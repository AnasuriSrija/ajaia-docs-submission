// Frontend for Ajaia Docs. esbuild bundles this into public/dist/app.js (`npm run build`).
//
// No framework on purpose - it's two screens and a dialog. The only real
// dependency is TipTap for the editor (see the note in renderEditor about why).
//
// Rule of thumb in here: anything user-typed goes in as text nodes, never innerHTML.
// The one exception is the document body, which TipTap renders from html the
// server already sanitized.
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Placeholder } from '@tiptap/extensions';

const $app = document.getElementById('app');
const $userSelect = document.getElementById('user-select');
const $userAvatar = document.getElementById('user-avatar');
const $toast = document.getElementById('toast');
const USER_KEY = 'ajaia.userId';

let users = [];
let currentUserId = readStored(USER_KEY);
let teardown = null; // set by the editor view: flushes the pending save + removes listeners

// localStorage throws in some private modes / when storage is blocked
function readStored(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // not the end of the world, they'll just have to pick the user again
  }
}

// Thin fetch wrapper. `as` lets the editor pin the user it was opened with (see renderEditor).
// Errors carry .status so callers can tell a 404 from everything else.
async function api(path, { method = 'GET', body, form, as = currentUserId } = {}) {
  const headers = { 'x-user-id': as };
  let payload;
  if (form) {
    payload = form; // don't set content-type, the browser adds the multipart boundary
  } else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  const res = await fetch(path, { method, headers, body: payload });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// tiny hyperscript helper: h('a', { href: '#/' }, 'text', otherNode, [more, nodes])
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'value') el.value = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(2)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

// Hand-drawn on a 24px grid, lucide-ish. Not worth an icon library for ~10 icons.
const ICONS = {
  doc: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  upload: '<path d="M12 15V4M7.5 8.5 12 4l4.5 4.5"/><path d="M5 15v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3"/>',
  share: '<circle cx="9" cy="8" r="3.5"/><path d="M3 20a6 6 0 0 1 12 0"/><path d="M19 8v6M16 11h6"/>',
  back: '<path d="M15 18l-6-6 6-6"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  bullets:
    '<circle cx="5" cy="7" r=".9" fill="currentColor"/><circle cx="5" cy="12" r=".9" fill="currentColor"/><circle cx="5" cy="17" r=".9" fill="currentColor"/><path d="M9.5 7H20M9.5 12H20M9.5 17H20"/>',
  numbers:
    '<path d="M10 7h10M10 12h10M10 17h10"/><path d="M4 5.5 5.5 4.5V9.5"/><path d="M4 14.5a1.5 1.5 0 1 1 2.6 1L4 19.5h3"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
};

// innerHTML is fine here - the markup is the static set above, never user input
function icon(name, cls = 'icon') {
  const span = document.createElement('span');
  span.className = cls;
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
  return span;
}

const AVATAR_COLORS = ['#2f5d50', '#9a5a2c', '#4b5c93', '#85466a', '#5d6c2f', '#2e6a77'];

function userById(id) {
  return users.find((u) => u.id === id) ?? null;
}

// Color comes from the user's position in the list, not a hash of the id -
// tried hashing first but bob and carol landed on the same color.
function avatar(user, size = 'md') {
  const index = Math.max(0, users.findIndex((u) => u.id === user.id));
  const initials = user.name
    .split(/\s+/)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
  return h(
    'span',
    { class: `avatar avatar-${size}`, style: `--avatar: ${AVATAR_COLORS[index % AVATAR_COLORS.length]}`, title: user.name, 'aria-hidden': 'true' },
    initials
  );
}

function fullDate(iso) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

// "Just now" / "12 min ago" / "3:41 PM" / "Yesterday" / "Mar 4"
// Full timestamp goes in the title attr for hover.
function timeAgo(iso) {
  const then = new Date(iso);
  const now = new Date();
  const seconds = (now - then) / 1000;

  if (seconds < 60) return 'Just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (then.toDateString() === now.toDateString()) {
    return then.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (then.toDateString() === yesterday.toDateString()) return 'Yesterday';

  return then.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: then.getFullYear() === now.getFullYear() ? undefined : 'numeric',
  });
}

function toast(message) {
  $toast.textContent = message;
  $toast.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => ($toast.hidden = true), 5000);
}

// full-page message for "not found" / "server down" type states
function renderNotice(title, message) {
  $app.replaceChildren(
    h('section', { class: 'notice' }, icon('doc'), h('h1', {}, title), h('p', {}, message), h('a', { class: 'btn', href: '#/' }, 'Back to documents'))
  );
}

/* ---- user picker (stand-in for login) ---- */

function paintCurrentUser() {
  const me = userById(currentUserId);
  $userAvatar.replaceChildren(me ? avatar(me) : '');
}

async function initUsers() {
  const res = await fetch('/api/users');
  if (!res.ok) throw new Error('Could not load users');
  users = await res.json();

  // stored id might be stale (e.g. db was reset), fall back to the first user
  if (!users.some((u) => u.id === currentUserId)) currentUserId = users[0].id;
  store(USER_KEY, currentUserId);

  $userSelect.replaceChildren(...users.map((u) => h('option', { value: u.id }, u.name)));
  $userSelect.value = currentUserId;
  paintCurrentUser();

  $userSelect.addEventListener('change', () => {
    currentUserId = $userSelect.value;
    store(USER_KEY, currentUserId);
    paintCurrentUser();

    // Used to do both of these unconditionally. When the hash actually changed,
    // hashchange fired route() as well, so the list rendered twice with two fetches racing.
    // location.hash = '#/';
    // route();
    if (location.hash === '#/' || location.hash === '') route();
    else location.hash = '#/';
  });
}

/* ---- routing: #/ is the list, #/doc/:id is the editor ---- */

function route() {
  if (teardown) {
    teardown();
    teardown = null;
  }
  const match = location.hash.match(/^#\/doc\/([\w-]+)$/);
  if (match) renderEditor(match[1]);
  else renderHome();
}

/* ---- documents list ---- */

async function renderHome() {
  document.title = 'Documents · Ajaia Docs';
  $app.replaceChildren(h('p', { class: 'loading' }, 'Loading documents…'));

  let docs;
  try {
    docs = await api('/api/documents');
  } catch (err) {
    return renderNotice('Something went wrong', err.message);
  }

  const owned = docs.filter((d) => d.role === 'owner');
  const shared = docs.filter((d) => d.role !== 'owner');

  // hidden <input type=file>, the visible button just clicks it
  const fileInput = h('input', {
    type: 'file',
    accept: '.txt,.md,.docx', // only a hint for the picker, the server is what actually enforces it
    hidden: true,
    'aria-label': 'Choose a file to import',
    onchange: async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const form = new FormData();
      form.append('file', file);
      try {
        const doc = await api('/api/documents/import', { method: 'POST', form });
        location.hash = `#/doc/${doc.id}`;
      } catch (err) {
        toast(err.message);
      } finally {
        e.target.value = ''; // so picking the same file again still fires change
      }
    },
  });

  const newDocument = async () => {
    try {
      const doc = await api('/api/documents', { method: 'POST', body: { title: 'Untitled document' } });
      location.hash = `#/doc/${doc.id}`;
    } catch (err) {
      toast(err.message);
    }
  };

  $app.replaceChildren(
    h(
      'section',
      { class: 'home' },
      h(
        'div',
        { class: 'home-head' },
        h('h1', {}, 'Documents'),
        // brief asks for supported types to be visible in the UI, not just the README
        h('p', { class: 'home-note' }, 'Import works with .txt, .md and .docx files up to 2 MB. Each file opens as a new document.'),
        h(
          'div',
          { class: 'home-actions' },
          h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => fileInput.click() }, icon('upload'), 'Import file'),
          h('button', { class: 'btn btn-primary', type: 'button', onclick: newDocument }, icon('plus'), 'New document'),
          fileInput
        )
      ),
      docGroup('My documents', owned, 'Nothing here yet. Start a new document or import a file.'),
      docGroup('Shared with me', shared, 'When someone shares a document with you, it will show up here.')
    )
  );
}

function docGroup(title, items, emptyText) {
  const header = h('div', { class: 'group-head' }, h('h2', {}, title), h('span', { class: 'count' }, items.length));
  if (!items.length) {
    return h('section', { class: 'doc-group' }, header, h('p', { class: 'empty-line' }, emptyText));
  }
  return h(
    'section',
    { class: 'doc-group' },
    header,
    h(
      'div',
      { class: 'doc-table', role: 'list', 'aria-label': title },
      h('div', { class: 'doc-row doc-row-head', 'aria-hidden': 'true' }, h('span', {}, 'Name'), h('span', {}, 'Owner'), h('span', {}, 'Last edited')),
      items.map(docRow)
    )
  );
}

function docRow(d) {
  const mine = d.role === 'owner';
  // fallback in case the users list and the doc list are ever out of sync
  const owner = userById(d.ownerId) ?? { id: d.ownerId, name: d.ownerName };
  return h(
    'a',
    { class: 'doc-row', role: 'listitem', href: `#/doc/${d.id}` },
    h('span', { class: 'doc-name' }, icon('doc', mine ? 'icon doc-icon' : 'icon doc-icon shared'), h('span', { class: 'doc-title' }, d.title)),
    h('span', { class: 'doc-owner' }, mine ? h('span', {}, 'me') : [avatar(owner, 'sm'), h('span', {}, owner.name)]),
    h('time', { class: 'doc-time', datetime: d.updatedAt, title: fullDate(d.updatedAt) }, timeAgo(d.updatedAt))
  );
}

/* ---- editor ---- */

// v1 was a plain contenteditable driven by document.execCommand. Dropped it after
// testing in Chrome: typing into an empty doc put the first line outside any <p>,
// formatBlock lost headings, and it injected <span style="font-size:..."> plus
// <ul> nested inside <p>. TipTap (ProseMirror underneath) has an actual schema,
// so the html coming out is predictable.
//
// Everything the sanitizer doesn't allow is switched off here, so nothing a
// user can type gets silently dropped on save.
function createRichEditor(element, content, onUpdate) {
  return new Editor({
    element,
    content,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        blockquote: false,
        code: false,
        codeBlock: false,
        horizontalRule: false,
        strike: false,
        link: false, // TODO: links would be nice, needs href in the sanitizer allow-list (http/https only)
      }),
      Placeholder.configure({ placeholder: 'Start writing…' }),
    ],
    editorProps: {
      attributes: {
        class: 'page',
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': 'Document body',
        spellcheck: 'true',
      },
    },
    onUpdate,
  });
}

async function renderEditor(id) {
  // Bug I hit: switching user while an autosave was pending sent the flush on
  // teardown with the NEW user's id (404 at best, saved as the wrong person at worst).
  // So the user is captured once when the doc opens and every call uses that.
  const as = currentUserId;
  const call = (path, options = {}) => api(path, { ...options, as });

  $app.replaceChildren(h('p', { class: 'loading' }, 'Opening document…'));

  let doc;
  try {
    doc = await call(`/api/documents/${id}`);
  } catch (err) {
    if (err.status === 404) {
      // server sends 404 for "no access" too, so the copy has to cover both
      return renderNotice("Can't open this document", "It doesn't exist, or it hasn't been shared with you.");
    }
    return renderNotice('Something went wrong', err.message);
  }
  document.title = `${doc.title} · Ajaia Docs`;

  const isOwner = doc.role === 'owner';
  const owner = userById(doc.ownerId) ?? { id: doc.ownerId, name: doc.ownerName };
  let saveTimer = null;
  // Saves are chained so they go out one at a time - otherwise a slow request
  // could land after a newer one and overwrite it with older content.
  let saveChain = Promise.resolve();

  // Save status under the title. It's also clickable = "save now".
  // (there was a separate Save button at first, felt redundant next to this)
  const saveState = h('button', { class: 'save-state', type: 'button', title: 'Save now (Ctrl+S)', 'aria-live': 'polite' }, 'Saved');
  const setState = (text, state = 'saved') => {
    saveState.textContent = text;
    saveState.dataset.state = state; // css colors pending/error states off this
  };

  // title saves on change = blur or Enter. Esc puts the old one back.
  const titleInput = h('input', {
    class: 'title-input',
    value: doc.title,
    maxlength: '200', // server trims to 200 as well
    'aria-label': 'Document title',
    onkeydown: (e) => {
      if (e.key === 'Enter') e.target.blur();
      if (e.key === 'Escape') {
        e.target.value = doc.title;
        e.target.blur();
      }
    },
    onchange: async (e) => {
      const title = e.target.value.trim();
      if (!title) {
        e.target.value = doc.title;
        return toast('A document needs a title.');
      }
      try {
        const updated = await call(`/api/documents/${id}`, { method: 'PATCH', body: { title } });
        doc.title = updated.title;
        document.title = `${doc.title} · Ajaia Docs`;
        setState('Saved');
      } catch (err) {
        e.target.value = doc.title;
        toast(err.message);
      }
    },
  });

  const mount = h('div');
  const editor = createRichEditor(mount, doc.content, () => {
    scheduleSave();
    refreshToolbar();
  });

  // Compare against the editor's own normalized html, not what the server sent.
  // TipTap reformats on load (e.g. wraps <li> text in <p>), so with doc.content
  // just opening a doc looked like an edit and fired a save.
  // let lastSavedHtml = doc.content;
  let lastSavedHtml = editor.getHTML();

  const save = () => {
    saveChain = saveChain.then(async () => {
      if (editor.isDestroyed) return;
      const content = editor.getHTML();
      if (content === lastSavedHtml) {
        setState('Saved');
        return;
      }
      setState('Saving…', 'saving');
      try {
        await call(`/api/documents/${id}`, { method: 'PATCH', body: { content } });
        lastSavedHtml = content;
        setState('Saved');
      } catch (err) {
        setState("Couldn't save · Retry", 'error');
        toast(err.message);
      }
    });
    return saveChain;
  };

  const saveNow = () => {
    clearTimeout(saveTimer);
    saveTimer = null;
    return save();
  };
  saveState.addEventListener('click', saveNow);

  // debounce: save 800ms after the last keystroke. Short enough that closing the
  // tab right after typing rarely loses anything (and beforeunload covers the rest).
  function scheduleSave() {
    setState('Unsaved changes', 'pending');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      save();
    }, 800);
  }

  const onKeydown = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault(); // otherwise the browser's "save page as" dialog pops up
      saveNow();
    }
  };
  window.addEventListener('keydown', onKeydown);

  // browser's "leave site?" prompt if there's anything unsaved
  const onBeforeUnload = (e) => {
    if (saveTimer || editor.getHTML() !== lastSavedHtml) e.preventDefault();
  };
  window.addEventListener('beforeunload', onBeforeUnload);

  // Leaving the editor (back button, user switch): flush first, then destroy.
  // Destroying before the save finishes would make getHTML() blow up.
  teardown = () => {
    window.removeEventListener('keydown', onKeydown);
    window.removeEventListener('beforeunload', onBeforeUnload);
    saveNow().then(() => editor.destroy());
  };

  // --- toolbar ---
  // mousedown preventDefault everywhere so clicking a button doesn't steal the
  // selection from the editor.

  // Old execCommand toolbar, for reference (see note on createRichEditor):
  //
  // const exec = (command, value) => {
  //   page.focus();
  //   document.execCommand(command, false, value);
  //   scheduleSave();
  // };
  // tool('B', 'Bold (Ctrl+B)', 'bold');                   // -> exec('bold')
  // tool('• List', 'Bulleted list', 'insertUnorderedList');
  // blockSelect.onchange = (e) => exec('formatBlock', `<${e.target.value}>`);

  const toggles = []; // buttons that light up when the format is active at the cursor
  const history = []; // undo/redo, disabled when there's nothing to undo/redo

  const tool = (content, label, run) =>
    h(
      'button',
      {
        class: 'tool',
        type: 'button',
        title: label,
        'aria-label': label,
        onmousedown: (e) => e.preventDefault(),
        onclick: () => run(editor.chain().focus()).run(),
      },
      content
    );

  const toggle = (content, label, run, isActive) => {
    const btn = tool(content, label, run);
    btn.setAttribute('aria-pressed', 'false');
    toggles.push({ btn, isActive });
    return btn;
  };

  const historyTool = (name, label, run, can) => {
    const btn = tool(icon(name), label, run);
    history.push({ btn, can });
    return btn;
  };

  const blockSelect = h(
    'select',
    {
      class: 'tool-select',
      'aria-label': 'Text style',
      title: 'Text style',
      onchange: (e) => {
        const value = e.target.value;
        const chain = editor.chain().focus();
        if (value === 'p') chain.setParagraph().run();
        else chain.setHeading({ level: Number(value.slice(1)) }).run();
      },
    },
    h('option', { value: 'p' }, 'Body text'),
    h('option', { value: 'h1' }, 'Heading 1'),
    h('option', { value: 'h2' }, 'Heading 2'),
    h('option', { value: 'h3' }, 'Heading 3')
  );

  // runs on every edit + every cursor move. Cheap enough, it's a handful of isActive() calls.
  function refreshToolbar() {
    for (const { btn, isActive } of toggles) {
      const active = isActive();
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', String(active));
    }
    for (const { btn, can } of history) btn.disabled = !can();

    const level = [1, 2, 3].find((l) => editor.isActive('heading', { level: l }));
    blockSelect.value = level ? `h${level}` : 'p';
  }
  editor.on('selectionUpdate', refreshToolbar);

  const toolbar = h(
    'div',
    { class: 'toolbar', role: 'toolbar', 'aria-label': 'Formatting' },
    historyTool('undo', 'Undo (Ctrl+Z)', (c) => c.undo(), () => editor.can().undo()),
    historyTool('redo', 'Redo (Ctrl+Shift+Z)', (c) => c.redo(), () => editor.can().redo()),
    h('span', { class: 'sep' }),
    blockSelect,
    h('span', { class: 'sep' }),
    toggle(h('span', { class: 'glyph glyph-b' }, 'B'), 'Bold (Ctrl+B)', (c) => c.toggleBold(), () => editor.isActive('bold')),
    toggle(h('span', { class: 'glyph glyph-i' }, 'I'), 'Italic (Ctrl+I)', (c) => c.toggleItalic(), () => editor.isActive('italic')),
    toggle(h('span', { class: 'glyph glyph-u' }, 'U'), 'Underline (Ctrl+U)', (c) => c.toggleUnderline(), () => editor.isActive('underline')),
    h('span', { class: 'sep' }),
    toggle(icon('bullets'), 'Bulleted list', (c) => c.toggleBulletList(), () => editor.isActive('bulletList')),
    toggle(icon('numbers'), 'Numbered list', (c) => c.toggleOrderedList(), () => editor.isActive('orderedList'))
  );
  refreshToolbar();

  // Right side of the header. Owners: who has access + Share button.
  // Everyone else: a label saying whose doc it is (no sharing for editors).
  let actions;
  let share = null;
  if (isOwner) {
    const people = h('div', { class: 'people-stack' });
    const drawPeople = (shares) => people.replaceChildren(...[owner, ...shares].slice(0, 5).map((u) => avatar(u, 'sm')));
    share = buildShareDialog({ doc, owner, call, onChange: drawPeople });
    drawPeople(doc.shares ?? []);
    actions = [people, h('button', { class: 'btn btn-primary', type: 'button', onclick: share.open }, icon('share'), 'Share')];
  } else {
    actions = h('span', { class: 'shared-chip' }, avatar(owner, 'sm'), `Shared by ${owner.name}`);
  }

  const sheet = h(
    'div',
    {
      class: 'sheet',
      // clicking in the page margins should put the cursor in the doc, like a real page
      onmousedown: (e) => {
        if (e.target === sheet) {
          e.preventDefault();
          editor.commands.focus('end');
        }
      },
    },
    mount
  );

  $app.replaceChildren(
    h(
      'section',
      { class: 'editor' },
      h(
        'div',
        { class: 'editor-chrome' },
        h(
          'div',
          { class: 'doc-bar' },
          h('a', { class: 'icon-btn', href: '#/', title: 'All documents', 'aria-label': 'Back to all documents' }, icon('back')),
          icon('doc', isOwner ? 'icon doc-icon' : 'icon doc-icon shared'),
          h(
            'div',
            { class: 'doc-meta' },
            titleInput,
            h('div', { class: 'doc-sub' }, h('span', {}, isOwner ? 'Owned by you ·' : `${owner.name} shared this with you · you can edit ·`), saveState)
          ),
          h('div', { class: 'doc-actions' }, actions)
        ),
        toolbar
      ),
      h('div', { class: 'canvas' }, sheet),
      share?.dialog
    )
  );

  // new/empty doc -> cursor straight in so you can start typing
  if (editor.isEmpty) editor.commands.focus();
  // TODO: if someone else edits while you have it open you won't see it until reload.
  // Polling updatedAt (or SSE) + a "this doc changed, reload?" banner would cover most of it.
}

/* ---- share dialog ---- */

// Owner only. Add people by email, see who has access, remove them.
//
// This started as an always-open <details> panel between the header and the
// toolbar. It pushed the page down on every single doc for something you use
// once, so it moved into a <dialog> behind the Share button.
function buildShareDialog({ doc, owner, call, onChange }) {
  const heading = h('h2', { id: 'share-title' });
  const list = h('ul', { class: 'people-list' });
  const error = h('p', { class: 'form-error', role: 'alert' });

  const personRow = (user, label, ...right) =>
    h(
      'li',
      {},
      avatar(user),
      h('div', { class: 'person' }, h('span', { class: 'person-name' }, label), h('span', { class: 'person-email' }, user.email ?? '')),
      h('div', { class: 'person-right' }, right)
    );

  const removeAccess = async (person) => {
    try {
      const res = await call(`/api/documents/${doc.id}/shares/${person.id}`, { method: 'DELETE' });
      error.textContent = '';
      draw(res.shares);
    } catch (err) {
      error.textContent = err.message;
    }
  };

  // owner always first, then everyone it's shared with (server sorts those by name)
  function draw(shares) {
    list.replaceChildren(
      personRow(owner, `${owner.name} (you)`, h('span', { class: 'role' }, 'Owner')),
      ...shares.map((s) =>
        personRow(
          s,
          s.name,
          h('span', { class: 'role' }, 'Can edit'),
          h('button', { class: 'link-btn danger', type: 'button', 'aria-label': `Remove ${s.name}`, onclick: () => removeAccess(s) }, 'Remove')
        )
      )
    );
    onChange(shares); // keeps the avatar stack in the header in sync
  }

  // Suggest the other demo accounts so reviewers don't have to remember the emails.
  // TODO: with real users this would be a search endpoint, not the full list.
  const suggestions = h(
    'datalist',
    { id: 'share-suggestions' },
    users.filter((u) => u.id !== owner.id).map((u) => h('option', { value: u.email }, u.name))
  );
  const emailInput = h('input', {
    type: 'email',
    required: true,
    list: 'share-suggestions',
    autocomplete: 'off', // otherwise the browser's own autofill fights with the datalist
    placeholder: 'Add people by email',
    'aria-label': 'Email address',
  });

  const form = h(
    'form',
    {
      class: 'share-form',
      onsubmit: async (e) => {
        e.preventDefault();
        error.textContent = '';
        try {
          const res = await call(`/api/documents/${doc.id}/shares`, { method: 'POST', body: { email: emailInput.value } });
          emailInput.value = '';
          draw(res.shares);
        } catch (err) {
          error.textContent = err.message; // "No user with that email." etc. straight from the API
        }
      },
    },
    emailInput,
    h('button', { class: 'btn btn-primary', type: 'submit' }, 'Share')
  );

  const dialog = h(
    'dialog',
    { class: 'share-dialog', 'aria-labelledby': 'share-title' },
    h(
      'div',
      { class: 'dialog-body' },
      h(
        'div',
        { class: 'dialog-head' },
        heading,
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: () => dialog.close() }, icon('close'))
      ),
      form,
      suggestions,
      error,
      h('h3', {}, 'People with access'),
      list,
      h(
        'div',
        { class: 'dialog-foot' },
        h('p', {}, 'Anyone you add can open and edit this document.'),
        h('button', { class: 'btn', type: 'button', onclick: () => dialog.close() }, 'Done')
      )
    )
  );

  // Click on the backdrop closes it. The dialog itself has no padding (it's all
  // on .dialog-body) so e.target === dialog only happens outside the content.
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close();
  });

  draw(doc.shares ?? []);

  return {
    dialog,
    open: () => {
      heading.textContent = `Share “${doc.title}”`; // set on open so a rename is reflected
      error.textContent = '';
      dialog.showModal(); // Esc to close comes free with showModal
      emailInput.focus();
    },
  };
}

/* ---- boot ---- */

(async function start() {
  try {
    await initUsers();
  } catch {
    toast('Could not reach the server. Is it running?');
    return;
  }
  window.addEventListener('hashchange', route);
  route();
})();
