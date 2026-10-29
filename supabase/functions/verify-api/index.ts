// TeemVerify server function: the only door into the block store.
// Deployed with scripts/deploy.ps1, JWT verification turned off;
// callers prove themselves with the TEEMVERIFY_TOKEN secret instead.
//
// Actions (POST JSON with an "action" field):
//   match          { text, threshold?, count? } -> blocks whose meaning is close to text
//   embed_missing  {}                           -> fills in embeddings for blocks that lack one
//   export         {}                           -> every row of every block store table, as JSON
//   lookup         { url, sentences, daily_cap_usd } -> cheap labelling of up to 20 sentences;
//                                                     claims go to the research queue (see check.ts)
//   check          { url, sentences, daily_cap_usd } -> researches up to 6 sentences now
//   queue_next     { limit? }                   -> claims waiting for research, most-seen first
//   submit_results { results }                  -> research findings from Claude Code
//   read_images    { images, daily_cap_usd }    -> text found in up to 4 post images (see images.ts)
//   spend          {}                           -> what Claude calls have cost so far today (UTC)

import { createClient } from "npm:@supabase/supabase-js@2";
import { checkSentences, lookupSentences, queueNext, spentToday, submitResults } from "./check.ts";
import { readImages } from "./images.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// Supabase's built-in gte-small model: 384 numbers per sentence.
const model = new Supabase.ai.Session("gte-small");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-teemverify-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function embed(text: string): Promise<string> {
  const vector = await model.run(text, { mean_pool: true, normalize: true });
  // pgvector reads vectors written as "[0.1,0.2,...]".
  return JSON.stringify(vector);
}

async function match(text: string, threshold = 0.85, count = 5) {
  const { data, error } = await supabase.rpc("match_blocks", {
    query_embedding: await embed(text),
    match_threshold: threshold,
    match_count: count,
  });
  if (error) throw error;
  return { matches: data };
}

async function embedMissing() {
  const { data: blocks, error } = await supabase
    .from("blocks")
    .select("id, claim_text")
    .is("embedding", null)
    .limit(100);
  if (error) throw error;

  for (const block of blocks) {
    const { error: updateError } = await supabase
      .from("blocks")
      .update({ embedding: await embed(block.claim_text) })
      .eq("id", block.id);
    if (updateError) throw updateError;
  }
  return { embedded: blocks.length };
}

const EXPORT_TABLES = [
  "blocks",
  "exhibits",
  "block_exhibits",
  "tier_history",
  "sightings",
  "challenges",
  "non_fact_tags",
  "api_spend",
  "sentence_memory",
  "claim_queue",
  "image_memory",
];
const PAGE_SIZE = 1000;

async function exportAll() {
  const tables: Record<string, unknown[]> = {};
  for (const table of EXPORT_TABLES) {
    const rows: unknown[] = [];
    // Supabase returns at most 1000 rows per request, so read in pages.
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await supabase
        .from(table)
        .select("*")
        .range(from, from + PAGE_SIZE - 1);
      if (error) throw error;
      rows.push(...data);
      if (data.length < PAGE_SIZE) break;
    }
    tables[table] = rows;
  }
  return { exported_at: new Date().toISOString(), tables };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return reply({ error: "Use POST" }, 405);

  if (req.headers.get("x-teemverify-token") !== Deno.env.get("TEEMVERIFY_TOKEN")) {
    return reply({ error: "Not allowed" }, 401);
  }

  try {
    const body = await req.json();
    switch (body.action) {
      case "match":
        if (typeof body.text !== "string" || !body.text.trim()) {
          return reply({ error: "match needs text" }, 400);
        }
        return reply(await match(body.text, body.threshold, body.count));
      case "embed_missing":
        return reply(await embedMissing());
      case "export":
        return reply(await exportAll());
      case "lookup":
        return reply(await lookupSentences(supabase, embed, body));
      case "check":
        return reply(await checkSentences(supabase, embed, body));
      case "read_images":
        return reply(await readImages(supabase, body));
      case "queue_next":
        return reply(await queueNext(supabase, body));
      case "submit_results":
        return reply(await submitResults(supabase, embed, body));
      case "spend":
        return reply({ spent_today_usd: await spentToday(supabase) });
      default:
        return reply({ error: `Unknown action: ${body.action}` }, 400);
    }
  } catch (err) {
    console.error(err);
    return reply({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
