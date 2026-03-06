import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// text-embedding-3-small: fast, cheap, 1536 dims
const EMBED_MODEL = 'text-embedding-3-small';

export async function embed(text) {
  if (!text || typeof text !== 'string') throw new Error('embed() requires a non-empty string');

  // Truncate to ~8000 tokens max
  const truncated = text.slice(0, 32000);

  const res = await openai.embeddings.create({
    model: EMBED_MODEL,
    input: truncated,
    encoding_format: 'float'
  });

  return res.data[0].embedding;
}

export async function embedBatch(texts) {
  const res = await openai.embeddings.create({
    model: EMBED_MODEL,
    input: texts.map(t => t.slice(0, 32000)),
    encoding_format: 'float'
  });
  return res.data.map(d => d.embedding);
}
