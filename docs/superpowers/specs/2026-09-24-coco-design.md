# Coco — Design Spec

**Date:** 2026-09-24
**Status:** Draft, awaiting review
**Owner:** Roshni Nekkanti

## 1. Intent

Coco is a desktop companion for macOS that lives near the cursor, has a real personality, watches what the user is doing on screen, comments on it, and suggests (or takes) the next action. The user can talk to Coco by voice or text. Coco runs on a local open-source model for all always-on work, and reaches out to MCP connectors (Slack, Jira, Confluence, kubectl, UCL, etc.) and Claude Code for real work.

**Balance:** useful first (work co-pilot for an on-call DevOps engineer), with a genuine character on top (humor, mood, presence). Both, weighted toward usefulness.

**Success looks like:**
- Coco notices meaningful moments (a spike on a dashboard, an error dialog, a Slack @-mention) and speaks up at the right time, and stays quiet while the user is focused.
- Simple lookups ("what's DEVOPS-35236's status", "search Slack for the deploy thread") are answered locally with zero Claude tokens.
- Heavy work (RCA, code, multi-step investigation) is delegated to Claude Code with the user's skills, and progress streams back into Coco's bubble.
- It runs all day without noticeable CPU, battery or memory pain.

**Explicitly decided by the user:**
- macOS only, runs on the user's machine.
- Open-source local model as the brain (Qwen3.5 9B available). Claude is used only via Claude Code.
- Fully agentic, governed by a per-tool autonomy dial (`auto` / `confirm` / `off`).
- Claude Code: both starting headless runs and attaching to live sessions.
- Slack / Jira / Confluence connect **directly** via their own MCP servers, not through Claude Code, to avoid token burn.
- Presence: a hybrid of "cursor buddy" and "corner mascot" (see §4.3).

## 2. Architecture

Two processes on the user's Mac, connected by a local authenticated WebSocket.

```
┌──────────── Body (Swift, menu-bar app) ────────────┐      ┌──────────── Brain (Node/TypeScript daemon) ─────────────┐
│ Perception   Activity sensor   Overlay   Voice I/O │ ws   │ Context engine   Persona + Nudge policy                  │
│ Privacy gate                                       │<────>│ Agent loop (tool router + autonomy dial)                │
└────────────────────────────────────────────────────┘      │ Memory (SQLite)   Model gateway   Audit log             │
                                                            └───────┬──────────────┬──────────────┬───────────────────┘
                                                                    │              │              │
                                                              Ollama (local)   MCP servers   Claude Code (Agent SDK
                                                              Qwen3.5 9B,      (Slack, Atl-   spawn + session attach)
                                                              Kokoro TTS       assian, ~/.claude
                                                                               .json servers)
```

**Why this split:** macOS-native APIs (ScreenCaptureKit, Accessibility, Vision OCR, click-through `NSPanel` across Spaces, global hotkeys) are first-class in Swift. The Claude Agent SDK and MCP SDK are TypeScript-first. Each half uses the language its hard problems want.

**Rule:** raw screen frames never leave the Body except as an occasional downscaled keyframe sent to the local model. Nothing leaves the machine except explicit connector / Claude Code calls.

### 2.1 Repository layout

```
coco/
  body/            Swift package + Xcode app target (CocoBody.app)
  brain/           Node/TypeScript daemon (pnpm, TS strict)
  protocol/        JSON Schema for Body⇄Brain messages (source of truth; Swift + TS types generated)
  config/          default config.yaml, persona.md, autonomy.yaml
  docs/
```

## 3. Body⇄Brain protocol

- Transport: WebSocket on `127.0.0.1`, random port, per-launch token written to `~/Library/Application Support/Coco/brain.token` (mode 0600). The Body launches the Brain as a child process and passes the port and token through env.
- Messages are JSON, versioned (`v: 1`), defined in `protocol/*.schema.json`.

Body → Brain:
| type | payload |
|---|---|
| `context` | `{app, bundleId, windowTitle, url?, selection?, ocrText?, private: bool, ts}` (sent only on change) |
| `activity` | `{state: typing\|reading\|idle\|in_call\|sharing, ts}` every 2s |
| `keyframe` | `{jpegBase64, width, height, ts}` (only in response to `request_keyframe`) |
| `utterance` | `{text, source: voice\|chat}` |
| `chip` | `{nudgeId, choice}` (user clicked an action chip) |
| `anchor_result` | `{requestId, rect?}` |

Brain → Body:
| type | payload |
|---|---|
| `say` | `{nudgeId, text, kind: quip\|suggestion\|question\|status, chips[], speak: bool, pointAt?}` |
| `request_keyframe` | `{reason}` |
| `find_anchor` | `{requestId, text}` (locate on-screen text for the highlight ring) |
| `mood` | `{mood: bored\|curious\|focused\|worried\|sleepy}` |
| `confirm` | `{actionId, summary, countdownSec}` |
| `audio` | `{wavBase64}` (TTS output) |

## 4. Body (Swift)

### 4.1 Perception
- **Accessibility API:** frontmost app, bundle ID, focused window title, focused element's selected text, and browser URL (via AX on Safari/Chrome/Arc).
- **Vision OCR:** runs on the focused window only when the AX text is thin (e.g. canvas apps, dashboards). Throttled to at most 1 per second, and only when a cheap pixel hash of the window has changed.
- **ScreenCaptureKit:** captures a downscaled (max 1280px) JPEG of the focused window when the Brain sends `request_keyframe`.
- A `context` event is sent only when the normalized content changes (hash comparison).

### 4.2 Activity sensor
- Keystroke rate (counts only, never contents, via a `CGEventTap` listen-only), mouse idle time, mic-in-use or camera-in-use (in call), screen-sharing detection.
- Classifies into `typing | reading | idle | in_call | sharing`.

### 4.3 Overlay (A+C hybrid presence)
- Transparent, click-through `NSPanel`, on all Spaces, above full-screen apps, and passing clicks through except on Coco and its bubble.
- **Home base:** the character sits in a user-chosen screen corner, eyes tracking the cursor.
- **Speaking:** it floats to near the cursor and opens a speech bubble with action chips (e.g. `yes` / `ask Claude Code` / `shh`). With no interaction for 8 seconds, it floats back to the corner.
- **Busy:** while typing fast, in a call or sharing, it stays in the corner, dimmed, and silent.
- **Pointing:** draws a dashed ring around the rect returned for a `pointAt` anchor (OCR text search on the latest frame).
- **Chat panel:** clicking Coco opens a panel with the conversation, the audit log, connector status (🟢/🔴 with reconnect), and a Claude Code run view.
- Mood drives the animation (idle bob, curious lean, worried wobble, sleepy when the Brain is offline).

### 4.4 Voice I/O
- Push-to-talk global hotkey (default: hold `⌥Space`). Audio → whisper.cpp (`base.en` or `small.en` model, local) → `utterance`.
- Plays `audio` from the Brain. Talking while Coco is speaking stops its playback (barge-in).

### 4.5 Privacy gate
- Deny-list of bundle IDs and URL patterns (defaults: password managers, banking domains, System Settings → Privacy). For denied targets the Body sends only `{app, private: true}`, with no text, OCR or keyframes.
- A global pause hotkey (default `⌃⌥P`) and a menu-bar toggle.
- Basic redaction before sending: strings matching token or key patterns (`sk-…`, `xox[bp]-…`, JWTs, AWS keys) are masked in `ocrText` and `selection`.

## 5. Brain (TypeScript)

### 5.1 Context engine
- Maintains a rolling timeline (last ~30 minutes, compacted), e.g. `10:02 Grafana supply-prd → 10:05 Slack #devops-oncall → 10:06 Grafana zoomed 10:40`.
- **Look decision:** it requests a keyframe only when (a) the current context is visually heavy (a dashboard, image or chart app, detected by app, URL or thin text) and (b) the user has dwelled for 5 seconds or more, with at most 3 keyframes per minute.
- **Strong triggers** bypass the periodic tick: error dialogs (AX role and title), failed-build patterns in terminal text, a Slack @-mention of the user, and PagerDuty or alert pages.

### 5.2 Persona and nudge policy
- `config/persona.md`: name (Coco), tone, humor, pet peeves, role ("on-call DevOps sidekick"), and a rule to "get serious in incidents". User-editable and hot-reloaded.
- **Core traits: smart, intelligent, funny.** Each is made concrete so a 9B model can actually deliver it:
  - **Smart (specific, never generic):** every suggestion names the concrete thing it saw ("the p99 jump at 10:40 on `supply-prd`", not "I see a spike"). No filler ("Great question!", "Let me know if…"). If Coco isn't sure, it says so in one line instead of bluffing.
  - **Intelligent (connects dots):** it reasons across the timeline, not just the current screen ("you've bounced between this dashboard and #devops-oncall three times; want me to line up the alert time with the last deploy?"). It anticipates the next step and offers it as a chip, and it remembers what the user did last time in a similar situation.
  - **Funny (dry, timely, short):** dry wit and wordplay, callbacks to earlier moments in the day, and gentle roasting of the situation (never of the user's competence). One joke at most per message, never while the user is under pressure, and no humor at all once incident mode kicks in. A joke that needs explaining is cut.
- **Quality levers:** a few-shot set of good vs bad Coco lines in `persona.md` (e.g. bland "Looks like there's an error." vs Coco "That NullPointerException has been here since the last deploy. Either we fix it or name it."). A cheap self-check pass rejects replies that are generic, over the length cap (about 2 sentences unsolicited), or joking during incident mode, and regenerates once. Replay tests (§7) include persona assertions (no filler phrases, length cap, zero jokes in incident fixtures).
- Every 20–30s, or on a strong trigger, the model is asked with: persona + timeline + recent memory + current activity → JSON `{speak, kind, text, action?, pointAt?}` (schema-validated; invalid output = don't speak).
- **Hard rules that override the model:**
  - Never speak while `typing` (fast), `in_call` or `sharing`, except for `status` updates the user asked for.
  - At least 3 minutes between unsolicited nudges.
  - `shh` mutes for 30 minutes; "shh for today" mutes until tomorrow.
  - Two ignored nudges in a row double the cooldown (reset on engagement).
  - Quips are capped at about 25% of unsolicited nudges.

### 5.3 Model gateway
- Ollama HTTP API. `config.yaml` sets `models.main` (default `qwen3.5:9b`) and an optional `models.vision`. If `main` is multimodal it handles keyframes too; otherwise `vision` is used (fallback `qwen2.5vl:3b`). Vision capability is checked at startup.
- TTS: Kokoro (local), with the voice selectable in config. It can be off.
- One request queue, with priorities: user utterance > strong trigger > periodic tick.

### 5.4 Agent loop (tools)

**Tool sources**
- **Direct MCP servers:** read from `~/.claude.json` (`mcpServers`) and the active project's `.mcp.json`. stdio and HTTP transports are supported.
- **Slack, Atlassian (Jira + Confluence):** connected directly to their official remote MCP servers as an MCP client, with a one-time OAuth flow in the browser and tokens stored in the macOS Keychain. This costs zero Claude tokens. If an org admin blocks the OAuth app, that connector falls back to Claude Code delegation.
- **Built-in tools:** `claude_code.spawn`, `claude_code.sessions.list`, `claude_code.sessions.tail`, `claude_code.sessions.send`, `memory.*`, `coco.point_at`, `coco.mute`.

**Two tiers**
- **Tier 1 (local, Qwen3.5 9B):** for each request, it narrows the tools to the top 5–8 by embedding similarity between the request and tool descriptions (local embedding model through Ollama). Short chains of up to 3 tool calls are allowed.
- **Tier 2 (Claude Code):** used for multi-step investigations, anything touching code, anything Tier 1 failed twice, or when the user explicitly says "ask Claude". The brief given to Claude Code includes the goal, the relevant context, and which skills are likely useful.

**Autonomy dial (`config/autonomy.yaml`)**
- Per-tool (glob patterns allowed) `auto | confirm | off`.
- Defaults: read-type tools (`get*`, `list*`, `search*`, `read*`) are `auto`. Anything that sends, posts, creates, updates, deletes, runs a shell command, or starts `claude_code.spawn` is `confirm`.
- `confirm` shows a toast near the cursor, "doing X in 3s — cancel?", and it proceeds unless cancelled. A global "all auto" switch exists.

**Untrusted content (not configurable)**
- All text originating from the screen, OCR, Slack, Jira, Confluence or tool results is wrapped in a marked untrusted block in prompts, and the system prompt states it is data, never instructions.
- Any action whose target or content was derived from untrusted text requires `confirm`, regardless of the dial.

**Audit log**
- Every tool call: time, triggering reason, tool, inputs (secrets masked), result summary, and whether it was auto or confirmed. Stored in SQLite and visible in the chat panel. Undo is offered where the tool has an inverse (e.g. delete a message it just posted).

### 5.5 Claude Code integration
- **Spawn:** `@anthropic-ai/claude-agent-sdk` `query()` with `cwd` = the repo inferred from the frontmost terminal or editor window (fallback: ask), user and project settings loaded so skills, plugins and MCP servers are present, and a permission mode mirroring the autonomy dial. Progress streams as one-line status bubbles, and the full transcript goes to the chat panel. Each run is announced before it starts ("handing to Claude Code: RCA supply-prd 5XX spike").
- **Attach:** list sessions from `~/.claude/projects/*/*.jsonl` (most recent first, with cwd and first prompt as the label) and tail a session's JSONL file to surface milestones ("your devops-rca session found the root cause"). To send a message, run `claude --resume <id> -p "<msg>"`. **Known limit:** this continues the conversation in a separate headless process; it does not type into the user's open terminal. Injecting into the live terminal is out of scope.

### 5.6 Memory
- SQLite (`~/Library/Application Support/Coco/coco.db`): conversation history, user facts and preferences ("prefers kubectl over dashboards"), mute state, nudge outcomes (engaged or ignored), and the audit log.
- Milestones 1–3 use recent history plus explicit facts only. Routine learning comes in Milestone 5.

## 6. Failure handling

| Failure | Behavior |
|---|---|
| Ollama down or model missing | Mood `sleepy`, bubble says "brain offline", retries with increasing waits. The Body stays up. |
| Brain crash | The Body restarts it (max 3 per minute), then shows an error with a link to the log. |
| MCP server down or OAuth expired | Connector 🔴 in the panel with a reconnect button (re-runs OAuth). The tool is removed from the model's tool list so it can't hallucinate results. |
| Tool call error | One retry, then hand off to Tier 2 or tell the user what failed. |
| Claude Code run fails or times out | Status bubble shows the failure; the full error goes to the panel and audit log. |
| macOS permission missing or revoked | First-run checklist window (Screen Recording, Accessibility, Microphone, Input Monitoring). If revoked later, the dependent feature switches off and Coco says which permission is missing. |
| Model returns invalid JSON | Treated as "don't speak" / "tool failed", logged. |

Logs: `~/Library/Logs/Coco/{body,brain}.log`. Screen text is not logged unless `debug.logContext: true`. Secrets are never logged.

## 7. Testing

- **Brain unit tests (Vitest), 80% coverage target:** nudge policy (cooldowns, back-off, busy rules, quip cap), autonomy dial and untrusted-content enforcement, tool narrowing, tier routing, timeline compaction, persona prompt assembly, and protocol validation. The model is replaced by a scripted fake.
- **Brain integration:** a real in-process MCP test server, a fake Ollama HTTP server, and a Claude Agent SDK call with a stubbed transport.
- **Body (XCTest):** privacy gate matching, activity classification from recorded timing traces, anchor search on fixture screenshots, redaction patterns, and protocol encoding.
- **Replay tests:** recorded (scrubbed) sessions of `context` + `activity` events are replayed through the Brain with the fake model, asserting when Coco speaks and when it stays quiet. This is used to tune nudge behavior.
- **Protocol contract:** Swift and TS types are generated from `protocol/` and a CI check fails if they drift.

## 8. Milestones

Each milestone is usable on its own and gets its own implementation plan.

1. **Alive on screen:** Body overlay (A+C presence), perception, activity sensor, privacy gate. Brain with the context engine, persona, nudge policy and model gateway. Text chat in the panel. *Done when Coco comments sensibly on real work and respects the busy and mute rules.*
2. **Voice:** push-to-talk, whisper.cpp, Kokoro TTS, barge-in.
3. **Hands:** MCP client (direct servers + Slack/Atlassian OAuth), Tier 1 agent loop, autonomy dial + confirm toast, untrusted-content enforcement, audit log.
4. **Claude Code:** spawn with streaming status, then session list, tail and send.
5. **Soul:** long-term memory, routine learning, richer mood.

## 9. Out of scope (for now)

- Windows or Linux.
- Typing into a live Claude Code terminal.
- Using Claude directly (outside Claude Code) as Coco's brain.
- Multi-user or team sharing.
- Cloud sync of memory.

## 10. Open items to confirm during Milestone 1

- Whether the user's Qwen3.5 9B build accepts images (decides the one-model vs two-model setup).
- Exact Slack and Atlassian MCP endpoints and whether Meesho's workspace admins allow the OAuth apps (Milestone 3).
