import { callVerifyApi, getSettings } from "./api.js";

// Sentences per request. Each request must finish within Supabase's time limit,
// and a full check with web search takes a while.
const CHUNK_SIZE = 5;

// Progress for each tab lives in session storage under "check:<tabId>", so the popup
// can close and reopen while a check keeps running here.
async function checkPage(tabId, page) {
  const key = `check:${tabId}`;
  const { dailyCapUsd } = await getSettings();
  const progress = {
    status: "running",
    url: page.url,
    total: page.sentences.length,
    done: 0,
    results: [],
    spentTodayUsd: null,
    error: null,
  };
  await chrome.storage.session.set({ [key]: progress });

  for (let start = 0; start < page.sentences.length; start += CHUNK_SIZE) {
    const chunk = page.sentences.slice(start, start + CHUNK_SIZE).map((s) => s.text);
    try {
      const reply = await callVerifyApi("check", {
        url: page.url,
        sentences: chunk,
        daily_cap_usd: dailyCapUsd,
      });
      progress.results.push(...reply.results);
      progress.spentTodayUsd = reply.spent_today_usd;
      if (reply.results.some((r) => r.status === "skipped_cap")) {
        progress.status = "cap_reached";
        break;
      }
    } catch (err) {
      progress.status = "error";
      progress.error = err.message;
      break;
    } finally {
      progress.done = Math.min(start + CHUNK_SIZE, page.sentences.length);
      await chrome.storage.session.set({ [key]: progress });
    }
  }

  if (progress.status === "running") progress.status = "done";
  await chrome.storage.session.set({ [key]: progress });
}

// Messages:
//   { type: "api", action, payload }   -> { ok, data } or { ok: false, error }
//   { type: "checkPage", tabId, page } -> starts a check; progress appears in session storage
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "api") {
    callVerifyApi(message.action, message.payload)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // keeps the channel open for the async reply
  }
  if (message?.type === "checkPage") {
    checkPage(message.tabId, message.page);
    sendResponse({ ok: true });
  }
  return false;
});
