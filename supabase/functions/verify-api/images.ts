// The "read_images" action: find out whether post images contain text, transcribe it, and
// decide what each image is as a whole (exhibit mode): an exhibit (an email, document,
// screenshot of a post, quote card, chart: graded once, on provenance), the poster's own words
// (a meme: its text goes through the normal lookup), or nothing to read.
// Each image gets one cheap Claude Haiku look; the answer is remembered by image address,
// so an image is only ever paid for once. Images read before exhibit mode get one more look.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { ask, type Item, spentToday } from "./check.ts";
import { exhibitItem } from "./exhibits.ts";
import { IMAGE_SCHEMA, IMAGE_SYSTEM } from "./prompts.ts";

const MAX_IMAGES = 4;

type Unit = "exhibit" | "own_words" | "none";

type ImageResult = {
  url: string;
  status: "remembered" | "read" | "skipped_cap" | "error";
  has_text: boolean;
  text: string | null;
  description: string | null;
  unit: Unit;
  // For an exhibit: its card item (its provenance check, or "not checked yet").
  item?: Item;
  error?: string;
};

export async function readImages(
  supabase: SupabaseClient,
  { images, daily_cap_usd }: { images: string[]; daily_cap_usd: number },
) {
  if (!Array.isArray(images) || images.length === 0) throw new Error("read_images needs images");
  if (images.length > MAX_IMAGES) throw new Error(`read_images takes at most ${MAX_IMAGES} images at a time`);
  if (!(Number(daily_cap_usd) >= 0)) throw new Error("read_images needs daily_cap_usd");

  const { data: remembered, error } = await supabase
    .from("image_memory")
    .select("image_url, has_text, text, description, seen_count, unit, exhibit, block_id")
    .in("image_url", images);
  if (error) throw error;
  const memory = new Map(remembered.map((row) => [row.image_url, row]));
  const underCap = await spentToday(supabase) < Number(daily_cap_usd);

  const results = await Promise.all(images.map(async (url): Promise<ImageResult> => {
    const known = memory.get(url);
    if (known?.unit) {
      await supabase.from("image_memory")
        .update({ seen_count: known.seen_count + 1, last_seen: new Date().toISOString() })
        .eq("image_url", url);
      return withItem(supabase, {
        url, status: "remembered", has_text: known.has_text, text: known.text, description: known.description, unit: known.unit,
      }, known);
    }
    if (!underCap) {
      // Read before exhibit mode: keep using its text as the poster's words until it's looked at again.
      return known
        ? { url, status: "remembered", has_text: known.has_text, text: known.text, description: known.description, unit: known.has_text ? "own_words" : "none" }
        : { url, status: "skipped_cap", has_text: false, text: null, description: null, unit: "none" };
    }

    try {
      const out = await ask(supabase, "image", {
        system: IMAGE_SYSTEM,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "url", url } },
            { type: "text", text: "Read this image." },
          ],
        }],
        output_config: { effort: "low", format: { type: "json_schema", schema: IMAGE_SCHEMA } },
      });
      const text = out.has_text && out.text?.trim() ? out.text.trim() : null;
      const unit: Unit = out.unit === "exhibit" && out.exhibit ? "exhibit" : text ? "own_words" : "none";
      const row = {
        image_url: url,
        has_text: text !== null,
        text,
        description: out.description,
        unit,
        exhibit: unit === "exhibit" ? out.exhibit : null,
        last_seen: new Date().toISOString(),
      };
      const { error: saveError } = await supabase.from("image_memory").upsert(row);
      if (saveError) throw saveError;
      return withItem(supabase, {
        url, status: "read", has_text: text !== null, text, description: out.description, unit,
      }, { ...row, block_id: known?.block_id ?? null });
    } catch (err) {
      return {
        url,
        status: "error",
        has_text: false,
        text: null,
        description: null,
        unit: "none",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }));

  return { results, spent_today_usd: await spentToday(supabase) };
}

// deno-lint-ignore no-explicit-any
async function withItem(supabase: SupabaseClient, result: ImageResult, row: any): Promise<ImageResult> {
  if (result.unit !== "exhibit" || !row.exhibit) return result;
  return { ...result, item: await exhibitItem(supabase, row) };
}
