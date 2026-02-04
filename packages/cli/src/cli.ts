#!/usr/bin/env node
import { Command } from 'commander';
import fs from 'node:fs';
import { v4 as uuidv4 } from 'uuid';
import { addItem, initSchema, openDb, searchItems } from '@akasha/openclaw-memory-offline-core';

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
    .description('Search items using SQLite FTS5 (bm25)')
    .argument('<query>', 'FTS query (will be minimally escaped)')
    .option('--limit <n>', 'Max results (default 10, max 200)', '10')
    .action((query: string, cmdOpts) => {
      withDb((dbPath) => {
        const db = openDb(dbPath);
        initSchema(db);

        const limit = Math.max(1, Math.min(200, Number(cmdOpts.limit ?? 10)));
        const out = searchItems(db, query, limit);
        console.log(JSON.stringify({ ok: true, ...out }));
      });
    });
}

registerSearchCommand('search');
// Back-compat with README/skill naming.
registerSearchCommand('recall');

program.parse();
