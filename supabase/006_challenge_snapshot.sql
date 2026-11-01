-- TeemVerify: nothing is thrown away. Each challenge keeps a copy of the claim as it stood
-- before the re-check (wording, tier, reason, scope, as_of and exhibits), since a re-check
-- can replace the reason and evidence without changing the tier. Safe to re-run.

alter table challenges add column if not exists previous jsonb;
