import Database from 'better-sqlite3';

export type MemConfig = {
  dbPath: string;
  ollamaBaseUrl?: string; // default http://127.0.0.1:11434
  embeddingModel?: string; // default bge-m3
};

export function openDb(dbPath: string): any {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  return db;
}

export function initSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      source TEXT,
      source_id TEXT,
      title TEXT,
      text TEXT NOT NULL,
      tags TEXT,
      meta TEXT
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
      title,
      text,
      tags,
      content='items',
      content_rowid='rowid'
    );

    CREATE TABLE IF NOT EXISTS embeddings (
      item_id TEXT PRIMARY KEY,
      model TEXT NOT NULL,
      dims INTEGER NOT NULL,
      vector BLOB NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(item_id) REFERENCES items(id)
    );
  `);
}
