-- TeemVerify Part 4: Becket's feedback on cards. Safe to re-run.

-- A challenge can bring a link as well as a note. The link becomes an exhibit only if the
-- re-check uses it, so its source type is judged rather than guessed.
alter table challenges add column if not exists link text;
-- Tier before and after the re-check, so the outcome reads at a glance.
alter table challenges add column if not exists old_tier smallint;
alter table challenges add column if not exists new_tier smallint;

-- Every change to a claim's wording. Append-only, like tier_history.
create table if not exists wording_history (
  id          uuid primary key default gen_random_uuid(),
  block_id    uuid not null references blocks (id),
  old_text    text not null,
  new_text    text not null,
  actor       text not null, -- 'becket', 'model' or 'claude_code'
  note        text,
  created_at  timestamptz not null default now()
);

drop trigger if exists wording_history_append_only on wording_history;
create trigger wording_history_append_only before update or delete on wording_history
  for each row execute function block_tier_history_changes();

alter table wording_history enable row level security;

-- Becket's picks ("Research this") go to the front of the research queue
-- (Fact Library Rules, "Choosing what to build first").
alter table claim_queue add column if not exists picked_at timestamptz;
drop index if exists claim_queue_status_idx;
create index if not exists claim_queue_order_idx on claim_queue (status, picked_at desc nulls last, seen_count desc, queued_at);

-- Spending log covers re-checks after a challenge, and image reading (already logged as 'image').
alter table api_spend drop constraint if exists api_spend_purpose_check;
alter table api_spend add constraint api_spend_purpose_check
  check (purpose in ('compare', 'check', 'triage', 'image', 'recheck'));
