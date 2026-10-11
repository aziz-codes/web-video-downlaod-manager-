import { describe, expect, it } from 'vitest';
import { parseHls, parseAttributes, sequenceIv } from '../lib/engine/hls';
import { parseDash, parseIsoDuration, fillTemplate } from '../lib/engine/dash';
import { parseXml } from '../lib/engine/xml';

describe('hls', () => {
  it('parses quoted attributes containing commas', () => {
    expect(parseAttributes('BANDWIDTH=1,CODECS="avc1.4d401f,mp4a.40.2",RESOLUTION=640x360')).toEqual({
      BANDWIDTH: '1',
      CODECS: 'avc1.4d401f,mp4a.40.2',
      RESOLUTION: '640x360',
    });
  });

  it('parses a master playlist with audio groups', () => {
    const pl = parseHls(
      `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="audio/en.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,FRAME-RATE=29.97,CODECS="avc1.640028,mp4a.40.2",AUDIO="a"
1080/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=640x360,AUDIO="a"
https://cdn.example.com/360.m3u8`,
      'https://example.com/video/master.m3u8?token=1',
    );
    expect(pl.kind).toBe('master');
    if (pl.kind !== 'master') return;
    expect(pl.variants.map((v) => [v.height, v.uri])).toEqual([
      [1080, 'https://example.com/video/1080/index.m3u8'],
      [360, 'https://cdn.example.com/360.m3u8'],
    ]);
    expect(pl.renditions[0]).toMatchObject({ type: 'AUDIO', groupId: 'a', isDefault: true, uri: 'https://example.com/video/audio/en.m3u8' });
  });

  it('tracks byte ranges, keys, discontinuities and live state', () => {
    const pl = parseHls(
      `#EXTM3U
#EXT-X-TARGETDURATION:4
#EXT-X-MEDIA-SEQUENCE:7
#EXT-X-KEY:METHOD=AES-128,URI="k.bin"
#EXTINF:4,
#EXT-X-BYTERANGE:100@0
all.ts
#EXTINF:4,
#EXT-X-BYTERANGE:50
all.ts
#EXT-X-DISCONTINUITY
#EXT-X-KEY:METHOD=NONE
#EXTINF:2.5,
next.ts`,
      'https://h/p/x.m3u8',
    );
    if (pl.kind !== 'media') throw new Error();
    expect(pl.endList).toBe(false);
    expect(pl.encryption).toBe('aes-128');
    expect(pl.segments[1].byteRange).toEqual({ offset: 100, length: 50 });
    expect(pl.segments[0].key?.uri).toBe('https://h/p/k.bin');
    expect(pl.segments[2].key).toBeUndefined();
    expect(pl.segments[2].discontinuity).toBe(true);
    expect(pl.segments[2].start).toBe(8);
    expect(pl.totalDuration).toBe(10.5);
    expect(sequenceIv(258)[14]).toBe(1);
    expect(sequenceIv(258)[15]).toBe(2);
  });

  it('flags DRM key systems', () => {
    const pl = parseHls(
      `#EXTM3U
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://x",KEYFORMAT="com.apple.streamingkeydelivery"
#EXTINF:4,
a.ts
#EXT-X-ENDLIST`,
      'https://h/',
    );
    expect(pl.kind === 'media' && pl.encryption).toBe('drm');
  });
});

describe('dash', () => {
  it('parses durations and templates', () => {
    expect(parseIsoDuration('PT1H2M3.5S')).toBe(3723.5);
    expect(parseIsoDuration('P1DT1S')).toBe(86401);
    expect(fillTemplate('$RepresentationID$/seg-$Number%05d$-$Time$.m4s$$', { RepresentationID: 'v1', Number: 42, Time: 900, Bandwidth: 1 })).toBe(
      'v1/seg-00042-900.m4s$',
    );
  });

  it('expands SegmentTimeline repeats including r=-1 and inherits from AdaptationSet', () => {
    const mpd = parseDash(
      `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT10S">
  <BaseURL>https://cdn.example.com/v/</BaseURL>
  <Period id="ad" duration="PT2S"><AdaptationSet mimeType="video/mp4"><Representation id="ad" bandwidth="1"/></AdaptationSet></Period>
  <Period id="main" duration="PT10S">
    <AdaptationSet mimeType="video/mp4" codecs="avc1.640028">
      <SegmentTemplate timescale="1000" initialization="$RepresentationID$/init.mp4" media="$RepresentationID$/$Time$.m4s">
        <SegmentTimeline><S t="0" d="4000" r="1"/><S d="2000" r="-1"/></SegmentTimeline>
      </SegmentTemplate>
      <Representation id="1080" bandwidth="5000000" width="1920" height="1080" frameRate="30000/1001"/>
      <Representation id="720" bandwidth="2500000" width="1280" height="720"><BaseURL>alt/</BaseURL></Representation>
    </AdaptationSet>
    <AdaptationSet mimeType="audio/mp4" lang="en">
      <ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011"/>
      <Representation id="a" bandwidth="128000" codecs="mp4a.40.2">
        <SegmentTemplate timescale="48000" duration="96000" startNumber="0" media="a/$Number$.m4s" initialization="a/i.mp4"/>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`,
      'https://example.com/manifest.mpd',
    );
    expect(mpd.duration).toBe(10);
    const [v1080, v720, audio] = mpd.representations;
    expect(v1080.frameRate).toBeCloseTo(29.97, 2);
    if (v1080.addressing.type !== 'list') throw new Error();
    expect(v1080.addressing.init?.url).toBe('https://cdn.example.com/v/1080/init.mp4');
    expect(v1080.addressing.segments.map((s) => s.url.split('/').pop())).toEqual(['0.m4s', '4000.m4s', '8000.m4s']);
    if (v720.addressing.type !== 'list') throw new Error();
    expect(v720.addressing.segments[0].url).toBe('https://cdn.example.com/v/alt/720/0.m4s');
    expect(audio.isProtected).toBe(true);
    if (audio.addressing.type !== 'list') throw new Error();
    expect(audio.addressing.segments).toHaveLength(5);
    expect(audio.addressing.segments[4].url).toBe('https://cdn.example.com/v/a/4.m4s');
  });
});

describe('xml', () => {
  it('handles comments, CDATA, entities and self-closing tags', () => {
    const doc = parseXml('<a x="1 &amp; 2"><!-- c --><b/><c><![CDATA[<raw>]]></c>t&lt;</a>');
    const a = doc.children[0];
    expect(a.attrs.x).toBe('1 & 2');
    expect(a.children.map((c) => c.name)).toEqual(['b', 'c']);
    expect(a.children[1].text).toBe('<raw>');
    expect(a.text).toBe('t<');
  });
});
