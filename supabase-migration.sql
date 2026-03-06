-- MemoryBridge — Supabase Schema Setup
-- Run this in your Supabase SQL editor

-- 1. Enable pgvector extension
create extension if not exists vector;

-- 2. Memories table
create table if not exists memories (
  id            uuid primary key default gen_random_uuid(),
  user_id       text not null,
  content       text not null,
  type          text not null default 'conversation',   -- conversation | preference | fact | task
  source_model  text,                                   -- claude | chatgpt | gemini
  visibility    text not null default 'private',        -- private | cross-model | team
  embedding     vector(1536),                           -- text-embedding-3-small dims
  extracted_facts jsonb,                                -- { type, facts[], summary, importance }
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- 3. Indexes
create index if not exists memories_user_id_idx on memories(user_id);
create index if not exists memories_created_at_idx on memories(created_at desc);
create index if not exists memories_type_idx on memories(type);
create index if not exists memories_source_model_idx on memories(source_model);

-- 4. Vector index for fast ANN search (cosine distance)
create index if not exists memories_embedding_idx
  on memories using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

-- 5. RLS (Row Level Security) — optional but recommended
alter table memories enable row level security;

-- Allow service role full access (used by our backend)
create policy "Service role full access"
  on memories
  using (true)
  with check (true);

-- 6. Semantic search RPC function
create or replace function search_memories(
  query_embedding   vector(1536),
  p_user_id         text,
  match_count       int      default 5,
  filter_visibility text     default null,
  filter_model      text     default null
)
returns table (
  id              uuid,
  user_id         text,
  content         text,
  type            text,
  source_model    text,
  visibility      text,
  extracted_facts jsonb,
  created_at      timestamptz,
  similarity      float
)
language plpgsql
as $$
begin
  return query
  select
    m.id,
    m.user_id,
    m.content,
    m.type,
    m.source_model,
    m.visibility,
    m.extracted_facts,
    m.created_at,
    1 - (m.embedding <=> query_embedding) as similarity
  from memories m
  where
    m.user_id = p_user_id
    and (filter_visibility is null or m.visibility = filter_visibility)
    and (filter_model is null or m.source_model = filter_model)
  order by m.embedding <=> query_embedding
  limit match_count;
end;
$$;

-- 7. Auto-update updated_at
create or replace function update_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger memories_updated_at
  before update on memories
  for each row execute function update_updated_at();
