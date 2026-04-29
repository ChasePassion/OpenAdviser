"use strict";

const { execFileSync } = require("node:child_process");

const DEFAULT_BASE_URL = process.env.WEB_AI_BRIDGE_URL || process.env.CHATGPT_BRIDGE_URL || "http://127.0.0.1:8787";
const DEFAULT_PROVIDER = process.env.WEB_AI_PROVIDER || "chatgpt";
const CHROME_NOT_RUNNING_MESSAGE = [
  "Chrome is not running.",
  "Open Chrome, make sure the OpenAdviser extension is loaded and enabled, then retry."
].join(" ");

main().catch((error) => {
  console.error(error && error.message ? error.message : error);
  process.exitCode = 1;
});

async function main() {
  const [command, ...args] = process.argv.slice(2);

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }

  if (command === "send") {
    await send(args);
    return;
  }

  if (command === "read") {
    await read(args);
    return;
  }

  if (command === "wait") {
    await wait(args);
    return;
  }

  if (command === "health") {
    const flags = parseArgs(args);
    const response = await requestJson(`${flags.server || DEFAULT_BASE_URL}/health`);
    console.log(JSON.stringify(response, null, 2));
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

async function send(args) {
  const flags = parseArgs(args);
  const prompt = await resolvePrompt(flags.positionals);
  if (!prompt.trim()) {
    throw new Error("Prompt is empty. Pass text after `send` or pipe it through stdin.");
  }
  assertChromeRunning(flags);

  const baseUrl = flags.server || DEFAULT_BASE_URL;
  const timeoutMs = numberFlag(flags.timeout, 120000);
  const provider = normalizeProvider(flags.provider || DEFAULT_PROVIDER);
  const options = {
    pageLoadTimeoutMs: numberFlag(flags["page-load-timeout"], undefined),
    inputTimeoutMs: numberFlag(flags["input-timeout"], undefined),
    pageUrl: flags.url && flags.url !== true ? String(flags.url) : undefined,
    workerWindowLeft: numberFlag(flags["window-left"], undefined),
    workerWindowTop: numberFlag(flags["window-top"], undefined),
    workerWindowWidth: numberFlag(flags["window-width"], undefined),
    workerWindowHeight: numberFlag(flags["window-height"], undefined),
    focusWorkerWindow: Boolean(flags["focus-window"])
  };

  stripUndefined(options);

  const createResponse = await requestJson(`${baseUrl}/tasks`, {
    method: "POST",
    body: {
      action: "send",
      provider,
      prompt,
      options
    }
  });

  if (!createResponse.ok) {
    throw new Error(createResponse.error?.message || "Unable to create bridge task.");
  }

  const taskId = createResponse.taskId;
  if (!flags.quiet && !flags.json) {
    console.error(`[client] queued send ${taskId}; waiting for extension pickup...`);
  }

  const task = await waitForTask(baseUrl, taskId, timeoutMs);
  if (task.status !== "completed" || !task.result || task.result.ok !== true) {
    const message = task.result?.error?.message || `Task ended with status ${task.status}.`;
    if (flags.json) {
      console.log(JSON.stringify(task, null, 2));
      process.exitCode = 1;
      return;
    }
    throw new Error(message);
  }

  if (flags.text) {
    process.stdout.write(`${task.result.runId || task.runId || ""}\n`);
    return;
  }

  console.log(JSON.stringify(task, null, 2));
}

async function read(args) {
  const flags = parseArgs(args);
  const runId = requireRunId(flags, "read");
  assertChromeRunning(flags);

  const task = await readRun(runId, flags);
  if (flags.text) {
    process.stdout.write(`${task.result.text || ""}\n`);
    return;
  }

  console.log(JSON.stringify(task, null, 2));
}

async function wait(args) {
  const flags = parseArgs(args);
  const runId = requireRunId(flags, "wait");
  assertChromeRunning(flags);

  const timeoutMs = numberFlag(flags.timeout, 600000);
  const intervalMs = Math.max(1000, numberFlag(flags.interval, 5000));
  const deadline = Date.now() + timeoutMs;
  let lastTask = null;
  let attempt = 0;

  while (Date.now() < deadline) {
    attempt += 1;
    const remainingMs = Math.max(1000, deadline - Date.now());
    const readTaskTimeoutMs = Math.min(
      remainingMs,
      numberFlag(flags["read-task-timeout"] || flags["action-timeout"], 120000)
    );
    const task = await readRun(runId, flags, { timeoutMs: readTaskTimeoutMs, quiet: true, fullTextDefault: true });
    lastTask = task;

    if (isCompleteReadResult(task.result)) {
      if (flags.text) {
        process.stdout.write(`${task.result.text || ""}\n`);
        return;
      }
      console.log(JSON.stringify(task, null, 2));
      return;
    }

    if (!flags.quiet && !flags.text && !flags.json) {
      const status = task.result?.status || "unknown";
      const textLength = typeof task.result?.text === "string" ? task.result.text.length : 0;
      console.error(`[client] wait attempt ${attempt}: ${status}, ${textLength} chars; polling again...`);
    }

    const sleepMs = Math.min(intervalMs, Math.max(0, deadline - Date.now()));
    if (sleepMs <= 0) {
      break;
    }
    await delay(sleepMs);
  }

  if (flags.json && lastTask) {
    console.log(JSON.stringify({
      ...lastTask,
      waitTimedOut: true,
      waitTimeoutMs: timeoutMs
    }, null, 2));
    process.exitCode = 1;
    return;
  }

  const lastStatus = lastTask?.result?.status || "unknown";
  const textLength = typeof lastTask?.result?.text === "string" ? lastTask.result.text.length : 0;
  throw new Error(`Timed out after ${timeoutMs} ms waiting for run ${runId} to complete. Last status: ${lastStatus}; text length: ${textLength}.`);
}

async function readRun(runId, flags, overrides = {}) {
  const baseUrl = flags.server || DEFAULT_BASE_URL;
  const timeoutMs = overrides.timeoutMs || numberFlag(flags.timeout, 120000);
  const options = {
    provider: flags.provider && flags.provider !== true ? normalizeProvider(flags.provider) : undefined,
    useCopyButton: Boolean(flags["copy-button"] || flags.full || flags["full-text"] || (overrides.fullTextDefault && !flags["no-full"])),
    hydrateRenderedContent: Boolean(flags.full || flags["full-text"] || (overrides.fullTextDefault && !flags["no-full"])),
    readTimeoutMs: numberFlag(flags["read-timeout"], undefined)
  };

  stripUndefined(options);

  const createResponse = await requestJson(`${baseUrl}/tasks`, {
    method: "POST",
    body: {
      action: "read",
      provider: options.provider,
      runId,
      options
    }
  });

  if (!createResponse.ok) {
    throw new Error(createResponse.error?.message || "Unable to create bridge read task.");
  }

  const taskId = createResponse.taskId;
  if (!overrides.quiet && !flags.quiet && !flags.json && !flags.text) {
    console.error(`[client] queued read ${taskId}; waiting for extension pickup...`);
  }

  const task = await waitForTask(baseUrl, taskId, timeoutMs);
  if (task.status !== "completed" || !task.result || task.result.ok !== true) {
    const message = task.result?.error?.message || `Task ended with status ${task.status}.`;
    if (flags.json && !overrides.quiet) {
      console.log(JSON.stringify(task, null, 2));
      process.exitCode = 1;
      return;
    }
    throw new Error(message);
  }

  return task;
}

async function waitForTask(baseUrl, taskId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const waitMs = Math.min(30000, Math.max(1000, deadline - Date.now()));
    const response = await requestJson(`${baseUrl}/tasks/${encodeURIComponent(taskId)}/wait?timeoutMs=${waitMs}`);

    if (!response.ok) {
      throw new Error(response.error?.message || "Unable to wait for task.");
    }

    const task = response.task;
    if (task && (task.status === "completed" || task.status === "failed")) {
      return task;
    }
  }

  throw new Error(`Timed out after ${timeoutMs} ms waiting for task ${taskId}.`);
}

async function resolvePrompt(positionals) {
  if (positionals.length > 0) {
    return positionals.join(" ");
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

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(payload.error?.message || `HTTP ${response.status} from ${url}`);
  }
  return payload;
}

function numberFlag(value, fallback) {
  if (value === undefined || value === null || value === true) {
    return fallback;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function stripUndefined(value) {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) {
      delete value[key];
    }
  }
}

function requireRunId(flags, command) {
  const runId = String(flags["run-id"] || flags.run || flags.positionals[0] || "").trim();
  if (!runId) {
    throw new Error(`runId is required. Use \`${command} --run-id <id>\`.`);
  }
  return runId;
}

function isCompleteReadResult(result) {
  return Boolean(result && (result.complete === true || result.status === "complete"));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeProvider(value) {
  const provider = String(value || DEFAULT_PROVIDER).trim().toLowerCase();
  return provider || DEFAULT_PROVIDER;
}

function assertChromeRunning(flags) {
  if (shouldSkipChromeProcessCheck(flags)) {
    return;
  }

  const status = chromeProcessStatus();
  if (status.running === false) {
    throw new Error(`${CHROME_NOT_RUNNING_MESSAGE} Checked process names: ${status.names.join(", ")}.`);
  }
  if (status.running === null && !flags.quiet) {
    console.error(`[client] unable to verify Chrome process state (${status.reason}); continuing anyway.`);
  }
}

function shouldSkipChromeProcessCheck(flags) {
  return Boolean(
    flags["no-chrome-check"] ||
    /^(1|true|yes)$/i.test(String(process.env.OPENADVISER_SKIP_CHROME_CHECK || ""))
  );
}

function chromeProcessStatus() {
  const names = chromeProcessNames();
  try {
    if (process.platform === "win32") {
      return {
        running: names.some((name) => windowsProcessExists(name)),
        names
      };
    }

    if (process.platform === "darwin" || process.platform === "linux") {
      return {
        running: names.some((name) => unixProcessExists(name)),
        names
      };
    }

    return {
      running: null,
      names,
      reason: `unsupported platform ${process.platform}`
    };
  } catch (error) {
    return {
      running: null,
      names,
      reason: error && error.message ? error.message : String(error)
    };
  }
}

function chromeProcessNames() {
  const configured = String(process.env.OPENADVISER_CHROME_PROCESS_NAMES || "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  if (configured.length > 0) {
    return configured;
  }

  if (process.platform === "win32") {
    return ["chrome.exe"];
  }
  if (process.platform === "darwin") {
    return ["Google Chrome", "Google Chrome Canary", "Chromium"];
  }
  return ["chrome", "google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];
}

function windowsProcessExists(processName) {
  const output = execFileSync("tasklist.exe", ["/FI", `IMAGENAME eq ${processName}`, "/NH"], {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  return new RegExp(`\\b${escapeRegExp(processName)}\\b`, "i").test(output);
}

function unixProcessExists(processName) {
  try {
    const output = execFileSync("pgrep", ["-x", processName], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    return output.trim().length > 0;
  } catch (error) {
    if (typeof error.status === "number" && error.status === 1) {
      return false;
    }
    throw error;
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function printHelp() {
  console.log(`Usage:
  node bridge/client.js health
  node bridge/client.js send "your prompt" --provider chatgpt
  echo "your prompt" | node bridge/client.js send --provider grok
  node bridge/client.js read --run-id <runId>
  node bridge/client.js wait --run-id <runId>

Options:
  --server <url>              Bridge server URL. Default: ${DEFAULT_BASE_URL}
  --provider <id>             Web provider for send. Supported now: chatgpt, grok. Default: ${DEFAULT_PROVIDER}
  --timeout <ms>              Client timeout. For wait, total wait timeout. Default: 120000; wait default: 600000
  --interval <ms>             Poll interval for wait. Default: 5000
  --read-task-timeout <ms>    Per-read bridge task timeout for wait. Default: 120000
  --url <url>                 Provider URL to open for send. Default: provider setting.
  --page-load-timeout <ms>    Max soft wait for provider page load before continuing.
  --input-timeout <ms>        Provider composer wait timeout inside the extension.
  --window-left <px>          OpenAdviser worker window left edge. Default: 24
  --window-top <px>           OpenAdviser worker window top edge. Default: 24
  --window-width <px>         OpenAdviser worker window width. Default: 560
  --window-height <px>        OpenAdviser worker window height. Default: 520
  --focus-window              Focus the worker window when creating it. Default: false
  --run-id <id>               Run id to read.
  --full                      Hydrate rendered content and use the provider Copy response button before DOM fallback.
  --copy-button               On read, also try the provider's Copy response button.
  --no-full                   Disable wait's default full-read mode.
  --no-chrome-check           Skip the local Chrome process preflight check.
  --text                      Print only runId for send, or answer text for read/wait.
  --json                      Accepted for compatibility; JSON is the default output.
  --quiet                     Suppress progress messages.
`);
}
