"use strict";

(() => {
  if (globalThis.__webAiBridgeContentInjected) {
    return;
  }
  globalThis.__webAiBridgeContentInjected = true;

  const CONTENT_SOURCE = "web-ai-bridge-content";
  const PAGE_SOURCE = "web-ai-bridge-page";
  const REQUEST_TIMEOUT_PADDING_MS = 45000;
  const PAGE_SCRIPTS = {
    chatgpt: "src/content/chatgpt-page.js",
    grok: "src/content/grok-page.js"
  };

  const pageScriptPromises = new Map();
  const pageReadyProviders = new Set();
  const pendingRequests = new Map();

  window.addEventListener("message", (event) => {
    if (
      event.source !== window ||
      !event.data ||
      event.data.source !== PAGE_SOURCE
    ) {
      return;
    }

    const provider = normalizeProvider(event.data.provider || detectProvider());
    if (event.data.type === "PAGE_READY") {
      pageReadyProviders.add(provider);
      return;
    }

    const pending = pendingRequests.get(event.data.requestId);
    if (!pending) {
      return;
    }

    pendingRequests.delete(event.data.requestId);
    clearTimeout(pending.timeoutId);

    if (event.data.ok) {
      pending.resolve(event.data.result);
    } else {
      pending.reject(messageToError(event.data.error));
    }
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message) {
      return false;
    }

    if (message.type === "PING_CONTENT_SCRIPT") {
      const provider = normalizeProvider(message.provider || detectProvider());
      sendResponse({
        ok: true,
        provider,
        url: location.href,
        title: document.title,
        pageReady: pageReadyProviders.has(provider)
      });
      return false;
    }

    if (!isProviderRequest(message.type)) {
      return false;
    }

    const provider = normalizeProvider(message.provider || message.options?.provider || detectProvider());
    runInPage(provider, normalizeMessageType(message.type), message.prompt, message.options || {})
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({
        ok: false,
        provider,
        error: serializeError(error)
      }));

    return true;
  });

  async function runInPage(provider, type, prompt, options) {
    await ensurePageScript(provider);

    const requestId = crypto.randomUUID();
    const timeoutMs = requestTimeoutMs(type, options);

    const resultPromise = new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        pendingRequests.delete(requestId);
        reject(new Error(`Timed out waiting for ${provider} page automation result after ${timeoutMs} ms.`));
      }, timeoutMs);

      pendingRequests.set(requestId, { resolve, reject, timeoutId });
    });

    window.postMessage({
      source: CONTENT_SOURCE,
      type,
      provider,
      requestId,
      prompt,
      options: {
        ...options,
        provider
      }
    }, window.location.origin);

    return resultPromise;
  }

  async function ensurePageScript(provider) {
    if (pageReadyProviders.has(provider)) {
      return;
    }

    if (!pageScriptPromises.has(provider)) {
      pageScriptPromises.set(provider, injectPageScript(provider));
    }

    await pageScriptPromises.get(provider);
    window.postMessage({
      source: CONTENT_SOURCE,
      type: "PING_PAGE",
      provider
    }, window.location.origin);
    await waitFor(() => pageReadyProviders.has(provider), 5000, 100);
  }

  function injectPageScript(provider) {
    return new Promise((resolve, reject) => {
      const pageScript = PAGE_SCRIPTS[provider];
      if (!pageScript) {
        reject(new Error(`Unsupported web provider: ${provider}`));
        return;
      }

      const existing = document.querySelector(`script[data-web-ai-bridge-page='${provider}']`);
      if (existing) {
        resolve();
        return;
      }

      const script = document.createElement("script");
      script.src = chrome.runtime.getURL(pageScript);
      script.async = false;
      script.dataset.webAiBridgePage = provider;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error(`Unable to inject ${provider} page automation script.`));
      (document.head || document.documentElement).appendChild(script);
    });
  }

  function requestTimeoutMs(type, options) {
    if (type === "READ_WEB_RESULT") {
      return clampNumber(options.readTimeoutMs, 5000, 60000, 15000) + 5000;
    }

    const inputTimeoutMs = clampNumber(options.inputTimeoutMs, 10000, 180000, 60000);
    return inputTimeoutMs + REQUEST_TIMEOUT_PADDING_MS;
  }

  function isProviderRequest(type) {
    return (
      type === "SEND_WEB_PROMPT" ||
      type === "READ_WEB_RESULT"
    );
  }

  function normalizeMessageType(type) {
    return type;
  }

  function detectProvider() {
    const host = location.hostname.toLowerCase();
    if (host === "grok.com" || host.endsWith(".grok.com")) {
      return "grok";
    }
    if (host === "chatgpt.com" || host.endsWith(".chatgpt.com") || host === "chat.openai.com") {
      return "chatgpt";
    }
    return "chatgpt";
  }

  function normalizeProvider(value) {
    return String(value || detectProvider()).trim().toLowerCase();
  }

  function waitFor(fn, timeoutMs, intervalMs) {
    const start = Date.now();
    return new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        if (fn()) {
          clearInterval(timer);
          resolve();
          return;
        }

        if (Date.now() - start >= timeoutMs) {
          clearInterval(timer);
          reject(new Error("Timed out waiting for page script readiness."));
        }
      }, intervalMs);
    });
  }

  function messageToError(error) {
    const result = new Error(error && error.message ? error.message : String(error));
    if (error && error.name) {
      result.name = error.name;
    }
    if (error && error.stack) {
      result.stack = error.stack;
    }
    return result;
  }

  function serializeError(error) {
    return {
      message: error && error.message ? error.message : String(error),
      name: error && error.name ? error.name : "Error",
      stack: error && error.stack ? error.stack : undefined
    };
  }

  function clampNumber(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return fallback;
    }
    return Math.min(max, Math.max(min, number));
  }
})();
