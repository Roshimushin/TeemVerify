-- TeemVerify: remember every sentence, and queue unknown claims for later research.
-- Safe to re-run.

-- Every sentence ever looked up, with its outcome, so nothing is paid for twice.
-- Keyed by a fingerprint of the normalized sentence text.
create table if not exists sentence_memory (
  sentence_hash  text primary key,
  sentence_text  text not null,
  -- "claim", "value", "opinion", "forecast", "not_a_claim" or "mixed"
  kind           text not null,
  -- The items returned for this sentence (same shape as a check result).
  outcome        jsonb not null,
  -- True while it holds claims waiting in the queue.
  pending        boolean not null default false,
  seen_count     integer not null default 1,
  first_seen     timestamptz not null default now(),
  last_seen      timestamptz not null default now()
);

-- Claims waiting for research. Claude Code sessions on Becket's subscription work through
-- this, most-seen first; the extension's "Check now" button can also jump the queue.
create table if not exists claim_queue (
  id             uuid primary key default gen_random_uuid(),
  sentence_hash  text not null unique references sentence_memory (sentence_hash),
  sentence_text  text not null,
  page_url       text,
  status         text not null default 'queued' check (status in ('queued', 'done', 'failed')),
  seen_count     integer not null default 1,
  queued_at      timestamptz not null default now(),
  done_at        timestamptz,
  note           text
);

create index if not exists claim_queue_status_idx on claim_queue (status, seen_count desc, queued_at);

-- Non-fact statements get meaning search too, so near-identical opinions are reused.
alter table non_fact_tags add column if not exists embedding extensions.vector(384);
create index if not exists non_fact_tags_embedding_idx on non_fact_tags
  using hnsw (embedding extensions.vector_cosine_ops);

create or replace function match_non_facts(
  query_embedding extensions.vector(384),
  match_threshold float default 0.95,
  match_count     int default 1
)
returns table (id uuid, statement_text text, tag text, similarity float)
language sql stable
set search_path = public, extensions
as $$
  select n.id, n.statement_text, n.tag, 1 - (n.embedding <=> query_embedding) as similarity
  from non_fact_tags n
  where n.embedding is not null
    and 1 - (n.embedding <=> query_embedding) >= match_threshold
  order by n.embedding <=> query_embedding
  limit match_count;
$$;

-- Spending log now covers the cheap first pass too.
alter table api_spend drop constraint if exists api_spend_purpose_check;
alter table api_spend add constraint api_spend_purpose_check
  check (purpose in ('compare', 'check', 'triage'));

alter table sentence_memory enable row level security;
alter table claim_queue enable row level security;
