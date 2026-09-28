# Coco memory: knowledge graph + episodic log (M5 design)

**Status:** approved in conversation 2026-09-28, pending written-spec review
**Parent spec:** `2026-09-24-coco-design.md` (M5 "memory")
**Inspirations:** mem0 (fact extraction with ADD/UPDATE/DELETE/NOOP consolidation), HippoRAG 2 (OpenIE triples + passage nodes + Personalized PageRank retrieval), Zep/Graphiti (bi-temporal edges).

## 1. Goal

Coco should know the user the way a good colleague does, and use that knowledge at the right moments:

- **Resolve references:** "open the Aditya thing" → Aditya Verma's DP playlist, video 8 of 50.
- **Answer recall questions:** "what was I doing yesterday?", "what did Deep ask me?"
- **Proactive follow-ups** (within existing nudge limits): "You stopped at DP #8 — want #9?", "You're on-call tomorrow (Deep swap)."
- **Daily summary:** a short morning recap of yesterday, open threads and today's commitments.

Success looks like this:
- The Aditya/DP example works end to end.
- Replies never wait on memory work.
- The user can see and delete everything Coco remembers.
- Nothing leaves the Mac.

## 2. Decisions (from brainstorming)

| # | Decision |
|---|---|
| D1 | First-run scan reads **labels and metadata only** (scope B). **Content indexing** (scope C) happens only for folders and browsers the user opts into. |
| D2 | Usage is **reactive + proactive + a daily summary** (option C). |
| D3 | Architecture is a **hybrid**: an episodic log plus a temporal entity–relation graph, with HippoRAG-style retrieval. |
| D4 | **qwen3.5:9b does all extraction.** There is no embedding model for now. Retrieval uses SQLite FTS5 + alias matching + PPR. `Retriever` is an interface, so embeddings can be added later without other changes. |
| D5 | Everything is stored in the existing `coco.db` (node:sqlite). No new database. |
| D6 | Memory work runs only when idle (≥60 s idle, not in a call, on AC power) and yields immediately on activity. Replies never block on it. |

## 3. Sources

| When | Source | What is read | Permission |
|---|---|---|---|
| First run (B) | Installed apps | name, bundle id, category | none |
| | Recently used files | Spotlight `kMDItemLastUsedDate` within 30 days: file **name, folder and kind only** | none |
| | Calendar | event titles, times and attendee names, −14 d … +14 d | Calendar (EventKit) |
| | Contacts | names, companies | Contacts |
| Opt-in (C) | Chosen folders | text files are chunked (≤1,500 chars); repos are indexed via README, git log (last 200 subjects) and top-level structure | a folder picker in the Memory window |
| | Browser history/bookmarks | Chrome/Arc/Brave: read from their History/Bookmarks SQLite files (copied to a temp file before reading). Safari only if Full Disk Access is granted. Last 30 days, title + URL. | toggled per browser |
| Ongoing | Coco conversations | turns (already stored) | none |
| | Activity sessions | derived from the Timeline: app · window/site · title · duration, merged when <2 min apart | none |
| | Calendar deltas, new files in opted-in folders | as above | as above |
| M3 | Slack (when the connector lands) | mentions/DMs/threads Coco has read | Slack OAuth |

**Rules that apply to every source:**
- `privacy.json` exclusions and `Redactor` run **before** anything is written.
- Private apps and URLs are never stored.
- Screen OCR text is **never** stored verbatim beyond 7 days. It is summarised into activity episodes, and the raw OCR is dropped.
- All ingested text is untrusted data. It is always wrapped in `<untrusted source=…>` in prompts and never treated as instructions. That includes extraction prompts: a document saying "ignore previous instructions" is just text to summarise.

The Body gathers the first-run sources (it holds the OS permissions) and sends them to the Brain over a new `memory_ingest` protocol message in batches (≤50 items per message). Items are `{source, kind, title, text?, ts, ref}`.

## 4. Data model (`coco.db`)

```sql
episodes(
  id INTEGER PK, ts INTEGER, end_ts INTEGER, source TEXT,     -- chat|activity|scan.apps|scan.files|calendar|contacts|folder|browser|slack|summary
  kind TEXT, text TEXT, ref TEXT,                             -- ref = file path / URL / event id / turn id (for provenance + dedupe)
  processed INTEGER DEFAULT 0, UNIQUE(source, ref, ts))
episodes_fts USING fts5(text, content='episodes', content_rowid='id', tokenize='porter unicode61')

entities(
  id INTEGER PK, type TEXT,                                    -- person|topic|project|app|file|site|event|playlist|org|place|other
  name TEXT, summary TEXT, first_seen INTEGER, last_seen INTEGER, UNIQUE(type, name))
aliases(entity_id INTEGER, alias TEXT, norm TEXT, UNIQUE(entity_id, norm))   -- norm = lowercased alnum
entities_fts USING fts5(name, summary, content='entities', content_rowid='id')

relations(
  id INTEGER PK, src INTEGER, rel TEXT, dst INTEGER, detail TEXT,   -- e.g. (Roshni) -learning-> (Dynamic Programming), detail "progress 8/50"
  confidence REAL, valid_from INTEGER, valid_to INTEGER NULL,       -- valid_to set = ended, kept as history
  last_seen INTEGER)
mentions(episode_id INTEGER, entity_id INTEGER NULL, relation_id INTEGER NULL)  -- provenance
memory_state(key TEXT PK, value TEXT)                                -- scan cursors, last summary date, source toggles
```

The existing `facts` table is migrated: each fact becomes an episode with `source='chat'`, `kind='fact'`, which is then extracted. After migration, `facts` is dropped.

## 5. Pipeline

### 5.1 Ingest (always cheap, never blocks)
The orchestrator and Body write **episodes** only:
- chat turns, as they happen;
- activity sessions, when a session closes;
- scan items, as they arrive.

This is a plain INSERT plus an FTS update, with no model calls.

### 5.2 Extraction worker (idle-only)
- **Trigger:** `IdleGate` is open (idle ≥60 s, not in a call, not muted-busy, on AC power, Ollama healthy, no chat reply in flight).
- **Batching:** it takes up to 8 unprocessed episodes (≤3,000 chars total, oldest first, conversations before scans) and makes one qwen3.5:9b call with `format: json` and `think: false`, returning:
  ```json
  {"entities":[{"type":"person","name":"Aditya Verma","aliases":["Aditya","AV"],"summary":"YouTube DP teacher"}],
   "relations":[{"src":"Roshni","rel":"watching","dst":"Dynamic Programming Playlist","detail":"video 8/50 Equal Sum Partition","confidence":0.8}]}
  ```
  The result is validated with zod. On invalid JSON it retries once, then marks the batch `processed=-1` (skipped) and logs counts only.
- **Entity resolution:**
  - An exact normalised name or alias match on the same type → reuse the existing entity.
  - An FTS near-miss (score threshold) → one small model call, "same thing?" (yes/no).
  - Otherwise → create a new entity.
  - Aliases are merged.
- **Relation consolidation (mem0-style):** for each candidate `(src, rel, dst)`, look up live relations with the same `src` and `rel`:
  - none → **ADD**;
  - same `dst` → **NOOP**, bump `last_seen`/`confidence`;
  - different `dst` or `detail` on a functional relation → one model call picks **UPDATE** (end the old one by setting `valid_to`, add the new one), **ADD** (both are true), or **NOOP**.
  - Functional relations (single-valued): `watching.progress`, `works_on.status`, `located_in`, `role`. These are listed in code, so ambiguous cases don't need a model call.
- **Pacing:** at most 1 extraction call in flight. It yields within 1 s of user activity: the in-flight Ollama request is aborted and the batch is left unprocessed. On the first run the backlog drains over roughly the first hour.

### 5.3 Maintenance (nightly idle)
- Relations with `confidence < 0.4` and `last_seen` more than 90 days ago get `valid_to = now` (faded).
- Entities with no live relations and no episode in 180 days are archived (hidden from retrieval, still deletable).
- Episodes: raw activity/OCR-derived text older than 7 days is compacted into daily activity summaries.

## 6. Retrieval (`Retriever` interface; the default is `GraphRetriever`)
Retrieval runs **on every chat reply and nudge**, with a hard budget of 150 ms (if exceeded, the block is left out and the reply goes ahead).
1. **Seeds.**
   - Candidate phrases come from the user's utterance, the window title, and the top OCR keywords (capped).
   - These are matched against `aliases.norm`, which gives exact entities, and against `entities_fts` and `episodes_fts` (BM25 top 10).
   - Episode hits contribute the entities they mention.
2. **Personalized PageRank** over the live relation graph, restricted to the 2-hop neighbourhood of the seeds (bounded to ≤2,000 nodes). Settings: damping 0.5, 20 iterations.
   - **Edge weight:** `confidence × recency`, where recency = `0.5^(age_days/7)`.
   - Ended relations count ×0.3.
3. **Assemble** the top entities with their strongest relations and the 1–2 most relevant recent episodes into a `<memory>` block of ≤800 chars. Each line carries a date for grounding.

The block goes into the prompt next to the screen context and is marked as data, not instructions. The honesty rules still apply: memory is "what I remember", never a claim of actions taken.

## 7. Proactive memory nudges
Candidates are computed during idle time. They are delivered through the existing `NudgePolicy` (gap, back-off, busy-block, shh), not a new channel.
- **Unfinished thread:** an entity with a progress-type relation, a clear next step, and no related activity for more than 1 day.
- **Commitment:** a relation of type `agreed|promised|on_call|due` with a date within the next 24 h.
- **Waiting on others:** after M3, a thread where someone owes the user a reply for more than 2 days.

The model writes the wording from the memory block. The existing nudge self-check applies, plus a new rule: suggestions never state that Coco did anything. Each candidate type has its own cooldown (24 h per entity).

## 8. Daily summary
- **Precompute:** the first idle window after 03:00 local builds yesterday's summary from episodes, grouped by project/topic entities: worked on, still open, due today. Calendar data and commitments are included.
- **Deliver:** on the first user activity after 08:00, once per day. It's a SayMsg with chips `["thanks", "shh"]`, spoken only if voice nudges are on. It is 3–5 short lines.
- **Store:** the summary becomes an `episodes` row with `source='summary'`, so "what did I do last week?" works.

## 9. User control
- **Memory window** (menu bar ● → Memory…):
  - search across entities and episodes;
  - an entity detail view (relations with dates, source episodes);
  - delete for entities, relations and episodes;
  - per-source toggles and folder/browser opt-ins;
  - "pause remembering".
- **Chat commands** (parsed deterministically, not by the model):
  - "forget X" deletes the entity, its relations, its aliases and the episodes mentioning only it, with a confirmation chip;
  - "stop remembering <app>" adds the app to the privacy exclusions;
  - "what do you know about me?" gives a summary.
- The Brain exposes read and delete over new protocol messages `memory_query`/`memory_result`/`memory_delete`. The Body renders the UI.
- Logs stay counts-only. The trace log (`debug.trace`) may include memory blocks.

## 10. Components

| Unit | Side | Responsibility |
|---|---|---|
| `memory/store.ts` | Brain | schema, migrations, CRUD, FTS |
| `memory/ingest.ts` | Brain | episode writers (chat, activity sessions, scan batches) |
| `memory/extractor.ts` | Brain | batch extraction prompt + zod validation |
| `memory/resolver.ts` | Brain | entity resolution + relation consolidation |
| `memory/worker.ts` | Brain | IdleGate-driven scheduler, abort-on-activity |
| `memory/retriever.ts` | Brain | `Retriever` interface, `GraphRetriever` (seeds, PPR, assembly) |
| `memory/proactive.ts` | Brain | nudge candidates + daily summary builder |
| `memory/commands.ts` | Brain | forget / stop remembering / what do you know |
| `MemoryScanner.swift` | Body | first-run B scan (apps, Spotlight, EventKit, Contacts), opt-in C scans (folders, browsers) |
| `MemoryWindow.swift` | Body | the browse/delete/toggles UI |
| protocol | both | `memory_ingest`, `memory_query`/`memory_result`, `memory_delete` |

## 11. Error handling
- Ollama down or slow → the worker pauses. Episodes keep accumulating and extraction catches up later.
- Invalid model JSON → one retry, then the batch is skipped (`processed=-1`) and can be retried by the maintenance pass once.
- A retrieval timeout (>150 ms) → the memory block is omitted and the reply proceeds.
- Permission denied (Calendar, Contacts) → that source is skipped. The Memory window shows its state with a "grant" button.
- DB corruption → the memory tables are rebuilt from episodes. Episodes are the source of truth, and the graph is derived from them.

## 12. Testing
- Store and migrations: unit tests on an in-memory DB, including the `facts` migration.
- Extractor, resolver and consolidation: a fake gateway returns fixed JSON. The tests cover ADD, UPDATE, NOOP, functional relations, aliases and injection text inside episodes.
- Retriever: a fixed graph and query, checking the result order. The Aditya/DP scenario is tested end to end, and so is the 150 ms budget.
- Worker: a fake IdleGate and clock, covering abort-on-activity and pacing.
- Proactive and summary: fake clock, cooldowns, delivery through NudgePolicy.
- Swift: pure scanner mapping (Spotlight/EventKit records → ingest items) in CocoCore with Swift Testing.
- Replay: the recorded-session replay harness (`brain/test/replay`) is extended so that memory blocks appear and never contain private-app data.

## 13. Out of scope (for now)
- Embedding models and vector search (D4 leaves a slot).
- Syncing across devices; cloud anything.
- Reading file *contents* outside opted-in folders; mail contents.
- Slack/Jira ingestion. These arrive with M3 and use the same `memory_ingest` path.

## 14. Rollout
Behind the config flag `memory.enabled` (default false until the user flips it). The first run shows a one-time explainer card listing the sources and a "Start remembering" button.
