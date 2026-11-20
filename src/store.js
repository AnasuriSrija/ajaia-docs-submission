import { randomUUID } from 'node:crypto'; // no need for the uuid package anymore

// All the SQL is in here. Routes shouldn't have to know table/column names,
// and if this ever moves to Postgres this is the only file that changes.
export function createStore(db) {
  const USER_COLS = 'id, name, email';

  return {
    listUsers() {
      return db.prepare(`SELECT ${USER_COLS} FROM users ORDER BY name`).all();
    },

    getUser(id) {
      return db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).get(id) ?? null;
    },

    // case-insensitive, people type Bob@Example.com
    findUserByEmail(email) {
      return db.prepare(`SELECT ${USER_COLS} FROM users WHERE lower(email) = lower(?)`).get(email) ?? null;
    },

    createDocument({ title, content, ownerId }) {
      const id = randomUUID();
      const now = new Date().toISOString();
      db.prepare(
        'INSERT INTO documents (id, title, content, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(id, title, content, ownerId, now, now);
      return this.getDocument(id);
    },

    getDocument(id) {
      const row = db
        .prepare(
          `SELECT d.id, d.title, d.content, d.owner_id AS ownerId, u.name AS ownerName,
                  d.created_at AS createdAt, d.updated_at AS updatedAt
             FROM documents d
             JOIN users u ON u.id = d.owner_id
            WHERE d.id = ?`
        )
        .get(id);
      return row ?? null;
    },

    // Everything a user can open: their own docs + anything shared with them.
    // role is 'owner' for their own, otherwise whatever the share row says.
    // No content column here - the list page doesn't need the bodies.
    listDocumentsFor(userId) {
      return db
        .prepare(
          `SELECT d.id, d.title, d.owner_id AS ownerId, u.name AS ownerName,
                  d.updated_at AS updatedAt,
                  CASE WHEN d.owner_id = ? THEN 'owner' ELSE s.role END AS role
             FROM documents d
             JOIN users u ON u.id = d.owner_id
             LEFT JOIN shares s ON s.document_id = d.id AND s.user_id = ?
            WHERE d.owner_id = ? OR s.user_id IS NOT NULL
            ORDER BY d.updated_at DESC`
        )
        .all(userId, userId, userId);
    },

    // 'owner' | 'editor' | null. null = no access (or doc doesn't exist, same thing to the caller)
    getRole(documentId, userId) {
      const row = db
        .prepare(
          `SELECT CASE WHEN d.owner_id = ? THEN 'owner' ELSE s.role END AS role
             FROM documents d
             LEFT JOIN shares s ON s.document_id = d.id AND s.user_id = ?
            WHERE d.id = ?`
        )
        .get(userId, userId, documentId);
      return row?.role ?? null;
    },

    // Two statements if both fields change. The UI never sends both at once
    // (title saves on blur, body on autosave) so not worth building a dynamic SET.
    updateDocument(id, { title, content }) {
      const now = new Date().toISOString();
      if (title !== undefined) {
        db.prepare('UPDATE documents SET title = ?, updated_at = ? WHERE id = ?').run(title, now, id);
      }
      if (content !== undefined) {
        db.prepare('UPDATE documents SET content = ?, updated_at = ? WHERE id = ?').run(content, now, id);
      }
      return this.getDocument(id);
    },

    listShares(documentId) {
      return db
        .prepare(
          `SELECT u.id, u.name, u.email, s.role
             FROM shares s
             JOIN users u ON u.id = s.user_id
            WHERE s.document_id = ?
            ORDER BY u.name`
        )
        .all(documentId);
    },

    // sharing with someone who already has access is a no-op, not an error
    addShare(documentId, userId) {
      db.prepare(
        `INSERT INTO shares (document_id, user_id, role, created_at) VALUES (?, ?, 'editor', ?)
         ON CONFLICT(document_id, user_id) DO NOTHING`
      ).run(documentId, userId, new Date().toISOString());
    },

    removeShare(documentId, userId) {
      db.prepare('DELETE FROM shares WHERE document_id = ? AND user_id = ?').run(documentId, userId);
    },
  };
}
