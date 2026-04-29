"use strict";

const DEFAULT_BASE_URL = process.env.WEB_AI_BRIDGE_URL || process.env.CHATGPT_BRIDGE_URL || "http://127.0.0.1:8787";
const DEFAULT_PROVIDER = process.env.WEB_AI_PROVIDER || "chatgpt";

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

  if (command === "send") {
    await send(args);
    return;
  }

  if (command === "read") {
    await read(args);
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

  const baseUrl = flags.server || DEFAULT_BASE_URL;
  const timeoutMs = numberFlag(flags.timeout, 120000);
  const provider = normalizeProvider(flags.provider || DEFAULT_PROVIDER);
  const options = {
    pageLoadTimeoutMs: numberFlag(flags["page-load-timeout"], undefined),
    inputTimeoutMs: numberFlag(flags["input-timeout"], undefined),
    pageUrl: flags.url && flags.url !== true ? String(flags.url) : undefined
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
  const runId = String(flags["run-id"] || flags.run || flags.positionals[0] || "").trim();
  if (!runId) {
    throw new Error("runId is required. Use `read --run-id <id>`.");
  }

  const baseUrl = flags.server || DEFAULT_BASE_URL;
  const timeoutMs = numberFlag(flags.timeout, 120000);
  const options = {
    provider: flags.provider && flags.provider !== true ? normalizeProvider(flags.provider) : undefined,
    useCopyButton: Boolean(flags["copy-button"]),
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
  if (!flags.quiet && !flags.json && !flags.text) {
    console.error(`[client] queued read ${taskId}; waiting for extension pickup...`);
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
    process.stdout.write(`${task.result.text || ""}\n`);
    return;
  }

  console.log(JSON.stringify(task, null, 2));
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

function normalizeProvider(value) {
  const provider = String(value || DEFAULT_PROVIDER).trim().toLowerCase();
  return provider || DEFAULT_PROVIDER;
}

function printHelp() {
  console.log(`Usage:
  node bridge/client.js health
  node bridge/client.js send "your prompt" --provider chatgpt
  echo "your prompt" | node bridge/client.js send --provider grok
  node bridge/client.js read --run-id <runId>

Options:
  --server <url>              Bridge server URL. Default: ${DEFAULT_BASE_URL}
  --provider <id>             Web provider for send. Supported now: chatgpt, grok. Default: ${DEFAULT_PROVIDER}
  --timeout <ms>              Client wait timeout for the atomic bridge action. Default: 120000
  --url <url>                 Provider URL to open for send. Default: provider setting.
  --page-load-timeout <ms>    Max soft wait for provider page load before continuing.
  --input-timeout <ms>        Provider composer wait timeout inside the extension.
  --run-id <id>               Run id to read.
  --copy-button               On read, also try the provider's Copy response button.
  --text                      Print only runId for send, or answer text for read.
  --json                      Accepted for compatibility; JSON is the default output.
  --quiet                     Suppress progress messages.
`);
}
