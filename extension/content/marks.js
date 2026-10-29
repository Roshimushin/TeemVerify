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

  // Which highlight each category uses, and which show in the default view.
  const DEFAULT_VIEW = new Set(["tier1", "tier4"]);
  const HIGHLIGHTS = ["tier1", "tier2", "tier3", "tier4", "unchecked"];

  // ---------- state ----------

  const state = {
    results: [],
    status: "idle",
    xray: false,
    marks: [], // { range, category, result }
    chips: [], // { element, result, item }
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

  function findRange(index, sentence, used) {
    const target = normalize(sentence);
    if (!target) return null;
    let at = index.text.indexOf(target);
    // The same sentence can appear twice; take the next unused copy.
    while (at !== -1 && used.has(at)) at = index.text.indexOf(target, at + 1);
    if (at === -1) return null;
    used.add(at);
    const [startNode, startOffset] = index.map[at];
    const [endNode, endOffset] = index.map[at + target.length - 1];
    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, Math.min(endOffset + 1, endNode.data.length));
    return range;
  }

  // ---------- what a result looks like on the page ----------

  // A sentence's mark follows its most important claim: refuted first, then verified.
  function categoryOf(result) {
    const claims = result.items.filter((i) => i.kind === "claim");
    const tiers = claims.map((i) => i.tier);
    if (tiers.includes(4)) return "tier4";
    if (tiers.includes(1)) return "tier1";
    if (tiers.includes(2)) return "tier2";
    if (tiers.includes(3)) return "tier3";
    if (claims.length) return "unchecked";
    return null;
  }

  function nonFactKinds(result) {
    return [...new Set(result.items.map((i) => i.kind).filter((k) => NON_FACTS[k]))];
  }

  // ---------- drawing ----------

  function clear() {
    for (const name of HIGHLIGHTS) CSS.highlights.delete(`tv-${name}`);
    for (const chip of state.chips) chip.element.remove();
    for (const image of state.images) image.badge.remove();
    for (const element of state.darkAreas) element.classList.remove("tv-on-dark");
    state.darkAreas = [];
    state.marks = [];
    state.chips = [];
    state.images = [];
  }

  function render() {
    clear();
    const index = buildIndex();
    const used = new Set();
    const byImage = new Map();
    const placed = [];

    // Find every sentence first: inserting chips changes the page's text nodes, which
    // would leave the index pointing at the wrong places.
    for (const result of state.results) {
      if (result.image) {
        if (!byImage.has(result.image)) byImage.set(result.image, []);
        byImage.get(result.image).push(result);
        continue;
      }
      const category = categoryOf(result);
      const kinds = nonFactKinds(result);
      if (!category && !kinds.length) continue;
      const range = findRange(index, result.sentence, used);
      if (!range) continue;
      if (category) state.marks.push({ range, category, result });
      if (kinds.length) placed.push({ range, kinds, result });
    }

    // Chips go at the end of the sentence, one per kind of non-fact. Ranges are live,
    // so the marks found above stay correct as chips are inserted.
    for (const { range, kinds, result } of placed) {
      const end = range.cloneRange();
      end.collapse(false);
      for (const kind of kinds.reverse()) {
        const chip = el("span", "tv-chip", NON_FACTS[kind].name);
        chip.dataset.tvChip = "true";
        end.insertNode(chip);
        const item = result.items.find((i) => i.kind === kind);
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
    closeCard();
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

  function closeCard() {
    card?.remove();
    card = null;
  }

  // Shows every labelled item of the given sentence results, so a sentence reads the same
  // whichever of its marks or chips was tapped. `anchor` is a DOMRect; `focusKind` puts the
  // tapped kind first (e.g. "opinion" when its chip was tapped).
  function openCard(results, anchor, quoteLabel, focusKind) {
    closeCard();
    card = el("div", "tv-card");
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-label", "Verify label");

    const head = el("div", "tv-card-head");
    const close = el("button", "tv-close", "×");
    close.setAttribute("aria-label", "Close");
    close.addEventListener("click", closeCard);
    head.append(el("span", "tv-badge", quoteLabel ?? "Verify"), close);
    card.append(head);

    for (const result of results) {
      const items = result.items
        .filter((i) => i.kind !== "not_a_claim")
        .sort((a, b) => (b.kind === focusKind) - (a.kind === focusKind));
      if (!items.length) continue;
      if (quoteLabel || items.length > 1) card.append(el("p", "tv-quote", result.sentence));
      if (items.length > 1) {
        card.append(el("p", "tv-meaning", `This sentence has ${items.length} labelled parts:`));
      }
      for (const item of items) card.append(itemView(item, result));
    }

    layer.append(card);
    placeCard(anchor);
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

    if (item.kind === "claim" && item.tier == null) {
      head.append(el("span", "tv-tier unchecked", UNCHECKED.name));
      view.append(head, el("p", "tv-claim", item.text), el("p", "tv-meaning", UNCHECKED.meaning));
      const button = el("button", "tv-action", CHECK_NOW_LABEL);
      button.addEventListener("click", () => {
        button.disabled = true;
        button.textContent = "Checking…";
        chrome.runtime.sendMessage({ type: "checkNow", indexes: [result.index] });
      });
      view.append(button);
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
    view.append(head, el("p", "tv-claim", item.text), el("p", "tv-meaning", tier.meaning));
    if (item.reason) view.append(el("p", "tv-reason", item.reason));
    if (item.scope || item.as_of) {
      const scope = [item.scope, item.as_of && `as of ${formatDate(item.as_of)}`].filter(Boolean).join(", ");
      view.append(el("p", "tv-meaning", `Scope: ${scope}`));
    }
    view.append(exhibitsView(item.exhibits ?? []));

    // Tier history and review status come from the library, loaded when the card opens.
    if (item.block_id) {
      const history = el("div", "tv-section");
      history.append(el("h3", "", "Tier history"), el("p", "tv-meaning", "Loading…"));
      view.append(history);
      loadDetail(item.block_id, history, head);
    }
    return view;
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

  async function loadDetail(blockId, section, head) {
    const reply = await chrome.runtime.sendMessage({ type: "api", action: "block_detail", payload: { block_id: blockId } });
    section.replaceChildren(el("h3", "", "Tier history"));
    if (!reply?.ok) {
      section.append(el("p", "tv-meaning", "Couldn't load the history."));
      return;
    }
    const { block, history, sightings } = reply.data;
    if (block.status === "reviewed") {
      head.querySelector(".tv-badge")?.replaceWith(el("span", "tv-badge", "Reviewed"));
    }
    const list = el("ul");
    const rows = history.map((h) => {
      const change = h.old_tier == null ? `Tier ${h.new_tier}` : `Tier ${h.old_tier} → Tier ${h.new_tier}`;
      return `${formatDate(h.created_at)} · ${change} · ${ACTORS[h.actor] ?? h.actor}`;
    });
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

  function markAt(x, y) {
    const caret = caretAt(x, y);
    if (!caret) return null;
    return state.marks.find((m) => {
      if (!state.xray && !DEFAULT_VIEW.has(m.category)) return false;
      try {
        if (!m.range.isPointInRange(caret.node, caret.offset)) return false;
        // The caret lands beside the nearest character, so also check the click is on the text.
        return [...m.range.getClientRects()].some((r) =>
          x >= r.left && x <= r.right && y >= r.top && y <= r.bottom);
      } catch {
        return false;
      }
    }) ?? null;
  }

  document.addEventListener("click", (event) => {
    if (event.composedPath().includes(host)) return;
    const chip = event.target.closest?.("[data-tv-chip]");
    if (chip) {
      event.preventDefault();
      event.stopPropagation();
      const found = state.chips.find((c) => c.element === chip);
      if (found) openCard([found.result], chip.getBoundingClientRect(), undefined, found.item.kind);
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
    openCard([mark.result], mark.range.getBoundingClientRect());
  }, true);

  let pendingMove = false;
  document.addEventListener("mousemove", (event) => {
    if (pendingMove || !state.marks.length) return;
    pendingMove = true;
    requestAnimationFrame(() => {
      pendingMove = false;
      document.documentElement.classList.toggle("tv-pointer", Boolean(markAt(event.clientX, event.clientY)));
    });
  }, { passive: true });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeCard();
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
