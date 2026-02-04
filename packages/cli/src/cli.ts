#!/usr/bin/env node
import { Command } from 'commander';
import { openDb, initSchema } from '@akasha/openclaw-memory-offline-core';

const program = new Command();

program
  .name('openclaw-mem')
  .description('Offline memory (SQLite FTS + optional Ollama embeddings)')
  .option('--db <path>', 'SQLite db path', 'memory.sqlite');

program
  .command('init')
  .description('Initialize the SQLite database schema')
  .action(() => {
    const opts = program.opts<{ db: string }>();
    const db = openDb(opts.db);
    initSchema(db);
    console.log(JSON.stringify({ ok: true, db: opts.db }));
  });

program.parse();
