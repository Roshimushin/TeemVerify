// Draws Verify's labels on the page: marks on claims, chips on non-facts, a badge on post
// images whose text was read, a legend chip in the corner, and a card when a mark is tapped.
// Injected by the background worker once per page; it then sends { type: "tv-render" }
// messages with the latest results. All styling is in verify.css.
//
// Marks use the CSS Custom Highlight API, so the page's own text and layout are never
// rewritten. Only the small chips are inserted into the page.

(() => {
  if (window.__teemverify) return;

  // ---------- words shown to the reader ----------

  const TIERS = {
    1: { name: "Tier 1 · Verified", meaning: "Established beyond reasonable doubt by the evidence below." },
    2: { name: "Tier 2 · Good-faith conclusion", meaning: "A reasonable conclusion built on verified facts. The evidence may be mixed." },
    3: { name: "Tier 3 · Unverified", meaning: "Not established either way. Unverified isn't the same as false." },
    4: { name: "Tier 4 · Refuted", meaning: "There is affirmative evidence that this is false." },
  };
  const NON_FACTS = {
    value: { name: "Value", meaning: "This is a values question. Facts can inform it, but they can't settle it." },
    opinion: { name: "Opinion", meaning: "A matter of taste or judgment. Opinions aren't graded true or false." },
    forecast: { name: "Forecast ⏱", meaning: "A prediction. It can only be checked once its date arrives." },
  };
  const UNCHECKED = {
    name: "Not checked yet",
    meaning: "This is a checkable claim, but it hasn't been researched yet. It's in the research queue.",
  };
  const SOURCE_TYPES = {
    primary: "Primary source",
    secondary: "Secondary source",
    fact_checker: "Fact-checker (a Tier 2 conclusion)",
    encyclopedia: "Encyclopedia",
  };
  const ACTORS = { model: "AI review", claude_code: "AI review (research queue)", becket: "Becket" };
  const CHECK_NOW_LABEL = "Check now (about 2¢)";
  const RECHECK_LABEL = "Re-check (about 5¢)";
  const RESEARCH_LATER_LABEL = "Research this (free, later)";
  // Why a label is challenged, in the words the card shows (values match the challenges table).
  const REASON_TYPES = [
    ["new_evidence", "I have new evidence"],
    ["wording_or_scope", "The wording or scope is off"],
    ["reasoning", "The reasoning doesn't hold"],
    ["outdated", "It's out of date"],
  ];

  const HINTS = {
    tier1: "Tier 1, click for sources",
    tier2: "Tier 2, click for the evidence",
    tier3: "Tier 3, click for details",
    tier4: "Tier 4, click for sources",
    unchecked: "Not checked yet, click to check",
  };

  // Which highlight each category uses, and which show in the default view.
  // HIGHLIGHTS is also the order of importance: refuted first, then verified.
  const DEFAULT_VIEW = new Set(["tier1", "tier4"]);
  const HIGHLIGHTS = ["tier4", "tier1", "tier2", "tier3", "unchecked"];
  const FLASH_MS = 1400;

  // ---------- state ----------

  const state = {
    results: [],
    status: "idle",
    xray: false,
    marks: [], // { range, category, result, item }
    chips: [], // { element, result, item }
    ranges: new Map(), // item → the range of its words, for the flash when its card opens
    images: [], // { element, badge, results }
    darkAreas: [], // elements tagged .tv-on-dark
  };
  window.__teemverify = state;
  const xrayKey = `xray:${location.hostname}`;

  // ---------- the shadow root for the legend, badges and card ----------

  const host = document.createElement("div");
  host.id = "teemverify-root";
  const shadow = host.attachShadow({ mode: "open" });
  const stylesheet = document.createElement("link");
  stylesheet.rel = "stylesheet";
  stylesheet.href = chrome.runtime.getURL("content/verify.css");
  const layer = el("div", "tv-layer");
  shadow.append(stylesheet, layer);
  document.documentElement.append(host);

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // ---------- finding sentences in the page ----------

  // Quotes and spaces vary between how text is read and how it sits in the page,
  // so both sides are normalized the same way, one character for one character.
  function normalizeChar(ch) {
    if (/\s/.test(ch)) return " ";
    if (ch === "‘" || ch === "’") return "'";
    if (ch === "“" || ch === "”") return '"';
    return ch;
  }

  function normalize(text) {
    return [...text].map(normalizeChar).join("").replace(/ +/g, " ").trim();
  }

  const BLOCKS = "p, div, li, h1, h2, h3, h4, h5, h6, td, th, dd, dt, blockquote, figcaption, pre, " +
    "section, article, header, footer, main, aside, nav";

  // One string of all visible page text, with a map back to the text node and offset
  // of every character, so a sentence found in the string can become a Range.
  function buildIndex() {
    const skip = "script, style, noscript, textarea, [contenteditable='true'], .tv-chip, #teemverify-root";
    let lastBlock = null;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || parent.closest(skip)) return NodeFilter.FILTER_REJECT;
        return node.data.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      },
    });
    let text = "";
    const map = [];
    let lastWasSpace = true;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      // Text in a different block (paragraph, list item, comment) is a separate word,
      // but text split by a link or bold inside one block is not ("a <a>link</a>.").
      const block = node.parentElement.closest(BLOCKS);
      if (block !== lastBlock && !lastWasSpace) {
        text += " ";
        map.push([node, 0]);
        lastWasSpace = true;
      }
      lastBlock = block;
      for (let i = 0; i < node.data.length; i++) {
        const ch = normalizeChar(node.data[i]);
        if (ch === " ") {
          if (lastWasSpace) continue;
          lastWasSpace = true;
        } else {
          lastWasSpace = false;
        }
        text += ch;
        map.push([node, i]);
      }
    }
    return { text, map };
  }

  // Where a sentence starts in the index, and its length there.
  function findSentence(index, sentence, used) {
    const target = normalize(sentence);
    if (!target) return null;
    let at = index.text.indexOf(target);
    // The same sentence can appear twice; take the next unused copy.
    while (at !== -1 && used.has(at)) at = index.text.indexOf(target, at + 1);
    if (at === -1) return null;
    used.add(at);
    return { at, length: target.length };
  }

  // Where a part's quoted words sit inside its sentence; null when they can't be found.
  function findQuote(index, spot, quote) {
    const target = normalize(quote).toLowerCase();
    if (!target) return null;
    const offset = index.text.slice(spot.at, spot.at + spot.length).toLowerCase().indexOf(target);
    return offset === -1 ? null : { at: spot.at + offset, length: target.length };
  }

  function rangeAt(index, { at, length }) {
    const [startNode, startOffset] = index.map[at];
    const [endNode, endOffset] = index.map[at + length - 1];
    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, Math.min(endOffset + 1, endNode.data.length));
    return range;
  }

  // ---------- what a result looks like on the page ----------

  function categoryOfItem(item) {
    return item.tier ? `tier${item.tier}` : "unchecked";
  }

  // The most important claim among items: refuted first, then verified.
  function leadClaim(items) {
    const claims = items.filter((i) => i.kind === "claim");
    const rank = (i) => HIGHLIGHTS.indexOf(categoryOfItem(i));
    return claims.sort((a, b) => rank(a) - rank(b))[0] ?? null;
  }

  function categoryOf(result) {
    const lead = leadClaim(result.items);
    return lead && categoryOfItem(lead);
  }

  // ---------- drawing ----------

  function clear() {
    for (const name of HIGHLIGHTS) {
      CSS.highlights.delete(`tv-${name}`);
      CSS.highlights.delete(`tv-hover-${name}`);
    }
    CSS.highlights.delete("tv-flash");
    for (const chip of state.chips) chip.element.remove();
    for (const image of state.images) image.badge.remove();
    for (const element of state.darkAreas) element.classList.remove("tv-on-dark");
    state.darkAreas = [];
    state.marks = [];
    state.chips = [];
    state.images = [];
    state.ranges = new Map();
    hovered = null;
    hint.hidden = true;
  }

  function render() {
    clear();
    const index = buildIndex();
    const used = new Set();
    const byImage = new Map();
    const placed = [];

    // Find every sentence and part first: inserting chips changes the page's text nodes,
    // which would leave the index pointing at the wrong places.
    for (const result of state.results) {
      if (result.image) {
        if (!byImage.has(result.image)) byImage.set(result.image, []);
        byImage.get(result.image).push(result);
        continue;
      }
      const items = result.items.filter((i) => i.kind !== "not_a_claim");
      if (!items.length) continue;
      // Text Becket added may overlap a sentence already marked, so it may reuse that spot.
      const spot = findSentence(index, result.sentence, result.added ? new Set() : used);
      if (!spot) continue;
      const sentenceRange = rangeAt(index, spot);

      // Each claim is underlined on just its own words. Claims without words of their own
      // (labelled before parts had quotes) share one mark across the sentence, styled by
      // the most important of them.
      const shared = [];
      for (const item of items) {
        const words = item.quote && findQuote(index, spot, item.quote);
        const range = words ? rangeAt(index, words) : sentenceRange;
        state.ranges.set(item, range);
        if (item.kind !== "claim") continue;
        if (words) state.marks.push({ range, category: categoryOfItem(item), result, item });
        else shared.push(item);
      }
      const lead = leadClaim(shared);
      if (lead) state.marks.push({ range: sentenceRange, category: categoryOfItem(lead), result, item: lead });

      const nonFacts = items.filter((i) => NON_FACTS[i.kind]);
      if (nonFacts.length) placed.push({ range: sentenceRange, nonFacts, result });
    }

    // Chips go at the end of the sentence, one per non-fact part, in sentence order.
    // Ranges are live, so the marks found above stay correct as chips are inserted.
    for (const { range, nonFacts, result } of placed) {
      const end = range.cloneRange();
      end.collapse(false);
      for (const item of [...nonFacts].reverse()) {
        const chip = el("span", "tv-chip", NON_FACTS[item.kind].name);
        chip.dataset.tvChip = "true";
        chip.title = item.text;
        end.insertNode(chip);
        state.chips.push({ element: chip, result, item });
      }
    }

    for (const [url, results] of byImage) placeImageBadge(url, results);
    markDarkAreas();
    applyHighlights();
    renderLegend();
  }

  // Marks need brighter colors on dark backgrounds. Light-colored text means a dark
  // background (often a comment box, not the page body), so each marked sentence's
  // surrounding element is tagged, and verify.css swaps the color tokens inside it.
  function markDarkAreas() {
    const ranges = [...state.marks.map((m) => m.range), ...state.chips.map((c) => c.element)];
    for (const target of ranges) {
      const element = target instanceof Range
        ? target.commonAncestorContainer.parentElement ?? target.commonAncestorContainer
        : target.parentElement;
      if (!element || element.classList.contains("tv-on-dark")) continue;
      const [r, g, b] = (getComputedStyle(element).color.match(/\d+(\.\d+)?/g) ?? []).map(Number);
      if ((0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6) {
        element.classList.add("tv-on-dark");
        state.darkAreas.push(element);
      }
    }
  }

  function applyHighlights() {
    for (const name of HIGHLIGHTS) {
      const ranges = state.marks
        .filter((m) => m.category === name && (state.xray || DEFAULT_VIEW.has(name)))
        .map((m) => m.range);
      if (ranges.length) CSS.highlights.set(`tv-${name}`, new Highlight(...ranges));
      else CSS.highlights.delete(`tv-${name}`);
    }
    document.documentElement.classList.toggle("tv-xray", state.xray);
  }

  // ---------- post images ----------

  function sameImage(a, b) {
    const strip = (u) => u.replace(/[?#].*$/, "").replace(/^https?:/, "");
    return strip(a) === strip(b);
  }

  function findImage(url) {
    const images = [...document.images].filter((img) => img.getBoundingClientRect().width > 120);
    const match = images.find((img) => sameImage(img.currentSrc || img.src, url));
    if (match) return match;
    // The share image often isn't the displayed file; fall back to the largest image.
    return images.sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return rb.width * rb.height - ra.width * ra.height;
    })[0] ?? null;
  }

  function placeImageBadge(url, results) {
    const image = findImage(url);
    if (!image) return;
    const categories = results.map(categoryOf);
    const worst = categories.includes("tier4") ? "t4"
      : categories.includes("tier1") ? "t1"
      : categories.includes("tier2") ? "t2"
      : categories.some((c) => c === "tier3" || c === "unchecked") ? "t3" : "nonfact";
    const count = results.reduce((n, r) => n + r.items.filter((i) => i.kind !== "not_a_claim").length, 0);
    if (!count) return;
    const badge = el("button", "tv-image-badge");
    badge.append(el("span", `tv-dot ${worst}`), document.createTextNode(`Text in image: ${count} labelled`));
    badge.addEventListener("click", (event) => {
      event.stopPropagation();
      openCard(results, badge.getBoundingClientRect(), "In the image");
    });
    layer.append(badge);
    state.images.push({ element: image, badge, results });
    positionBadges();
  }

  function positionBadges() {
    for (const { element, badge } of state.images) {
      const rect = element.getBoundingClientRect();
      const visible = rect.bottom > 0 && rect.top < innerHeight;
      badge.style.display = visible ? "flex" : "none";
      badge.style.left = `${Math.max(8, rect.left + 8)}px`;
      badge.style.top = `${Math.max(8, rect.top + 8)}px`;
    }
  }

  addEventListener("scroll", () => {
    // The card would drift away from its sentence, so scrolling the page closes it.
    // A card with a form being filled in stays put, so nothing typed is lost.
    if (!card?.querySelector(".tv-form")) closeCard();
    hidePicker();
    setHovered(null);
    requestAnimationFrame(positionBadges);
  }, { passive: true, capture: true });
  addEventListener("resize", () => requestAnimationFrame(positionBadges));

  // ---------- legend chip ----------

  const legend = el("div", "tv-legend");
  layer.append(legend);
  let legendOpen = false;

  function counts() {
    const n = (c) => state.marks.filter((m) => m.category === c).length;
    const parts = [];
    if (n("tier1")) parts.push(`${n("tier1")} verified`);
    if (n("tier4")) parts.push(`${n("tier4")} refuted`);
    if (state.xray) {
      if (n("tier2")) parts.push(`${n("tier2")} ${n("tier2") === 1 ? "conclusion" : "conclusions"}`);
      if (n("tier3")) parts.push(`${n("tier3")} unverified`);
      if (n("unchecked")) parts.push(`${n("unchecked")} not checked`);
    }
    return parts.join(" · ") || "Nothing marked";
  }

  function renderLegend() {
    legend.replaceChildren();
    if (legendOpen) legend.append(legendPanel());

    const pill = el("div", "tv-pill");
    const label = el("button", "tv-pill-label");
    label.setAttribute("aria-expanded", String(legendOpen));
    label.title = "What do the marks mean?";
    label.append(
      state.status === "running" ? el("span", "tv-spinner") : el("span", "tv-dot"),
      el("span", "", "Verify"),
      el("span", "tv-counts", state.status === "running" ? "Checking…" : counts()),
    );
    label.addEventListener("click", () => {
      legendOpen = !legendOpen;
      renderLegend();
    });

    const toggle = el("button", "tv-toggle", "X-ray");
    toggle.setAttribute("aria-pressed", String(state.xray));
    toggle.title = state.xray ? "Show only verified and refuted" : "Show every label";
    toggle.addEventListener("click", () => setXray(!state.xray));

    pill.append(label, toggle);
    legend.append(pill);
  }

  function legendPanel() {
    const panel = el("div", "tv-legend-panel");
    panel.append(el("h2", "", "What the marks mean"));
    const rows = [
      ["t1", "Text", "Tier 1 · verified"],
      ["t4", "Text", "Tier 4 · refuted"],
      ["t2", "Text", "Tier 2 · good-faith conclusion (X-ray)"],
      ["t3", "Text", "Tier 3 · unverified (X-ray)"],
      ["unchecked", "Text", "Not checked yet (X-ray)"],
    ];
    for (const [cls, sample, meaning] of rows) {
      const row = el("div", "tv-legend-row");
      row.append(el("span", `tv-swatch ${cls}`, sample), el("span", "", meaning));
      panel.append(row);
    }
    const chipRow = el("div", "tv-legend-row");
    chipRow.append(el("span", "tv-swatch", "Chips"), el("span", "", "Value · Opinion · Forecast ⏱ (X-ray). Not graded."));
    panel.append(chipRow);
    panel.append(el("p", "tv-legend-note",
      "Underlines are facts; chips are non-facts. Every label is an AI draft until reviewed. Tap a mark for the evidence."));
    return panel;
  }

  async function setXray(on) {
    state.xray = on;
    try {
      await chrome.storage.local.set({ [xrayKey]: on });
    } catch {
      // Remembering the choice is a convenience; the toggle still works without it.
    }
    applyHighlights();
    renderLegend();
  }

  // ---------- the card ----------

  let card = null;
  // What the open card shows, so it can be redrawn with fresh results after feedback.
  let lastCard = null;
  // A line to show at the top of an item the next time its card is drawn ("Confirmed.").
  const notices = new Map();

  function closeCard() {
    card?.remove();
    card = null;
  }

  // Items are found again after a redraw by their library id, or by their words.
  function itemKey(item) {
    return item.block_id ?? `${item.kind}:${item.text}`;
  }

  function reopenCard() {
    if (!lastCard) return;
    const results = state.results.filter((r) => lastCard.indexes.includes(r.index));
    const focus = results.flatMap((r) => r.items).find((i) => itemKey(i) === lastCard.focus);
    openCard(results, lastCard.anchor, lastCard.quoteLabel, focus, { flash: false });
  }

  // Shows every labelled item of the given sentence results, so a sentence reads the same
  // whichever of its marks or chips was tapped. `anchor` is a DOMRect; `focusItem` (the
  // tapped part) goes first, and its words light up briefly in the page.
  function openCard(results, anchor, quoteLabel, focusItem, { flash: flashFocus = true } = {}) {
    closeCard();
    lastCard = { indexes: results.map((r) => r.index), anchor, quoteLabel, focus: focusItem && itemKey(focusItem) };
    card = el("div", "tv-card");
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-label", "Verify label");
    // Typing in the card's forms mustn't trigger the site's own keyboard shortcuts.
    for (const type of ["keydown", "keyup", "keypress"]) {
      card.addEventListener(type, (event) => {
        event.stopPropagation();
        if (type === "keydown" && event.key === "Escape") closeCard();
      });
    }

    const head = el("div", "tv-card-head");
    const close = el("button", "tv-close", "×");
    close.setAttribute("aria-label", "Close");
    close.addEventListener("click", closeCard);
    head.append(el("span", "tv-badge", quoteLabel ?? "Verify"), close);
    card.append(head);

    for (const result of results) {
      const items = result.items
        .filter((i) => i.kind !== "not_a_claim")
        .sort((a, b) => (b === focusItem) - (a === focusItem));
      if (!items.length) continue;
      if (quoteLabel || items.length > 1) card.append(el("p", "tv-quote", result.sentence));
      if (items.length > 1) {
        card.append(el("p", "tv-meaning", `This sentence has ${items.length} labelled parts:`));
      }
      for (const item of items) card.append(itemView(item, result));
    }

    layer.append(card);
    placeCard(anchor);
    if (focusItem && flashFocus) flash(focusItem);
  }

  let flashTimer = 0;

  function flash(item) {
    const range = state.ranges.get(item);
    if (!range) return;
    CSS.highlights.set("tv-flash", new Highlight(range));
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => CSS.highlights.delete("tv-flash"), FLASH_MS);
  }

  function placeCard(anchor) {
    const width = card.offsetWidth;
    const height = card.offsetHeight;
    let left = Math.min(Math.max(16, anchor.left), innerWidth - width - 16);
    let top = anchor.bottom + 8;
    if (top + height > innerHeight - 16) top = Math.max(16, anchor.top - height - 8);
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
  }

  function itemView(item, result) {
    const view = el("div", "tv-item");
    const head = el("div", "tv-card-head");

    const notice = notices.get(itemKey(item));
    notices.delete(itemKey(item));
    const noticeView = notice && el("p", notice.error ? "tv-notice error" : "tv-notice", notice.text);

    if (item.kind === "claim" && item.tier == null) {
      head.append(el("span", "tv-tier unchecked", UNCHECKED.name));
      view.append(head);
      if (noticeView) view.append(noticeView);
      view.append(el("p", "tv-claim", item.text), el("p", "tv-meaning", UNCHECKED.meaning));
      const button = el("button", "tv-action", CHECK_NOW_LABEL);
      button.addEventListener("click", () => {
        button.disabled = true;
        button.textContent = "Checking…";
        chrome.runtime.sendMessage({ type: "checkNow", indexes: [result.index] });
      });
      // Becket's picks go to the front of the research queue, worked for free by Claude Code.
      const later = el("button", "tv-action secondary", RESEARCH_LATER_LABEL);
      later.title = "Moves this claim to the front of the research queue";
      later.addEventListener("click", () => sendFeedback(item, later, view, "prioritize", { sentence: result.sentence },
        (data) => ({ text: `In the research queue, at the front (${data.picked_waiting} picked so far). Its label appears here once it's researched.` })));
      view.append(button, document.createTextNode(" "), later);
      return view;
    }

    if (item.kind !== "claim") {
      const info = NON_FACTS[item.kind];
      head.append(el("span", "tv-tier nonfact", info.name));
      view.append(head, el("p", "tv-claim", item.text), el("p", "tv-meaning", info.meaning));
      if (item.kind === "forecast") view.append(evidenceClock(item));
      if (item.kind === "value") {
        const section = el("div", "tv-section");
        section.append(el("h3", "", "Facts that bear on it"),
          el("p", "tv-meaning", "Linked verified facts will appear here in a later version."));
        view.append(section);
      }
      return view;
    }

    const tier = TIERS[item.tier];
    head.append(el("span", `tv-tier t${item.tier}`, tier.name), el("span", "tv-badge", "AI draft"));
    view.append(head);
    if (noticeView) view.append(noticeView);
    view.append(el("p", "tv-claim", item.text), el("p", "tv-meaning", tier.meaning));
    if (item.reason) view.append(el("p", "tv-reason", item.reason));
    if (item.scope || item.as_of) {
      const scope = [item.scope, item.as_of && `as of ${formatDate(item.as_of)}`].filter(Boolean).join(", ");
      view.append(el("p", "tv-meaning", `Scope: ${scope}`));
    }
    view.append(exhibitsView(item.exhibits ?? []));

    // Tier history and review status come from the library, loaded when the card opens.
    if (item.block_id) {
      view.append(feedbackView(item));
      const history = el("div", "tv-section");
      history.append(el("h3", "", "Tier history"), el("p", "tv-meaning", "Loading…"));
      view.append(history);
      loadDetail(item.block_id, history, view);
    }
    return view;
  }

  // ---------- feedback: Confirm, Challenge, Reword ----------

  function feedbackView(item) {
    const wrap = el("div");
    const row = el("div", "tv-feedback");
    const confirm = el("button", "tv-confirm", "Confirm");
    confirm.title = "The label is right: mark it reviewed";
    const challenge = el("button", "", "Challenge");
    challenge.title = "The label is wrong or incomplete: re-check it with your evidence";
    const reword = el("button", "", "Reword");
    reword.title = "Suggest more precise wording";
    row.append(confirm, challenge, reword);
    wrap.append(row);

    confirm.addEventListener("click", () => sendFeedback(item, confirm, wrap, "confirm", { block_id: item.block_id },
      () => ({ text: "Confirmed. Marked as reviewed, and logged in the tier history." })));
    challenge.addEventListener("click", () => showForm(wrap, challengeForm(item)));
    reword.addEventListener("click", () => showForm(wrap, rewordForm(item)));
    return wrap;
  }

  function showForm(wrap, form) {
    wrap.querySelector(".tv-form")?.remove();
    wrap.append(form);
    revealForm(form);
  }

  // Forms open below the card's fold, so they're scrolled into view and focused.
  function revealForm(form) {
    form.scrollIntoView({ block: "nearest" });
    form.querySelector("select, textarea, input")?.focus({ preventScroll: true });
  }

  function swapForm(oldForm, newForm) {
    oldForm.replaceWith(newForm);
    revealForm(newForm);
  }

  function field(form, label, control) {
    const id = `tv-field-${Math.random().toString(36).slice(2)}`;
    const text = el("label", "", label);
    text.htmlFor = id;
    control.id = id;
    form.append(text, control);
    return control;
  }

  function challengeForm(item, suggestedWording) {
    const form = el("div", "tv-form");
    const reason = field(form, "What's wrong with it?", el("select"));
    for (const [value, label] of REASON_TYPES) {
      const option = el("option", "", label);
      option.value = value;
      reason.append(option);
    }
    const note = field(form, "Your note", el("textarea"));
    note.placeholder = "What the label gets wrong, in a sentence or two";
    const link = field(form, "Link to evidence (optional)", el("input"));
    link.type = "url";
    link.placeholder = "https://…";
    if (suggestedWording) {
      reason.value = "wording_or_scope";
      note.value = `More precise wording: "${suggestedWording}"`;
    }

    const submit = el("button", "tv-action", RECHECK_LABEL);
    const cancel = el("button", "tv-action secondary", "Cancel");
    cancel.addEventListener("click", () => form.remove());
    submit.addEventListener("click", () => {
      if (!note.value.trim() && !link.value.trim()) {
        showError(form, "Add a note or a link, so the re-check knows what to look at.");
        return;
      }
      sendFeedback(item, submit, form, "challenge",
        { block_id: item.block_id, reason_type: reason.value, note: note.value, link: link.value },
        (data) => ({
          text: !data.rechecked ? data.response
            : `${data.outcome === "upheld" ? "Challenge upheld" : "Challenge not upheld"}: ${data.response}`,
        }),
        "Re-checking… this can take a minute");
    });
    form.append(el("p", "tv-meaning", "Claude re-checks the claim with your note and link, by the same rules. The label changes only if the evidence calls for it."),
      submit, cancel);
    return form;
  }

  function rewordForm(item) {
    const form = el("div", "tv-form");
    const text = field(form, "More precise wording", el("textarea"));
    text.value = item.text;
    const submit = el("button", "tv-action", "Save wording");
    const cancel = el("button", "tv-action secondary", "Cancel");
    cancel.addEventListener("click", () => form.remove());
    submit.addEventListener("click", () => {
      const wording = text.value.trim();
      if (!wording) return;
      sendFeedback(item, submit, form, "reword", { block_id: item.block_id, text: wording }, (data) => {
        if (data.saved) return { text: "Wording saved. The tier stays, since it says the same thing." };
        if (data.unchanged) return { text: "That's the wording it already has." };
        // New wording that says something else needs its own check before it can keep a tier.
        swapForm(form, challengeOffer(item, wording, data.relation));
        return null;
      }, "Comparing…");
    });
    form.append(el("p", "tv-meaning", "Same meaning, said more precisely. If the new wording changes what the claim says, it needs a re-check instead."),
      submit, cancel);
    return form;
  }

  function challengeOffer(item, wording, relation) {
    const form = el("div", "tv-form");
    form.append(el("p", "tv-notice",
      relation === "opposite"
        ? "That wording says the opposite of the checked claim, so its tier can't carry over."
        : "That wording says something different from the checked claim, so its tier might not fit."));
    const recheck = el("button", "tv-action", "Challenge with this wording");
    const cancel = el("button", "tv-action secondary", "Cancel");
    recheck.addEventListener("click", () => swapForm(form, challengeForm(item, wording)));
    cancel.addEventListener("click", () => form.remove());
    form.append(recheck, cancel);
    return form;
  }

  function showError(place, text) {
    place.querySelector(".tv-notice.error")?.remove();
    place.prepend(el("p", "tv-notice error", text));
  }

  // Sends one feedback action through the background worker. On success the card is redrawn
  // from the updated results with `describe(data)` shown on the item; null keeps the card as is.
  async function sendFeedback(item, button, place, action, payload, describe, busyText = "Saving…") {
    const label = button.textContent;
    button.disabled = true;
    button.textContent = busyText;
    let reply;
    try {
      reply = await chrome.runtime.sendMessage({ type: "feedback", action, payload });
    } catch (err) {
      reply = { ok: false, error: err.message };
    }
    if (!reply?.ok) {
      button.disabled = false;
      button.textContent = label;
      showError(place, reply?.error ?? "Something went wrong. Try again.");
      return;
    }
    const notice = describe(reply.data);
    if (!notice) return;
    notices.set(itemKey(item), notice);
    reopenCard();
  }

  function exhibitsView(exhibits) {
    const section = el("div", "tv-section");
    section.append(el("h3", "", "Exhibits"));
    if (!exhibits.length) {
      section.append(el("p", "tv-meaning", "No exhibits presented."));
      return section;
    }
    const list = el("ul");
    for (const exhibit of exhibits) {
      const li = el("li");
      const link = el("a", "", hostOf(exhibit.url));
      link.href = exhibit.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      li.append(link, el("div", "tv-source-type", [SOURCE_TYPES[exhibit.source_type], exhibit.location].filter(Boolean).join(" · ")));
      list.append(li);
    }
    section.append(list);
    return section;
  }

  // Evidence clock for forecasts: when it was claimed, when it resolves, and where it stands.
  function evidenceClock(item) {
    const section = el("div", "tv-section");
    section.append(el("h3", "", "Evidence clock"));
    const list = el("ul");
    const today = new Date().toLocaleDateString("en-CA"); // local date as YYYY-MM-DD
    list.append(el("li", "", `Seen: ${formatDate(today)}`));
    if (item.resolve_by) {
      const days = Math.round((new Date(item.resolve_by) - new Date(today)) / 86_400_000);
      list.append(el("li", "", `Resolves by: ${formatDate(item.resolve_by)}`));
      list.append(el("li", "", days > 0 ? `Status: waiting, ${days} days to go` : "Status: due. The outcome can be checked now."));
    } else {
      list.append(el("li", "", "Resolves by: no date given"));
    }
    section.append(list);
    return section;
  }

  async function loadDetail(blockId, section, view) {
    const reply = await chrome.runtime.sendMessage({ type: "api", action: "block_detail", payload: { block_id: blockId } });
    section.replaceChildren(el("h3", "", "Tier history"));
    if (!reply?.ok) {
      section.append(el("p", "tv-meaning", "Couldn't load the history."));
      return;
    }
    const { block, history, challenges = [], wording = [], sightings } = reply.data;
    if (block.status === "reviewed") {
      view.querySelector(".tv-card-head .tv-badge")?.replaceWith(el("span", "tv-badge", "Reviewed"));
      view.querySelector(".tv-confirm")?.remove();
    }
    const list = el("ul");
    // One timeline: tier changes, confirmations, challenges and rewordings, oldest first.
    const reasons = { new_evidence: "new evidence", wording_or_scope: "wording or scope", reasoning: "reasoning", outdated: "out of date" };
    const events = [
      ...history.map((h) => {
        const change = h.old_tier == null ? `Tier ${h.new_tier}`
          : h.old_tier === h.new_tier ? `Tier ${h.new_tier} confirmed`
          : `Tier ${h.old_tier} → Tier ${h.new_tier}`;
        return [h.created_at, `${change} · ${ACTORS[h.actor] ?? h.actor}`];
      }),
      ...challenges.map((c) => [c.created_at,
        `Challenged (${reasons[c.reason_type] ?? c.reason_type})` +
        (c.resolution ? `. ${c.resolution}` : " · waiting for a re-check")]),
      ...wording.map((w) => [w.created_at, `Reworded by ${ACTORS[w.actor] ?? w.actor} · was "${w.old_text}"`]),
    ].sort(([a], [b]) => new Date(a) - new Date(b));
    const rows = events.map(([at, text]) => `${formatDate(at)} · ${text}`);
    // Skimmable first: the latest three, with the rest a tap away.
    const shown = rows.slice(-3);
    for (const row of shown) list.append(el("li", "", row));
    section.append(list);
    if (rows.length > shown.length) {
      const more = el("button", "tv-more", `Show all ${rows.length}`);
      more.addEventListener("click", () => {
        list.replaceChildren(...rows.map((row) => el("li", "", row)));
        more.remove();
      });
      section.append(more);
    }
    if (sightings > 1) section.append(el("p", "tv-meaning", `Seen on ${sightings} pages.`));
  }

  function formatDate(value) {
    return new Date(value.length === 10 ? `${value}T12:00:00` : value)
      .toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  function hostOf(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return url;
    }
  }

  // ---------- tapping marks ----------

  function caretAt(x, y) {
    if (document.caretPositionFromPoint) {
      const pos = document.caretPositionFromPoint(x, y);
      return pos && { node: pos.offsetNode, offset: pos.offset };
    }
    const range = document.caretRangeFromPoint?.(x, y);
    return range && { node: range.startContainer, offset: range.startOffset };
  }

  // The mark under the pointer. Where parts overlap, the one with the fewest words wins,
  // since it's the most specific.
  function markAt(x, y) {
    const caret = caretAt(x, y);
    if (!caret) return null;
    const hits = state.marks.filter((m) => {
      if (!state.xray && !DEFAULT_VIEW.has(m.category)) return false;
      try {
        if (!m.range.isPointInRange(caret.node, caret.offset)) return false;
        // The caret lands beside the nearest character, so also check the click is on the text.
        return [...m.range.getClientRects()].some((r) =>
          x >= r.left && x <= r.right && y >= r.top && y <= r.bottom);
      } catch {
        return false;
      }
    });
    const size = (m) => m.range.toString().length;
    return hits.sort((a, b) => size(a) - size(b))[0] ?? null;
  }

  document.addEventListener("click", (event) => {
    if (event.composedPath().includes(host)) return;
    // The click that ends a text selection is for "Add claim", not for opening a mark.
    if (!getSelection()?.isCollapsed) return;
    const chip = event.target.closest?.("[data-tv-chip]");
    if (chip) {
      event.preventDefault();
      event.stopPropagation();
      const found = state.chips.find((c) => c.element === chip);
      if (found) openCard([found.result], chip.getBoundingClientRect(), undefined, found.item);
      return;
    }
    // Links keep working: marks inside a link open only with Alt held.
    if (event.target.closest?.("a") && !event.altKey) {
      closeCard();
      return;
    }
    const mark = markAt(event.clientX, event.clientY);
    if (!mark) {
      closeCard();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    setHovered(null);
    openCard([mark.result], mark.range.getBoundingClientRect(), undefined, mark.item);
  }, true);

  // ---------- hovering marks (desktop) ----------

  // The hovered mark thickens and a short hint follows the pointer.
  const hint = el("div", "tv-hint");
  hint.hidden = true;
  layer.append(hint);
  let hovered = null;

  function setHovered(mark, x, y) {
    if (mark !== hovered) {
      if (hovered) CSS.highlights.delete(`tv-hover-${hovered.category}`);
      if (mark) {
        const highlight = new Highlight(mark.range);
        highlight.priority = 1;
        CSS.highlights.set(`tv-hover-${mark.category}`, highlight);
        hint.textContent = HINTS[mark.category];
      }
      hovered = mark;
      hint.hidden = !mark;
      document.documentElement.classList.toggle("tv-pointer", Boolean(mark));
    }
    if (mark) {
      hint.style.left = `${Math.min(x + 12, innerWidth - hint.offsetWidth - 8)}px`;
      hint.style.top = `${y + 18}px`;
    }
  }

  let pendingMove = false;
  document.addEventListener("mousemove", (event) => {
    if (pendingMove || !state.marks.length) return;
    pendingMove = true;
    requestAnimationFrame(() => {
      pendingMove = false;
      setHovered(card ? null : markAt(event.clientX, event.clientY), event.clientX, event.clientY);
    });
  }, { passive: true });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeCard();
      hidePicker();
    }
  });

  // ---------- Add claim: select any text and send it for checking ----------

  const MIN_PICK_WORDS = 3;
  const MAX_PICK_CHARS = 600;
  const picker = el("div", "tv-select");
  picker.hidden = true;
  layer.append(picker);
  let picked = "";

  function hidePicker() {
    picker.hidden = true;
    picked = "";
  }

  function showPickerFor(text, rect) {
    picked = text;
    picker.replaceChildren();
    const now = el("button", "tv-select-main", "Check now · 2¢");
    now.title = "Research this text right away";
    const later = el("button", "", "Research later");
    later.title = "Free: puts it at the front of the research queue";
    now.addEventListener("click", () => addClaim("now"));
    later.addEventListener("click", () => addClaim("later"));
    picker.append(now, later);
    picker.hidden = false;
    const width = picker.offsetWidth;
    picker.style.left = `${Math.min(Math.max(8, rect.left), innerWidth - width - 8)}px`;
    picker.style.top = `${rect.bottom + 8 + picker.offsetHeight > innerHeight ? rect.top - picker.offsetHeight - 8 : rect.bottom + 8}px`;
  }

  async function addClaim(mode) {
    const text = picked;
    picker.replaceChildren(el("span", "", mode === "now" ? "Checking…" : "Adding…"));
    const reply = await chrome.runtime.sendMessage({ type: "addClaim", text, mode }).catch((err) => ({ ok: false, error: err.message }));
    picker.replaceChildren(el("span", "", reply?.ok
      ? (mode === "now" ? "Added. Its label appears when the check is done." : "Added to the front of the research queue.")
      : reply?.error ?? "Couldn't add it."));
    setTimeout(hidePicker, 2500);
  }

  document.addEventListener("mouseup", (event) => {
    if (event.composedPath().includes(host)) return;
    // The selection settles after mouseup.
    setTimeout(() => {
      const selection = getSelection();
      const text = selection?.toString().replace(/\s+/g, " ").trim() ?? "";
      const inField = selection?.anchorNode?.parentElement?.closest("input, textarea, [contenteditable='true']");
      if (!selection || selection.isCollapsed || inField || text.length > MAX_PICK_CHARS ||
        text.split(" ").length < MIN_PICK_WORDS) {
        hidePicker();
        return;
      }
      closeCard();
      showPickerFor(text, selection.getRangeAt(0).getBoundingClientRect());
    }, 0);
  });

  // ---------- messages from the background worker ----------

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "tv-ping") {
      sendResponse(true);
      return false;
    }
    if (message?.type === "tv-render") {
      state.results = message.results;
      state.status = message.status;
      render();
      sendResponse(true);
    }
    return false;
  });

  chrome.storage.local.get(xrayKey).then((stored) => {
    state.xray = Boolean(stored[xrayKey]);
    applyHighlights();
    renderLegend();
  }).catch(() => renderLegend());
})();
