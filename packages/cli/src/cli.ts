#!/usr/bin/env node
import { Command } from 'commander';
import fs from 'node:fs';
import { v4 as uuidv4 } from 'uuid';
import * as core from '@akashabot/openclaw-memory-offline-core';

const {
  addItem,
  hybridSearch,
  hybridSearchFiltered,
  initSchema,
  openDb,
  runMigrations,
  searchItems,
  getMemoriesByEntity,
  getMemoriesBySession,
  getMemoriesByProcess,
  listEntities,
  listSessions,
} = core;

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
      runMigrations(db);
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
    // Phase 1: Attribution & Session
    .option('--entity-id <entityId>', 'Who said/wrote this (e.g. "loic", "system")')
    .option('--process-id <processId>', 'Which agent/process captured this (e.g. "akasha")')
    .option('--session-id <sessionId>', 'Session/conversation grouping')
    .action((textArg: string | undefined, cmdOpts) => {
      withDb((dbPath) => {
        const db = openDb(dbPath);
        initSchema(db);
        runMigrations(db);

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
          // Phase 1: Attribution & Session
          entity_id: cmdOpts.entityId ? String(cmdOpts.entityId) : null,
          process_id: cmdOpts.processId ? String(cmdOpts.processId) : null,
          session_id: cmdOpts.sessionId ? String(cmdOpts.sessionId) : null,
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
    // Phase 1: Filtering
    .option('--entity-id <entityId>', 'Filter by entity (who said/wrote)')
    .option('--process-id <processId>', 'Filter by process (which agent captured)')
    .option('--session-id <sessionId>', 'Filter by session/conversation')
    .action(async (query: string, cmdOpts) => {
      await withDb(async (dbPath) => {
        const db = openDb(dbPath);
        initSchema(db);
        runMigrations(db);

        const limit = Math.max(1, Math.min(200, Number(cmdOpts.limit ?? 10)));

        // Check if any filter is specified
        const hasFilter = cmdOpts.entityId || cmdOpts.processId || cmdOpts.sessionId;
        const filter = hasFilter ? {
          entity_id: cmdOpts.entityId || undefined,
          process_id: cmdOpts.processId || undefined,
          session_id: cmdOpts.sessionId || undefined,
        } : undefined;

        if (!cmdOpts.hybrid) {
          const out = searchItems(db, query, limit);
          console.log(JSON.stringify({ ok: true, mode: 'lexical', ...out }));
          return;
        }

        const candidates = cmdOpts.candidates ? Math.max(limit, Number(cmdOpts.candidates)) : undefined;
        const semanticWeight = Math.max(0, Math.min(1, Number(cmdOpts.semanticWeight ?? 0.7)));

        // Use filtered search if filter options are specified
        const results = await (hasFilter
          ? hybridSearchFiltered(
              db,
              {
                dbPath,
                ollamaBaseUrl: cmdOpts.ollamaBaseUrl,
                embeddingModel: cmdOpts.embeddingModel,
                ollamaTimeoutMs: cmdOpts.ollamaTimeoutMs ? Number(cmdOpts.ollamaTimeoutMs) : undefined,
              },
              searchItems(db, query, 1).escapedQuery,
              { topK: limit, candidates, semanticWeight, filter }
            )
          : hybridSearch(
              db,
              {
                dbPath,
                ollamaBaseUrl: cmdOpts.ollamaBaseUrl,
                embeddingModel: cmdOpts.embeddingModel,
                ollamaTimeoutMs: cmdOpts.ollamaTimeoutMs ? Number(cmdOpts.ollamaTimeoutMs) : undefined,
              },
              searchItems(db, query, 1).escapedQuery,
              { topK: limit, candidates, semanticWeight }
            ));

        console.log(
          JSON.stringify({
            ok: true,
            mode: hasFilter ? 'hybrid-filtered' : 'hybrid',
            query,
            filter: hasFilter ? filter : undefined,
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

// Phase 1: Utility commands for attribution & session
program
  .command('list-entities')
  .description('List all distinct entity_ids in the database')
  .action(() => {
    withDb((dbPath) => {
      const db = openDb(dbPath);
      initSchema(db);
      runMigrations(db);
      const entities = listEntities(db);
      console.log(JSON.stringify({ ok: true, entities, count: entities.length }));
    });
  });

program
  .command('list-sessions')
  .description('List all distinct session_ids in the database')
  .action(() => {
    withDb((dbPath) => {
      const db = openDb(dbPath);
      initSchema(db);
      runMigrations(db);
      const sessions = listSessions(db);
      console.log(JSON.stringify({ ok: true, sessions, count: sessions.length }));
    });
  });

program
  .command('get-by-entity <entityId>')
  .description('Get all memories from a specific entity')
  .option('--limit <n>', 'Max results (default 50)', '50')
  .action((entityId: string, cmdOpts) => {
    withDb((dbPath) => {
      const db = openDb(dbPath);
      initSchema(db);
      runMigrations(db);
      const limit = Math.max(1, Math.min(500, Number(cmdOpts.limit ?? 50)));
      const items = getMemoriesByEntity(db, entityId, limit);
      console.log(JSON.stringify({ ok: true, entityId, count: items.length, items }));
    });
  });

program
  .command('get-by-session <sessionId>')
  .description('Get all memories from a specific session/conversation')
  .option('--limit <n>', 'Max results (default 100)', '100')
  .action((sessionId: string, cmdOpts) => {
    withDb((dbPath) => {
      const db = openDb(dbPath);
      initSchema(db);
      runMigrations(db);
      const limit = Math.max(1, Math.min(500, Number(cmdOpts.limit ?? 100)));
      const items = getMemoriesBySession(db, sessionId, limit);
      console.log(JSON.stringify({ ok: true, sessionId, count: items.length, items }));
    });
  });

program.parse();
