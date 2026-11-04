-- Daily research batch (Build Queue, START HERE item 7).
-- Fetchers (GDELT now; Reddit and Imgur once Becket has created those apps) add candidate claims
-- to claim_queue, which is the brief's research_queue. A /research-batch run in Claude Code works
-- through it toward a block target and writes a report to Notion; each run is logged here.

-- Where a trending candidate came from, and the reach signal that ranked it.
alter table claim_queue add column if not exists source text;
alter table claim_queue add column if not exists reach jsonb;

-- "skipped": already in the library (near-identical claim), so not researched again.
alter table claim_queue drop constraint if exists claim_queue_status_check;
alter table claim_queue add constraint claim_queue_status_check
  check (status in ('queued', 'done', 'failed', 'skipped'));

create table if not exists research_batches (
  id            uuid primary key default gen_random_uuid(),
  started_at    timestamptz not null,
  finished_at   timestamptz not null default now(),
  block_target  integer,
  -- Counts from batch_stats: blocks created by tier, seed claims revised, queue entries finished.
  stats         jsonb not null,
  notion_url    text,
  note          text
);

alter table research_batches enable row level security;
