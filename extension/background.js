import { callVerifyApi } from "./api.js";

// Popup, settings page and (later) the page script send { type: "api", action, payload }.
// Replies are { ok: true, data } or { ok: false, error }.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "api") return false;
  callVerifyApi(message.action, message.payload)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => sendResponse({ ok: false, error: err.message }));
  return true; // keeps the channel open for the async reply
});
