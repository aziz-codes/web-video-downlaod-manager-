// Minimal XML parser, enough for DASH manifests. Runs in service workers and
// Node, where DOMParser does not exist.

export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

const isSpace = (c: string) => c === ' ' || c === '\n' || c === '\t' || c === '\r';

export function parseXml(src: string): XmlNode {
  const root: XmlNode = { name: '#document', attrs: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];
  const n = src.length;
  let i = 0;

  const top = () => stack[stack.length - 1];

  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt === -1) {
      top().text += decodeEntities(src.slice(i));
      break;
    }
    if (lt > i) top().text += decodeEntities(src.slice(i, lt));

    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      top().text += src.slice(lt + 9, end === -1 ? n : end);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (src[lt + 1] === '?' || src[lt + 1] === '!') {
      const end = src.indexOf('>', lt);
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (src[lt + 1] === '/') {
      const end = src.indexOf('>', lt);
      if (stack.length > 1) stack.pop();
      i = end === -1 ? n : end + 1;
      continue;
    }

    // Opening tag.
    let j = lt + 1;
    while (j < n && !isSpace(src[j]) && src[j] !== '>' && src[j] !== '/') j++;
    const node: XmlNode = { name: src.slice(lt + 1, j), attrs: {}, children: [], text: '' };
    let selfClosing = false;

    while (j < n) {
      while (j < n && isSpace(src[j])) j++;
      if (src[j] === '>') {
        j++;
        break;
      }
      if (src[j] === '/' && src[j + 1] === '>') {
        selfClosing = true;
        j += 2;
        break;
      }
      const nameStart = j;
      while (j < n && !isSpace(src[j]) && src[j] !== '=' && src[j] !== '>' && src[j] !== '/') j++;
      const attrName = src.slice(nameStart, j);
      while (j < n && isSpace(src[j])) j++;
      if (src[j] !== '=') {
        if (attrName) node.attrs[attrName] = '';
        if (j === nameStart) j++; // Avoid stalling on unexpected characters.
        continue;
      }
      j++;
      while (j < n && isSpace(src[j])) j++;
      const quote = src[j];
      if (quote === '"' || quote === "'") {
        const end = src.indexOf(quote, j + 1);
        node.attrs[attrName] = decodeEntities(src.slice(j + 1, end === -1 ? n : end));
        j = end === -1 ? n : end + 1;
      } else {
        const valueStart = j;
        while (j < n && !isSpace(src[j]) && src[j] !== '>') j++;
        node.attrs[attrName] = decodeEntities(src.slice(valueStart, j));
      }
    }

    top().children.push(node);
    if (!selfClosing) stack.push(node);
    i = j;
  }
  return root;
}

const localName = (name: string) => name.slice(name.indexOf(':') + 1);

export function childrenNamed(node: XmlNode | undefined, name: string): XmlNode[] {
  return node ? node.children.filter((c) => localName(c.name) === name) : [];
}

export function childNamed(node: XmlNode | undefined, name: string): XmlNode | undefined {
  return node?.children.find((c) => localName(c.name) === name);
}
