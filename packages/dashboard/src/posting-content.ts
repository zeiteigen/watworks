/** Browser-only Markdown subset for saved posting descriptions. */
export const POSTING_CONTENT_SCRIPT = String.raw`
function renderPosting(text, el) {
  const root = el('div', { class: 'description' });
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  let paragraph = [];
  let list = null;

  function inline(value, parent) {
    const pattern = /\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)]+)\)/g;
    let cursor = 0;
    let match;
    while ((match = pattern.exec(value))) {
      if (match.index > cursor) parent.append(document.createTextNode(value.slice(cursor, match.index)));
      if (match[1] !== undefined) {
        const strong = document.createElement('strong');
        strong.textContent = match[1];
        parent.append(strong);
      } else {
        const label = match[2];
        const rawUrl = match[3].trim();
        let safeUrl = null;
        try {
          const parsed = new URL(rawUrl);
          if (parsed.protocol === 'http:' || parsed.protocol === 'https:') safeUrl = parsed.href;
        } catch {}
        if (safeUrl) {
          const link = document.createElement('a');
          link.textContent = label;
          link.href = safeUrl;
          link.rel = 'noopener noreferrer';
          link.target = '_blank';
          parent.append(link);
        } else {
          parent.append(document.createTextNode(match[0]));
        }
      }
      cursor = pattern.lastIndex;
    }
    if (cursor < value.length) parent.append(document.createTextNode(value.slice(cursor)));
  }

  function flushParagraph() {
    if (!paragraph.length) return;
    const node = document.createElement('p');
    inline(paragraph.join(' '), node);
    root.append(node);
    paragraph = [];
  }

  function flushList() {
    if (!list) return;
    root.append(list.node);
    list = null;
  }

  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    const bullet = /^\s*[-*+]\s+(.+)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.+)$/.exec(line);
    if (!line.trim()) { flushParagraph(); flushList(); continue; }
    if (heading) {
      flushParagraph(); flushList();
      const node = document.createElement(heading[1].length === 1 ? 'h3' : 'h4');
      inline(heading[2], node);
      root.append(node);
      continue;
    }
    if (bullet || numbered) {
      flushParagraph();
      const type = bullet ? 'ul' : 'ol';
      if (!list || list.type !== type) { flushList(); list = { type, node: document.createElement(type) }; }
      const item = document.createElement('li');
      inline((bullet || numbered)[1], item);
      list.node.append(item);
      continue;
    }
    flushList();
    paragraph.push(line.trim());
  }
  flushParagraph();
  flushList();
  return root;
}
`;
