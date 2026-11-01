"""Builds the fact-checker seed import from the Data Commons fact-check feed.

    python -I scripts/seed_datacommons.py <feed.json> <out.sql> [--since 2025-01-01]

The feed (https://datacommons.org/factcheck/download) is licensed CC BY 4.0. Only fact-checks
by admitted fact-checkers (SOURCES.md) are kept, in English. Each becomes:
  - a seed_reviews row (the outlet's verdict, with attribution),
  - a Tier 2 ai_draft block with the fact-check as its exhibit, and its tier history,
  - a sentence memory row, so pages that repeat the claim show it, and
  - a research queue entry (stream fact_checker_seed), interleaved across outlets.
Run the output with: supabase db query --linked -f <out.sql>. Re-running skips fact-checks
already imported.
"""

import argparse
import collections
import hashlib
import json
import re
import uuid

LICENSE = "CC BY 4.0, Data Commons fact-check feed (datacommons.org/factcheck)"

# Admitted fact-checkers (SOURCES.md) by web address. Keep in step with sources.ts.
ADMITTED = {
    "apnews.com": "AP Fact Check",
    "reuters.com": "Reuters Fact Check",
    "factcheck.afp.com": "AFP Fact Check",
    "politifact.com": "PolitiFact",
    "factcheck.org": "FactCheck.org",
    "snopes.com": "Snopes",
    "leadstories.com": "Lead Stories",
    "washingtonpost.com": "The Washington Post Fact Checker",
    "thedispatch.com": "The Dispatch Fact Check",
    "poynter.org": "MediaWise",
    "wisconsinwatch.org": "Wisconsin Watch",
    "fullfact.org": "Full Fact",
    "factcheckni.org": "FactCheckNI",
    "pamediagroup.com": "PA Media",
    "aap.com.au": "AAP FactCheck",
    "thecanadianpress.com": "The Canadian Press",
    "thejournal.ie": "The Journal FactCheck",
    "dw.com": "Deutsche Welle",
    "africacheck.org": "Africa Check",
    "rappler.com": "Rappler",
    "univision.com": "El Detector (Univision)",
    "telemundo.com": "T Verifica (Telemundo)",
    "factchequeado.com": "Factchequeado",
}


def outlet_for(url):
    host = url.split("/")[2].lower() if url.count("/") >= 2 else ""
    host = host.removeprefix("www.")
    for domain, name in ADMITTED.items():
        if host == domain or host.endswith("." + domain):
            return name
    return None


def looks_english(text):
    return len(text) > 0 and sum(c.isascii() for c in text) >= 0.95 * len(text)


def sentence_hash(text):
    # Same fingerprint as hash() in supabase/functions/verify-api/check.ts.
    normalized = re.sub(r"\s+", " ", text.lower()).strip()
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def short_rating(outlet, value):
    # Some outlets put their whole explanation in the rating ("DW Fact check: Unproven. There is
    # no ..."): keep just the verdict. The Washington Post rates in Pinocchios.
    if not value:
        return None
    value = re.sub(r"^\s*\w+ fact ?check:\s*", "", value.strip(), flags=re.I)
    value = re.split(r"\.\s|\s{2,}", value, maxsplit=1)[0].strip().rstrip(".")
    if outlet == "The Washington Post Fact Checker" and value in ("1", "2", "3", "4"):
        value = f"{value} Pinocchio" + ("" if value == "1" else "s")
    return value[:60] or None


def day(value):
    return value[:10] if isinstance(value, str) and re.match(r"\d{4}-\d{2}-\d{2}", value) else None


def first(value):
    return value[0] if isinstance(value, list) and value else value if isinstance(value, dict) else {}


def reviews(feed, since):
    for element in feed.get("dataFeedElement", []):
        for item in element.get("item") or []:
            if item.get("@type") != "ClaimReview":
                continue
            url = item.get("url") or ""
            outlet = outlet_for(url)
            claim = " ".join((item.get("claimReviewed") or "").split())
            date = day(item.get("datePublished"))
            # DW publishes in many languages; its English pages are under /en/.
            if outlet == "Deutsche Welle" and "/en/" not in url:
                continue
            if not outlet or not claim or not looks_english(claim) or not date or date < since:
                continue
            reviewed = first(item.get("itemReviewed"))
            rating = first(item.get("reviewRating"))
            appearance = first(reviewed.get("appearance"))
            yield {
                "outlet": outlet,
                "review_url": url,
                "review_date": date,
                "claim_reviewed": claim,
                "claimant": (first(reviewed.get("author")).get("name") or None),
                "claim_date": day(reviewed.get("datePublished")),
                "appearance_url": appearance.get("url") or None,
                "rating": short_rating(outlet, rating.get("alternateName")),
                "rating_explanation": (rating.get("ratingExplanation") or None),
            }


def build(rows):
    # The same claim checked more than once becomes one block, with every fact-check as an exhibit.
    by_claim = collections.OrderedDict()
    for row in sorted(rows, key=lambda r: r["review_date"], reverse=True):
        by_claim.setdefault(sentence_hash(row["claim_reviewed"]), []).append(row)

    # Interleave across outlets, newest first: the k-th claim of every outlet comes before the
    # (k+1)-th of any, so research pulls evenly however much each outlet published.
    outlets = sorted({group[0]["outlet"] for group in by_claim.values()})
    rank = collections.Counter()
    claims = []
    for key, group in by_claim.items():
        lead = group[0]
        position = rank[lead["outlet"]] * len(outlets) + outlets.index(lead["outlet"])
        rank[lead["outlet"]] += 1
        block_id = str(uuid.uuid4())
        verdicts = "; ".join(f'{r["outlet"]} rated it "{r["rating"] or "unrated"}" ({r["review_date"]})' for r in group)
        reason = (f"{verdicts}. A fact-checker's verdict is a Tier 2 conclusion until the primary "
                  "record is checked; this claim is queued for that research.")
        exhibits = [{"id": str(uuid.uuid4()), "url": r["review_url"], "location": f'Rating: {r["rating"] or "unrated"}',
                     "source_type": "fact_checker"} for r in group]
        claims.append({
            "hash": key,
            "text": lead["claim_reviewed"],
            "block_id": block_id,
            "reason": reason,
            "as_of": lead["review_date"],
            "priority": -position,
            "exhibits": exhibits,
            "reviews": [{**r, "id": str(uuid.uuid4())} for r in group],
        })
    return claims


SQL = """-- Generated by scripts/seed_datacommons.py. Skips fact-checks already imported.
begin;
create temp table seed_input on commit drop as
  select * from jsonb_to_recordset($seed${data}$seed$::jsonb)
    as t(hash text, text text, block_id uuid, reason text, as_of date, priority real, exhibits jsonb, reviews jsonb);

-- Only claims none of whose fact-checks are in yet.
delete from seed_input s where exists (
  select 1 from jsonb_array_elements(s.reviews) r join seed_reviews x
    on x.review_url = r->>'review_url' and x.claim_reviewed = r->>'claim_reviewed');

insert into blocks (id, claim_text, tier, status, as_of, reason)
  select block_id, text, 2, 'ai_draft', as_of, reason from seed_input;

insert into tier_history (block_id, old_tier, new_tier, reason, actor)
  select block_id, null, 2, reason, 'seed_import' from seed_input;

insert into exhibits (id, source_url, location, source_type)
  select (e->>'id')::uuid, e->>'url', e->>'location', 'fact_checker'
  from seed_input, jsonb_array_elements(exhibits) e;
insert into block_exhibits (block_id, exhibit_id)
  select block_id, (e->>'id')::uuid from seed_input, jsonb_array_elements(exhibits) e;

insert into seed_reviews (id, source, outlet, review_url, review_date, claim_reviewed, claimant, claim_date,
                          appearance_url, rating, rating_explanation, license, block_id)
  select (r->>'id')::uuid, 'datacommons', r->>'outlet', r->>'review_url', (r->>'review_date')::date,
         r->>'claim_reviewed', r->>'claimant', (r->>'claim_date')::date, r->>'appearance_url',
         r->>'rating', r->>'rating_explanation', '{license}', block_id
  from seed_input, jsonb_array_elements(reviews) r;

-- Remembered as a Tier 2 claim, so a page repeating it shows the label for free. A sentence
-- already in memory (seen on a page) keeps what it has.
insert into sentence_memory (sentence_hash, sentence_text, kind, outcome, pending, seen_count)
  select hash, text, 'claim',
         jsonb_build_array(jsonb_build_object(
           'kind', 'claim', 'text', text, 'tier', 2, 'reason', reason, 'scope', null, 'as_of', as_of,
           'resolve_by', null, 'quote', null, 'block_id', block_id,
           'exhibits', (select jsonb_agg(jsonb_build_object('url', e->>'url', 'location', e->>'location',
                                                            'source_type', 'fact_checker'))
                        from jsonb_array_elements(exhibits) e))),
         true, 0
  from seed_input
  on conflict (sentence_hash) do nothing;

-- Not seen on any page yet (seen_count 0), so claims Becket has met come first.
insert into claim_queue (sentence_hash, sentence_text, stream, seed_review_id, priority, seen_count)
  select hash, text, 'fact_checker_seed', (reviews->0->>'id')::uuid, priority, 0
  from seed_input
  on conflict (sentence_hash) do nothing;

select count(*) as claims_imported, sum(jsonb_array_length(reviews)) as fact_checks_imported from seed_input;
commit;
"""


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("feed")
    parser.add_argument("out")
    parser.add_argument("--since", default="2025-01-01")
    args = parser.parse_args()
    with open(args.feed, encoding="utf-8") as f:
        feed = json.load(f)
    claims = build(list(reviews(feed, args.since)))
    data = json.dumps(claims, ensure_ascii=False)
    if "$seed$" in data:
        raise SystemExit("feed text contains the SQL quote marker")
    with open(args.out, "w", encoding="utf-8") as f:
        f.write(SQL.replace("{data}", data).replace("{license}", LICENSE))
    counts = collections.Counter(r["outlet"] for c in claims for r in c["reviews"])
    print(f"{len(claims)} claims, {sum(counts.values())} fact-checks")
    for outlet, n in counts.most_common():
        print(f"  {n:5d}  {outlet}")


if __name__ == "__main__":
    main()
