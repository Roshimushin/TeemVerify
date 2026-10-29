import { getSettings } from "./api.js";

const tokenInput = document.getElementById("token");
const capInput = document.getElementById("cap");
const status = document.getElementById("status");

function show(text, kind = "") {
  status.textContent = text;
  status.className = kind;
}

const settings = await getSettings();
tokenInput.value = settings.token;
capInput.value = settings.dailyCapUsd;

document.getElementById("save").addEventListener("click", async () => {
  const cap = Number(capInput.value);
  if (!(cap >= 0)) return show("Enter a cap of 0 or more.", "error");
  await chrome.storage.local.set({ token: tokenInput.value.trim(), dailyCapUsd: cap });
  show("Saved.", "ok");
});

document.getElementById("test").addEventListener("click", async () => {
  show("Testing…", "muted");
  // Uses the saved token, so save first if it was just changed.
  const reply = await chrome.runtime.sendMessage({
    type: "api",
    action: "match",
    payload: { text: "Connection test", count: 1 },
  });
  if (reply.ok) show("Connected to your block store.", "ok");
  else show(reply.error, "error");
});
