-- Act vs. form vs. intent (Build Queue, START HERE item 3).
-- A label that implies intent ("X gave a Nazi salute") splits into three layers, each its own item:
-- form (what was said or done, can be Tier 1), meaning (what it's called, usually Tier 2, with
-- each side's views) and intent (ungraded unless self-documented, with the dated pattern).
-- Only adds columns; existing blocks, reviewed or not, are left as they are.

alter table blocks
  add column if not exists layer   text check (layer is null or layer in ('form', 'meaning', 'intent')),
  -- The label or term the layers split, the same on each layer ("Nazi salute").
  add column if not exists label   text,
  -- A charged term in the claim's words (language layer), whatever the intent.
  add column if not exists charged text,
  -- Meaning layer: {"views": [{position, held_by, size, url}]}. Intent layer: {"pattern": [{date, action, url}]}.
  add column if not exists context jsonb;

-- Inferred intent is never tiered, so it's stored with the other non-fact statements.
alter table non_fact_tags drop constraint if exists non_fact_tags_tag_check;
alter table non_fact_tags add constraint non_fact_tags_tag_check
  check (tag in ('value', 'opinion', 'forecast', 'intent'));

alter table non_fact_tags
  add column if not exists layer   text check (layer is null or layer in ('form', 'meaning', 'intent')),
  add column if not exists label   text,
  add column if not exists charged text,
  add column if not exists context jsonb;
