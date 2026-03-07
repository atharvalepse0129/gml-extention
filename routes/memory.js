import { Router } from 'express';
import { embed } from '../lib/embed.js';
import { extractFacts } from '../lib/extract.js';
import {
  insertMemory,
  semanticSearch,
  getUserMemories,
  deleteMemoryById,
  updateMemoryById
} from '../lib/supabase.js';

const router = Router();

// ─── POST /api/memory — Save a new memory ─────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const { content, source, model, type, visibility, userId } = req.body;

    if (!content || !userId) {
      return res.status(400).json({ error: 'content and userId are required' });
    }

    // Run extraction and embedding in parallel
    const [extracted, embedding] = await Promise.all([
      extractFacts(content),
      embed(content)
    ]);

    // Skip low-importance memories (importance 1 = trivial chat)
    // Still save them but flag it
    const memory = await insertMemory({
      userId,
      content,
      type: extracted.type || type || 'conversation',
      sourceModel: model || 'unknown',
      visibility: visibility || 'private',
      embedding,
      extractedFacts: extracted
    });

    res.json({
      id: memory.id,
      type: memory.type,
      importance: extracted.importance,
      facts: extracted.facts,
      summary: extracted.summary
    });
  } catch (err) {
    console.error('[POST /memory]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/memory/search — Semantic search ────────────────────────────────
router.post('/search', async (req, res) => {
  try {
    const { query, userId, topK = 5, filter = {} } = req.body;

    if (!query || !userId) {
      return res.status(400).json({ error: 'query and userId are required' });
    }

    const embedding = await embed(query);
    const results = await semanticSearch({ userId, embedding, topK, filter });

    res.json({ results, count: results.length });
  } catch (err) {
    console.error('[POST /memory/search]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/memory — List memories ─────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { userId, limit = 50, offset = 0, type, model } = req.query;

    if (!userId) return res.status(400).json({ error: 'userId is required' });

    const memories = await getUserMemories({
      userId,
      limit: parseInt(limit),
      offset: parseInt(offset),
      type,
      model
    });

    res.json({ memories, count: memories.length });
  } catch (err) {
    console.error('[GET /memory]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /api/memory/:id ───────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.query.userId || req.body?.userId;

    if (!userId) return res.status(400).json({ error: 'userId required' });

    await deleteMemoryById(id, userId);
    res.json({ deleted: true, id });
  } catch (err) {
    console.error('[DELETE /memory]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── PUT /api/memory/:id ──────────────────────────────────────────────────────
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { userId, ...updates } = req.body;

    if (!userId) return res.status(400).json({ error: 'userId required' });

    const updated = await updateMemoryById(id, userId, updates);
    res.json(updated);
  } catch (err) {
    console.error('[PUT /memory]', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
