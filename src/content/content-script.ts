// Runs in the content script's isolated world (same tab/frame as inject.ts, separate JS realm).
// Pure relay: page <-window.postMessage-> here <-chrome.runtime.sendMessage-> background.
import type { AccountsChangedBroadcast, PageRequestMessage, PageResponseMessage } from "../lib/messages";

const PAGE_TARGET = "tari-wallet-page";
const CONTENT_TARGET = "tari-wallet-content";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sendToBackgroundOnce(message: PageRequestMessage): Promise<PageResponseMessage | undefined> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response: PageResponseMessage | undefined) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

// The background service worker can be mid-cold-start (Chrome tears MV3 workers down after ~30s
// idle) when a page's very first request arrives, failing with "Could not establish connection.
// Receiving end does not exist." even though it comes up a beat later. Retrying that specific,
// transient failure rides out the gap instead of surfacing a spurious error to the dApp.
async function sendToBackground(message: PageRequestMessage, retries = 3): Promise<PageResponseMessage | undefined> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await sendToBackgroundOnce(message);
    } catch (e) {
      const isColdStartRace = e instanceof Error && e.message.includes("Receiving end does not exist");
      if (!isColdStartRace || attempt >= retries) throw e;
      await sleep(200 * (attempt + 1));
    }
  }
}

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.target !== CONTENT_TARGET || data.type !== "tari-request") return;

  const message: PageRequestMessage = {
    kind: "tari-page-request",
    origin: window.location.origin,
    id: data.id,
    method: data.method,
    params: data.params,
  };

  sendToBackground(message)
    .then((response) => {
      if (!response) {
        window.postMessage({ target: PAGE_TARGET, type: "tari-response", id: data.id, error: "No response from wallet extension" }, "*");
        return;
      }
      window.postMessage({ target: PAGE_TARGET, type: "tari-response", id: response.id, result: response.result, error: response.error }, "*");
    })
    .catch((e: Error) => {
      window.postMessage({ target: PAGE_TARGET, type: "tari-response", id: data.id, error: e.message }, "*");
    });
});

// Unsolicited push from the background (not a reply to any page request) — forwarded into the
// page's world the same way as everything else, so inject.ts can turn it into a DOM event.
chrome.runtime.onMessage.addListener((message: AccountsChangedBroadcast) => {
  if (!message || message.kind !== "tari-accounts-changed") return;
  window.postMessage({ target: PAGE_TARGET, type: "tari-accounts-changed", accounts: message.accounts }, "*");
});
