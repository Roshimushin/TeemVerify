# TeemVerify

A personal prototype of Verify, part of Teemplay: a Chrome extension that labels claims on the pages you read with four tiers.

- **Tier 1:** verified
- **Tier 2:** good-faith conclusion
- **Tier 3:** unverified
- **Tier 4:** refuted

Every check and every piece of reviewer feedback is saved to a block store (Supabase Postgres with pgvector), which is meant to grow into the real fact library.

**Status:** early prototype, desktop Chrome only, single user. All labels are AI drafts until a person reviews them.

## Layout

- `supabase/`: database scripts for the block store.

## License

GNU Affero General Public License v3.0 (AGPL-3.0), see `LICENSE`. Anyone who shares a modified version, including running it as a hosted service, must publish their changes, so every fork shows how it grades claims.
