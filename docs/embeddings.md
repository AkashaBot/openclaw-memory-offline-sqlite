# Embeddings (Ollama)

This project uses Ollama's OpenAI-compatible embeddings endpoint:
- `POST http://127.0.0.1:11434/v1/embeddings`

## Recommended models

### Default (balanced)
- `bge-m3`

### Baseline fallback
- `nomic-embed-text`

### High-quality (heavier)
- `qwen3-embedding`
  - Prefer `qwen3-embedding:0.6b` or `qwen3-embedding:4b`
  - Use `qwen3-embedding:8b` only if you can afford the VRAM/latency

## Important: embedding dimensions

Some models (notably qwen3-embedding) may support multiple output dimensions.
We store `dims` in the DB alongside each vector, and we assume one stable dimension per model.
If `dims` changes, we should treat it as a re-embed / migration event.

## Pulling models

Examples:
- `ollama pull bge-m3`
- `ollama pull nomic-embed-text`
- `ollama pull qwen3-embedding:0.6b`
