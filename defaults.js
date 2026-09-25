// Shared by the background worker, content script and popup.

// "default" covers ungrouped tabs and any tab group without its own timer.
// "groups" maps a tab group's title to that group's own timer.
// "theme" is "system", "light" or "dark".
var TIMES_UP_DEFAULTS = {
  timers: {
    default: { countdownSeconds: 60, timesUpSeconds: 30 },
    groups: {},
  },
  theme: "system",
};

function timesUpIsDark(theme) {
  return theme === "dark" ||
    (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
}

// Chrome's tab group colours, as shown in the tab strip in each mode. The
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
