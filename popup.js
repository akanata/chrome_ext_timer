const container = document.getElementById("timers");
const status = document.getElementById("status");
const themeSelect = document.getElementById("theme");

let timers = TIMES_UP_DEFAULTS.timers;
let theme = TIMES_UP_DEFAULTS.theme;
let openGroups = []; // [{ title, color }] for open groups, one per title.

init();

themeSelect.addEventListener("change", async () => {
  applyTheme(themeSelect.value);
  await chrome.storage.sync.set({ theme });
  showStatus("Saved.", "var(--ok)");
});

// Group dots use different shades in dark mode.
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", render);

function applyTheme(value) {
  theme = value;
  themeSelect.value = value;
  document.documentElement.dataset.theme = value;
  render();
}

async function init() {
  const [sync, groups] = await Promise.all([
    chrome.storage.sync.get(TIMES_UP_DEFAULTS),
    chrome.tabGroups.query({}),
  ]);
  timers = sync.timers;
  theme = sync.theme;
  themeSelect.value = theme;
  document.documentElement.dataset.theme = theme;

  // Groups are matched by title, so same-named groups share one entry (as do
  // all unnamed groups).
  const byTitle = new Map();
  for (const group of groups) {
    const title = group.title || null;
    if (!byTitle.has(title)) byTitle.set(title, { title, color: group.color });
  }
  openGroups = [...byTitle.values()];
  render();
}

function render() {
  container.replaceChildren();

  const ungrouped = section("Ungrouped tabs", null);
  ungrouped.append(
    note("Also used by groups without their own timer."),
    timerFields(timers.default, (changes, restart) => {
      timers.default = { ...timers.default, ...changes };
      save(restart ? null : undefined);
    })
  );
  container.append(ungrouped);

  for (const { title, color } of openGroups) {
    container.append(groupSection(title, color));
  }

  // Groups with saved settings that aren't open right now.
  const openTitles = new Set(openGroups.map((g) => g.title));
  for (const title of Object.keys(timers.groups)) {
    if (!openTitles.has(title)) container.append(groupSection(title, null, true));
  }
}

function groupSection(title, color, closed = false) {
  if (title === null) {
    const el = section("Unnamed group", color);
    el.append(note("Name this group to give it its own timer."));
    return el;
  }

  const el = section(closed ? `${title} (not open)` : title, color);
  const custom = timers.groups[title];

  const toggle = document.createElement("label");
  toggle.className = "toggle";
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = Boolean(custom);
  checkbox.addEventListener("change", () => {
    if (checkbox.checked) {
      timers.groups[title] = { ...timers.default };
      save(title);
    } else {
      delete timers.groups[title];
      save(); // Tabs fall back to the default timer; nothing to restart.
    }
    render();
  });
  toggle.append(checkbox, "Own timer");
  el.querySelector("header").append(toggle);

  if (custom) {
    el.append(
      timerFields(custom, (changes, restart) => {
        timers.groups[title] = { ...timers.groups[title], ...changes };
        save(restart ? title : undefined);
      })
    );
  }
  return el;
}

// `colorName` is a Chrome tab group colour name, or null for no dot.
function section(name, colorName) {
  const el = document.createElement("section");
  const header = document.createElement("header");
  if (colorName) {
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = timesUpGroupColor(colorName, timesUpIsDark(theme));
    header.append(dot);
  }
  const label = document.createElement("span");
  label.className = "name";
  label.textContent = name;
  label.title = name;
  header.append(label);
  el.append(header);
  return el;
}

function note(text) {
  const p = document.createElement("p");
  p.className = "note";
  p.textContent = text;
  return p;
}

// `onChange(changes, restart)` receives the changed settings, and whether the
// timer should restart (duration changes do; message changes don't).
function timerFields(timer, onChange) {
  const fields = document.createElement("div");
  fields.className = "fields";

  const countdownMin = numberInput(Math.floor(timer.countdownSeconds / 60));
  const countdownSec = numberInput(timer.countdownSeconds % 60, 59);
  const timesUpMin = numberInput(Math.floor(timer.timesUpSeconds / 60));
  const timesUpSec = numberInput(timer.timesUpSeconds % 60, 59);

  const messageInput = document.createElement("input");
  messageInput.type = "text";
  messageInput.maxLength = 100;
  messageInput.placeholder = TIMES_UP_DEFAULT_MESSAGE;
  messageInput.value = timer.message || TIMES_UP_DEFAULT_MESSAGE;

  fields.append(
    "Timer",
    wrap(countdownMin, "min", countdownSec, "sec"),
    "Show for",
    wrap(timesUpMin, "min", timesUpSec, "sec"),
    "Message",
    messageInput
  );

  // A blank message goes back to the default.
  messageInput.addEventListener("change", () => {
    const message = messageInput.value.trim() || TIMES_UP_DEFAULT_MESSAGE;
    messageInput.value = message;
    onChange({ message }, false);
  });

  const update = () => {
    const countdownSeconds =
      toWholeNumber(countdownMin.value) * 60 + toWholeNumber(countdownSec.value);
    const timesUpSeconds =
      toWholeNumber(timesUpMin.value) * 60 + toWholeNumber(timesUpSec.value);

    if (countdownSeconds < 1 || timesUpSeconds < 1) {
      showStatus("Both durations must be at least 1 second.", "var(--error)");
      return;
    }

    // Normalise the fields, e.g. 0 min 90 sec -> 1 min 30 sec.
    countdownMin.value = Math.floor(countdownSeconds / 60);
    countdownSec.value = countdownSeconds % 60;
    timesUpMin.value = Math.floor(timesUpSeconds / 60);
    timesUpSec.value = timesUpSeconds % 60;

    onChange({ countdownSeconds, timesUpSeconds }, true);
  };
  for (const input of [countdownMin, countdownSec, timesUpMin, timesUpSec]) {
    input.addEventListener("change", update);
  }
  return fields;
}

function numberInput(value, max) {
  const input = document.createElement("input");
  input.type = "number";
  input.min = "0";
  if (max !== undefined) input.max = String(max);
  input.step = "1";
  input.value = value;
  return input;
}

function wrap(...parts) {
  const span = document.createElement("span");
  span.append(...parts);
  return span;
}

// Saves all timers. If `restartTitle` is given (null = the default timer),
// restart that timer's cycle so its tabs begin the new durations together.
// Restart first: a just-started cycle is in its countdown whatever the
// durations, so tabs never see new durations applied to the old start.
async function save(restartTitle) {
  if (restartTitle !== undefined) {
    await chrome.storage.local.set({ [timesUpCycleKey(restartTitle)]: Date.now() });
  }
  await chrome.storage.sync.set({ timers });
  showStatus(restartTitle !== undefined ? "Saved. Timer restarted." : "Saved.", "var(--ok)");
}

function toWholeNumber(value) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function showStatus(text, color) {
  status.textContent = text;
  status.style.color = color;
}
