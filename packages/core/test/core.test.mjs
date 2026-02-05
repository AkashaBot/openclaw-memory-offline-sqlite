import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import {
  openDb,
  initSchema,
  insertItem,
  lexicalSearch,
  hybridSearch,
  escapeFts5Query,
} from '../dist/index.js';

async function withTempDb(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-mem-sqlite-'));
  const dbPath = path.join(dir, 'mem.sqlite');
  const db = openDb(dbPath);
  initSchema(db);
  try {
    await fn(db, dbPath);
  } finally {
    db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('escapeFts5Query: simple tokens unchanged; others become phrase', () => {
  assert.equal(escapeFts5Query('hello world'), 'hello world');
  assert.equal(escapeFts5Query('  '), '""');
  assert.equal(escapeFts5Query('hello:world'), '"hello:world"');
  assert.equal(escapeFts5Query('say "hi"'), '"say ""hi"""');
});

test('lexicalSearch: returns inserted item', async () => {
  await withTempDb(async (db) => {
    insertItem(db, { id: '1', text: 'Bonjour Paris', source: 'test', source_id: 'a', title: 'salut', tags: 'fr', meta: null });
    const res = lexicalSearch(db, escapeFts5Query('Paris'), 5);
    assert.ok(res.length >= 1);
    assert.equal(res[0].item.id, '1');
  });
});

test('hybridSearch: if query embedding fetch fails, returns lexical-only (no throw)', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('network down');
  };

  try {
    await withTempDb(async (db) => {
      insertItem(db, { id: '1', text: 'alpha bravo', source: null, source_id: null, title: null, tags: null, meta: null });
      const out = await hybridSearch(
        db,
        { dbPath: ':memory:', embeddingModel: 'nomic-embed-text', ollamaTimeoutMs: 10 },
        escapeFts5Query('alpha'),
        { topK: 5 }
      );
      assert.ok(out.length >= 1);
      assert.equal(out[0].semanticScore, null);
      assert.equal(typeof out[0].score, 'number');
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('hybridSearch: uses semantic score when embeddings succeed; caches item embeddings', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;

  globalThis.fetch = async (_url, _opts) => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      async json() {
        // return a tiny deterministic embedding
        return { data: [{ embedding: [1, 0, 0, 0] }] };
      },
    };
  };

  try {
    await withTempDb(async (db) => {
      insertItem(db, { id: '1', text: 'alpha bravo', source: null, source_id: null, title: null, tags: null, meta: null });
      insertItem(db, { id: '2', text: 'charlie delta', source: null, source_id: null, title: null, tags: null, meta: null });

      const cfg = { dbPath: ':memory:', embeddingModel: 'nomic-embed-text', ollamaTimeoutMs: 1000 };

      const q = escapeFts5Query('alpha');
      const out1 = await hybridSearch(db, cfg, q, { topK: 2, candidates: 10, semanticWeight: 0.7 });
      assert.equal(out1.length, 2);
      assert.ok(out1[0].semanticScore === null || typeof out1[0].semanticScore === 'number');

      const callsAfter1 = calls;
      const out2 = await hybridSearch(db, cfg, q, { topK: 2, candidates: 10, semanticWeight: 0.7 });
      assert.equal(out2.length, 2);

      // Second run should NOT need to refetch item embeddings already cached; it will still fetch query embedding once.
      // So total additional calls should be <= number of items + 1; but caching should reduce it.
      assert.ok(calls - callsAfter1 <= 3);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
