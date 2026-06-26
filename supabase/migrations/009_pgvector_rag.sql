-- Enable the pgvector extension for Supabase
create extension if not exists vector;

-- Add embedding vector column to coach messages
alter table public.coach_messages
add column if not exists embedding vector(1536);

-- Create a background RPC to search related historical context
create or replace function match_coach_messages(
  query_embedding vector(1536),
  match_threshold float,
  match_count int,
  p_user_id uuid,
  p_session_id uuid
)
returns table (
  id uuid,
  content text,
  role text,
  similarity float
)
language sql stable
as $$
  select
    coach_messages.id,
    coach_messages.content,
    coach_messages.role,
    1 - (coach_messages.embedding <=> query_embedding) as similarity
  from coach_messages
  where coach_messages.user_id = p_user_id
    and coach_messages.session_id = p_session_id
    and 1 - (coach_messages.embedding <=> query_embedding) > match_threshold
  order by coach_messages.embedding <=> query_embedding
  limit match_count;
$$;
