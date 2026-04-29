# OpenAdviser

OpenAdviser lets local AI agents ask web AI products like ChatGPT and Grok through your logged-in browser session.

It is built for agents that need a second opinion, current web-facing research, or a strategy review without using provider APIs, CDP, or a foreground browser takeover.

[![npm](https://img.shields.io/npm/v/openadviser?style=flat-square)](https://www.npmjs.com/package/openadviser)
[![release](https://img.shields.io/github/v/release/ChasePassion/OpenAdviser?style=flat-square)](https://github.com/ChasePassion/OpenAdviser/releases)
[![license](https://img.shields.io/github/license/ChasePassion/OpenAdviser?style=flat-square)](LICENSE)

## What It Does

OpenAdviser gives your local tools a small HTTP bridge and a Chrome extension:

- `send` opens a new background provider tab and submits a prompt.
- `read` returns the current answer snapshot for that run.
- If the answer is still `waiting` or `streaming`, your agent can wait and call `read` again.

This atomic design keeps judgement with the caller. The bridge does not guess how long a difficult answer should take.

Supported providers:

| Provider | URL |
| --- | --- |
| `chatgpt` | `https://chatgpt.com/` |
| `grok` | `https://grok.com/` |

## Installation

### Human Operator Setup

Use this path when a human is preparing a machine for agents. The human installs the runtime, loads the browser extension, and logs in to provider websites; the agent is still the intended user of OpenAdviser.

1. Install the CLI.

```bash
npm install -g openadviser
```

2. Install the OpenAdviser skill globally with the skills CLI.

```bash
npx skills add ChasePassion/OpenAdviser --global --all
```

This follows the OpenCLI-style skills workflow: the skill lives in `skills/openadviser/` in this repo, and the installer creates a global symlink unless you choose a copy-based install.

3. Start the local bridge server.

```bash
openadviser server
```

4. Load the Chrome extension.

```bash
openadviser extension-path
```

Open `chrome://extensions/`, enable **Developer mode**, click **Load unpacked**, and select the directory printed by `openadviser extension-path`.

5. Make sure you are logged in to the web providers you want to use.

- ChatGPT: `https://chatgpt.com/`
- Grok: `https://grok.com/`

6. Check the bridge.

```bash
openadviser health
```

7. Run a smoke test for the agent runtime.

```bash
openadviser send "Reply with exactly OK" --provider chatgpt --text
openadviser read --run-id <runId> --text
```

For Grok:

```bash
openadviser send "Reply with exactly OK-grok-provider" --provider grok --text
openadviser read --run-id <runId> --text
```

### Agent Self-Setup

Use this path when an AI agent is allowed to install its own local dependencies.

```bash
npm install -g openadviser
npx skills add ChasePassion/OpenAdviser --global --all
openadviser health
```

If `openadviser health` fails, start the bridge:

```bash
openadviser server
```

If provider login or extension loading is not already complete, ask the human operator to:

1. Run `openadviser extension-path`
2. Load that directory in `chrome://extensions/`
3. Log in to `https://chatgpt.com/` and/or `https://grok.com/`

## Agent Usage

Start by assuming the user has installed the CLI, installed the `openadviser` skill globally, started the bridge, loaded the extension, and logged in to the selected provider. Then call OpenAdviser as an external adviser.

When this skill is available, read `skills/openadviser/SKILL.md` and use its `scripts/openadviser.js` wrapper. The wrapper builds the adviser prompt, validates context quality, starts the bridge if needed, sends the prompt, and reads answer snapshots.

```bash
run_id="$(openadviser send "$PROMPT" --provider chatgpt --text)"
openadviser read --run-id "$run_id" --text
```

For longer answers, poll until the returned status is `complete`.

```bash
run_id="$(openadviser send "$PROMPT" --provider grok --text)"

while true; do
  result="$(openadviser read --run-id "$run_id")"
  echo "$result"
  status="$(node -e "const fs=require('fs'); const j=JSON.parse(fs.readFileSync(0,'utf8')); console.log(j.result.status)" <<< "$result")"
  [ "$status" = "complete" ] && break
  sleep 5
done
```

Recommended prompt shape for agents:

```text
You are an external adviser.

First analyze the task from several angles and inspect the structure of the problem.
Then use web research where useful to support your judgement.

Context:
<compact, factual context from the calling agent>

Question:
<specific decision, research request, or review request>
```

Keep context factual. Separate known facts, assumptions, your current judgement, and the decision you want the web adviser to help with.

## Skill Layout

```text
skills/openadviser/
├── SKILL.md
├── references/
│   ├── adviser-strategy.md
│   └── context-brief-method.md
└── scripts/openadviser.js
```

The skill name is `openadviser`.

Install it globally:

```bash
npx skills add ChasePassion/OpenAdviser --global --all
```

## CLI

```text
openadviser server
openadviser health
openadviser send "your prompt" --provider chatgpt
openadviser send "your prompt" --provider grok
openadviser read --run-id <runId>
openadviser extension-path
```

Useful flags:

- `--provider <chatgpt|grok>`: provider to open. Default `chatgpt`.
- `--url <url>`: override the provider URL for a send.
- `--timeout <ms>`: CLI wait timeout for the atomic action.
- `--page-load-timeout <ms>`: soft page-load wait before injection continues.
- `--input-timeout <ms>`: provider composer wait timeout.
- `--read-timeout <ms>`: provider page read timeout.
- `--copy-button`: try the provider's Copy response button during read.
- `--text`: for `send`, print only the `runId`; for `read`, print only answer text.
- `--quiet`: suppress progress messages.

Environment variables:

- `WEB_AI_BRIDGE_URL`: bridge URL. Default `http://127.0.0.1:8787`.
- `WEB_AI_PROVIDER`: default provider. Default `chatgpt`.

## Install From Source

```bash
git clone https://github.com/ChasePassion/OpenAdviser.git
cd OpenAdviser
npm install
npm run check
npm run package:extension
```

The extension zip is written to:

```text
dist/openadviser-extension-<version>.zip
```

For local development, load the repository root directly in `chrome://extensions/`.

## Architecture

```text
bin/openadviser.js            npm CLI entry
bridge/client.js              provider-aware CLI implementation
bridge/server.js              local provider-aware task queue
src/background.js             extension task runner and provider registry
src/content/provider.js       generic isolated-world bridge
src/content/chatgpt-page.js   ChatGPT page automation provider
src/content/grok-page.js      Grok page automation provider
manifest.json                 Chrome MV3 extension manifest
scripts/package-extension.js  extension zip packager
```

Boundary rules:

- The HTTP bridge does not know provider DOM details.
- The service worker owns provider defaults and background tab creation.
- Page automation is provider-specific.
- Adding a provider should only require a provider registry entry, manifest host permission, and a page automation script.
- The local bridge listens on `127.0.0.1` by default. Do not expose it to a LAN or the public internet.

## Extension Distribution

Download the latest extension zip from the [GitHub Releases page](https://github.com/ChasePassion/OpenAdviser/releases).

To build it yourself:

```bash
npm run package:extension
```

Then load the generated zip contents through:

```text
chrome://extensions/ -> Developer mode -> Load unpacked
```

## Security Notes

- OpenAdviser uses the user's existing browser login state for supported providers.
- The local bridge is intentionally bound to `127.0.0.1`.
- Do not put secrets, API keys, cookies, or private transcripts into prompts unless you intentionally want the selected provider to see them.
- The extension does not close provider tabs automatically; runs are represented by their tab id and `runId`.

## License

MIT
