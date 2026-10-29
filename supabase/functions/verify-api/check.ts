// The "check" action: grade a handful of sentences from one page.
//
// 1. Meaning search finds a stored claim that might match each sentence.
// 2. A quick Claude call (no web search) confirms the match is the same claim,
//    not the opposite or a different one. Only "same" reuses the stored label.
// 3. Everything else gets a full Claude check with web search.
// 4. Results are saved as AI drafts. Every Claude call is logged in api_spend,
//    and checking stops once today's spending reaches the daily cap.

import Anthropic from "npm:@anthropic-ai/sdk";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { CHECK_SCHEMA, CHECK_SYSTEM, COMPARE_SCHEMA, COMPARE_SYSTEM } from "./prompts.ts";

const MODEL = "claude-opus-5-5";
// Claude Opus 5.5 prices in US dollars, and web search per search.
const PRICE_PER_INPUT_TOKEN = 4 / 1_000_000;
const PRICE_PER_OUTPUT_TOKEN = 20 / 1_000_000;
const PRICE_PER_CACHE_READ_TOKEN = 0.2 / 1_000_000;
const PRICE_PER_SEARCH = 10 / 1_000;

const MATCH_THRESHOLD = 0.8;
const MAX_SENTENCES = 6;
const MAX_SEARCHES_PER_CHECK = 6;

const anthropic = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY") });

type Embed = (text: string) => Promise<string>;

type Item = {
  kind: "claim" | "value" | "opinion" | "forecast" | "not_a_claim";
  text: string;
  tier: number | null;
  reason: string;
  scope: string | null;
  as_of: string | null;
  resolve_by: string | null;
  exhibits: { url: string; location: string; source_type: string }[];
};

export type SentenceResult = {
  index: number;
  sentence: string;
  status: "checked" | "from_store" | "skipped_cap" | "error";
  items: (Item & { block_id?: string })[];
  error?: string;
};

export async function checkSentences(
  supabase: SupabaseClient,
  embed: Embed,
  { url, sentences, daily_cap_usd }: { url: string; sentences: string[]; daily_cap_usd: number },
) {
  if (!Array.isArray(sentences) || sentences.length === 0) throw new Error("check needs sentences");
  if (sentences.length > MAX_SENTENCES) throw new Error(`check takes at most ${MAX_SENTENCES} sentences at a time`);
  const cap = Number(daily_cap_usd);
  if (!(cap >= 0)) throw new Error("check needs daily_cap_usd");

  const results: SentenceResult[] = sentences.map((sentence, index) => ({
    index,
    sentence,
    status: "checked",
    items: [],
  }));

  // 1. Meaning search: the best stored candidate for each sentence.
  const embeddings = await Promise.all(sentences.map(embed));
  const candidates = await Promise.all(embeddings.map(async (embedding) => {
    const { data, error } = await supabase.rpc("match_blocks", {
      query_embedding: embedding,
      match_threshold: MATCH_THRESHOLD,
      match_count: 1,
    });
    if (error) throw error;
    return data[0] ?? null;
  }));

  // 2. Confirm candidates are the same claim.
  const pairs = results.filter((r) => candidates[r.index]);
  const reused = new Set<number>();
  if (pairs.length > 0 && await spentToday(supabase) < cap) {
    const relations = await compare(supabase, pairs.map((r) => [r.sentence, candidates[r.index].claim_text]));
    for (const [pairIndex, relation] of relations) {
      if (relation !== "same") continue;
      const result = pairs[pairIndex];
      const block = candidates[result.index];
      const exhibits = await exhibitsFor(supabase, block.id);
      result.status = "from_store";
      result.items = [{
        kind: "claim",
        text: block.claim_text,
        tier: block.tier,
        reason: block.reason ?? "",
        scope: null,
        as_of: null,
        resolve_by: null,
        exhibits,
        block_id: block.id,
      }];
      await supabase.from("sightings").insert({ block_id: block.id, page_url: url, quoted_text: result.sentence });
      reused.add(result.index);
    }
  }

  // 3. Full check for everything not reused.
  const toCheck = results.filter((r) => !reused.has(r.index));
  if (toCheck.length === 0) return { results, spent_today_usd: await spentToday(supabase) };

  if (await spentToday(supabase) >= cap) {
    for (const r of toCheck) r.status = "skipped_cap";
    return { results, spent_today_usd: await spentToday(supabase) };
  }

  let graded: Map<number, Item[]>;
  try {
    graded = await fullCheck(supabase, url, toCheck.map((r) => r.sentence));
  } catch (err) {
    for (const r of toCheck) {
      r.status = "error";
      r.error = err instanceof Error ? err.message : String(err);
    }
    return { results, spent_today_usd: await spentToday(supabase) };
  }

  // 4. Save.
  for (const [checkIndex, items] of graded) {
    const result = toCheck[checkIndex];
    if (!result) continue;
    result.items = [];
    for (const item of items) {
      result.items.push({ ...item, block_id: await save(supabase, embed, url, result.sentence, item) });
    }
  }
  for (const r of toCheck) {
    if (r.items.length === 0) {
      r.status = "error";
      r.error = "No result came back for this sentence.";
    }
  }

  return { results, spent_today_usd: await spentToday(supabase) };
}

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

async function logSpend(supabase: SupabaseClient, purpose: "compare" | "check", usage: Anthropic.Beta.BetaUsage) {
  const searches = usage.server_tool_use?.web_search_requests ?? 0;
  const cost = usage.input_tokens * PRICE_PER_INPUT_TOKEN +
    (usage.cache_read_input_tokens ?? 0) * PRICE_PER_CACHE_READ_TOKEN +
    usage.output_tokens * PRICE_PER_OUTPUT_TOKEN +
    searches * PRICE_PER_SEARCH;
  const { error } = await supabase.from("api_spend").insert({
    purpose,
    model: MODEL,
    input_tokens: usage.input_tokens + (usage.cache_read_input_tokens ?? 0),
    output_tokens: usage.output_tokens,
    web_searches: searches,
    cost_usd: cost,
  });
  if (error) throw error;
}

// Sends a request, continuing it if a long web search pauses the turn. Logs spend for every call.
async function ask(
  supabase: SupabaseClient,
  purpose: "compare" | "check",
  params: Omit<Anthropic.Beta.MessageCreateParamsNonStreaming, "model" | "max_tokens" | "betas">,
) {
  const messages = [...params.messages];
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await anthropic.beta.messages.create({
      ...params,
      model: MODEL,
      max_tokens: 16000,
      messages,
      betas: ["server-side-fallback-2026-07-01"],
      // If a safety check declines the request, Anthropic retries it on a suitable model.
      fallbacks: "default",
    } as Anthropic.Beta.MessageCreateParamsNonStreaming);
    await logSpend(supabase, purpose, response.usage);

    if (response.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: response.content });
      continue;
    }
    if (response.stop_reason === "refusal") throw new Error("Claude declined to check this text.");
    if (response.stop_reason === "max_tokens") throw new Error("Claude's answer was cut off. Try fewer sentences.");

    const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    return JSON.parse(text);
  }
  throw new Error("The check took too many rounds.");
}

async function compare(supabase: SupabaseClient, pairs: [string, string][]): Promise<[number, string][]> {
  const list = pairs.map(([a, b], i) => `${i}. A: ${a}\n   B: ${b}`).join("\n");
  const out = await ask(supabase, "compare", {
    system: COMPARE_SYSTEM,
    messages: [{ role: "user", content: list }],
    output_config: { effort: "low", format: { type: "json_schema", schema: COMPARE_SCHEMA } },
  });
  return out.results.map((r: { index: number; relation: string }) => [r.index, r.relation]);
}

async function fullCheck(supabase: SupabaseClient, url: string, sentences: string[]): Promise<Map<number, Item[]>> {
  const today = new Date().toISOString().slice(0, 10);
  const list = sentences.map((s, i) => `${i}. ${s}`).join("\n");
  const out = await ask(supabase, "check", {
    system: CHECK_SYSTEM,
    messages: [{ role: "user", content: `Today is ${today}. Page: ${url}\n\nSentences:\n${list}` }],
    tools: [{ type: "web_search_20260209", name: "web_search", max_uses: MAX_SEARCHES_PER_CHECK }],
    output_config: { effort: "medium", format: { type: "json_schema", schema: CHECK_SCHEMA } },
  });
  return new Map(out.results.map((r: { index: number; items: Item[] }) => [r.index, r.items]));
}

async function exhibitsFor(supabase: SupabaseClient, blockId: string) {
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

// Saves one graded item. Claims become ai_draft blocks with exhibits, tier history and a
// sighting; values, opinions and forecasts become non_fact_tags. Returns the block id.
async function save(
  supabase: SupabaseClient,
  embed: Embed,
  url: string,
  sentence: string,
  item: Item,
): Promise<string | undefined> {
  if (item.kind === "not_a_claim") return undefined;

  if (item.kind !== "claim") {
    const { error } = await supabase.from("non_fact_tags").insert({
      statement_text: item.text,
      tag: item.kind,
      resolve_by: item.resolve_by,
      page_url: url,
    });
    if (error) throw error;
    return undefined;
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

  for (const exhibit of item.exhibits) {
    const { data: saved, error: exhibitError } = await supabase.from("exhibits").insert({
      source_url: exhibit.url,
      location: exhibit.location,
      source_type: exhibit.source_type,
    }).select("id").single();
    if (exhibitError) throw exhibitError;
    await supabase.from("block_exhibits").insert({ block_id: block.id, exhibit_id: saved.id });
  }

  await supabase.from("tier_history").insert({
    block_id: block.id,
    old_tier: null,
    new_tier: tier,
    reason: item.reason,
    actor: "model",
  });
  await supabase.from("sightings").insert({ block_id: block.id, page_url: url, quoted_text: sentence });
  return block.id;
}
