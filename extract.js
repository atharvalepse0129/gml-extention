import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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
- If nothing meaningful to remember, return importance: 1 and empty facts array
- Return ONLY valid JSON, no preamble`;

export async function extractFacts(conversationText) {
  try {
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001', // Fast + cheap
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
    // Strip any markdown fences
    const cleaned = raw.replace(/```json\n?|\n?```/g, '').trim();
    return JSON.parse(cleaned);
  } catch (err) {
    console.error('[Extract] Failed:', err.message);
    return { type: 'conversation', facts: [], summary: '', importance: 1 };
  }
}
