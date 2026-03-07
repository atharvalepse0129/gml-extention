import Anthropic from '@anthropic-ai/sdk';
import axios from 'axios';

const anthropicClient = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

const SYSTEM_PROMPT = `You are a memory extraction engine. Given a conversation snippet, extract key facts, preferences, and information worth remembering about the user.

Return ONLY a JSON object with this exact shape:
{
  "type": "preference" | "fact" | "task" | "conversation",
  "facts": ["concise fact 1", "concise fact 2"],
  "summary": "One-sentence summary of what happened",
  "importance": 1-5
}

Rules:
- "type" = preference if user expressed likes/dislikes, fact if factual info, task if action items, conversation otherwise
- "facts" = array of 1-5 short, standalone, reusable statements
- "importance" = 5 for critical preferences/facts, 1 for trivial chat
- Be inclusive: store anything the user says about themselves (names, hobbies, family, work, etc)
- Return ONLY valid JSON, no preamble`;

export async function extractFacts(conversationText) {
  // 1. Try Anthropic first (if key exists)
  if (anthropicClient) {
    try {
      const msg = await anthropicClient.messages.create({
        model: 'claude-3-haiku-20240307', // Common, stable endpoint
        max_tokens: 400,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: `Extract key facts from this conversation:\n\n${conversationText.slice(0, 4000)}`
          }
        ]
      });

      const raw = msg.content[0]?.text?.trim() || '{}';
      return parseJson(raw);
    } catch (err) {
      console.warn('[Extract] Anthropic failed, trying OpenRouter fallback...', err.message);
    }
  }

  // 2. Try OpenRouter (Gemini Flash Free) fallback
  if (process.env.OPENROUTER_API_KEY) {
    try {
      const res = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
        model: 'google/gemini-2.0-flash-001', // High-quality, fast, often has free versions on OpenRouter
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `Extract key facts from this conversation:\n\n${conversationText.slice(0, 4000)}` }
        ]
      }, {
        headers: {
          'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'HTTP-Referer': 'http://localhost:3000',
          'X-Title': 'MemoryBridge'
        }
      });

      const raw = res.data.choices[0]?.message?.content?.trim() || '{}';
      return parseJson(raw);
    } catch (err) {
      console.error('[Extract] OpenRouter fallback failed:', err.message);
    }
  }

  // Final fallback (do nothing)
  return { type: 'conversation', facts: [], summary: '', importance: 1 };
}

function parseJson(raw) {
    try {
        // Strip any markdown fences
        const cleaned = raw.replace(/```json\n?|\n?```/g, '').trim();
        return JSON.parse(cleaned);
    } catch (e) {
        console.error('[Extract] JSON parse failed:', e.message, 'Raw:', raw);
        return { type: 'conversation', facts: [], summary: '', importance: 1 };
    }
}
