# 🧠 MemoryBridge

**Cross-LLM persistent memory layer for Claude, ChatGPT, and Gemini.**

MemoryBridge captures what you discuss with any AI, extracts key facts using Claude, stores them as semantic vectors in Supabase, and automatically injects relevant context when you switch between models — so you never repeat yourself.

---

## Architecture

```
Chrome Extension
  ├── content.js        → Intercepts prompts/responses on Claude, ChatGPT, Gemini
  ├── background.js     → Relay between content scripts and backend
  ├── popup.html        → Quick memory viewer in the extension badge
  └── pages/dashboard.html → Full memory management UI

Backend (Node.js)
  ├── server.js         → Express API on :3000
  ├── routes/memory.js  → CRUD + search endpoints
  ├── lib/extract.js    → Anthropic Claude extracts structured facts
  ├── lib/embed.js      → OpenAI generates 1536-dim embeddings
  └── lib/supabase.js   → pgvector semantic search + storage
```

---

## Setup

### 1. Supabase

1. Create a project at [supabase.com](https://supabase.com)
2. In the **SQL Editor**, run the contents of `backend/supabase-migration.sql`
3. Copy your **Project URL** and **Service Role Key** (Settings → API)

### 2. Backend

```bash
cd backend
cp .env.example .env
# Fill in: SUPABASE_URL, SUPABASE_SERVICE_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY
npm install
npm run dev
```

Verify it's running: http://localhost:3000/api/health

### 3. Chrome Extension

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the `extension/` folder
5. The 🧠 icon will appear in your toolbar

### 4. Configure

1. Click the extension icon → **Open Dashboard**
2. Go to **Settings**
3. Enter your User ID (any string, e.g. `alice@company.com`)
4. Optionally set an API key if you set `MB_API_KEY` in `.env`
5. Save

---

## How It Works

### Memory Capture
When you chat on Claude/ChatGPT/Gemini:
1. The extension detects your prompt and the AI response
2. After the response completes (3s debounce), it calls `POST /api/memory`
3. Backend runs **Anthropic extraction** → structured facts + importance score
4. Backend generates **OpenAI embedding** → 1536-dim vector
5. Stored in Supabase with metadata (model, visibility, timestamp)

### Memory Injection
When you type a new prompt on any supported site:
1. Extension calls `POST /api/memory/search` with your prompt text
2. Backend embeds your prompt and does **pgvector cosine similarity search**
3. Top 5 most relevant memories are returned
4. Extension **prepends them** to your prompt as context:
   ```
   [MemoryBridge Context:
   - You prefer concise, bullet-pointed answers
   - Project deadline is June 10
   ]
   Your actual message here...
   ```

### Manual Controls
- **Ctrl+Shift+M** → Open memory panel on any AI site
- Toggle **auto-capture** / **auto-inject** independently
- Click **+ Inject** in the panel to manually add a specific memory

---

## API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/memory` | Save a memory (auto-embeds + extracts) |
| `POST` | `/api/memory/search` | Semantic similarity search |
| `GET` | `/api/memory?userId=...` | List all memories |
| `DELETE` | `/api/memory/:id` | Delete a memory |
| `PUT` | `/api/memory/:id` | Update visibility/content |
| `GET` | `/api/health` | Backend health check |

### POST /api/memory
```json
{
  "content": "User wants vegetarian recipes, prefers Indian cuisine",
  "model": "claude",
  "type": "preference",
  "visibility": "private",
  "userId": "alice@example.com"
}
```

### POST /api/memory/search
```json
{
  "query": "what food does the user like?",
  "userId": "alice@example.com",
  "topK": 5
}
```

---

## Visibility Levels

| Level | Meaning |
|-------|---------|
| `private` | Only visible to your user account |
| `cross-model` | Injected across all models (Claude, ChatGPT, Gemini) |
| `team` | Shared with your team workspace (future) |

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Shift+M` | Toggle memory panel on any AI site |

---

## Roadmap

- [ ] Team workspaces + shared memories
- [ ] Memory importance decay / auto-cleanup
- [ ] On-device encrypted memory option
- [ ] Firefox extension support
- [ ] SDK for custom LLM integrations
- [ ] Memory graph visualization
