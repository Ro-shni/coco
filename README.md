# Coco

A desktop companion that lives near your cursor, watches what you're working on, and speaks up when it has something smart, specific and occasionally funny to say. Runs on a local model (Ollama, `qwen3.5:9b`). Milestone 1: presence, perception, nudges and text chat.

## Run

Prerequisites: macOS 14+, Command Line Tools (`xcode-select --install`), Node 26+, Ollama with `ollama pull qwen3.5:9b`.

    cd brain && npm install && cd ..
    ./scripts/dev.sh

On first launch Coco opens a permissions window: grant Screen Recording, Accessibility and Input Monitoring to **Coco**. Ad-hoc builds lose these grants on every rebuild; to keep them, create a self-signed "Code Signing" certificate named `Coco Dev` in Keychain Access (Certificate Assistant → Create a Certificate) and build with `COCO_SIGN_IDENTITY="Coco Dev" ./scripts/dev.sh`.

**Permissions not sticking?** With an ad-hoc build every rebuild is a new app to macOS. To use a persistent identity, follow the Keychain Access recipe above. If switching identities, reset stale grants first:
```sh
tccutil reset ScreenCapture com.roshni.coco
tccutil reset Accessibility com.roshni.coco
tccutil reset ListenEvent com.roshni.coco
```
Then rebuild and grant permissions again.

## Use

- Coco sits in the bottom-right corner. Click it to chat.
- When it speaks, click a chip, or `shh` to mute for 30 minutes. Type `shh for today` or `unmute` in chat.
- Hold Right ⌘ to talk to Coco.
- `⌃⌥P` pauses and resumes watching. The menu-bar `●` has the same controls.
- Config lives in `~/Library/Application Support/Coco/config` (seeded from this repo's `config/` on first launch, never overwritten after). Edit `persona.md` there to change its personality (hot-reloaded), `config.yaml` for timing and your name/Slack handles, `privacy.json` for apps and sites Coco never reads. To push edits you made in the repo's `config/` instead, run `./scripts/sync-config.sh` (this does overwrite).

## Develop

    cd brain && npm test            # unit + replay tests
    cd brain && npm run eval:persona  # live check against your local model
    cd body && ./scripts/test.sh    # Swift tests (works without Xcode)
    cd body && ./scripts/bundle.sh  # release build + signed .app

`test.sh` and `bundle.sh` build Swift into `~/Library/Caches/coco-swift-build` rather than `body/.build`: a `build.db` under a repo checked out inside `~/Downloads` can throw intermittent "disk I/O error"s. Override the location with `COCO_SWIFT_SCRATCH=/some/path`.

Logs: `~/Library/Logs/Coco/`. Data: `~/Library/Application Support/Coco/coco.db`.

### Debugging

Set `debug.trace: true` in `config.yaml` to have the brain append a decision trace — one JSON line per user
turn (utterance, which branch routed it, every model call, the extracted reply/action, the intent gate's
verdict, what was sent to the Body, and its result), plus one line per unsolicited-nudge attempt — to
`~/Library/Logs/Coco/trace.jsonl` (rotated to `trace.jsonl.1` at 5MB). It's **off by default, opt-in, and
local-only**: this file can contain the full text of what you said and what Coco said back (unlike the
normal `brain.log`, which stays counts-only). Turn it on only for debugging, and treat `trace.jsonl` the same
way you'd treat chat history.

## Coco Studio & connectors

Open Studio with the **Studio** button in Coco's chat window, or menu bar ● → **Open Coco Studio…** (⌘,). Studio is served by Coco's brain on `127.0.0.1` only. Each launch uses a one-time link; the page swaps it for a session kept in that window only (no cookies).

- **Connectors → Found on this Mac:** your `~/.claude.json` servers appear automatically; add a folder (e.g. your code folder) to scan its `.mcp.json` files. Import shows the exact command it will run; credentials go to your macOS Keychain. Production hosts (`*.prd.meesho.int`, `*.int.meesho.int`, `*.mrouter.int`) are blocked, so `bifrost` and `devops-brain` show as locked.
- **Catalog:** Atlassian (sign in via the browser), GitHub (token), Grafana, Files, Slack. Sign-in redirects always come back to `http://127.0.0.1:47823/oauth/callback` (change with `connectors.oauthCallbackPort`). Slack needs an internal Slack app approved by your admins that lists that redirect URL — paste its Client ID in Studio.
- **Permissions:** each tool is *Run freely*, *Ask me first* or *Off*. Read-style tools default to *Run freely*, anything that changes things to *Ask me first*; anything built from text on your screen always asks. Confirmations run only from the **Run it** button.
- **Activity:** every tool call Coco made or you tested, with its decision.

Coco only asks the local model to use tools when your message matches a connected tool, and answers cite the source ("per Jira").
