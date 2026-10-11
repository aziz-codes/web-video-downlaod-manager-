#!/usr/bin/env bash
# Generates HLS / DASH test streams with ffmpeg into tests/.media
set -euo pipefail
FF="${FFMPEG:-ffmpeg}"
D="$(cd "$(dirname "$0")" && pwd)/.media"
rm -rf "$D" && mkdir -p "$D"
cd "$D"
q=(-hide_banner -loglevel error -y)

"$FF" "${q[@]}" -f lavfi -i testsrc2=size=1280x720:rate=30 -f lavfi -i sine=frequency=440:sample_rate=48000 \
  -t 12 -c:v libx264 -preset veryfast -g 60 -keyint_min 60 -sc_threshold 0 -bf 2 -pix_fmt yuv420p \
  -c:a aac -b:a 128k -shortest source.mp4

mkdir hls-ts && "$FF" "${q[@]}" -i source.mp4 -c copy -f hls -hls_time 2 -hls_playlist_type vod \
  -hls_segment_filename hls-ts/seg_%03d.ts hls-ts/index.m3u8

mkdir hls-fmp4 && "$FF" "${q[@]}" -i source.mp4 -c copy -f hls -hls_time 2 -hls_playlist_type vod \
  -hls_segment_type fmp4 -hls_segment_filename hls-fmp4/seg_%03d.m4s hls-fmp4/index.m3u8

mkdir hls-aes && printf '0123456789abcdef' > hls-aes/key.bin
printf 'key.bin\n%s\n%s\n' "$D/hls-aes/key.bin" "000102030405060708090a0b0c0d0e0f" > hls-aes/keyinfo
"$FF" "${q[@]}" -i source.mp4 -c copy -f hls -hls_time 2 -hls_playlist_type vod \
  -hls_key_info_file hls-aes/keyinfo -hls_segment_filename hls-aes/seg_%03d.ts hls-aes/index.m3u8

mkdir hls-alt && "$FF" "${q[@]}" -i source.mp4 -map 0:v -map 0:a -c copy -f hls -hls_time 2 -hls_playlist_type vod \
  -var_stream_map "v:0,agroup:aud a:0,agroup:aud,default:yes" -master_pl_name master.m3u8 \
  -hls_segment_filename "hls-alt/%v_%03d.ts" "hls-alt/%v.m3u8"

mkdir hls-single && "$FF" "${q[@]}" -i source.mp4 -c copy -f hls -hls_time 2 -hls_playlist_type vod \
  -hls_flags single_file hls-single/index.m3u8

mkdir dash-tl && "$FF" "${q[@]}" -i source.mp4 -map 0:v -map 0:a -c copy -f dash -seg_duration 2 \
  -use_template 1 -use_timeline 1 -adaptation_sets "id=0,streams=v id=1,streams=a" dash-tl/manifest.mpd

mkdir dash-num && "$FF" "${q[@]}" -i source.mp4 -map 0:v -map 0:a -c copy -f dash -seg_duration 2 \
  -use_template 1 -use_timeline 0 -adaptation_sets "id=0,streams=v id=1,streams=a" dash-num/manifest.mpd

mkdir dash-single && "$FF" "${q[@]}" -i source.mp4 -map 0:v -map 0:a -c copy -f dash -seg_duration 2 \
  -single_file 1 -adaptation_sets "id=0,streams=v id=1,streams=a" dash-single/manifest.mpd

echo "media ready in $D"
