// The "read_images" action: find out whether post images contain text, and transcribe it.
// Each image gets one cheap Claude Haiku look; the answer is remembered by image address,
// so an image is only ever paid for once. The text found then goes through the normal lookup.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { ask, spentToday } from "./check.ts";
import { IMAGE_SCHEMA, IMAGE_SYSTEM } from "./prompts.ts";

const MAX_IMAGES = 4;

type ImageResult = {
  url: string;
  status: "remembered" | "read" | "skipped_cap" | "error";
  has_text: boolean;
  text: string | null;
  description: string | null;
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
    .select("image_url, has_text, text, description, seen_count")
    .in("image_url", images);
  if (error) throw error;
  const memory = new Map(remembered.map((row) => [row.image_url, row]));
  const underCap = await spentToday(supabase) < Number(daily_cap_usd);

  const results = await Promise.all(images.map(async (url): Promise<ImageResult> => {
    const known = memory.get(url);
    if (known) {
      await supabase.from("image_memory")
        .update({ seen_count: known.seen_count + 1, last_seen: new Date().toISOString() })
        .eq("image_url", url);
      return { url, status: "remembered", has_text: known.has_text, text: known.text, description: known.description };
    }
    if (!underCap) return { url, status: "skipped_cap", has_text: false, text: null, description: null };

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
      await supabase.from("image_memory").insert({
        image_url: url,
        has_text: text !== null,
        text,
        description: out.description,
      });
      return { url, status: "read", has_text: text !== null, text, description: out.description };
    } catch (err) {
      return {
        url,
        status: "error",
        has_text: false,
        text: null,
        description: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }));

  return { results, spent_today_usd: await spentToday(supabase) };
}
