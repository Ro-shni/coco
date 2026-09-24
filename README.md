# Coco

A desktop companion that lives near your cursor, watches what you're working on, and speaks up when it has something smart, specific and occasionally funny to say. Runs on a local model (Ollama, `qwen3.5:9b`). Milestone 1: presence, perception, nudges and text chat.

## Run

Prerequisites: macOS 14+, Command Line Tools (`xcode-select --install`), Node 26+, Ollama with `ollama pull qwen3.5:9b`.

    cd brain && npm install && cd ..
    ./scripts/dev.sh

On first launch Coco opens a permissions window: grant Screen Recording, Accessibility and Input Monitoring to **Coco**. Ad-hoc builds lose these grants on every rebuild; to keep them, create a self-signed "Code Signing" certificate named `Coco Dev` in Keychain Access (Certificate Assistant → Create a Certificate) and build with `COCO_SIGN_IDENTITY="Coco Dev" ./scripts/dev.sh`.

## Use

- Coco sits in the bottom-right corner. Click it to chat.
- When it speaks, click a chip, or `shh` to mute for 30 minutes. Type `shh for today` or `unmute` in chat.
- `⌃⌥P` pauses and resumes watching. The menu-bar `●` has the same controls.
- Edit `config/persona.md` to change its personality (hot-reloaded), `config/config.yaml` for timing and your name/Slack handles, `config/privacy.json` for apps and sites Coco never reads.

## Develop

    cd brain && npm test            # unit + replay tests
    cd brain && npm run eval:persona  # live check against your local model
    cd body && ./scripts/test.sh    # Swift tests (works without Xcode)

Logs: `~/Library/Logs/Coco/`. Data: `~/Library/Application Support/Coco/coco.db`.
