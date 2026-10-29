-- TeemVerify spending log: one row per Claude call, so the daily cap can be enforced.
-- Safe to re-run.

create table if not exists api_spend (
  id             uuid primary key default gen_random_uuid(),
  purpose        text not null check (purpose in ('compare', 'check')),
  model          text not null,
  input_tokens   integer not null default 0,
  output_tokens  integer not null default 0,
  web_searches   integer not null default 0,
  cost_usd       numeric(10, 5) not null,
  created_at     timestamptz not null default now()
);

create index if not exists api_spend_created_at_idx on api_spend (created_at);

alter table api_spend enable row level security;

-- Forecasts often have no inferable resolve-by date, so it can't be required.
alter table non_fact_tags drop constraint if exists non_fact_tags_check;
