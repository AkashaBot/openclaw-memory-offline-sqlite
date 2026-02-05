# OpenClaw Offline Memory (SQLite FTS + Ollama embeddings)

Offline-first memory store + search for OpenClaw.

Features:
- SQLite single-file DB (WAL)
- FTS5 lexical search (BM25)
- Optional semantic rerank using local embeddings via Ollama (`POST /v1/embeddings`)

Default embedding model: `bge-m3`.

## Install / build

This repo is a small TS monorepo (`packages/core`, `packages/cli`).

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

### Remember
```bash
openclaw-mem remember "Met Alice at the cafe, she likes espresso" \
  --db memory.sqlite \
  --title "Coffee chat" \
  --tags "people,alice"
```

### Search (lexical)
```bash
openclaw-mem search "espresso" --db memory.sqlite --limit 5
```

### Search (hybrid rerank)
Hybrid mode runs a normal FTS search to get candidates, then asks Ollama for embeddings and reranks those candidates by cosine similarity (with a small lexical tie-break).

If Ollama is unavailable (down, timeout, model missing), it **automatically falls back** to lexical-only results.

```bash
openclaw-mem search "what did Alice drink" --db memory.sqlite --hybrid --limit 5
```

### Ollama configuration
```bash
openclaw-mem search "..." --hybrid \
  --ollama-base-url http://127.0.0.1:11434 \
  --embedding-model bge-m3 \
  --ollama-timeout-ms 3000
```

See `docs/embeddings.md`.

## Status

Working MVP:
- `remember` inserts items into `items` + keeps FTS in sync via triggers.
- `search` supports `--hybrid` semantic reranking, storing Float32 vectors in the `embeddings` table.
