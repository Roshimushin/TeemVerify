// Rough cost of checking one new sentence, from the first test runs (Oct 28, 2026).
// Sentences already in the store cost far less.
const ESTIMATED_USD_PER_SENTENCE = 0.06;

const LABELS = {
  1: "Tier 1 · verified",
  2: "Tier 2 · conclusion",
  3: "Tier 3 · unverified",
  4: "Tier 4 · refuted",
  value: "Value",
  opinion: "Opinion",
  forecast: "Forecast ⏱",
  not_a_claim: "Not a claim",
};

const status = document.getElementById("status");
const readButton = document.getElementById("read");
const checkButton = document.getElementById("check");
const result = document.getElementById("result");
const list = document.getElementById("list");

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const progressKey = `check:${tab.id}`;
const pageKey = `page:${tab.id}`;

function money(usd) {
  return `$${usd.toFixed(2)}`;
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

function renderPreview(page) {
  list.replaceChildren(...page.sentences.map((s) => el("li", "", s.text)));
  list.hidden = page.sentences.length === 0;
}

function renderResults(results) {
  list.replaceChildren(...results.map((r) => {
    const li = el("li");
    li.append(el("div", "sentence", r.sentence));
    if (r.status === "error") li.append(el("div", "error", `Couldn't check: ${r.error}`));
    if (r.status === "skipped_cap") li.append(el("div", "muted", "Not checked: daily cap reached."));
    for (const item of r.items) {
      const line = el("div", "item");
      const label = item.kind === "claim" ? LABELS[item.tier] : LABELS[item.kind];
      line.append(el("span", "badge", label));
      const detail = item.kind === "not_a_claim" ? "" : item.reason;
      const suffix = r.status === "from_store" ? " (from your library)" : "";
      line.append(el("span", "reason", detail + suffix));
      li.append(line);
    }
    return li;
  }));
  list.hidden = results.length === 0;
}

function renderProgress(progress) {
  renderResults(progress.results);
  const spent = progress.spentTodayUsd != null ? ` Spent today: ${money(progress.spentTodayUsd)}.` : "";
  if (progress.status === "running") {
    setResult(`Checking… ${progress.done} of ${progress.total} sentences.${spent}`);
  } else if (progress.status === "done") {
    setResult(`Checked ${progress.total} sentences.${spent}`, "ok");
  } else if (progress.status === "cap_reached") {
    setResult(`Stopped: daily spending cap reached.${spent}`, "error");
  } else {
    setResult(`Stopped: ${progress.error}`, "error");
  }
  const running = progress.status === "running";
  readButton.disabled = running;
  checkButton.hidden = true;
}

// Connection check, and today's spending so far.
const reply = await chrome.runtime.sendMessage({ type: "api", action: "spend" });
if (reply.ok) {
  const { dailyCapUsd } = await chrome.storage.local.get({ dailyCapUsd: 5 });
  status.textContent = `Connected. Spent today: ${money(reply.data.spent_today_usd)} of ${money(dailyCapUsd)}.`;
  status.className = "ok";
  readButton.disabled = false;
} else {
  status.textContent = reply.error;
  status.className = "error";
}

// Show a check already running or finished for this tab.
const stored = await chrome.storage.session.get(progressKey);
if (stored[progressKey] && stored[progressKey].url === tab.url) renderProgress(stored[progressKey]);

chrome.storage.session.onChanged.addListener((changes) => {
  if (changes[progressKey]?.newValue) renderProgress(changes[progressKey].newValue);
});

readButton.addEventListener("click", async () => {
  readButton.disabled = true;
  checkButton.hidden = true;
  setResult("Reading the page…");
  list.hidden = true;

  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content/extract.js"],
    });
    const page = injection.result;
    await chrome.storage.session.set({ [pageKey]: page });

    const count = page.sentences.length;
    setResult(`Found ${count} sentences in ${page.passageCount} passages.`);
    renderPreview(page);
    if (count > 0) {
      checkButton.textContent = `Check ${count} sentences (about ${money(count * ESTIMATED_USD_PER_SENTENCE)})`;
      checkButton.hidden = false;
    }
  } catch (err) {
    setResult(`Couldn't read this page: ${err.message}`, "error");
  } finally {
    readButton.disabled = false;
  }
});

checkButton.addEventListener("click", async () => {
  const { [pageKey]: page } = await chrome.storage.session.get(pageKey);
  if (!page) return;
  checkButton.hidden = true;
  await chrome.runtime.sendMessage({ type: "checkPage", tabId: tab.id, page });
});
