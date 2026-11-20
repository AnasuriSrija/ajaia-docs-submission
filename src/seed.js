import { createStore } from './store.js';

// Doubles as a mini guide for reviewers, since it's the first thing they'll open.
const WELCOME_HTML =
  '<h1>Welcome to Ajaia Docs</h1>' +
  '<p>This sample document is owned by <strong>Alice Chen</strong> and shared with <strong>Bob Singh</strong>.</p>' +
  '<h2>Try it</h2>' +
  '<ol>' +
  '<li><p>Switch users with the selector in the top-right corner.</p></li>' +
  '<li><p>As Bob, open this document from <em>Shared with me</em> and edit it.</p></li>' +
  '<li><p>As Carol, notice that this document does not appear at all.</p></li>' +
  '</ol>' +
  '<h2>Formatting</h2>' +
  '<ul><li><p><strong>Bold</strong>, <em>italic</em>, and <u>underline</u></p></li>' +
  '<li><p>Headings 1 to 3, bulleted and numbered lists</p></li></ul>';

// Only runs against an empty db. Render's free tier wipes the disk on
// redeploy/idle, and an empty app with nothing shared is a bad first impression.
// Returns true if it actually seeded (server logs it).
export function seedDemoContent(db) {
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM documents').get();
  if (count > 0) return false;

  const store = createStore(db);
  const doc = store.createDocument({ title: 'Welcome to Ajaia Docs', content: WELCOME_HTML, ownerId: 'u_alice' });
  store.addShare(doc.id, 'u_bob');
  return true;
}
