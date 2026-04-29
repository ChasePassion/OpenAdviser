#!/usr/bin/env node
"use strict";

const path = require("node:path");
const { spawnSync } = require("node:child_process");

const rootDir = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const command = args[0];

if (!command || command === "help" || command === "--help" || command === "-h") {
  printHelp();
  process.exit(0);
}

if (command === "extension-path") {
  console.log(rootDir);
  process.exit(0);
}

const script = command === "server"
  ? path.join(rootDir, "bridge", "server.js")
  : path.join(rootDir, "bridge", "client.js");
const scriptArgs = command === "server" ? args.slice(1) : args;

const result = spawnSync(process.execPath, [script, ...scriptArgs], {
  cwd: rootDir,
  stdio: "inherit",
  windowsHide: true
});

if (typeof result.status === "number") {
  process.exit(result.status);
}

if (result.error) {
  console.error(result.error.message || result.error);
}
process.exit(1);

function printHelp() {
  console.log(`OpenAdviser

Usage:
  openadviser server
  openadviser health
  openadviser send "your prompt" --provider chatgpt
  openadviser send "your prompt" --provider grok
  openadviser read --run-id <runId>
  openadviser wait --run-id <runId>
  openadviser extension-path

Commands:
  server          Start the local bridge server.
  health          Check bridge health.
  send            Submit a prompt to a web AI provider.
  read            Read an answer snapshot for a runId.
  wait            Poll read until the run is complete or timeout is reached.
  extension-path  Print the extension directory to load in Chrome.
`);
}
