"""Queues today's most-covered news stories for research (Build Queue, START HERE item 7).

    python -I scripts\\gdelt.py              fetch, then queue the top 20 stories
    python -I scripts\\gdelt.py --dry-run    fetch and print, queue nothing
    python -I scripts\\gdelt.py --top 30 --country UK

GDELT (free, no key) lists articles it saw in the last 24 hours. Headlines about the same story
are grouped, and each story is ranked by how many different outlets carried it: sampled by
reach, never by viewpoint. That reach is news coverage only, not social sharing; every queued
entry says so. Stories already in the library are skipped by the server (queue_add).
GDELT asks for at most one request every 5 seconds; this waits 6.
Doesn't call the Claude API.
"""

import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GDELT = "https://api.gdeltproject.org/api/v2/doc/doc"
WAIT_SECONDS = 6
CHUNK = 10  # queue_add takes 10 at a time

STOP = set("""
about above after again against also among amid amidst another around asks back been before being
below between both could does doing down during each even every from further have having here
into just know like made make many more most much must near news next only other over said says
should since some still such than that their them then there these they this those through today
under until update updates upon very want week what when where which while will with without would
year years your live watch video photos breaking report reports amid""".split())


def settings():
    values = {}
    for line in (ROOT / ".env").read_text(encoding="utf-8").splitlines():
        match = re.match(r"^(\w+)=(.*)$", line)
        if match:
            values[match.group(1)] = match.group(2).strip()
    return values


def fetch_window(country, start, end):
    query = {
        "query": f"sourcecountry:{country} sourcelang:english",
        "mode": "ArtList",
        "format": "json",
        "maxrecords": "250",
        "sort": "HybridRel",
        "startdatetime": start.strftime("%Y%m%d%H%M%S"),
        "enddatetime": end.strftime("%Y%m%d%H%M%S"),
    }
    url = f"{GDELT}?{urllib.parse.urlencode(query)}"
    request = urllib.request.Request(url, headers={"User-Agent": "TeemVerify research queue"})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                body = response.read().decode("utf-8", errors="replace")
            break
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as error:
            # GDELT refuses ("too many requests") or stalls when busy: wait longer each time,
            # then stop: when GDELT is busy, the other slices of the day get refused too.
            if attempt == 3:
                print(f"GDELT busy at {start:%H:%M}-{end:%H:%M} UTC ({error}); try again later.", file=sys.stderr)
                return None
            time.sleep(30 * (attempt + 1))
    try:
        return json.loads(body).get("articles", [])
    except json.JSONDecodeError:
        # GDELT answers rate limits and bad queries with a plain-text message.
        print(f"GDELT said: {body[:200]}", file=sys.stderr)
        return []


def clean_title(title):
    # GDELT spaces out punctuation: "Senate , House : vote".
    title = re.sub(r"\s+([,:;.!?%])", r"\1", title or "")
    title = re.sub(r"\s*'\s*", "'", title)
    title = re.sub(r"\s+", " ", title).strip()
    # Drop a trailing outlet name: "... - CNN", "... | Fox News".
    title = re.sub(r"\s+[-|–—]\s+[^-|–—]{2,40}$", "", title)
    return title


def words(title):
    return {w for w in re.findall(r"[a-z0-9']+", title.lower()) if len(w) > 3 and w not in STOP}


def usable(title):
    lowered = title.lower()
    if len(title.split()) < 6 or title.endswith("?"):
        return False
    if lowered.startswith("live") or "live scores" in lowered:
        return False
    return not any(s in lowered for s in ("live updates", "live:", "quiz", "horoscope", "crossword", "recipe"))


def cluster(articles):
    """Groups headlines that share at least 3 distinctive words, or half their words."""
    groups = []
    for article in articles:
        tokens = words(article["title"])
        if len(tokens) < 3:
            continue
        for group in groups:
            shared = len(tokens & group["tokens"])
            if shared >= 3 or shared / min(len(tokens), len(group["tokens"])) >= 0.5:
                group["articles"].append(article)
                break
        else:
            groups.append({"tokens": tokens, "articles": [article]})
    return groups


def representative(group):
    """The headline that shares the most words with the rest of its story."""
    articles = group["articles"]
    return max(articles, key=lambda a: sum(len(words(a["title"]) & words(b["title"])) for b in articles))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--top", type=int, default=20, help="stories to queue (default 20)")
    parser.add_argument("--country", default="US", help="GDELT source country code (default US)")
    parser.add_argument("--windows", type=int, default=4, help="slices of the last 24 hours (default 4)")
    parser.add_argument("--dry-run", action="store_true", help="print the stories, queue nothing")
    args = parser.parse_args()

    end = datetime.now(timezone.utc).replace(microsecond=0)
    span = timedelta(hours=24) / args.windows
    seen_urls, articles = set(), []
    for i in range(args.windows):
        if i:
            time.sleep(WAIT_SECONDS)
        window_end = end - span * i
        fetched = fetch_window(args.country, window_end - span, window_end)
        if fetched is None:
            break
        for article in fetched:
            title = clean_title(article.get("title", ""))
            if article.get("url") in seen_urls or not usable(title):
                continue
            seen_urls.add(article.get("url"))
            articles.append({"title": title, "url": article.get("url"), "domain": article.get("domain", "")})
    print(f"GDELT: {len(articles)} usable headlines in the last 24 hours ({args.country}).")

    groups = cluster(articles)
    for group in groups:
        group["outlets"] = sorted({a["domain"] for a in group["articles"]})
    groups.sort(key=lambda g: (len(g["outlets"]), len(g["articles"])), reverse=True)

    entries = []
    for group in groups[: args.top]:
        lead = representative(group)
        examples, domains = [], set()
        for article in group["articles"]:
            if article["domain"] not in domains and len(examples) < 3:
                domains.add(article["domain"])
                examples.append(article["url"])
        entries.append({
            "text": lead["title"],
            "url": lead["url"],
            "source": "gdelt",
            "priority": len(group["outlets"]),
            "reach": {
                "signal": "gdelt_outlets",
                "outlets": len(group["outlets"]),
                "articles": len(group["articles"]),
                "window_hours": 24,
                "country": args.country,
                "fetched_at": end.isoformat(),
                "examples": examples,
                "limit": "News coverage only (outlets that carried the story), not social sharing.",
            },
        })

    for entry in entries:
        print(f"  {entry['reach']['outlets']:>3} outlets  {entry['text']}")
    if args.dry_run or not entries:
        return

    config = settings()
    totals = {}
    for start in range(0, len(entries), CHUNK):
        body = json.dumps({"action": "queue_add", "entries": entries[start:start + CHUNK]}).encode("utf-8")
        request = urllib.request.Request(
            f"{config['SUPABASE_URL']}/functions/v1/verify-api",
            data=body,
            method="POST",
            headers={"Content-Type": "application/json; charset=utf-8", "x-teemverify-token": config["TEEMVERIFY_TOKEN"]},
        )
        try:
            with urllib.request.urlopen(request, timeout=300) as response:
                reply = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            print(f"Not queued: {error.read().decode('utf-8', errors='replace')}", file=sys.stderr)
            continue
        for added in reply.get("added", []):
            totals[added["result"]] = totals.get(added["result"], 0) + 1
    print("Queue: " + ", ".join(f"{count} {result.replace('_', ' ')}" for result, count in totals.items()))


if __name__ == "__main__":
    main()
