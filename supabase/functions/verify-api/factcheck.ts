// Live lookups in Google Fact Check Tools (claims:search), to find what admitted fact-checkers
// have already published on a claim before Claude researches it. Google's API terms (section 5e)
// forbid building a database from its results, so nothing from here is stored: results go to
// Claude as leads to open, and only what Claude then cites (a link) is kept, like any exhibit.
// Needs the GOOGLE_FACTCHECK_KEY secret; without it, lookups return nothing and checks carry on.

import { admittedFactChecker } from "./sources.ts";

const ENDPOINT = "https://factchecktools.googleapis.com/v1alpha1/claims:search";
const MAX_LEADS = 4;

export type FactCheckLead = {
  outlet: string;
  url: string;
  claim: string;
  claimant: string | null;
  rating: string | null;
  published: string | null;
};

export async function findFactChecks(text: string): Promise<FactCheckLead[]> {
  const key = Deno.env.get("GOOGLE_FACTCHECK_KEY");
  if (!key || !text.trim()) return [];
  const params = new URLSearchParams({ query: text.trim().slice(0, 300), languageCode: "en", pageSize: "20", key });
  try {
    const response = await fetch(`${ENDPOINT}?${params}`, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) {
      console.error(`Fact Check Tools: HTTP ${response.status}`);
      return [];
    }
    const data = await response.json();
    const leads: FactCheckLead[] = [];
    for (const claim of data.claims ?? []) {
      for (const review of claim.claimReview ?? []) {
        // Admitted fact-checkers only (SOURCES.md).
        const outlet = admittedFactChecker(review.url ?? "");
        if (!outlet || leads.some((l) => l.url === review.url)) continue;
        leads.push({
          outlet,
          url: review.url,
          claim: claim.text ?? "",
          claimant: claim.claimant ?? null,
          rating: review.textualRating ?? null,
          published: review.reviewDate?.slice(0, 10) ?? null,
        });
      }
    }
    return leads.slice(0, MAX_LEADS);
  } catch (err) {
    console.error("Fact Check Tools lookup failed", err);
    return [];
  }
}

// Leads for several texts at once, as a block of text for Claude's request ("" when none).
export async function factCheckLeads(texts: string[]): Promise<string> {
  const found = await Promise.all(texts.map(findFactChecks));
  if (!found.some((leads) => leads.length)) return "";
  const lines = found.map((leads, i) => leads.length ? `${i}. ${JSON.stringify(leads)}` : `${i}. none found`);
  return "\n\nFact-checks by admitted outlets found in Google Fact Check Tools (leads to open and " +
    "follow to the primary record; the claim each one checked may differ from the sentence, so " +
    "use only those about the same claim):\n" + lines.join("\n");
}
