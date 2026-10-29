-- TeemVerify block store (Part 1 of the build brief).
-- Run once in the Supabase SQL Editor. Safe to re-run: it skips anything that already exists.
--
-- Embeddings come from Supabase's built-in gte-small model, which makes 384-number vectors.
-- Row level security is on with no public policies, so nothing can read or write these
-- tables from the outside. The extension will go through a Supabase Edge Function instead.

create extension if not exists vector with schema extensions;

-- Keeps updated_at current on any row change.
create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- A single checkable claim, in its most precise wording.
create table if not exists blocks (
  id          uuid primary key default gen_random_uuid(),
  claim_text  text not null,
  tier        smallint not null check (tier between 1 and 4),
  status      text not null default 'ai_draft' check (status in ('ai_draft', 'reviewed')),
  scope       text,
  as_of       date,
  -- One-line reason shown on the claim card. Not in the brief's field list; added so the card has it.
  reason      text,
  embedding   extensions.vector(384),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

drop trigger if exists blocks_updated_at on blocks;
create trigger blocks_updated_at before update on blocks
  for each row execute function set_updated_at();

create index if not exists blocks_embedding_idx on blocks
  using hnsw (embedding extensions.vector_cosine_ops);

-- A source that supports or refutes a block.
create table if not exists exhibits (
  id            uuid primary key default gen_random_uuid(),
  source_url    text not null,
  location      text,
  version_hash  text,
  retrieved_on  date not null default current_date,
  source_type   text not null check (source_type in ('primary', 'secondary', 'fact_checker', 'encyclopedia')),
  created_at    timestamptz not null default now()
);

create table if not exists block_exhibits (
  block_id    uuid not null references blocks (id) on delete cascade,
  exhibit_id  uuid not null references exhibits (id) on delete cascade,
  primary key (block_id, exhibit_id)
);

-- Every tier change, ever. Append-only: updates and deletes are blocked below.
create table if not exists tier_history (
  id          uuid primary key default gen_random_uuid(),
  block_id    uuid not null references blocks (id),
  old_tier    smallint check (old_tier between 1 and 4),
  new_tier    smallint not null check (new_tier between 1 and 4),
  reason      text,
  actor       text not null, -- 'model' or 'becket'
  created_at  timestamptz not null default now()
);

create or replace function block_tier_history_changes() returns trigger
language plpgsql as $$
begin
  raise exception 'tier_history is append-only';
end;
$$;

drop trigger if exists tier_history_append_only on tier_history;
create trigger tier_history_append_only before update or delete on tier_history
  for each row execute function block_tier_history_changes();

-- Where a claim was seen. Reuse count is the attention signal.
create table if not exists sightings (
  id           uuid primary key default gen_random_uuid(),
  block_id     uuid not null references blocks (id) on delete cascade,
  page_url     text not null,
  quoted_text  text not null,
  seen_at      timestamptz not null default now()
);

create table if not exists challenges (
  id           uuid primary key default gen_random_uuid(),
  block_id     uuid not null references blocks (id) on delete cascade,
  reason_type  text not null check (reason_type in ('new_evidence', 'wording_or_scope', 'reasoning', 'outdated')),
  note         text,
  exhibit_id   uuid references exhibits (id),
  status       text not null default 'open' check (status in ('open', 'resolved')),
  resolution   text,
  created_at   timestamptz not null default now(),
  resolved_at  timestamptz
);

-- Statements that aren't tiered: values, opinions and forecasts.
create table if not exists non_fact_tags (
  id              uuid primary key default gen_random_uuid(),
  statement_text  text not null,
  tag             text not null check (tag in ('value', 'opinion', 'forecast')),
  resolve_by      date,
  page_url        text,
  created_at      timestamptz not null default now(),
  check (tag <> 'forecast' or resolve_by is not null)
);

alter table blocks         enable row level security;
alter table exhibits       enable row level security;
alter table block_exhibits enable row level security;
alter table tier_history   enable row level security;
alter table sightings      enable row level security;
alter table challenges     enable row level security;
alter table non_fact_tags  enable row level security;

-- Finds stored blocks whose meaning is close to a sentence's embedding.
create or replace function match_blocks(
  query_embedding extensions.vector(384),
  match_threshold float default 0.85,
  match_count     int default 5
)
returns table (id uuid, claim_text text, tier smallint, status text, reason text, similarity float)
language sql stable
set search_path = public, extensions
as $$
  select b.id, b.claim_text, b.tier, b.status, b.reason,
         1 - (b.embedding <=> query_embedding) as similarity
  from blocks b
  where b.embedding is not null
    and 1 - (b.embedding <=> query_embedding) >= match_threshold
  order by b.embedding <=> query_embedding
  limit match_count;
$$;
