"use strict";

const DEFAULT_PROVIDER_ID = "chatgpt";
const PROVIDERS = {
  chatgpt: {
    id: "chatgpt",
    label: "ChatGPT",
    defaultUrl: "https://chatgpt.com/"
  },
  grok: {
    id: "grok",
    label: "Grok",
    defaultUrl: "https://grok.com/"
  }
};
const CONTENT_SCRIPT_FILE = "src/content/provider.js";
const BRIDGE_BASE_URL = "http://127.0.0.1:8787";
const BRIDGE_ALARM_NAME = "web-ai-bridge";
const DEFAULT_INPUT_TIMEOUT_MS = 60000;
const DEFAULT_PAGE_LOAD_WAIT_MS = 15000;
const CONTENT_SCRIPT_READY_TIMEOUT_MS = 20000;

let bridgeDrainPromise = null;
let currentRun = null;

chrome.runtime.onInstalled.addListener(() => {
  ensureBridgeAlarm();
  drainBridgeQueue("installed");
});

chrome.runtime.onStartup.addListener(() => {
  ensureBridgeAlarm();
  drainBridgeQueue("startup");
});

chrome.action.onClicked.addListener(() => {
  drainBridgeQueue("action");
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === BRIDGE_ALARM_NAME) {
    drainBridgeQueue("alarm");
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) {
    return false;
  }

  if (message.type === "RUN_PROMPT" || message.type === "SEND_PROMPT") {
    sendPrompt(message.prompt, message.options || {})
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse(failureResult(error)));
    return true;
  }

  if (message.type === "READ_RESULT") {
    readRunResult(message.run || {}, message.options || {})
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse(failureResult(error)));
    return true;
  }

  if (message.type === "WAKE_BRIDGE") {
    drainBridgeQueue("message")
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse(failureResult(error)));
    return true;
  }

  if (message.type === "GET_STATUS") {
    getStatus()
      .then((status) => sendResponse({ ok: true, status }))
      .catch((error) => sendResponse(failureResult(error)));
    return true;
  }

  return false;
});

async function sendPrompt(prompt, options = {}) {
  const cleanPrompt = String(prompt || "").trim();
  if (!cleanPrompt) {
    throw new Error("Prompt is empty.");
  }

  const provider = resolveProvider(options.provider);
  if (currentRun) {
    throw new Error("Another web AI run is already in progress.");
  }

  const runId = String(options.runId || crypto.randomUUID());
  const startedAt = new Date().toISOString();
  const runOptions = normalizeRunOptions(provider, options);
  currentRun = {
    runId,
    provider: provider.id,
    startedAt,
    promptPreview: preview(cleanPrompt),
    source: runOptions.source
  };

  await setBadge("SEND", "#2563eb");
  await saveStatus({
    state: "sending",
    provider: provider.id,
    runId,
    startedAt,
    promptPreview: preview(cleanPrompt),
    source: runOptions.source
  });

  let tabId = null;

  try {
    const tab = await openProviderTab(runOptions);
    tabId = tab.id;

    const loadWait = await waitForTabCompleteOrDelay(tabId, runOptions.pageLoadTimeoutMs);
    await ensureContentScriptReady(tabId, CONTENT_SCRIPT_READY_TIMEOUT_MS);

    const response = await sendProviderMessage(tabId, cleanPrompt, {
      ...runOptions,
      runId
    });
    if (!response || response.ok !== true) {
      throw responseToError(response);
    }

    const completedAt = new Date().toISOString();
    const result = {
      ok: true,
      provider: provider.id,
      runId: response.runId || runId,
      tabId,
      url: response.url || tab.url || null,
      title: response.title || tab.title || null,
      sentAt: response.sentAt || completedAt,
      startedAt,
      completedAt,
      elapsedMs: Date.now() - Date.parse(startedAt),
      meta: {
        ...(response.meta || {}),
        provider: provider.id,
        providerLabel: provider.label,
        pageLoadWait: loadWait
      }
    };

    await saveStatus({
      state: "sent",
      provider: provider.id,
      runId: result.runId,
      startedAt,
      completedAt,
      promptPreview: preview(cleanPrompt),
      tabId,
      url: result.url,
      title: result.title,
      source: runOptions.source
    });
    await setBadge("SENT", "#16a34a", 5000);

    return result;
  } catch (error) {
    const failedAt = new Date().toISOString();
    const result = failureResult(error, {
      runId,
      provider: provider.id,
      startedAt,
      failedAt,
      tabId
    });

    await saveStatus({
      state: "failed",
      provider: provider.id,
      runId,
      startedAt,
      failedAt,
      promptPreview: preview(cleanPrompt),
      error: result.error,
      tabId,
      source: runOptions.source
    });
    await setBadge("ERR", "#dc2626", 8000);

    return result;
  } finally {
    currentRun = null;
  }
}

async function readRunResult(run, options = {}) {
  const runId = String(options.runId || run.id || run.runId || "").trim();
  const tabId = Number(options.tabId || run.tabId || run.sendResult?.tabId);
  const provider = resolveProvider(options.provider || run.provider || run.sendResult?.provider);
  if (!runId) {
    throw new Error("runId is required to read a web AI result.");
  }
  if (!Number.isFinite(tabId)) {
    throw new Error(`No provider tab id is available for run ${runId}.`);
  }

  const startedAt = new Date().toISOString();
  const readOptions = normalizeReadOptions(provider, {
    ...(options || {}),
    runId,
    run
  });

  await setBadge("READ", "#7c3aed");
  try {
    await ensureContentScriptReady(tabId, CONTENT_SCRIPT_READY_TIMEOUT_MS);
    const response = await readProviderResult(tabId, readOptions);
    if (!response || response.ok !== true) {
      throw responseToError(response);
    }

    const completedAt = new Date().toISOString();
    const result = {
      ok: true,
      provider: provider.id,
      runId,
      tabId,
      status: response.status,
      complete: response.complete === true,
      text: response.text || "",
      textLength: response.textLength || 0,
      lowConfidence: response.lowConfidence === true,
      hasResponseActions: response.hasResponseActions === true,
      isGenerating: response.isGenerating === true,
      extractionMethod: response.extractionMethod || "dom",
      assistantCount: response.assistantCount,
      beforeAssistantCount: response.beforeAssistantCount,
      url: response.url || null,
      title: response.title || null,
      startedAt,
      completedAt,
      elapsedMs: Date.now() - Date.parse(startedAt),
      meta: response.meta || {}
    };

    await saveStatus({
      state: "read",
      provider: provider.id,
      runId,
      tabId,
      status: result.status,
      complete: result.complete,
      textLength: result.textLength,
      answerPreview: preview(result.text),
      source: readOptions.source
    });
    await setBadge(result.complete ? "DONE" : "PART", result.complete ? "#16a34a" : "#f59e0b", 5000);
    return result;
  } catch (error) {
    const failedAt = new Date().toISOString();
    const result = failureResult(error, {
      runId,
      provider: provider.id,
      startedAt,
      failedAt,
      tabId
    });

    await saveStatus({
      state: "read_failed",
      provider: provider.id,
      runId,
      failedAt,
      error: result.error,
      tabId,
      source: readOptions.source
    });
    await setBadge("ERR", "#dc2626", 8000);
    return result;
  }
}

function normalizeRunOptions(provider, options) {
  const pageUrl = options.pageUrl || options.url || provider.defaultUrl;
  return {
    provider: provider.id,
    providerLabel: provider.label,
    source: options.source || "bridge",
    pageUrl,
    pageLoadTimeoutMs: clampNumber(options.pageLoadTimeoutMs, 3000, 120000, DEFAULT_PAGE_LOAD_WAIT_MS),
    inputTimeoutMs: clampNumber(options.inputTimeoutMs, 10000, 180000, DEFAULT_INPUT_TIMEOUT_MS)
  };
}

function normalizeReadOptions(provider, options) {
  return {
    provider: provider.id,
    providerLabel: provider.label,
    source: options.source || "bridge",
    runId: options.runId,
    run: options.run || null,
    useCopyButton: Boolean(options.useCopyButton),
    readTimeoutMs: clampNumber(options.readTimeoutMs, 5000, 60000, 15000)
  };
}

async function openProviderTab(options) {
  return chrome.tabs.create({
    url: options.pageUrl,
    active: false
  });
}

async function waitForTabCompleteOrDelay(tabId, timeoutMs) {
  const startedAt = Date.now();
  const tab = await chrome.tabs.get(tabId);
  if (tab.status === "complete") {
    return {
      completed: true,
      elapsedMs: Date.now() - startedAt
    };
  }

  return await new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      cleanup();
      console.warn(`Continuing before tab ${tabId} reported complete after ${timeoutMs} ms.`);
      resolve({
        completed: false,
        elapsedMs: Date.now() - startedAt,
        reason: "fixed-wait-elapsed"
      });
    }, timeoutMs);

    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        cleanup();
        resolve({
          completed: true,
          elapsedMs: Date.now() - startedAt
        });
      }
    };

    function cleanup() {
      clearTimeout(timeoutId);
      chrome.tabs.onUpdated.removeListener(listener);
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function injectContentScript(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: [CONTENT_SCRIPT_FILE]
  });
}

async function ensureContentScriptReady(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      await injectContentScript(tabId);
      const pong = await pingContentScript(tabId);
      if (pong && pong.ok === true) {
        return pong;
      }
    } catch (error) {
      lastError = error;
    }
    await delay(500);
  }

  throw new Error(`Content script did not become ready in tab ${tabId}: ${lastError && lastError.message ? lastError.message : "unknown error"}`);
}

async function pingContentScript(tabId) {
  return await chrome.tabs.sendMessage(tabId, {
    type: "PING_CONTENT_SCRIPT"
  });
}

async function sendProviderMessage(tabId, prompt, options) {
  const payload = {
    type: "SEND_WEB_PROMPT",
    provider: options.provider,
    prompt,
    options: {
      provider: options.provider,
      runId: options.runId,
      inputTimeoutMs: options.inputTimeoutMs
    }
  };

  return await sendContentMessage(tabId, payload);
}

async function readProviderResult(tabId, options) {
  return await sendContentMessage(tabId, {
    type: "READ_WEB_RESULT",
    provider: options.provider,
    options
  });
}

async function sendContentMessage(tabId, payload) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await chrome.tabs.sendMessage(tabId, payload);
    } catch (error) {
      lastError = error;
      if (isReceivingEndMissingError(error)) {
        try {
          await ensureContentScriptReady(tabId, 5000);
        } catch (readyError) {
          lastError = readyError;
        }
      }
      await delay(350 + attempt * 500);
    }
  }

  throw lastError || new Error("Unable to send message to provider content script.");
}

function isReceivingEndMissingError(error) {
  return /receiving end does not exist|could not establish connection/i.test(String(error && error.message ? error.message : error));
}

async function ensureBridgeAlarm() {
  try {
    await chrome.alarms.create(BRIDGE_ALARM_NAME, { periodInMinutes: 0.5 });
  } catch (error) {
    console.warn("30 second alarms unavailable, falling back to 1 minute:", error);
    await chrome.alarms.create(BRIDGE_ALARM_NAME, { periodInMinutes: 1 });
  }
}

async function drainBridgeQueue(reason) {
  if (bridgeDrainPromise) {
    return bridgeDrainPromise;
  }

  bridgeDrainPromise = drainBridgeQueueInner(reason).finally(() => {
    bridgeDrainPromise = null;
  });
  return bridgeDrainPromise;
}

async function drainBridgeQueueInner(reason) {
  let idleRounds = 0;

  while (idleRounds < 2) {
    const task = await fetchNextBridgeTask(12000);
    if (!task) {
      idleRounds += 1;
      continue;
    }

    idleRounds = 0;
    const result = await runBridgeTask(task, reason);
    await postBridgeResult(task.id, result);
  }
}

async function runBridgeTask(task, reason) {
  const action = String(task.action || "send").toLowerCase();
  const options = {
    ...(task.options || {}),
    provider: task.provider || task.options?.provider || DEFAULT_PROVIDER_ID,
    runId: task.runId,
    source: task.source || `bridge:${reason}`
  };

  if (action === "send") {
    return await sendPrompt(task.prompt, options);
  }

  if (action === "read") {
    return await readRunResult(task.run || { id: task.runId }, options);
  }

  return failureResult(new Error(`Unsupported bridge task action: ${action}`), {
    runId: task.runId || null
  });
}

async function fetchNextBridgeTask(timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs + 3000);

  try {
    const url = `${BRIDGE_BASE_URL}/tasks/next?timeoutMs=${encodeURIComponent(timeoutMs)}`;
    const response = await fetch(url, { signal: controller.signal, cache: "no-store" });
    if (response.status === 204) {
      return null;
    }
    if (!response.ok) {
      throw new Error(`Bridge responded with HTTP ${response.status}.`);
    }

    const payload = await response.json();
    return payload.task || null;
  } catch (error) {
    if (error.name !== "AbortError" && !String(error.message || "").includes("Failed to fetch")) {
      console.warn("Bridge fetch failed:", error);
    }
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function postBridgeResult(taskId, result) {
  try {
    await fetch(`${BRIDGE_BASE_URL}/tasks/${encodeURIComponent(taskId)}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(result)
    });
  } catch (error) {
    console.warn("Unable to post bridge result:", error);
  }
}

async function getStatus() {
  const stored = await chrome.storage.local.get(["lastRun"]);
  return {
    providers: Object.keys(PROVIDERS),
    defaultProvider: DEFAULT_PROVIDER_ID,
    currentRun,
    lastRun: stored.lastRun || null
  };
}

async function saveStatus(lastRun) {
  await chrome.storage.local.set({ lastRun });
}

async function setBadge(text, color, clearAfterMs = 0) {
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });

  if (clearAfterMs > 0) {
    setTimeout(() => {
      chrome.action.setBadgeText({ text: "" }).catch(() => {});
    }, clearAfterMs);
  }
}

async function safeRemoveTab(tabId) {
  if (!tabId) {
    return;
  }
  try {
    await chrome.tabs.remove(tabId);
  } catch (error) {
    console.warn(`Unable to close tab ${tabId}:`, error);
  }
}

function resolveProvider(providerId) {
  const id = String(providerId || DEFAULT_PROVIDER_ID).trim().toLowerCase();
  const provider = PROVIDERS[id];
  if (!provider) {
    throw new Error(`Unsupported web provider: ${id || "(empty)"}. Supported providers: ${Object.keys(PROVIDERS).join(", ")}`);
  }
  return provider;
}

function responseToError(response) {
  if (!response) {
    return new Error("No response from provider content script.");
  }
  if (response.error && response.error.message) {
    return new Error(response.error.message);
  }
  if (response.error) {
    return new Error(String(response.error));
  }
  return new Error("Provider content script returned an unsuccessful response.");
}

function failureResult(error, extra = {}) {
  return {
    ok: false,
    ...extra,
    error: {
      message: error && error.message ? error.message : String(error),
      name: error && error.name ? error.name : "Error",
      stack: error && error.stack ? error.stack : undefined
    }
  };
}

function preview(value, maxLength = 160) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 1)}...`;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, number));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
