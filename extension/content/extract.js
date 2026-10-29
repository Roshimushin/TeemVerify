// Injected into the current tab when "Check this page" is clicked.
// Collects the readable text on the page (titles, article paragraphs, comments) and splits
// it into sentences. The value of the last expression is returned to the popup.

(() => {
  // Elements that hold readable text, plus Reddit and Imgur spots the generic list misses.
  const TEXT_SELECTORS = [
    "h1", "h2", "h3", "h4", "p", "li", "blockquote", "figcaption", "td",
    "shreddit-post [slot='title']",
    "[data-testid='post-title']",
    ".Gallery-Title", ".GalleryComment-body",
    // Post descriptions (e.g. the poster's note under an Imgur image) are often plain divs.
    "[class*='description' i]",
  ].join(",");

  // Page furniture that isn't content. Some sites (Imgur) build footers and menus from
  // plain divs, so roles and footer class names count too.
  const SKIP_INSIDE = [
    "nav", "header", "footer", "aside", "form", "button", "script", "style", "noscript",
    "[aria-hidden='true']", "[hidden]",
    "[role='navigation']", "[role='banner']", "[role='contentinfo']", "[role='menu']", "[role='tablist']",
    "[class*='footer' i]",
  ].join(",");

  // Sentences that are labels or legal lines, not claims: short all-caps menu text
  // ("NEWEST IN MOST VIRAL") and copyright notices. Longer all-caps text is kept,
  // because Imgur titles often shout real claims.
  const MAX_LABEL_WORDS = 5;
  function isFurnitureText(sentence) {
    const shortAllCaps = !/[a-z]/.test(sentence) && sentence.split(/\s+/).length <= MAX_LABEL_WORDS;
    return shortAllCaps || !/[a-z]/i.test(sentence) || /^(©|\(c\)|copyright\b)/i.test(sentence);
  }

  const MIN_WORDS = 4;

  function isVisible(el) {
    if (!el.getClientRects().length) return false;
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none";
  }

  // Keep only the innermost matches, so a <li> holding a <p> isn't read twice.
  function hasMatchingChild(el) {
    return el.querySelector(TEXT_SELECTORS) !== null;
  }

  const passages = [];
  const seen = new Set();
  for (const el of document.querySelectorAll(TEXT_SELECTORS)) {
    if (el.closest(SKIP_INSIDE) || hasMatchingChild(el) || !isVisible(el)) continue;
    const text = el.innerText.replace(/\s+/g, " ").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    passages.push(text);
  }

  const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
  const sentences = [];
  passages.forEach((passage, passageIndex) => {
    for (const { segment } of segmenter.segment(passage)) {
      const sentence = segment.trim();
      if (sentence.split(/\s+/).length < MIN_WORDS || isFurnitureText(sentence)) continue;
      sentences.push({ text: sentence, passage: passageIndex });
    }
  });

  return { url: location.href, title: document.title, passageCount: passages.length, sentences };
})();
