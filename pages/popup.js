let settings = {};
let allMemories = [];
let searchTimer;

async function init() {
  await loadSettings();
  await checkHealth();
  await loadMemories();
  await detectPlatform();
  setupListeners();
}

async function send(msg) {
  return new Promise(resolve => chrome.runtime.sendMessage(msg, resolve));
}

async function loadSettings() {
  settings = await send({ type: 'GET_SETTINGS' }) || {};
  const captureToggle = document.getElementById('toggle-capture');
  const injectToggle = document.getElementById('toggle-inject');
  if (captureToggle) captureToggle.classList.toggle('on', settings.autoCapture !== false);
  if (injectToggle) injectToggle.classList.toggle('on', settings.autoInject !== false);
}

async function checkHealth() {
  const health = await send({ type: 'CHECK_HEALTH' });
  const dot = document.getElementById('status-dot');
  const text = document.getElementById('status-text');
  if (!dot || !text) return;
  if (health?.status === 'ok') {
    dot.className = 'status-dot online';
    text.textContent = 'Backend connected';
  } else {
    dot.className = 'status-dot offline';
    text.textContent = 'Backend offline — start your server';
  }
}

async function loadMemories(query = '') {
  const wrap = document.getElementById('memories-wrap');
  if (wrap) wrap.innerHTML = '<div class="loading">Loading...</div>';

  let memories;
  if (query.length > 2) {
    const res = await send({ type: 'SEARCH_MEMORIES', query });
    memories = res?.results || [];
  } else {
    const res = await send({ type: 'GET_MEMORIES', limit: 30 });
    memories = res?.memories || [];
  }

  allMemories = memories;
  updateStats(memories);
  renderMemories(memories);
}

function updateStats(memories) {
  const total = document.getElementById('stat-total');
  const todayCount = document.getElementById('stat-today');
  if (total) total.textContent = memories.length;
  if (todayCount) {
    const today = memories.filter(m => {
      if (!m.created_at) return false;
      const d = new Date(m.created_at);
      const now = new Date();
      return d.toDateString() === now.toDateString();
    }).length;
    todayCount.textContent = today;
  }
}

function renderMemories(memories) {
  const wrap = document.getElementById('memories-wrap');
  if (!wrap) return;
  if (!memories.length) {
    wrap.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🧠</div>
        <div class="empty-title">No memories yet</div>
        <div class="empty-sub">Visit Claude, ChatGPT, or Gemini and start chatting. MemoryBridge will capture key information automatically.</div>
      </div>`;
    return;
  }

  wrap.innerHTML = memories.map(m => `
    <div class="memory-card" data-id="${m.id}">
      <div class="memory-card-header">
        <span class="mem-type-tag">${m.type || 'note'}</span>
        <span class="mem-model">${m.source_model || '—'}</span>
        <span class="mem-date">${formatDate(m.created_at)}</span>
      </div>
      <div class="memory-content">${escHtml(m.content)}</div>
      <div class="memory-card-actions">
        <button class="mem-action-btn copy-btn" data-id="${m.id}">Copy</button>
        <button class="mem-action-btn danger delete-btn" data-id="${m.id}">Delete</button>
      </div>
    </div>
  `).join('');

  wrap.querySelectorAll('.copy-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
        const id = e.target.getAttribute('data-id');
        copyMemory(id);
    });
  });

  wrap.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
        const id = e.target.getAttribute('data-id');
        deleteMemory(id);
    });
  });
}

async function copyMemory(id) {
  const m = allMemories.find(x => x.id === id);
  if (!m) return;
  await navigator.clipboard.writeText(m.content);
}

async function deleteMemory(id) {
  await send({ type: 'DELETE_MEMORY', id });
  allMemories = allMemories.filter(m => m.id !== id);
  renderMemories(allMemories);
  updateStats(allMemories);
}

async function detectPlatform() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const badge = document.getElementById('platform-badge');
  if (!badge) return;
  const url = tab?.url || '';
  if (url.includes('claude.ai')) badge.textContent = 'Claude';
  else if (url.includes('chatgpt.com') || url.includes('openai.com')) badge.textContent = 'ChatGPT';
  else if (url.includes('gemini.google.com')) badge.textContent = 'Gemini';
  else badge.textContent = 'No AI tab';
}

function setupListeners() {
  const refreshBtn = document.getElementById('btn-refresh');
  const dashboardBtn = document.getElementById('btn-dashboard');
  const searchInput = document.getElementById('search-input');
  const captureToggle = document.getElementById('toggle-capture');
  const injectToggle = document.getElementById('toggle-inject');

  if (refreshBtn) refreshBtn.addEventListener('click', () => loadMemories());
  if (dashboardBtn) dashboardBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('pages/dashboard.html') });
  });

  if (searchInput) searchInput.addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => loadMemories(e.target.value), 400);
  });

  if (captureToggle) captureToggle.addEventListener('click', async (e) => {
    settings.autoCapture = !settings.autoCapture;
    e.currentTarget.classList.toggle('on', settings.autoCapture);
    await send({ type: 'SAVE_SETTINGS', settings });
  });

  if (injectToggle) injectToggle.addEventListener('click', async (e) => {
    settings.autoInject = !settings.autoInject;
    e.currentTarget.classList.toggle('on', settings.autoInject);
    await send({ type: 'SAVE_SETTINGS', settings });
  });
}

function escHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function formatDate(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleDateString(undefined, { month:'short', day:'numeric' }); }
  catch { return ''; }
}

init();
