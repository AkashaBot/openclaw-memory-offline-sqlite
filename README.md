# OpenClaw Offline Memory (SQLite FTS + Hybrid Embeddings)

Offline‑first, privacy‑preserving memory store for OpenClaw.

## ✅ What’s new (v0.5.0)
- **Knowledge Graph** (entities + relations) stored locally
- **Facts & attribution** (who/when) for reliable long‑term memory
- **Hybrid search** (FTS5 + embeddings re‑rank)
- **F16 quantization** for lighter embedding storage
- **MCP server support** (connect from Claude Desktop / Cursor / Windsurf)

> The core remains a **single SQLite file** with **zero external services** required.

## Features
- SQLite single‑file DB (WAL)
- FTS5 lexical search (BM25)
- Hybrid semantic re‑rank (dense + sparse embeddings)
- Local embeddings (Ollama) or OpenAI embeddings
- Knowledge Graph + facts extraction
- Automatic attribution (source + timestamp)

Default embedding model: `bge-m3` (Ollama).

---

## Install / build

This repo is a small TS monorepo (`packages/core`, `packages/cli`, `packages/skill`).

Build:
```bash
npm ci
npx tsc -b
```

## CLI

### Realistic test

PowerShell (Windows):
```powershell
cd C:\Users\algon\clawd\openclaw-memory-offline-sqlite
npx tsc -b
.\scripts\realistic-test.ps1 -OllamaBaseUrl http://192.168.1.168:11434 -EmbeddingModel bge-m3
```

### Init
```bash
# Either ordering works:
openclaw-mem --db memory.sqlite init
# openclaw-mem init --db memory.sqlite
```

### Remember (with attribution)
```bash
# Basic usage
openclaw-mem remember "Met Alice at the cafe, she likes espresso" \
  --db memory.sqlite \
  --title "Coffee chat" \
  --tags "people,alice"

# With attribution
openclaw-mem remember "Loïc prefers autonomous agent behavior" \
  --db memory.sqlite \
  --entity-id "loic" \
  --process-id "akasha" \
  --session-id "2026-02-10-main"
```

### Search (lexical)
```bash
openclaw-mem search "espresso" --db memory.sqlite --limit 5
```

### Search (hybrid re‑rank)
Hybrid mode runs a normal FTS search to get candidates, then asks the embeddings provider and re‑ranks by cosine similarity (with a lexical tie‑break).

If the embeddings provider is unavailable (down, timeout, model missing), it **automatically falls back** to lexical‑only results.

```bash
openclaw-mem search "what did Alice drink" --db memory.sqlite --hybrid --limit 5
```

### Search with filters
Filter memories by entity, process, or session:
```bash
# What did Loïc tell me?
openclaw-mem search "preferences" --db memory.sqlite --entity-id "loic"

# What happened in this session?
openclaw-mem search "" --db memory.sqlite --session-id "2026-02-10-main"
```

### Ollama configuration
```bash
openclaw-mem search "..." --hybrid \
  --ollama-base-url http://127.0.0.1:11434 \
  --embedding-model bge-m3 \
  --ollama-timeout-ms 3000
```

### OpenAI configuration
The core can also use OpenAI’s `/v1/embeddings` endpoint:

```bash
OPENAI_API_KEY=sk-... openclaw-mem search "..." --hybrid \
  --provider openai \
  --openai-base-url https://api.openai.com \
  --openai-model text-embedding-3-small
```

If `provider` is omitted, the core defaults to Ollama + `bge-m3` for backwards compatibility.

See `docs/embeddings.md`.

---

## API (packages/core)

### Basic usage
```typescript
import { openDb, initSchema, runMigrations, addItem, hybridSearch } from '@akashabot/openclaw-memory-offline-core';

const db = openDb('memory.sqlite');
initSchema(db);
runMigrations(db);  // Safe to call on every startup

// Add memory with attribution
addItem(db, {
  id: 'mem-001',
  text: 'Loïc prefers autonomous agent behavior',
  entity_id: 'loic',      // Who said this
  process_id: 'akasha',   // Which agent captured it
  session_id: '2026-02-10-main'  // Session grouping
});

// Search
const results = await hybridSearch(db, config, 'preferences', { topK: 5 });
```

### Filtered APIs
```typescript
import {
  getMemoriesByEntity,
  getMemoriesBySession,
  getMemoriesByProcess,
  hybridSearchFiltered,
  listEntities,
  listSessions
} from '@akashabot/openclaw-memory-offline-core';

// Get all memories from a specific entity
const loicsThoughts = getMemoriesByEntity(db, 'loic');

// Get all memories from a session
const sessionMemories = getMemoriesBySession(db, '2026-02-10-main');

// Search with filter
const filtered = await hybridSearchFiltered(db, config, 'preferences', {
  topK: 10,
  filter: { entity_id: 'loic' }
});

// List all entities
const entities = listEntities(db);  // ['loic', 'system', 'akasha', ...]
```

---

## Status

Stable:
- `remember` inserts items into `items` + keeps FTS in sync via triggers
- `search` supports `--hybrid` semantic re‑ranking
- Pluggable embeddings (Ollama / OpenAI)
- Knowledge Graph + facts + attribution (offline)
