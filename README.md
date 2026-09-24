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
- `⌃⌥P` pauses and resumes watching. The menu-bar `●` has the same controls.
- Config lives in `~/Library/Application Support/Coco/config` (seeded from this repo's `config/` on first launch, never overwritten after). Edit `persona.md` there to change its personality (hot-reloaded), `config.yaml` for timing and your name/Slack handles, `privacy.json` for apps and sites Coco never reads. To push edits you made in the repo's `config/` instead, run `./scripts/sync-config.sh` (this does overwrite).

## Develop

    cd brain && npm test            # unit + replay tests
    cd brain && npm run eval:persona  # live check against your local model
    cd body && ./scripts/test.sh    # Swift tests (works without Xcode)
    cd body && ./scripts/bundle.sh  # release build + signed .app

`test.sh` and `bundle.sh` build Swift into `~/Library/Caches/coco-swift-build` rather than `body/.build`: a `build.db` under a repo checked out inside `~/Downloads` can throw intermittent "disk I/O error"s. Override the location with `COCO_SWIFT_SCRATCH=/some/path`.

Logs: `~/Library/Logs/Coco/`. Data: `~/Library/Application Support/Coco/coco.db`.
