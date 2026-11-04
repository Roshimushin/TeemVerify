-- Schema updates (Build Queue, START HERE item 4). Adds columns and tables only: no existing
-- block's claim, tier or status is changed, reviewed or not.

-- 1. Contested is a flavor of Tier 2, never a fifth tier. It needs live Tier 1 exhibits on each
--    side; thin evidence on both sides is Tier 3, not contested.
alter table blocks
  add column if not exists flavor text check (flavor is null or flavor = 'contested');
alter table blocks drop constraint if exists blocks_contested_is_tier2;
alter table blocks add constraint blocks_contested_is_tier2
  check (flavor is null or tier = 2);

-- A block that leaves Tier 2 (say one side's study is retracted) leaves "contested" with it;
-- the tier history records the move.
create or replace function blocks_flavor_follows_tier() returns trigger
language plpgsql as $$
begin
  if new.tier <> 2 then new.flavor := null; end if;
  return new;
end;
$$;

drop trigger if exists blocks_flavor_follows_tier on blocks;
create trigger blocks_flavor_follows_tier before insert or update on blocks
  for each row execute function blocks_flavor_follows_tier();

-- 2. Tier at the time of the statement. Trust signals judge a statement by the tier its claim
--    held when it was said, never by hindsight: a good-faith Tier 2 later overturned doesn't
--    count against the speaker.
alter table sightings
  add column if not exists stated_on date,           -- when the statement was made, if known
  add column if not exists tier_at_statement smallint check (tier_at_statement between 1 and 4);

-- Filled in on every new sighting: the block's tier on the day the statement was made (from the
-- tier history), or its current tier when the statement is new.
create or replace function sightings_tier_at_statement() returns trigger
language plpgsql as $$
begin
  new.stated_on := coalesce(new.stated_on, (coalesce(new.seen_at, now()))::date);
  if new.tier_at_statement is null then
    select h.new_tier into new.tier_at_statement
      from tier_history h
     where h.block_id = new.block_id and h.created_at < new.stated_on + 1
     order by h.created_at desc limit 1;
    if new.tier_at_statement is null then
      select b.tier into new.tier_at_statement from blocks b where b.id = new.block_id;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists sightings_tier_at_statement on sightings;
create trigger sightings_tier_at_statement before insert on sightings
  for each row execute function sightings_tier_at_statement();

-- Existing sightings: the tier the block held when each was seen.
update sightings s
   set stated_on = coalesce(s.stated_on, s.seen_at::date),
       tier_at_statement = coalesce(
         (select h.new_tier from tier_history h
           where h.block_id = s.block_id and h.created_at <= s.seen_at
           order by h.created_at desc limit 1),
         (select h.new_tier from tier_history h
           where h.block_id = s.block_id order by h.created_at asc limit 1),
         (select b.tier from blocks b where b.id = s.block_id))
 where s.tier_at_statement is null;

-- 3. Links between blocks. First kind: conflict of interest. "Funder F funded study S" is its own
--    Tier 1 block, shown as context on S. It flags S for a closer look at its methods; it never
--    lowers S's tier on its own.
create table if not exists block_links (
  id            uuid primary key default gen_random_uuid(),
  from_block_id uuid not null references blocks (id) on delete cascade, -- the context ("F funded S")
  to_block_id   uuid not null references blocks (id) on delete cascade, -- the block it's shown on (S)
  relation      text not null check (relation in ('coi')),
  note          text,
  actor         text not null default 'model',
  created_at    timestamptz not null default now(),
  unique (from_block_id, to_block_id, relation),
  check (from_block_id <> to_block_id)
);
create index if not exists block_links_to_idx on block_links (to_block_id, relation);

-- 4. Say-do consistency (fifth trust signal): dated pairs of what someone said and what they did.
--    Matches and gaps both count. Never labelled "hypocrite": the pair is shown, the reader judges.
create table if not exists say_do_pairs (
  id                 uuid primary key default gen_random_uuid(),
  actor              text not null,       -- the person or institution, as named on the record
  trigger            text not null check (trigger in ('credit_taking', 'accusation', 'promise', 'position')),
  statement_text     text not null,
  statement_date     date,
  statement_url      text,
  statement_block_id uuid references blocks (id) on delete set null,
  action_text        text not null,       -- e.g. "Voted no on H.R. 1234 (roll call 210)"
  action_date        date,
  action_url         text,
  action_block_id    uuid references blocks (id) on delete set null,
  relation           text not null check (relation in ('match', 'gap')),
  -- Context the pair needs to be fair: "this bill also included Y", and the stated reason.
  bundled_context    text,
  stated_reason      text,
  stated_reason_url  text,
  status             text not null default 'ai_draft' check (status in ('ai_draft', 'reviewed')),
  actor_kind         text not null default 'manual' check (actor_kind in ('manual', 'model', 'claude_code')),
  created_at         timestamptz not null default now()
);
create index if not exists say_do_pairs_actor_idx on say_do_pairs (lower(actor));

-- The signal itself: counts per actor, both directions, with the date range they cover.
create or replace view say_do_consistency with (security_invoker = true) as
select lower(actor)                              as actor_key,
       min(actor)                                as actor,
       count(*) filter (where relation = 'match') as matches,
       count(*) filter (where relation = 'gap')   as gaps,
       count(*)                                  as pairs,
       min(least(statement_date, action_date))   as from_date,
       max(greatest(statement_date, action_date)) as to_date
  from say_do_pairs
 group by lower(actor);

-- Same as the other tables: only the Edge Function (service role) reads and writes.
alter table block_links  enable row level security;
alter table say_do_pairs enable row level security;
