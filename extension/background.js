import { callVerifyApi, getSettings } from "./api.js";

// Sentences per request. Lookups are limited by Supabase's free-tier CPU allowance; researched
// checks take a while, and each request must finish within Supabase's time limit.
const LOOKUP_CHUNK = 8;
const CHECK_CHUNK = 5;

const IMAGE_CHUNK = 4;
const MIN_WORDS = 4;

// Progress for each tab lives in session storage under "check:<tabId>", so the popup can
// close and reopen while work keeps running here. Shape:
//   { url, status: "running" | "done" | "cap_reached" | "error", task, done, total,
//     results: [{ index, sentence, status, items, error?, image? }], spentTodayUsd, error }
// A result with "image" set came from text Claude read in that image.

async function save(key, progress) {
  await chrome.storage.session.set({ [key]: progress });
  await showOnPage(Number(key.split(":")[1]), progress);
}

// Draws the latest results on the page itself (content/marks.js), injecting it the first
// time. Fails quietly if the tab has moved on to another page.
async function showOnPage(tabId, progress) {
  try {
    const injected = await chrome.tabs.sendMessage(tabId, { type: "tv-ping" }).catch(() => false);
    if (!injected) {
      await chrome.scripting.insertCSS({ target: { tabId }, files: ["content/verify.css"] });
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content/marks.js"] });
    }
    await chrome.tabs.sendMessage(tabId, {
      type: "tv-render",
      results: progress.results,
      status: progress.status,
    });
  } catch (err) {
    console.warn("Couldn't draw labels on the page:", err);
  }
}

// Reads the page's images and returns their text as sentences, image by image.
async function imageSentences(images, dailyCapUsd) {
  const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
  const found = [];
  for (let start = 0; start < images.length; start += IMAGE_CHUNK) {
    const reply = await callVerifyApi("read_images", {
      images: images.slice(start, start + IMAGE_CHUNK),
      daily_cap_usd: dailyCapUsd,
    });
    for (const image of reply.results) {
      if (!image.has_text) continue;
      for (const line of image.text.split(/\n+/)) {
        for (const { segment } of segmenter.segment(line)) {
          const text = segment.trim();
          if (text.split(/\s+/).length >= MIN_WORDS) found.push({ text, image: image.url });
        }
      }
    }
  }
  return found;
}

async function lookupPage(tabId, page) {
  const key = `check:${tabId}`;
  const { dailyCapUsd } = await getSettings();
  const progress = {
    url: page.url,
    status: "running",
    task: "Reading images",
    done: 0,
    total: page.sentences.length,
    results: [],
    spentTodayUsd: null,
    error: null,
  };
  await save(key, progress);

  // Image text comes first: the image is usually what the post and its comments are about.
  let fromImages = [];
  if (page.images?.length) {
    try {
      fromImages = await imageSentences(page.images, dailyCapUsd);
    } catch (err) {
      console.warn("Couldn't read images:", err);
    }
  }
  const entries = [...fromImages, ...page.sentences.map((s) => ({ text: s.text }))];
  const sentences = entries.map((e) => e.text);
  progress.task = "Looking up";
  progress.total = sentences.length;
  await save(key, progress);

  for (let start = 0; start < sentences.length; start += LOOKUP_CHUNK) {
    try {
      const reply = await callVerifyApi("lookup", {
        url: page.url,
        sentences: sentences.slice(start, start + LOOKUP_CHUNK),
        daily_cap_usd: dailyCapUsd,
      });
      // Server indexes are per chunk; store page-wide ones.
      progress.results.push(...reply.results.map((r) => ({
        ...r,
        index: start + r.index,
        image: entries[start + r.index].image,
      })));
      progress.spentTodayUsd = reply.spent_today_usd;
      if (reply.results.some((r) => r.status === "skipped_cap")) progress.status = "cap_reached";
    } catch (err) {
      progress.status = "error";
      progress.error = err.message;
    }
    progress.done = Math.min(start + LOOKUP_CHUNK, sentences.length);
    await save(key, progress);
    if (progress.status !== "running") return;
  }
  progress.status = "done";
  await save(key, progress);
}

// Researches the given sentences right away (costs API money), replacing their results.
async function checkNow(tabId, indexes) {
  const key = `check:${tabId}`;
  const { [key]: progress } = await chrome.storage.session.get(key);
  if (!progress) return;
  const { dailyCapUsd } = await getSettings();
  const targets = progress.results.filter((r) => indexes.includes(r.index));
  progress.status = "running";
  progress.task = "Checking";
  progress.done = 0;
  progress.total = targets.length;
  progress.error = null;
  await save(key, progress);

  for (let start = 0; start < targets.length; start += CHECK_CHUNK) {
    const chunk = targets.slice(start, start + CHECK_CHUNK);
    try {
      const reply = await callVerifyApi("check", {
        url: progress.url,
        sentences: chunk.map((r) => r.sentence),
        daily_cap_usd: dailyCapUsd,
      });
      reply.results.forEach((checked, i) => {
        const target = progress.results.find((r) => r.index === chunk[i].index);
        Object.assign(target, { status: checked.status, items: checked.items, error: checked.error });
      });
      progress.spentTodayUsd = reply.spent_today_usd;
      if (reply.results.some((r) => r.status === "skipped_cap")) progress.status = "cap_reached";
    } catch (err) {
      progress.status = "error";
      progress.error = err.message;
    }
    progress.done = Math.min(start + CHECK_CHUNK, targets.length);
    await save(key, progress);
    if (progress.status !== "running") return;
  }
  progress.status = "done";
  await save(key, progress);
}

// ---------- Becket's feedback from the claim card ----------

const FEEDBACK_ACTIONS = ["confirm", "challenge", "reword", "prioritize"];

// Sends one feedback action, then writes any change into this tab's results so the page
// redraws with the new label.
async function feedback(tabId, action, payload) {
  if (!FEEDBACK_ACTIONS.includes(action)) throw new Error(`Unknown feedback: ${action}`);
  const key = `check:${tabId}`;
  const { [key]: progress } = await chrome.storage.session.get(key);
  const { dailyCapUsd } = await getSettings();
  const data = await callVerifyApi(action, { ...payload, url: progress?.url, daily_cap_usd: dailyCapUsd });
  if (progress && data.patch && payload.block_id) {
    for (const result of progress.results) {
      result.items = result.items.map((i) => i.block_id === payload.block_id ? { ...i, ...data.patch } : i);
    }
    await save(key, progress);
  }
  return data;
}

// "Add claim": text Becket selected on the page becomes a sentence of its own. It's looked up
// like any other (free if known), then checked now or put at the front of the research queue.
async function addClaim(tabId, url, text, mode) {
  const key = `check:${tabId}`;
  let { [key]: progress } = await chrome.storage.session.get(key);
  if (progress?.status === "running") throw new Error("Wait until the page check finishes.");
  if (!progress || progress.url !== url) {
    progress = { url, status: "done", task: "", done: 0, total: 0, results: [], spentTodayUsd: null, error: null };
  }
  const { dailyCapUsd } = await getSettings();
  const index = progress.results.reduce((next, r) => Math.max(next, r.index + 1), 0);
  const unchecked = { kind: "claim", text, tier: null, reason: "Waiting for research.", scope: null, as_of: null, resolve_by: null, exhibits: [], quote: null };
  const result = { index, sentence: text, status: "queued", items: [unchecked], added: true };
  progress.results.push(result);

  const reply = await callVerifyApi("lookup", { url, sentences: [text], daily_cap_usd: dailyCapUsd });
  const [found] = reply.results;
  if (found?.items?.length) Object.assign(result, { status: found.status, items: found.items });
  progress.spentTodayUsd = reply.spent_today_usd;
  await save(key, progress);

  // Already labelled from memory or the library: nothing more to do.
  const known = ["remembered", "from_library"].includes(result.status) &&
    result.items.every((i) => i.kind !== "claim" || i.tier);
  if (known) return { status: result.status };
  if (mode === "now") {
    // Runs on in the background; the page shows the spinner and then the label.
    checkNow(tabId, [index]);
    return { status: "checking" };
  }
  const picked = await callVerifyApi("prioritize", { sentence: text, url });
  // A selection first sorted as a non-claim is still researched, since Becket picked it.
  if (!result.items.some((i) => i.kind === "claim")) result.items = picked.items;
  result.status = "queued";
  await save(key, progress);
  return { status: "queued", picked_waiting: picked.picked_waiting };
}

// Messages:
//   { type: "api", action, payload }      -> { ok, data } or { ok: false, error }
//   { type: "lookupPage", tabId, page }   -> starts a lookup; progress appears in session storage
//   { type: "checkNow", tabId, indexes }  -> researches those sentences now (from the page's
//                                            claim card, tabId is the sender's tab)
//   { type: "feedback", action, payload } -> confirm / challenge / reword / prioritize, from a card
//   { type: "addClaim", text, mode }      -> selected text, checked "now" or researched "later"
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "api") {
    callVerifyApi(message.action, message.payload)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // keeps the channel open for the async reply
  }
  if (message?.type === "feedback") {
    feedback(sender.tab?.id, message.action, message.payload)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (message?.type === "addClaim") {
    addClaim(sender.tab?.id, sender.tab?.url, message.text, message.mode)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (message?.type === "lookupPage") {
    lookupPage(message.tabId, message.page);
    sendResponse({ ok: true });
  }
  if (message?.type === "checkNow") {
    checkNow(message.tabId ?? sender.tab?.id, message.indexes);
    sendResponse({ ok: true });
  }
  return false;
});
