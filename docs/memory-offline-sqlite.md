# OpenClaw Offline Memory (SQLite + Hybrid Embeddings)

Offline-first long‑term memory for OpenClaw, powered by a local SQLite database (FTS5) with optional semantic reranking via embeddings.

This page regroupe:
- Présentation générale
- Installation (core + CLI + plugin OpenClaw)
- Configuration (Ollama / OpenAI)
- Notes de version

---

## 1. Présentation

**openclaw-memory-offline-sqlite** fournit:

- Une bibliothèque core: `@akashabot/openclaw-memory-offline-core`
  - Stockage SQLite (WAL)
  - FTS5 (BM25) pour la recherche lexicale
  - Recherche hybride: FTS + embeddings (cosine) avec fallback lexical si les embeddings sont indisponibles
- Un CLI: `@akashabot/openclaw-mem`
  - `init`, `remember`, `search`, etc.
- Un plugin OpenClaw dédié (repo: `openclaw-memory-offline-sqlite-plugin`)
  - Auto‑recall: injection de souvenirs pertinents dans le prompt (`<relevant-memories>`)
  - Auto‑capture: enregistrement des messages user/assistant avec déduplication et filtres anti‑bruit

Objectif: offrir une mémoire long terme **offline**, contrôlable, avec performance stable et aucun appel réseau pour la partie stockage/recherche FTS.

---

## 2. Installation

### 2.1. Core + CLI

Sur la machine qui héberge OpenClaw:

```bash
npm install @akashabot/openclaw-memory-offline-core
npm install -g @akashabot/openclaw-mem
```

### 2.2. Plugin OpenClaw

Le plugin vit dans un repo séparé:

- GitHub: https://github.com/AkashaBot/openclaw-memory-offline-sqlite-plugin

Clone ce repo sur la machine OpenClaw, par ex.:

```bash
cd C:\Users\algon\clawd\repos
git clone https://github.com/AkashaBot/openclaw-memory-offline-sqlite-plugin.git
```

Ensuite, ajoute le chemin du plugin à la config OpenClaw (voir section suivante).

---

## 3. Configuration OpenClaw

Exemple de bloc `plugins` (JSON) pour activer la mémoire offline avec **Ollama** :

```jsonc
{
  "plugins": {
    "load": {
      "paths": [
        "C:\\Users\\algon\\clawd\\repos\\openclaw-memory-offline-sqlite-plugin"
      ]
    },
    "slots": {
      "memory": "memory-offline-sqlite"
    },
    "entries": {
      "memory-offline-sqlite": {
        "enabled": true,
        "config": {
          "dbPath": "C:\\Users\\algon\\.openclaw\\memory\\offline.sqlite",
          "autoRecall": true,
          "autoCapture": true,
          "mode": "hybrid",
          "topK": 5,
          "candidates": 50,
          "semanticWeight": 0.7,

          // Provider par défaut: Ollama
          "provider": "ollama",
          "ollamaBaseUrl": "http://127.0.0.1:11434",
          "embeddingModel": "bge-m3",
          "ollamaTimeoutMs": 3000
        }
      }
    }
  }
}
```

### 3.1. Variante OpenAI

Pour utiliser les embeddings OpenAI à la place d'Ollama :

```jsonc
{
  "id": "memory-offline-sqlite",
  "config": {
    "dbPath": "C:\\Users\\algon\\.openclaw\\memory\\offline.sqlite",
    "autoRecall": true,
    "autoCapture": true,
    "mode": "hybrid",
    "topK": 5,
    "candidates": 50,
    "semanticWeight": 0.7,

    "provider": "openai",
    "openaiBaseUrl": "https://api.openai.com",
    "openaiApiKey": "sk-...",              // en pratique: via env/secret manager
    "openaiModel": "text-embedding-3-small"
  }
}
```

Si `provider` est omis, le core retombe sur `"ollama"` + `bge-m3` (comportement backward‑compatible).

---

## 4. CLI `openclaw-mem` (smoke tests)

Quelques commandes utiles:

```bash
# Initialiser une nouvelle base
openclaw-mem --db memory.sqlite init

# Ajouter un souvenir
openclaw-mem remember "Met Alice at the cafe, she likes espresso" \
  --db memory.sqlite \
  --title "Coffee chat" \
  --tags "people,alice"

# Recherche lexicale
openclaw-mem search "espresso" --db memory.sqlite --limit 5

# Recherche hybride (avec rerank embeddings)
openclaw-mem search "what did Alice drink" --db memory.sqlite --hybrid --limit 5
```

Pour les options embeddings (Ollama / OpenAI), voir aussi le README du repo.

---

## 5. Notes de version

### 0.1.0

- Core: `@akashabot/openclaw-memory-offline-core@0.1.0`
- CLI: `@akashabot/openclaw-mem@0.1.0`

Points clés:
- Stockage SQLite + FTS5 stable, triggers pour garder l'index en sync.
- Recherche hybride avec rerank embeddings et fallback lexical si embeddings indisponibles.
- Abstraction d'"embeddings provider" :
  - `provider: 'ollama' | 'openai'`
  - Ollama: `ollamaBaseUrl`, `embeddingModel`, `ollamaTimeoutMs`
  - OpenAI: `openaiBaseUrl`, `openaiApiKey`, `openaiModel`
- Plugin OpenClaw:
  - Tools: `memory_store`, `memory_recall`, `memory_forget`.
  - Hooks: `before_agent_start` (auto‑recall) et `agent_end` (auto‑capture + déduplication + filtres anti‑bruit).

---

## 6. Liens

- Core + CLI: https://github.com/AkashaBot/openclaw-memory-offline-sqlite
- Plugin OpenClaw: https://github.com/AkashaBot/openclaw-memory-offline-sqlite-plugin
- Packages npm:
  - https://www.npmjs.com/package/@akashabot/openclaw-memory-offline-core
  - https://www.npmjs.com/package/@akashabot/openclaw-mem
