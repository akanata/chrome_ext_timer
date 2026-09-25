importScripts("defaults.js");

// Restart every timer's cycle when the browser or extension starts.
async function restartAllCycles() {
  const stored = await chrome.storage.local.get(null);
  const now = Date.now();
  const cycles = { [timesUpCycleKey(null)]: now };
  for (const key of Object.keys(stored)) {
    if (key.startsWith("cycleStart:")) cycles[key] = now;
  }
  await chrome.storage.local.remove("cycleStart"); // Pre-0.4 single timer.
  await chrome.storage.local.set(cycles);
}

chrome.runtime.onStartup.addListener(restartAllCycles);

chrome.runtime.onInstalled.addListener(async () => {
  // Carry over the single timer's settings from before 0.4.
  const old = await chrome.storage.sync.get(["countdownSeconds", "timesUpSeconds", "timers"]);
  if (old.countdownSeconds !== undefined && old.timers === undefined) {
    const fallback = TIMES_UP_DEFAULTS.timers.default;
    await chrome.storage.sync.set({
      timers: {
        default: {
          countdownSeconds: old.countdownSeconds,
          timesUpSeconds: old.timesUpSeconds ?? fallback.timesUpSeconds,
        },
        groups: {},
      },
    });
  }
  await chrome.storage.sync.remove(["countdownSeconds", "timesUpSeconds"]);
  await restartAllCycles();
});

// Content scripts can't see which tab group they're in, so they ask here and
// are told whenever it changes. A tab's group is { title, color }, with a
// null title for unnamed groups, or null if the tab is ungrouped.
function groupInfo(group) {
  return { title: group.title || null, color: group.color };
}

async function groupOf(groupId) {
  if (groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) return null;
  try {
    return groupInfo(await chrome.tabGroups.get(groupId));
  } catch {
    return null;
  }
}

function notifyTab(tabId, group) {
  // Fails for tabs without the content script (e.g. chrome:// pages).
  chrome.tabs.sendMessage(tabId, { type: "group", group }).catch(() => {});
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "getGroup" || !sender.tab) return;
  groupOf(sender.tab.groupId).then(sendResponse);
  return true; // Responding asynchronously.
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if ("groupId" in changeInfo) {
    groupOf(changeInfo.groupId).then((group) => notifyTab(tabId, group));
  }
});

// Fires for renames and colour changes, among others.
chrome.tabGroups.onUpdated.addListener(async (group) => {
  const tabs = await chrome.tabs.query({ groupId: group.id });
  for (const tab of tabs) notifyTab(tab.id, groupInfo(group));
});
