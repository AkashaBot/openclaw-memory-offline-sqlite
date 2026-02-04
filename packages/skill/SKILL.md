---
name: openclaw-memory-offline-sqlite
description: Local/offline memory recall for OpenClaw using SQLite FTS5 + optional Ollama embeddings via /v1/embeddings.
---

# OpenClaw offline memory (SQLite + Ollama embeddings)

This skill is a thin wrapper around the `openclaw-mem` CLI.

## Tools
- `remember(text, meta?)`: store a memory item
- `recall(query, topK?, filters?)`: search memories (hybrid lexical+semantic)

## Notes
- Designed to work on Windows.
- If Ollama is down, recall should fall back to lexical-only.
