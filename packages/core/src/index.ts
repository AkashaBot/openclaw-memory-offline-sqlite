import Database from 'better-sqlite3';

export type MemConfig = {
  dbPath: string;
  // Embeddings provider configuration. Defaults to Ollama+bge-m3 for backward compatibility.
  provider?: 'ollama' | 'openai';

  // Ollama-specific config
  ollamaBaseUrl?: string; // default http://127.0.0.1:11434
  ollamaTimeoutMs?: number; // default 3000

  // OpenAI-specific config
  openaiBaseUrl?: string; // default https://api.openai.com
  openaiApiKey?: string;
  openaiModel?: string; // default text-embedding-3-small

  // Generic embedding model name (used as default for the chosen provider)
  embeddingModel?: string; // default bge-m3 for Ollama; text-embedding-3-small for OpenAI
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
  // Phase 1: Attribution & Session
  entity_id: string | null;   // Who said/wrote this (user, agent, system)
  process_id: string | null;  // Which agent/process captured this
  session_id: string | null;  // Session/conversation grouping
};

// Phase 2: Structured Facts
export type Fact = {
  id: string;
  created_at: number;
  subject: string;      // Who/what the fact is about (e.g., "Loïc", "Akasha")
  predicate: string;    // The relationship (e.g., "works_at", "prefers", "is")
  object: string;       // The value (e.g., "Fasst", "short answers", "helpful")
  confidence: number;   // 0-1, how confident we are in this fact
  source_item_id: string | null;  // Link to the memory item it was extracted from
  entity_id: string | null;       // Who said/wrote this fact
};

export type InsertFactInput = Omit<Fact, 'created_at'> & { created_at?: number };

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
      meta TEXT,
      -- Phase 1: Attribution & Session
      entity_id TEXT,
      process_id TEXT,
      session_id TEXT
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

    -- Phase 2: Structured Facts Table
    CREATE TABLE IF NOT EXISTS facts (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      subject TEXT NOT NULL,
      predicate TEXT NOT NULL,
      object TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.5,
      source_item_id TEXT,
      entity_id TEXT,
      FOREIGN KEY(source_item_id) REFERENCES items(id)
    );

    -- Indexes for Phase 1: Attribution & Session filtering
    CREATE INDEX IF NOT EXISTS idx_items_entity_id ON items(entity_id);
    CREATE INDEX IF NOT EXISTS idx_items_process_id ON items(process_id);
    CREATE INDEX IF NOT EXISTS idx_items_session_id ON items(session_id);

    -- Indexes for Phase 2: Facts queries
    CREATE INDEX IF NOT EXISTS idx_facts_subject ON facts(subject);
    CREATE INDEX IF NOT EXISTS idx_facts_predicate ON facts(predicate);
    CREATE INDEX IF NOT EXISTS idx_facts_entity_id ON facts(entity_id);
  `);
}

/**
 * Run migrations for existing databases that lack Phase 1 columns.
 * Safe to call on every startup - will only add missing columns.
 */
export function runMigrations(db: Database.Database) {
  const cols = db.prepare("PRAGMA table_info(items)").all() as { name: string }[];
  const existing = new Set(cols.map(c => c.name));

  const migrations = [
    { col: 'entity_id', sql: 'ALTER TABLE items ADD COLUMN entity_id TEXT' },
    { col: 'process_id', sql: 'ALTER TABLE items ADD COLUMN process_id TEXT' },
    { col: 'session_id', sql: 'ALTER TABLE items ADD COLUMN session_id TEXT' },
  ];

  for (const m of migrations) {
    if (!existing.has(m.col)) {
      db.exec(m.sql);
    }
  }

  // Ensure indexes exist (safe to repeat)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_items_entity_id ON items(entity_id);
    CREATE INDEX IF NOT EXISTS idx_items_process_id ON items(process_id);
    CREATE INDEX IF NOT EXISTS idx_items_session_id ON items(session_id);
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
    INSERT INTO items (id, created_at, source, source_id, title, text, tags, meta, entity_id, process_id, session_id)
    VALUES (@id, @created_at, @source, @source_id, @title, @text, @tags, @meta, @entity_id, @process_id, @session_id)
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
    entity_id: input.entity_id ?? null,
    process_id: input.process_id ?? null,
    session_id: input.session_id ?? null,
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
    entity_id: input.entity_id ?? null,
    process_id: input.process_id ?? null,
    session_id: input.session_id ?? null,
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
        i.entity_id,
        i.process_id,
        i.session_id,
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
      entity_id: r.entity_id,
      process_id: r.process_id,
      session_id: r.session_id,
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

async function fetchEmbeddingOllama(
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

async function fetchEmbeddingOpenAI(
  cfg: MemConfig,
  input: string
): Promise<{ vector: Float32Array; dims: number; model: string }> {
  const baseUrl = cfg.openaiBaseUrl ?? 'https://api.openai.com';
  const apiKey = cfg.openaiApiKey;
  if (!apiKey) {
    throw new Error('OpenAI embeddings: missing openaiApiKey in MemConfig');
  }

  const model = cfg.openaiModel ?? (cfg.embeddingModel || 'text-embedding-3-small');
  const timeoutMs = cfg.ollamaTimeoutMs ?? 3000;

  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/embeddings`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, input }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`OpenAI embeddings failed: ${res.status} ${res.statusText} ${body}`);
  }

  const json = (await res.json()) as any;
  const embedding = json?.data?.[0]?.embedding;
  if (!Array.isArray(embedding)) throw new Error('OpenAI embeddings: missing data[0].embedding');

  const vec = new Float32Array(embedding.length);
  for (let i = 0; i < embedding.length; i++) vec[i] = Number(embedding[i]);

  return { vector: vec, dims: vec.length, model };
}

async function fetchEmbedding(
  cfg: MemConfig,
  input: string
): Promise<{ vector: Float32Array; dims: number; model: string }> {
  const provider = cfg.provider ?? 'ollama';
  if (provider === 'openai') {
    return fetchEmbeddingOpenAI(cfg, input);
  }
  // Default: Ollama
  return fetchEmbeddingOllama(cfg, input);
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

  // Candidates: lexical hits + recents (merged).
  const lexHits = lexicalSearch(db, query, candidates);
  const recentRows = db
    .prepare(
      `SELECT id, created_at, source, source_id, title, text, tags, meta, entity_id, process_id, session_id
       FROM items
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(candidates) as any[];

  const recent: LexicalResult[] = recentRows.map((r) => ({
    item: {
      id: r.id,
      created_at: r.created_at,
      source: r.source,
      source_id: r.source_id,
      title: r.title,
      text: r.text,
      tags: r.tags,
      meta: r.meta,
      entity_id: r.entity_id,
      process_id: r.process_id,
      session_id: r.session_id,
    },
    lexicalScore: 0,
  }));

  const merged: LexicalResult[] = [];
  const seen = new Set<string>();
  for (const r of [...lexHits, ...recent]) {
    if (seen.has(r.item.id)) continue;
    seen.add(r.item.id);
    merged.push(r);
  }

  let lex = merged;
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

// ============================================================================
// Phase 1: Attribution & Session Filtering
// ============================================================================

export type FilterOpts = {
  entity_id?: string | null;
  process_id?: string | null;
  session_id?: string | null;
};

/**
 * Filter hybrid search results by attribution/session fields.
 */
export function filterResults(results: HybridResult[], opts: FilterOpts): HybridResult[] {
  return results.filter(r => {
    if (opts.entity_id !== undefined && r.item.entity_id !== opts.entity_id) return false;
    if (opts.process_id !== undefined && r.item.process_id !== opts.process_id) return false;
    if (opts.session_id !== undefined && r.item.session_id !== opts.session_id) return false;
    return true;
  });
}

/**
 * Hybrid search with built-in filtering (more efficient than filter + hybridSearch).
 */
export async function hybridSearchFiltered(
  db: Database.Database,
  cfg: MemConfig,
  query: string,
  opts?: {
    topK?: number;
    candidates?: number;
    semanticWeight?: number;
    filter?: FilterOpts;
  }
): Promise<HybridResult[]> {
  const results = await hybridSearch(db, cfg, query, opts);
  if (!opts?.filter) return results;
  return filterResults(results, opts.filter);
}

/**
 * Get all memories for a specific entity (e.g., "what did Loïc tell me?").
 */
export function getMemoriesByEntity(
  db: Database.Database,
  entity_id: string,
  limit = 50
): MemItem[] {
  const rows = db
    .prepare(
      `SELECT id, created_at, source, source_id, title, text, tags, meta, entity_id, process_id, session_id
       FROM items
       WHERE entity_id = ?
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(entity_id, limit) as any[];

  return rows.map(r => ({
    id: r.id,
    created_at: r.created_at,
    source: r.source,
    source_id: r.source_id,
    title: r.title,
    text: r.text,
    tags: r.tags,
    meta: r.meta,
    entity_id: r.entity_id,
    process_id: r.process_id,
    session_id: r.session_id,
  }));
}

/**
 * Get all memories for a specific session/conversation.
 */
export function getMemoriesBySession(
  db: Database.Database,
  session_id: string,
  limit = 100
): MemItem[] {
  const rows = db
    .prepare(
      `SELECT id, created_at, source, source_id, title, text, tags, meta, entity_id, process_id, session_id
       FROM items
       WHERE session_id = ?
       ORDER BY created_at ASC
       LIMIT ?`
    )
    .all(session_id, limit) as any[];

  return rows.map(r => ({
    id: r.id,
    created_at: r.created_at,
    source: r.source,
    source_id: r.source_id,
    title: r.title,
    text: r.text,
    tags: r.tags,
    meta: r.meta,
    entity_id: r.entity_id,
    process_id: r.process_id,
    session_id: r.session_id,
  }));
}

/**
 * Get all memories captured by a specific process/agent.
 */
export function getMemoriesByProcess(
  db: Database.Database,
  process_id: string,
  limit = 100
): MemItem[] {
  const rows = db
    .prepare(
      `SELECT id, created_at, source, source_id, title, text, tags, meta, entity_id, process_id, session_id
       FROM items
       WHERE process_id = ?
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(process_id, limit) as any[];

  return rows.map(r => ({
    id: r.id,
    created_at: r.created_at,
    source: r.source,
    source_id: r.source_id,
    title: r.title,
    text: r.text,
    tags: r.tags,
    meta: r.meta,
    entity_id: r.entity_id,
    process_id: r.process_id,
    session_id: r.session_id,
  }));
}

/**
 * List distinct entity_ids in the database.
 */
export function listEntities(db: Database.Database): string[] {
  const rows = db
    .prepare(`SELECT DISTINCT entity_id FROM items WHERE entity_id IS NOT NULL ORDER BY entity_id`)
    .all() as { entity_id: string }[];
  return rows.map(r => r.entity_id);
}

/**
 * List distinct session_ids in the database.
 */
export function listSessions(db: Database.Database): string[] {
  const rows = db
    .prepare(`SELECT DISTINCT session_id FROM items WHERE session_id IS NOT NULL ORDER BY session_id`)
    .all() as { session_id: string }[];
  return rows.map(r => r.session_id);
}

// ============================================================================
// Phase 2: Structured Facts
// ============================================================================

/**
 * Insert a new fact into the database.
 */
export function insertFact(db: Database.Database, input: InsertFactInput): Fact {
  const stmt = db.prepare(`
    INSERT INTO facts (id, created_at, subject, predicate, object, confidence, source_item_id, entity_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const created_at = input.created_at ?? Date.now();
  stmt.run(
    input.id,
    created_at,
    input.subject,
    input.predicate,
    input.object,
    input.confidence,
    input.source_item_id ?? null,
    input.entity_id ?? null
  );
  return { ...input, created_at };
}

/**
 * Get all facts about a specific subject.
 */
export function getFactsBySubject(db: Database.Database, subject: string, limit = 100): Fact[] {
  const rows = db
    .prepare(
      `SELECT id, created_at, subject, predicate, object, confidence, source_item_id, entity_id
       FROM facts
       WHERE subject = ?
       ORDER BY confidence DESC, created_at DESC
       LIMIT ?`
    )
    .all(subject, limit) as any[];

  return rows.map(r => ({
    id: r.id,
    created_at: r.created_at,
    subject: r.subject,
    predicate: r.predicate,
    object: r.object,
    confidence: r.confidence,
    source_item_id: r.source_item_id,
    entity_id: r.entity_id,
  }));
}

/**
 * Get all facts with a specific predicate.
 */
export function getFactsByPredicate(db: Database.Database, predicate: string, limit = 100): Fact[] {
  const rows = db
    .prepare(
      `SELECT id, created_at, subject, predicate, object, confidence, source_item_id, entity_id
       FROM facts
       WHERE predicate = ?
       ORDER BY confidence DESC, created_at DESC
       LIMIT ?`
    )
    .all(predicate, limit) as any[];

  return rows.map(r => ({
    id: r.id,
    created_at: r.created_at,
    subject: r.subject,
    predicate: r.predicate,
    object: r.object,
    confidence: r.confidence,
    source_item_id: r.source_item_id,
    entity_id: r.entity_id,
  }));
}

/**
 * Search facts by subject, predicate, or object (simple LIKE search).
 */
export function searchFacts(db: Database.Database, query: string, limit = 50): Fact[] {
  const pattern = `%${query}%`;
  const rows = db
    .prepare(
      `SELECT id, created_at, subject, predicate, object, confidence, source_item_id, entity_id
       FROM facts
       WHERE subject LIKE ? OR predicate LIKE ? OR object LIKE ?
       ORDER BY confidence DESC, created_at DESC
       LIMIT ?`
    )
    .all(pattern, pattern, pattern, limit) as any[];

  return rows.map(r => ({
    id: r.id,
    created_at: r.created_at,
    subject: r.subject,
    predicate: r.predicate,
    object: r.object,
    confidence: r.confidence,
    source_item_id: r.source_item_id,
    entity_id: r.entity_id,
  }));
}

/**
 * Get all facts (optionally filtered by entity_id).
 */
export function getAllFacts(db: Database.Database, entityId?: string, limit = 100): Fact[] {
  let rows: any[];
  if (entityId) {
    rows = db
      .prepare(
        `SELECT id, created_at, subject, predicate, object, confidence, source_item_id, entity_id
         FROM facts
         WHERE entity_id = ?
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(entityId, limit) as any[];
  } else {
    rows = db
      .prepare(
        `SELECT id, created_at, subject, predicate, object, confidence, source_item_id, entity_id
         FROM facts
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(limit) as any[];
  }

  return rows.map(r => ({
    id: r.id,
    created_at: r.created_at,
    subject: r.subject,
    predicate: r.predicate,
    object: r.object,
    confidence: r.confidence,
    source_item_id: r.source_item_id,
    entity_id: r.entity_id,
  }));
}

/**
 * List distinct subjects in the facts table.
 */
export function listSubjects(db: Database.Database): string[] {
  const rows = db
    .prepare(`SELECT DISTINCT subject FROM facts ORDER BY subject`)
    .all() as { subject: string }[];
  return rows.map(r => r.subject);
}

/**
 * List distinct predicates in the facts table.
 */
export function listPredicates(db: Database.Database): string[] {
  const rows = db
    .prepare(`SELECT DISTINCT predicate FROM facts ORDER BY predicate`)
    .all() as { predicate: string }[];
  return rows.map(r => r.predicate);
}

/**
 * Delete a fact by ID.
 */
export function deleteFact(db: Database.Database, id: string): boolean {
  const stmt = db.prepare('DELETE FROM facts WHERE id = ?');
  const result = stmt.run(id);
  return (result.changes ?? 0) > 0;
}

/**
 * Delete all facts derived from a specific memory item.
 */
export function deleteFactsBySourceItem(db: Database.Database, sourceItemId: string): number {
  const stmt = db.prepare('DELETE FROM facts WHERE source_item_id = ?');
  const result = stmt.run(sourceItemId);
  return result.changes ?? 0;
}

/**
 * Simple pattern-based fact extraction.
 * Looks for common patterns like "X works at Y", "X prefers Y", etc.
 * Returns an array of potential facts (not inserted yet).
 */
export function extractFactsSimple(text: string, entityId?: string): Array<{
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
}> {
  const facts: Array<{ subject: string; predicate: string; object: string; confidence: number }> = [];
  const lower = text.toLowerCase();

  // Pattern: "X works at Y" / "X travaille chez Y"
  const workPatterns = [
    /(\w+)\s+(?:works at|travaille chez|works for|work at)\s+([\w\s]+?)(?:\.|,|$)/gi,
  ];
  for (const pattern of workPatterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      facts.push({
        subject: match[1].trim(),
        predicate: 'works_at',
        object: match[2].trim(),
        confidence: 0.7,
      });
    }
  }

  // Pattern: "X prefers Y" / "X préfère Y"
  const preferPatterns = [
    /(\w+)\s+(?:prefers?|préfère)\s+([\w\s]+?)(?:\.|,|$)/gi,
  ];
  for (const pattern of preferPatterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      facts.push({
        subject: match[1].trim(),
        predicate: 'prefers',
        object: match[2].trim(),
        confidence: 0.8,
      });
    }
  }

  // Pattern: "X is Y" / "X est Y"
  const isPatterns = [
    /(\w+)\s+(?:is|est)\s+(?:a |an |un |une )?([\w\s]+?)(?:\.|,|$)/gi,
  ];
  for (const pattern of isPatterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const subject = match[1].trim();
      // Skip common false positives
      if (['it', 'this', 'that', 'ce', 'il', 'elle', 'cette'].includes(subject.toLowerCase())) continue;
      facts.push({
        subject,
        predicate: 'is',
        object: match[2].trim(),
        confidence: 0.6,
      });
    }
  }

  // Dedupe by subject+predicate+object
  const seen = new Set<string>();
  return facts.filter(f => {
    const key = `${f.subject}|${f.predicate}|${f.object}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ============================================================================
// Phase 3: Knowledge Graph
// ============================================================================

export type GraphEdge = {
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
};

export type GraphPath = {
  from: string;
  to: string;
  path: Array<{ entity: string; edge?: GraphEdge }>;
  length: number;
};

export type GraphStats = {
  totalFacts: number;
  totalEntities: number;
  totalPredicates: number;
  avgConnectionsPerEntity: number;
  mostConnectedEntities: Array<{ entity: string; connections: number }>;
  mostUsedPredicates: Array<{ predicate: string; count: number }>;
};

/**
 * Get all facts where the entity is either subject or object.
 */
export function getEntityGraph(db: Database.Database, entity: string): GraphEdge[] {
  const rows = db
    .prepare(
      `SELECT subject, predicate, object, confidence
       FROM facts
       WHERE subject = ? OR object = ?
       ORDER BY confidence DESC`
    )
    .all(entity, entity) as any[];

  return rows.map(r => ({
    subject: r.subject,
    predicate: r.predicate,
    object: r.object,
    confidence: r.confidence,
  }));
}

/**
 * Get all entities directly connected to a given entity.
 */
export function getRelatedEntities(db: Database.Database, entity: string): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT CASE 
         WHEN subject = ? THEN object 
         ELSE subject 
       END AS related
       FROM facts
       WHERE subject = ? OR object = ?`
    )
    .all(entity, entity, entity) as { related: string }[];

  return rows.map(r => r.related).filter(e => e !== entity);
}

/**
 * Find paths between two entities using BFS (breadth-first search).
 * Returns up to `maxPaths` paths with a maximum depth of `maxDepth`.
 */
export function findPaths(
  db: Database.Database,
  fromEntity: string,
  toEntity: string,
  maxDepth = 4,
  maxPaths = 5
): GraphPath[] {
  // Get all edges for efficient graph traversal
  const allEdges = db
    .prepare(`SELECT subject, predicate, object, confidence FROM facts`)
    .all() as any[];

  // Build adjacency list (undirected - we can traverse both ways)
  const adjacency = new Map<string, Array<{ entity: string; edge: GraphEdge }>>();
  for (const e of allEdges) {
    const edge: GraphEdge = {
      subject: e.subject,
      predicate: e.predicate,
      object: e.object,
      confidence: e.confidence,
    };

    if (!adjacency.has(e.subject)) adjacency.set(e.subject, []);
    if (!adjacency.has(e.object)) adjacency.set(e.object, []);
    
    adjacency.get(e.subject)!.push({ entity: e.object, edge });
    adjacency.get(e.object)!.push({ entity: e.subject, edge });
  }

  // BFS to find paths
  const paths: GraphPath[] = [];
  const queue: Array<{ entity: string; path: Array<{ entity: string; edge?: GraphEdge }> }> = [
    { entity: fromEntity, path: [{ entity: fromEntity }] }
  ];
  const visited = new Set<string>();

  while (queue.length > 0 && paths.length < maxPaths) {
    const current = queue.shift()!;
    
    if (current.entity === toEntity && current.path.length > 1) {
      paths.push({
        from: fromEntity,
        to: toEntity,
        path: current.path,
        length: current.path.length - 1,
      });
      continue;
    }

    if (current.path.length > maxDepth) continue;

    const neighbors = adjacency.get(current.entity) || [];
    for (const neighbor of neighbors) {
      const pathKey = `${current.entity}|${neighbor.entity}`;
      if (visited.has(pathKey)) continue;
      visited.add(pathKey);

      queue.push({
        entity: neighbor.entity,
        path: [...current.path, { entity: neighbor.entity, edge: neighbor.edge }],
      });
    }
  }

  return paths.sort((a, b) => a.length - b.length);
}

/**
 * Get statistics about the knowledge graph.
 */
export function getGraphStats(db: Database.Database): GraphStats {
  // Total facts
  const totalFactsRow = db.prepare(`SELECT COUNT(*) as count FROM facts`).get() as { count: number };
  const totalFacts = totalFactsRow?.count ?? 0;

  // Total unique entities (subjects + objects)
  const entitiesRow = db
    .prepare(
      `SELECT COUNT(DISTINCT entity) as count FROM (
         SELECT subject as entity FROM facts
         UNION
         SELECT object as entity FROM facts
       )`
    )
    .get() as { count: number };
  const totalEntities = entitiesRow?.count ?? 0;

  // Total predicates
  const predicatesRow = db
    .prepare(`SELECT COUNT(DISTINCT predicate) as count FROM facts`)
    .get() as { count: number };
  const totalPredicates = predicatesRow?.count ?? 0;

  // Most connected entities
  const mostConnected = db
    .prepare(
      `SELECT entity, COUNT(*) as connections FROM (
         SELECT subject as entity FROM facts
         UNION ALL
         SELECT object as entity FROM facts
       ) GROUP BY entity ORDER BY connections DESC LIMIT 10`
    )
    .all() as { entity: string; connections: number }[];

  // Most used predicates
  const mostUsedPredicates = db
    .prepare(
      `SELECT predicate, COUNT(*) as count FROM facts GROUP BY predicate ORDER BY count DESC LIMIT 10`
    )
    .all() as { predicate: string; count: number }[];

  // Average connections per entity
  const avgConnections = totalEntities > 0 
    ? Math.round((totalFacts * 2 / totalEntities) * 10) / 10 
    : 0;

  return {
    totalFacts,
    totalEntities,
    totalPredicates,
    avgConnectionsPerEntity: avgConnections,
    mostConnectedEntities: mostConnected,
    mostUsedPredicates: mostUsedPredicates,
  };
}

/**
 * Export the graph as JSON (for visualization tools).
 */
export function exportGraphJson(
  db: Database.Database,
  options?: { 
    limit?: number; 
    minConfidence?: number;
    entity?: string; // Export only subgraph around this entity
  }
): { nodes: Array<{ id: string; label: string }>; edges: Array<{ from: string; to: string; label: string; confidence: number }> } {
  let facts: any[];
  
  if (options?.entity) {
    facts = db
      .prepare(
        `SELECT subject, predicate, object, confidence FROM facts
         WHERE subject = ? OR object = ?
         ORDER BY confidence DESC
         LIMIT ?`
      )
      .all(options.entity, options.entity, options?.limit ?? 1000) as any[];
  } else if (options?.minConfidence) {
    facts = db
      .prepare(
        `SELECT subject, predicate, object, confidence FROM facts
         WHERE confidence >= ?
         ORDER BY confidence DESC
         LIMIT ?`
      )
      .all(options.minConfidence, options?.limit ?? 1000) as any[];
  } else {
    facts = db
      .prepare(
        `SELECT subject, predicate, object, confidence FROM facts
         ORDER BY confidence DESC
         LIMIT ?`
      )
      .all(options?.limit ?? 1000) as any[];
  }

  // Build unique nodes
  const nodeSet = new Set<string>();
  for (const f of facts) {
    nodeSet.add(f.subject);
    nodeSet.add(f.object);
  }

  const nodes = Array.from(nodeSet).map(id => ({ id, label: id }));
  const edges = facts.map(f => ({
    from: f.subject,
    to: f.object,
    label: f.predicate,
    confidence: f.confidence,
  }));

  return { nodes, edges };
}

/**
 * Find all entities matching a pattern (LIKE search).
 */
export function searchEntities(db: Database.Database, pattern: string, limit = 50): string[] {
  const likePattern = `%${pattern}%`;
  const rows = db
    .prepare(
      `SELECT DISTINCT entity FROM (
         SELECT subject as entity FROM facts WHERE subject LIKE ?
         UNION
         SELECT object as entity FROM facts WHERE object LIKE ?
       ) LIMIT ?`
    )
    .all(likePattern, likePattern, limit) as { entity: string }[];

  return rows.map(r => r.entity);
}
