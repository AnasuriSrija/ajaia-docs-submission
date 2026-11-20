// Using node's built-in sqlite (22.13+) instead of better-sqlite3 so there's no
// native module to compile on whoever's machine runs this. Downside: it's still
// flagged experimental and prints an ExperimentalWarning on startup. Harmless.
import { DatabaseSync } from 'node:sqlite';

// No real auth in scope - the brief allows seeded accounts. Fixed ids so the
// client can remember who you picked across refreshes.
export const SEED_USERS = [
  { id: 'u_alice', name: 'Alice Chen', email: 'alice@example.com' },
  { id: 'u_bob', name: 'Bob Singh', email: 'bob@example.com' },
  { id: 'u_carol', name: 'Carol Diaz', email: 'carol@example.com' },
];

// Small enough that CREATE IF NOT EXISTS on every boot is the whole "migration" story.
// TODO: if the schema actually changes, add a schema_version table + numbered migrations.
//
// content is stored as (sanitized) html, not ProseMirror JSON. Easier to import
// into and to eyeball in the db. Would switch to JSON if we ever do real-time collab.
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id    TEXT PRIMARY KEY,
    name  TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE
  );

  CREATE TABLE IF NOT EXISTS documents (
    id         TEXT PRIMARY KEY,
    title      TEXT NOT NULL,
    content    TEXT NOT NULL DEFAULT '',
    owner_id   TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- role is always 'editor' today. Column is here so a viewer role later
  -- doesn't need a migration.
  CREATE TABLE IF NOT EXISTS shares (
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL REFERENCES users(id),
    role        TEXT NOT NULL DEFAULT 'editor',
    created_at  TEXT NOT NULL,
    PRIMARY KEY (document_id, user_id)
  );
`;

// ':memory:' for tests, a file path for the real server
export function openDb(filename = ':memory:') {
  const db = new DatabaseSync(filename);

  db.exec('PRAGMA foreign_keys = ON;'); // off by default in sqlite, every connection
  // WAL so the list page isn't blocked behind autosave writes. Doesn't apply to :memory:
  if (filename !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');

  db.exec(SCHEMA);

  const insertUser = db.prepare('INSERT OR IGNORE INTO users (id, name, email) VALUES (?, ?, ?)');
  for (const u of SEED_USERS) insertUser.run(u.id, u.name, u.email);

  return db;
}
