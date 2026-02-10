#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  openDb,
  initSchema,
  runMigrations,
  addItem,
  searchItems,
  hybridSearch,
  getMemoriesByEntity,
  getMemoriesBySession,
  listEntities,
  listSessions,
  insertFact,
  getFactsBySubject,
  searchFacts,
  getAllFacts,
  listSubjects,
  listPredicates,
  deleteFact,
  getEntityGraph,
  getRelatedEntities,
  findPaths,
  getGraphStats,
  exportGraphJson,
  type MemConfig,
} from '@akashabot/openclaw-memory-offline-core';
import { randomUUID } from 'crypto';

// Default DB path - can be overridden via environment variable
const DB_PATH = process.env.OPENCLAW_MEMORY_DB || 'memory.sqlite';

// Initialize database
const db = openDb(DB_PATH);
initSchema(db);
runMigrations(db);

// Default config for hybrid search (no embeddings - lexical only fallback)
const defaultConfig: MemConfig = {
  dbPath: DB_PATH,
};

// Create MCP server
const server = new McpServer({
  name: 'openclaw-memory',
  version: '0.1.0',
}, {
  capabilities: {
    tools: {},
  },
});

// ============================================================================
// Memory Tools
// ============================================================================

server.tool(
  'memory_store',
  'Store a memory item in the offline SQLite database',
  {
    text: z.string().describe('The text content to store'),
    title: z.string().optional().describe('Optional title for the memory'),
    tags: z.string().optional().describe('Comma-separated tags'),
    entity_id: z.string().optional().describe('Who said/wrote this (user, agent, system)'),
    session_id: z.string().optional().describe('Session/conversation ID'),
  },
  async (params) => {
    const id = randomUUID();
    addItem(db, {
      id,
      text: params.text,
      title: params.title ?? null,
      tags: params.tags ?? null,
      source: 'mcp',
      source_id: null,
      meta: null,
      entity_id: params.entity_id ?? null,
      process_id: 'mcp-server',
      session_id: params.session_id ?? null,
    });
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: true, id }) }],
    };
  }
);

server.tool(
  'memory_recall',
  'Search and recall memories from the SQLite database using FTS5 full-text search',
  {
    query: z.string().describe('The search query'),
    limit: z.number().optional().default(10).describe('Maximum number of results'),
    entity_id: z.string().optional().describe('Filter by entity'),
    session_id: z.string().optional().describe('Filter by session'),
  },
  async (params) => {
    const limit = params.limit ?? 10;
    // Use synchronous lexical search for simplicity
    const searchResult = searchItems(db, params.query, limit * 2);
    let items = searchResult.results.map(r => r.item);
    
    // Apply filters if specified
    if (params.entity_id) {
      items = items.filter((item: any) => item.entity_id === params.entity_id);
    }
    if (params.session_id) {
      items = items.filter((item: any) => item.session_id === params.session_id);
    }
    
    // Limit results after filtering
    items = items.slice(0, limit);
    
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: true, count: items.length, items }) }],
    };
  }
);

server.tool(
  'memory_list_entities',
  'List all distinct entity IDs in the memory database',
  {},
  async () => {
    const entities = listEntities(db);
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: true, entities, count: entities.length }) }],
    };
  }
);

server.tool(
  'memory_list_sessions',
  'List all distinct session IDs in the memory database',
  {},
  async () => {
    const sessions = listSessions(db);
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: true, sessions, count: sessions.length }) }],
    };
  }
);

server.tool(
  'memory_get_by_entity',
  'Get all memories from a specific entity',
  {
    entity_id: z.string().describe('The entity ID to filter by'),
    limit: z.number().optional().default(50).describe('Maximum results'),
  },
  async (params) => {
    const items = getMemoriesByEntity(db, params.entity_id, params.limit ?? 50);
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: true, entity_id: params.entity_id, count: items.length, items }) }],
    };
  }
);

server.tool(
  'memory_get_by_session',
  'Get all memories from a specific session/conversation',
  {
    session_id: z.string().describe('The session ID to filter by'),
    limit: z.number().optional().default(100).describe('Maximum results'),
  },
  async (params) => {
    const items = getMemoriesBySession(db, params.session_id, params.limit ?? 100);
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: true, session_id: params.session_id, count: items.length, items }) }],
    };
  }
);

// ============================================================================
// Fact Tools
// ============================================================================

server.tool(
  'fact_add',
  'Add a structured fact to the knowledge base',
  {
    subject: z.string().describe('The subject of the fact (e.g., "Loic")'),
    predicate: z.string().describe('The relationship (e.g., "works_at", "prefers")'),
    object: z.string().describe('The object/value (e.g., "Fasst")'),
    confidence: z.number().optional().default(0.7).describe('Confidence level 0-1'),
    entity_id: z.string().optional().describe('Who stated this fact'),
  },
  async (params) => {
    const id = randomUUID();
    const fact = insertFact(db, {
      id,
      subject: params.subject,
      predicate: params.predicate,
      object: params.object,
      confidence: params.confidence ?? 0.7,
      source_item_id: null,
      entity_id: params.entity_id ?? null,
    });
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: true, fact }) }],
    };
  }
);

server.tool(
  'fact_search',
  'Search facts by subject, predicate, or object',
  {
    query: z.string().describe('Search query'),
    limit: z.number().optional().default(50).describe('Maximum results'),
  },
  async (params) => {
    const facts = searchFacts(db, params.query, params.limit ?? 50);
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: true, count: facts.length, facts }) }],
    };
  }
);

server.tool(
  'fact_get_by_subject',
  'Get all facts about a specific subject',
  {
    subject: z.string().describe('The subject to search for'),
    limit: z.number().optional().default(50).describe('Maximum results'),
  },
  async (params) => {
    const facts = getFactsBySubject(db, params.subject, params.limit ?? 50);
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: true, subject: params.subject, count: facts.length, facts }) }],
    };
  }
);

server.tool(
  'fact_list',
  'List all facts in the database',
  {
    entity_id: z.string().optional().describe('Filter by entity'),
    limit: z.number().optional().default(50).describe('Maximum results'),
  },
  async (params) => {
    const facts = getAllFacts(db, params.entity_id, params.limit ?? 50);
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: true, count: facts.length, facts }) }],
    };
  }
);

server.tool(
  'fact_delete',
  'Delete a fact by ID',
  {
    id: z.string().describe('The fact ID to delete'),
  },
  async (params) => {
    const deleted = deleteFact(db, params.id);
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: true, deleted, id: params.id }) }],
    };
  }
);

server.tool(
  'fact_list_subjects',
  'List all distinct subjects in the facts table',
  {},
  async () => {
    const subjects = listSubjects(db);
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: true, subjects, count: subjects.length }) }],
    };
  }
);

server.tool(
  'fact_list_predicates',
  'List all distinct predicates in the facts table',
  {},
  async () => {
    const predicates = listPredicates(db);
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: true, predicates, count: predicates.length }) }],
    };
  }
);

// ============================================================================
// Knowledge Graph Tools
// ============================================================================

server.tool(
  'graph_stats',
  'Get statistics about the knowledge graph',
  {},
  async () => {
    const stats = getGraphStats(db);
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: true, stats }, null, 2) }],
    };
  }
);

server.tool(
  'graph_entity',
  'Get all facts connected to an entity (as subject or object)',
  {
    entity: z.string().describe('The entity to query'),
  },
  async (params) => {
    const edges = getEntityGraph(db, params.entity);
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: true, entity: params.entity, count: edges.length, edges }) }],
    };
  }
);

server.tool(
  'graph_related',
  'Get all entities directly connected to an entity',
  {
    entity: z.string().describe('The entity to query'),
  },
  async (params) => {
    const related = getRelatedEntities(db, params.entity);
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: true, entity: params.entity, count: related.length, related }) }],
    };
  }
);

server.tool(
  'graph_path',
  'Find paths between two entities in the knowledge graph',
  {
    from: z.string().describe('Starting entity'),
    to: z.string().describe('Target entity'),
    max_depth: z.number().optional().default(4).describe('Maximum path depth'),
    max_paths: z.number().optional().default(5).describe('Maximum number of paths'),
  },
  async (params) => {
    const paths = findPaths(db, params.from, params.to, params.max_depth ?? 4, params.max_paths ?? 5);
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: true, from: params.from, to: params.to, count: paths.length, paths }) }],
    };
  }
);

server.tool(
  'graph_export',
  'Export the knowledge graph as JSON for visualization',
  {
    entity: z.string().optional().describe('Export only subgraph around this entity'),
    min_confidence: z.number().optional().default(0).describe('Minimum confidence threshold'),
    limit: z.number().optional().default(1000).describe('Maximum edges to export'),
  },
  async (params) => {
    const graph = exportGraphJson(db, {
      entity: params.entity,
      minConfidence: params.min_confidence,
      limit: params.limit,
    });
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: true, nodes: graph.nodes.length, edges: graph.edges.length, graph }) }],
    };
  }
);

// ============================================================================
// Start Server
// ============================================================================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('OpenClaw Memory MCP Server running on stdio');
}

main().catch(console.error);
