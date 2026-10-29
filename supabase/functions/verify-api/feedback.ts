// Becket's feedback from the claim card (Part 4 of the build brief):
//   confirm     -> the claim is marked reviewed, logged in tier history.
//   challenge   -> saved with its reason, note and link; Claude re-checks the claim with that
//                  evidence (web search, about 2 cents) and the outcome is logged.
//   reword      -> new wording is saved if it says the same thing; if it changes the claim,
//                  nothing is saved and the card offers a re-check instead.
//   prioritize  -> "Research this": a sentence goes to the front of the research queue.
// Every change is also written into sentence memory, so pages show the new label.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { ask, compare, enqueue, exhibitsFor, hash, type Item, remember, spentToday, today } from "./check.ts";
import { RECHECK_SCHEMA, RECHECK_SYSTEM } from "./prompts.ts";

type Embed = (text: string) => Promise<string>;

const REASON_TYPES = ["new_evidence", "wording_or_scope", "reasoning", "outdated"];
const MAX_RECHECK_SEARCHES = 4;
const MAX_RECHECK_FETCHES = 2;

// ---------- confirm ----------

export async function confirmBlock(supabase: SupabaseClient, { block_id }: { block_id: string }) {
  const block = await loadBlock(supabase, block_id);
  const { error } = await supabase.from("blocks").update({ status: "reviewed" }).eq("id", block_id);
  if (error) throw error;
  await logTier(supabase, block_id, block.tier, block.tier, "Confirmed by Becket", "becket");
  return { status: "reviewed" };
}

// ---------- challenge ----------

export async function challengeBlock(
  supabase: SupabaseClient,
  embed: Embed,
  { block_id, reason_type, note, link, daily_cap_usd }:
    { block_id: string; reason_type: string; note?: string; link?: string; daily_cap_usd: number },
) {
  if (!REASON_TYPES.includes(reason_type)) throw new Error("challenge needs a reason type");
  note = note?.trim() || undefined;
  link = link?.trim() || undefined;
  if (!note && !link) throw new Error("Add a note or a link");
  if (link && !/^https?:\/\/\S+$/.test(link)) throw new Error("The link should start with http:// or https://");
  if (!(Number(daily_cap_usd) >= 0)) throw new Error("needs daily_cap_usd");

  const block = await loadBlock(supabase, block_id);
  const { data: challenge, error } = await supabase.from("challenges")
    .insert({ block_id, reason_type, note, link, old_tier: block.tier })
    .select("id").single();
  if (error) throw error;

  // The challenge is saved either way; the re-check waits if today's spending is used up.
  if (await spentToday(supabase) >= Number(daily_cap_usd)) {
    return { rechecked: false, response: "Saved. Today's spending cap is reached, so it hasn't been re-checked yet." };
  }

  try {
    const exhibits = await exhibitsFor(supabase, block_id);
    const { data: sighting } = await supabase.from("sightings")
      .select("quoted_text").eq("block_id", block_id).order("seen_at", { ascending: false }).limit(1).maybeSingle();
    const tools: unknown[] = [{ type: "web_search_20250305", name: "web_search", max_uses: MAX_RECHECK_SEARCHES }];
    if (link) tools.push({ type: "web_fetch_20250910", name: "web_fetch", max_uses: MAX_RECHECK_FETCHES });

    const out = await ask(supabase, "recheck", {
      system: RECHECK_SYSTEM,
      messages: [{
        role: "user",
        content: JSON.stringify({
          today: today(),
          stored_claim: {
            text: block.claim_text, tier: block.tier, reason: block.reason,
            scope: block.scope, as_of: block.as_of, exhibits,
          },
          seen_in_sentence: sighting?.quoted_text ?? null,
          challenge: { reason_type, note: note ?? null, link: link ?? null },
        }, null, 2),
      }],
      // deno-lint-ignore no-explicit-any
      tools: tools as any,
      output_config: { effort: "medium", format: { type: "json_schema", schema: RECHECK_SCHEMA } },
    });

    const changedTier = out.tier !== block.tier;
    const changedText = out.text.trim() !== block.claim_text;
    const changed = changedTier || changedText || out.scope !== block.scope || out.as_of !== block.as_of;
    const why = `Re-checked after a challenge (${reason_type.replaceAll("_", " ")}): ${out.response}`;

    const update: Record<string, unknown> = { tier: out.tier, reason: out.reason, scope: out.scope, as_of: out.as_of };
    // Any change is a fresh AI draft again; an unchanged label keeps Becket's review.
    if (changed) update.status = "ai_draft";
    if (changedText) {
      update.claim_text = out.text.trim();
      update.embedding = await embed(out.text.trim());
      await logWording(supabase, block_id, block.claim_text, out.text.trim(), "model", why);
    }
    const { error: updateError } = await supabase.from("blocks").update(update).eq("id", block_id);
    if (updateError) throw updateError;
    if (changedTier) await logTier(supabase, block_id, block.tier, out.tier, why, "model");

    const linkExhibit = await replaceExhibits(supabase, block_id, out.exhibits, link);
    await supabase.from("challenges").update({
      status: "resolved",
      resolution: `${out.outcome === "upheld" ? "Upheld" : "Not upheld"}: ${out.response}`,
      new_tier: out.tier,
      exhibit_id: linkExhibit,
      resolved_at: new Date().toISOString(),
    }).eq("id", challenge.id);

    const patch = {
      text: out.text.trim(), tier: out.tier, reason: out.reason, scope: out.scope, as_of: out.as_of,
      exhibits: await exhibitsFor(supabase, block_id),
    };
    await patchMemory(supabase, block_id, patch);
    return { rechecked: true, outcome: out.outcome, response: out.response, patch, status: changed ? "ai_draft" : block.status };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await supabase.from("challenges").update({ resolution: `Re-check failed: ${message}` }).eq("id", challenge.id);
    throw err;
  }
}

// ---------- reword ----------

export async function rewordBlock(
  supabase: SupabaseClient,
  embed: Embed,
  { block_id, text, daily_cap_usd }: { block_id: string; text: string; daily_cap_usd: number },
) {
  text = text?.trim();
  if (!text) throw new Error("reword needs the new wording");
  const block = await loadBlock(supabase, block_id);
  if (text === block.claim_text) return { saved: false, relation: "same", unchanged: true };
  if (await spentToday(supabase) >= Number(daily_cap_usd)) {
    throw new Error("Today's spending cap is reached, so the new wording can't be compared yet.");
  }

  // The tier was earned by the old wording, so new wording keeps it only if it says the same thing.
  const [[, relation] = [0, "different"]] = await compare(supabase, [[text, block.claim_text]]);
  if (relation !== "same") return { saved: false, relation };

  const { error } = await supabase.from("blocks")
    .update({ claim_text: text, embedding: await embed(text) })
    .eq("id", block_id);
  if (error) throw error;
  await logWording(supabase, block_id, block.claim_text, text, "becket", "Reworded by Becket");
  await patchMemory(supabase, block_id, { text });
  return { saved: true, relation, patch: { text } };
}

// ---------- research this ----------

// Puts a sentence at the front of the research queue, even one first sorted as a non-claim:
// Becket picking it is reason enough to research it.
export async function prioritize(supabase: SupabaseClient, { sentence, url }: { sentence: string; url?: string }) {
  sentence = sentence?.trim();
  if (!sentence) throw new Error("prioritize needs a sentence");
  const sentenceHash = await hash(sentence);
  const { data: memory } = await supabase.from("sentence_memory")
    .select("outcome").eq("sentence_hash", sentenceHash).maybeSingle();
  const items: Item[] = memory?.outcome?.some((i: Item) => i.kind === "claim")
    ? memory.outcome
    : [{
      kind: "claim", text: sentence, tier: null, reason: "Waiting for research.", scope: null, as_of: null,
      resolve_by: null, exhibits: [], quote: null,
    }];
  await remember(supabase, sentenceHash, sentence, items, true);
  await enqueue(supabase, sentenceHash, sentence, url ?? "");
  const { error } = await supabase.from("claim_queue")
    .update({ status: "queued", picked_at: new Date().toISOString(), done_at: null })
    .eq("sentence_hash", sentenceHash);
  if (error) throw error;
  const { count } = await supabase.from("claim_queue")
    .select("id", { count: "exact", head: true }).eq("status", "queued").not("picked_at", "is", null);
  return { picked: true, picked_waiting: count ?? 1, items };
}

// ---------- helpers ----------

async function loadBlock(supabase: SupabaseClient, blockId: string) {
  if (!blockId) throw new Error("needs block_id");
  const { data, error } = await supabase.from("blocks")
    .select("id, claim_text, tier, status, scope, as_of, reason")
    .eq("id", blockId).single();
  if (error) throw error;
  return data;
}

async function logTier(supabase: SupabaseClient, blockId: string, oldTier: number, newTier: number, reason: string, actor: string) {
  const { error } = await supabase.from("tier_history")
    .insert({ block_id: blockId, old_tier: oldTier, new_tier: newTier, reason, actor });
  if (error) throw error;
}

async function logWording(supabase: SupabaseClient, blockId: string, oldText: string, newText: string, actor: string, note: string) {
  const { error } = await supabase.from("wording_history")
    .insert({ block_id: blockId, old_text: oldText, new_text: newText, actor, note });
  if (error) throw error;
}

// Links the re-check's exhibits to the block, reusing stored ones by address. Exhibits it
// dropped are unlinked but kept in the exhibits table. Returns the challenge link's exhibit id.
async function replaceExhibits(
  supabase: SupabaseClient,
  blockId: string,
  exhibits: { url: string; location: string; source_type: string }[],
  link?: string,
): Promise<string | null> {
  const { data: linked, error } = await supabase.from("block_exhibits")
    .select("exhibit_id, exhibits(source_url)").eq("block_id", blockId);
  if (error) throw error;
  // deno-lint-ignore no-explicit-any
  const byUrl = new Map(linked.map((row: any) => [row.exhibits.source_url, row.exhibit_id as string]));
  const keep = new Set<string>();
  let linkExhibit: string | null = null;
  for (const exhibit of exhibits) {
    let id = byUrl.get(exhibit.url);
    if (!id) {
      const { data: saved, error: saveError } = await supabase.from("exhibits")
        .insert({ source_url: exhibit.url, location: exhibit.location, source_type: exhibit.source_type })
        .select("id").single();
      if (saveError) throw saveError;
      id = saved.id as string;
      await supabase.from("block_exhibits").insert({ block_id: blockId, exhibit_id: id });
    }
    keep.add(id);
    if (link && sameUrl(exhibit.url, link)) linkExhibit = id;
  }
  const drop = [...byUrl.values()].filter((id) => !keep.has(id));
  if (drop.length) await supabase.from("block_exhibits").delete().eq("block_id", blockId).in("exhibit_id", drop);
  return linkExhibit;
}

function sameUrl(a: string, b: string) {
  const strip = (u: string) => u.replace(/^https?:\/\/(www\.)?/, "").replace(/[#?].*$/, "").replace(/\/$/, "");
  return strip(a) === strip(b);
}

// Rewrites every remembered sentence that holds this claim, so the next lookup shows the change.
async function patchMemory(supabase: SupabaseClient, blockId: string, patch: Partial<Item>) {
  const { data, error } = await supabase.from("sentence_memory")
    .select("sentence_hash, outcome")
    .filter("outcome", "cs", JSON.stringify([{ block_id: blockId }]));
  if (error) throw error;
  for (const row of data) {
    const outcome = row.outcome.map((i: Item) => i.block_id === blockId ? { ...i, ...patch } : i);
    await supabase.from("sentence_memory").update({ outcome }).eq("sentence_hash", row.sentence_hash);
  }
}
