let allMemories = [];
let currentFilter = 'all';
let currentModelFilter = null;
let settings = {};
let searchTimer;

function send(msg) {
  return new Promise(resolve => chrome.runtime.sendMessage(msg, resolve));
}

async function init() {
  await loadSettings();
  await checkHealth();
  await loadMemories();
  setupNav();
  setupModelFilters();
  setupFilters();
  setupSearch();
  setupSettings();
  setupExport();

  // Auto-refresh every 30 seconds
  setInterval(() => {
    if (document.visibilityState === 'visible') {
      loadMemories(document.getElementById('topbar-search')?.value || '');
    }
  }, 30000);
}

async function checkHealth() {
  const h = await send({ type: 'CHECK_HEALTH' });
  const dot = document.getElementById('s-dot');
  const txt = document.getElementById('s-text');
  if (!dot || !txt) return;
  if (h?.status === 'ok') {
    dot.classList.add('online');
    txt.textContent = 'Backend online';
  } else {
    txt.textContent = 'Backend offline';
  }
}

async function loadSettings() {
  settings = await send({ type: 'GET_SETTINGS' }) || {};
  const apikeyInput = document.getElementById('s-apikey');
  const useridInput = document.getElementById('s-userid');
  const autocaptureBtn = document.getElementById('s-autocapture');
  const autoinjectBtn = document.getElementById('s-autoinject');
  const visibilitySelect = document.getElementById('s-visibility');

  if (apikeyInput) apikeyInput.value = settings.apiKey || '';
  if (useridInput) useridInput.value = settings.userId || '';
  if (autocaptureBtn) autocaptureBtn.classList.toggle('on', settings.autoCapture !== false);
  if (autoinjectBtn) autoinjectBtn.classList.toggle('on', settings.autoInject !== false);
  if (visibilitySelect) visibilitySelect.value = settings.defaultVisibility || 'private';
}

async function loadMemories(query = '') {
  const grid = document.getElementById('memories-grid');
  if (grid) grid.innerHTML = '<div class="loading-state">Loading memories...</div>';

  let mems;
  if (query.length > 2) {
    const res = await send({ type: 'SEARCH_MEMORIES', query });
    mems = res?.results || [];
  } else {
    const res = await send({ type: 'GET_MEMORIES', limit: 100 });
    mems = res?.memories || [];
  }

  allMemories = mems;
  updateStats(mems);
  renderFiltered();
}

function updateStats(mems) {
    const total = document.getElementById('ds-total');
    const week = document.getElementById('ds-week');
    const modelsCount = document.getElementById('ds-models');
    
    if (total) total.textContent = mems.length;
    if (week) {
        const count = mems.filter(m => {
          if (!m.created_at) return false;
          return (Date.now() - new Date(m.created_at)) < 7 * 86400000;
        }).length;
        week.textContent = count;
    }
    if (modelsCount) {
        const models = new Set(mems.map(m => m.source_model).filter(Boolean));
        modelsCount.textContent = models.size || 0;
    }
}

function renderFiltered() {
  let mems = [...allMemories];
  if (currentFilter !== 'all') mems = mems.filter(m => m.type === currentFilter);
  if (currentModelFilter) mems = mems.filter(m => m.source_model === currentModelFilter);

  const sortSelect = document.getElementById('sort-select');
  if (sortSelect) {
    const sort = sortSelect.value;
    if (sort === 'oldest') mems.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    else mems.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  }

  renderGrid(mems);
}

function renderGrid(mems) {
  const grid = document.getElementById('memories-grid');
  if (!grid) return;
  if (!mems.length) {
    grid.innerHTML = `
      <div class="empty-state" style="grid-column:1/-1">
        <div class="empty-icon">🧠</div>
        <div class="empty-title">No memories found</div>
        <div class="empty-desc">Start chatting on Claude, ChatGPT, or Gemini with the extension active to build your memory.</div>
      </div>`;
    return;
  }

  const modelIcon = { claude: '◆', chatgpt: '◎', gemini: '✦' };
  grid.innerHTML = mems.map(m => `
    <div class="mem-card">
      <div class="mem-card-header">
        <span class="mem-type-badge ${m.type || 'auto'}">${m.type || 'auto'}</span>
        <span class="mem-model-icon">${modelIcon[m.source_model] || '·'}</span>
      </div>
      <div class="mem-text">${escHtml(m.content)}</div>
      <div class="mem-footer">
        <span class="mem-date-tag">${formatDate(m.created_at)}</span>
        <span class="visibility-badge ${m.visibility || 'private'}">${m.visibility || 'private'}</span>
        <div class="mem-actions">
          <button class="mem-btn copy-btn" data-id="${m.id}">Copy</button>
          <button class="mem-btn del delete-btn" data-id="${m.id}">✕</button>
        </div>
      </div>
    </div>
  `).join('');

  grid.querySelectorAll('.copy-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
        const id = e.target.getAttribute('data-id');
        copyMem(id);
    });
  });

  grid.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
        const id = e.target.getAttribute('data-id');
        deleteMem(id);
    });
  });
}

function copyMem(id) {
  const m = allMemories.find(x => x.id === id);
  if (m) { navigator.clipboard.writeText(m.content); toast('Copied!'); }
}

async function deleteMem(id) {
  await send({ type: 'DELETE_MEMORY', id });
  allMemories = allMemories.filter(m => m.id !== id);
  updateStats(allMemories);
  renderFiltered();
  toast('Memory deleted');
}

window.filterModel = function(model) {
  currentModelFilter = currentModelFilter === model ? null : model;
  renderFiltered();
};

function setupFilters() {
  document.querySelectorAll('.filter-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      currentFilter = chip.dataset.filter;
      renderFiltered();
    });
  });

  const sortSelect = document.getElementById('sort-select');
  if (sortSelect) sortSelect.addEventListener('change', renderFiltered);
}

function setupSearch() {
  const searchInput = document.getElementById('topbar-search');
  if (searchInput) {
      searchInput.addEventListener('input', e => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => loadMemories(e.target.value), 400);
      });
  }
}

function setupNav() {
  document.querySelectorAll('.nav-item[data-view]').forEach(item => {
    item.addEventListener('click', () => {
      document.querySelectorAll('.nav-item[data-view]').forEach(i => i.classList.remove('active'));
      item.classList.add('active');
      const view = item.dataset.view;
      const memsView = document.getElementById('view-memories');
      const settView = document.getElementById('view-settings');
      const title = document.getElementById('page-title');

      if (memsView) memsView.style.display = view === 'memories' ? '' : 'none';
      if (settView) settView.classList.toggle('active', view === 'settings');
      if (title) title.textContent = view === 'settings' ? 'Settings' : 'All Memories';
    });
  });
}

function setupModelFilters() {
  document.querySelectorAll('.model-filter').forEach(item => {
    item.addEventListener('click', () => {
      const model = item.getAttribute('data-model');
      currentModelFilter = (currentModelFilter === model) ? null : model;
      
      // Update UI state
      document.querySelectorAll('.model-filter').forEach(i => i.classList.remove('active'));
      if (currentModelFilter) item.classList.add('active');
      
      renderFiltered();
    });
  });
}

function setupSettings() {
  ['s-autocapture', 's-autoinject'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
        el.addEventListener('click', e => {
          e.currentTarget.classList.toggle('on');
        });
    }
  });

  const saveBtn = document.getElementById('btn-save-settings');
  if (saveBtn) {
      saveBtn.addEventListener('click', async () => {
        settings.apiKey = document.getElementById('s-apikey').value.trim();
        settings.userId = document.getElementById('s-userid').value.trim();
        settings.autoCapture = document.getElementById('s-autocapture').classList.contains('on');
        settings.autoInject = document.getElementById('s-autoinject').classList.contains('on');
        settings.defaultVisibility = document.getElementById('s-visibility').value;
        await send({ type: 'SAVE_SETTINGS', settings });
        toast('✅ Settings saved!');
      });
  }
}

function setupExport() {
  const exportBtn = document.getElementById('btn-export');
  if (exportBtn) {
      exportBtn.addEventListener('click', () => {
        const data = JSON.stringify(allMemories, null, 2);
        const blob = new Blob([data], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `memorybridge-export-${Date.now()}.json`;
        a.click();
      });
  }
}

function toast(msg, dur = 2500) {
  const el = document.getElementById('dash-toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), dur);
}

function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function formatDate(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  catch { return ''; }
}

init();
