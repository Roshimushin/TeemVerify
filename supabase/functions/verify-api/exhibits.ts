// Exhibit mode (Fact Library Rules, "Whole before parts"). An image presented as evidence (an
// email, document, screenshot of a post, quote card, chart) is graded once, on provenance: is it
// real, unaltered and correctly attributed? Its contents are quoted speech, never split into the
// poster's claims. Captions and comments about it are graded separately, as ordinary sentences.
//   check_exhibit  { image_url, url, context?, daily_cap_usd } -> researched now (about 3 cents)
//   queue_exhibit  { image_url, url }   -> "Research this": front of the research queue, free
// The image look in images.ts decides what is an exhibit; a checked exhibit is remembered by
// image address, so the same image elsewhere shows its card for free.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { ask, enqueue, exhibitsFor, hash, type Item, noEncyclopedias, remember, spentToday, today } from "./check.ts";
import { factCheckLeads } from "./factcheck.ts";
import { EXHIBIT_SCHEMA, EXHIBIT_SYSTEM } from "./prompts.ts";

type Embed = (text: string) => Promise<string>;

const MAX_EXHIBIT_SEARCHES = 5;
const MAX_EXHIBIT_FETCHES = 3;
// The words posted around the exhibit, as context for finding it (never instructions).
const MAX_CONTEXT_CHARS = 1500;

// What the image look found the exhibit claims to be (image_memory.exhibit).
export type ExhibitClaim = {
  exhibit_type: string;
  provenance_claim: string;
  author: string | null;
  recipient: string | null;
  date: string | null;
  source: string | null;
  identifiers: string[];
};

// What the exhibit card shows (blocks.provenance and item.provenance).
export type Provenance = {
  exhibit_type: string;
  status: "verified" | "altered" | "not_found" | "unchecked";
  authentic: "yes" | "no" | "unknown";
  unaltered: "yes" | "no" | "unknown";
  author: string | null;
  recipient: string | null;
  date: string | null;
  source: string | null;
  original_url: string | null;
  file_id: string | null;
  identifiers: string[];
};

type ImageRow = { image_url: string; text: string | null; description: string | null; exhibit: ExhibitClaim; block_id: string | null };

// The card item for an exhibit: its checked provenance block, or "Can't check yet".
export async function exhibitItem(supabase: SupabaseClient, row: ImageRow): Promise<Item> {
  if (row.block_id) {
    const { data: block } = await supabase.from("blocks")
      .select("id, claim_text, tier, reason, as_of, provenance").eq("id", row.block_id).maybeSingle();
    if (block) {
      return {
        kind: "claim", text: block.claim_text, tier: block.tier, reason: block.reason ?? "", scope: null,
        as_of: block.as_of, resolve_by: null, exhibits: await exhibitsFor(supabase, block.id), quote: null,
        block_id: block.id, provenance: block.provenance,
      };
    }
  }
  const claim = row.exhibit;
  return {
    kind: "claim", text: claim.provenance_claim, tier: null,
    reason: "Not checked yet. Its contents are quoted speech: the check is whether it's real.",
    scope: null, as_of: null, resolve_by: null, exhibits: [], quote: null,
    provenance: {
      exhibit_type: claim.exhibit_type, status: "unchecked", authentic: "unknown", unaltered: "unknown",
      author: claim.author, recipient: claim.recipient, date: claim.date, source: claim.source,
      original_url: null, file_id: null, identifiers: claim.identifiers ?? [],
    },
  };
}

async function loadExhibit(supabase: SupabaseClient, imageUrl: string): Promise<ImageRow> {
  if (!imageUrl) throw new Error("needs image_url");
  const { data, error } = await supabase.from("image_memory")
    .select("image_url, text, description, unit, exhibit, block_id").eq("image_url", imageUrl).maybeSingle();
  if (error) throw error;
  if (!data || data.unit !== "exhibit" || !data.exhibit) throw new Error("This image hasn't been read as an exhibit.");
  return data;
}

export async function checkExhibit(
  supabase: SupabaseClient,
  embed: Embed,
  { image_url, url, context, daily_cap_usd }: { image_url: string; url?: string; context?: string; daily_cap_usd: number },
) {
  if (!(Number(daily_cap_usd) >= 0)) throw new Error("check_exhibit needs daily_cap_usd");
  const row = await loadExhibit(supabase, image_url);
  // Already checked (here or elsewhere): free.
  if (row.block_id) return { status: "remembered", item: await exhibitItem(supabase, row), spent_today_usd: await spentToday(supabase) };
  if (await spentToday(supabase) >= Number(daily_cap_usd)) {
    return { status: "skipped_cap", item: await exhibitItem(supabase, row), spent_today_usd: await spentToday(supabase) };
  }

  const leads = await factCheckLeads([row.exhibit.provenance_claim]);
  const out = await ask(supabase, "exhibit", {
    system: EXHIBIT_SYSTEM,
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "url", url: image_url } },
        {
          type: "text",
          text: JSON.stringify({
            today: today(),
            page: url ?? null,
            presents_itself_as: row.exhibit,
            transcribed_text: row.text,
            words_around_it: context?.slice(0, MAX_CONTEXT_CHARS) ?? null,
          }, null, 2) + leads,
        },
      ],
    }],
    tools: [
      { type: "web_search_20250305", name: "web_search", max_uses: MAX_EXHIBIT_SEARCHES },
      { type: "web_fetch_20250910", name: "web_fetch", max_uses: MAX_EXHIBIT_FETCHES },
      // deno-lint-ignore no-explicit-any
    ] as any,
    output_config: { effort: "medium", format: { type: "json_schema", schema: EXHIBIT_SCHEMA } },
  });

  const item = await saveExhibit(supabase, embed, row, url ?? "", out, "model");
  return { status: "checked", item, spent_today_usd: await spentToday(supabase) };
}

// Saves a provenance check as a block (with exhibits, tier history and a sighting) and links
// it to the image. `out` has EXHIBIT_SCHEMA's shape, from Haiku or from /research-queue.
export async function saveExhibit(
  supabase: SupabaseClient,
  embed: Embed,
  row: ImageRow,
  pageUrl: string,
  // deno-lint-ignore no-explicit-any
  out: any,
  actor: "model" | "claude_code",
): Promise<Item> {
  const tier = [1, 3, 4].includes(out.tier) ? out.tier : 3;
  const status = ["verified", "altered", "not_found"].includes(out.status) ? out.status : "not_found";
  const text = (out.provenance_claim ?? row.exhibit.provenance_claim).trim();
  const provenance: Provenance = {
    exhibit_type: row.exhibit.exhibit_type,
    status,
    authentic: out.authentic ?? "unknown",
    unaltered: out.unaltered ?? "unknown",
    author: out.author ?? row.exhibit.author,
    recipient: row.exhibit.recipient,
    date: out.date ?? row.exhibit.date,
    source: out.source ?? row.exhibit.source,
    original_url: out.original_url ?? null,
    file_id: out.file_id ?? null,
    identifiers: row.exhibit.identifiers ?? [],
  };

  const { data: block, error } = await supabase.from("blocks").insert({
    claim_text: text, tier, status: "ai_draft", as_of: today(), reason: out.reason, provenance,
    embedding: await embed(text),
  }).select("id").single();
  if (error) throw error;
  const exhibits = noEncyclopedias(out.exhibits);
  for (const exhibit of exhibits) {
    const { data: saved, error: exhibitError } = await supabase.from("exhibits")
      .insert({ source_url: exhibit.url, location: exhibit.location, source_type: exhibit.source_type })
      .select("id").single();
    if (exhibitError) throw exhibitError;
    await supabase.from("block_exhibits").insert({ block_id: block.id, exhibit_id: saved.id });
  }
  await supabase.from("tier_history").insert({ block_id: block.id, old_tier: null, new_tier: tier, reason: out.reason, actor });
  if (pageUrl) await supabase.from("sightings").insert({ block_id: block.id, page_url: pageUrl, quoted_text: text });
  await supabase.from("image_memory").update({ block_id: block.id }).eq("image_url", row.image_url);

  return {
    kind: "claim", text, tier, reason: out.reason, scope: null, as_of: today(), resolve_by: null,
    exhibits, quote: null, block_id: block.id, provenance,
  };
}

// "Research this" on an exhibit: queued at the front, worked by /research-queue for free.
export async function queueExhibit(supabase: SupabaseClient, { image_url, url }: { image_url: string; url?: string }) {
  const row = await loadExhibit(supabase, image_url);
  if (row.block_id) return { picked: false, item: await exhibitItem(supabase, row) };
  const sentence = row.exhibit.provenance_claim;
  const sentenceHash = await hash(`exhibit:${image_url}`);
  const item = await exhibitItem(supabase, row);
  await remember(supabase, sentenceHash, sentence, [item], true);
  await enqueue(supabase, sentenceHash, sentence, url ?? "");
  const { error } = await supabase.from("claim_queue")
    .update({ status: "queued", picked_at: new Date().toISOString(), done_at: null, image_url })
    .eq("sentence_hash", sentenceHash);
  if (error) throw error;
  const { count } = await supabase.from("claim_queue")
    .select("id", { count: "exact", head: true }).eq("status", "queued").not("picked_at", "is", null);
  return { picked: true, picked_waiting: count ?? 1, item };
}

// For /research-queue: an exhibit's queue entry finished with a provenance result.
export async function submitExhibit(
  supabase: SupabaseClient,
  embed: Embed,
  imageUrl: string,
  pageUrl: string,
  // deno-lint-ignore no-explicit-any
  exhibit: any,
): Promise<Item> {
  const row = await loadExhibit(supabase, imageUrl);
  if (row.block_id) return await exhibitItem(supabase, row);
  return await saveExhibit(supabase, embed, row, pageUrl, exhibit, "claude_code");
}
