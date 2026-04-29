"use strict";

(() => {
  if (window.__webAiBridgeGrokPageReady) {
    return;
  }
  window.__webAiBridgeGrokPageReady = true;

  const PROVIDER = "grok";
  const CONTENT_SOURCE = "web-ai-bridge-content";
  const PAGE_SOURCE = "web-ai-bridge-page";

  const INPUT_SELECTORS = [
    "[data-testid='chat-input'] .ProseMirror[contenteditable='true']",
    "[data-testid='chat-input'] [contenteditable='true']",
    ".query-bar .ProseMirror[contenteditable='true']",
    ".tiptap.ProseMirror[contenteditable='true']",
    "form textarea",
    "form [contenteditable='true'][role='textbox']",
    "form [contenteditable='true']",
    "textarea[placeholder*='Ask']",
    "textarea[aria-label*='Ask']",
    "[role='textbox'][contenteditable='true']",
    "[contenteditable='true']",
    "textarea"
  ];

  const ASSISTANT_SELECTORS = [
    "main [data-testid='assistant-message']",
    "main [data-testid='assistant-message'] .response-content-markdown",
    "#last-reply-container [id^='response-'] [data-testid='assistant-message']",
    "main article",
    "main [role='article']",
    "main [class*='assistant' i]",
    "main [class*='response' i] [class*='markdown' i]"
  ];

  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data || event.data.source !== CONTENT_SOURCE) {
      return;
    }

    if (event.data.type === "PING_PAGE") {
      postReady();
      return;
    }

    if (event.data.type === "SEND_WEB_PROMPT") {
      sendGrok(event.data.prompt, event.data.options || {})
        .then((result) => postResult(event.data.requestId, true, result))
        .catch((error) => postResult(event.data.requestId, false, null, serializeError(error)));
      return;
    }

    if (event.data.type === "READ_WEB_RESULT") {
      readGrokResult(event.data.options || {})
        .then((result) => postResult(event.data.requestId, true, result))
        .catch((error) => postResult(event.data.requestId, false, null, serializeError(error)));
    }
  });

  postReady();

  async function sendGrok(prompt, options) {
    const cleanPrompt = String(prompt || "").trim();
    if (!cleanPrompt) {
      throw new Error("Prompt is empty.");
    }

    const runId = String(options.runId || crypto.randomUUID());
    const inputTimeoutMs = clampNumber(options.inputTimeoutMs, 10000, 180000, 60000);
    const startedAt = Date.now();
    const beforeAssistantMessages = getAssistantMessages();
    const beforeBodyText = normalizeText(document.body?.innerText || "");
    const input = await waitForPromptInput(inputTimeoutMs);

    await setPromptText(input, cleanPrompt);
    const button = await waitForSendButtonReady(input, 30000);
    clickSendButton(button);
    await waitForPromptSubmitted(input, cleanPrompt, beforeBodyText, 20000);

    const sentAt = new Date().toISOString();
    const runState = {
      runId,
      provider: PROVIDER,
      prompt: cleanPrompt,
      promptPreview: preview(cleanPrompt),
      beforeAssistantCount: beforeAssistantMessages.length,
      sentAt,
      url: location.href,
      title: document.title
    };
    saveRunState(runId, runState);

    return {
      ok: true,
      provider: PROVIDER,
      runId,
      beforeAssistantCount: runState.beforeAssistantCount,
      sentAt,
      url: location.href,
      title: document.title,
      meta: {
        elapsedMs: Date.now() - startedAt,
        promptPreview: runState.promptPreview
      }
    };
  }

  async function readGrokResult(options) {
    const runId = String(options.runId || options.run?.id || getLastRunId() || "").trim();
    const runState = getRunState(runId);
    const beforeAssistantCount = firstFiniteNumber(
      options.beforeAssistantCount,
      options.run?.sendResult?.meta?.beforeAssistantCount,
      options.run?.sendResult?.beforeAssistantCount,
      runState?.beforeAssistantCount,
      -1
    );
    const stableMs = clampNumber(options.stableMs, 1000, 15000, 3000);
    const prompt = normalizeText(options.run?.prompt || runState?.prompt || runState?.promptPreview || "");
    const assistantMessages = getAssistantMessages();
    const candidate = selectAssistantForRun(assistantMessages, beforeAssistantCount);
    const domText = candidate ? extractMessageText(candidate) : "";
    const fallbackText = extractBodyAnswerFallback(prompt);
    const hasResponseActions = candidate ? Boolean(findCopyButton(candidate)) : false;
    const generating = isGenerating();
    let text = chooseBestText(domText, fallbackText, prompt);
    let extractionMethod = domText ? "dom" : "body-fallback";

    if (options.useCopyButton && candidate && hasResponseActions && !generating) {
      const copiedText = await readCopyButtonText(candidate);
      if (copiedText && copiedText.length >= text.length) {
        text = copiedText;
        extractionMethod = "copy-button";
      }
    }

    const normalizedText = normalizeText(text);
    const placeholder = isPlaceholderText(normalizedText) || isPromptEcho(normalizedText, prompt);
    const stability = updateRunReadStability(runId, runState, normalizedText);
    const status = classifyReadStatus({
      text: normalizedText,
      placeholder,
      generating,
      hasResponseActions,
      stable: stability.stableMs >= stableMs
    });

    const result = {
      ok: true,
      provider: PROVIDER,
      runId,
      status,
      complete: status === "complete",
      text: normalizedText,
      textLength: normalizedText.length,
      lowConfidence: status === "complete" && normalizedText.length < 20,
      hasResponseActions,
      isGenerating: generating,
      extractionMethod,
      assistantCount: assistantMessages.length,
      beforeAssistantCount,
      url: location.href,
      title: document.title,
      meta: {
        candidateFound: Boolean(candidate),
        placeholder,
        latestAssistantPreview: preview(domText),
        fallbackPreview: preview(fallbackText),
        runStateFound: Boolean(runState)
      }
    };

    if (runId) {
      saveRunState(runId, {
        ...(runState || {}),
        runId,
        provider: PROVIDER,
        beforeAssistantCount,
        lastReadAt: new Date().toISOString(),
        lastStatus: status,
        lastTextLength: normalizedText.length,
        lastText: normalizedText,
        lastChangedAt: stability.lastChangedAt
      });
    }

    return result;
  }

  function classifyReadStatus(snapshot) {
    if (!snapshot.text || snapshot.placeholder) {
      return "waiting";
    }
    if (snapshot.generating) {
      return "streaming";
    }
    if (snapshot.hasResponseActions || snapshot.stable) {
      return "complete";
    }
    return "streaming";
  }

  function chooseBestText(domText, fallbackText, prompt) {
    const dom = normalizeText(domText);
    const fallback = normalizeText(fallbackText);
    if (isPromptEcho(dom, prompt)) {
      return fallback;
    }
    if (!dom) {
      return fallback;
    }
    return dom;
  }

  function selectAssistantForRun(messages, beforeAssistantCount) {
    if (!messages.length) {
      return null;
    }
    if (Number.isFinite(beforeAssistantCount) && beforeAssistantCount >= 0) {
      const laterMessages = messages.slice(beforeAssistantCount);
      return laterMessages[laterMessages.length - 1] || null;
    }
    return messages[messages.length - 1] || null;
  }

  async function waitForPromptInput(timeoutMs) {
    try {
      return await waitFor(() => findPromptInput(), timeoutMs, 250);
    } catch (error) {
      throw new Error(`Could not find Grok prompt input. The page may need login, verification, or a selector update. URL: ${location.href}; title: ${document.title}`);
    }
  }

  function findPromptInput() {
    const candidates = [];
    for (const selector of INPUT_SELECTORS) {
      const nodes = safeQuerySelectorAll(selector);
      for (const node of nodes) {
        if (isEditablePrompt(node)) {
          candidates.push(node);
        }
      }
    }

    const unique = Array.from(new Set(candidates));
    unique.sort((a, b) => promptInputScore(b) - promptInputScore(a));
    return unique[0] || null;
  }

  function promptInputScore(node) {
    let score = 0;
    const rect = node.getBoundingClientRect();
    const placeholder = (node.getAttribute("placeholder") || "").toLowerCase();
    const label = (node.getAttribute("aria-label") || "").toLowerCase();
    const role = (node.getAttribute("role") || "").toLowerCase();

    if (placeholder.includes("ask") || label.includes("ask")) {
      score += 100;
    }
    if (role === "textbox") {
      score += 50;
    }
    if (node.closest("form")) {
      score += 60;
    }
    if (node.closest("[data-testid='chat-input']")) {
      score += 220;
    }
    if (node.matches(".ProseMirror, .tiptap") || node.classList.contains("ProseMirror") || node.classList.contains("tiptap")) {
      score += 160;
    }
    if (node.closest(".query-bar")) {
      score += 120;
    }
    if (node.closest("main")) {
      score += 20;
    }
    if (node.closest("nav, aside, header, [role='dialog']")) {
      score -= 70;
    }
    if (node.closest("[data-testid*='message' i], article")) {
      score -= 100;
    }

    score += Math.max(0, rect.top);
    return score;
  }

  function isEditablePrompt(node) {
    if (!node || !isVisible(node)) {
      return false;
    }
    if (node instanceof HTMLTextAreaElement) {
      return !node.disabled && !node.readOnly;
    }
    return node.isContentEditable || node.getAttribute("role") === "textbox";
  }

  async function setPromptText(input, text) {
    input.scrollIntoView({ block: "center", inline: "nearest" });
    input.focus();
    await delay(150);

    if (input instanceof HTMLTextAreaElement) {
      setNativeTextareaValue(input, text);
    } else {
      await setContentEditableValue(input, text);
    }

    await delay(300);
    const currentText = getEditorText(input);
    const needle = text.slice(0, Math.min(40, text.length));
    if (!normalizeText(currentText).includes(normalizeText(needle))) {
      throw new Error(`Prompt text was not accepted by the Grok composer. Composer text: "${preview(currentText)}"`);
    }
  }

  function setNativeTextareaValue(textarea, text) {
    textarea.focus();
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    if (valueSetter) {
      valueSetter.call(textarea, text);
    } else {
      textarea.value = text;
    }
    fireInputEvents(textarea, text, "insertText");
  }

  async function setContentEditableValue(editor, text) {
    if (await tryPasteInsert(editor, text)) {
      return;
    }
    if (await tryBeforeInputInsert(editor, text)) {
      return;
    }
    if (await tryExecCommandInsert(editor, text)) {
      return;
    }

    await activateEditor(editor);
    setContentEditableDomValue(editor, text);
    fireInputEvents(editor, text, "insertText");
    if (await waitForEditorText(editor, text, 1000)) {
      return;
    }

    throw new Error(`Prompt text was not accepted by the Grok Tiptap editor. Composer text: "${preview(getEditorText(editor))}"`);
  }

  async function activateEditor(editor) {
    editor.scrollIntoView({ block: "center", inline: "nearest" });
    dispatchPointerClick(editor);
    editor.focus({ preventScroll: true });
    selectEditorContents(editor);
    await delay(100);
  }

  async function tryPasteInsert(editor, text) {
    await activateEditor(editor);
    try {
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", text);
      clipboardData.setData("text/html", textToHtml(text));
      editor.dispatchEvent(createClipboardEvent("paste", clipboardData));
      await delay(250);
      if (await waitForEditorText(editor, text, 750)) {
        fireInputEvents(editor, text, "insertFromPaste", clipboardData);
        return true;
      }
    } catch (error) {
      // Continue to the next insertion strategy.
    }
    return false;
  }

  async function tryBeforeInputInsert(editor, text) {
    await activateEditor(editor);
    try {
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", text);
      clipboardData.setData("text/html", textToHtml(text));
      const beforeInput = createInputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        composed: true,
        inputType: "insertFromPaste",
        data: text,
        dataTransfer: clipboardData
      });
      const defaultNotPrevented = editor.dispatchEvent(beforeInput);
      await delay(100);

      if (await waitForEditorText(editor, text, 500)) {
        return true;
      }

      if (defaultNotPrevented) {
        setContentEditableDomValue(editor, text);
        fireInputEvents(editor, text, "insertFromPaste", clipboardData);
      }

      return await waitForEditorText(editor, text, 750);
    } catch (error) {
      return false;
    }
  }

  async function tryExecCommandInsert(editor, text) {
    await activateEditor(editor);
    try {
      const inserted = document.execCommand("insertText", false, text);
      await delay(250);
      if (inserted && await waitForEditorText(editor, text, 750)) {
        return true;
      }
    } catch (error) {
      // Continue to fallback.
    }
    return false;
  }

  function createClipboardEvent(type, clipboardData) {
    let event;
    try {
      event = new ClipboardEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        clipboardData
      });
    } catch (error) {
      event = new Event(type, {
        bubbles: true,
        cancelable: true,
        composed: true
      });
    }

    if (!event.clipboardData) {
      try {
        Object.defineProperty(event, "clipboardData", {
          configurable: true,
          enumerable: true,
          value: clipboardData
        });
      } catch (error) {
        // Best effort; some browsers expose clipboardData as read-only.
      }
    }
    return event;
  }

  function createInputEvent(type, init) {
    try {
      return new InputEvent(type, init);
    } catch (error) {
      const event = new Event(type, init);
      for (const [key, value] of Object.entries(init)) {
        if (key === "bubbles" || key === "cancelable" || key === "composed") {
          continue;
        }
        try {
          Object.defineProperty(event, key, {
            configurable: true,
            enumerable: true,
            value
          });
        } catch (defineError) {
          // Best effort.
        }
      }
      return event;
    }
  }

  function selectEditorContents(editor) {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function fireInputEvents(target, text, inputType, dataTransfer) {
    target.dispatchEvent(createInputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      composed: true,
      inputType,
      data: text,
      dataTransfer
    }));
    target.dispatchEvent(createInputEvent("input", {
      bubbles: true,
      cancelable: false,
      composed: true,
      inputType,
      data: text,
      dataTransfer
    }));
    target.dispatchEvent(new Event("change", { bubbles: true }));
    document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
  }

  function setContentEditableDomValue(editor, text) {
    editor.replaceChildren(...textToParagraphNodes(text));
    editor.querySelectorAll(".is-empty, .is-editor-empty").forEach((node) => {
      node.classList.remove("is-empty", "is-editor-empty");
    });
  }

  function textToParagraphNodes(text) {
    return text.split("\n").map((line) => {
      const paragraph = document.createElement("p");
      paragraph.textContent = line || "\u00a0";
      return paragraph;
    });
  }

  function textToHtml(text) {
    return text.split("\n")
      .map((line) => `<p>${escapeHtml(line) || "<br>"}</p>`)
      .join("");
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  async function waitForEditorText(editor, text, timeoutMs) {
    const normalized = normalizeText(text);
    const needle = normalized.slice(0, Math.min(40, normalized.length));
    if (!needle) {
      return true;
    }

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (normalizeText(getEditorText(editor)).includes(needle)) {
        return true;
      }
      await delay(100);
    }
    return false;
  }

  async function waitForSendButtonReady(input, timeoutMs) {
    try {
      return await waitFor(() => {
        const button = findSendButton(input);
        if (button && !isDisabled(button)) {
          return button;
        }
        return null;
      }, timeoutMs, 200);
    } catch (error) {
      const button = findSendButton(input);
      const reason = button ? `button label="${buttonLabel(button)}" disabled=${isDisabled(button)}` : "no button candidate";
      throw new Error(`Could not find an enabled Grok send button after text input (${reason}).`);
    }
  }

  function findSendButton(input) {
    const roots = [
      input.closest("form"),
      input.closest("[role='textbox']")?.parentElement,
      input.parentElement,
      input.closest("main"),
      document
    ].filter(Boolean);

    for (const root of roots) {
      const exact = root.querySelector([
        "button[aria-label*='Send' i]",
        "button[aria-label*='Submit' i]",
        "button[data-testid*='send' i]",
        "button[type='submit']"
      ].join(","));
      if (exact && isVisible(exact)) {
        return exact;
      }
    }

    const buttons = Array.from(document.querySelectorAll("button")).filter(isVisible);
    return buttons.find((button) => /\b(send|submit)\b/.test(buttonLabel(button))) || null;
  }

  function clickSendButton(button) {
    if (!button || isDisabled(button)) {
      throw new Error("Refusing to click missing or disabled Grok send button.");
    }
    dispatchPointerClick(button);
  }

  async function waitForPromptSubmitted(input, prompt, beforeBodyText, timeoutMs) {
    const promptNeedle = normalizeText(prompt).slice(0, Math.min(60, normalizeText(prompt).length));
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const composerText = normalizeText(getEditorText(input));
      const bodyText = normalizeText(document.body?.innerText || "");

      if (composerText.length === 0 && bodyText !== beforeBodyText) {
        return;
      }
      if (promptNeedle && bodyText.includes(promptNeedle) && bodyText !== beforeBodyText) {
        return;
      }
      if (isGenerating() && composerText.length === 0) {
        return;
      }

      await delay(400);
    }

    throw new Error(`Prompt did not appear to submit to Grok. Composer still contains: "${preview(getEditorText(input))}"`);
  }

  function getAssistantMessages() {
    const nodes = [];
    for (const selector of ASSISTANT_SELECTORS) {
      nodes.push(...safeQuerySelectorAll(selector));
    }

    const unique = [];
    const seen = new Set();
    for (const node of nodes) {
      const container = messageContainer(node);
      const text = extractMessageText(container);
      if (seen.has(container) || !text || isLikelyUiContainer(container, text)) {
        continue;
      }

      const childIndex = unique.findIndex((item) => container.contains(item));
      if (childIndex >= 0) {
        seen.delete(unique[childIndex]);
        unique.splice(childIndex, 1, container);
        seen.add(container);
        continue;
      }

      if (unique.some((item) => item.contains(container))) {
        continue;
      }

      unique.push(container);
      seen.add(container);
    }

    unique.sort(compareDocumentOrder);
    return unique;
  }

  function messageContainer(node) {
    if (!node) {
      return null;
    }
    return (
      node.closest("[data-testid='assistant-message']") ||
      node.closest("[data-testid*='assistant' i]") ||
      node.closest("article") ||
      node.closest("[role='article']") ||
      node
    );
  }

  function responseContainer(node) {
    if (!node) {
      return null;
    }
    return node.closest("[id^='response-']") || messageContainer(node) || node;
  }

  function extractMessageText(node) {
    if (!node) {
      return "";
    }

    const clone = node.cloneNode(true);
    clone.querySelectorAll([
      ".thinking-container",
      ".action-buttons",
      ".inline-media-container",
      "button",
      "svg",
      "style",
      "script",
      "noscript",
      "textarea",
      "[contenteditable='true']",
      "[aria-hidden='true']",
      "[data-testid*='copy' i]",
      "[data-testid*='feedback' i]"
    ].join(",")).forEach((child) => child.remove());

    const contentNodes = [];
    if (clone.matches?.(".response-content-markdown")) {
      contentNodes.push(clone);
    }
    contentNodes.push(...Array.from(clone.querySelectorAll(".response-content-markdown")));

    const text = contentNodes.length > 0
      ? contentNodes.map((child) => child.innerText || child.textContent || "").join("\n")
      : clone.innerText || clone.textContent || "";

    return stripUiLines(normalizeText(text));
  }

  function stripUiLines(text) {
    return String(text || "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !isUiLine(line))
      .join("\n")
      .trim();
  }

  function extractBodyAnswerFallback(prompt) {
    const promptNeedle = normalizeText(prompt).slice(0, Math.min(80, normalizeText(prompt).length));
    if (!promptNeedle) {
      return "";
    }

    const bodyText = normalizeText(document.body?.innerText || document.body?.textContent || "");
    if (!bodyText) {
      return "";
    }

    const lines = bodyText.split("\n").map((line) => line.trim()).filter(Boolean);
    let promptIndex = -1;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = normalizeText(lines[index]);
      if (line.includes(promptNeedle) || promptNeedle.includes(line)) {
        promptIndex = index;
        break;
      }
    }

    if (promptIndex < 0) {
      return "";
    }

    const answerLines = [];
    for (const line of lines.slice(promptIndex + 1)) {
      if (isBodyFallbackStopLine(line)) {
        break;
      }
      if (isUiLine(line)) {
        continue;
      }
      answerLines.push(line);
    }

    return normalizeText(answerLines.join("\n"));
  }

  function isBodyFallbackStopLine(line) {
    return /^(Ask Grok|Ask anything|Message Grok|New chat|Upgrade|Try Grok|Sign in|Log in)$/i.test(line);
  }

  function isUiLine(line) {
    return /^(Grok|xAI|Search|Share|Copy|Copied|Retry|Regenerate|More|Sources|Attach|Upload|Voice|Send|Stop|Thinking|DeepSearch|Think)$/i.test(line);
  }

  function isLikelyUiContainer(node, text) {
    if (!node || !isVisible(node)) {
      return true;
    }
    if (node.matches?.("[data-testid='assistant-message']") || node.closest("[data-testid='assistant-message']")) {
      return false;
    }
    if (node.closest("nav, aside, header, footer")) {
      return true;
    }
    const normalized = normalizeText(text);
    return normalized.length < 2 || isUiLine(normalized);
  }

  function findCopyButton(node) {
    const root = responseContainer(node) || node;
    const actionRoots = Array.from(root.querySelectorAll(".action-buttons, [class*='action-buttons']"));
    const roots = actionRoots.length > 0 ? actionRoots : [root];
    const buttons = roots.flatMap((item) => Array.from(item.querySelectorAll("button")).filter(isVisible));
    return buttons.find((button) => /\bcopy\b/.test(buttonLabel(button)) && !isDisabled(button)) || null;
  }

  async function readCopyButtonText(node) {
    const button = findCopyButton(node);
    if (!button || isDisabled(button)) {
      return "";
    }

    const capture = installClipboardCapture();
    try {
      dispatchPointerClick(button);
      await capture.waitForText(2500);
      return normalizeText(capture.text());
    } catch (error) {
      return "";
    } finally {
      capture.restore();
    }
  }

  function installClipboardCapture() {
    let capturedText = "";
    const restorers = [];

    const clipboard = navigator.clipboard;
    if (clipboard) {
      const writeTextRestore = patchClipboardMethod(clipboard, "writeText", (text) => {
        capturedText = String(text || "");
        return Promise.resolve();
      });
      if (writeTextRestore) {
        restorers.push(writeTextRestore);
      }
    }

    const onCopy = (event) => {
      const data = event.clipboardData;
      if (!data) {
        return;
      }
      const text = data.getData("text/plain") || data.getData("text");
      if (text) {
        capturedText = text;
      }
    };
    document.addEventListener("copy", onCopy, false);
    restorers.push(() => document.removeEventListener("copy", onCopy, false));

    return {
      text: () => capturedText,
      waitForText: async (timeoutMs) => {
        const startedAt = Date.now();
        while (Date.now() - startedAt < timeoutMs) {
          if (normalizeText(capturedText)) {
            return capturedText;
          }
          await delay(100);
        }
        return capturedText;
      },
      restore: () => {
        while (restorers.length > 0) {
          const restore = restorers.pop();
          try {
            restore();
          } catch (error) {
            // Best effort restore.
          }
        }
      }
    };
  }

  function patchClipboardMethod(clipboard, methodName, replacement) {
    if (typeof clipboard[methodName] !== "function") {
      return null;
    }

    const original = clipboard[methodName];
    try {
      clipboard[methodName] = replacement;
      if (clipboard[methodName] === replacement) {
        return () => {
          clipboard[methodName] = original;
        };
      }
    } catch (error) {
      // Try defineProperty below.
    }

    try {
      const descriptor = Object.getOwnPropertyDescriptor(clipboard, methodName);
      Object.defineProperty(clipboard, methodName, {
        configurable: true,
        writable: true,
        value: replacement
      });
      return () => {
        if (descriptor) {
          Object.defineProperty(clipboard, methodName, descriptor);
        } else {
          delete clipboard[methodName];
        }
      };
    } catch (error) {
      return null;
    }
  }

  function isGenerating() {
    if (document.querySelector("[aria-busy='true'], [data-streaming='true'], [data-is-streaming='true']")) {
      return true;
    }

    const buttons = Array.from(document.querySelectorAll("button")).filter(isVisible);
    return buttons.some((button) => {
      const label = buttonLabel(button);
      return /\b(stop|cancel|interrupt|abort)\b/.test(label);
    });
  }

  function isPlaceholderText(text) {
    const normalized = normalizeText(text).toLowerCase();
    return normalized === "thinking" || normalized === "thinking..." || normalized === "...";
  }

  function isPromptEcho(text, prompt) {
    const normalizedText = normalizeText(text);
    const normalizedPrompt = normalizeText(prompt);
    if (!normalizedText || !normalizedPrompt) {
      return false;
    }
    if (normalizedText === normalizedPrompt) {
      return true;
    }
    return normalizedText.length <= normalizedPrompt.length + 20 && normalizedText.includes(normalizedPrompt.slice(0, Math.min(80, normalizedPrompt.length)));
  }

  function updateRunReadStability(runId, runState, text) {
    const now = Date.now();
    const previousText = runState?.lastText || "";
    const previousChangedAt = Number(runState?.lastChangedAt || 0);
    const changed = text !== previousText;
    const lastChangedAt = changed || !previousChangedAt ? now : previousChangedAt;
    if (runId) {
      saveRunState(runId, {
        ...(runState || {}),
        runId,
        provider: PROVIDER,
        lastText: text,
        lastChangedAt
      });
    }
    return {
      lastChangedAt,
      stableMs: now - lastChangedAt
    };
  }

  function saveRunState(runId, state) {
    if (!runId) {
      return;
    }
    const store = getRunStore();
    store[runId] = state;
    store.__lastRunId = runId;
  }

  function getRunState(runId) {
    if (!runId) {
      return null;
    }
    return getRunStore()[runId] || null;
  }

  function getLastRunId() {
    return getRunStore().__lastRunId || "";
  }

  function getRunStore() {
    if (!window.__webAiBridgeGrokRuns || typeof window.__webAiBridgeGrokRuns !== "object") {
      window.__webAiBridgeGrokRuns = {};
    }
    return window.__webAiBridgeGrokRuns;
  }

  function firstFiniteNumber(...values) {
    for (const value of values) {
      const number = Number(value);
      if (Number.isFinite(number)) {
        return number;
      }
    }
    return -1;
  }

  function dispatchPointerClick(button) {
    button.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, view: window }));
    button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
    button.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
    button.click();
  }

  function buttonLabel(button) {
    return [
      button.getAttribute("aria-label"),
      button.getAttribute("title"),
      button.getAttribute("data-testid"),
      button.textContent
    ].filter(Boolean).join(" ").toLowerCase();
  }

  function isDisabled(node) {
    return Boolean(
      node.disabled ||
      node.getAttribute("disabled") !== null ||
      node.getAttribute("aria-disabled") === "true"
    );
  }

  function getEditorText(input) {
    if (input instanceof HTMLTextAreaElement) {
      return input.value || "";
    }
    return input.innerText || input.textContent || "";
  }

  function safeQuerySelectorAll(selector) {
    try {
      return Array.from(document.querySelectorAll(selector));
    } catch (error) {
      return [];
    }
  }

  function compareDocumentOrder(a, b) {
    if (a === b) {
      return 0;
    }
    const position = a.compareDocumentPosition(b);
    if (position & Node.DOCUMENT_POSITION_FOLLOWING) {
      return -1;
    }
    if (position & Node.DOCUMENT_POSITION_PRECEDING) {
      return 1;
    }
    return 0;
  }

  function isVisible(node) {
    if (!node || !(node instanceof Element)) {
      return false;
    }
    const rect = node.getBoundingClientRect();
    const style = window.getComputedStyle(node);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.visibility !== "hidden" &&
      style.display !== "none" &&
      Number(style.opacity) !== 0
    );
  }

  function normalizeText(text) {
    return String(text || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function waitFor(fn, timeoutMs, intervalMs) {
    const start = Date.now();
    return new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        const value = fn();
        if (value) {
          clearInterval(timer);
          resolve(value);
          return;
        }

        if (Date.now() - start >= timeoutMs) {
          clearInterval(timer);
          reject(new Error("Timed out waiting for condition."));
        }
      }, intervalMs);
    });
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

  function preview(value, maxLength = 160) {
    const text = normalizeText(value).replace(/\s+/g, " ");
    if (text.length <= maxLength) {
      return text;
    }
    return `${text.slice(0, maxLength - 1)}...`;
  }

  function postResult(requestId, ok, result, error) {
    window.postMessage({
      source: PAGE_SOURCE,
      provider: PROVIDER,
      requestId,
      ok,
      result,
      error
    }, window.location.origin);
  }

  function postReady() {
    window.postMessage({
      source: PAGE_SOURCE,
      provider: PROVIDER,
      type: "PAGE_READY"
    }, window.location.origin);
  }

  function serializeError(error) {
    return {
      message: error && error.message ? error.message : String(error),
      name: error && error.name ? error.name : "Error",
      stack: error && error.stack ? error.stack : undefined
    };
  }
})();
