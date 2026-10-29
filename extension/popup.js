const status = document.getElementById("status");
const checkButton = document.getElementById("check");
const result = document.getElementById("result");
const preview = document.getElementById("preview");

const reply = await chrome.runtime.sendMessage({
  type: "api",
  action: "match",
  payload: { text: "Connection test", count: 1 },
});

if (reply.ok) {
  status.textContent = "Connected.";
  status.className = "ok";
  checkButton.disabled = false;
} else {
  status.textContent = reply.error;
  status.className = "error";
}

checkButton.addEventListener("click", async () => {
  checkButton.disabled = true;
  result.hidden = false;
  result.className = "muted";
  result.textContent = "Reading the page…";
  preview.hidden = true;
  preview.replaceChildren();

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content/extract.js"],
    });
    const page = injection.result;

    // Preview only for now: claim checking comes in the next build step.
    result.textContent = `Found ${page.sentences.length} sentences in ${page.passageCount} passages.`;
    for (const sentence of page.sentences) {
      const item = document.createElement("li");
      item.textContent = sentence.text;
      preview.append(item);
    }
    preview.hidden = page.sentences.length === 0;
  } catch (err) {
    result.className = "error";
    result.textContent = `Couldn't read this page: ${err.message}`;
  } finally {
    checkButton.disabled = false;
  }
});
