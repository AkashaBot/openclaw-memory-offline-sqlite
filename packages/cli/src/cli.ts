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
  // Phase 2: Facts
  insertFact,
  getFactsBySubject,
  getFactsByPredicate,
  searchFacts,
  getAllFacts,
  listSubjects,
  listPredicates,
  deleteFact,
  extractFactsSimple,
  // Phase 3: Knowledge Graph
  getEntityGraph,
  getRelatedEntities,
  findPaths,
  getGraphStats,
  exportGraphJson,
  searchEntities,
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

// ============================================================================
// Phase 2: Fact commands
// ============================================================================

program
  .command('add-fact <subject> <predicate> <object>')
  .description('Add a structured fact (subject, predicate, object)')
  .option('--confidence <n>', 'Confidence level 0-1 (default 0.7)', '0.7')
  .option('--entity-id <entityId>', 'Who said/wrote this fact')
  .option('--source-item-id <itemId>', 'Source memory item ID')
  .action((subject: string, predicate: string, object: string, cmdOpts) => {
    withDb((dbPath) => {
      const db = openDb(dbPath);
      initSchema(db);
      const id = uuidv4();
      const confidence = Math.max(0, Math.min(1, Number(cmdOpts.confidence ?? 0.7)));
      const fact = insertFact(db, {
        id,
        subject,
        predicate,
        object,
        confidence,
        source_item_id: cmdOpts.sourceItemId ?? null,
        entity_id: cmdOpts.entityId ?? null,
      });
      console.log(JSON.stringify({ ok: true, fact }));
    });
  });

program
  .command('list-facts')
  .description('List all facts (optionally filtered by entity)')
  .option('--entity-id <entityId>', 'Filter by entity')
  .option('--limit <n>', 'Max results (default 50)', '50')
  .action((cmdOpts) => {
    withDb((dbPath) => {
      const db = openDb(dbPath);
      initSchema(db);
      const limit = Math.max(1, Math.min(500, Number(cmdOpts.limit ?? 50)));
      const facts = getAllFacts(db, cmdOpts.entityId, limit);
      console.log(JSON.stringify({ ok: true, count: facts.length, facts }));
    });
  });

program
  .command('get-facts-by-subject <subject>')
  .description('Get all facts about a specific subject')
  .option('--limit <n>', 'Max results (default 50)', '50')
  .action((subject: string, cmdOpts) => {
    withDb((dbPath) => {
      const db = openDb(dbPath);
      initSchema(db);
      const limit = Math.max(1, Math.min(500, Number(cmdOpts.limit ?? 50)));
      const facts = getFactsBySubject(db, subject, limit);
      console.log(JSON.stringify({ ok: true, subject, count: facts.length, facts }));
    });
  });

program
  .command('search-facts <query>')
  .description('Search facts by subject, predicate, or object')
  .option('--limit <n>', 'Max results (default 50)', '50')
  .action((query: string, cmdOpts) => {
    withDb((dbPath) => {
      const db = openDb(dbPath);
      initSchema(db);
      const limit = Math.max(1, Math.min(500, Number(cmdOpts.limit ?? 50)));
      const facts = searchFacts(db, query, limit);
      console.log(JSON.stringify({ ok: true, query, count: facts.length, facts }));
    });
  });

program
  .command('list-subjects')
  .description('List all distinct subjects in the facts table')
  .action(() => {
    withDb((dbPath) => {
      const db = openDb(dbPath);
      initSchema(db);
      const subjects = listSubjects(db);
      console.log(JSON.stringify({ ok: true, subjects, count: subjects.length }));
    });
  });

program
  .command('list-predicates')
  .description('List all distinct predicates in the facts table')
  .action(() => {
    withDb((dbPath) => {
      const db = openDb(dbPath);
      initSchema(db);
      const predicates = listPredicates(db);
      console.log(JSON.stringify({ ok: true, predicates, count: predicates.length }));
    });
  });

program
  .command('delete-fact <factId>')
  .description('Delete a fact by ID')
  .action((factId: string) => {
    withDb((dbPath) => {
      const db = openDb(dbPath);
      initSchema(db);
      const deleted = deleteFact(db, factId);
      console.log(JSON.stringify({ ok: true, deleted, id: factId }));
    });
  });

program
  .command('extract-facts [text]')
  .description('Extract potential facts from text (pattern-based, does not store)')
  .action((text: string | undefined) => {
    const input = text ?? fs.readFileSync(0, 'utf-8');
    const facts = extractFactsSimple(input);
    console.log(JSON.stringify({ ok: true, count: facts.length, facts }));
  });

// ============================================================================
// Phase 3: Knowledge Graph commands
// ============================================================================

program
  .command('graph-stats')
  .description('Get statistics about the knowledge graph')
  .action(() => {
    withDb((dbPath) => {
      const db = openDb(dbPath);
      initSchema(db);
      const stats = getGraphStats(db);
      console.log(JSON.stringify({ ok: true, stats }, null, 2));
    });
  });

program
  .command('graph-entity <entity>')
  .description('Get all facts connected to an entity (as subject or object)')
  .action((entity: string) => {
    withDb((dbPath) => {
      const db = openDb(dbPath);
      initSchema(db);
      const edges = getEntityGraph(db, entity);
      console.log(JSON.stringify({ ok: true, entity, count: edges.length, edges }));
    });
  });

program
  .command('graph-related <entity>')
  .description('Get all entities directly connected to an entity')
  .action((entity: string) => {
    withDb((dbPath) => {
      const db = openDb(dbPath);
      initSchema(db);
      const related = getRelatedEntities(db, entity);
      console.log(JSON.stringify({ ok: true, entity, count: related.length, related }));
    });
  });

program
  .command('graph-path <fromEntity> <toEntity>')
  .description('Find paths between two entities in the knowledge graph')
  .option('--max-depth <n>', 'Maximum path depth (default 4)', '4')
  .option('--max-paths <n>', 'Maximum number of paths to return (default 5)', '5')
  .action((fromEntity: string, toEntity: string, cmdOpts) => {
    withDb((dbPath) => {
      const db = openDb(dbPath);
      initSchema(db);
      const maxDepth = Math.max(1, Math.min(10, Number(cmdOpts.maxDepth ?? 4)));
      const maxPaths = Math.max(1, Math.min(20, Number(cmdOpts.maxPaths ?? 5)));
      const paths = findPaths(db, fromEntity, toEntity, maxDepth, maxPaths);
      console.log(JSON.stringify({ ok: true, from: fromEntity, to: toEntity, count: paths.length, paths }));
    });
  });

program
  .command('graph-export [outputFile]')
  .description('Export the knowledge graph as JSON (for visualization)')
  .option('--limit <n>', 'Max edges to export (default 1000)', '1000')
  .option('--min-confidence <n>', 'Minimum confidence threshold (default 0)', '0')
  .option('--entity <entity>', 'Export only subgraph around this entity')
  .action((outputFile: string | undefined, cmdOpts) => {
    withDb((dbPath) => {
      const db = openDb(dbPath);
      initSchema(db);
      const graph = exportGraphJson(db, {
        limit: Number(cmdOpts.limit ?? 1000),
        minConfidence: Number(cmdOpts.minConfidence ?? 0),
        entity: cmdOpts.entity,
      });

      const output = JSON.stringify({ ok: true, graph }, null, 2);
      if (outputFile) {
        fs.writeFileSync(outputFile, output);
        console.log(JSON.stringify({ ok: true, file: outputFile, nodes: graph.nodes.length, edges: graph.edges.length }));
      } else {
        console.log(output);
      }
    });
  });

program
  .command('search-entities <pattern>')
  .description('Search for entities matching a pattern')
  .option('--limit <n>', 'Max results (default 50)', '50')
  .action((pattern: string, cmdOpts) => {
    withDb((dbPath) => {
      const db = openDb(dbPath);
      initSchema(db);
      const limit = Math.max(1, Math.min(500, Number(cmdOpts.limit ?? 50)));
      const entities = searchEntities(db, pattern, limit);
      console.log(JSON.stringify({ ok: true, pattern, count: entities.length, entities }));
    });
  });

program.parse();
