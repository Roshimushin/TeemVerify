const status = document.getElementById("status");

const reply = await chrome.runtime.sendMessage({
  type: "api",
  action: "match",
  payload: { text: "Connection test", count: 1 },
});

if (reply.ok) {
  status.textContent = "Connected. Page checking arrives in the next build step.";
  status.className = "ok";
} else {
  status.textContent = reply.error;
  status.className = "error";
}
