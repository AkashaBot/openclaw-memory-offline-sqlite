#!/usr/bin/env node
import { Command } from 'commander';
import fs from 'node:fs';
import { v4 as uuidv4 } from 'uuid';
import { addItem, hybridSearch, initSchema, openDb, searchItems } from '@akasha/openclaw-memory-offline-core';

const program = new Command();

program
  .name('openclaw-mem')
  .description('Offline memory (SQLite FTS + optional Ollama embeddings)')
  .option('--db <path>', 'SQLite db path', 'memory.sqlite');

function withDb<T>(fn: (dbPath: string) => T): T {
  const opts = program.opts<{ db: string }>();
  return fn(opts.db);
}

program
  .command('init')
  .description('Initialize the SQLite database schema')
  .action(() => {
    withDb((dbPath) => {
      const db = openDb(dbPath);
      initSchema(db);
      console.log(JSON.stringify({ ok: true, db: dbPath }));
    });
  });

function registerAddCommand(name: string) {
  program
    .command(name)
    .description('Add an item (and update FTS index)')
    .argument('[text]', 'Text content. If omitted, reads from stdin.')
    .option('--id <id>', 'Item id (default: uuid)')
    .option('--title <title>', 'Title')
    .option('--tags <tags>', 'Tags (freeform, e.g. "a,b,c")')
    .option('--source <source>', 'Source (e.g. "whatsapp")')
    .option('--source-id <sourceId>', 'Source id / external id')
    .option('--meta <json>', 'JSON metadata (string)')
    .action((textArg: string | undefined, cmdOpts) => {
      withDb((dbPath) => {
        const db = openDb(dbPath);
        initSchema(db);

        const text = (textArg ?? fs.readFileSync(0, 'utf8')).trim();
        if (!text) {
          process.exitCode = 2;
          console.log(JSON.stringify({ ok: false, error: 'Missing text (arg or stdin)' }));
          return;
        }

        let meta: unknown = undefined;
        if (cmdOpts.meta) {
          try {
            meta = JSON.parse(String(cmdOpts.meta));
          } catch (e: any) {
            process.exitCode = 2;
            console.log(
              JSON.stringify({
                ok: false,
                error: 'Invalid JSON for --meta',
                details: String(e?.message ?? e),
              })
            );
            return;
          }
        }

        const id = String(cmdOpts.id ?? uuidv4());
        const item = addItem(db, {
          id,
          title: cmdOpts.title ? String(cmdOpts.title) : null,
          text,
          tags: cmdOpts.tags ? String(cmdOpts.tags) : null,
          source: cmdOpts.source ? String(cmdOpts.source) : null,
          source_id: cmdOpts.sourceId ? String(cmdOpts.sourceId) : null,
          meta,
        });

        console.log(JSON.stringify({ ok: true, item }));
      });
    });
}

registerAddCommand('add');
// Back-compat with README/skill naming.
registerAddCommand('remember');

function registerSearchCommand(name: string) {
  program
    .command(name)
    .description('Search items using SQLite FTS5 (bm25), optionally reranked with Ollama embeddings')
    .argument('<query>', 'FTS query (will be minimally escaped)')
    .option('--limit <n>', 'Max results (default 10, max 200)', '10')
    .option('--hybrid', 'Enable semantic rerank using Ollama embeddings', false)
    .option('--candidates <n>', 'How many lexical candidates to rerank in hybrid mode (default max(50,limit))')
    .option('--semantic-weight <w>', 'Hybrid weight for semantic score (0..1, default 0.7)', '0.7')
    .option('--ollama-base-url <url>', 'Ollama baseUrl (OpenAI-compatible). e.g. http://127.0.0.1:11434')
    .option('--embedding-model <id>', 'Embedding model id (default bge-m3)')
    .option('--ollama-timeout-ms <n>', 'Ollama timeout in ms (default 3000)')
    .action(async (query: string, cmdOpts) => {
      await withDb(async (dbPath) => {
        const db = openDb(dbPath);
        initSchema(db);

        const limit = Math.max(1, Math.min(200, Number(cmdOpts.limit ?? 10)));

        if (!cmdOpts.hybrid) {
          const out = searchItems(db, query, limit);
          console.log(JSON.stringify({ ok: true, mode: 'lexical', ...out }));
          return;
        }

        const candidates = cmdOpts.candidates ? Math.max(limit, Number(cmdOpts.candidates)) : undefined;
        const semanticWeight = Math.max(0, Math.min(1, Number(cmdOpts.semanticWeight ?? 0.7)));

        const results = await hybridSearch(
          db,
          {
            dbPath,
            ollamaBaseUrl: cmdOpts.ollamaBaseUrl,
            embeddingModel: cmdOpts.embeddingModel,
            ollamaTimeoutMs: cmdOpts.ollamaTimeoutMs ? Number(cmdOpts.ollamaTimeoutMs) : undefined,
          },
          // IMPORTANT: hybridSearch expects an already-escaped FTS query.
          // We can reuse searchItems() to get the escapedQuery.
          searchItems(db, query, 1).escapedQuery,
          { topK: limit, candidates, semanticWeight }
        );

        console.log(
          JSON.stringify({
            ok: true,
            mode: 'hybrid',
            query,
            results,
            embeddingModel: cmdOpts.embeddingModel ?? 'bge-m3',
            ollamaBaseUrl: cmdOpts.ollamaBaseUrl ?? 'http://127.0.0.1:11434',
          })
        );
      });
    });
}

registerSearchCommand('search');
// Back-compat with README/skill naming.
registerSearchCommand('recall');

program.parse();
