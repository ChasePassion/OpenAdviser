"use strict";

const http = require("node:http");
const { randomUUID } = require("node:crypto");

const PORT = Number(process.env.WEB_AI_BRIDGE_PORT || process.env.CHATGPT_BRIDGE_PORT || 8787);
const HOST = process.env.WEB_AI_BRIDGE_HOST || process.env.CHATGPT_BRIDGE_HOST || "127.0.0.1";
const CLAIM_TIMEOUT_MS = Number(process.env.WEB_AI_BRIDGE_CLAIM_TIMEOUT_MS || process.env.CHATGPT_BRIDGE_CLAIM_TIMEOUT_MS || 10 * 60 * 1000);
const DEFAULT_PROVIDER = process.env.WEB_AI_BRIDGE_PROVIDER || "chatgpt";
const KNOWN_PROVIDERS = ["chatgpt", "grok"];

const tasks = new Map();
const runs = new Map();
const queue = [];
const nextWaiters = [];
const taskWaiters = new Map();

const server = http.createServer((request, response) => {
  route(request, response).catch((error) => {
    console.error("[bridge] request failed:", error);
    sendJson(response, 500, {
      ok: false,
      error: { message: error.message || String(error) }
    });
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[bridge] listening on http://${HOST}:${PORT}`);
  console.log("[bridge] load the extension, then run: node bridge/client.js send \"hello\"");
});

async function route(request, response) {
  setCors(response);

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  const url = new URL(request.url, `http://${request.headers.host || `${HOST}:${PORT}`}`);
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  const segments = pathname.split("/").filter(Boolean);

  if (request.method === "GET" && pathname === "/health") {
    sendJson(response, 200, {
      ok: true,
      bridge: "web-ai",
      queued: queue.length,
      total: tasks.size,
      runs: runs.size,
      defaultProvider: DEFAULT_PROVIDER,
      knownProviders: KNOWN_PROVIDERS
    });
    return;
  }

  if (request.method === "POST" && pathname === "/tasks") {
    const body = await readJson(request);

    let task;
    try {
      task = enqueueTask(body);
    } catch (error) {
      sendJson(response, 400, {
        ok: false,
        error: { message: error.message || String(error) }
      });
      return;
    }

    sendJson(response, 202, {
      ok: true,
      taskId: task.id,
      task: publicTask(task)
    });
    return;
  }

  if (segments.length === 2 && segments[0] === "runs" && request.method === "GET") {
    const run = runs.get(segments[1]);
    if (!run) {
      sendJson(response, 404, {
        ok: false,
        error: { message: "Run not found." }
      });
      return;
    }
    sendJson(response, 200, {
      ok: true,
      run: publicRun(run)
    });
    return;
  }

  if (request.method === "GET" && pathname === "/tasks/next") {
    const timeoutMs = clampNumber(url.searchParams.get("timeoutMs"), 0, 60000, 25000);
    const task = claimNextTask();
    if (task) {
      sendJson(response, 200, {
        ok: true,
        task: extensionTask(task)
      });
      return;
    }

    holdNextTask(response, timeoutMs);
    return;
  }

  if (segments.length === 2 && segments[0] === "tasks" && request.method === "GET") {
    const task = tasks.get(segments[1]);
    if (!task) {
      sendJson(response, 404, {
        ok: false,
        error: { message: "Task not found." }
      });
      return;
    }
    sendJson(response, 200, {
      ok: true,
      task: publicTask(task)
    });
    return;
  }

  if (segments.length === 3 && segments[0] === "tasks" && segments[2] === "wait" && request.method === "GET") {
    const taskId = segments[1];
    const task = tasks.get(taskId);
    if (!task) {
      sendJson(response, 404, {
        ok: false,
        error: { message: "Task not found." }
      });
      return;
    }

    if (isFinal(task)) {
      sendJson(response, 200, {
        ok: true,
        task: publicTask(task)
      });
      return;
    }

    const timeoutMs = clampNumber(url.searchParams.get("timeoutMs"), 1000, 60000, 30000);
    holdTaskResult(taskId, response, timeoutMs);
    return;
  }

  if (segments.length === 3 && segments[0] === "tasks" && segments[2] === "result" && request.method === "POST") {
    const taskId = segments[1];
    const task = tasks.get(taskId);
    if (!task) {
      sendJson(response, 404, {
        ok: false,
        error: { message: "Task not found." }
      });
      return;
    }

    const result = await readJson(request);
    completeTask(task, result);
    sendJson(response, 200, {
      ok: true,
      task: publicTask(task)
    });
    return;
  }

  sendJson(response, 404, {
    ok: false,
    error: { message: "Route not found." }
  });
}

function enqueueTask(body) {
  const now = new Date().toISOString();
  const action = String(body.action || "send").trim().toLowerCase();
  const options = body.options && typeof body.options === "object" ? body.options : {};
  const id = randomUUID();
  let prompt = "";
  let runId = "";
  let run = null;
  let provider = normalizeProvider(body.provider || options.provider || DEFAULT_PROVIDER);

  if (action === "send") {
    prompt = String(body.prompt || "").trim();
    if (!prompt) {
      throw new Error("Prompt is empty.");
    }
    runId = String(body.runId || id).trim();
  } else if (action === "read") {
    runId = String(body.runId || options.runId || "").trim();
    if (!runId) {
      throw new Error("runId is required for read tasks.");
    }
    run = runs.get(runId);
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }
    provider = normalizeProvider(body.provider || options.provider || run.provider || DEFAULT_PROVIDER);
  } else {
    throw new Error(`Unsupported task action: ${action}`);
  }

  const task = {
    id,
    action,
    provider,
    runId,
    prompt,
    options,
    run: run ? publicRun(run) : null,
    status: "queued",
    attempts: 0,
    createdAt: now,
    updatedAt: now,
    result: null
  };

  tasks.set(task.id, task);
  queue.push(task.id);
  console.log(`[bridge] queued ${task.action} ${task.id} provider=${task.provider}${runId ? ` run=${runId}` : ""}: ${preview(prompt || runId)}`);
  releaseNextWaiters();
  return task;
}

function claimNextTask() {
  sweepStaleClaims();

  while (queue.length > 0) {
    const taskId = queue.shift();
    const task = tasks.get(taskId);
    if (!task || task.status !== "queued") {
      continue;
    }

    const now = new Date().toISOString();
    task.status = "running";
    task.attempts += 1;
    task.startedAt = now;
    task.updatedAt = now;
    console.log(`[bridge] claimed ${task.id} provider=${task.provider} attempt ${task.attempts}`);
    return task;
  }

  return null;
}

function completeTask(task, result) {
  const now = new Date().toISOString();
  const normalizedResult = result && typeof result === "object" ? result : { ok: false, error: { message: "Missing task result." } };

  if (task.action === "send" && normalizedResult.ok === true) {
    normalizedResult.runId = String(normalizedResult.runId || task.runId || task.id);
    const run = {
      id: normalizedResult.runId,
      provider: normalizeProvider(normalizedResult.provider || task.provider || DEFAULT_PROVIDER),
      taskId: task.id,
      prompt: task.prompt,
      options: task.options,
      createdAt: task.createdAt,
      updatedAt: now,
      tabId: normalizedResult.tabId,
      url: normalizedResult.url || normalizedResult.meta?.url || null,
      title: normalizedResult.title || normalizedResult.meta?.title || null,
      sendResult: normalizedResult,
      lastRead: null
    };
    task.runId = run.id;
    runs.set(run.id, run);
  }

  if (task.action === "read" && normalizedResult.ok === true && task.runId && runs.has(task.runId)) {
    const run = runs.get(task.runId);
    run.updatedAt = now;
    run.lastRead = normalizedResult;
    if (normalizedResult.url) {
      run.url = normalizedResult.url;
    }
    if (normalizedResult.title) {
      run.title = normalizedResult.title;
    }
  }

  task.result = normalizedResult;
  task.status = normalizedResult.ok === true ? "completed" : "failed";
  task.completedAt = now;
  task.updatedAt = now;

  console.log(`[bridge] ${task.status} ${task.action} ${task.id}`);
  releaseTaskWaiters(task.id);
}

function holdNextTask(response, timeoutMs) {
  const waiter = { response, done: false, timeoutId: null };

  waiter.timeoutId = setTimeout(() => {
    if (waiter.done) {
      return;
    }
    waiter.done = true;
    removeFromArray(nextWaiters, waiter);
    response.writeHead(204);
    response.end();
  }, timeoutMs);

  response.on("close", () => {
    if (waiter.done) {
      return;
    }
    waiter.done = true;
    clearTimeout(waiter.timeoutId);
    removeFromArray(nextWaiters, waiter);
  });

  nextWaiters.push(waiter);
}

function releaseNextWaiters() {
  while (nextWaiters.length > 0) {
    const task = claimNextTask();
    if (!task) {
      return;
    }

    const waiter = nextWaiters.shift();
    if (waiter.done) {
      continue;
    }

    waiter.done = true;
    clearTimeout(waiter.timeoutId);
    sendJson(waiter.response, 200, {
      ok: true,
      task: extensionTask(task)
    });
  }
}

function holdTaskResult(taskId, response, timeoutMs) {
  const waiter = { response, done: false, timeoutId: null };

  waiter.timeoutId = setTimeout(() => {
    if (waiter.done) {
      return;
    }
    waiter.done = true;
    removeTaskWaiter(taskId, waiter);

    const task = tasks.get(taskId);
    sendJson(response, 200, {
      ok: true,
      task: task ? publicTask(task) : null
    });
  }, timeoutMs);

  response.on("close", () => {
    if (waiter.done) {
      return;
    }
    waiter.done = true;
    clearTimeout(waiter.timeoutId);
    removeTaskWaiter(taskId, waiter);
  });

  if (!taskWaiters.has(taskId)) {
    taskWaiters.set(taskId, []);
  }
  taskWaiters.get(taskId).push(waiter);
}

function releaseTaskWaiters(taskId) {
  const waiters = taskWaiters.get(taskId) || [];
  taskWaiters.delete(taskId);
  const task = tasks.get(taskId);

  for (const waiter of waiters) {
    if (waiter.done) {
      continue;
    }

    waiter.done = true;
    clearTimeout(waiter.timeoutId);
    sendJson(waiter.response, 200, {
      ok: true,
      task: publicTask(task)
    });
  }
}

function sweepStaleClaims() {
  const now = Date.now();
  for (const task of tasks.values()) {
    if (task.status !== "running" || !task.startedAt) {
      continue;
    }

    if (now - Date.parse(task.startedAt) > CLAIM_TIMEOUT_MS) {
      task.status = "queued";
      task.updatedAt = new Date().toISOString();
      queue.push(task.id);
      console.warn(`[bridge] requeued stale task ${task.id}`);
    }
  }
}

function publicTask(task) {
  if (!task) {
    return null;
  }

  return {
    id: task.id,
    action: task.action,
    provider: task.provider,
    runId: task.runId,
    prompt: task.prompt,
    options: task.options,
    run: task.run,
    status: task.status,
    attempts: task.attempts,
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    updatedAt: task.updatedAt,
    result: task.result
  };
}

function extensionTask(task) {
  return {
    id: task.id,
    action: task.action,
    provider: task.provider,
    runId: task.runId,
    prompt: task.prompt,
    options: task.options,
    run: task.run,
    source: "bridge"
  };
}

function publicRun(run) {
  if (!run) {
    return null;
  }

  return {
    id: run.id,
    provider: run.provider || DEFAULT_PROVIDER,
    taskId: run.taskId,
    prompt: run.prompt,
    options: run.options,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    tabId: run.tabId,
    url: run.url,
    title: run.title,
    sendResult: run.sendResult,
    lastRead: run.lastRead
  };
}

function isFinal(task) {
  return task.status === "completed" || task.status === "failed";
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(new Error(`Invalid JSON body: ${error.message}`));
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response, statusCode, payload) {
  setCors(response);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(payload));
}

function setCors(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function removeTaskWaiter(taskId, waiter) {
  const waiters = taskWaiters.get(taskId);
  if (!waiters) {
    return;
  }
  removeFromArray(waiters, waiter);
  if (waiters.length === 0) {
    taskWaiters.delete(taskId);
  }
}

function removeFromArray(items, item) {
  const index = items.indexOf(item);
  if (index >= 0) {
    items.splice(index, 1);
  }
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, number));
}

function normalizeProvider(value) {
  const provider = String(value || DEFAULT_PROVIDER).trim().toLowerCase();
  return provider || DEFAULT_PROVIDER;
}

function preview(value, maxLength = 80) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 1)}...`;
}
