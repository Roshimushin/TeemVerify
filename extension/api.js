// Talks to the verify-api server function. Only the background worker calls this,
// so the access token never reaches the pages being read.

export const FUNCTION_URL = "https://hfbmawmztowmjkphbqmg.supabase.co/functions/v1/verify-api";

export const DEFAULT_SETTINGS = { token: "", dailyCapUsd: 5 };

export async function getSettings() {
  return { ...DEFAULT_SETTINGS, ...(await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS))) };
}

export async function callVerifyApi(action, payload = {}) {
  const { token } = await getSettings();
  if (!token) throw new Error("No access token yet. Add it on the settings page.");

  const res = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-teemverify-token": token },
    body: JSON.stringify({ action, ...payload }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) throw new Error("The access token was not accepted. Check it on the settings page.");
  if (!res.ok) throw new Error(body.error || `Server error ${res.status}`);
  return body;
}
