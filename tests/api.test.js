import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { openDb } from '../src/db.js';
import { createApp, MAX_CONTENT_CHARS } from '../src/app.js';
import { seedDemoContent } from '../src/seed.js';

// Every test gets a fresh in-memory db and the real express app on a random port,
// then talks to it over HTTP - closer to what the browser does than calling handlers directly.

const ALICE = 'u_alice';
const BOB = 'u_bob';
const CAROL = 'u_carol';

let db;
let server;
let base;

function startServer(database) {
  return new Promise((resolve) => {
    const s = http.createServer(createApp({ db: database })).listen(0, () => {
      resolve({ server: s, base: `http://127.0.0.1:${s.address().port}` });
    });
  });
}

// user: null -> no x-user-id header at all
async function call(method, urlPath, { user = ALICE, body, form } = {}) {
  const headers = {};
  if (user) headers['x-user-id'] = user;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(base + urlPath, { method, headers, body: payload });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

async function createDoc(user = ALICE, title = 'Q3 plan') {
  const r = await call('POST', '/api/documents', { user, body: { title } });
  expect(r.status).toBe(201);
  return r.data;
}

function fileForm(name, text) {
  const form = new FormData();
  form.append('file', new Blob([text]), name);
  return form;
}

beforeEach(async () => {
  db = openDb(':memory:');
  ({ server, base } = await startServer(db));
});

afterEach(() => {
  server.close();
  db.close();
});

describe('identity', () => {
  it('rejects requests without a known user', async () => {
    expect((await call('GET', '/api/documents', { user: null })).status).toBe(401);
    expect((await call('GET', '/api/documents', { user: 'u_nobody' })).status).toBe(401);
  });

  it('lists the seeded users', async () => {
    const r = await call('GET', '/api/users', { user: null });
    expect(r.data.map((u) => u.id)).toEqual(expect.arrayContaining([ALICE, BOB, CAROL]));
  });
});

describe('create, rename, edit, reopen', () => {
  it('creates a document owned by the caller and lists it', async () => {
    const doc = await createDoc(ALICE, 'Roadmap');
    expect(doc.title).toBe('Roadmap');
    expect(doc.ownerId).toBe(ALICE);

    const list = await call('GET', '/api/documents');
    expect(list.data).toHaveLength(1);
    expect(list.data[0]).toMatchObject({ id: doc.id, role: 'owner' });
  });

  it('defaults the title when none is given', async () => {
    const r = await call('POST', '/api/documents', { body: {} });
    expect(r.data.title).toBe('Untitled document');
  });

  it('renames a document and rejects an empty title', async () => {
    const doc = await createDoc();
    const ok = await call('PATCH', `/api/documents/${doc.id}`, { body: { title: '  Renamed  ' } });
    expect(ok.data.title).toBe('Renamed');

    const bad = await call('PATCH', `/api/documents/${doc.id}`, { body: { title: '   ' } });
    expect(bad.status).toBe(400);
  });

  it('saves content and returns it when the document is reopened', async () => {
    const doc = await createDoc();
    await call('PATCH', `/api/documents/${doc.id}`, { body: { content: '<h1>Hello</h1><p><strong>bold</strong></p>' } });

    const reopened = await call('GET', `/api/documents/${doc.id}`);
    expect(reopened.data.content).toBe('<h1>Hello</h1><p><strong>bold</strong></p>');
  });

  it('rejects an update with nothing to change and oversized content', async () => {
    const doc = await createDoc();
    expect((await call('PATCH', `/api/documents/${doc.id}`, { body: {} })).status).toBe(400);

    const huge = 'a'.repeat(MAX_CONTENT_CHARS + 1);
    expect((await call('PATCH', `/api/documents/${doc.id}`, { body: { content: huge } })).status).toBe(413);
  });
});

describe('sanitization', () => {
  it('strips scripts, event handlers, and unsupported tags but keeps formatting', async () => {
    const doc = await createDoc();
    const dirty =
      '<p onclick="steal()">Hi <img src=x onerror="alert(1)"><script>alert(1)</script></p>' +
      '<h2>Title</h2><a href="javascript:alert(1)">link</a><em>ok</em>';
    const r = await call('PATCH', `/api/documents/${doc.id}`, { body: { content: dirty } });

    expect(r.data.content).not.toMatch(/script|onclick|onerror|javascript:|<img|<a /);
    expect(r.data.content).toContain('<p>Hi');
    expect(r.data.content).toContain('<h2>Title</h2>');
    expect(r.data.content).toContain('<em>ok</em>');
  });

  it('round-trips the exact HTML the TipTap editor produces', async () => {
    const doc = await createDoc();
    const html =
      '<h1>Goals</h1><p>This is <strong>bold</strong>, <em>italic</em> and <u>underlined</u></p>' +
      '<ul><li><p>Ship editor</p></li></ul><ol><li><p>First step</p></li></ol><h3>Notes</h3><p>a<br>b</p>';
    await call('PATCH', `/api/documents/${doc.id}`, { body: { content: html } });
    const r = await call('GET', `/api/documents/${doc.id}`);
    // sanitize-html writes <br> back as <br />. Same thing, just adjusting the expectation.
    expect(r.data.content).toBe(html.replace('<br>', '<br />'));
  });

  // docs saved by the old execCommand editor - make sure they still load
  it('keeps the <b>, <i>, and <div> tags from the old execCommand editor', async () => {
    const doc = await createDoc();
    const html = '<div><b>bold</b> and <i>italic</i></div><div><u>under</u></div>';
    const r = await call('PATCH', `/api/documents/${doc.id}`, { body: { content: html } });
    expect(r.data.content).toBe(html);
  });
});

describe('access control and sharing', () => {
  it('hides documents from users without access (404, not 403)', async () => {
    const doc = await createDoc(ALICE);
    expect((await call('GET', `/api/documents/${doc.id}`, { user: BOB })).status).toBe(404);
    expect((await call('PATCH', `/api/documents/${doc.id}`, { user: BOB, body: { title: 'x' } })).status).toBe(404);
  });

  it('owner shares by email; the recipient sees it under Shared and can edit', async () => {
    const doc = await createDoc(ALICE);
    const share = await call('POST', `/api/documents/${doc.id}/shares`, { body: { email: 'BOB@example.com' } });
    expect(share.status).toBe(201);
    expect(share.data.shares).toEqual([expect.objectContaining({ id: BOB, role: 'editor' })]);

    const bobList = await call('GET', '/api/documents', { user: BOB });
    expect(bobList.data).toEqual([expect.objectContaining({ id: doc.id, role: 'editor', ownerName: 'Alice Chen' })]);

    const edit = await call('PATCH', `/api/documents/${doc.id}`, { user: BOB, body: { content: '<p>from Bob</p>' } });
    expect(edit.status).toBe(200);
    expect(edit.data.role).toBe('editor');
  });

  it('only the owner can share, and only the owner sees the share list', async () => {
    const doc = await createDoc(ALICE);
    await call('POST', `/api/documents/${doc.id}/shares`, { body: { email: 'bob@example.com' } });

    const bobShare = await call('POST', `/api/documents/${doc.id}/shares`, {
      user: BOB,
      body: { email: 'carol@example.com' },
    });
    expect(bobShare.status).toBe(403);

    const bobView = await call('GET', `/api/documents/${doc.id}`, { user: BOB });
    expect(bobView.data.shares).toBeUndefined();
  });

  it('gives a clear error for unknown emails and self-sharing', async () => {
    const doc = await createDoc(ALICE);
    expect((await call('POST', `/api/documents/${doc.id}/shares`, { body: { email: 'nobody@x.com' } })).status).toBe(404);
    expect((await call('POST', `/api/documents/${doc.id}/shares`, { body: { email: 'alice@example.com' } })).status).toBe(400);
  });

  it('revoking access removes the document from the recipient', async () => {
    const doc = await createDoc(ALICE);
    await call('POST', `/api/documents/${doc.id}/shares`, { body: { email: 'bob@example.com' } });
    await call('DELETE', `/api/documents/${doc.id}/shares/${BOB}`);

    expect((await call('GET', `/api/documents/${doc.id}`, { user: BOB })).status).toBe(404);
    expect((await call('GET', '/api/documents', { user: BOB })).data).toEqual([]);
  });
});

describe('import', () => {
  it('turns a .txt file into a new document titled after the file', async () => {
    const r = await call('POST', '/api/documents/import', {
      form: fileForm('meeting-notes.txt', 'First <b>para</b>\n\nSecond para'),
    });
    expect(r.status).toBe(201);
    expect(r.data.title).toBe('meeting-notes');
    expect(r.data.content).toBe('<p>First &lt;b&gt;para&lt;/b&gt;</p>\n<p>Second para</p>');
  });

  it('converts a .md file into headings, lists, and emphasis', async () => {
    const md = '# Plan\n\nSome **bold** and *italic*.\n\n- one\n- two\n\n1. first\n2. second';
    const r = await call('POST', '/api/documents/import', { form: fileForm('plan.md', md) });
    expect(r.data.content).toContain('<h1>Plan</h1>');
    expect(r.data.content).toContain('<strong>bold</strong>');
    expect(r.data.content).toContain('<em>italic</em>');
    expect(r.data.content).toContain('<ul>\n<li>one</li>\n<li>two</li>\n</ul>');
    expect(r.data.content).toContain('<ol>\n<li>first</li>\n<li>second</li>\n</ol>');
  });

  // retro.docx is a minimal hand-built docx (made with python's zipfile): h1, h2, one bold run
  it('converts a real .docx file, keeping headings and bold', async () => {
    const bytes = readFileSync(new URL('./fixtures/retro.docx', import.meta.url));
    const form = new FormData();
    form.append('file', new Blob([bytes]), 'Team retro.docx');
    const r = await call('POST', '/api/documents/import', { form });
    expect(r.status).toBe(201);
    expect(r.data.title).toBe('Team retro');
    expect(r.data.content).toBe(
      '<h1>Team Retro</h1><p>What went <strong>well</strong> this sprint.</p><h2>Action items</h2><p>Fix the flaky test</p>'
    );
    // and it's a normal doc owned by whoever imported it
    const reopened = await call('GET', `/api/documents/${r.data.id}`);
    expect(reopened.data.role).toBe('owner');
  });

  // regression: this used to be a 500 because mammoth throws on non-zip input
  it('rejects a corrupt .docx with a clear error instead of crashing', async () => {
    const r = await call('POST', '/api/documents/import', { form: fileForm('broken.docx', 'not a zip') });
    expect(r.status).toBe(400);
    expect(r.data.error).toMatch(/could not read/i);
  });

  it('rejects unsupported file types with a clear message', async () => {
    const r = await call('POST', '/api/documents/import', { form: fileForm('virus.exe', 'MZ') });
    expect(r.status).toBe(400);
    expect(r.data.error).toMatch(/Unsupported file type/);
  });

  it('rejects files over the 2 MB limit', async () => {
    const big = 'x'.repeat(2 * 1024 * 1024 + 1);
    const r = await call('POST', '/api/documents/import', { form: fileForm('big.txt', big) });
    expect(r.status).toBe(413);
  });
});

describe('validation and errors', () => {
  it('returns 400 for malformed JSON', async () => {
    const res = await fetch(`${base}/api/documents`, {
      method: 'POST',
      headers: { 'x-user-id': ALICE, 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(res.status).toBe(400);
  });
});

describe('persistence', () => {
  it('keeps documents and shares after the database is reopened', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ajaia-'));
    const file = path.join(dir, 'test.db');
    try {
      let fileDb = openDb(file);
      let app = await startServer(fileDb);
      base = app.base;
      const doc = await createDoc(ALICE, 'Persisted');
      await call('PATCH', `/api/documents/${doc.id}`, { body: { content: '<p>still here</p>' } });
      await call('POST', `/api/documents/${doc.id}/shares`, { body: { email: 'bob@example.com' } });
      app.server.close();
      fileDb.close();

      // "restart": close everything and open the same file again
      fileDb = openDb(file);
      app = await startServer(fileDb);
      base = app.base;

      const reopened = await call('GET', `/api/documents/${doc.id}`);
      expect(reopened.data).toMatchObject({ title: 'Persisted', content: '<p>still here</p>' });
      expect(reopened.data.shares).toEqual([expect.objectContaining({ id: BOB })]);
      expect((await call('GET', `/api/documents/${doc.id}`, { user: BOB })).status).toBe(200);

      app.server.close();
      fileDb.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('demo seed', () => {
  it('seeds one sample owned by Alice and shared with Bob, only into an empty database', async () => {
    expect(seedDemoContent(db)).toBe(true);
    expect(seedDemoContent(db)).toBe(false);

    const alice = await call('GET', '/api/documents', { user: ALICE });
    const bob = await call('GET', '/api/documents', { user: BOB });
    const carol = await call('GET', '/api/documents', { user: CAROL });
    expect(alice.data).toHaveLength(1);
    expect(alice.data[0].role).toBe('owner');
    expect(bob.data[0]).toMatchObject({ role: 'editor', ownerName: 'Alice Chen' });
    expect(carol.data).toHaveLength(0);
  });
});
