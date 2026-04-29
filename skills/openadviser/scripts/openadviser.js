#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const DEFAULT_OPENADVISER_BIN = process.env.OPENADVISER_BIN || "openadviser";
const DEFAULT_BRIDGE_URL = process.env.WEB_AI_BRIDGE_URL || process.env.CHATGPT_BRIDGE_URL || "http://127.0.0.1:8787";
const DEFAULT_PROVIDER = process.env.ADVISER_PROVIDER || process.env.WEB_AI_PROVIDER || "chatgpt";
const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_WAIT_TIMEOUT_MS = 600000;
const DEFAULT_PAGE_LOAD_TIMEOUT_MS = 15000;

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});

async function main() {
  const [command = "help", ...rest] = process.argv.slice(2);
  const flags = parseArgs(rest);

  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (rest.includes("--help") || rest.includes("-h")) {
    printHelp();
    return;
  }

  if (command === "send") {
    const question = await readQuestion(flags);
    const context = await readContext(flags);
    if (!question.trim()) {
      throw new Error("Question is empty. Pass it after `send`, or use --question-file.");
    }
    if (!context.trim()) {
      throw new Error("Context is empty. Provide compact-style context on stdin or with --context-file.");
    }

    validateContextBrief(context, Boolean(flags["strict-context"]));
    const prompt = buildAdviserPrompt(question, context);
    await ensureBridgeRunning(flags);
    const result = sendViaOpenAdviser(prompt, flags);

    if (flags.text) {
      console.log(result.result?.runId || result.runId || "");
      return;
    }

    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "read") {
    const runId = String(flags["run-id"] || flags.run || flags.positionals[0] || "").trim();
    if (!runId) {
      throw new Error("runId is required. Use `openadviser.js read --run-id <id>`.");
    }

    await ensureBridgeRunning(flags);
    const result = readViaOpenAdviser(runId, flags);
    if (flags.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    const text = result && result.result && typeof result.result.text === "string"
      ? result.result.text
      : JSON.stringify(result, null, 2);
    console.log(text);
    return;
  }

  if (command === "wait") {
    const runId = String(flags["run-id"] || flags.run || flags.positionals[0] || "").trim();
    if (!runId) {
      throw new Error("runId is required. Use `openadviser.js wait --run-id <id>`.");
    }

    await ensureBridgeRunning(flags);
    const result = waitViaOpenAdviser(runId, flags);
    if (flags.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    const text = result && result.result && typeof result.result.text === "string"
      ? result.result.text
      : JSON.stringify(result, null, 2);
    console.log(text);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

function buildAdviserPrompt(question, context) {
  return [
    "You are an external adviser for an AI agent.",
    "You are receiving a manually prepared decision brief based on a compact-style handoff, not a raw transcript or hidden state dump.",
    "Interpret the brief like a senior reviewer would: verified facts are evidence, caller assessments are hypotheses, risks/open questions are unresolved, and file paths/commands/errors are primary context.",
    "Do not blindly accept the caller's opinions. If the facts support a different conclusion, say so and explain the tie-breaker.",
    "If the brief is missing decision-critical context or appears to describe the adviser call rather than the underlying situation, call that out before answering.",
    "Before answering, first analyze your task, examine the problem structure from multiple angles, then search the web for relevant information to support your judgment.",
    "Clearly separate externally checked facts, your inferences, and your recommendations.",
    "Give direct, concrete, actionable advice. Do not restate the whole brief.",
    "",
    "[Adviser Question]",
    question.trim(),
    "",
    "[Compact-Style Context]",
    context.trim()
  ].join("\n");
}

function validateContextBrief(context, strict) {
  const requiredHeadings = [
    "## Goal",
    "## Constraints & Preferences",
    "## Current State",
    "## Key Decisions",
    "## Important Files & Code Locations",
    "## Critical Technical Context",
    "## Validation Status",
    "## Risks & Open Questions",
    "## Next Steps",
    "## Handoff Instructions for the Next Model"
  ];
  const missing = requiredHeadings.filter((heading) => !context.includes(heading));

  const weakSignals = [];
  if (!/Adviser decision needed|需要.*(判断|决策|建议)|希望.*(判断|决策|建议)/i.test(context)) {
    weakSignals.push("no explicit adviser decision needed");
  }
  if (!/\b(Fact|Facts|事实|Verified|已验证|Confirmed|证据)\b/i.test(context)) {
    weakSignals.push("no explicit fact/evidence labeling");
  }
  if (!/\b(Assumptions?|Hypothes(?:is|es)|Inferences?|Opinions?|假设|推断|判断|观点)\b/i.test(context)) {
    weakSignals.push("no explicit assumption/inference labeling");
  }
  if (/(Primary task|主要任务)\s*[:：]\s*(Ask|Use|Test|调用|使用|测试).*(adviser|advisor|外部顾问)|ask (an )?external adviser|test .*adviser|测试.*adviser|让.*adviser.*返回|adviser.*返回.*答案/i.test(context)) {
    weakSignals.push("context may describe the adviser test instead of the underlying user situation");
  }
  if (/(<skills_instructions>|### Available skills|<permissions instructions>|<environment_context>|^# Tools\b|namespace functions)/im.test(context)) {
    weakSignals.push("context may include raw system/tool/skill catalog text instead of a curated brief");
  }

  if (missing.length === 0 && weakSignals.length === 0) {
    return;
  }

  const message = [
    "Context brief quality warning:",
    missing.length > 0 ? `- Missing compact headings: ${missing.join(", ")}` : "",
    weakSignals.length > 0 ? `- Weak signals: ${weakSignals.join("; ")}` : "",
    "OpenAdviser context should describe the underlying situation, evidence, assumptions, decisions, and unknowns, not just the act of asking adviser."
  ].filter(Boolean).join("\n");

  if (strict) {
    throw new Error(message);
  }
  console.error(message);
}

async function ensureBridgeRunning(flags) {
  const serverUrl = String(flags.server || DEFAULT_BRIDGE_URL);
  if (await canReachHealth(serverUrl)) {
    return;
  }

  const bin = String(flags["openadviser-bin"] || DEFAULT_OPENADVISER_BIN);
  const child = spawn(bin, ["server"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    shell: process.platform === "win32"
  });
  child.unref();

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await canReachHealth(serverUrl)) {
      return;
    }
    await delay(250);
  }

  throw new Error(`OpenAdviser bridge did not become healthy at ${serverUrl}. Install/start it with: npm install -g openadviser && openadviser server`);
}

async function canReachHealth(serverUrl) {
  try {
    const response = await fetch(`${serverUrl.replace(/\/$/, "")}/health`, { cache: "no-store" });
    return response.ok;
  } catch (error) {
    return false;
  }
}

function sendViaOpenAdviser(prompt, flags) {
  const args = [
    "send",
    "--json",
    "--provider",
    normalizeProvider(flags.provider || DEFAULT_PROVIDER),
    "--timeout",
    String(numberFlag(flags.timeout, DEFAULT_TIMEOUT_MS)),
    "--page-load-timeout",
    String(numberFlag(flags["page-load-timeout"], DEFAULT_PAGE_LOAD_TIMEOUT_MS))
  ];

  if (flags.server) {
    args.push("--server", String(flags.server));
  }
  if (flags.url && flags.url !== true) {
    args.push("--url", String(flags.url));
  }
  if (flags["input-timeout"]) {
    args.push("--input-timeout", String(numberFlag(flags["input-timeout"], 60000)));
  }
  for (const optionName of ["window-left", "window-top", "window-width", "window-height"]) {
    if (flags[optionName]) {
      args.push(`--${optionName}`, String(numberFlag(flags[optionName], 0)));
    }
  }
  if (flags["focus-window"]) {
    args.push("--focus-window");
  }
  return runOpenAdviser(args, prompt, flags);
}

function readViaOpenAdviser(runId, flags) {
  const args = [
    "read",
    "--json",
    "--timeout",
    String(numberFlag(flags.timeout, DEFAULT_TIMEOUT_MS)),
    "--run-id",
    runId
  ];

  if (flags.server) {
    args.push("--server", String(flags.server));
  }
  if (flags.provider && flags.provider !== true) {
    args.push("--provider", normalizeProvider(flags.provider));
  }
  if (flags["copy-button"]) {
    args.push("--copy-button");
  }
  if (flags.full || flags["full-text"]) {
    args.push("--full");
  }
  if (flags["read-timeout"]) {
    args.push("--read-timeout", String(numberFlag(flags["read-timeout"], 15000)));
  }

  return runOpenAdviser(args, "", flags);
}

function waitViaOpenAdviser(runId, flags) {
  const args = [
    "wait",
    "--json",
    "--timeout",
    String(numberFlag(flags.timeout, DEFAULT_WAIT_TIMEOUT_MS)),
    "--run-id",
    runId
  ];

  if (flags.server) {
    args.push("--server", String(flags.server));
  }
  if (flags.provider && flags.provider !== true) {
    args.push("--provider", normalizeProvider(flags.provider));
  }
  if (flags["copy-button"]) {
    args.push("--copy-button");
  }
  if (flags.full || flags["full-text"]) {
    args.push("--full");
  }
  if (flags["no-full"]) {
    args.push("--no-full");
  }
  if (flags["read-timeout"]) {
    args.push("--read-timeout", String(numberFlag(flags["read-timeout"], 15000)));
  }
  if (flags.interval) {
    args.push("--interval", String(numberFlag(flags.interval, 5000)));
  }
  if (flags["read-task-timeout"]) {
    args.push("--read-task-timeout", String(numberFlag(flags["read-task-timeout"], DEFAULT_TIMEOUT_MS)));
  }

  return runOpenAdviser(args, "", flags);
}

function runOpenAdviser(args, input, flags) {
  const bin = String(flags["openadviser-bin"] || DEFAULT_OPENADVISER_BIN);
  const result = spawnSync(bin, args, {
    input,
    encoding: "utf8",
    maxBuffer: 200 * 1024 * 1024,
    windowsHide: true,
    shell: process.platform === "win32"
  });

  if (result.status !== 0) {
    throw new Error([
      "OpenAdviser CLI failed.",
      summarizeOpenAdviserOutput(result.stdout.trim()),
      result.stderr.trim()
    ].filter(Boolean).join("\n"));
  }

  const stdout = result.stdout.trim();
  try {
    const task = JSON.parse(stdout);
    if (task.status !== "completed" || !task.result || task.result.ok !== true) {
      throw new Error(summarizeTask(task));
    }
    return task;
  } catch (error) {
    throw new Error(`Unable to parse OpenAdviser JSON output: ${error.message}\n${summarizeOpenAdviserOutput(stdout)}`);
  }
}

function summarizeOpenAdviserOutput(stdout) {
  if (!stdout) {
    return "";
  }

  try {
    return summarizeTask(JSON.parse(stdout));
  } catch (error) {
    return stdout.length > 2000
      ? `${stdout.slice(0, 2000)}\n[truncated ${stdout.length - 2000} chars]`
      : stdout;
  }
}

function summarizeTask(task) {
  return JSON.stringify({
    id: task.id,
    status: task.status,
    attempts: task.attempts,
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    updatedAt: task.updatedAt,
    promptLength: typeof task.prompt === "string" ? task.prompt.length : undefined,
    promptPreview: typeof task.prompt === "string" ? preview(task.prompt, 240) : undefined,
    options: task.options,
    result: task.result
  }, null, 2);
}

async function readQuestion(flags) {
  if (flags["question-file"]) {
    return fs.readFileSync(path.resolve(String(flags["question-file"])), "utf8");
  }
  if (flags.positionals.length > 0) {
    return flags.positionals.join(" ");
  }
  return "";
}

async function readContext(flags) {
  if (flags["context-file"]) {
    return fs.readFileSync(path.resolve(String(flags["context-file"])), "utf8");
  }
  if (flags.context && flags.context !== true) {
    return String(flags.context);
  }
  if (process.stdin.isTTY) {
    return "";
  }

  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseArgs(args) {
  const flags = { positionals: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      flags.positionals.push(arg);
      continue;
    }

    const eqIndex = arg.indexOf("=");
    if (eqIndex >= 0) {
      flags[arg.slice(2, eqIndex)] = arg.slice(eqIndex + 1);
      continue;
    }

    const name = arg.slice(2);
    const next = args[index + 1];
    if (next && !next.startsWith("--")) {
      flags[name] = next;
      index += 1;
    } else {
      flags[name] = true;
    }
  }
  return flags;
}

function numberFlag(value, fallback) {
  if (value === undefined || value === null || value === true) {
    return fallback;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeProvider(value) {
  const provider = String(value || DEFAULT_PROVIDER).trim().toLowerCase();
  return provider || DEFAULT_PROVIDER;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function preview(value, maxLength = 120) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 1)}...`;
}

function printHelp() {
  console.log(`Usage:
  openadviser.js send "question" --context-file context.md
  cat context.md | openadviser.js send "question"
  openadviser.js read --run-id <runId>
  openadviser.js wait --run-id <runId>

Options:
  --context-file <path>        Compact-style context file to send.
  --context <text>             Compact-style context text to send.
  --question-file <path>       Adviser question file.
  --strict-context             Fail if the context brief lacks core compact/adviser signals.
  --openadviser-bin <command>  OpenAdviser executable. Default: ${DEFAULT_OPENADVISER_BIN}
  --server <url>               Bridge URL. Default: ${DEFAULT_BRIDGE_URL}
  --provider <id>              Web AI provider. Supported now: chatgpt, grok. Default: ${DEFAULT_PROVIDER}
  --url <url>                  Override provider URL for send.
  --timeout <ms>               Atomic bridge action wait timeout. Default: ${DEFAULT_TIMEOUT_MS}
                               For wait, total timeout. Default: ${DEFAULT_WAIT_TIMEOUT_MS}
  --interval <ms>              Poll interval for wait. Default: 5000
  --page-load-timeout <ms>     Max soft wait for provider page load before continuing. Default: ${DEFAULT_PAGE_LOAD_TIMEOUT_MS}
  --input-timeout <ms>         Provider composer wait timeout before send.
  --window-left <px>           OpenAdviser worker window left edge.
  --window-top <px>            OpenAdviser worker window top edge.
  --window-width <px>          OpenAdviser worker window width.
  --window-height <px>         OpenAdviser worker window height.
  --focus-window               Focus the worker window when creating it.
  --run-id <id>                Adviser run id to read.
  --full                       Hydrate rendered content and use provider Copy response before DOM fallback.
  --read-timeout <ms>          Page read timeout. Default: 15000
  --read-task-timeout <ms>     Per-read bridge task timeout for wait. Default: ${DEFAULT_TIMEOUT_MS}
  --copy-button                Try the provider's Copy response button during read.
  --no-full                    Disable wait's default full-read mode.
  --json                       Print full bridge task object.
  --text                       For send, print only runId; for read/wait, print answer text.
`);
}
