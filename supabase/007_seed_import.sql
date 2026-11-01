-- TeemVerify: fact-checker seed import (Build Queue item "Fact-checker seed import + intake
-- priority"). Safe to re-run.

-- One published fact-check, as its outlet marked it up (ClaimReview). Only admitted
-- fact-checkers (SOURCES.md) are imported. The verdict is stored as a Tier 2 block, with the
-- fact-check as its exhibit; research then follows it to the primary record.
create table if not exists seed_reviews (
  id                  uuid primary key default gen_random_uuid(),
  -- 'datacommons': the Data Commons fact-check feed (CC BY 4.0).
  -- 'outlet_page': the ClaimReview markup on the outlet's own page.
  source              text not null check (source in ('datacommons', 'outlet_page')),
  outlet              text not null,
  review_url          text not null,
  review_date         date,
  claim_reviewed      text not null,
  claimant            text,
  claim_date          date,
  -- Where the claim was made, per the outlet: evidence that it was said, not that it's true.
  appearance_url      text,
  rating              text,
  rating_explanation  text,
  license             text not null,
  block_id            uuid references blocks (id),
  imported_at         timestamptz not null default now()
);

-- One article can check several claims.
alter table seed_reviews drop constraint if exists seed_reviews_review_url_key;
create unique index if not exists seed_reviews_review_claim_idx on seed_reviews (review_url, claim_reviewed);

alter table seed_reviews enable row level security;

-- Where a queued claim came from. Becket's picks are marked by picked_at, as before.
alter table claim_queue add column if not exists stream text not null default 'page';
alter table claim_queue drop constraint if exists claim_queue_stream_check;
alter table claim_queue add constraint claim_queue_stream_check
  check (stream in ('page', 'fact_checker_seed', 'trending'));
alter table claim_queue add column if not exists seed_review_id uuid references seed_reviews (id);
-- Order among claims seen equally often. Seeds are interleaved across outlets, newest first,
-- so research pulls evenly from every outlet rather than from whichever published most.
alter table claim_queue add column if not exists priority real not null default 0;

drop index if exists claim_queue_order_idx;
create index if not exists claim_queue_order_idx
  on claim_queue (status, picked_at desc nulls last, seen_count desc, priority desc, queued_at);
