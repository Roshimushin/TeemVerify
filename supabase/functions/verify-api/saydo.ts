// Say-do card (prototype): a statement that can be checked against the speaker's own record.
// First two triggers (Build Queue, START HERE item 6):
//   credit_taking: taking credit for a law or program, shown beside the speaker's dated vote on it;
//   accusation:    accusing others of something, shown beside the speaker's own dated record.
// Pairs are entered by hand for now (add_say_do), as "manual vote blocks"; vote-data import comes later.
// The card shows the dated pair, any bundled-bill context and the speaker's stated reason.
// Verify never applies the word "hypocrite" (a character judgment): the reader judges the pair.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { Item } from "./check.ts";

export type SayDoTrigger = "credit_taking" | "accusation";

export type SayDo = {
  trigger: SayDoTrigger;
  actor: string;
  subject: string | null;
  pairs?: SayDoPair[];
};

export type SayDoPair = {
  id: string;
  trigger: SayDoTrigger | "promise" | "position";
  actor: string;
  statement_text: string;
  statement_date: string | null;
  statement_url: string | null;
  action_text: string;
  action_date: string | null;
  action_url: string | null;
  relation: "match" | "gap";
  bundled_context: string | null;
  stated_reason: string | null;
  stated_reason_url: string | null;
  status: string;
};

const PAIR_COLUMNS = "id, trigger, actor, statement_text, statement_date, statement_url, action_text, action_date, " +
  "action_url, relation, bundled_context, stated_reason, stated_reason_url, status";
const MAX_PAIRS = 3;
const TRIGGERS = ["credit_taking", "accusation", "promise", "position"];
// A character judgment, never a label Verify applies.
const JUDGMENT = /hypocri/i;

// Claude answers "none" when a sentence isn't one of the triggers; stored items use null.
// deno-lint-ignore no-explicit-any
export function tidySayDo(value: any): SayDo | null {
  if (!value || value.trigger === "none" || !TRIGGERS.includes(value.trigger)) return null;
  const actor = typeof value.actor === "string" ? value.actor.trim() : "";
  if (!actor) return null;
  return { trigger: value.trigger, actor, subject: value.subject?.trim() || null };
}

// Adds the speaker's matching dated pairs to each item that takes credit or accuses.
export async function attachSayDo(supabase: SupabaseClient, items: Item[]): Promise<Item[]> {
  const out: Item[] = [];
  // One sentence's parts often share a trigger ("X said she delivered Y" and "X delivered Y"):
  // the record is shown once, on the first.
  const shown = new Set<string>();
  for (const item of items) {
    const sayDo = tidySayDo(item.say_do);
    const key = sayDo && `${sayDo.trigger}|${sayDo.actor.toLowerCase()}|${(sayDo.subject ?? "").toLowerCase()}`;
    if (!sayDo || shown.has(key!)) {
      out.push({ ...item, say_do: null });
      continue;
    }
    shown.add(key!);
    // Names vary ("Alvarez", "Senator Alvarez", "Sen. Maria Alvarez"): match on the surname,
    // then keep only pairs about the same subject.
    const surname = sayDo.actor.replace(/[%_]/g, "").trim().split(/\s+/).pop() ?? "";
    if (surname.length < 3) {
      out.push({ ...item, say_do: { ...sayDo, pairs: [] } });
      continue;
    }
    const { data } = await supabase.from("say_do_pairs").select(PAIR_COLUMNS)
      .ilike("actor", `%${surname}%`)
      .eq("trigger", sayDo.trigger)
      .order("statement_date", { ascending: false, nullsFirst: false })
      .limit(20);
    const pairs = aboutSubject((data ?? []) as SayDoPair[], sayDo.subject).slice(0, MAX_PAIRS);
    out.push({ ...item, say_do: { ...sayDo, pairs } });
  }
  return out;
}

// Pairs about the same law or act: they share a distinctive word with the subject
// (a bill name or number, the act named). With no subject, none are shown, so an unrelated
// pair is never put beside a statement.
function aboutSubject(pairs: SayDoPair[], subject: string | null): SayDoPair[] {
  if (!subject) return [];
  const words = distinctive(subject);
  if (!words.length) return [];
  return pairs.filter((pair) => {
    const text = `${pair.statement_text} ${pair.action_text} ${pair.bundled_context ?? ""}`.toLowerCase();
    return words.some((word) => text.includes(word));
  });
}

const COMMON = new Set([
  "the", "and", "for", "act", "bill", "law", "with", "that", "this", "from", "their", "they", "have",
  "money", "program", "plan", "people", "other", "others", "about", "which", "were", "been",
]);

function distinctive(text: string): string[] {
  return [...new Set(text.toLowerCase().match(/[a-z0-9.\-]+/g) ?? [])]
    .filter((word) => (word.length > 3 || /\d/.test(word)) && !COMMON.has(word));
}

// Becket (or a research-queue session) records a dated statement-action pair by hand.
// deno-lint-ignore no-explicit-any
export async function addSayDo(supabase: SupabaseClient, { pair, actor_kind = "manual" }: { pair: any; actor_kind?: string }) {
  if (!pair) throw new Error("add_say_do needs pair");
  for (const field of ["actor", "trigger", "statement_text", "action_text", "relation"]) {
    if (!pair[field] || typeof pair[field] !== "string") throw new Error(`add_say_do needs pair.${field}`);
  }
  for (const value of Object.values(pair)) {
    if (typeof value === "string" && JUDGMENT.test(value)) {
      throw new Error("Describe what was said and done; Verify doesn't apply character labels like that one.");
    }
  }
  const { data, error } = await supabase.from("say_do_pairs").insert({
    actor: pair.actor.trim(),
    trigger: pair.trigger,
    statement_text: pair.statement_text,
    statement_date: pair.statement_date ?? null,
    statement_url: pair.statement_url ?? null,
    statement_block_id: pair.statement_block_id ?? null,
    action_text: pair.action_text,
    action_date: pair.action_date ?? null,
    action_url: pair.action_url ?? null,
    action_block_id: pair.action_block_id ?? null,
    relation: pair.relation,
    bundled_context: pair.bundled_context ?? null,
    stated_reason: pair.stated_reason ?? null,
    stated_reason_url: pair.stated_reason_url ?? null,
    actor_kind,
  }).select("id").single();
  if (error) throw error;
  return { id: data.id };
}
