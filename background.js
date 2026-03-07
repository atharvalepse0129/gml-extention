// MemoryBridge - Background Service Worker
const API_BASE = 'http://localhost:3000/api';

// ─── Message Router ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case 'SAVE_MEMORY':
          sendResponse(await saveMemory(msg.payload));
          break;
        case 'SEARCH_MEMORIES':
          sendResponse(await searchMemories(msg.query, msg.userId));
          break;
        case 'GET_MEMORIES':
          sendResponse(await getMemories(msg.userId, msg.limit));
          break;
        case 'DELETE_MEMORY':
          sendResponse(await deleteMemory(msg.id));
          break;
        case 'UPDATE_MEMORY':
          sendResponse(await updateMemory(msg.id, msg.updates));
          break;
        case 'GET_SETTINGS':
          sendResponse(await getSettings());
          break;
        case 'SAVE_SETTINGS':
          sendResponse(await saveSettings(msg.settings));
          break;
        case 'CHECK_HEALTH':
          sendResponse(await checkHealth());
          break;
        default:
          sendResponse({ error: 'Unknown message type' });
      }
    } catch (err) {
      console.error('[MemoryBridge BG]', err);
      sendResponse({ error: err.message });
    }
  })();
  return true; // keep channel open for async
});

// ─── API Calls ────────────────────────────────────────────────────────────────
async function saveMemory({ content, source, model, type = 'auto', visibility = 'private', userId }) {
  const settings = await getSettings();
  const uid = userId || settings.userId || 'default';

  const res = await fetch(`${API_BASE}/memory`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': settings.apiKey || ''
    },
    body: JSON.stringify({ content, source, model, type, visibility, userId: uid })
  });

  if (!res.ok) throw new Error(`Save failed: ${res.status}`);
  return res.json();
}

async function searchMemories(query, userId) {
  const settings = await getSettings();
  const uid = userId || settings.userId || 'default';

  const res = await fetch(`${API_BASE}/memory/search`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': settings.apiKey || ''
    },
    body: JSON.stringify({ query, userId: uid, topK: 5 })
  });

  if (!res.ok) throw new Error(`Search failed: ${res.status}`);
  return res.json();
}

async function getMemories(userId, limit = 50) {
  const settings = await getSettings();
  const uid = userId || settings.userId || 'default';

  const res = await fetch(`${API_BASE}/memory?userId=${uid}&limit=${limit}`, {
    headers: { 'x-api-key': settings.apiKey || '' }
  });

  if (!res.ok) throw new Error(`Get failed: ${res.status}`);
  return res.json();
}

async function deleteMemory(id) {
  const settings = await getSettings();
  const res = await fetch(`${API_BASE}/memory/${id}`, {
    method: 'DELETE',
    headers: { 'x-api-key': settings.apiKey || '' }
  });
  if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
  return res.json();
}

async function updateMemory(id, updates) {
  const settings = await getSettings();
  const res = await fetch(`${API_BASE}/memory/${id}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': settings.apiKey || ''
    },
    body: JSON.stringify(updates)
  });
  if (!res.ok) throw new Error(`Update failed: ${res.status}`);
  return res.json();
}

async function checkHealth() {
  try {
    const res = await fetch(`${API_BASE}/health`);
    return res.json();
  } catch {
    return { status: 'offline' };
  }
}

// ─── Settings ─────────────────────────────────────────────────────────────────
async function getSettings() {
  return new Promise(resolve => {
    chrome.storage.local.get(['mbSettings'], async result => {
      if (result.mbSettings) {
        resolve(result.mbSettings);
      } else {
        const defaults = {
          userId: 'user_' + Math.random().toString(36).slice(2, 9),
          apiKey: '',
          autoCapture: true,
          autoInject: true,
          injectionDelay: 500,
          showBadge: true,
          captureThreshold: 20
        };
        await chrome.storage.local.set({ mbSettings: defaults });
        resolve(defaults);
      }
    });
  });
}

async function saveSettings(settings) {
  return new Promise(resolve => {
    chrome.storage.local.set({ mbSettings: settings }, () => resolve({ ok: true }));
  });
}

// ─── Badge ────────────────────────────────────────────────────────────────────
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete') {
    const settings = await getSettings();
    if (!settings.showBadge) return;

    const supportedHosts = ['claude.ai', 'chatgpt.com', 'chat.openai.com', 'gemini.google.com'];
    const isSupported = supportedHosts.some(h => tab.url?.includes(h));

    if (isSupported) {
      chrome.action.setBadgeText({ tabId, text: '●' });
      chrome.action.setBadgeBackgroundColor({ tabId, color: '#6366f1' });
    } else {
      chrome.action.setBadgeText({ tabId, text: '' });
    }
  }
});
