// Rough cost of researching one sentence right away with Claude Haiku 5.5 and web search,
// measured Oct 28, 2026 (mostly the $0.01 per web search). Lookups cost far less.
const CHECK_NOW_USD_PER_SENTENCE = 0.015;

const LABELS = {
  1: "Tier 1 · verified",
  2: "Tier 2 · conclusion",
  3: "Tier 3 · unverified",
  4: "Tier 4 · refuted",
  value: "Value",
  opinion: "Opinion",
  forecast: "Forecast ⏱",
  not_a_claim: "Not a claim",
  queued: "Queued",
};

const SOURCES = {
  remembered: "seen before",
  from_library: "from your library",
  checked: "checked just now",
};

const status = document.getElementById("status");
const lookupButton = document.getElementById("lookup");
const checkAllButton = document.getElementById("checkAll");
const result = document.getElementById("result");
const list = document.getElementById("list");

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const progressKey = `check:${tab.id}`;
let running = false;

function money(usd) {
  return usd < 0.01 ? "under 1¢" : `$${usd.toFixed(2)}`;
}

function setResult(text, kind = "muted") {
  result.hidden = false;
  result.className = kind;
  result.textContent = text;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function checkNow(indexes) {
  chrome.runtime.sendMessage({ type: "checkNow", tabId: tab.id, indexes });
}

function renderItem(item, sentenceStatus) {
  const line = el("div", "item");
  const waiting = item.kind === "claim" && item.tier == null;
  const label = waiting ? LABELS.queued : item.kind === "claim" ? LABELS[item.tier] : LABELS[item.kind];
  line.append(el("span", "badge", label));
  let detail = waiting ? item.text : item.kind === "not_a_claim" ? "" : item.reason || item.text;
  if (!waiting && SOURCES[sentenceStatus]) detail += ` (${SOURCES[sentenceStatus]})`;
  line.append(el("span", "reason", detail));
  return line;
}

function renderResults(results) {
  list.replaceChildren(...results.map((r) => {
    const li = el("li");
    li.append(el("div", "sentence", r.sentence));
    if (r.status === "error") li.append(el("div", "error", `Couldn't check: ${r.error}`));
    if (r.status === "skipped_cap") li.append(el("div", "muted", "Not checked: daily cap reached."));
    for (const item of r.items) li.append(renderItem(item, r.status));
    if (r.status === "queued" && !running) {
      const button = el("button", "secondary small", `Check now (about ${money(CHECK_NOW_USD_PER_SENTENCE)})`);
      button.addEventListener("click", () => checkNow([r.index]));
      li.append(button);
    }
    return li;
  }));
  list.hidden = results.length === 0;
}

function renderProgress(progress) {
  running = progress.status === "running";
  renderResults(progress.results);

  const spent = progress.spentTodayUsd != null ? ` Spent today: $${progress.spentTodayUsd.toFixed(2)}.` : "";
  const queued = progress.results.filter((r) => r.status === "queued");
  if (running) {
    setResult(`${progress.task}… ${progress.done} of ${progress.total} sentences.${spent}`);
  } else if (progress.status === "done") {
    const waiting = queued.length ? ` ${queued.length} claims queued for research.` : "";
    setResult(`Done.${waiting}${spent}`, "ok");
  } else if (progress.status === "cap_reached") {
    setResult(`Stopped: daily spending cap reached.${spent}`, "error");
  } else {
    setResult(`Stopped: ${progress.error}`, "error");
  }

  lookupButton.disabled = running;
  checkAllButton.hidden = running || queued.length === 0;
  checkAllButton.textContent = `Check all ${queued.length} queued now (about ${money(queued.length * CHECK_NOW_USD_PER_SENTENCE)})`;
  checkAllButton.onclick = () => checkNow(queued.map((r) => r.index));
}

// Connection check, and today's spending so far.
const reply = await chrome.runtime.sendMessage({ type: "api", action: "spend" });
if (reply.ok) {
  const { dailyCapUsd } = await chrome.storage.local.get({ dailyCapUsd: 5 });
  status.textContent = `Connected. Spent today: $${reply.data.spent_today_usd.toFixed(2)} of $${dailyCapUsd.toFixed(2)}.`;
  status.className = "ok";
  lookupButton.disabled = false;
} else {
  status.textContent = reply.error;
  status.className = "error";
}

// Show work already running or finished for this tab.
const stored = await chrome.storage.session.get(progressKey);
if (stored[progressKey] && stored[progressKey].url === tab.url) renderProgress(stored[progressKey]);

chrome.storage.session.onChanged.addListener((changes) => {
  if (changes[progressKey]?.newValue) renderProgress(changes[progressKey].newValue);
});

// Reads the page, then looks every sentence up: memory, library, then a cheap first pass.
// New claims are queued for research rather than checked right away.
lookupButton.addEventListener("click", async () => {
  lookupButton.disabled = true;
  checkAllButton.hidden = true;
  setResult("Reading the page…");
  list.hidden = true;

  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content/extract.js"],
    });
    const page = injection.result;
    if (page.sentences.length === 0) {
      setResult("No sentences found on this page.");
      lookupButton.disabled = false;
      return;
    }
    await chrome.runtime.sendMessage({ type: "lookupPage", tabId: tab.id, page });
  } catch (err) {
    setResult(`Couldn't read this page: ${err.message}`, "error");
    lookupButton.disabled = false;
  }
});
