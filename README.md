# OpenAdviser

OpenAdviser is an open-source bridge that lets local AI agents consult web AI providers such as ChatGPT and Grok without CDP and without taking over the foreground browser tab.

This is a single repository project. The same `OpenAdviser` repo contains the npm CLI/server, Chrome extension source, extension packaging script, and release workflow.

It has two parts:

- A local Node.js bridge server and CLI, published as the `openadviser` npm package.
- A Chrome MV3 extension that opens provider tabs in the background, sends prompts, and reads answer snapshots.

Current providers:

- `chatgpt` -> `https://chatgpt.com/`
- `grok` -> `https://grok.com/`

## Why

OpenAdviser is designed for coding agents and local automation tools that need a second opinion, strategy review, or current web-facing research from a web AI product the user is already logged into.

The bridge deliberately keeps the workflow atomic:

1. `send` opens a new background provider tab, submits the prompt, and returns a `runId`.
2. `read` reads the current answer snapshot for that `runId`.
3. If the answer is still `waiting` or `streaming`, wait and call `read` again.

## Install From npm

```bash
npm install -g openadviser
```

Start the local bridge:

```bash
openadviser server
```

Check health:

```bash
openadviser health
```

Submit prompts:

```bash
openadviser send "Reply with exactly OK" --provider chatgpt
openadviser send "Reply with exactly OK" --provider grok
```

Read a result:

```bash
openadviser read --run-id <runId>
openadviser read --run-id <runId> --text
```

Find the installed extension directory:

```bash
openadviser extension-path
```

Load that directory in `chrome://extensions/` with **Developer mode -> Load unpacked**.

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

For local development, load the repository root directly in `chrome://extensions/`:

```text
OpenAdviser/
```

## Chrome Extension Distribution

There are two practical distribution channels:

### GitHub Release

Run:

```bash
npm run package:extension
```

Upload `dist/openadviser-extension-<version>.zip` to a GitHub Release.

Users can download the zip, unzip it, and load the extracted folder through:

```text
chrome://extensions/ -> Developer mode -> Load unpacked
```

This repository also includes a release workflow. Push a version tag to publish release assets:

```bash
git tag v0.2.0
git push origin v0.2.0
```

The workflow uploads:

- `dist/openadviser-extension-<version>.zip`
- `openadviser-<version>.tgz`

If the repository has an `NPM_TOKEN` secret, the same workflow also publishes the npm package.

### Chrome Web Store

Run:

```bash
npm run package:extension
```

Upload `dist/openadviser-extension-<version>.zip` in the Chrome Web Store Developer Dashboard.

Before submitting, prepare:

- Extension name: `OpenAdviser`
- Short description: `Let local AI agents consult ChatGPT, Grok, and other web AI providers from background tabs.`
- Detailed description: reuse the project summary from this README.
- Privacy disclosure: the extension talks only to `127.0.0.1:8787` / `localhost:8787` and supported provider sites. It does not ship a remote backend.
- Screenshots and icon assets if you want a polished public listing.

## Publish to npm

The npm package name is lowercase:

```text
openadviser
```

Product name and extension name are:

```text
OpenAdviser
```

Publish flow:

```bash
npm login
npm run check
npm run package:extension
npm pack --dry-run
npm publish --access public
```

After publishing:

```bash
npm install -g openadviser
openadviser health
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
- `--copy-button`: try the provider's copy button during read.
- `--text`: for `send`, print only the `runId`; for `read`, print only answer text.

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

## Development

```bash
npm run check
npm run package:extension
npm pack --dry-run
```

When extension source changes, reload it in `chrome://extensions/`.

## Security Notes

- OpenAdviser uses the user's existing browser login state for supported providers.
- The local bridge is intentionally bound to `127.0.0.1`.
- Do not put secrets, API keys, cookies, or private transcripts into prompts unless you intentionally want the selected provider to see them.
- The extension does not close provider tabs automatically; runs are represented by their tab id and `runId`.

## License

MIT
