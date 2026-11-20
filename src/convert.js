// .txt / .md -> html for the import feature. (.docx goes through mammoth in app.js.)
//
// Deliberately not using marked/markdown-it here. The editor can only display
// headings, lists and bold/italic/underline - tables, code blocks, links, images
// etc. would get stripped by the sanitizer anyway. A small subset parser covers
// what can actually survive.

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

// Escape FIRST, then add our own tags back, so text in the file can never turn into markup.
// Not a real inline parser: ***x*** or nested emphasis come out a bit odd. Fine for imports.
function inline(text) {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>');
}

// blank line = new paragraph, single newline = <br> (keeps addresses, poems etc. intact)
export function textToHtml(text) {
  return text
    .replace(/\r\n?/g, '\n') // windows line endings
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

// Supports: # ## ### headings, - / * bullets, "1." or "1)" numbered lists,
// **bold**, *italic*, paragraphs. Anything else stays as plain text.
// Nested lists are flattened to one level.
export function markdownToHtml(source) {
  const out = [];
  let list = null; // 'ul' | 'ol' | null - the list we're currently inside
  let para = []; // consecutive plain lines, joined with <br> when flushed

  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    para = [];
  };
  const closeList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  // switching from - to 1. mid-list closes the ul and starts an ol
  const openList = (tag) => {
    if (list === tag) return;
    closeList();
    out.push(`<${tag}>`);
    list = tag;
  };

  for (const raw of source.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    let m;

    if (!line.trim()) {
      flushPara();
      closeList();
    } else if ((m = line.match(/^(#{1,3})\s+(.*)$/))) {
      // #### and deeper fall through to plain text on purpose - editor only has h1-h3
      flushPara();
      closeList();
      const level = m[1].length;
      out.push(`<h${level}>${inline(m[2])}</h${level}>`);
    } else if ((m = line.match(/^\s*[-*]\s+(.*)$/))) {
      flushPara();
      openList('ul');
      out.push(`<li>${inline(m[1])}</li>`);
    } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      flushPara();
      openList('ol');
      out.push(`<li>${inline(m[1])}</li>`);
    } else {
      closeList();
      para.push(line);
    }
  }

  flushPara();
  closeList();
  return out.join('\n');
}
