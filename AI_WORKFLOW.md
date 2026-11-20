# AI workflow note

## Tools

I used **Claude Code** (Anthropic's coding agent, running on Claude Opus) in my local repo. No other AI tools.

I treated it like a fast pair programmer. I set the direction and the quality bar. It handled most of the implementation, especially the parts that are mostly typing: UI markup and CSS, wiring, and test boilerplate. I reviewed every change, and nothing counted as done until it was proven with a test or in the browser. The judgment calls were mine: what to build, what to cut, which tradeoffs to accept, and when something wasn't good enough.

## How I worked with it

- **Spec first, code second.** I started from the brief and one non-negotiable: every requirement met. Then I scoped it deliberately: a seeded-user switcher instead of real auth, last-write-wins instead of real-time collaboration, embedded SQLite instead of a hosted database. Each one trades breadth for depth in the core loop. The reasons are in `ARCHITECTURE.md`.
- **Constraints the agent had to work within.** No frontend framework for two screens. Access control enforced on the server, not just hidden in the UI. Stored HTML sanitized on write, because shared docs render one user's content in another user's browser. Nothing for reviewers to install or pay for.
- **Evidence over assertions.** For each requirement I wanted proof: a test, or the flow clicked through in a real browser. Several of the fixes below exist only because of that.
- **I didn't take the agent's tool choices at face value.** The editor library was the biggest one, so I researched it myself (details below).
- **I owned anything public or irreversible.** It offered to create a GitHub repo and push. I said no, because I wanted to test locally first and handle the repo and deployment myself.

## Picking the editor: my research

The editor is the heart of the product, so I didn't want to just accept whatever the agent reached for. Once raw `contenteditable` + `execCommand` proved unreliable (see below), I compared the main rich-text options against four constraints I'd set:

1. **No frontend framework.** The client is plain JS, and I wasn't adding React just for the editor.
2. **HTML in, HTML out.** The server stores sanitized HTML, and imports (`.md`, `.docx`) arrive as HTML.
3. **The editor's output has to match my sanitizer's allow-list exactly**, or formatting gets silently stripped on save.
4. **Ready-made basics.** Bold, italic, underline, headings, lists and undo should come built in, not be hand-built under a timebox.

How the options compared:

- **Quill:** quick to set up and works in plain JS. But its native format is Delta, not HTML, and in Quill 2 list items carry a `data-list` attribute to tell bullets from numbers. My sanitizer strips every attribute, so bullet lists could come back as numbered lists unless I special-cased it. It's also harder to lock down which formats are allowed.
- **Lexical (Meta):** modern and fast, but built React-first (most plugins and docs assume React). It stores state as JSON, so HTML import/export takes an extra package and more setup. It's also still on 0.x, so the API can change between releases.
- **Slate:** React-only, and really a toolkit for *building* an editor. I'd be writing list behavior, normalization and HTML conversion myself. That flexibility fits a big product, not a timeboxed slice.
- **TipTap (on ProseMirror):** works in plain JS, `getHTML()` and HTML content loading are built in, and the starter kit covers exactly the brief's formatting. Every extra node or mark (links, code, blockquote, strike) can be switched off, so the editor can *only* produce what the sanitizer allows. A test checks that round trip. ProseMirror underneath is mature, and it has a well-trodden path to real-time collaboration through Yjs, which is my next step after conflict detection.

**Why TipTap won:** it was the only option that met all four constraints without fighting the rest of my design. The costs I accepted: a bigger bundle (about 390 KB minified, mostly ProseMirror, fine for an internal tool), and the fact that some of TipTap's add-ons (hosted collaboration, comments) are paid. The core I use is MIT and free.

## Where AI genuinely saved time

- **Boilerplate and UI.** Express routes, the SQLite schema and queries, and all the DOM and CSS work came together in a few iterations instead of an afternoon.
- **Tests.** It turned the brief's requirements (owner, grant access, owned vs shared, persistence, file types) into 24 HTTP-level tests, plus a real `.docx` fixture built with Python's `zipfile` so the Word import is tested on an actual Word file.
- **Swapping the editor.** Moving from `execCommand` to TipTap, including toolbar active states, the heading selector, undo/redo and the esbuild step, took minutes once we knew why the first editor was broken.

## What I rejected or had changed

- **The first UI.** It worked, but it looked like a generic template: Google blue, system font, pill badges everywhere. I asked for a deliberate design. The result is a warm paper palette, IBM Plex Sans with Source Serif for the document, an owner/last-edited table instead of plain cards, and sharing moved into a dialog.
- **The first editor (`contenteditable` + `execCommand`).** It passed every API test but broke in the browser: the first line of a new doc landed outside any paragraph, headings got dropped, and Chrome injected `<span style>` and a `<ul>` inside a `<p>`. We replaced it with TipTap. The old toolbar code is left in `client/app.js` as a comment so the history is visible.
- **Code that read like it came off an assembly line.** Every function had the same doc block and the comments said *what*, not *why*. I had it reworked so the comments explain decisions, real TODOs mark the next steps, and commented-out code shows approaches that changed. I checked that those notes only describe things that actually happened during the build.
- **A confusing startup crash.** When I ran it locally, an old copy was still holding port 3000 and Node printed a stack trace. The server now prints a plain explanation and the two ways to fix it.

Issues that review and testing caught before they shipped:

- **A damaged `.docx` returned a 500.** Mammoth throws on anything that isn't a valid zip. It's now a 400 with a readable message, and there's a regression test.
- **Switching users mid-edit saved as the wrong person.** The pending autosave flushed with the *new* user's id. The editor now pins the user it was opened with.
- **Switching users rendered the list twice,** because the hash change and a direct `route()` call both fired.
- **The sanitizer was too strict at first.** It stripped `<b>`/`<i>`/`<div>` from the old editor, which would have silently removed formatting.
- **`npm audit` flagged multer 1.x.** I upgraded to 2.x, which has the same API.
- **Async errors would hang requests** in the import handler under Express 4. Errors now go to `next()`.
- **Dependencies I didn't want:** `uuid` (Node's `crypto.randomUUID()` covers it) and a native SQLite driver (built-in `node:sqlite` means reviewers have nothing to compile).

## How I checked correctness, UX and reliability

- **Tests:** `npm test` runs 24 tests against the real Express app over HTTP. They cover CRUD, sanitization (including the exact HTML the editor produces), access control, all three import types plus bad files, malformed JSON, persistence after reopening the database file, and the demo seed. The agent drafted the suite from the brief's requirements. I reviewed the cases for coverage and made sure the edge cases I cared about (404 vs 403, corrupt uploads, the restart test) were in there.
- **By hand, in the browser:**
  - I tested the sharing flow myself: shared from Alice to Bob, edited as Bob, checked the edit as Alice, confirmed Carol can't see the doc or open its URL, then removed Bob's access.
  - I also tried bad emails and sharing with myself.
  - The agent separately drove the UI for formatting, import (including a rejected `.pdf`) and the 375 px phone layout. The screenshots in `docs/screenshots/` come from that pass.
- **Clean install:** a copy without `node_modules` or build output runs `npm ci`, `npm run build`, `npm test` and starts. That's the same sequence Render runs.
- **Security basics:** scripts, event handlers and `javascript:` links are stripped (tested), non-members get 404 (tested), and `npm audit` is clean.

## What I'd do differently

I'd ask for a browser-level smoke test (Playwright) from day one instead of relying on API tests plus manual clicking. The `execCommand` problem passed every API test, and only showed up in a real browser.
