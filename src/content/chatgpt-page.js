"use strict";

(() => {
  if (window.__webAiBridgeChatGPTPageReady) {
    return;
  }
  window.__webAiBridgeChatGPTPageReady = true;

  const PROVIDER = "chatgpt";
  const CONTENT_SOURCE = "web-ai-bridge-content";
  const PAGE_SOURCE = "web-ai-bridge-page";

  const INPUT_SELECTORS = [
    "form #prompt-textarea",
    "form [data-testid='prompt-textarea']",
    "form div[contenteditable='true'][id='prompt-textarea']",
    "form div[contenteditable='true'][data-lexical-editor='true']",
    "form div[contenteditable='true'][role='textbox']",
    "form textarea",
    "[data-testid='composer'] [contenteditable='true']",
    "[data-testid='composer'] textarea",
    "#prompt-textarea",
    "[data-testid='prompt-textarea']",
    "main form div[contenteditable='true']",
    "main form textarea",
    "div[contenteditable='true'][role='textbox']",
    "div[contenteditable='true']",
    "textarea"
  ];

  const ASSISTANT_SELECTORS = [
    "section[data-turn='assistant'][data-testid^='conversation-turn-']",
    "[data-testid^='conversation-turn-'][data-turn='assistant']",
    "[data-message-author-role='assistant']",
    "[data-testid^='conversation-turn-'] [data-message-author-role='assistant']",
    "main div.markdown.prose",
    "main div.markdown"
  ];

  const USER_SELECTORS = [
    "[data-message-author-role='user']",
    "[data-testid^='conversation-turn-'] [data-message-author-role='user']"
  ];

  window.addEventListener("message", (event) => {
    if (
      event.source !== window ||
      !event.data ||
      event.data.source !== CONTENT_SOURCE
    ) {
      return;
    }

    if (event.data.type === "PING_PAGE") {
      postReady();
      return;
    }

    if (event.data.type === "SEND_WEB_PROMPT") {
      sendChatGPT(event.data.prompt, event.data.options || {})
        .then((result) => postResult(event.data.requestId, true, result))
        .catch((error) => postResult(event.data.requestId, false, null, serializeError(error)));
      return;
    }

    if (event.data.type === "READ_WEB_RESULT") {
      readChatGPTResult(event.data.options || {})
        .then((result) => postResult(event.data.requestId, true, result))
        .catch((error) => postResult(event.data.requestId, false, null, serializeError(error)));
    }
  });

  postReady();

  async function sendChatGPT(prompt, options) {
    const cleanPrompt = String(prompt || "").trim();
    if (!cleanPrompt) {
      throw new Error("Prompt is empty.");
    }

    const runId = String(options.runId || crypto.randomUUID());
    const inputTimeoutMs = clampNumber(options.inputTimeoutMs, 10000, 180000, 60000);
    const startedAt = Date.now();

    const beforeAssistantMessages = getAssistantMessages();
    const beforeUserMessages = getUserMessages().map(extractMessageText).filter(Boolean);
    const input = await waitForPromptInput(inputTimeoutMs);

    await setPromptText(input, cleanPrompt);
    await submitPrompt(input, cleanPrompt);

    await waitForPromptSubmitted(input, cleanPrompt, beforeUserMessages, 20000);

    const sentAt = new Date().toISOString();
    const runState = {
      runId,
      promptPreview: preview(cleanPrompt),
      beforeAssistantCount: beforeAssistantMessages.length,
      beforeUserCount: beforeUserMessages.length,
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
      beforeUserCount: runState.beforeUserCount,
      sentAt,
      url: location.href,
      title: document.title,
      meta: {
        elapsedMs: Date.now() - startedAt,
        promptPreview: runState.promptPreview
      }
    };
  }

  async function readChatGPTResult(options) {
    const runId = String(options.runId || options.run?.id || getLastRunId() || "").trim();
    const runState = getRunState(runId);
    const beforeAssistantCount = firstFiniteNumber(
      options.beforeAssistantCount,
      options.run?.sendResult?.meta?.beforeAssistantCount,
      options.run?.sendResult?.beforeAssistantCount,
      runState?.beforeAssistantCount,
      -1
    );
    const useCopyButton = Boolean(options.useCopyButton);
    const stableMs = clampNumber(options.stableMs, 1000, 15000, 3000);
    const assistantMessages = getAssistantMessages();
    const candidate = selectAssistantForRun(assistantMessages, beforeAssistantCount);
    const domText = candidate ? extractMessageText(candidate) : "";
    const fallbackText = candidate ? "" : extractBodyAnswerFallback(options, runState);
    const hasResponseActions = candidate ? hasAssistantCompletionMarker(candidate) : false;
    const generating = isGenerating();
    let text = domText || fallbackText;
    let extractionMethod = "dom";

    if (!domText && fallbackText) {
      extractionMethod = "body-fallback";
    }

    if (useCopyButton && candidate && hasResponseActions && !generating) {
      const copiedText = await readAssistantCopyButtonText(candidate);
      if (copiedText && copiedText.length >= domText.length) {
        text = copiedText;
        extractionMethod = "copy-button";
      }
    }

    const normalizedText = normalizeText(text);
    const placeholder = isPlaceholderAssistantText(normalizedText);
    const stability = updateRunReadStability(runId, runState, normalizedText);
    const status = classifyReadStatus({
      text: normalizedText,
      placeholder,
      hasCandidate: Boolean(candidate),
      hasResponseActions,
      generating,
      fallbackText: Boolean(!candidate && fallbackText),
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
      lowConfidence: status === "complete" && isLowConfidenceText(normalizedText),
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
        assistantCount: assistantMessages.length,
        runStateFound: Boolean(runState)
      }
    };

    if (runId) {
      saveRunState(runId, {
        ...(runState || {}),
        runId,
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

  function selectAssistantForRun(assistantMessages, beforeAssistantCount) {
    if (!assistantMessages.length) {
      return null;
    }

    if (Number.isFinite(beforeAssistantCount) && beforeAssistantCount >= 0) {
      const laterMessages = assistantMessages.slice(beforeAssistantCount);
      return laterMessages[laterMessages.length - 1] || null;
    }

    return assistantMessages[assistantMessages.length - 1] || null;
  }

  function classifyReadStatus(snapshot) {
    if (!snapshot.hasCandidate || !snapshot.text || snapshot.placeholder) {
      if (!snapshot.fallbackText || !snapshot.text || snapshot.placeholder) {
        return "waiting";
      }
      if (snapshot.generating || !snapshot.stable) {
        return "streaming";
      }
      return "complete";
    }
    if (snapshot.generating || !snapshot.hasResponseActions) {
      return "streaming";
    }
    return "complete";
  }

  function extractBodyAnswerFallback(options, runState) {
    const prompt = normalizeText(options.run?.prompt || runState?.promptPreview || "");
    if (!prompt) {
      return "";
    }

    const bodyText = normalizeText(document.body?.innerText || document.body?.textContent || "");
    if (!bodyText) {
      return "";
    }

    const lines = bodyText.split("\n").map((line) => line.trim()).filter(Boolean);
    const promptNeedle = prompt.slice(0, Math.min(80, prompt.length));
    let promptIndex = -1;

    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = normalizeText(lines[index]);
      if (line.includes(promptNeedle) || prompt.includes(line)) {
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
      if (isBodyFallbackUiLine(line)) {
        continue;
      }
      answerLines.push(line);
    }

    return normalizeText(answerLines.join("\n"));
  }

  function isBodyFallbackStopLine(line) {
    return /^(Ask anything|Message ChatGPT|ChatGPT can make mistakes\.? Check important info\.?|Extended|Search chats|New chat)$/i.test(line);
  }

  function isBodyFallbackUiLine(line) {
    return /^(ChatGPT|Share|Sources|Thought for \d+s|Copy|Retry|More actions|\.\.\.)$/i.test(line);
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
        lastText: text,
        lastChangedAt
      });
    }
    return {
      lastChangedAt,
      stableMs: now - lastChangedAt
    };
  }

  function isLowConfidenceText(text) {
    const normalized = normalizeText(text);
    return normalized.length < 20 || isPlaceholderAssistantText(normalized) || isLikelyCitationOnlyText(normalized);
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
    if (!window.__chatgptBackgroundRunnerRuns || typeof window.__chatgptBackgroundRunnerRuns !== "object") {
      window.__chatgptBackgroundRunnerRuns = {};
    }
    return window.__chatgptBackgroundRunnerRuns;
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

  async function waitForPromptInput(timeoutMs) {
    try {
      return await waitFor(() => findPromptInput(), timeoutMs, 250);
    } catch (error) {
      throw new Error(`Could not find ChatGPT prompt input. The page may need login, verification, or a UI selector update. URL: ${location.href}; title: ${document.title}`);
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
    const id = (node.id || "").toLowerCase();
    const testId = (node.getAttribute("data-testid") || "").toLowerCase();
    const role = (node.getAttribute("role") || "").toLowerCase();

    if (id === "prompt-textarea") {
      score += 100;
    }
    if (testId.includes("prompt")) {
      score += 80;
    }
    if (role === "textbox") {
      score += 30;
    }
    if (node.closest("form")) {
      score += 60;
    }
    if (node.closest("[data-testid='composer']")) {
      score += 50;
    }
    if (node.closest("[data-message-author-role]")) {
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

    return node.isContentEditable;
  }

  async function setPromptText(input, text) {
    input.scrollIntoView({ block: "center", inline: "nearest" });
    input.focus();
    await delay(150);

    if (input instanceof HTMLTextAreaElement) {
      setNativeTextareaValue(input, text);
    } else {
      setContentEditableValue(input, text);
    }

    await delay(300);

    const currentText = getEditorText(input);
    const needle = text.slice(0, Math.min(40, text.length));
    if (!currentText.includes(needle)) {
      throw new Error(`Prompt text was not accepted by the ChatGPT composer. Composer text: "${preview(currentText)}"`);
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

  function setContentEditableValue(editor, text) {
    editor.focus();
    selectEditorContents(editor);

    let inserted = dispatchPaste(editor, text);
    if (inserted && getEditorText(editor).includes(text.slice(0, Math.min(40, text.length)))) {
      return;
    }

    selectEditorContents(editor);
    inserted = false;
    try {
      inserted = document.execCommand("insertText", false, text);
    } catch (error) {
      inserted = false;
    }

    if (!inserted || !getEditorText(editor).includes(text.slice(0, Math.min(40, text.length)))) {
      editor.replaceChildren(...textToParagraphNodes(text));
    }

    fireInputEvents(editor, text, "insertText");
  }

  function dispatchPaste(editor, text) {
    try {
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", text);
      const pasteEvent = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData
      });
      editor.dispatchEvent(pasteEvent);
      fireInputEvents(editor, text, "insertFromPaste");
      return true;
    } catch (error) {
      return false;
    }
  }

  function selectEditorContents(editor) {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function fireInputEvents(target, text, inputType) {
    target.dispatchEvent(new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType,
      data: text
    }));
    target.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType,
      data: text
    }));
    target.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function textToParagraphNodes(text) {
    const fragmentNodes = [];
    const lines = text.split("\n");
    for (const line of lines) {
      const paragraph = document.createElement("p");
      paragraph.textContent = line || "\u00a0";
      fragmentNodes.push(paragraph);
    }
    return fragmentNodes;
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
      throw new Error(`Could not find an enabled ChatGPT send button after text input (${reason}).`);
    }
  }

  async function submitPrompt(input, prompt) {
    const button = await waitForOptionalSendButtonReady(input, 5000);
    if (button) {
      clickSendButton(button);
      return;
    }

    dispatchEnterSubmit(input);
    await delay(500);
    if (normalizeText(getEditorText(input)).length === 0 || isGenerating()) {
      return;
    }

    const form = input.closest("form");
    if (form && typeof form.requestSubmit === "function") {
      try {
        form.requestSubmit();
      } catch (error) {
        dispatchSubmitEvent(form);
      }
    } else if (form) {
      dispatchSubmitEvent(form);
    }

    await delay(500);
    if (normalizeText(getEditorText(input)).length === 0 || isGenerating()) {
      return;
    }

    const lateButton = await waitForOptionalSendButtonReady(input, 2000);
    if (lateButton) {
      clickSendButton(lateButton);
      return;
    }

    throw new Error(`Could not submit ChatGPT prompt after text input. Composer still contains: "${preview(getEditorText(input))}"`);
  }

  async function waitForOptionalSendButtonReady(input, timeoutMs) {
    try {
      return await waitFor(() => {
        const button = findSendButton(input);
        if (button && !isDisabled(button)) {
          return button;
        }
        return null;
      }, timeoutMs, 200);
    } catch (error) {
      return null;
    }
  }

  function clickSendButton(button) {
    if (!button || isDisabled(button)) {
      throw new Error("Refusing to click missing or disabled ChatGPT send button.");
    }

    button.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, view: window }));
    button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
    button.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
    button.click();
  }

  function dispatchEnterSubmit(input) {
    input.focus();
    const events = [
      new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
        composed: true
      }),
      new KeyboardEvent("keypress", {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
        composed: true
      }),
      new KeyboardEvent("keyup", {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
        composed: true
      })
    ];

    for (const event of events) {
      input.dispatchEvent(event);
    }
  }

  function dispatchSubmitEvent(form) {
    const submitter = findSendButton(form);
    const init = {
      bubbles: true,
      cancelable: true
    };
    if (submitter) {
      init.submitter = submitter;
    }

    const event = typeof SubmitEvent === "function"
      ? new SubmitEvent("submit", init)
      : new Event("submit", init);
    form.dispatchEvent(event);
  }

  async function waitForPromptSubmitted(input, prompt, beforeUserMessages, timeoutMs) {
    const beforeCount = beforeUserMessages.length;
    const promptNeedle = normalizeText(prompt).slice(0, Math.min(60, normalizeText(prompt).length));
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const userMessages = getUserMessages();
      const latestUser = userMessages[userMessages.length - 1] || null;
      const latestText = latestUser ? extractMessageText(latestUser) : "";
      const composerText = normalizeText(getEditorText(input));

      if (userMessages.length > beforeCount && (!promptNeedle || latestText.includes(promptNeedle))) {
        return;
      }

      if (userMessages.length > beforeCount && composerText.length === 0) {
        return;
      }

      if (isGenerating() && composerText.length === 0) {
        return;
      }

      await delay(400);
    }

    throw new Error(`Prompt did not appear in the conversation after clicking send. Composer still contains: "${preview(getEditorText(input))}"`);
  }

  function getAssistantMessages() {
    return getRoleMessages(ASSISTANT_SELECTORS, "assistant");
  }

  function getUserMessages() {
    return getRoleMessages(USER_SELECTORS, "user");
  }

  function getRoleMessages(selectors, role) {
    const nodes = [];
    for (const selector of selectors) {
      nodes.push(...safeQuerySelectorAll(selector));
    }

    const unique = [];
    const seen = new Set();
    for (const node of nodes) {
      const container = role === "assistant"
        ? assistantTurnContainer(node)
        : (node.closest(`[data-message-author-role='${role}']`) || node);
      const text = extractMessageText(container);
      if (seen.has(container) || !text || isSidebarHistoryItem(container)) {
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

  function assistantTurnContainer(node) {
    if (!node) {
      return null;
    }
    return (
      node.closest("section[data-turn='assistant'][data-testid^='conversation-turn-']") ||
      node.closest("[data-testid^='conversation-turn-'][data-turn='assistant']") ||
      node.closest("[data-message-author-role='assistant']") ||
      node
    );
  }

  function extractMessageText(node) {
    if (!node) {
      return "";
    }

    const clone = node.cloneNode(true);
    clone.querySelectorAll([
      "button",
      "svg",
      "style",
      "script",
      "noscript",
      "[contenteditable='true']",
      "[aria-hidden='true']",
      "[data-testid*='copy']",
      "[data-testid*='feedback']",
      "[data-testid*='turn-action']",
      ".sr-only"
    ].join(",")).forEach((child) => child.remove());

    return stripMessageUiLines(normalizeText(clone.innerText || clone.textContent || ""));
  }

  function stripMessageUiLines(text) {
    return String(text || "")
      .split("\n")
      .filter((line) => !/^\s*Pasted text\s*$/i.test(line))
      .join("\n")
      .trim();
  }

  function hasAssistantCompletionMarker(node) {
    return Boolean(findAssistantCopyButton(node));
  }

  function findAssistantCopyButton(node) {
    if (!node) {
      return null;
    }

    const turn = assistantTurnContainer(node) || node.closest("[data-testid^='conversation-turn-']") || node.closest("article") || node.parentElement;
    if (!turn) {
      return null;
    }

    const actionGroups = Array.from(turn.querySelectorAll("[aria-label='Response actions'][role='group'], [aria-label='Response actions']"));
    const roots = actionGroups.length > 0 ? actionGroups : [turn];
    const buttons = roots.flatMap((root) => Array.from(root.querySelectorAll("button")));
    return buttons.find((button) => {
      const testId = (button.getAttribute("data-testid") || "").toLowerCase();
      const label = buttonLabel(button);
      return (
        (testId === "copy-turn-action-button" && !isDisabled(button)) ||
        (!isDisabled(button) && /\bcopy response\b|复制回复|复制回答|复制响应/.test(label))
      );
    }) || null;
  }

  function isAssistantTurnGenerating(node) {
    const turn = assistantTurnContainer(node);
    if (!turn) {
      return isGenerating();
    }

    if (
      turn.hasAttribute("data-stream-active") ||
      turn.querySelector("[data-stream-active], [data-is-streaming='true'], [aria-busy='true']")
    ) {
      return true;
    }

    const buttons = Array.from(turn.querySelectorAll("button")).filter(isVisible);
    return buttons.some((button) => {
      const testId = (button.getAttribute("data-testid") || "").toLowerCase();
      const label = buttonLabel(button);
      return testId === "stop-button" || /\b(stop|cancel|interrupt)\b|停止|取消|中止/.test(label);
    });
  }

  async function readAssistantCopyButtonText(node) {
    const button = findAssistantCopyButton(node);
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
    const pending = [];
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

      const writeRestore = patchClipboardMethod(clipboard, "write", (items) => {
        const pendingWrite = captureClipboardItems(items).then((text) => {
          if (text) {
            capturedText = text;
          }
        }).catch(() => {});
        pending.push(pendingWrite);
        return Promise.resolve();
      });
      if (writeRestore) {
        restorers.push(writeRestore);
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
          if (pending.length > 0) {
            await Promise.race([Promise.allSettled(pending), delay(100)]);
          } else {
            await delay(100);
          }
        }
        return capturedText;
      },
      restore: () => {
        while (restorers.length > 0) {
          const restore = restorers.pop();
          try {
            restore();
          } catch (error) {
            // Best effort restore; fall back to DOM extraction if capture failed.
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

  async function captureClipboardItems(items) {
    for (const item of Array.from(items || [])) {
      if (!item || !Array.isArray(item.types) || !item.types.includes("text/plain")) {
        continue;
      }
      const blob = await item.getType("text/plain");
      return await blob.text();
    }
    return "";
  }

  function dispatchPointerClick(button) {
    button.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, view: window }));
    button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
    button.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
    button.click();
  }

  function isPlaceholderAssistantText(text) {
    const normalized = normalizeText(text).toLowerCase();
    return (
      normalized === "thinking" ||
      normalized === "thinking..." ||
      normalized === "思考中" ||
      normalized === "思考中..." ||
      normalized === "正在思考" ||
      normalized === "正在思考..." ||
      isLikelyCitationOnlyText(normalized)
    );
  }

  function isLikelyCitationOnlyText(text) {
    if (!text || text.length > 240 || /[。！？.!?]\s/.test(text)) {
      return false;
    }

    const citationMarkers = text.match(/\+\d+/g) || [];
    if (citationMarkers.length < 2) {
      return false;
    }

    const withoutMarkers = text.replace(/\+\d+/g, " ").replace(/\s+/g, " ").trim();
    const words = withoutMarkers.split(/\s+/).filter(Boolean);
    return words.length > 0 && words.length <= 18;
  }

  function isSidebarHistoryItem(node) {
    return Boolean(node.closest("nav[aria-label='Chat history']"));
  }

  function findSendButton(input) {
    const roots = [
      input.closest("form"),
      input.closest("[data-testid='composer']"),
      input.closest("main"),
      document
    ].filter(Boolean);

    for (const root of roots) {
      const exact = root.querySelector([
        "button[data-testid='send-button']",
        "button[data-testid='composer-submit-button']",
        "button[aria-label*='Send']",
        "button[aria-label*='send']",
        "button[aria-label*='发送']",
        "button[type='submit']"
      ].join(","));
      if (exact && isVisible(exact)) {
        return exact;
      }
    }

    const buttons = Array.from(document.querySelectorAll("button")).filter(isVisible);
    return buttons.find((button) => {
      const label = buttonLabel(button);
      return /\b(send|submit)\b|发送|提交/.test(label);
    }) || null;
  }

  function isGenerating() {
    const buttons = Array.from(document.querySelectorAll("button")).filter(isVisible);
    return buttons.some((button) => {
      const testId = (button.getAttribute("data-testid") || "").toLowerCase();
      const label = buttonLabel(button);
      return testId === "stop-button" || /\b(stop|cancel|interrupt)\b|停止|取消|中止/.test(label);
    });
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
