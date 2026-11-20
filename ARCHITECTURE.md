# Architecture note

## How it fits together

```
Browser (client/app.js, bundled by esbuild)
  ├─ documents page: owned and shared lists, import
  ├─ editor: TipTap (ProseMirror) → HTML, autosave queue
  └─ share dialog (owners only)
        │  JSON over fetch, x-user-id header
        ▼
Express (src/app.js)
  ├─ currentUser    → 401 if the header isn't a seeded user
  ├─ loadDocument   → 404 if you have no access, 403 if the route is owner-only
  ├─ sanitize-html  → on every write, imports included
  └─ multer + mammoth / convert.js → import
        │
        ▼
store.js (all the SQL) → node:sqlite → data/ajaia.db
  users(id, name, email)
  documents(id, title, content, owner_id, created_at, updated_at)
  shares(document_id, user_id, role)   primary key (document_id, user_id)
```

## What I prioritized

The brief says depth beats breadth, so I put the time into the core loop (create → edit → save → reopen → share) and into making that loop trustworthy, rather than adding features.

1. **An editor whose output I can predict.** I started with `contenteditable` + `execCommand` because it's zero dependencies. It fell apart in a real browser: the first line of an empty doc ended up outside any paragraph, headings got dropped, and Chrome injected `<span style>` and a `<ul>` inside a `<p>`. I compared Quill, Lexical, Slate and TipTap against my constraints (plain JS, HTML in and out, output locked to the sanitizer's allow-list) and went with **TipTap** (ProseMirror underneath). I switched off every feature the server doesn't allow, so what you type is exactly what gets saved, and a test round-trips the editor's exact HTML. The full comparison is in `AI_WORKFLOW.md`.
2. **Access control on the server, not just in the UI.** Every document route checks your role. If you have no access you get a 404, not a 403, so you can't probe for document ids. Only the owner can share or remove access, and only the owner gets the share list in the response.
3. **Sanitize on write.** A shared doc renders HTML that someone else wrote, so this is a security requirement. The allow-list is the editor's formatting and nothing else, with no attributes at all. Imports go through the same sanitizer.
4. **One import path.** `.txt`, `.md` and `.docx` all end up in the same sanitizer and the same `createDocument` call. Bad files (wrong type, over 2 MB, a damaged `.docx`) get a 4xx with a readable message, never a 500.
5. **Saves you can trust.** Autosave runs 800 ms after you stop typing, and saves are queued so an old response can never overwrite a newer one. The status under the title always says what's happening. Leaving the editor flushes any pending save, and closing the tab with unsaved changes triggers the browser's warning.

## What I cut on purpose

- **Real-time co-editing** (CRDT/OT, presence, cursors). It's the biggest piece of a real Docs clone and the brief doesn't ask for it. Last-write-wins is simple and I say so up front.
- **Real authentication.** The brief allows seeded users. A switcher also makes reviewing sharing much faster than logging in and out.
- **Viewer roles, share links, deleting documents.** The `shares.role` column is already there, so a viewer role is a small change later.
- **Full Markdown and Word fidelity.** Import handles the structures the editor can actually show and drops the rest.
- **A frontend framework.** It's two screens and a dialog. Plain DOM code plus one editor library, bundled by esbuild in under a second, keeps setup at `npm install && npm start`.

## Decisions and tradeoffs

| Decision | Alternatives | Why |
|---|---|---|
| TipTap | `execCommand`, Quill, Lexical, Slate | `execCommand` broke in browser testing. Quill 2 marks list items with a `data-list` attribute, which my strip-all-attributes sanitizer would break. Lexical and Slate are React-first and much more setup for this scope. TipTap works in plain JS, reads and writes HTML, and its schema can be locked to my allow-list. Cost: about 390 KB minified bundle, mostly ProseMirror. |
| Store sanitized HTML | Store ProseMirror JSON | Easy to import into and easy to read in the database, and TipTap round-trips it cleanly for this schema. I'd switch to JSON if real-time collaboration (Yjs) comes in. |
| `node:sqlite` (built into Node) | better-sqlite3, Postgres, Supabase | One file, nothing to run, nothing to compile on a reviewer's machine. Cost: it's flagged experimental, so Node prints a warning on startup. |
| Render free web service | Fly.io, Railway, Vercel | Free with no card, deploys from a checked-in `render.yaml`, and runs a normal long-lived Node process (Vercel's serverless model doesn't suit SQLite on local disk). |
| Seed a sample doc into an empty DB | Ship a pre-built DB | Render's free disk resets, and a fresh deploy with nothing shared is a bad first impression. |
| 404 for no access | 403 | Doesn't confirm a document exists. |

## Persistence on the live demo

Locally, or on any host with a real disk, documents and shares survive refreshes and restarts. There's a test that closes and reopens the database file to check this.

On Render's free plan the disk is temporary. Data lasts through normal use, but a redeploy or the idle spin-down (about 15 minutes) resets it to the seeded state. That's the free host, not the app. Attaching a Render disk and pointing `DB_PATH` at it fixes it with no code change. Moving to Postgres would only touch `store.js`, since all the SQL lives there.

## Where it breaks first

- **Two people saving at the same moment.** The later save wins and the other person's changes are gone.
- **Very large docs.** The whole body is one row and one PATCH, capped at 1 MB.
- **Identity.** Anyone can send any seeded user id in the header.

## With another 2–4 hours

1. **Conflict detection.** Send the `updatedAt` you loaded with each save, return 409 if it's stale, and show a "someone else edited this, reload?" message.
2. **A signed session cookie** instead of trusting the `x-user-id` header.
3. **A viewer role** (TipTap with `editable: false`) and deleting documents for owners.
4. **A Playwright smoke test** for the editor. API tests didn't catch the `execCommand` problem, and a browser test would have.
