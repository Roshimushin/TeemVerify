-- TeemVerify: remember what each image says, so every image is read only once.
-- Safe to re-run.

create table if not exists image_memory (
  image_url   text primary key,
  has_text    boolean not null,
  -- Exact transcription of readable text, in reading order. Null when there is none.
  text        text,
  -- One-line description of the image, for the reader's context (not graded).
  description text,
  seen_count  integer not null default 1,
  first_seen  timestamptz not null default now(),
  last_seen   timestamptz not null default now()
);

alter table image_memory enable row level security;

alter table api_spend drop constraint if exists api_spend_purpose_check;
alter table api_spend add constraint api_spend_purpose_check
  check (purpose in ('compare', 'check', 'triage', 'image'));
