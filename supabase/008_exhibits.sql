-- TeemVerify: whole before parts (exhibit mode). Safe to re-run.
-- An exhibit (an email, document, screenshot of a post, quote card, chart) is graded once, on
-- provenance: is it real, unaltered and correctly attributed? Its contents are quoted speech,
-- not the poster's claims, so they aren't split into sentences.

-- A provenance block is an ordinary block (tier, reason, exhibits, history) whose claim is
-- "This is a real <thing> from <source>, written by <author>, on <date>", plus the details the
-- exhibit card shows: type, status, authentic, unaltered, who and when, original and file ID.
alter table blocks add column if not exists provenance jsonb;

-- How the image look classified each image: 'exhibit', 'own_words' (a meme or text the poster
-- asserts) or 'none'. Null for images read before exhibit mode; they're looked at again once.
alter table image_memory add column if not exists unit text;
alter table image_memory drop constraint if exists image_memory_unit_check;
alter table image_memory add constraint image_memory_unit_check
  check (unit is null or unit in ('exhibit', 'own_words', 'none'));
-- What the exhibit says it is (type, author, date, source, identifiers), before any check.
alter table image_memory add column if not exists exhibit jsonb;
-- The provenance block, once checked: a repeat sighting of the image reuses it for free.
alter table image_memory add column if not exists block_id uuid references blocks (id);

-- An exhibit sent to the research queue ("Research this") carries its image.
alter table claim_queue add column if not exists image_url text;

alter table api_spend drop constraint if exists api_spend_purpose_check;
alter table api_spend add constraint api_spend_purpose_check
  check (purpose in ('compare', 'check', 'triage', 'image', 'recheck', 'exhibit'));
