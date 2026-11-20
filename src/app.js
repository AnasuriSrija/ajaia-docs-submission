import express from 'express';
import multer from 'multer';
import mammoth from 'mammoth';
import sanitizeHtml from 'sanitize-html';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from './store.js';
import { markdownToHtml, textToHtml } from './convert.js';

export const MAX_CONTENT_CHARS = 1_000_000; // ~1MB of html, way more than any real doc here
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
export const ALLOWED_IMPORT_EXTENSIONS = ['.txt', '.md', '.docx'];

// Docs get rendered in *other people's* browsers once shared, so the html is
// sanitized on every write (not on read - stored data should already be clean).
//
// The list is basically what the TipTap toolbar can produce. No attributes at all,
// which also kills style=, on*=, href etc. in one go.
//
// b / i / div: TipTap never outputs these. They came from v1 of the editor
// (contenteditable + execCommand) - Chrome emits <b>/<i> and wraps lines in <div>.
// Keeping them so anything saved back then still renders. TipTap maps b/i to
// bold/italic when it loads the doc anyway.
//
// first version of the list - silently ate the execCommand formatting:
// allowedTags: ['p', 'h1', 'h2', 'h3', 'strong', 'em', 'u', 'ul', 'ol', 'li', 'br'],
const SANITIZE_OPTIONS = {
  allowedTags: ['p', 'div', 'h1', 'h2', 'h3', 'strong', 'b', 'em', 'i', 'u', 'ul', 'ol', 'li', 'br'],
  allowedAttributes: {},
  disallowedTagsMode: 'discard',
};

export function sanitizeContent(html) {
  return sanitizeHtml(String(html ?? ''), SANITIZE_OPTIONS);
}

// null means "not a usable title" - callers decide whether that's a 400 or a default
function cleanTitle(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().slice(0, 200);
  return trimmed || null;
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// db is passed in so tests can hand us an in-memory one
export function createApp({ db }) {
  const store = createStore(db);
  const app = express();

  // memoryStorage is fine at 2MB - nothing touches disk, we only need the buffer.
  // (was on multer 1.x, npm audit flagged the busboy/dicer DoS - 2.x is the same API)
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES } });

  app.use(express.json({ limit: '2mb' }));

  const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
  app.use(express.static(publicDir));

  // "Auth": the client sends the picked demo user's id in a header. The brief
  // allows seeded users, but to be clear this is NOT secure - anyone can send any id.
  // TODO: signed session cookie instead of trusting the header
  function currentUser(req, res, next) {
    const user = store.getUser(req.get('x-user-id') ?? '');
    if (!user) return res.status(401).json({ error: 'Select a user to continue.' });
    req.user = user;
    next();
  }

  // No access -> 404, not 403, so you can't tell whether a doc id exists.
  // 403 is only for "you can see it but you're not the owner" (editor trying to share).
  function loadDocument({ requireOwner = false } = {}) {
    return (req, res, next) => {
      const role = store.getRole(req.params.id, req.user.id);
      if (!role) return res.status(404).json({ error: 'Document not found.' });
      if (requireOwner && role !== 'owner') {
        return res.status(403).json({ error: 'Only the owner can do that.' });
      }
      req.doc = store.getDocument(req.params.id);
      req.role = role;
      next();
    };
  }

  app.get('/api/health', (req, res) => res.json({ ok: true })); // render health check

  // public on purpose - the user picker needs it before anyone is "logged in"
  app.get('/api/users', (req, res) => res.json(store.listUsers()));

  app.get('/api/documents', currentUser, (req, res) => {
    res.json(store.listDocumentsFor(req.user.id));
  });

  app.post('/api/documents', currentUser, (req, res) => {
    const title = cleanTitle(req.body?.title) ?? 'Untitled document';
    const content = sanitizeContent(req.body?.content ?? '<p></p>');
    if (content.length > MAX_CONTENT_CHARS) throw httpError(413, 'Document is too large.');
    res.status(201).json(store.createDocument({ title, content, ownerId: req.user.id }));
  });

  app.get('/api/documents/:id', currentUser, loadDocument(), (req, res) => {
    const body = { ...req.doc, role: req.role };
    // share list is owner-only, editors don't need to see who else has access
    if (req.role === 'owner') body.shares = store.listShares(req.doc.id);
    res.json(body);
  });

  // Rename and body save both come through here. The client sends them separately
  // (title on blur, body on autosave), but either/both is accepted.
  // TODO: conflict detection - client sends the updatedAt it loaded, 409 if it's stale.
  // Right now it's last-write-wins if two people edit at the same time.
  app.patch('/api/documents/:id', currentUser, loadDocument(), (req, res) => {
    const changes = {};

    if (req.body?.title !== undefined) {
      const title = cleanTitle(req.body.title);
      if (!title) throw httpError(400, 'Title cannot be empty.');
      changes.title = title;
    }

    if (req.body?.content !== undefined) {
      if (typeof req.body.content !== 'string') throw httpError(400, 'Content must be a string.');
      // check the raw length before sanitizing so we don't run the sanitizer on 50MB of junk
      if (req.body.content.length > MAX_CONTENT_CHARS) throw httpError(413, 'Document is too large.');
      changes.content = sanitizeContent(req.body.content);
    }

    if (Object.keys(changes).length === 0) throw httpError(400, 'Nothing to update.');
    res.json({ ...store.updateDocument(req.doc.id, changes), role: req.role });
  });

  app.post('/api/documents/:id/shares', currentUser, loadDocument({ requireOwner: true }), (req, res) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
    const target = email && store.findUserByEmail(email);
    if (!target) throw httpError(404, 'No user with that email.');
    if (target.id === req.doc.ownerId) throw httpError(400, 'You already own this document.');

    store.addShare(req.doc.id, target.id);
    // send back the whole list so the dialog can just re-render
    res.status(201).json({ shares: store.listShares(req.doc.id) });
  });

  app.delete('/api/documents/:id/shares/:userId', currentUser, loadDocument({ requireOwner: true }), (req, res) => {
    store.removeShare(req.doc.id, req.params.userId);
    res.json({ shares: store.listShares(req.doc.id) });
  });

  // Every import becomes a *new* document owned by the uploader.
  //
  // Express 4 doesn't catch rejected promises from async handlers - the request
  // just hangs until the client times out. Hence the try/catch -> next(err).
  // (Express 5 handles this natively, didn't want to upgrade mid-way.)
  app.post('/api/documents/import', currentUser, upload.single('file'), async (req, res, next) => {
    try {
      if (!req.file) throw httpError(400, 'Choose a file to import.');

      // going by extension, not mimetype - browsers report .md as all sorts of things
      const ext = path.extname(req.file.originalname).toLowerCase();
      if (!ALLOWED_IMPORT_EXTENSIONS.includes(ext)) {
        throw httpError(400, `Unsupported file type. Use ${ALLOWED_IMPORT_EXTENSIONS.join(', ')}.`);
      }

      let html;
      if (ext === '.txt') {
        html = textToHtml(req.file.buffer.toString('utf8'));
      } else if (ext === '.md') {
        html = markdownToHtml(req.file.buffer.toString('utf8'));
      } else {
        // mammoth throws on anything that isn't a valid docx (it's a zip underneath).
        // That used to fall through to the 500 handler - a renamed .txt shouldn't be a server error.
        try {
          html = (await mammoth.convertToHtml({ buffer: req.file.buffer })).value;
        } catch {
          throw httpError(400, 'Could not read that .docx file. It may be damaged or not a Word document.');
        }
      }

      const title = cleanTitle(path.basename(req.file.originalname, ext)) ?? 'Imported document';
      // same sanitizer as normal saves - mammoth output can include images, tables, links etc.
      const content = sanitizeContent(html) || '<p></p>';
      res.status(201).json(store.createDocument({ title, content, ownerId: req.user.id }));
    } catch (err) {
      next(err);
    }
  });

  // `next` is unused, but express only treats this as an error handler if it takes 4 args
  app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'File is larger than 2 MB.' });
    }
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'Request body is not valid JSON.' });
    }
    if (err.status) return res.status(err.status).json({ error: err.message });

    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  });

  return app;
}
