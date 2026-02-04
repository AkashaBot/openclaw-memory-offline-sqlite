# OpenClaw Offline Memory (SQLite FTS + Ollama embeddings)

Offline-first memory search for OpenClaw on Windows.

MVP:
- SQLite single-file DB (WAL)
- FTS5 (BM25) lexical search
- Optional semantic rerank using local embeddings via Ollama (`/v1/embeddings`)
- Exposed via CLI (`openclaw-mem`) and an OpenClaw Skill/Tool (`remember` / `recall`)

Status: scaffold (WIP)
