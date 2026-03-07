import OpenAI from 'openai';
import axios from 'axios';

const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

// Primary model dimensions are 1536 (set in Supabase schema)
const PRIMARY_MODEL = 'text-embedding-3-small';

/**
 * Creates vector embeddings for text.
 * Tries OpenAI first, then falls back to OpenRouter.
 * 
 * IMPORTANT: Mixing embedding models in one database will make search results inaccurate.
 * If you switch models permanently, you should clear your 'memories' table.
 */
export async function embed(text) {
  if (!text || typeof text !== 'string') throw new Error('embed() requires a non-empty string');
  const truncated = text.slice(0, 32000);

  // 1. Try OpenAI (Primary)
  if (openai) {
    try {
      const res = await openai.embeddings.create({
        model: PRIMARY_MODEL,
        input: truncated,
        encoding_format: 'float'
      });
      return res.data[0].embedding;
    } catch (err) {
      if (err.message?.includes('insufficient_quota') || err.status === 402 || err.status === 429) {
        console.warn('[Embed] OpenAI quota/limit reached, trying OpenRouter fallback...');
      } else {
        console.error('[Embed] OpenAI error:', err.message);
      }
    }
  }

  // 2. Try OpenRouter (Fallback)
  if (process.env.OPENROUTER_API_KEY) {
    try {
      // We try to use the same model via OpenRouter if possible, 
      // or a compatible 1536-dim model.
      const res = await axios.post('https://openrouter.ai/api/v1/embeddings', {
        model: 'openai/text-embedding-3-small', // OpenRouter's proxy for OpenAI
        input: truncated
      }, {
        headers: {
          'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'HTTP-Referer': 'http://localhost:3000',
          'X-Title': 'MemoryBridge'
        }
      });

      // OpenRouter format for embeddings matches OpenAI
      const embedding = res.data.data[0].embedding;
      
      // Safety check: ensure it matches the 1536 dims required by your Supabase table
      if (embedding.length !== 1536) {
        console.warn(`[Embed] Warning: embedding length ${embedding.length} doesn't match 1536. DB might error.`);
      }
      return embedding;
    } catch (err) {
      console.error('[Embed] OpenRouter fallback failed:', err.response?.data || err.message);
    }
  }

  throw new Error('All embedding providers failed (Quota exceeded or keys missing)');
}

/**
 * Embeds multiple strings in one batch.
 */
export async function embedBatch(texts) {
  const truncated = texts.map(t => t.slice(0, 32000));

  // 1. Try OpenAI
  if (openai) {
    try {
      const res = await openai.embeddings.create({
        model: PRIMARY_MODEL,
        input: truncated,
        encoding_format: 'float'
      });
      return res.data.map(d => d.embedding);
    } catch (err) {
      console.warn('[EmbedBatch] OpenAI failed, trying OpenRouter fallback...');
    }
  }

  // 2. Try OpenRouter
  if (process.env.OPENROUTER_API_KEY) {
    try {
      const res = await axios.post('https://openrouter.ai/api/v1/embeddings', {
        model: 'openai/text-embedding-3-small',
        input: truncated
      }, {
        headers: {
          'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`
        }
      });
      return res.data.data.map(d => d.embedding);
    } catch (err) {
      console.error('[EmbedBatch] All fallbacks failed');
    }
  }

  throw new Error('All embedding batch providers failed');
}
