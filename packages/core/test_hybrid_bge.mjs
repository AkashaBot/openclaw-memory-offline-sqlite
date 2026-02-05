import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

import { openDb, initSchema, insertItem, hybridSearch } from './dist/index.js';

async function withTempDb(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-mem-bge-test-'));
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

async function main() {
  console.log('Starting hybridSearch load test with bge-m3 embeddings via Ollama...');

  await withTempDb(async (db) => {
    // Insert a bunch of synthetic items
    const N = 200;
    console.log(`Inserting ${N} items...`);
    for (let i = 0; i < N; i++) {
      insertItem(db, {
        id: `item-${i}`,
        text: `Test memory item ${i} about OpenClaw, memory plugins, and embedding performance.`,
        source: 'test',
        source_id: null,
        title: `Item ${i}`,
        tags: 'test,openclaw,memory',
        meta: null,
      });
    }

    const cfg = {
      dbPath: ':memory:',
      ollamaBaseUrl: 'http://192.168.1.168:11434',
      embeddingModel: 'bge-m3',
      ollamaTimeoutMs: 10000,
    };

    const queries = [
      'memory plugin performance',
      'OpenClaw agent preferences',
      'embedding test for sqlite hybrid search',
      'latence sur bge-m3 et ollama',
    ];

    for (const q of queries) {
      console.log(`\nQuery: ${q}`);
      const t0 = performance.now();
      try {
        const res = await hybridSearch(db, cfg, q, { topK: 5, candidates: 50, semanticWeight: 0.7 });
        const t1 = performance.now();
        console.log(`  hybridSearch returned ${res.length} results in ${(t1 - t0).toFixed(0)} ms`);
        const semanticCount = res.filter(r => r.semanticScore !== null).length;
        console.log(`  results with semanticScore != null: ${semanticCount}`);
      } catch (err) {
        const t1 = performance.now();
        console.error(`  hybridSearch failed after ${(t1 - t0).toFixed(0)} ms:`, err?.message ?? err);
      }
    }

    console.log('\nRunning a second pass to test embedding cache reuse...');
    const t0 = performance.now();
    const res2 = await hybridSearch(db, cfg, 'memory plugin performance', { topK: 5, candidates: 50, semanticWeight: 0.7 });
    const t1 = performance.now();
    console.log(`  Second pass returned ${res2.length} results in ${(t1 - t0).toFixed(0)} ms`);
  });

  console.log('Hybrid bge-m3 test completed.');
}

main().catch((err) => {
  console.error('Test script failed:', err);
  process.exit(1);
});
