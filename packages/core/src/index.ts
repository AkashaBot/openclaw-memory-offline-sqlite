import Database from 'better-sqlite3';

export type MemConfig = {
  dbPath: string;
  ollamaBaseUrl?: string; // default http://127.0.0.1:11434
  embeddingModel?: string; // default bge-m3
  ollamaTimeoutMs?: number; // default 3000
};

export type MemItem = {
  id: string;
  created_at: number;
  source: string | null;
  source_id: string | null;
  title: string | null;
  text: string;
  tags: string | null;
  meta: string | null;
};

export type InsertItemInput = Omit<MemItem, 'created_at'> & { created_at?: number };

export type LexicalResult = { item: MemItem; lexicalScore: number };
export type HybridResult = LexicalResult & { semanticScore: number | null; score: number };

export function openDb(dbPath: string): Database.Database {
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

    -- Keep the FTS index in sync with items.
    CREATE TRIGGER IF NOT EXISTS items_ai AFTER INSERT ON items BEGIN
      INSERT INTO items_fts(rowid, title, text, tags)
      VALUES (new.rowid, new.title, new.text, new.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS items_ad AFTER DELETE ON items BEGIN
      INSERT INTO items_fts(items_fts, rowid, title, text, tags)
      VALUES('delete', old.rowid, old.title, old.text, old.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS items_au AFTER UPDATE ON items BEGIN
      INSERT INTO items_fts(items_fts, rowid, title, text, tags)
      VALUES('delete', old.rowid, old.title, old.text, old.tags);
      INSERT INTO items_fts(rowid, title, text, tags)
      VALUES (new.rowid, new.title, new.text, new.tags);
    END;

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

/**
 * Minimal escaping for FTS5 queries.
 *
 * - If the query is made of simple word tokens, return it as-is.
 * - Otherwise, wrap as a phrase query and escape double quotes.
 */
export function escapeFts5Query(query: string): string {
  const q = query.trim();
  if (!q) return '""';
  const simple = /^[\p{L}\p{N}_]+(?:\s+[\p{L}\p{N}_]+)*$/u;
  if (simple.test(q)) return q;
  return `"${q.replace(/"/g, '""')}"`;
}

/**
 * Convenience wrapper for CLI usage: accepts meta as an object and stringifies it.
 */
export function addItem(
  db: Database.Database,
  input: Omit<InsertItemInput, 'meta'> & { meta?: unknown }
): MemItem {
  return insertItem(db, {
    ...input,
    meta: input.meta === undefined ? null : typeof input.meta === 'string' ? input.meta : JSON.stringify(input.meta),
  });
}

/**
 * Convenience wrapper for CLI usage: returns the escaped query and lexical results.
 */
export function searchItems(db: Database.Database, query: string, limit = 10) {
  const escapedQuery = escapeFts5Query(query);
  const results = lexicalSearch(db, escapedQuery, limit);
  return { query, escapedQuery, results };
}

export function insertItem(db: Database.Database, input: InsertItemInput): MemItem {
  const now = input.created_at ?? Date.now();

  const stmt = db.prepare(`
    INSERT INTO items (id, created_at, source, source_id, title, text, tags, meta)
    VALUES (@id, @created_at, @source, @source_id, @title, @text, @tags, @meta)
  `);

  stmt.run({
    id: input.id,
    created_at: now,
    source: input.source ?? null,
    source_id: input.source_id ?? null,
    title: input.title ?? null,
    text: input.text,
    tags: input.tags ?? null,
    meta: input.meta ?? null,
  });

  return {
    id: input.id,
    created_at: now,
    source: input.source ?? null,
    source_id: input.source_id ?? null,
    title: input.title ?? null,
    text: input.text,
    tags: input.tags ?? null,
    meta: input.meta ?? null,
  };
}

export function lexicalSearch(db: Database.Database, query: string, limit = 10): LexicalResult[] {
  const rows = db
    .prepare(
      `
      SELECT
        i.id,
        i.created_at,
        i.source,
        i.source_id,
        i.title,
        i.text,
        i.tags,
        i.meta,
        bm25(items_fts) AS bm25
      FROM items_fts
      JOIN items i ON i.rowid = items_fts.rowid
      WHERE items_fts MATCH ?
      ORDER BY bm25 ASC
      LIMIT ?
    `
    )
    .all(query, limit) as any[];

  return rows.map((r) => ({
    item: {
      id: r.id,
      created_at: r.created_at,
      source: r.source,
      source_id: r.source_id,
      title: r.title,
      text: r.text,
      tags: r.tags,
      meta: r.meta,
    },
    // bm25: lower is better; flip sign so higher is better
    lexicalScore: -Number(r.bm25),
  }));
}

function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) throw new Error(`cosine: length mismatch ${a.length} vs ${b.length}`);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i]!;
    const bv = b[i]!;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

async function fetchEmbedding(
  cfg: MemConfig,
  input: string
): Promise<{ vector: Float32Array; dims: number; model: string }> {
  const baseUrl = cfg.ollamaBaseUrl ?? 'http://127.0.0.1:11434';
  const model = cfg.embeddingModel ?? 'bge-m3';
  const timeoutMs = cfg.ollamaTimeoutMs ?? 3000;

  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, input }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Ollama embeddings failed: ${res.status} ${res.statusText} ${body}`);
  }

  const json = (await res.json()) as any;
  const embedding = json?.data?.[0]?.embedding;
  if (!Array.isArray(embedding)) throw new Error('Ollama embeddings: missing data[0].embedding');

  const vec = new Float32Array(embedding.length);
  for (let i = 0; i < embedding.length; i++) vec[i] = Number(embedding[i]);

  return { vector: vec, dims: vec.length, model };
}

function vectorToBlob(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer.slice(vec.byteOffset, vec.byteOffset + vec.byteLength));
}

function blobToVector(blob: Buffer): Float32Array {
  return new Float32Array(blob.buffer, blob.byteOffset, Math.floor(blob.byteLength / 4));
}

async function getOrCreateItemEmbedding(
  db: Database.Database,
  cfg: MemConfig,
  itemId: string,
  text: string
): Promise<{ vector: Float32Array; dims: number; model: string } | null> {
  const model = cfg.embeddingModel ?? 'bge-m3';

  const row = db
    .prepare('SELECT model, dims, vector FROM embeddings WHERE item_id = ? AND model = ?')
    .get(itemId, model) as any;

  if (row?.vector) {
    return { model: row.model, dims: Number(row.dims), vector: blobToVector(row.vector as Buffer) };
  }

  // If Ollama is unavailable, degrade gracefully (no semantic score).
  try {
    const emb = await fetchEmbedding(cfg, text);
    const blob = vectorToBlob(emb.vector);
    db.prepare(
      `INSERT INTO embeddings (item_id, model, dims, vector, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(item_id) DO UPDATE SET
         model=excluded.model,
         dims=excluded.dims,
         vector=excluded.vector,
         updated_at=excluded.updated_at`
    ).run(itemId, emb.model, emb.dims, blob, Date.now());

    return emb;
  } catch {
    return null;
  }
}

export async function hybridSearch(
  db: Database.Database,
  cfg: MemConfig,
  query: string,
  opts?: { topK?: number; candidates?: number; semanticWeight?: number }
): Promise<HybridResult[]> {
  const topK = opts?.topK ?? 10;
  const candidates = opts?.candidates ?? Math.max(50, topK);
  const w = opts?.semanticWeight ?? 0.7;

  const lex = lexicalSearch(db, query, candidates);
  if (lex.length === 0) return [];

  let queryEmb: { vector: Float32Array; dims: number; model: string } | null = null;
  try {
    queryEmb = await fetchEmbedding(cfg, query);
  } catch {
    // Ollama unreachable => lexical-only results.
    return lex.slice(0, topK).map((r) => ({ ...r, semanticScore: null, score: r.lexicalScore }));
  }

  const lexScores = lex.map((r) => r.lexicalScore);
  const minLex = Math.min(...lexScores);
  const maxLex = Math.max(...lexScores);
  const denomLex = maxLex - minLex || 1;

  const out: HybridResult[] = [];
  for (const r of lex) {
    const itemEmb = await getOrCreateItemEmbedding(db, cfg, r.item.id, r.item.text);
    const sem = itemEmb ? cosine(queryEmb.vector, itemEmb.vector) : null;

    const lexNorm = (r.lexicalScore - minLex) / denomLex; // 0..1
    const semNorm = sem === null ? 0 : (sem + 1) / 2; // -1..1 => 0..1
    const score = (1 - w) * lexNorm + w * semNorm;

    out.push({ ...r, semanticScore: sem, score });
  }

  out.sort((a, b) => b.score - a.score);
  return out.slice(0, topK);
}
