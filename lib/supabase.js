import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default supabase;

// ─── Memory CRUD ──────────────────────────────────────────────────────────────

export async function insertMemory({ userId, content, type, sourceModel, visibility, embedding, extractedFacts }) {
  const { data, error } = await supabase
    .from('memories')
    .insert({
      user_id: userId,
      content,
      type: type || 'conversation',
      source_model: sourceModel,
      visibility: visibility || 'private',
      embedding,
      extracted_facts: extractedFacts || null,
      created_at: new Date().toISOString()
    })
    .select()
    .single();

  if (error) throw new Error(error.message);
  return data;
}

export async function semanticSearch({ userId, embedding, topK = 5, filter = {} }) {
  // pgvector cosine similarity search via RPC
  const { data, error } = await supabase.rpc('search_memories', {
    query_embedding: embedding,
    p_user_id: userId,
    match_count: topK,
    filter_visibility: filter.visibility || null,
    filter_model: filter.model || null
  });

  if (error) throw new Error(error.message);
  return data || [];
}

export async function getUserMemories({ userId, limit = 50, offset = 0, type = null, model = null }) {
  let query = supabase
    .from('memories')
    .select('id, user_id, content, type, source_model, visibility, extracted_facts, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (type) query = query.eq('type', type);
  if (model) query = query.eq('source_model', model);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data || [];
}

export async function deleteMemoryById(id, userId) {
  const { error } = await supabase
    .from('memories')
    .delete()
    .eq('id', id)
    .eq('user_id', userId); // ensure ownership

  if (error) throw new Error(error.message);
  return { deleted: true };
}

export async function updateMemoryById(id, userId, updates) {
  const allowed = ['visibility', 'content', 'type'];
  const clean = Object.fromEntries(
    Object.entries(updates).filter(([k]) => allowed.includes(k))
  );

  const { data, error } = await supabase
    .from('memories')
    .update(clean)
    .eq('id', id)
    .eq('user_id', userId)
    .select()
    .single();

  if (error) throw new Error(error.message);
  return data;
}
