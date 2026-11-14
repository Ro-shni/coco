# Coco Studio + connectors (M3, reshaped)

**Status:** approved in conversation 2026-09-28, pending written-spec review
**Parent spec:** `2026-09-24-coco-design.md` §5.4 (agent loop, autonomy dial, untrusted content). This document supersedes the parent's M3 scope and implements §5.4's Tier 1.
**Related:** `2026-09-28-coco-memory-kg-design.md`. Its Memory window becomes a Studio tab.

## 1. Goal

One local control panel, **Coco Studio**, where the user manages everything about Coco without editing files:
- personality and voice;
- prompts;
- connectors (MCP servers), plug and play;
- per-tool permissions;
- memory;
- activity.

Together with it, the **Hands**: Coco can actually call connector tools from chat, under the autonomy dial.

Success looks like this:
- The user opens Studio from the menu bar.
- The MCP servers they already use with Claude Code (bifrost, devops-brain, kubectl-readonly, atlassian…) appear under "Found on this Mac" and import in one click — except `bifrost` and `devops-brain`, which resolve to the org's production hosts and show as "Blocked: production host" with Import disabled (R2; no override in this plan, the user decides separately).
- After that, "what's the status of DEVOPS-35236?" is answered through the Atlassian connector by the local model, with zero Claude tokens.

## 2. Decisions

| # | Decision |
|---|---|
| S1 | Studio is a **local web app served by the Brain** on `127.0.0.1` (same process, separate HTTP route from the Body WebSocket). The Body shows it in a native window hosting a `WKWebView`; "Open in browser" is also offered. |
| S2 | Front end: React 19 + TypeScript (strict) + Vite, pnpm, Vitest + Testing Library, Playwright for 2–3 smoke flows. Exact-pinned versions. There's no Meesho design system (this is a personal tool): plain CSS modules with tokens copied from the Coco look (cream / plum / lavender, light + dark). |
| S3 | MCP client uses `@modelcontextprotocol/sdk` (exact pin), with stdio and Streamable HTTP transports. OAuth 2.1 + PKCE with a loopback redirect on the Brain's server, on a **fixed** port (`connectors.oauthCallbackPort`, default 47823 — pre-registered apps like Slack list this exact `http://127.0.0.1:47823/oauth/callback` in their manifest, so it cannot be ephemeral like the main Studio/Body port). Secrets live in the **macOS Keychain**, written by the **Brain** via `/usr/bin/security` with the secret on stdin, never argv or disk (R1 — this drops the Swift bridge and protocol round trip the parent spec assumed; cost: Keychain prompts say "security" rather than "Coco"). |
| S4 | Tool narrowing for the local model uses **keyword/FTS scoring over tool names and descriptions** (no embedding model, per memory D4), keeping the top 6 tools per request. |
| S5 | Slack is a catalog entry marked "Needs Slack app". It works only after the user registers the internal app and pastes its Client ID (see `.superpowers/sdd/slack-mcp-spike.md`). |

## 3. Security model (non-negotiable)

- **Studio access:**
  - It binds to 127.0.0.1 only.
  - **No cookies, anywhere.** Every `/api/*` request carries the Studio session token as `Authorization: Bearer <token>`, read from `sessionStorage` (never persisted, never sent to any other 127.0.0.1 port). Opening Studio (menu bar or the chat window's "Studio" button) POSTs `/api/launch-nonce` with the permanent Studio token to mint a one-time nonce, then loads `/studio/launch?n=<nonce>`; that page's own inline script exchanges the nonce for a session token via `/studio/session` and redirects to `/studio/`. A launch link is single-use and short-lived; a session token never appears in a URL.
  - The `Host` header is checked on every route (`127.0.0.1:<port>` exactly); `Origin`, when present, must match too. This defeats DNS rebinding and CSRF without needing cookie flags at all.
- **Adding a stdio connector runs a program on the Mac.** The add/import dialog always shows the exact command, args, env var *names* (never values) and working directory, and requires an explicit "Run this server" confirmation. Catalog entries get no exemption.
- **Imported configs are read, never modified:** `~/.claude.json` and `.mcp.json` files are never written. Their env values are copied into Keychain only when the user confirms an import, and they are never logged or sent to the model.
- **Tool results are untrusted:** they are wrapped as `<untrusted source="mcp:<server>/<tool>">` in prompts.
- **Autonomy dial:** per tool, one of `auto | confirm | off`.
  - Defaults: tools with read-like names (`get*`, `list*`, `search*`, `read*`, `fetch*`, `describe*`, `query*`) are `auto`; everything else is `confirm`.
  - Some servers are imported already marked read-only (the user's `kubectl-readonly`, for instance). Their tools keep the read heuristic, and the server-level mode is shown.
  - Any tool call whose arguments were derived from untrusted text is forced to `confirm`, whatever the dial says.
- **Confirmation:** a `confirm` shows a chip near Coco reading "Run jira.createIssue? [Run] [Cancel]". It does **not** auto-proceed; this departs from the parent spec's "3 s then proceed", because model-chosen tool calls on a 9B local model warrant an explicit click.
- **Audit log:** every tool call gets a row with timestamp, server, tool, decision (auto/confirmed/denied), duration, ok/error and result size. Argument values are stored only when `debug.trace` is on.
- **Never prod hosts:** a connector whose URL matches the org's prod-host denylist (`int.meesho.int`, `prd.meesho.int`, `int.mrouter.int`, `prd.mrouter.int`) is refused, with an explanation. The denylist is configurable, but the default ships.

## 4. Studio tabs

1. **Home:** Brain/Ollama status, model names, connector health summary, quick toggles (voice, nudges, memory, trace).
2. **Personality:**
   - edit `persona.md` in a Markdown editor (CodeMirror 6);
   - sliders mapped to config: nudge gap, quip cap, chattiness (tick interval), speak nudges;
   - a voice picker (System/Siri + installed voices, with a "Test voice" button);
   - **live preview:** "How would Coco reply?" runs the real prompt builder on the current screen context and shows the model's reply, without sending it to the Body.
3. **Prompts:** the prompt fragments (chat system, nudge decider, draft rules, honesty rules, action rules) are editable. Each has version history (last 20, stored in `coco.db`), a diff view and "Reset to default". Invalid edits (missing required placeholders) are rejected with a message.
4. **Connectors:**
   - **Found on this Mac:** servers parsed from `~/.claude.json` `mcpServers`, plus `.mcp.json` files found in the folders listed in `connectors.scanDirs` (default `[]` — never hard-coded to any one user's paths) and each of those folders' immediate children (R4). Studio's Connectors tab has an "Add folder to scan" field that appends to `scanDirs`. Deduplicated by name + command/URL, with **Import** buttons. A server whose `command`/`args`/`url` contains a `${VAR}`-style placeholder (e.g. `${CLAUDE_PLUGIN_ROOT}`) is listed as "Unsupported: uses a plugin variable" instead — placeholders are never expanded (R5).
   - **Catalog:** a curated JSON shipped with Coco (Slack, Atlassian, GitHub, Google Drive, Grafana, filesystem, fetch). Each entry has a transport, auth kind (none / OAuth / API key / env), setup notes and default permissions. Clicking **Connect** runs the auth flow.
   - **Add custom:** by URL (Streamable HTTP) or by command (stdio).
   - **Per connector:** status light (connected / needs auth / error with message), reconnect, disable, remove, a tools list with a per-tool dial, and "Test a tool" (runs a read tool with user-entered args and shows the raw result).
5. **Memory:** the UI from the memory spec §9 (search, entity detail, delete, source toggles, folder/browser opt-ins). Until memory is built, it shows the current `facts` list.
6. **Activity:** the audit log table (filter by connector and decision) and a trace viewer that reads `trace.jsonl` when tracing is on.

## 5. Architecture

```
Body (Swift)                               Brain (Node)
─────────────                              ─────────────────────────────────────────────
StudioWindow (WKWebView) ──http (loopback)─▶ studio/http.ts   GET /studio/* (static SPA from dist/studio-web)
  mints/consumes launch nonce                studio/api.ts   /api/* JSON (zod-validated)
                                            connectors/secrets.ts   (R1: Keychain via `/usr/bin/security`,
                                                                     secret on stdin — no Body round trip)
                                            connectors/registry.ts  (config + state)
                                            connectors/discovery.ts (~/.claude.json, .mcp.json under scanDirs)
                                            connectors/catalog.json
                                            connectors/client.ts    (@modelcontextprotocol/sdk, per server)
                                            connectors/oauth.ts     (PKCE, loopback /oauth/callback)
                                            agent/narrow.ts         (FTS tool narrowing, top 6)
                                            agent/loop.ts           (Tier 1: ≤3 tool calls/turn)
                                            agent/autonomy.ts       (dial + untrusted forcing)
                                            audit.ts                (coco.db audit table)
studio/web (React SPA, built to brain/dist/studio-web)
```

- **Config:** `connectors.yaml` in the user config dir (Application Support/Coco/config) holds the server list, transport, command/URL, env var *names* with Keychain refs, and enabled flags. `autonomy.yaml` holds the per-tool dial. The Studio API writes these files atomically (write to a temp file, then rename). The existing loader gains a hot-reload of those two files.
- **Keychain access (R1):** the Brain calls `/usr/bin/security` directly (`connectors/secrets.ts`), with the secret passed on stdin, never argv or disk — never via a Body round trip. Only keys prefixed `coco.connector.` are ever read or written. This drops the WS `secret_get`/`secret_put`/`secret_delete` protocol messages the parent spec assumed; cost if this is ever wrong: Keychain access prompts identify the requesting process as "security" rather than "Coco".
- **Tier 1 loop (R3):** runs as a **gather phase before** the existing `ChatResponder.reply` pipeline, not interleaved with it.
  - On a turn, the narrowed tools (top 6, FTS-scored) are offered to the model via Ollama `tools`; it may call up to 3 tools.
  - Each call passes through autonomy. A `confirm` suspends the turn until the chip is clicked (with a 2 min expiry); a suspended call's `serverId`/`tool` are re-resolved from its qualified name (never trusting a caller-supplied value) before it runs.
  - Tool results are collected into an untrusted context string and handed to the reply pipeline as-is — every existing honesty, draft and action check still runs over the final wording, unchanged. This costs one extra model call, only on turns that end up using tools.
  - If the model fails to use tools properly twice, the reply says so honestly. Claude Code hand-off is M4, not this milestone.
- **Connection lifecycle:** servers connect lazily on first use, or eagerly when marked "keep warm". Stdio children are killed on Brain exit. Failures show as a red status and the server's tools are removed from narrowing, so the model can't pretend to use them.

## 6. Error handling
- MCP connection failure → red status with the error text in Studio; tools are hidden; auto-retry with back-off (30 s → 10 min).
- OAuth expired → status "needs auth" plus a Reconnect button; tools are hidden.
- Tool error → the model gets a `{error}` result it can explain; the audit row is `error`.
- A Studio API validation failure → 400 with field errors, shown inline.
- Brain restart → Studio reconnects automatically (it polls `/api/health`).

## 7. Testing
- **Brain (Vitest):**
  - discovery parsing (fixtures of `~/.claude.json` / `.mcp.json`, including secrets that must not leak into API responses);
  - registry CRUD and atomic writes;
  - autonomy decisions, including forcing `confirm` for untrusted-derived arguments;
  - tool narrowing ranking;
  - the Tier 1 loop against a **real in-process MCP test server** and a scripted fake model;
  - the OAuth PKCE flow against a fake authorisation server;
  - Studio API auth (missing or bad token, bad Host/Origin → 401/403);
  - the prod-host denylist.
- **Web (Vitest + Testing Library):** each tab's main interactions, and the import confirmation dialog showing the command.
- **E2E (Playwright, against the brain with a fake model):**
  - import a discovered server, then test a tool;
  - edit the persona, then preview;
  - set a tool to confirm, then chat, then the chip appears.
- **Swift:** `StudioURL` (launch/session navigation policy, CocoCore, pure) and `StudioWindowController`'s nonce-fetch/no-token-in-URL behaviour as units. (R1: the Keychain bridge itself moved entirely into the Brain — see §5 — so there is no Swift-side Keychain policy to test here.)

## 8. Build order (plans)
1. **Studio shell + Connectors + Hands:** HTTP/SPA/auth, discovery/import, registry, MCP client, autonomy, Tier 1 loop, audit, Home/Connectors/Activity tabs.
2. **Personality + Prompts tabs:** persona editor, sliders, voice picker, live preview, prompt fragments with history.
3. **Memory** (the memory spec), with its UI as the Studio Memory tab.
4. **Slack**, once the internal app is approved: catalog entry → OAuth with the user's Client ID. Socket Mode mention triggers are a follow-up.

## 9. Out of scope
- Claude Code delegation (M4).
- Remote access to Studio, multi-user, and sync.
- A public MCP marketplace fetch (the catalog is curated and shipped with Coco).
