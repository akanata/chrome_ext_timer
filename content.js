(() => {
  // Avoid adding the timer twice if the script is injected more than once.
  if (document.getElementById("times-up-ext-host")) return;

  // Everything we draw lives in a closed shadow root on a custom element, so
  // page CSS and other extensions (e.g. dark mode ones) can't restyle it. The
  // host covers the viewport but lets clicks through except on the overlay.
  // It's a manual popover so it can sit in the top layer, above the page's
  // own dialogs and popovers whatever their z-index; `all:initial` clears
  // the browser's default popover styling.
  const host = document.createElement("times-up-timer");
  host.id = "times-up-ext-host";
  host.popover = "manual";
  host.style.cssText =
    "all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;";

  const shadow = host.attachShadow({ mode: "closed" });
  shadow.innerHTML = `
    <style>
      .badge {
        position: absolute;
        top: 12px;
        right: 12px;
        font: 600 14px/1 system-ui, sans-serif;
        font-variant-numeric: tabular-nums;
        padding: 8px 14px;
        border-radius: 6px;
        box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3);
      }
      .overlay {
        position: absolute;
        inset: 0;
        display: none;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        pointer-events: auto;
      }
      .overlay.shown {
        display: flex;
      }
      /* GTA "WASTED" style: a heavy retro face with a thick black outline.
         The outline is painted under the fill so it doesn't eat into it. */
      .message {
        font: 400 clamp(48px, 12vw, 200px)/1.1 "TimeOut Bowlby One", system-ui, sans-serif;
        font-synthesis: none;
        -webkit-text-stroke: 0.08em #000;
        paint-order: stroke fill;
        text-shadow: 0.03em 0.05em 0 rgba(0, 0, 0, 0.35);
        text-align: center;
        padding: 0 16px;
        overflow-wrap: anywhere;
      }
      .reset {
        margin-top: 24px;
        font: 600 clamp(18px, 3vw, 36px)/1 system-ui, sans-serif;
        font-variant-numeric: tabular-nums;
        text-align: center;
      }
      .summary {
        margin-top: 32px;
        padding: 0 16px;
        max-width: min(65ch, 100%);
        max-height: 30vh;
        overflow: auto;
        box-sizing: border-box;
        font: 400 clamp(14px, 1.6vw, 18px)/1.5 system-ui, sans-serif;
        white-space: pre-wrap;
      }
      .summary:empty {
        display: none;
      }
    </style>
    <div class="badge"></div>
    <div class="overlay" role="alert">
      <div class="message"></div>
      <div class="reset"></div>
      <div class="summary"></div>
    </div>
  `;
  const badge = shadow.querySelector(".badge");
  const overlay = shadow.querySelector(".overlay");
  const message = shadow.querySelector(".message");
  const resetDisplay = shadow.querySelector(".reset");
  const summaryDisplay = shadow.querySelector(".summary");

  // Load the bundled font from bytes rather than a URL, so the page's content
  // security policy can't block it. Fonts added to the document also apply
  // inside our shadow root. A unique family name avoids clashing with a page
  // that uses Bowlby One itself.
  fetch(chrome.runtime.getURL("fonts/BowlbyOne-Regular.ttf"))
    .then((response) => response.arrayBuffer())
    .then((data) => new FontFace("TimeOut Bowlby One", data).load())
    .then((face) => document.fonts.add(face))
    .catch(() => {}); // Fall back to the system font.

  let ready = false;
  let timers = TIMES_UP_DEFAULTS.timers;
  let theme = TIMES_UP_DEFAULTS.theme;
  let cycleStarts = {}; // Mirror of local storage's cycleStart:* keys.
  let group = null; // This tab's group as { title, color }, or null if ungrouped.
  let saved = null; // What we changed on the page while TIME OUT is shown.
  let summary = null; // The latest page summary run; see startSummary().
  let summaryLeadMs = 30000; // How early to start summarising; adapts.
  let summarizerPromise = null;

  Promise.all([
    chrome.storage.sync.get(TIMES_UP_DEFAULTS),
    chrome.storage.local.get(null),
    chrome.runtime.sendMessage({ type: "getGroup" }),
  ]).then(([sync, local, tabGroup]) => {
    timers = timesUpWithDefaults(sync.timers);
    theme = sync.theme;
    cycleStarts = local;
    group = tabGroup ?? null;
    applyColors();
    ready = true;
    attach();
    tick();
    setInterval(tick, 250);
  });

  // Some single-page apps (e.g. ChatGPT) rebuild the whole document as they
  // start up, deleting anything they didn't create. Watch <html> and the
  // document itself (in case <html> is replaced) and put the timer back.
  const reattacher = new MutationObserver(() => {
    if (!host.isConnected) attach();
  });

  function attach() {
    document.documentElement.appendChild(host);
    reattacher.disconnect();
    reattacher.observe(document, { childList: true });
    reattacher.observe(document.documentElement, { childList: true });
    raise();
  }

  // (Re-)enter the top layer. Later entries stack above earlier ones, so this
  // also lifts us above any dialog the page opened since.
  function raise() {
    if (!host.showPopover) return; // Chrome < 114: z-index only.
    if (host.matches(":popover-open")) host.hidePopover();
    host.showPopover();
  }

  // Follow the system setting while the theme is "system".
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyColors);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes.timers?.newValue) {
      timers = timesUpWithDefaults(changes.timers.newValue);
      applyColors(); // A site list change can move this tab into a category.
    }
    if (area === "sync" && changes.theme?.newValue) {
      theme = changes.theme.newValue;
      applyColors();
    }
    if (area === "local") {
      for (const [key, { newValue }] of Object.entries(changes)) {
        if (newValue === undefined) delete cycleStarts[key];
        else cycleStarts[key] = newValue;
      }
    }
    tick();
  });

  // The background worker tells us when this tab changes group.
  chrome.runtime.onMessage.addListener((update) => {
    if (update.type !== "group") return;
    group = update.group;
    applyColors();
    tick();
  });

  // A group with its own settings has its own timer, and ungrouped tabs on a
  // category's sites use that category's timer. Everything else shares the
  // default one.
  function currentTimer() {
    const title = group?.title ?? null;
    const custom = title !== null ? timers.groups[title] : undefined;
    if (custom) return { key: timesUpCycleKey(title), settings: custom };

    const category = currentCategory();
    if (category) {
      return { key: timesUpCategoryCycleKey(category), settings: timers.categories[category] };
    }
    return { key: timesUpCycleKey(null), settings: timers.default };
  }

  // Categories only apply to ungrouped tabs.
  function currentCategory() {
    return group === null ? timesUpCategoryFor(timers, location.hostname) : null;
  }

  // The timer badge and message take the tab group's or category's colour.
  // Other ungrouped tabs get a black badge (light in dark mode) and a white
  // message, which isn't a group colour and stands out inside its black
  // outline. Dark mode uses lighter shades, so the badge text flips to dark
  // to stay readable.
  function applyColors() {
    const dark = timesUpIsDark(theme);
    const category = currentCategory();
    const colorName = group ? group.color : category && TIMES_UP_CATEGORY_COLORS[category];
    const color = timesUpGroupColor(colorName, dark);

    badge.style.background = color;
    badge.style.color = dark ? "#202124" : "#fff";
    overlay.style.background = dark ? "#202124" : "#fff";
    message.style.color = colorName ? color : "#fff";
    resetDisplay.style.color = dark ? "#9aa0a6" : "#5f6368";
    summaryDisplay.style.color = dark ? "#bdc1c6" : "#3c4043";
  }

  // Also used as the tab title while the message is shown.
  function setMessage(text) {
    text ||= TIMES_UP_DEFAULT_MESSAGE;
    if (message.textContent === text) return;
    message.textContent = text;
    if (saved) document.title = text;
  }

  // Work out where we are in the shared countdown / TIME OUT cycle from the
  // clock alone, so every tab agrees and throttled background tabs catch up.
  function tick() {
    if (!ready) return;
    const { key, settings } = currentTimer();
    setMessage(settings.message);
    let cycleStart = cycleStarts[key];
    if (cycleStart === undefined) {
      // First tab on this timer since it was cleared: start its cycle.
      cycleStart = cycleStarts[key] = Date.now();
      chrome.storage.local.set({ [key]: cycleStart });
    }

    const countdownMs = settings.countdownSeconds * 1000;
    const cycleMs = countdownMs + settings.timesUpSeconds * 1000;
    const elapsed = (((Date.now() - cycleStart) % cycleMs) + cycleMs) % cycleMs;
    const cycle = `${key}:${Math.floor((Date.now() - cycleStart) / cycleMs)}`;

    if (elapsed < countdownMs) {
      if (saved) hideTimeOut();
      badge.textContent = formatTime(countdownMs - elapsed);
      if (countdownMs - elapsed <= summaryLeadMs) maybeStartSummary(cycle);
    } else {
      if (!saved) showTimeOut();
      resetDisplay.textContent = `Back in ${formatTime(cycleMs - elapsed)}`;
      maybeStartSummary(cycle);
      renderSummary();
    }
  }

  function formatTime(ms) {
    const secs = Math.ceil(ms / 1000);
    return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
  }

  // Cover the page rather than removing it, so its DOM (and anything other
  // extensions added to it) is left alone. Underneath, make the page inert
  // (no clicks, focus, find-in-page or screen reader access), stop it
  // scrolling and pause its media.
  function showTimeOut() {
    const root = document.documentElement;
    saved = {
      title: document.title,
      bodyInert: document.body?.inert ?? false,
      rootOverflow: root.style.getPropertyValue("overflow"),
      rootOverflowPriority: root.style.getPropertyPriority("overflow"),
      pausedMedia: [...document.querySelectorAll("video, audio")].filter(
        (media) => !media.paused
      ),
    };

    if (document.body) document.body.inert = true;
    root.style.setProperty("overflow", "hidden", "important");
    for (const media of saved.pausedMedia) media.pause();
    document.title = message.textContent;

    badge.hidden = true;
    overlay.classList.add("shown");
    raise();
  }

  function hideTimeOut() {
    const root = document.documentElement;
    if (document.body) document.body.inert = saved.bodyInert;
    if (saved.rootOverflow) {
      root.style.setProperty("overflow", saved.rootOverflow, saved.rootOverflowPriority);
    } else {
      root.style.removeProperty("overflow");
    }
    for (const media of saved.pausedMedia) media.play().catch(() => {});
    document.title = saved.title;
    saved = null;

    overlay.classList.remove("shown");
    badge.hidden = false;

    // A summary still being written keeps going; it's reused next time.
    summaryDisplay.textContent = "";
  }

  // Summarise the page with Chrome's on-device Summarizer API, so the text
  // never leaves the machine. The model can be slow (~30 s on a laptop's
  // integrated GPU on battery), so start before TIME OUT, stream the result
  // in, and learn how early to start from how long summaries take here.
  //
  // Only in the visible tab: every tab on a timer times out at once, and
  // running the model in all of them would bog the machine down. A
  // background tab starts its summary when it's shown.
  const SUMMARY_INPUT_CHARS = 4000;
  const SUMMARY_OPTIONS = {
    type: "tldr",
    format: "plain-text",
    length: "medium",
    // The languages the Summarizer supports for output.
    outputLanguage: ["en", "es", "ja"].find((lang) => navigator.language.startsWith(lang)) ?? "en",
  };

  // `cycle` identifies one countdown/TIME OUT round, so each round gets at
  // most one summary. A summary of this page still being written (e.g. from
  // last round) is carried over rather than restarted.
  function maybeStartSummary(cycle) {
    if (summary?.cycle === cycle || document.visibilityState !== "visible") return;
    const running = summary && !summary.done && !summary.error;
    if (running && summary.url === location.href) {
      summary.cycle = cycle;
      return;
    }
    startSummary(cycle);
  }

  async function startSummary(cycle) {
    summary?.controller.abort(); // Superseded, e.g. by a navigation.
    const run = (summary = {
      cycle,
      url: location.href,
      controller: new AbortController(),
      startedAt: Date.now(),
      text: "",
      done: false,
      error: null,
    });
    const { signal } = run.controller;
    const title = saved?.title ?? document.title;

    try {
      const input = pageText();
      if (!input) throw new Error("this page has no text to summarize.");
      const summarizer = await getSummarizer();
      const stream = summarizer.summarizeStreaming(await fitToInputQuota(summarizer, input), {
        context: title ? `The page is titled "${title}".` : undefined,
        signal,
      });
      for await (const chunk of stream) {
        // Older Chrome versions stream the whole summary so far each time;
        // newer ones stream only the new part.
        run.text = chunk.startsWith(run.text) ? chunk : run.text + chunk;
      }
      run.done = true;
      const tookMs = Date.now() - run.startedAt;
      summaryLeadMs = Math.min(90000, Math.max(20000, tookMs * 1.25 + 5000));
    } catch (error) {
      if (!signal.aborted) run.error = error.message;
    }
  }

  // One summarizer per page, reused across rounds. A failure is retried next
  // round, e.g. once the model has finished downloading.
  function getSummarizer() {
    summarizerPromise ??= (async () => {
      if (!("Summarizer" in self)) throw new Error("the Summarizer API isn't available here.");
      // Downloading the model needs a user click, which a timer can't provide.
      const availability = await Summarizer.availability(SUMMARY_OPTIONS);
      if (availability === "unavailable") {
        throw new Error("Chrome's summary model can't run on this device.");
      }
      if (availability !== "available") {
        throw new Error("Chrome's summary model hasn't been downloaded yet.");
      }
      return Summarizer.create(SUMMARY_OPTIONS);
    })();
    summarizerPromise.catch(() => {
      summarizerPromise = null;
    });
    return summarizerPromise;
  }

  function renderSummary() {
    let text = "";
    if (summary && summary.url === location.href) {
      if (summary.error) {
        text = `No page summary: ${summary.error}`;
      } else if (summary.text) {
        text = summary.text;
      } else {
        const secs = Math.floor((Date.now() - summary.startedAt) / 1000);
        text = `Summarizing this page… ${secs}s`;
      }
    }
    if (summaryDisplay.textContent !== text) summaryDisplay.textContent = text;
  }

  // The page's main content if it marks one, otherwise the whole body. Kept
  // short: the model reads all of its input before writing anything, so
  // input length dominates how long a summary takes.
  function pageText() {
    const root = document.querySelector("main, [role='main'], article") ?? document.body;
    return (root?.innerText ?? "")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
      .slice(0, SUMMARY_INPUT_CHARS);
  }

  // Trim from the end until the text fits the model's input limit.
  async function fitToInputQuota(summarizer, text) {
    if (!summarizer.inputQuota || !summarizer.measureInputUsage) return text;
    while (
      text.length > 500 &&
      (await summarizer.measureInputUsage(text)) > summarizer.inputQuota
    ) {
      text = text.slice(0, Math.floor(text.length * 0.75));
    }
    return text;
  }
})();
