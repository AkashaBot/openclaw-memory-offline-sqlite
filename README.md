# OpenClaw Offline Memory (SQLite FTS + Ollama embeddings)

Offline-first memory search for OpenClaw on Windows.

MVP:
- SQLite single-file DB (WAL)
- FTS5 (BM25) lexical search
- Optional semantic rerank using local embeddings via Ollama (`/v1/embeddings`)

Default embedding model: `bge-m3`.
Also supported/documented: `nomic-embed-text`, `qwen3-embedding` (recommended tags: `0.6b` or `4b`; `8b` if you have the VRAM).
- Exposed via CLI (`openclaw-mem`) and an OpenClaw Skill/Tool (`remember` / `recall`)

Status: scaffold (WIP)
