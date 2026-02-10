## Phase 1: Attribution and Session Grouping

### New Features

**Attribution fields:**
- `entity_id` - who said/wrote this memory (e.g., "loic", "system")
- `process_id` - which agent/process captured this (e.g., "akasha")

**Session grouping:**
- `session_id` - group memories by conversation/session

**New API functions:**
- `runMigrations(db)` - automatic DB schema upgrade
- `hybridSearchFiltered()` - search with filters
- `getMemoriesByEntity()`, `getMemoriesBySession()`, `getMemoriesByProcess()`
- `listEntities()`, `listSessions()`
- `filterResults()`

**CLI additions:**
- `--entity-id`, `--process-id`, `--session-id` options on `remember` and `search`
- New commands: `list-entities`, `list-sessions`, `get-by-entity`, `get-by-session`

### Migration
Existing databases are automatically upgraded via `runMigrations()`. Safe to call on every startup.

### Packages
- @akashabot/openclaw-memory-offline-core: 0.2.0
- @akashabot/openclaw-mem (CLI): 0.2.0
