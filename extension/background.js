import { callVerifyApi, getSettings } from "./api.js";

// Sentences per request. Lookups are limited by Supabase's free-tier CPU allowance; researched
// checks take a while, and each request must finish within Supabase's time limit.
const LOOKUP_CHUNK = 8;
const CHECK_CHUNK = 5;

// Progress for each tab lives in session storage under "check:<tabId>", so the popup can
// close and reopen while work keeps running here. Shape:
//   { url, status: "running" | "done" | "cap_reached" | "error", task, done, total,
//     results: [{ index, sentence, status, items, error? }], spentTodayUsd, error }

async function save(key, progress) {
  await chrome.storage.session.set({ [key]: progress });
}

async function lookupPage(tabId, page) {
  const key = `check:${tabId}`;
  const { dailyCapUsd } = await getSettings();
  const sentences = page.sentences.map((s) => s.text);
  const progress = {
    url: page.url,
    status: "running",
    task: "Looking up",
    done: 0,
    total: sentences.length,
    results: [],
    spentTodayUsd: null,
    error: null,
  };
  await save(key, progress);

  for (let start = 0; start < sentences.length; start += LOOKUP_CHUNK) {
    try {
      const reply = await callVerifyApi("lookup", {
        url: page.url,
        sentences: sentences.slice(start, start + LOOKUP_CHUNK),
        daily_cap_usd: dailyCapUsd,
      });
      // Server indexes are per chunk; store page-wide ones.
      progress.results.push(...reply.results.map((r) => ({ ...r, index: start + r.index })));
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

// Messages:
//   { type: "api", action, payload }      -> { ok, data } or { ok: false, error }
//   { type: "lookupPage", tabId, page }   -> starts a lookup; progress appears in session storage
//   { type: "checkNow", tabId, indexes }  -> researches those sentences now
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "api") {
    callVerifyApi(message.action, message.payload)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // keeps the channel open for the async reply
  }
  if (message?.type === "lookupPage") {
    lookupPage(message.tabId, message.page);
    sendResponse({ ok: true });
  }
  if (message?.type === "checkNow") {
    checkNow(message.tabId, message.indexes);
    sendResponse({ ok: true });
  }
  return false;
});
