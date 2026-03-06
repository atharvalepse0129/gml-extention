// MemoryBridge - Content Script
// Detects platform, intercepts messages, captures & injects memories

(function () {
  'use strict';

  // ─── Platform Detection ──────────────────────────────────────────────────────
  const PLATFORM = (() => {
    const h = location.hostname;
    if (h.includes('claude.ai')) return 'claude';
    if (h.includes('chatgpt.com') || h.includes('chat.openai.com')) return 'chatgpt';
    if (h.includes('gemini.google.com')) return 'gemini';
    return null;
  })();

  if (!PLATFORM) return;
  console.log(`[MemoryBridge] Loaded on ${PLATFORM}`);

  // ─── Platform Selectors ───────────────────────────────────────────────────────
  const SELECTORS = {
    claude: {
      input: '[contenteditable="true"][data-placeholder]',
      submit: 'button[aria-label="Send Message"], button[type="submit"]',
      response: '[data-testid="assistant-message"] .prose, .font-claude-message',
      conversation: 'main'
    },
    chatgpt: {
      input: '#prompt-textarea, [contenteditable="true"][data-id]',
      submit: 'button[data-testid="send-button"], button[aria-label="Send prompt"]',
      response: '[data-message-author-role="assistant"] .markdown',
      conversation: 'main'
    },
    gemini: {
      input: 'rich-textarea .ql-editor, [contenteditable="true"].input-area-container',
      submit: 'button.send-button, button[aria-label="Send message"]',
      response: '.response-content .markdown, model-response .response-text',
      conversation: 'chat-window, .conversation-container'
    }
  };

  const sel = SELECTORS[PLATFORM];
  let settings = {};
  let lastCapturedResponse = '';
  let injectionPending = false;
  let memoryBarEl = null;

  // ─── Init ─────────────────────────────────────────────────────────────────────
  async function init() {
    settings = await getSettings();
    if (!settings.autoCapture && !settings.autoInject) return;

    injectStyles();
    createMemoryBar();
    observeSubmit();
    observeResponses();
    listenForShortcuts();
  }

  function getSettings() {
    return new Promise(resolve => {
      chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, resolve);
    });
  }

  // ─── Memory Bar UI ────────────────────────────────────────────────────────────
  function createMemoryBar() {
    memoryBarEl = document.createElement('div');
    memoryBarEl.id = 'mb-bar';
    memoryBarEl.innerHTML = `
      <div id="mb-bar-inner">
        <span id="mb-icon">🧠</span>
        <span id="mb-text">MemoryBridge active</span>
        <div id="mb-actions">
          <button id="mb-search-btn" title="Search memories (Ctrl+Shift+M)">Search</button>
          <button id="mb-toggle-btn" title="Toggle injection">Inject: ON</button>
        </div>
      </div>
      <div id="mb-memories-panel" class="hidden">
        <div id="mb-memories-list"></div>
      </div>
    `;
    document.body.appendChild(memoryBarEl);

    document.getElementById('mb-search-btn').addEventListener('click', () => togglePanel());
    document.getElementById('mb-toggle-btn').addEventListener('click', toggleInjection);
  }

  function togglePanel() {
    const panel = document.getElementById('mb-memories-panel');
    panel.classList.toggle('hidden');
    if (!panel.classList.contains('hidden')) loadMemoriesPanel();
  }

  async function loadMemoriesPanel() {
    const list = document.getElementById('mb-memories-list');
    list.innerHTML = '<div class="mb-loading">Searching memories...</div>';

    // Get input text for context-aware search
    const inputEl = document.querySelector(sel.input);
    const query = inputEl?.textContent?.trim() || inputEl?.value?.trim() || '';

    let memories;
    if (query.length > 10) {
      memories = await chrome.runtime.sendMessage({ type: 'SEARCH_MEMORIES', query });
    } else {
      memories = await chrome.runtime.sendMessage({ type: 'GET_MEMORIES', limit: 10 });
      memories = memories?.memories || [];
    }

    const items = memories?.results || memories || [];
    if (!items.length) {
      list.innerHTML = '<div class="mb-empty">No memories yet. Chat to start building your memory!</div>';
      return;
    }

    list.innerHTML = items.map(m => `
      <div class="mb-memory-item" data-id="${m.id}">
        <div class="mb-memory-type">${m.type || 'note'}</div>
        <div class="mb-memory-content">${escapeHtml(m.content)}</div>
        <div class="mb-memory-meta">
          <span>${m.source_model || PLATFORM}</span>
          <span>${formatDate(m.created_at)}</span>
          <button class="mb-inject-btn" data-content="${escapeHtml(m.content)}">+ Inject</button>
        </div>
      </div>
    `).join('');

    list.querySelectorAll('.mb-inject-btn').forEach(btn => {
      btn.addEventListener('click', () => injectManual(btn.dataset.content));
    });
  }

  function toggleInjection() {
    settings.autoInject = !settings.autoInject;
    chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings });
    const btn = document.getElementById('mb-toggle-btn');
    btn.textContent = `Inject: ${settings.autoInject ? 'ON' : 'OFF'}`;
    btn.classList.toggle('off', !settings.autoInject);
    showToast(settings.autoInject ? '✅ Auto-injection enabled' : '⏸ Auto-injection paused');
  }

  // ─── Intercept Submit ─────────────────────────────────────────────────────────
  function observeSubmit() {
    // Watch for keyboard shortcut Enter
    document.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter' || e.shiftKey) return;
      const input = document.querySelector(sel.input);
      if (!input || !document.activeElement?.closest(sel.input?.split(',')[0])) return;
      const text = input.textContent?.trim() || input.value?.trim();
      if (!text || text.length < 5) return;
      await handleUserMessage(text);
    }, true);

    // Also watch submit button clicks
    document.addEventListener('click', async (e) => {
      const btn = e.target.closest(sel.submit);
      if (!btn) return;
      const input = document.querySelector(sel.input);
      const text = input?.textContent?.trim() || input?.value?.trim();
      if (!text || text.length < 5) return;
      await handleUserMessage(text);
    }, true);
  }

  async function handleUserMessage(text) {
    if (!settings.autoInject) return;
    if (injectionPending) return;

    // Search for relevant memories
    const result = await chrome.runtime.sendMessage({
      type: 'SEARCH_MEMORIES',
      query: text
    });

    const memories = result?.results || [];
    if (memories.length === 0) return;

    // Inject top memories into prompt
    const contextBlock = buildContextBlock(memories);
    await injectContext(contextBlock);
    showToast(`🧠 Injected ${memories.length} memory${memories.length > 1 ? 'ies' : ''}`);
  }

  function buildContextBlock(memories) {
    const lines = memories.map(m => `- ${m.content}`).join('\n');
    return `[MemoryBridge Context — relevant memories from previous sessions:\n${lines}\n]\n\n`;
  }

  async function injectContext(contextBlock) {
    injectionPending = true;
    const input = document.querySelector(sel.input);
    if (!input) { injectionPending = false; return; }

    const existingText = input.textContent?.trim() || input.value?.trim() || '';

    if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
      nativeSetter?.call(input, contextBlock + existingText);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    } else if (input.contentEditable === 'true') {
      // For contenteditable divs (Claude, Gemini)
      input.focus();
      const range = document.createRange();
      range.selectNodeContents(input);
      range.collapse(true);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.execCommand('insertText', false, contextBlock);
    }

    setTimeout(() => { injectionPending = false; }, 1000);
  }

  async function injectManual(content) {
    await injectContext(`[Memory: ${content}]\n\n`);
    showToast('🧠 Memory injected!');
    togglePanel();
  }

  // ─── Capture Responses ────────────────────────────────────────────────────────
  function observeResponses() {
    const observer = new MutationObserver(async () => {
      if (!settings.autoCapture) return;

      const responses = document.querySelectorAll(sel.response);
      if (!responses.length) return;

      const lastResponse = responses[responses.length - 1];
      const text = lastResponse?.textContent?.trim();

      if (!text || text === lastCapturedResponse) return;
      if (text.length < (settings.captureThreshold || 100)) return;

      // Debounce — wait for response to finish streaming
      clearTimeout(window._mbCaptureTimer);
      window._mbCaptureTimer = setTimeout(async () => {
        if (text === lastCapturedResponse) return;
        lastCapturedResponse = text;
        await captureConversationTurn(text);
      }, 3000);
    });

    // Observe the whole page
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  async function captureConversationTurn(responseText) {
    // Get the last user message for context
    const inputEl = document.querySelector(sel.input);
    const userText = inputEl?.textContent?.trim() || inputEl?.value?.trim() || '';

    const combined = userText
      ? `User: ${userText}\n\nAssistant: ${responseText}`
      : responseText;

    const result = await chrome.runtime.sendMessage({
      type: 'SAVE_MEMORY',
      payload: {
        content: combined.slice(0, 3000), // cap size
        source: location.href,
        model: PLATFORM,
        type: 'conversation',
        visibility: settings.defaultVisibility || 'private'
      }
    });

    if (result?.id) {
      updateBadge();
      showToast('💾 Memory saved', 1500);
    }
  }

  // ─── Keyboard Shortcuts ───────────────────────────────────────────────────────
  function listenForShortcuts() {
    document.addEventListener('keydown', (e) => {
      // Ctrl+Shift+M → open memory panel
      if (e.ctrlKey && e.shiftKey && e.key === 'M') {
        e.preventDefault();
        togglePanel();
      }
    });
  }

  // ─── Toast Notification ───────────────────────────────────────────────────────
  function showToast(msg, duration = 2500) {
    const existing = document.getElementById('mb-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'mb-toast';
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => toast.classList.add('show'), 10);
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  function updateBadge() {
    chrome.runtime.sendMessage({ type: 'UPDATE_BADGE' });
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────────
  function escapeHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function formatDate(iso) {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    } catch { return ''; }
  }

  function injectStyles() {
    // Styles injected from content.css
  }

  // ─── Boot ─────────────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    setTimeout(init, 1500); // wait for SPA to mount
  }
})();
