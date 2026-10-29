// How sentences get labelled, cheapest step first.
//
// lookup (runs on every "Look up" click, costs a fraction of a cent per sentence):
//   1. Sentence memory: seen this exact sentence before? Reuse its outcome. Free.
//   2. Library: meaning search finds a stored claim, and a quick Claude check confirms it's
//      the same claim (not the opposite or a different one). Reuse its label.
//   3. Non-fact memory: a near-identical opinion, value or forecast seen before. Reuse it.
//   4. First pass: Claude sorts the rest into claims and non-claims without researching.
//      Non-claims are labelled now; claims go into the research queue.
//
// check (the "Check now" button): researches queued claims immediately, with web search.
// The queue is otherwise worked through by Claude Code sessions on Becket's subscription,
// which send their findings back through submitResults.
//
// Every Claude call is logged in api_spend; nothing paid runs once today's spend reaches the cap.

import Anthropic from "npm:@anthropic-ai/sdk";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  CHECK_SCHEMA,
  CHECK_SYSTEM,
  COMPARE_SCHEMA,
  COMPARE_SYSTEM,
  TRIAGE_SCHEMA,
  TRIAGE_SYSTEM,
} from "./prompts.ts";

// Claude Haiku 5.5 does every paid step (Becket's choice, Oct 28, 2026).
const MODEL = "claude-haiku-5-5";
// Haiku 5.5 prices in US dollars (prompts up to 100K tokens), and web search per search.
const PRICE_PER_INPUT_TOKEN = 0.1 / 1_000_000;
const PRICE_PER_OUTPUT_TOKEN = 0.5 / 1_000_000;
const PRICE_PER_SEARCH = 10 / 1_000;

const CLAIM_MATCH_THRESHOLD = 0.8;
const LIBRARY_CANDIDATES = 3;
const NON_FACT_MATCH_THRESHOLD = 0.95;
// Embedding is processor-heavy; 20 sentences per request hit Supabase's free-tier CPU limit.
const MAX_LOOKUP_SENTENCES = 8;
const MAX_CHECK_SENTENCES = 6;
const MAX_SEARCHES_PER_CHECK = 6;

const anthropic = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY") });

type Embed = (text: string) => Promise<string>;
type Kind = "claim" | "value" | "opinion" | "forecast" | "not_a_claim";

export type Item = {
  kind: Kind;
  text: string;
  tier: number | null;
  reason: string;
  scope: string | null;
  as_of: string | null;
  resolve_by: string | null;
  exhibits: { url: string; location: string; source_type: string }[];
  // The exact words of the sentence this item comes from, so the page can mark just those.
  quote?: string | null;
  block_id?: string;
};

// remembered: reused from sentence memory; from_library: matched a stored claim;
// classified: sorted now, nothing to research; queued: has claims waiting for research;
// checked: researched just now; skipped_cap: daily cap reached; error: something failed.
type Status = "remembered" | "from_library" | "classified" | "queued" | "checked" | "skipped_cap" | "error";

export type SentenceResult = {
  index: number;
  sentence: string;
  status: Status;
  items: Item[];
  error?: string;
};

// ---------- lookup ----------

export async function lookupSentences(
  supabase: SupabaseClient,
  embed: Embed,
  { url, sentences, daily_cap_usd }: { url: string; sentences: string[]; daily_cap_usd: number },
) {
  validate(sentences, MAX_LOOKUP_SENTENCES, daily_cap_usd);
  const cap = Number(daily_cap_usd);
  const results: SentenceResult[] = sentences.map((sentence, index) => ({ index, sentence, status: "error", items: [] }));
  const hashes = await Promise.all(sentences.map(hash));

  // 1. Sentence memory.
  const { data: remembered, error } = await supabase
    .from("sentence_memory")
    .select("sentence_hash, outcome, pending")
    .in("sentence_hash", hashes);
  if (error) throw error;
  const memory = new Map(remembered.map((row) => [row.sentence_hash, row]));
  for (const r of results) {
    const row = memory.get(hashes[r.index]);
    if (!row) continue;
    r.status = row.pending ? "queued" : "remembered";
    r.items = row.outcome;
    await touchMemory(supabase, hashes[r.index], url, row.pending);
  }

  let rest = results.filter((r) => !memory.has(hashes[r.index]));
  if (rest.length === 0) return { results, spent_today_usd: await spentToday(supabase) };

  // 2. Library match, confirmed as the same claim. The closest few stored claims are compared,
  //    because the very closest is often the opposite claim.
  const embeddings = new Map(await Promise.all(rest.map(async (r) => [r.index, await embed(r.sentence)] as const)));
  const pairs: { result: SentenceResult; block: LibraryMatch }[] = [];
  for (const r of rest) {
    const matches = await topMatches(supabase, "match_blocks", embeddings.get(r.index)!, CLAIM_MATCH_THRESHOLD, LIBRARY_CANDIDATES);
    for (const block of matches) pairs.push({ result: r, block });
  }
  if (pairs.length > 0 && await spentToday(supabase) < cap) {
    const relations = await compare(supabase, pairs.map((p) => [p.result.sentence, p.block.claim_text]));
    for (const [pairIndex, relation] of relations) {
      const pair = pairs[pairIndex];
      if (!pair || relation !== "same" || pair.result.status !== "error") continue;
      const { result: r, block } = pair;
      r.status = "from_library";
      r.items = [{ ...blockToItem(block), exhibits: await exhibitsFor(supabase, block.id) }];
      await supabase.from("sightings").insert({ block_id: block.id, page_url: url, quoted_text: r.sentence });
      await remember(supabase, hashes[r.index], r.sentence, r.items, false);
    }
    rest = rest.filter((r) => r.status === "error");
  }

  // 3. Near-identical non-fact statement seen before.
  for (const r of rest) {
    const [match] = await topMatches(supabase, "match_non_facts", embeddings.get(r.index)!, NON_FACT_MATCH_THRESHOLD, 1);
    if (!match) continue;
    r.status = "remembered";
    r.items = [nonFactItem(match.tag as Kind, match.statement_text, null)];
    await remember(supabase, hashes[r.index], r.sentence, r.items, false);
  }
  rest = rest.filter((r) => r.status === "error");
  if (rest.length === 0) return { results, spent_today_usd: await spentToday(supabase) };

  // 4. First pass: claims to the queue, everything else labelled now.
  if (await spentToday(supabase) >= cap) {
    for (const r of rest) r.status = "skipped_cap";
    return { results, spent_today_usd: await spentToday(supabase) };
  }
  const sorted = await triage(supabase, rest.map((r) => r.sentence));
  for (const [triageIndex, items] of sorted) {
    const r = rest[triageIndex];
    if (!r || items.length === 0) continue;
    r.items = items;
    const hasClaim = items.some((i) => i.kind === "claim");
    r.status = hasClaim ? "queued" : "classified";
    for (const item of items) {
      if (item.kind !== "claim" && item.kind !== "not_a_claim") await saveNonFact(supabase, embed, url, item);
    }
    await remember(supabase, hashes[r.index], r.sentence, items, hasClaim);
    if (hasClaim) await enqueue(supabase, hashes[r.index], r.sentence, url);
  }
  for (const r of rest) if (r.status === "error") r.error = "No result came back for this sentence.";

  return { results, spent_today_usd: await spentToday(supabase) };
}

// ---------- check now ----------

export async function checkSentences(
  supabase: SupabaseClient,
  embed: Embed,
  { url, sentences, daily_cap_usd }: { url: string; sentences: string[]; daily_cap_usd: number },
) {
  validate(sentences, MAX_CHECK_SENTENCES, daily_cap_usd);
  const results: SentenceResult[] = sentences.map((sentence, index) => ({ index, sentence, status: "checked", items: [] }));

  if (await spentToday(supabase) >= Number(daily_cap_usd)) {
    for (const r of results) r.status = "skipped_cap";
    return { results, spent_today_usd: await spentToday(supabase) };
  }

  let graded: Map<number, Item[]>;
  try {
    graded = await research(supabase, url, sentences);
  } catch (err) {
    for (const r of results) {
      r.status = "error";
      r.error = err instanceof Error ? err.message : String(err);
    }
    return { results, spent_today_usd: await spentToday(supabase) };
  }

  for (const r of results) {
    const items = graded.get(r.index);
    if (!items || items.length === 0) {
      r.status = "error";
      r.error = "No result came back for this sentence.";
      continue;
    }
    r.items = await saveResearched(supabase, embed, url, r.sentence, items, "model");
    await finishQueued(supabase, await hash(r.sentence), r.sentence, r.items, "Checked now from the extension");
  }
  return { results, spent_today_usd: await spentToday(supabase) };
}

// ---------- the research queue (worked by Claude Code) ----------

export async function queueNext(supabase: SupabaseClient, { limit = 10 }: { limit?: number }) {
  const { data, error } = await supabase
    .from("claim_queue")
    .select("id, sentence_text, page_url, seen_count, queued_at, picked_at")
    .eq("status", "queued")
    // Becket's picks first, in the order picked; then the most-seen claims.
    .order("picked_at", { ascending: true, nullsFirst: false })
    .order("seen_count", { ascending: false })
    .order("queued_at", { ascending: true })
    .limit(Math.min(Number(limit) || 10, 50));
  if (error) throw error;
  const { count } = await supabase.from("claim_queue").select("id", { count: "exact", head: true }).eq("status", "queued");
  return { queued_total: count ?? 0, items: data };
}

export async function submitResults(
  supabase: SupabaseClient,
  embed: Embed,
  { results }: { results: { queue_id: string; items?: Item[]; failed_note?: string }[] },
) {
  if (!Array.isArray(results)) throw new Error("submit_results needs results");
  const saved: { queue_id: string; ok: boolean; error?: string }[] = [];
  for (const result of results) {
    try {
      const { data: queued, error } = await supabase
        .from("claim_queue")
        .select("sentence_hash, sentence_text, page_url")
        .eq("id", result.queue_id)
        .single();
      if (error) throw error;
      if (result.failed_note) {
        await supabase.from("claim_queue")
          .update({ status: "failed", done_at: new Date().toISOString(), note: result.failed_note })
          .eq("id", result.queue_id);
      } else {
        if (!result.items?.length) throw new Error("No items given");
        const items = await saveResearched(
          supabase, embed, queued.page_url ?? "", queued.sentence_text, result.items, "claude_code",
        );
        await finishQueued(supabase, queued.sentence_hash, queued.sentence_text, items, "Researched by Claude Code");
      }
      saved.push({ queue_id: result.queue_id, ok: true });
    } catch (err) {
      saved.push({ queue_id: result.queue_id, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { saved };
}

// ---------- claim card details ----------

export async function blockDetail(supabase: SupabaseClient, { block_id }: { block_id: string }) {
  if (!block_id) throw new Error("block_detail needs block_id");
  const { data: block, error } = await supabase
    .from("blocks")
    .select("id, claim_text, tier, status, scope, as_of, reason, created_at, updated_at")
    .eq("id", block_id)
    .single();
  if (error) throw error;
  const { data: history, error: historyError } = await supabase
    .from("tier_history")
    .select("old_tier, new_tier, reason, actor, created_at")
    .eq("block_id", block_id)
    .order("created_at", { ascending: true });
  if (historyError) throw historyError;
  const { count: sightings } = await supabase
    .from("sightings")
    .select("id", { count: "exact", head: true })
    .eq("block_id", block_id);
  const { data: challenges } = await supabase
    .from("challenges")
    .select("reason_type, note, link, status, resolution, old_tier, new_tier, created_at")
    .eq("block_id", block_id)
    .order("created_at", { ascending: true });
  const { data: wording } = await supabase
    .from("wording_history")
    .select("old_text, new_text, actor, created_at")
    .eq("block_id", block_id)
    .order("created_at", { ascending: true });
  return {
    block,
    exhibits: await exhibitsFor(supabase, block_id),
    history,
    challenges: challenges ?? [],
    wording: wording ?? [],
    sightings: sightings ?? 0,
  };
}

// ---------- Claude calls ----------

export async function spentToday(supabase: SupabaseClient): Promise<number> {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const { data, error } = await supabase
    .from("api_spend")
    .select("cost_usd")
    .gte("created_at", startOfDay.toISOString());
  if (error) throw error;
  return data.reduce((sum, row) => sum + Number(row.cost_usd), 0);
}

type Purpose = "triage" | "compare" | "check" | "image" | "recheck";

async function logSpend(supabase: SupabaseClient, purpose: Purpose, usage: Anthropic.Usage) {
  const searches = usage.server_tool_use?.web_search_requests ?? 0;
  const inputTokens = usage.input_tokens + (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0);
  const cost = inputTokens * PRICE_PER_INPUT_TOKEN + usage.output_tokens * PRICE_PER_OUTPUT_TOKEN +
    searches * PRICE_PER_SEARCH;
  const { error } = await supabase.from("api_spend").insert({
    purpose,
    model: MODEL,
    input_tokens: inputTokens,
    output_tokens: usage.output_tokens,
    web_searches: searches,
    cost_usd: cost,
  });
  if (error) throw error;
}

// Sends a request, continuing it if a long web search pauses the turn. Logs spend for every call.
export async function ask(
  supabase: SupabaseClient,
  purpose: Purpose,
  params: Omit<Anthropic.MessageCreateParamsNonStreaming, "model" | "max_tokens">,
) {
  const messages = [...params.messages];
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await anthropic.messages.create({ ...params, model: MODEL, max_tokens: 16000, messages });
    await logSpend(supabase, purpose, response.usage);

    if (response.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: response.content });
      continue;
    }
    // Haiku 5.5 has no automatic fallback model, so a declined request is reported as an error.
    if (response.stop_reason === "refusal") throw new Error("Claude declined to check this text.");
    if (response.stop_reason === "max_tokens") throw new Error("Claude's answer was cut off. Try fewer sentences.");

    const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    return JSON.parse(text);
  }
  throw new Error("The check took too many rounds.");
}

function numbered(sentences: string[]) {
  return sentences.map((s, i) => `${i}. ${s}`).join("\n");
}

async function triage(supabase: SupabaseClient, sentences: string[]): Promise<Map<number, Item[]>> {
  const out = await ask(supabase, "triage", {
    system: TRIAGE_SYSTEM,
    messages: [{ role: "user", content: `Today is ${today()}.\n\nSentences:\n${numbered(sentences)}` }],
    output_config: { effort: "low", format: { type: "json_schema", schema: TRIAGE_SCHEMA } },
  });
  type Sorted = { kind: Kind; text: string; quote: string; resolve_by: string | null };
  return new Map(out.results.map((r: { index: number; items: Sorted[] }) => [
    r.index,
    r.items.map((i) => ({
      ...(i.kind === "claim"
        ? { ...nonFactItem("claim", i.text, null), reason: "Waiting for research." }
        : nonFactItem(i.kind, i.text, i.resolve_by)),
      quote: fitQuote(sentences[r.index] ?? "", i.quote),
    })),
  ]));
}

export async function compare(supabase: SupabaseClient, pairs: [string, string][]): Promise<[number, string][]> {
  const list = pairs.map(([a, b], i) => `${i}. A: ${a}\n   B: ${b}`).join("\n");
  const out = await ask(supabase, "compare", {
    system: COMPARE_SYSTEM,
    messages: [{ role: "user", content: list }],
    // Low effort missed obvious rewordings in testing; this call is cheap either way.
    output_config: { effort: "medium", format: { type: "json_schema", schema: COMPARE_SCHEMA } },
  });
  return out.results.map((r: { index: number; relation: string }) => [r.index, r.relation]);
}

async function research(supabase: SupabaseClient, url: string, sentences: string[]): Promise<Map<number, Item[]>> {
  const out = await ask(supabase, "check", {
    system: CHECK_SYSTEM,
    messages: [{ role: "user", content: `Today is ${today()}. Page: ${url}\n\nSentences:\n${numbered(sentences)}` }],
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: MAX_SEARCHES_PER_CHECK }],
    output_config: { effort: "medium", format: { type: "json_schema", schema: CHECK_SCHEMA } },
  });
  return new Map(out.results.map((r: { index: number; items: Item[] }) => [r.index, r.items]));
}

// ---------- storage ----------

type LibraryMatch = { id: string; claim_text: string; tier: number; reason: string | null };

async function topMatches(supabase: SupabaseClient, fn: string, embedding: string, threshold: number, count: number) {
  const { data, error } = await supabase.rpc(fn, {
    query_embedding: embedding,
    match_threshold: threshold,
    match_count: count,
  });
  if (error) throw error;
  return data;
}

function blockToItem(block: LibraryMatch): Item {
  return {
    kind: "claim",
    text: block.claim_text,
    tier: block.tier,
    reason: block.reason ?? "",
    scope: null,
    as_of: null,
    resolve_by: null,
    exhibits: [],
    block_id: block.id,
  };
}

function nonFactItem(kind: Kind, text: string, resolveBy: string | null): Item {
  return { kind, text, tier: null, reason: "", scope: null, as_of: null, resolve_by: resolveBy, exhibits: [] };
}

export async function exhibitsFor(supabase: SupabaseClient, blockId: string) {
  const { data, error } = await supabase
    .from("block_exhibits")
    .select("exhibits(source_url, location, source_type)")
    .eq("block_id", blockId);
  if (error) throw error;
  // deno-lint-ignore no-explicit-any
  return data.map((row: any) => ({
    url: row.exhibits.source_url,
    location: row.exhibits.location ?? "",
    source_type: row.exhibits.source_type,
  }));
}

export async function remember(supabase: SupabaseClient, sentenceHash: string, sentence: string, items: Item[], pending: boolean) {
  const kinds = new Set(items.map((i) => i.kind));
  const { error } = await supabase.from("sentence_memory").upsert({
    sentence_hash: sentenceHash,
    sentence_text: sentence,
    kind: kinds.size === 1 ? [...kinds][0] : "mixed",
    outcome: items,
    pending,
    last_seen: new Date().toISOString(),
  });
  if (error) throw error;
}

async function touchMemory(supabase: SupabaseClient, sentenceHash: string, url: string, pending: boolean) {
  const { data } = await supabase.from("sentence_memory").select("seen_count").eq("sentence_hash", sentenceHash).single();
  await supabase.from("sentence_memory")
    .update({ seen_count: (data?.seen_count ?? 0) + 1, last_seen: new Date().toISOString() })
    .eq("sentence_hash", sentenceHash);
  if (pending) {
    // A claim seen again moves up the research queue.
    const { data: queued } = await supabase.from("claim_queue").select("seen_count").eq("sentence_hash", sentenceHash).single();
    await supabase.from("claim_queue")
      .update({ seen_count: (queued?.seen_count ?? 0) + 1, page_url: url })
      .eq("sentence_hash", sentenceHash);
  }
}

export async function enqueue(supabase: SupabaseClient, sentenceHash: string, sentence: string, url: string) {
  const { error } = await supabase.from("claim_queue")
    .upsert({ sentence_hash: sentenceHash, sentence_text: sentence, page_url: url }, { onConflict: "sentence_hash", ignoreDuplicates: true });
  if (error) throw error;
}

async function finishQueued(supabase: SupabaseClient, sentenceHash: string, sentence: string, items: Item[], note: string) {
  await remember(supabase, sentenceHash, sentence, items, false);
  await supabase.from("claim_queue")
    .update({ status: "done", done_at: new Date().toISOString(), note })
    .eq("sentence_hash", sentenceHash);
}

async function saveNonFact(supabase: SupabaseClient, embed: Embed, url: string, item: Item) {
  const { error } = await supabase.from("non_fact_tags").insert({
    statement_text: item.text,
    tag: item.kind,
    resolve_by: item.resolve_by,
    page_url: url,
    embedding: await embed(item.text),
  });
  if (error) throw error;
}

// Saves researched items: claims become ai_draft blocks with exhibits, tier history and a
// sighting; values, opinions and forecasts go to non_fact_tags. Returns the items with block ids.
async function saveResearched(
  supabase: SupabaseClient,
  embed: Embed,
  url: string,
  sentence: string,
  items: Item[],
  actor: "model" | "claude_code",
): Promise<Item[]> {
  const saved: Item[] = [];
  for (const given of items) {
    const item = { ...given, quote: fitQuote(sentence, given.quote) };
    if (item.kind === "not_a_claim") {
      saved.push(item);
      continue;
    }
    if (item.kind !== "claim") {
      await saveNonFact(supabase, embed, url, item);
      saved.push(item);
      continue;
    }

    const tier = item.tier && item.tier >= 1 && item.tier <= 4 ? item.tier : 3;
    const { data: block, error } = await supabase.from("blocks").insert({
      claim_text: item.text,
      tier,
      status: "ai_draft",
      scope: item.scope,
      as_of: item.as_of,
      reason: item.reason,
      embedding: await embed(item.text),
    }).select("id").single();
    if (error) throw error;

    for (const exhibit of item.exhibits ?? []) {
      const { data: savedExhibit, error: exhibitError } = await supabase.from("exhibits").insert({
        source_url: exhibit.url,
        location: exhibit.location,
        source_type: exhibit.source_type,
      }).select("id").single();
      if (exhibitError) throw exhibitError;
      await supabase.from("block_exhibits").insert({ block_id: block.id, exhibit_id: savedExhibit.id });
    }

    await supabase.from("tier_history").insert({
      block_id: block.id,
      old_tier: null,
      new_tier: tier,
      reason: item.reason,
      actor,
    });
    if (url) await supabase.from("sightings").insert({ block_id: block.id, page_url: url, quoted_text: sentence });
    saved.push({ ...item, tier, block_id: block.id });
  }
  return saved;
}

// ---------- helpers ----------

function validate(sentences: string[], max: number, cap: number) {
  if (!Array.isArray(sentences) || sentences.length === 0) throw new Error("needs sentences");
  if (sentences.length > max) throw new Error(`takes at most ${max} sentences at a time`);
  if (!(Number(cap) >= 0)) throw new Error("needs daily_cap_usd");
}

// Keeps a part's quoted words only if they really appear in the sentence (ignoring case,
// spacing and curly quotes), so the page never marks words that aren't there.
function fitQuote(sentence: string, quote: string | null | undefined): string | null {
  if (!quote) return null;
  const plain = (s: string) => s.replace(/[â€˜â€™]/g, "'").replace(/[â€œâ€]/g, '"').replace(/\s+/g, " ").trim().toLowerCase();
  const words = plain(quote);
  return words && plain(sentence).includes(words) ? quote.trim() : null;
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

// Fingerprint of a sentence, ignoring case and spacing differences.
export async function hash(sentence: string) {
  const normalized = sentence.toLowerCase().replace(/\s+/g, " ").trim();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
