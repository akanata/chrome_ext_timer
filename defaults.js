// Shared by the background worker, content script and popup.

// "default" covers ungrouped tabs and any tab group without its own timer.
// "groups" maps a tab group's title to that group's own timer.
// "categories" are timers for ungrouped tabs on the sites each one lists.
// Each timer's "message" is shown when its time's up. "theme" is "system",
// "light" or "dark".
var TIMES_UP_DEFAULT_MESSAGE = "TIME OUT";
var TIMES_UP_DEFAULTS = {
  timers: {
    default: { countdownSeconds: 60, timesUpSeconds: 30, message: TIMES_UP_DEFAULT_MESSAGE },
    groups: {},
    categories: {
      social: {
        countdownSeconds: 60,
        timesUpSeconds: 30,
        message: TIMES_UP_DEFAULT_MESSAGE,
        sites: [
          "facebook.com",
          "instagram.com",
          "x.com",
          "twitter.com",
          "threads.net",
          "threads.com",
          "bsky.app",
          "tiktok.com",
          "reddit.com",
          "snapchat.com",
          "linkedin.com",
          "pinterest.com",
          "tumblr.com",
          "mastodon.social",
          "youtube.com",
          "twitch.tv",
          "discord.com",
          "whatsapp.com",
          "telegram.org",
        ],
      },
      ai: {
        countdownSeconds: 60,
        timesUpSeconds: 30,
        message: TIMES_UP_DEFAULT_MESSAGE,
        sites: [
          "chatgpt.com",
          "chat.openai.com",
          "claude.ai",
          "gemini.google.com",
          "copilot.microsoft.com",
          "perplexity.ai",
          "chat.deepseek.com",
          "grok.com",
          "chat.mistral.ai",
          "meta.ai",
          "poe.com",
          "character.ai",
          "pi.ai",
        ],
      },
    },
  },
  theme: "system",
};

// Display names, in the order categories are checked and shown.
var TIMES_UP_CATEGORY_NAMES = {
  social: "Social media",
  ai: "AI chatbots",
};

// Colour names from TIMES_UP_GROUP_COLORS. Deliberately not ones Chrome
// offers for tab groups, so a category never looks like a group.
var TIMES_UP_CATEGORY_COLORS = {
  social: "lime",
  ai: "indigo",
};

// Fill in categories missing from timers saved by an older version.
function timesUpWithDefaults(timers) {
  return {
    ...timers,
    categories: { ...TIMES_UP_DEFAULTS.timers.categories, ...timers.categories },
  };
}

// The first category listing `hostname` (or a parent domain of it), or null.
function timesUpCategoryFor(timers, hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  for (const id of Object.keys(TIMES_UP_CATEGORY_NAMES)) {
    const sites = timers.categories[id]?.sites ?? [];
    if (sites.some((site) => host === site || host.endsWith(`.${site}`))) return id;
  }
  return null;
}

function timesUpIsDark(theme) {
  return theme === "dark" ||
    (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
}

// Chrome's tab group colours, as shown in the tab strip in each mode, plus
// lime and indigo for categories (hues Chrome's palette leaves out). The
// neutral colour stands in for ungrouped tabs.
var TIMES_UP_GROUP_COLORS = {
  light: {
    neutral: "#000",
    grey: "#5f6368",
    blue: "#1a73e8",
    red: "#d93025",
    yellow: "#f9ab00",
    green: "#188038",
    pink: "#d01884",
    purple: "#a142f4",
    cyan: "#007b83",
    orange: "#fa903e",
    lime: "#7cb300",
    indigo: "#3f51b5",
  },
  dark: {
    neutral: "#e8eaed",
    grey: "#dadce0",
    blue: "#8ab4f8",
    red: "#f28b82",
    yellow: "#fdd663",
    green: "#81c995",
    pink: "#ff8bcb",
    purple: "#d7aefb",
    cyan: "#78d9ec",
    orange: "#fcad70",
    lime: "#c0e060",
    indigo: "#9fa8f0",
  },
};

function timesUpGroupColor(colorName, dark) {
  const palette = TIMES_UP_GROUP_COLORS[dark ? "dark" : "light"];
  return palette[colorName] ?? palette.neutral;
}

// Local-storage key holding when a timer's current cycle started. Every tab
// on the same timer derives its countdown from it, so they stay in step.
function timesUpCycleKey(groupTitle) {
  return groupTitle === null ? "cycleStart:default" : `cycleStart:group:${groupTitle}`;
}

function timesUpCategoryCycleKey(categoryId) {
  return `cycleStart:category:${categoryId}`;
}
