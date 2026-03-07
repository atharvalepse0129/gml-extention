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
  console.log(`[MemoryBridge] Aggressive loading on ${PLATFORM}`);

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
  let isContextValid = true;

  // ─── Helper: Safe Message Sending ───────────────────────────────────────────
  async function sendMessageSafe(msg) {
    if (!isContextValid) return null;
    try {
      return await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(msg, (response) => {
          if (chrome.runtime.lastError) {
            if (chrome.runtime.lastError.message.includes('context invalidated')) {
              console.warn('[MemoryBridge] Extension context invalidated. Please refresh the page.');
              isContextValid = false;
              cleanup();
              resolve(null);
            } else {
              reject(chrome.runtime.lastError);
            }
          } else {
            resolve(response);
          }
        });
      });
    } catch (err) {
      console.error('[MemoryBridge] Message failed:', err);
      return null;
    }
  }

  function cleanup() {
    if (memoryBarEl) {
      memoryBarEl.style.opacity = '0.5';
      memoryBarEl.title = 'Extension updated. Please refresh the page.';
      const text = document.getElementById('mb-text');
      if (text) text.textContent = 'Please refresh page';
    }
  }

  // ─── Init ─────────────────────────────────────────────────────────────────────
  async function init() {
    settings = await getSettings();
    if (!settings) return; 
    
    // Force aggressive defaults if not set
    if (settings.captureThreshold === undefined || settings.captureThreshold > 25) {
        settings.captureThreshold = 20;
    }

    injectStyles();
    createMemoryBar();
    observeSubmit();
    observeResponses();
    listenForShortcuts();
  }

  async function getSettings() {
    return await sendMessageSafe({ type: 'GET_SETTINGS' });
  }

  // ─── Memory Bar UI ────────────────────────────────────────────────────────────
  function createMemoryBar() {
    if (document.getElementById('mb-bar')) return;
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
    if (!isContextValid) return;
    const panel = document.getElementById('mb-memories-panel');
    panel.classList.toggle('hidden');
    if (!panel.classList.contains('hidden')) loadMemoriesPanel();
  }

  async function loadMemoriesPanel() {
    const list = document.getElementById('mb-memories-list');
    list.innerHTML = '<div class="mb-loading">Searching memories...</div>';

    const inputEl = document.querySelector(sel.input);
    const query = inputEl?.textContent?.trim() || inputEl?.value?.trim() || '';

    let res;
    if (query.length > 10) {
      res = await sendMessageSafe({ type: 'SEARCH_MEMORIES', query });
    } else {
      res = await sendMessageSafe({ type: 'GET_MEMORIES', limit: 10 });
    }

    const items = res?.results || res?.memories || [];
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

  async function toggleInjection() {
    if (!isContextValid) return;
    settings.autoInject = !settings.autoInject;
    await sendMessageSafe({ type: 'SAVE_SETTINGS', settings });
    const btn = document.getElementById('mb-toggle-btn');
    btn.textContent = `Inject: ${settings.autoInject ? 'ON' : 'OFF'}`;
    btn.classList.toggle('off', !settings.autoInject);
    showToast(settings.autoInject ? '✅ Auto-injection enabled' : '⏸ Auto-injection paused');
  }

  // ─── Intercept Submit ─────────────────────────────────────────────────────────
  function observeSubmit() {
    document.addEventListener('keydown', async (e) => {
      if (!isContextValid) return;
      if (e.key !== 'Enter' || e.shiftKey) return;
      const input = document.querySelector(sel.input);
      if (!input || !document.activeElement?.closest(sel.input?.split(',')[0])) return;
      const text = input.textContent?.trim() || input.value?.trim();
      if (!text || text.length < 5) return;
      await handleUserMessage(text);
    }, true);

    document.addEventListener('click', async (e) => {
      if (!isContextValid) return;
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

    console.log('[MemoryBridge] Searching context for:', text.slice(0, 50));
    const result = await sendMessageSafe({ type: 'SEARCH_MEMORIES', query: text });
    const memories = result?.results || [];
    if (memories.length === 0) return;

    const contextBlock = buildContextBlock(memories);
    await injectContext(contextBlock);
    showToast(`🧠 Injected ${memories.length} memories`);
  }

  function buildContextBlock(memories) {
    const lines = memories.map(m => `- ${m.content}`).join('\n');
    return `[MemoryBridge Context — relevant memories:\n${lines}\n]\n\n`;
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
      if (!isContextValid) { observer.disconnect(); return; }
      if (!settings.autoCapture) return;

      const responses = document.querySelectorAll(sel.response);
      if (!responses.length) return;

      const lastResponse = responses[responses.length - 1];
      const text = lastResponse?.textContent?.trim();

      if (!text || text === lastCapturedResponse) return;
      
      const threshold = settings.captureThreshold || 20;
      if (text.length < threshold) {
        // console.log(`[MemoryBridge] Text too short to capture (${text.length}<${threshold})`);
        return;
      }

      clearTimeout(window._mbCaptureTimer);
      window._mbCaptureTimer = setTimeout(async () => {
        if (!isContextValid || text === lastCapturedResponse) return;
        lastCapturedResponse = text;
        await captureConversationTurn(text);
      }, 2500); 
    });

    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  async function captureConversationTurn(responseText) {
    console.log('[MemoryBridge] Capture triggered for:', responseText.slice(0, 50));
    showToast('🧠 Processing memory...', 3000);

    const inputEl = document.querySelector(sel.input);
    const userText = inputEl?.textContent?.trim() || inputEl?.value?.trim() || '';

    const combined = userText ? `User: ${userText}\n\nAssistant: ${responseText}` : responseText;

    const result = await sendMessageSafe({
      type: 'SAVE_MEMORY',
      payload: {
        content: combined.slice(0, 4000), 
        source: location.href,
        model: PLATFORM,
        type: 'conversation'
      }
    });

    if (result?.id) {
      console.log('[MemoryBridge] Memory saved successfully, ID:', result.id);
      updateBadge();
      showToast('💾 Memory saved!', 2000);
    } else {
      console.error('[MemoryBridge] Save failed:', result?.error);
      showToast('❌ Save failed', 2000);
    }
  }

  // ─── Keyboard Shortcuts ───────────────────────────────────────────────────────
  function listenForShortcuts() {
    document.addEventListener('keydown', (e) => {
      if (!isContextValid) return;
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
      if (toast.parentNode) {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
      }
    }, duration);
  }

  function updateBadge() {
    sendMessageSafe({ type: 'UPDATE_BADGE' });
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────────
  function escapeHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function formatDate(iso) {
    if (!iso) return '';
    try { return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); } 
    catch { return ''; }
  }

  function injectStyles() {
    if (document.getElementById('mb-styles')) return;
    const style = document.createElement('style');
    style.id = 'mb-styles';
    style.textContent = `
      #mb-bar { position: fixed; bottom: 0; left: 0; width: 100%; background: #1f2937; color: white; height: 32px; font-size: 13px; z-index: 999999; display: flex; align-items: center; padding: 0 15px; box-shadow: 0 -2px 10px rgba(0,0,0,0.2); border-top: 1px solid #374151; font-family: sans-serif; }
      #mb-bar-inner { width: 100%; display: flex; align-items: center; justify-content: space-between; }
      #mb-icon { margin-right: 8px; font-size: 16px; }
      #mb-actions { display: flex; gap: 10px; }
      #mb-actions button { background: #374151; color: white; border: none; padding: 2px 8px; border-radius: 4px; cursor: pointer; font-size: 11px; transition: background 0.2s; }
      #mb-actions button:hover { background: #4b5563; }
      #mb-actions button.off { opacity: 0.5; background: #991b1b; }
      #mb-memories-panel { position: fixed; bottom: 32px; left: 0; width: 350px; max-height: 500px; background: #111827; border: 1px solid #374151; border-bottom: none; overflow-y: auto; padding: 10px; z-index: 999998; box-shadow: 2px 0 10px rgba(0,0,0,0.3); }
      .hidden { display: none !important; }
      .mb-memory-item { background: #1f2937; padding: 8px; border-radius: 6px; margin-bottom: 8px; border-left: 3px solid #6366f1; }
      .mb-memory-type { font-size: 10px; text-transform: uppercase; opacity: 0.6; margin-bottom: 4px; }
      .mb-memory-content { font-size: 12px; margin-bottom: 6px; line-height: 1.4; white-space: pre-wrap; word-break: break-word; }
      .mb-memory-meta { display: flex; justify-content: space-between; align-items: center; font-size: 10px; opacity: 0.7; }
      .mb-inject-btn { background: transparent; color: #818cf8; border: 1px solid #312e81; padding: 1px 5px; border-radius: 3px; cursor: pointer; }
      .mb-inject-btn:hover { background: #312e81; color: white; }
      #mb-toast { position: fixed; left: 50%; bottom: 50px; transform: translateX(-50%) translateY(20px); background: #6366f1; color: white; padding: 8px 20px; border-radius: 20px; font-size: 14px; box-shadow: 0 4px 12px rgba(0,0,0,0.3); pointer-events: none; opacity: 0; transition: all 0.3s; z-index: 1000000; }
      #mb-toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
    `;
    document.head.appendChild(style);
  }

  // ─── Boot ─────────────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    setTimeout(init, 1000); 
  }
})();
