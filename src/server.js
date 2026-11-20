import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { openDb } from './db.js';
import { createApp } from './app.js';
import { seedDemoContent } from './seed.js';

const port = Number(process.env.PORT) || 3000;
const dbPath = process.env.DB_PATH || path.join('data', 'ajaia.db');

// sqlite won't create the folder for us
if (dbPath !== ':memory:') mkdirSync(path.dirname(dbPath), { recursive: true });

const db = openDb(dbPath);

// SEED_DEMO=false to start with a truly empty db
if (process.env.SEED_DEMO !== 'false' && seedDemoContent(db)) {
  console.log('Empty database, added the welcome doc (Alice -> shared with Bob)');
}

const server = createApp({ db }).listen(port, () => {
  console.log(`Ajaia Docs on http://localhost:${port}  (db: ${dbPath})`);
});

// Most common "it won't start": an old copy is still running in another terminal.
// Print something useful instead of a node stack trace.
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nPort ${port} is already in use (probably another copy of this app).`);
    console.error(`Stop it with:  lsof -ti tcp:${port} | xargs kill`);
    console.error(`Or use another port:  PORT=3001 npm start\n`);
    process.exit(1);
  }
  throw err;
});

// Close the db on shutdown so the WAL gets checkpointed back into the main file.
// Render sends SIGTERM on redeploy, Ctrl+C locally is SIGINT.
function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
