// Daily research batch (Build Queue, START HERE item 7).
// Fetchers add candidate claims with queue_add; a /research-batch run in Claude Code researches
// them toward a block target, then reads batch_stats for its Notion report and logs the run with
// batch_log. None of this calls the Claude API: research runs on Becket's Claude subscription.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { hash, remember, type Item } from "./check.ts";

type Embed = (text: string) => Promise<string>;

// A candidate this close in meaning to a stored claim is already in the library.
const DUPLICATE_THRESHOLD = 0.9;
// Embedding is processor-heavy and the free tier stops long requests.
const MAX_ENTRIES = 10;
const SOURCES = ["gdelt", "reddit", "imgur"];

type Candidate = { text: string; url?: string; source: string; priority?: number; reach?: unknown };

// Adds candidate claims from a fetcher to the queue as the "trending" stream.
// Returns what happened to each: queued, already queued, or skipped as already in the library.
export async function queueAdd(supabase: SupabaseClient, embed: Embed, { entries }: { entries: Candidate[] }) {
  if (!Array.isArray(entries) || !entries.length) throw new Error("queue_add needs entries");
  if (entries.length > MAX_ENTRIES) throw new Error(`queue_add takes at most ${MAX_ENTRIES} entries at a time`);
  const out: { text: string; result: "queued" | "already_queued" | "in_library" | "refused"; block_id?: string; reason?: string }[] = [];
  for (const entry of entries) {
    const text = entry?.text?.replace(/\s+/g, " ").trim() ?? "";
    if (!SOURCES.includes(entry?.source)) {
      out.push({ text, result: "refused", reason: `source must be one of ${SOURCES.join(", ")}` });
      continue;
    }
    if (text.length < 20 || text.length > 600) {
      out.push({ text, result: "refused", reason: "Too short or too long to be one claim" });
      continue;
    }
    const sentenceHash = await hash(text);
    const { data: existing } = await supabase.from("claim_queue")
      .select("id, seen_count").eq("sentence_hash", sentenceHash).maybeSingle();
    if (existing) {
      // Seen again on another day or source: that's recurrence, part of the priority score.
      await supabase.from("claim_queue").update({ seen_count: existing.seen_count + 1 }).eq("id", existing.id);
      out.push({ text, result: "already_queued" });
      continue;
    }
    const { data: matches, error: matchError } = await supabase.rpc("match_blocks", {
      query_embedding: await embed(text),
      match_threshold: DUPLICATE_THRESHOLD,
      match_count: 1,
    });
    if (matchError) throw matchError;
    if (matches?.length) {
      out.push({ text, result: "in_library", block_id: matches[0].id });
      continue;
    }
    const placeholder: Item[] = [{
      kind: "claim", text, tier: null, reason: "Waiting for research.", scope: null, as_of: null,
      resolve_by: null, exhibits: [], quote: null,
    } as unknown as Item];
    await remember(supabase, sentenceHash, text, placeholder, true);
    const { error } = await supabase.from("claim_queue").insert({
      sentence_hash: sentenceHash,
      sentence_text: text,
      page_url: entry.url ?? null,
      stream: "trending",
      source: entry.source,
      priority: Number(entry.priority) || 0,
      reach: entry.reach ?? null,
    });
    if (error) throw error;
    out.push({ text, result: "queued" });
  }
  return { added: out };
}

// What Claude Code research has produced since a time: the batch report's numbers.
export async function batchStats(supabase: SupabaseClient, { since }: { since: string }) {
  if (!since || isNaN(Date.parse(since))) throw new Error("batch_stats needs since (an ISO date and time)");

  const { data: history, error } = await supabase.from("tier_history")
    .select("block_id, old_tier, new_tier, blocks(claim_text, status)")
    .eq("actor", "claude_code").gte("created_at", since);
  if (error) throw error;
  const created = history.filter((h) => h.old_tier === null);
  const byTier: Record<string, number> = { "1": 0, "2": 0, "3": 0, "4": 0 };
  for (const h of created) byTier[String(h.new_tier)]++;
  // deno-lint-ignore no-explicit-any
  const claim = (h: any) => ({ block_id: h.block_id, text: h.blocks?.claim_text ?? "" });

  const { data: finished } = await supabase.from("claim_queue")
    .select("status, stream").in("status", ["done", "failed", "skipped"]).gte("done_at", since);
  const entries: Record<string, number> = {};
  for (const f of finished ?? []) entries[f.status] = (entries[f.status] ?? 0) + 1;

  const { data: waiting } = await supabase.from("claim_queue")
    .select("stream, picked_at").eq("status", "queued");
  const queued: Record<string, number> = {};
  for (const w of waiting ?? []) {
    const key = w.picked_at ? "becket_pick" : w.stream;
    queued[key] = (queued[key] ?? 0) + 1;
  }

  return {
    since,
    blocks_created: created.length,
    blocks_by_tier: byTier,
    // Tier 2 seed drafts researched to the primary record (updated in place, so not "created").
    blocks_revised: history.filter((h) => h.old_tier !== null).length,
    queue_entries: entries,
    // Couldn't be resolved: Tier 3, pending more evidence.
    tier3: created.filter((h) => h.new_tier === 3).map(claim),
    // Worth Becket's review first: Tier 4 drafts.
    tier4: created.filter((h) => h.new_tier === 4).map(claim),
    still_queued: queued,
  };
}

// Logs a finished run, with its numbers, so blocks per day can be tracked over time.
export async function batchLog(
  supabase: SupabaseClient,
  { started_at, block_target, notion_url, note }: { started_at: string; block_target?: number; notion_url?: string; note?: string },
) {
  const stats = await batchStats(supabase, { since: started_at });
  const { data, error } = await supabase.from("research_batches").insert({
    started_at,
    block_target: block_target ?? null,
    stats,
    notion_url: notion_url ?? null,
    note: note ?? null,
  }).select("id").single();
  if (error) throw error;
  return { id: data.id, stats };
}
