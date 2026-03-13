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

  // ─── Platform Config ───────────────────────────────────────────────────────────
  const CONFIG = {
    claude: {
      input: '[contenteditable="true"][data-placeholder]',
      submit: 'button[aria-label="Send Message"], button[type="submit"]',
      response: '[data-testid="assistant-message"] .prose, .font-claude-message',
      // Selector for user message bubbles in the chat history
      userBubble: '[data-testid="user-message"]',
    },
    chatgpt: {
      input: '#prompt-textarea',
      submit: 'button[data-testid="send-button"], button[aria-label="Send prompt"]',
      response: '[data-message-author-role="assistant"] .markdown',
      userBubble: '[data-message-author-role="user"] .whitespace-pre-wrap',
    },
    gemini: {
      input: 'rich-textarea .ql-editor, [contenteditable="true"].input-area-container',
      submit: 'button.send-button, button[aria-label="Send message"]',
      response: '.response-content .markdown, model-response .response-text',
      userBubble: 'user-query .query-text',
    }
  };

  const sel = CONFIG[PLATFORM];
  let settings = {};
  let lastCapturedResponse = '';
  let isInjecting = false;
  let memoryBarEl = null;
  let isContextValid = true;
  // Marker so we can strip context from the displayed bubble after send
  const CONTEXT_MARKER_START = '【MB:';
  const CONTEXT_MARKER_END = '】\n\n';

  // ─── Safe Message Helper ───────────────────────────────────────────────────────
  async function sendMessageSafe(msg) {
    if (!isContextValid) return null;
    try {
      return await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(msg, (response) => {
          if (chrome.runtime.lastError) {
            const errMsg = chrome.runtime.lastError.message || '';
            if (errMsg.includes('context invalidated')) {
              isContextValid = false;
              cleanup();
              resolve(null);
            } else {
              reject(new Error(errMsg));
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
      const text = document.getElementById('mb-text');
      if (text) text.textContent = 'Please refresh page';
    }
  }

  // ─── Init ─────────────────────────────────────────────────────────────────────
  async function init() {
    settings = await sendMessageSafe({ type: 'GET_SETTINGS' });
    if (!settings) return;
    if (!settings.captureThreshold || settings.captureThreshold > 25) {
      settings.captureThreshold = 20;
    }
    injectStyles();
    createMemoryBar();
    setupSubmitInterceptor();
    observeResponses();
    observeUserBubblesForCleanup(); // strip context from displayed bubbles
    listenForShortcuts();
  }

  // ─── Memory Bar ────────────────────────────────────────────────────────────────
  function createMemoryBar() {
    if (document.getElementById('mb-bar')) return;
    memoryBarEl = document.createElement('div');
    memoryBarEl.id = 'mb-bar';
    memoryBarEl.innerHTML = `
      <div id="mb-bar-inner">
        <span id="mb-icon">🧠</span>
        <span id="mb-text">MemoryBridge active</span>
        <div id="mb-actions">
          <button id="mb-search-btn" title="Browse memories (Ctrl+Shift+M)">Memories</button>
          <button id="mb-toggle-btn">Inject: ${settings.autoInject !== false ? 'ON' : 'OFF'}</button>
        </div>
      </div>
      <div id="mb-memories-panel" class="hidden">
        <div id="mb-memories-list"></div>
      </div>
    `;
    document.body.appendChild(memoryBarEl);
    document.getElementById('mb-search-btn').addEventListener('click', togglePanel);
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
    list.innerHTML = '<div class="mb-loading">Loading memories...</div>';
    const res = await sendMessageSafe({ type: 'GET_MEMORIES', limit: 20 });
    const items = res?.memories || [];
    if (!items.length) {
      list.innerHTML = '<div class="mb-empty">No memories yet.</div>';
      return;
    }
    list.innerHTML = items.map(m => `
      <div class="mb-memory-item">
        <div class="mb-memory-content">${escapeHtml(m.content.slice(0, 200))}</div>
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
    if (btn) btn.textContent = `Inject: ${settings.autoInject ? 'ON' : 'OFF'}`;
    showToast(settings.autoInject ? '✅ Auto-injection ON' : '⏸ Auto-injection OFF');
  }

  // ─── Submit Interceptor ───────────────────────────────────────────────────────
  function setupSubmitInterceptor() {
    // Capture phase — fires before the AI platform's own handlers
    document.addEventListener('keydown', handleSubmitEvent, true);
    document.addEventListener('click', handleSubmitClick, true);
  }

  async function handleSubmitEvent(e) {
    if (!isContextValid || !settings.autoInject || isInjecting) return;
    if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.altKey) return;
    const input = getInputEl();
    if (!input || !isInputFocused(input)) return;
    const userText = getText(input);
    if (!userText || userText.length < 3) return;

    // ⚠️ MUST block the event synchronously — BEFORE any await.
    // Once we yield (await), the browser has already dispatched to ChatGPT's handlers.
    e.preventDefault();
    e.stopImmediatePropagation();

    await enrichAndSubmit(input, userText);
  }

  async function handleSubmitClick(e) {
    if (!isContextValid || !settings.autoInject || isInjecting) return;
    if (!e.target.closest(sel.submit)) return;
    const input = getInputEl();
    const userText = getText(input);
    if (!userText || userText.length < 3) return;

    // Same — block first, then do async work
    e.preventDefault();
    e.stopImmediatePropagation();

    await enrichAndSubmit(input, userText);
  }

  async function enrichAndSubmit(input, userText) {
    showToast('🔍 Searching memories...', 1500);
    const contextBlock = await buildContextBlock(userText);

    isInjecting = true;
    try {
      if (contextBlock) {
        showToast('🧠 Injecting context...', 2000);
        const hidden = `${CONTEXT_MARKER_START}${contextBlock}${CONTEXT_MARKER_END}`;
        await writeToInput(input, hidden + userText);
        await new Promise(r => setTimeout(r, 80)); // let framework reconcile
      }
      // Whether or not we found memories, we must still submit the message
      doSubmit(input);
    } finally {
      setTimeout(() => { isInjecting = false; }, 2000);
    }
  }

  // ─── Write to Input (React + contenteditable safe) ───────────────────────────
  async function writeToInput(input, fullText) {
    try {
      if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
        // Use native prototype setter to bypass React's property descriptor
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
        if (nativeSetter) {
          nativeSetter.call(input, fullText);
        } else {
          input.value = fullText;
        }
        // React needs both 'input' and 'change' events to update its internal state
        input.dispatchEvent(new InputEvent('input', { bubbles: true, data: fullText }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return true;

      } else if (input.contentEditable === 'true') {
        // Claude / Gemini — contenteditable approach
        input.focus();
        // Select all existing content
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(input);
        selection.removeAllRanges();
        selection.addRange(range);
        // execCommand('insertText') triggers the editor's own mutation handling
        const success = document.execCommand('insertText', false, fullText);
        if (!success) {
          // Fallback for browsers where execCommand is deprecated
          input.innerText = fullText;
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
        return true;
      }
    } catch (err) {
      console.error('[MemoryBridge] writeToInput error:', err);
    }
    return false;
  }

  function doSubmit(input) {
    const btn = document.querySelector(sel.submit);
    if (btn && !btn.disabled) {
      btn.click();
    } else {
      // Dispatch as a new synthetic event that we do NOT catch (isInjecting = true)
      input.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', code: 'Enter', keyCode: 13,
        bubbles: true, cancelable: true
      }));
    }
  }

  async function injectManual(content) {
    const input = getInputEl();
    if (!input) { showToast('❌ Could not find input'); return; }
    const userText = getText(input);
    const full = `${CONTEXT_MARKER_START}[Memory: ${content}]${CONTEXT_MARKER_END}${userText}`;
    const ok = await writeToInput(input, full);
    if (ok) {
      showToast('🧠 Memory injected — press Enter to send!');
    }
    togglePanel();
  }

  // ─── Build Context Block ──────────────────────────────────────────────────────
  async function buildContextBlock(userText) {
    const res = await sendMessageSafe({ type: 'SEARCH_MEMORIES', query: userText });
    const memories = res?.results || [];
    if (!memories.length) return null;

    // Prefer extracted facts first, fall back to raw content
    const facts = [];
    for (const m of memories) {
      const ef = m.extracted_facts?.facts;
      if (Array.isArray(ef) && ef.length > 0) {
        facts.push(...ef.slice(0, 2));
      } else if (m.content) {
        facts.push(m.content.split('\n')[0].slice(0, 250));
      }
    }
    const unique = [...new Set(facts)].slice(0, 8);
    if (!unique.length) return null;

    return `Relevant facts remembered about the user:\n${unique.map(f => `• ${f}`).join('\n')}`;
  }

  // ─── Clean Context From Displayed User Bubbles ────────────────────────────────
  // After the message is sent, the context block shows in the chat history bubble.
  // This observer strips it out so only the user's actual message is visible.
  function observeUserBubblesForCleanup() {
    const cleanupObserver = new MutationObserver(() => {
      document.querySelectorAll(sel.userBubble).forEach(bubble => {
        if (bubble.dataset.mbCleaned) return; // skip already processed
        const html = bubble.innerHTML;
        if (!html.includes(CONTEXT_MARKER_START)) return;
        // Strip the context block from the visual display
        const startIdx = html.indexOf(CONTEXT_MARKER_START);
        const endIdx = html.indexOf(CONTEXT_MARKER_END);
        if (startIdx !== -1 && endIdx !== -1) {
          bubble.innerHTML = html.slice(endIdx + CONTEXT_MARKER_END.length);
          bubble.dataset.mbCleaned = '1';
          console.log('[MemoryBridge] Cleaned context from displayed bubble');
        }
      });
    });
    cleanupObserver.observe(document.body, { childList: true, subtree: true });
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────────
  function getInputEl() {
    for (const s of sel.input.split(',')) {
      const el = document.querySelector(s.trim());
      if (el) return el;
    }
    return null;
  }

  function isInputFocused(el) {
    return el && (document.activeElement === el || el.contains(document.activeElement));
  }

  function getText(el) {
    if (!el) return '';
    return (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT')
      ? el.value.trim()
      : el.innerText.trim();
  }

  // ─── Capture AI Responses ─────────────────────────────────────────────────────
  function observeResponses() {
    const observer = new MutationObserver(async () => {
      if (!isContextValid) { observer.disconnect(); return; }
      if (!settings.autoCapture) return;

      const responses = document.querySelectorAll(sel.response);
      if (!responses.length) return;
      const lastResponse = responses[responses.length - 1];
      const text = lastResponse?.textContent?.trim();
      if (!text || text === lastCapturedResponse) return;
      if (text.length < (settings.captureThreshold || 20)) return;

      clearTimeout(window._mbCaptureTimer);
      window._mbCaptureTimer = setTimeout(async () => {
        if (!isContextValid || text === lastCapturedResponse) return;
        lastCapturedResponse = text;
        await captureResponse(text);
      }, 2500);
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  async function captureResponse(responseText) {
    console.log('[MemoryBridge] Capturing:', responseText.slice(0, 80));
    showToast('⏳ Saving memory...', 3000);
    const result = await sendMessageSafe({
      type: 'SAVE_MEMORY',
      payload: {
        content: responseText.slice(0, 4000),
        source: location.href,
        model: PLATFORM,
        type: 'conversation'
      }
    });
    if (result?.id) {
      console.log('[MemoryBridge] Saved:', result.id, '| Facts:', result.facts);
      showToast('💾 Memory saved!', 2000);
    } else {
      console.warn('[MemoryBridge] Save failed:', result?.error);
    }
  }

  // ─── Shortcuts ────────────────────────────────────────────────────────────────
  function listenForShortcuts() {
    document.addEventListener('keydown', (e) => {
      if (!isContextValid) return;
      if (e.ctrlKey && e.shiftKey && e.key === 'M') {
        e.preventDefault();
        togglePanel();
      }
    });
  }

  // ─── Toast ────────────────────────────────────────────────────────────────────
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

  // ─── Styles ────────────────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('mb-styles')) return;
    const style = document.createElement('style');
    style.id = 'mb-styles';
    style.textContent = `
      #mb-bar {
        position:fixed;bottom:0;left:0;width:100%;
        background:linear-gradient(90deg,#1e1b4b,#1f2937);
        color:white;height:34px;font-size:13px;z-index:999999;
        display:flex;align-items:center;padding:0 16px;
        box-shadow:0 -2px 12px rgba(99,102,241,.3);
        border-top:1px solid #312e81;font-family:system-ui,sans-serif;
      }
      #mb-bar-inner{width:100%;display:flex;align-items:center;gap:10px;}
      #mb-icon{font-size:16px;}
      #mb-text{flex:1;color:#c7d2fe;font-size:12px;}
      #mb-actions{display:flex;gap:8px;}
      #mb-actions button{
        background:#312e81;color:#c7d2fe;border:1px solid #4338ca;
        padding:3px 10px;border-radius:99px;cursor:pointer;
        font-size:11px;transition:all .2s;
      }
      #mb-actions button:hover{background:#4338ca;color:white;}
      #mb-actions button.off{background:#7f1d1d;border-color:#991b1b;color:#fca5a5;}
      #mb-memories-panel{
        position:fixed;bottom:34px;left:0;width:360px;
        max-height:480px;background:#111827;border:1px solid #374151;
        overflow-y:auto;padding:10px;z-index:999998;
        box-shadow:4px 0 20px rgba(0,0,0,.5);border-radius:0 8px 0 0;
      }
      .hidden{display:none!important;}
      .mb-memory-item{
        background:#1f2937;padding:10px;border-radius:6px;
        margin-bottom:8px;border-left:3px solid #6366f1;
      }
      .mb-memory-content{font-size:12px;color:#d1d5db;line-height:1.5;margin-bottom:6px;}
      .mb-memory-meta{display:flex;justify-content:space-between;align-items:center;font-size:10px;color:#6b7280;}
      .mb-inject-btn{
        background:transparent;color:#818cf8;
        border:1px solid #312e81;padding:1px 6px;
        border-radius:3px;cursor:pointer;font-size:10px;
      }
      .mb-inject-btn:hover{background:#312e81;color:white;}
      .mb-loading,.mb-empty{text-align:center;color:#6b7280;padding:20px;font-size:12px;}
      #mb-toast{
        position:fixed;left:50%;bottom:50px;
        transform:translateX(-50%) translateY(12px);
        background:#4f46e5;color:white;padding:8px 22px;
        border-radius:20px;font-size:13px;
        box-shadow:0 4px 16px rgba(79,70,229,.5);
        pointer-events:none;opacity:0;transition:all .25s;z-index:1000000;
        white-space:nowrap;
      }
      #mb-toast.show{opacity:1;transform:translateX(-50%) translateY(0);}
    `;
    document.head.appendChild(style);
  }

  function escapeHtml(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function formatDate(iso) {
    if (!iso) return '';
    try { return new Date(iso).toLocaleDateString(undefined,{month:'short',day:'numeric'}); }
    catch { return ''; }
  }

  // ─── Boot ─────────────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    setTimeout(init, 1000);
  }
})();
