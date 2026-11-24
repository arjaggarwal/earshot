// The in-meeting panel (top frame only), docked beside the meeting.
//
// Opens when a meeting is detected, docked beside the meeting (or floating),
// and collapses to a small draggable launcher: the Earshot "E" (its color
// shows capture status), a camera for screenshots, and Ask AI. Closes itself,
// launcher included, when the meeting ends.
//
// Live Transcript: spaced blocks by speaker; click a block to fix it, click a
// name to rename that person everywhere, hover for 🎯 ✅ ❓ 💡 to drop the block
// into your notes. NOTES below takes quick bullets and action items.
// Ask AI: questions about the meeting so far, answered by your CLI through the
// Earshot helper; every exchange is saved with the meeting.
(() => {
  if (window.top !== window || window.__earshotPanel) return;
  window.__earshotPanel = true;
  // A panel left by a copy that Earshot's reload cut off goes; this one replaces it.
  for (const stale of document.querySelectorAll("earshot-overlay")) stale.remove();

  const PANEL_WIDTH = 360;
  const DOCK_GAP = 8;
  const DOCK_SPACE = PANEL_WIDTH + DOCK_GAP * 2;
  const ENDED_CLOSE_MS = 4000;
  const BLOCK_GAP_MS = 8000; // a pause this long starts a new block even for the same speaker
  const NOTICE = "Hi all, I'm keeping a transcript of this call with my note-taking tool so I can follow up accurately.";
  const QUICK_PROMPTS = ["Key points so far", "Action items so far", "What did I miss in the last 5 minutes?", "Suggest follow-up questions"];

  // In the Mac app this panel runs in a web view (mac/Web/panel.html), where the
  // window around it is native: layout, moves and screenshots go to the app.
  // Both checks: a meeting page's element with id="earshotNative" shows up as
  // window.earshotNative even here, but it isn't a function and chrome.runtime.id is the extension's.
  const mac = chrome.runtime?.id === "earshot-mac" && typeof window.earshotNative?.call === "function";
  const MAC_PANEL_HEIGHT = 720;
  const native = (name, payload = {}) => {
    try {
      return Promise.resolve(window.earshotNative.call(name, payload)).catch(() => null);
    } catch {
      return Promise.resolve(null);
    }
  };

  const platform = /(^|\.)zoom\.us$/.test(location.hostname) ? "zoom" : location.hostname === "meet.google.com" ? "meet" : "teams";

  // Make room for the docked panel the way each app's layout allows.
  const DOCK_CSS = {
    zoom: `html[data-earshot-docked] #root, html[data-earshot-docked] .pwa-webclient__iframe-wrapper:not(#root *) { width: calc(100% - ${DOCK_SPACE + 4}px) !important; }`,
    meet: `html[data-earshot-docked] .crqnQb, html[data-earshot-docked] .cNfpK { max-width: calc(100% - ${DOCK_SPACE}px) !important; }`,
    teams: `html[data-earshot-docked] #app { margin-right: ${DOCK_SPACE}px !important; }
      html[data-earshot-docked] iframe.embedded-electron-webview.embedded-page-content { width: calc(100vw - ${DOCK_SPACE}px) !important; }
      html[data-earshot-docked] body:not(:has(#app)) [data-tid="stage-layout"] { margin-right: ${DOCK_SPACE}px !important; }`,
  };
  // The app's own caption strip, hidden on request (capture doesn't need it).
  const APP_CAPTIONS_CSS = {
    zoom: `.live-transcription-subtitle__box, #live-transcription-subtitle { display: none !important; }`,
    teams: `[data-tid="closed-caption-renderer-wrapper"], [data-tid="closed-caption-v2-window-wrapper"] { display: none !important; }`,
    meet: `.a4cQT, div[role="region"][aria-label="Captions"] { display: none !important; }`,
  };
  // Where each app shows a screen share, as far as we know; the scoring below covers the rest.
  const SHARE_SELECTORS = {
    zoom: ['[class*="sharee-container"] canvas', '[class*="sharee-container"] video', "#sharee-container canvas", '[class*="share-view"] canvas'],
    teams: ['[data-stream-type="ScreenSharing"] video', '[data-tid*="screen-shar" i] video', '[data-tid*="screenshar" i] video', '[data-cid*="screen-shar" i] video'],
    meet: ['[data-participant-id*="presentation" i] video', '[aria-label*="presentation" i] video', '[aria-label*="presenting" i] video'],
  };
  const SHARE_WORDS = /present|screen.?shar|sharee|screenshar|content.?shar|desktop.?shar/i;

  const segments = new Map(); // id -> segment
  let meeting = null; // summary or full record from the background worker
  let status = { level: "idle", text: "Waiting for a meeting…" };
  let prefs = { panelMode: "docked", captionLanguage: "en", hideAppCaptions: false, panelOpenOnJoin: false, tags: [] };
  let paused = false;
  let collapsed = false;
  let tab = "transcript";
  let query = "";
  let editing = null; // element being edited; renders wait until it's done
  let renderQueued = false;
  let renderDeferred = false; // a render skipped while text was selected
  let notesDirty = false; // typed notes not yet saved; renders leave the box alone
  let waitingSince = null; // when the meeting started waiting for captions
  let captionsOff = false; // waited too long: the host has probably turned captions off
  let offCause = null; // { text, hint, retry } when the page hook knows a better reason than that
  const NO_CAPTIONS_HINT = "No captions yet. If people are talking, the host has captions off: ask them to turn captions on.";
  let followLatest = true;
  let openReacts = null; // segment whose line-tag picker is open; survives re-renders
  let pendingDiagnostics = null;
  let endedTimer = null;
  let asking = null; // question waiting for an answer
  let lastShareScan = null;
  let aiHealth = null; // { ok, problem, fix } from the helper's sign-in check
  let host = null;
  let shadow = null;
  let $ = null;
  const shotCache = new Map(); // screenshot id -> data URL

  // ---------------------------------------------------------------- styles and icons

  // Same palette as the meetings page's dark theme: quiet graphite, warm text,
  // one steel-blue accent; small radii, underline tabs, tags as words. The
  // panel stays dark even when the meetings page is light, so it sits quietly
  // over a call.
  const STYLE = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .panel { --bg: #1c1d1f; --panel: #232427; --raised: #2c2d31; --hover: #303135; --line: #36383c; --text: #e6e4df; --muted: #a3a19b;
      --faint: #77756f; --accent: #8fb0cc; --accent-ink: #13212c; --danger: #e09a90;
      position: fixed; z-index: 2147483000; display: flex; flex-direction: column; background: var(--panel); color: var(--text);
      font: 14px/1.5 "Earshot Inter", -apple-system, system-ui, "Segoe UI", sans-serif; -webkit-font-smoothing: antialiased;
      border-radius: 8px; overflow: hidden; box-shadow: 0 12px 36px rgba(0,0,0,.45); }
    .panel.docked { top: ${DOCK_GAP}px; right: ${DOCK_GAP}px; bottom: ${DOCK_GAP}px; width: ${PANEL_WIDTH}px; }
    .panel.floating { top: 72px; right: 16px; width: ${PANEL_WIDTH}px; height: min(720px, calc(100vh - 100px)); }
    .hidden { display: none !important; }
    :focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    header { display: flex; align-items: center; gap: 2px; padding: 10px 10px 6px 12px; user-select: none; }
    .panel.floating header { cursor: grab; }
    .logo { width: 26px; height: 26px; border-radius: 50%; display: grid; place-items: center; font: 650 14px/1 "Earshot Inter", -apple-system, sans-serif;
      color: #fff; background: #3c4043; box-shadow: 0 0 0 2px #5f6368; flex: none; }
    .logo.waiting { box-shadow: 0 0 0 2px #e0a43a; }
    .logo.live { background: #1e8e3e; box-shadow: 0 0 0 2px #81c995; }
    .logo.paused { background: #5f6368; box-shadow: 0 0 0 2px #9aa0a6; }
    .logo.problem { background: #a50e0e; box-shadow: 0 0 0 2px #f28b82; }
    .logo.ended { background: #3d5266; box-shadow: 0 0 0 2px #8fb0cc; }
    .grow { flex: 1; }
    button { font: inherit; color: inherit; background: var(--raised); border: 1px solid transparent; border-radius: 6px; padding: 5px 10px; cursor: pointer; }
    button:hover { background: var(--hover); }
    button.icon { background: none; padding: 5px; display: inline-flex; color: var(--muted); border-radius: 6px; }
    button.icon:hover { background: var(--raised); color: var(--text); }
    button.icon.on { color: #e0c070; }
    svg { width: 18px; height: 18px; stroke: currentColor; fill: none; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
    .switch { display: flex; gap: 20px; margin: 0 12px 10px; border-bottom: 1px solid var(--line); }
    .switch button { background: none; border: 0; border-bottom: 2px solid transparent; border-radius: 0; margin-bottom: -1px; padding: 6px 0 8px;
      font-size: 14px; display: flex; gap: 6px; align-items: center; color: var(--muted); }
    .switch button:hover { background: none; color: var(--text); }
    .switch button.on { color: var(--text); border-bottom-color: var(--accent); }
    .switch svg { width: 15px; height: 15px; }
    .langbtn { position: relative; display: inline-flex; padding: 5px; border-radius: 6px; color: var(--muted); cursor: pointer; }
    .langbtn:hover { background: var(--raised); color: var(--text); }
    .langbtn select { position: absolute; inset: 0; width: 100%; opacity: 0; cursor: pointer; }
    .aiwarn, .capwarn, .discardask { display: flex; gap: 8px; align-items: center; margin: 0 12px 8px; padding: 8px 8px 8px 10px; border: 1px solid #6b3530; border-left-width: 3px;
      background: #2c2120; color: var(--danger); border-radius: 4px; font-size: 12px; }
    .aiwarn span, .capwarn span, .discardask span { flex: 1; }
    .aiwarn code { color: var(--text); font-size: 11px; }
    .aiwarn button, .capwarn button, .discardask button { font-size: 12px; background: #4a2a26; color: var(--text); padding: 3px 8px; flex: none; }
    .meetrow { display: flex; align-items: baseline; gap: 4px 10px; padding: 2px 12px 8px; flex-wrap: wrap; }
    .meta { font-size: 15px; font-weight: 650; letter-spacing: -.01em; line-height: 1.3; cursor: text; border-radius: 4px; padding: 1px 4px; margin-left: -4px; max-width: 100%;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .meta:hover { background: var(--raised); }
    .meta[contenteditable="true"] { background: var(--bg); outline: 1px solid var(--accent); white-space: normal; }
    .chips { display: flex; gap: 2px 8px; flex-wrap: wrap; align-items: baseline; }
    .chip { font-size: 12px; color: var(--accent); }
    .chip.add { background: none; border: 0; padding: 0; color: var(--faint); font-size: 12px; }
    .chip.add:hover { color: var(--text); background: none; text-decoration: underline; text-underline-offset: 3px; }
    .suggest { display: flex; align-items: baseline; gap: 10px; margin: -4px 12px 8px; font-size: 12px; color: var(--muted); }
    .suggest span { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .suggest button { background: none; border: 0; padding: 0; font-size: 12px; color: var(--accent); }
    .suggest button:hover { background: none; text-decoration: underline; text-underline-offset: 3px; }
    .suggest button[data-act="dismiss-suggestion"] { color: var(--faint); font-size: 14px; line-height: 1; }
    .suggest button[data-act="dismiss-suggestion"]:hover { color: var(--text); text-decoration: none; }
    .status { width: 100%; color: var(--faint); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .tagmenu { position: absolute; z-index: 3; top: 150px; left: 12px; right: 12px; background: var(--panel); border: 1px solid var(--line); border-radius: 6px;
      padding: 6px; max-height: 300px; overflow-y: auto; box-shadow: 0 12px 30px rgba(0,0,0,.5); }
    .tagmenu label { display: flex; gap: 8px; align-items: center; padding: 4px 6px; border-radius: 4px; cursor: pointer; }
    .tagmenu label:hover { background: var(--raised); }
    .tagmenu input[type=checkbox] { accent-color: var(--accent); }
    .tagmenu .done { margin-top: 6px; width: 100%; background: var(--accent); color: var(--accent-ink); font-weight: 600; }
    .tagmenu input[type=text] { width: 100%; margin-top: 6px; padding: 5px 8px; border-radius: 4px; border: 1px solid var(--line); background: var(--bg); color: inherit; font: inherit; }
    .view { display: none; flex: 1; min-height: 0; flex-direction: column; position: relative; }
    .view.on { display: flex; }
    .search { margin: 0 12px 6px; padding: 6px 9px; border-radius: 6px; border: 1px solid var(--line); background: var(--bg); color: inherit; font: inherit; font-size: 13px; }
    .search:focus { outline: none; border-color: var(--accent); }
    .body { overflow-y: auto; padding: 2px 10px 10px; flex: 1; min-height: 80px; }
    .who { font-weight: 600; font-size: 13px; margin: 12px 4px 2px; display: flex; gap: 8px; align-items: baseline; }
    .who .name { cursor: text; border-radius: 4px; padding: 0 2px; }
    .who .name:hover { background: var(--raised); }
    .who .name[contenteditable="true"] { background: var(--bg); outline: 1px solid var(--accent); }
    .when { color: var(--faint); font-weight: 400; font-size: 12px; font-variant-numeric: tabular-nums; }
    /* A speaker's turn is one paragraph; each caption line is an inline piece of it. */
    .turn { position: relative; margin: 0 0 10px; padding: 0 4px; font-size: 14px; line-height: 1.5; color: var(--text); }
    .block { border-radius: 3px; cursor: text; -webkit-box-decoration-break: clone; box-decoration-break: clone; }
    .block:hover { background: var(--raised); }
    .block[contenteditable="true"] { background: var(--bg); outline: 1px solid var(--accent); }
    .block.edited { text-decoration: underline dotted var(--faint); text-underline-offset: 4px; }
    .block .badge { margin-left: 6px; font-size: 11px; color: var(--accent); white-space: nowrap; }
    .reacts { position: absolute; right: 2px; top: -14px; display: none; flex-wrap: wrap; justify-content: flex-end; gap: 2px; max-width: calc(100% - 8px);
      background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 2px; z-index: 2; box-shadow: 0 4px 14px rgba(0,0,0,.35); }
    .block:hover .reacts, .reacts.open { display: flex; }
    .block[contenteditable="true"] .reacts { display: none; }
    .reacts button { background: none; border: 0; padding: 1px 6px; font-size: 11px; border-radius: 4px; color: var(--muted); }
    .reacts button[data-reaction] { display: none; }
    .reacts.open button[data-reaction] { display: inline-block; }
    .reacts.open .tagopen { display: none; }
    .reacts button:hover, .reacts button.on { background: var(--raised); color: var(--text); }
    /* Buttons and labels that sit in the text stay out of a selection and out of what's copied. */
    .reacts, .block .badge, .a .meta2, .shot .cap { -webkit-user-select: none; user-select: none; }
    .selcopy { position: absolute; z-index: 5; display: none; padding: 3px 10px; font-size: 12px; font-weight: 600; border: 0; border-radius: 5px;
      background: var(--accent); color: var(--accent-ink); box-shadow: 0 4px 12px rgba(0,0,0,.4); }
    .selcopy.show { display: block; }
    .shot { margin: 8px 4px 14px; }
    .shot img { width: 100%; border-radius: 4px; border: 1px solid var(--line); cursor: zoom-in; display: block; }
    .shot .cap { display: flex; justify-content: space-between; color: var(--faint); font-size: 11px; margin-top: 3px; }
    .shot .cap button { padding: 0 6px; font-size: 11px; background: none; color: var(--muted); }
    .empty { color: var(--faint); padding: 18px 6px; font-size: 14px; }
    .jump { position: absolute; right: 14px; bottom: 8px; font-size: 12px; background: var(--accent); color: var(--accent-ink); font-weight: 600; }
    .divider { display: flex; align-items: center; gap: 10px; color: var(--muted); font-size: 12px; font-weight: 600; padding: 6px 12px; cursor: row-resize; user-select: none; }
    .divider::after { content: ""; flex: 1; border-top: 1px solid var(--line); }
    .notesbox { display: flex; flex-direction: column; padding: 0 12px 6px; height: 230px; min-height: 120px; }
    .notetools { display: flex; flex-wrap: wrap; gap: 2px 12px; margin-bottom: 6px; }
    .notetools button { font-size: 12px; padding: 0; background: none; border: 0; color: var(--muted); white-space: nowrap; }
    .notetools button:hover { background: none; color: var(--accent); }
    .notes-text { flex: 1; resize: none; background: var(--bg); color: inherit; border: 1px solid var(--line); border-radius: 6px; padding: 9px 11px;
      font: 14px/1.5 -apple-system, system-ui, sans-serif; }
    .notes-text:focus { outline: none; border-color: var(--accent); }
    .saved { color: var(--faint); font-size: 11px; min-height: 16px; padding-top: 2px; }
    .chat { overflow-y: auto; flex: 1; padding: 4px 12px; }
    .q { margin: 16px 0 4px; font-weight: 600; }
    .q:first-child { margin-top: 4px; }
    .a { margin: 0 0 6px; padding: 0 0 10px 10px; border-left: 2px solid var(--line); white-space: pre-wrap; }
    .a.err { color: var(--danger); border-left-color: var(--danger); }
    .a .meta2 { display: flex; align-items: center; gap: 10px; color: var(--faint); font-size: 11px; margin-top: 6px; }
    .a .meta2 button { background: none; border: 0; color: var(--muted); font-size: 11px; padding: 0; }
    .a .meta2 button:hover { color: var(--accent); background: none; }
    .a.md { white-space: normal; }
    .md > :first-child { margin-top: 0; }
    .md h1, .md h2, .md h3, .md h4, .md h5, .md h6 { font-size: 14px; font-weight: 600; margin: 10px 0 4px; }
    .md p { margin: 5px 0; }
    .md ul, .md ol { margin: 3px 0; padding-left: 18px; }
    .md li { margin: 2px 0; }
    .md li::marker { color: var(--faint); }
    .md strong { font-weight: 600; }
    .md code { font: 12px ui-monospace, Menlo, monospace; background: var(--raised); padding: 1px 4px; border-radius: 3px; }
    .md pre { background: var(--bg); border: 1px solid var(--line); padding: 8px; border-radius: 4px; overflow-x: auto; }
    .md table { border-collapse: collapse; margin: 6px 0; font-size: 12px; }
    .md th, .md td { border-bottom: 1px solid var(--line); padding: 3px 10px 3px 0; text-align: left; vertical-align: top; }
    .md th { color: var(--muted); }
    .md blockquote { margin: 5px 0; padding-left: 10px; border-left: 2px solid var(--line); color: var(--muted); }
    .md a { color: var(--accent); }
    .prompts { display: flex; flex-wrap: wrap; gap: 4px 14px; padding: 8px 12px 0; }
    .prompts button { font-size: 12px; background: none; border: 0; padding: 0; color: var(--muted); }
    .prompts button:hover { background: none; color: var(--accent); }
    .askbar { display: flex; gap: 6px; padding: 8px 12px 12px; align-items: flex-end; }
    .askbar textarea { flex: 1; resize: none; min-height: 38px; max-height: 120px; background: var(--bg); color: inherit; border: 1px solid var(--line); border-radius: 6px; padding: 8px 10px; font: inherit; }
    .askbar textarea:focus { outline: none; border-color: var(--accent); }
    .askbar button { background: var(--accent); color: var(--accent-ink); height: 38px; }
    .askbar button:hover { background: #a3bfd6; }
    footer { display: flex; gap: 4px; padding: 8px 10px 10px; align-items: center; border-top: 1px solid var(--line); }
    footer button { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; background: none; color: var(--muted); }
    footer button:hover { background: var(--raised); color: var(--text); }
    footer svg { width: 16px; height: 16px; }
    .menuwrap { position: relative; margin-left: auto; }
    .menu { display: none; position: absolute; right: 0; bottom: 40px; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 4px;
      min-width: 240px; box-shadow: 0 12px 30px rgba(0,0,0,.5); }
    .menu.open { display: block; }
    .menu button { display: block; width: 100%; text-align: left; background: none; padding: 7px 10px; font-size: 13px; color: var(--text); border-radius: 4px; }
    .menu button:hover { background: var(--raised); }
    .menu hr { border: 0; border-top: 1px solid var(--line); margin: 4px 0; }
    .toast { position: absolute; left: 50%; bottom: 60px; transform: translateX(-50%); background: var(--text); color: var(--bg); padding: 6px 12px;
      border-radius: 6px; font-size: 12px; opacity: 0; transition: opacity .15s; pointer-events: none; max-width: 90%; text-align: center; z-index: 4; }
    .toast.show { opacity: 1; }
    .launcher { position: fixed; z-index: 2147483647; right: 12px; top: 40vh; display: flex; flex-direction: column; align-items: center; gap: 10px;
      padding: 10px 7px; background: #232427; border: 1px solid #36383c; border-radius: 10px; box-shadow: 0 8px 28px rgba(0,0,0,.45); user-select: none; }
    .launcher .grip { width: 18px; height: 4px; border-radius: 2px; background: #55575c; cursor: grab; margin-bottom: -2px; }
    .launcher button { background: none; border: 0; padding: 4px; border-radius: 6px; display: grid; place-items: center; color: #b4b2ac; }
    .launcher button:hover { background: #2c2d31; color: #e6e4df; }
    .launcher .logo { width: 28px; height: 28px; font-size: 15px; }
    .launcher .note { position: absolute; top: 8px; right: calc(100% + 8px); white-space: nowrap; background: #1e8e3e; color: #fff; padding: 6px 10px;
      border-radius: 6px; font: 500 12px/1.3 "Earshot Inter", -apple-system, sans-serif; box-shadow: 0 6px 20px rgba(0,0,0,.35);
      opacity: 0; transition: opacity .2s; pointer-events: none; }
    .launcher .note.on-left { right: auto; left: calc(100% + 8px); }
    .launcher .note.show { opacity: 1; }
    .launcher button svg { width: 24px; height: 24px; }
    .launcher button:not([data-act="l-open"]) { padding: 1px; }
    .lightbox { position: fixed; inset: 0; z-index: 2147483001; background: rgba(0,0,0,.85); display: none; align-items: center; justify-content: center; cursor: zoom-out; }
    .lightbox.open { display: flex; }
    .lightbox img { max-width: 94vw; max-height: 94vh; border-radius: 4px; }
    /* Mac app: the window fits the panel or the launcher; there's no meeting page to dock into or caption. */
    :host([data-mac]) .launcher { top: ${DOCK_GAP}px; left: ${DOCK_GAP}px; right: auto; }
    :host([data-mac]) header .logo { cursor: pointer; }
    :host(:not([data-mac])) [data-act="stop"], :host([data-mac]) [data-act="discard"] { display: none; }
    header .discard { color: #e8776c; }
    header .discard:hover { color: #f28b82; }
    :host([data-mac]) [data-act="dock"], :host([data-mac]) .langbtn, :host([data-mac]) [data-act="hide-captions"] { display: none; }
    @media (prefers-reduced-motion: reduce) { .toast { transition: none; } }
  `;

  const ICONS = {
    pause: '<svg viewBox="0 0 24 24"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>',
    play: '<svg viewBox="0 0 24 24"><path d="M7 5l12 7-12 7z"/></svg>',
    stop: '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>',
    discard: '<svg viewBox="0 0 24 24"><path d="M8.3 3h7.4L21 8.3v7.4L15.7 21H8.3L3 15.7V8.3z"/><path d="M9.5 9.5l5 5M14.5 9.5l-5 5"/></svg>',
    dock: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/></svg>',
    float: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><rect x="11" y="10" width="7" height="6" rx="1"/></svg>',
    home: '<svg viewBox="0 0 24 24"><path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/></svg>',
    settings: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
    collapse: '<svg viewBox="0 0 24 24"><path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/></svg>',
    camera: '<svg viewBox="0 0 24 24"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>',
    ask: '<svg viewBox="0 0 24 24"><path d="M6.5 4.5h11a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3h-5l-4.5 3.5v-3.5H6.5a3 3 0 0 1-3-3v-7a3 3 0 0 1 3-3z"/><path d="M12 7.6l1 2.4 2.4 1-2.4 1-1 2.4-1-2.4-2.4-1 2.4-1z" fill="currentColor" stroke="none"/></svg>',
    copy: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg>',
    download: '<svg viewBox="0 0 24 24"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>',
    search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
    globe: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>',
    send: '<svg viewBox="0 0 24 24"><path d="M4 12l16-8-6 16-2-7z"/></svg>',
  };

  let colorFor = () => "#81c995"; // set per render from the meeting's speaker order

  // After Earshot is reloaded, this copy in an open tab has no extension left
  // and sending throws at once; treat that as no answer, like any other failure.
  const send = (msg) => {
    try {
      return chrome.runtime.sendMessage(msg).catch(() => null);
    } catch {
      noteCutOff();
      return Promise.resolve(null);
    }
  };
  // Earshot was reloaded or updated and this copy can't reach it any more. Say
  // so in the panel, rather than sit there looking live and capturing nothing.
  let cutOff = false;
  const isCutOff = () => !mac && !chrome.runtime?.id;
  function noteCutOff() {
    if (cutOff || !isCutOff()) return;
    cutOff = true;
    queueRender();
  }
  const act = (action, extra = {}) => send({ kind: "meeting-action", action, ...extra });

  // ---------------------------------------------------------------- mounting and layout

  // Inter, from the extension. Fonts declared inside a shadow root don't load,
  // so the face goes in the page's head under a name of its own.
  function loadFont() {
    if (document.getElementById("earshot-font") || !chrome.runtime?.id) return;
    const style = document.createElement("style");
    style.id = "earshot-font";
    const face = (file, range) =>
      `@font-face { font-family: "Earshot Inter"; src: url("${chrome.runtime.getURL(`fonts/${file}`)}") format("woff2"); font-weight: 100 900; font-display: swap; unicode-range: ${range}; }`;
    style.textContent = [face("inter-latin.woff2", "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+2000-206F, U+20AC, U+2122, U+2190-2199, U+2212, U+2215, U+FEFF, U+FFFD"), face("inter-latin-ext.woff2", "U+0100-02AF, U+1E00-1EFF, U+20A0-20C0, U+2C60-2C7F, U+A720-A7FF")].join("\n");
    (document.head || document.documentElement).appendChild(style);
  }

  function mount() {
    if (shadow) return;
    clearTimeout(endedTimer);
    loadFont();
    host = document.createElement("earshot-overlay");
    if (mac) host.setAttribute("data-mac", "");
    overlayParent().appendChild(host);
    attachWatch = setInterval(keepAttached, 1500);
    shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>${STYLE}</style>
      <div class="panel">
        <header>
          <span class="logo dot" title="Earshot">E</span>
          <button class="icon discard" data-act="discard" title="Don't record this meeting: stop and delete what was captured">${ICONS.discard}</button>
          <span class="grow"></span>
          <button class="icon" data-act="meetings" title="All meetings">${ICONS.home}</button>
          <button class="icon" data-act="pause" title="Pause capture">${ICONS.pause}</button>
          <button class="icon" data-act="stop" title="Stop recording">${ICONS.stop}</button>
          <button class="icon" data-act="dock" title="Float the panel">${ICONS.float}</button>
          <label class="langbtn" title="Caption language: English">${ICONS.globe}<select class="langpick">${Earshot.LANGUAGES.map((l) => `<option value="${l.id}">${l.name}</option>`).join("")}</select></label>
          <button class="icon" data-act="settings" title="Settings">${ICONS.settings}</button>
          <button class="icon" data-act="collapse" title="Collapse to the launcher (⌥⇧E)">${ICONS.collapse}</button>
        </header>
        <div class="switch tabs">
          <button data-tab="transcript" class="on">Live Transcript</button>
          <button data-tab="ask">${ICONS.ask}Ask AI</button>
        </div>
        <div class="discardask hidden"><span>Stop recording and delete everything from this meeting?</span><button data-act="discard-yes">Delete</button><button data-act="discard-no">Cancel</button></div>
        <div class="aiwarn hidden"><span class="aiwarn-text"></span><button data-act="copy-fix">Copy fix</button></div>
        <div class="capwarn hidden"><span></span><button data-act="retry-captions">Try again</button></div>
        <div class="meetrow">
          <div class="meta" title="Click to rename the meeting"></div>
          <div class="chips"></div>
          <div class="status"></div>
        </div>
        <div class="suggest hidden"><span class="suggest-text"></span><button data-act="use-suggestion" title="Tag the meeting with this company">Use</button><button data-act="dismiss-suggestion" title="Not this company">×</button></div>
        <div class="tagmenu hidden"></div>
        <div class="view on" data-view="transcript">
          <input class="search hidden" type="search" placeholder="Search the transcript" />
          <div class="body"></div>
          <button class="jump hidden" data-act="latest">↓ Latest</button>
        </div>
        <div class="notes-area" data-view-extra="transcript">
          <div class="divider" title="Drag to resize">Notes</div>
          <div class="notesbox">
            <div class="notetools">
              <button data-note="- " title="Bullet">• Bullet</button>
              ${Earshot.TAGS.map((t) => `<button data-tag="${t.tag}" title="Tag this line #${t.tag}; the vault agent picks it up when the meeting is filed">#${t.tag}</button>`).join("")}
            </div>
            <textarea class="notes-text" placeholder="Add notes to your transcript. Type - for a bullet, [] for an action item; Tab indents."></textarea>
            <div class="saved"></div>
          </div>
        </div>
        <div class="view" data-view="ask">
          <div class="chat"></div>
          <div class="prompts">${QUICK_PROMPTS.map((p) => `<button data-prompt="${p}">${p}</button>`).join("")}</div>
          <div class="askbar">
            <textarea class="askinput" rows="1" placeholder="Ask anything about this meeting so far…"></textarea>
            <button data-act="ask-send" title="Ask">${ICONS.send}</button>
          </div>
        </div>
        <footer>
          <button data-act="screenshot" title="Save what's being presented, or the meeting screen (⌥⇧S)">${ICONS.camera}Screenshot</button>
          <button class="icon" data-act="search-toggle" title="Search the transcript">${ICONS.search}</button>
          <button class="icon" data-act="copy" title="Copy the transcript">${ICONS.copy}</button>
          <div class="menuwrap">
            <button data-act="export-menu">${ICONS.download}Export</button>
            <div class="menu">
              <button data-act="export-md">Markdown (.md)</button>
              <button data-act="export-html">Web page with screenshots (.html)</button>
              <button data-act="export-json">Data (.json)</button>
              <button data-act="open-folder">Open the meeting's folder</button>
              <hr />
              <button data-act="hide-captions">Hide the app's own captions</button>
              <button data-act="notify">Copy an "I'm transcribing" note</button>
              <button data-act="debug">Debug info</button>
            </div>
          </div>
        </footer>
        <div class="toast"></div>
        <button class="selcopy" data-act="copy-selection" title="Copy the selected text">Copy</button>
      </div>
      <div class="launcher hidden">
        <div class="grip" title="Drag to move"></div>
        <div class="note" role="status"></div>
        <button data-act="l-open" title="Open Earshot"><span class="logo dot">E</span></button>
        <button data-act="l-shot" title="Screenshot what's being presented, or the meeting screen">${ICONS.camera}</button>
        <button data-act="l-ask" title="Ask AI about this meeting">${ICONS.ask}</button>
      </div>
      <div class="lightbox"><img alt="" /></div>`;
    $ = (sel) => shadow.querySelector(sel);
    shadow.addEventListener("click", onClick);
    // Typing in Earshot mustn't trigger the meeting app's keyboard shortcuts.
    for (const type of ["keydown", "keyup", "keypress"]) {
      shadow.addEventListener(type, (e) => {
        const t = e.composedPath()[0];
        if (t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.isContentEditable)) e.stopPropagation();
      });
    }
    shadow.addEventListener("keydown", (e) => {
      if (e.key === "Escape") $(".tagmenu").classList.add("hidden");
      // ⌘C / Ctrl+C on selected text is Earshot's: the meeting app mustn't take it.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c" && selectionIn()) e.stopPropagation();
    });
    // Copying part of the transcript gives just that text, cleanly. (Answers keep the
    // browser's own rich copy, for Word and Teams; their buttons are left out by CSS.)
    shadow.addEventListener("copy", (e) => {
      const hit = selectionIn();
      if (!hit || hit.list !== $(".body") || !e.clipboardData) return;
      e.clipboardData.setData("text/plain", Earshot.selectionText(hit.range));
      e.preventDefault();
      e.stopPropagation();
    });
    // The Copy button by a selection: a mouse press on it mustn't clear the selection it copies.
    $(".selcopy").addEventListener("mousedown", (e) => e.preventDefault());
    $(".selcopy").addEventListener("pointerdown", (e) => e.stopPropagation());
    for (const list of [".body", ".chat"]) $(list).addEventListener("scroll", () => placeSelectionCopy(), { passive: true });
    $(".langpick").addEventListener("change", (e) => setLanguage(e.target.value));
    $(".search").addEventListener("input", (e) => {
      query = e.target.value.trim().toLowerCase();
      render();
    });
    $(".body").addEventListener("scroll", () => {
      const b = $(".body");
      followLatest = b.scrollHeight - b.scrollTop - b.clientHeight < 40;
      $(".jump").classList.toggle("hidden", followLatest);
    });
    wireNotes();
    wireAsk();
    makePanelDraggable();
    makeLauncherDraggable();
    makeNotesResizable();
    applyLayout();
    queueRender();
  }

  // Where the overlay lives: a direct child of <html>, outside the meeting app's own tree and
  // clear of any transform or clipping on <body>. In element fullscreen (Zoom's and Teams'
  // full-screen buttons) only the fullscreen element renders, so it moves in there and back
  // out after. If a re-render of the app drops it, it's put back.
  let attachWatch = null;
  function overlayParent() {
    const fs = document.fullscreenElement;
    if (fs && !/^(VIDEO|CANVAS|IFRAME|IMG|svg)$/i.test(fs.tagName)) return fs;
    return document.documentElement;
  }
  function keepAttached() {
    if (!host) return;
    if (isCutOff()) {
      // A fresh copy took this panel's place (it removed this one): stay gone, don't come back beside it.
      if (!host.isConnected || [...document.querySelectorAll("earshot-overlay")].some((el) => el !== host)) {
        clearInterval(attachWatch);
        host.remove();
        return;
      }
      noteCutOff();
    }
    const parent = overlayParent();
    if (host.parentNode !== parent) parent.appendChild(host);
  }
  document.addEventListener("fullscreenchange", keepAttached);

  function unmount() {
    if (!host) return;
    clearInterval(attachWatch);
    host.remove();
    host = shadow = $ = null;
    lastLayout = "";
    editing = null;
    undock();
    // Mac app: nothing shows now, so the (transparent) window goes too.
    if (mac) native("layout", { hidden: true });
  }

  function dockPage(on) {
    let style = document.getElementById("earshot-dock-style");
    if (!style) {
      style = document.createElement("style");
      style.id = "earshot-dock-style";
      style.textContent = DOCK_CSS[platform];
      (document.head || document.documentElement).appendChild(style);
    }
    const root = document.documentElement;
    const was = root.hasAttribute("data-earshot-docked");
    if (on) {
      root.setAttribute("data-earshot-docked", "");
      // Zoom and Meet also measure the window in script; page-layout.js answers with the narrower width.
      if (platform !== "teams") root.setAttribute("data-earshot-dock-js", String(DOCK_SPACE));
    } else {
      root.removeAttribute("data-earshot-docked");
      root.removeAttribute("data-earshot-dock-js");
    }
    if (was !== on) window.dispatchEvent(new Event("resize"));
  }
  const undock = () => dockPage(false);

  function applyLayout() {
    if (!shadow) return;
    const panel = $(".panel");
    const docked = prefs.panelMode === "docked";
    panel.classList.toggle("docked", docked);
    panel.classList.toggle("floating", !docked);
    panel.classList.toggle("hidden", collapsed);
    $(".launcher").classList.toggle("hidden", !collapsed);
    if (docked) panel.removeAttribute("style");
    dockPage(docked && !collapsed);
    const dockBtn = shadow.querySelector('[data-act="dock"]');
    dockBtn.innerHTML = docked ? ICONS.float : ICONS.dock;
    dockBtn.title = docked ? "Float the panel" : "Dock the panel beside the meeting";
    applyAppCaptions();
    tellLayout();
  }

  // The Mac app sizes its window to what shows: the panel, or the launcher
  // (and hides it on {hidden: true}, from unmount).
  let lastLayout = "";
  function tellLayout() {
    if (!mac || !shadow) return;
    const r = $(".launcher").getBoundingClientRect();
    const size = collapsed ? { width: Math.ceil(r.width) + DOCK_GAP * 2, height: Math.ceil(r.height) + DOCK_GAP * 2 } : { width: DOCK_SPACE, height: MAC_PANEL_HEIGHT + DOCK_GAP * 2 };
    const layout = { collapsed, ...size };
    if (JSON.stringify(layout) === lastLayout) return;
    lastLayout = JSON.stringify(layout);
    native("layout", layout);
  }

  // Mac app: a drag moves the window, by the pointer's movement on screen.
  function dragWindow(handle, onMove, onEnd) {
    let last = null;
    handle.addEventListener("pointerdown", (e) => (last = { x: e.screenX, y: e.screenY }));
    dragWith(
      handle,
      (ev) => {
        if (!last) return;
        onMove?.();
        const dx = ev.screenX - last.x;
        const dy = ev.screenY - last.y;
        last = { x: ev.screenX, y: ev.screenY };
        if (dx || dy) native("drag", { dx, dy });
      },
      onEnd
    );
  }

  function applyAppCaptions() {
    let style = document.getElementById("earshot-captions-style");
    if (prefs.hideAppCaptions && !style) {
      style = document.createElement("style");
      style.id = "earshot-captions-style";
      style.textContent = APP_CAPTIONS_CSS[platform];
      (document.head || document.documentElement).appendChild(style);
    } else if (!prefs.hideAppCaptions && style) style.remove();
    const item = shadow?.querySelector('[data-act="hide-captions"]');
    if (item) item.textContent = prefs.hideAppCaptions ? "Show the app's own captions" : "Hide the app's own captions";
  }

  // Drags follow the pointer at window level and only start after a few
  // pixels of movement, so a plain click still reaches the button under it.
  function dragWith(handle, onMove, onEnd) {
    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const start = { x: e.clientX, y: e.clientY };
      let moved = false;
      const move = (ev) => {
        if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 4) return;
        moved = true;
        ev.preventDefault();
        onMove(ev, start);
      };
      const up = () => {
        window.removeEventListener("pointermove", move, true);
        window.removeEventListener("pointerup", up, true);
        if (moved) onEnd?.();
      };
      window.addEventListener("pointermove", move, true);
      window.addEventListener("pointerup", up, true);
    });
  }

  function makePanelDraggable() {
    const panel = $(".panel");
    const header = shadow.querySelector("header");
    if (mac) {
      return dragWindow(
        header,
        () => (header.dataset.dragged = "1"),
        () => setTimeout(() => delete header.dataset.dragged, 0)
      );
    }
    let origin = null;
    header.addEventListener("pointerdown", () => (origin = panel.getBoundingClientRect()));
    dragWith(header, (ev, start) => {
      if (prefs.panelMode === "docked" || !origin) return;
      const left = Math.min(Math.max(0, origin.left + ev.clientX - start.x), window.innerWidth - 80);
      const top = Math.min(Math.max(0, origin.top + ev.clientY - start.y), window.innerHeight - 40);
      Object.assign(panel.style, { left: `${left}px`, top: `${top}px`, right: "auto" });
    });
  }

  // The launcher moves by dragging anywhere on it (a short press still clicks).
  // Its spot is saved as the side it's on (left or right, and how far in) plus how far down
  // it is as a share of the window's height, never as raw pixels. So it lands in the same
  // place on any window or screen size, and CSS keeps it on screen as the window changes.
  // One spot for Zoom, Teams and Meet (chrome.storage, not each site's localStorage).
  function placeLauncher(pos) {
    const launcher = $(".launcher");
    launcher.removeAttribute("style");
    const ok = pos && (pos.side === "left" || pos.side === "right") && [pos.inset, pos.y, pos.w, pos.h].every(Number.isFinite);
    if (!ok) return; // the stylesheet's default: right edge, 40% down
    const other = pos.side === "left" ? "right" : "left";
    Object.assign(launcher.style, {
      [pos.side]: `clamp(0px, ${pos.inset}px, calc(100vw - ${pos.w}px))`,
      [other]: "auto",
      top: `clamp(0px, calc(${(pos.y * 100).toFixed(2)}vh - ${pos.h / 2}px), calc(100vh - ${pos.h}px))`,
    });
  }

  function makeLauncherDraggable() {
    const launcher = $(".launcher");
    if (mac) {
      return dragWindow(
        launcher,
        () => (launcher.dataset.dragged = "1"),
        () => setTimeout(() => delete launcher.dataset.dragged, 0)
      );
    }
    try {
      localStorage.removeItem("earshot:launcher"); // the old pixel spot, which only fit the window it was saved in
      chrome.storage.local.get("launcherPos").then((r) => shadow && placeLauncher(r.launcherPos), () => {});
    } catch {}
    let origin = null;
    launcher.addEventListener("pointerdown", () => (origin = launcher.getBoundingClientRect()));
    dragWith(
      launcher,
      (ev, start) => {
        launcher.dataset.dragged = "1";
        const left = Math.min(Math.max(0, origin.left + ev.clientX - start.x), window.innerWidth - origin.width);
        const top = Math.min(Math.max(0, origin.top + ev.clientY - start.y), window.innerHeight - origin.height);
        Object.assign(launcher.style, { left: `${left}px`, top: `${top}px`, right: "auto" });
      },
      () => {
        const r = launcher.getBoundingClientRect();
        const side = r.left + r.width / 2 < window.innerWidth / 2 ? "left" : "right";
        const pos = {
          side,
          inset: Math.round(side === "left" ? r.left : window.innerWidth - r.right),
          y: Number(((r.top + r.height / 2) / window.innerHeight).toFixed(4)),
          w: Math.round(r.width),
          h: Math.round(r.height),
        };
        placeLauncher(pos);
        try {
          chrome.storage.local.set({ launcherPos: pos });
        } catch {}
        setTimeout(() => delete launcher.dataset.dragged, 0);
      }
    );
  }

  function makeNotesResizable() {
    const box = $(".notesbox");
    let startHeight = 0;
    $(".divider").addEventListener("pointerdown", () => (startHeight = box.getBoundingClientRect().height));
    dragWith($(".divider"), (ev, start) => {
      box.style.height = `${Math.min(Math.max(110, startHeight - (ev.clientY - start.y)), window.innerHeight * 0.7)}px`;
    });
  }

  function toast(text) {
    if (!shadow) return;
    const t = $(".toast");
    t.textContent = text;
    t.classList.add("show");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.remove("show"), 2800);
  }

  // Once per meeting, when the first lines come in (or come back after captions were off),
  // say so: a toast in the open panel, or a bubble beside the launcher.
  let confirmedFor = null;
  function confirmCapturing(text) {
    if (!shadow || !meeting) return;
    confirmedFor = meeting.id;
    if (!collapsed) return toast(text);
    const launcher = $(".launcher");
    const note = $(".launcher .note");
    const r = launcher.getBoundingClientRect();
    note.textContent = text;
    note.classList.toggle("on-left", r.left + r.width / 2 < window.innerWidth / 2); // bubble on the side with room
    note.classList.add("show");
    clearTimeout(confirmCapturing.timer);
    confirmCapturing.timer = setTimeout(() => note.classList.remove("show"), 4000);
  }

  // ---------------------------------------------------------------- notes: quick bullets

  function wireNotes() {
    const box = $(".notes-text");
    let timer = null;
    const flush = async () => {
      clearTimeout(timer);
      timer = null;
      await act("notes", { text: box.value });
      if (!timer) {
        notesDirty = false;
        $(".saved").textContent = "Saved";
      }
    };
    const save = () => {
      notesDirty = true;
      $(".saved").textContent = "Saving…";
      clearTimeout(timer);
      timer = setTimeout(flush, 600);
    };
    box.addEventListener("input", save);
    // Clicking away (to tag a line, say) saves at once, so that action builds on
    // these notes rather than racing the debounce and overwriting the last words.
    box.addEventListener("blur", () => timer && flush());

    const lineBounds = () => {
      const v = box.value;
      const start = v.lastIndexOf("\n", box.selectionStart - 1) + 1;
      const endAt = v.indexOf("\n", box.selectionStart);
      return { start, end: endAt === -1 ? v.length : endAt, text: v.slice(start, endAt === -1 ? v.length : endAt) };
    };
    const replaceRange = (from, to, text, caret) => {
      box.setRangeText(text, from, to, "end");
      if (caret !== undefined) box.setSelectionRange(caret, caret);
      save();
    };

    box.addEventListener("keydown", (e) => {
      const line = lineBounds();
      const bullet = /^(\s*)(- \[ \] |- \[x\] |[-*•] |\d+\. )/.exec(line.text);
      if (e.key === "Enter" && !e.shiftKey && bullet) {
        e.preventDefault();
        // An empty bullet ends the list; otherwise continue it on the next line.
        if (line.text.trim() === bullet[2].trim()) return replaceRange(line.start, line.end, "");
        let marker = bullet[2] === "- [x] " ? "- [ ] " : bullet[2];
        const n = /^(\d+)\. $/.exec(marker);
        if (n) marker = `${Number(n[1]) + 1}. `;
        replaceRange(box.selectionStart, box.selectionEnd, `\n${bullet[1]}${marker}`);
      } else if (e.key === "Tab") {
        e.preventDefault();
        if (e.shiftKey) {
          const trimmed = line.text.replace(/^ {1,2}/, "");
          replaceRange(line.start, line.end, trimmed, Math.max(line.start, box.selectionStart - (line.text.length - trimmed.length)));
        } else replaceRange(line.start, line.start, "  ", box.selectionStart + 2);
      } else if (e.key === " " && line.text === "[]" && box.selectionStart === line.end) {
        e.preventDefault();
        replaceRange(line.start, line.end, "- [ ] ");
      }
    });

    shadow.querySelector(".notetools").addEventListener("click", (e) => {
      const t = e.target.closest("button[data-tag]");
      if (t) {
        box.focus();
        const line = lineBounds();
        const next = Earshot.toggleLineTag(line.text, t.dataset.tag);
        return replaceRange(line.start, line.end, next.text, line.start + next.caret);
      }
      const b = e.target.closest("button[data-note]");
      if (!b) return;
      box.focus();
      const insert = b.dataset.note;
      const line = lineBounds();
      if (line.text.trim() === "") replaceRange(box.selectionStart, box.selectionEnd, insert);
      else replaceRange(line.end, line.end, `\n${insert}`);
    });
  }

  // ---------------------------------------------------------------- Ask AI

  function wireAsk() {
    const input = $(".askinput");
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        askQuestion(input.value);
      }
    });
    input.addEventListener("input", () => {
      input.style.height = "auto";
      input.style.height = `${Math.min(120, input.scrollHeight)}px`;
    });
  }

  async function askQuestion(text) {
    const question = String(text || "").trim();
    if (!question || asking) return;
    asking = question;
    $(".askinput").value = "";
    renderChat({ scroll: "bottom" });
    const res = await send({ kind: "ask", question });
    asking = null;
    if (res?.error) toast(res.error);
    if (res && !res.error && meeting) {
      meeting.chats = [...(meeting.chats || []).filter((c) => c.at !== res.at), res];
    }
    renderChat({ scroll: "last-question" });
  }

  function showTab(next) {
    tab = next;
    shadow.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
    shadow.querySelectorAll(".view").forEach((v) => v.classList.toggle("on", v.dataset.view === tab));
    $(".notes-area").classList.toggle("hidden", tab !== "transcript");
    shadow.querySelector('[data-act="search-toggle"]').classList.toggle("hidden", tab !== "transcript");
    render();
    if (tab === "ask") {
      $(".chat").scrollTop = $(".chat").scrollHeight;
      $(".askinput").focus();
    }
  }

  // ---------------------------------------------------------------- tags

  function openTagMenu() {
    const menu = $(".tagmenu");
    if (!menu.classList.contains("hidden")) return menu.classList.add("hidden");
    const current = new Set(meeting?.tags || []);
    const all = [...new Set([...(prefs.tags || []), ...current])];
    menu.innerHTML = "";
    for (const t of all) {
      const label = document.createElement("label");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = current.has(t);
      box.addEventListener("change", () => {
        box.checked ? current.add(t) : current.delete(t);
        act("set-tags", { tags: [...current] });
      });
      label.append(box, document.createTextNode(t));
      menu.appendChild(label);
    }
    const add = document.createElement("input");
    add.type = "text";
    add.placeholder = "New tag, then Enter";
    add.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || !add.value.trim()) return;
      const t = add.value.trim();
      current.add(t);
      prefs.tags = [...new Set([...(prefs.tags || []), t])];
      act("set-tags", { tags: [...current], addToList: true });
      menu.classList.add("hidden");
    });
    const done = document.createElement("button");
    done.textContent = "Done";
    done.className = "done";
    done.addEventListener("click", () => menu.classList.add("hidden"));
    menu.append(add, done);
    // Sit just under the title row.
    const row = $(".meetrow").getBoundingClientRect();
    const panel = $(".panel").getBoundingClientRect();
    menu.style.top = `${row.bottom - panel.top}px`;
    menu.classList.remove("hidden");
    add.focus();
  }

  // ---------------------------------------------------------------- selecting and copying part of the text

  function selection() {
    return shadow?.getSelection ? shadow.getSelection() : window.getSelection();
  }

  // Text selected in the transcript or the Ask AI answers: {range, list}, else null.
  function selectionIn() {
    if (!shadow) return null;
    const sel = selection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    if (!String(range).trim()) return null;
    for (const list of [$(".body"), $(".chat")]) if (list && list.contains(range.commonAncestorContainer)) return { range, list };
    return null;
  }

  // Where in a line's text a click left the cursor (null: not in its text).
  function clickOffset(block) {
    const sel = selection();
    return sel && sel.isCollapsed && sel.anchorNode === block.firstChild && sel.anchorNode?.nodeType === 3 ? sel.anchorOffset : null;
  }

  // The Copy button sits under the end of the selection (above it near the bottom), inside the panel.
  function placeSelectionCopy() {
    if (!shadow) return;
    const btn = $(".selcopy");
    const hit = editing ? null : selectionIn();
    const rects = hit ? [...hit.range.getClientRects()].filter((r) => r.width || r.height) : [];
    const box = hit && hit.list.getBoundingClientRect();
    const end = rects[rects.length - 1];
    if (!end || end.bottom < box.top || end.top > box.bottom) return btn.classList.remove("show");
    const panel = $(".panel").getBoundingClientRect();
    btn.classList.add("show");
    const w = btn.offsetWidth;
    const h = btn.offsetHeight;
    let top = end.bottom + 6;
    if (top + h > box.bottom) top = rects[0].top - h - 6;
    top = Math.min(Math.max(top, box.top), box.bottom - h);
    const left = Math.min(Math.max(end.right - w, box.left + 4), box.right - w - 4);
    btn.style.top = `${top - panel.top}px`;
    btn.style.left = `${left - panel.left}px`;
  }

  // ---------------------------------------------------------------- editing in place

  // Turn an element into a one-line editor. Enter saves, Escape cancels.
  // `caret` puts the cursor at that character instead of selecting the whole text.
  function editInPlace(el, onSave, textOf = (n) => n.textContent, caret = null) {
    if (editing) return;
    editing = el;
    const before = textOf(el);
    el.contentEditable = "true";
    el.textContent = before;
    el.focus();
    const range = document.createRange();
    if (Number.isInteger(caret) && el.firstChild) {
      range.setStart(el.firstChild, Math.min(caret, el.firstChild.length));
      range.collapse(true);
    } else range.selectNodeContents(el);
    const sel = selection();
    sel.removeAllRanges();
    sel.addRange(range);
    const finish = async (save) => {
      el.removeEventListener("keydown", onKey);
      el.removeEventListener("blur", onBlur);
      el.contentEditable = "false";
      const after = el.textContent.trim();
      editing = null;
      if (save && after && after !== before.trim()) await onSave(after);
      queueRender();
    };
    const onKey = (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        el.blur();
      } else if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      }
    };
    const onBlur = () => finish(true);
    el.addEventListener("keydown", onKey);
    el.addEventListener("blur", onBlur);
  }

  // ---------------------------------------------------------------- actions

  function download(name, content, type) {
    const blob = content instanceof Blob ? content : new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    shadow.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  const fullMeeting = (withImages = false) => send({ kind: "get-meeting", withImages });

  async function onClick(e) {
    const target = e.target;
    const launcherBtn = target.closest(".launcher button");
    if (launcherBtn) {
      if ($(".launcher").dataset.dragged) return;
      const a = launcherBtn.dataset.act;
      if (a === "l-shot") return takeScreenshot();
      collapsed = false;
      applyLayout();
      showTab(a === "l-ask" ? "ask" : "transcript");
      return;
    }
    if (target.closest(".lightbox")) return $(".lightbox").classList.remove("open");
    // Mac app: the panel's E folds it back to the launcher, as the launcher's E opens it.
    if (mac && target.closest("header .logo") && !shadow.querySelector("header").dataset.dragged) {
      collapsed = true;
      return applyLayout();
    }
    if (!target.closest(".tagmenu") && !target.closest(".chips")) $(".tagmenu").classList.add("hidden");
    if (openReacts && !target.closest(".reacts")) {
      openReacts = null;
      for (const open of shadow.querySelectorAll(".reacts.open")) open.classList.remove("open");
    }

    const tabBtn = target.closest(".tabs button");
    if (tabBtn) return showTab(tabBtn.dataset.tab);
    const prompt = target.closest("button[data-prompt]");
    if (prompt) return askQuestion(prompt.dataset.prompt);
    if (target.closest(".chips")) return openTagMenu();
    if (target.closest(".meta") && !editing) {
      return editInPlace($(".meta"), async (title) => {
        const res = await act("rename", { title });
        if (res?.ok) toast("Meeting renamed");
      });
    }
    // Selecting text (a drag, a double or triple click) is for copying, not editing.
    const selecting = !!selectionIn() || e.detail > 1;
    if (selecting && target.closest(".body") && !target.closest("button")) return;
    const name = target.closest(".name");
    if (name && !editing) {
      return editInPlace(name, async (newName) => {
        await act("rename-speaker", { speakerId: name.dataset.speaker, name: newName });
        toast(`Renamed to ${newName} everywhere`);
      });
    }
    const opener = target.closest(".reacts .tagopen");
    if (opener) {
      for (const other of shadow.querySelectorAll(".reacts.open")) other.classList.remove("open");
      opener.parentElement.classList.add("open");
      openReacts = opener.closest(".block").dataset.id;
      return;
    }
    const react = target.closest(".reacts button");
    if (react) {
      const id = react.closest(".block").dataset.id;
      const s = segments.get(id);
      openReacts = null;
      if (s) s.reaction = Earshot.tagOf(s.reaction)?.id === react.dataset.reaction ? null : react.dataset.reaction;
      render();
      const res = await act("react", { segmentId: id, reaction: react.dataset.reaction });
      if (res?.ok && s?.reaction) toast(`Added to your notes with #${Earshot.tagOf(s.reaction).tag}`);
      return;
    }
    const block = target.closest(".block");
    if (block && !editing) {
      // A click edits the line with the cursor where you clicked (a second click then
      // selects a word in it, as in any text box), not with the whole line selected.
      const s = segments.get(block.dataset.id);
      return editInPlace(
        block,
        async (text) => {
          if (s) Object.assign(s, { text, edited: true });
          await act("edit-segment", { segmentId: block.dataset.id, text });
        },
        () => s?.text || "",
        clickOffset(block)
      );
    }
    const img = target.closest(".shot img");
    if (img) {
      $(".lightbox img").src = img.src;
      $(".lightbox").classList.add("open");
      return;
    }

    const button = target.closest("button[data-act]");
    if (!button) return $(".menu")?.classList.remove("open");
    const action = button.dataset.act;
    if (action !== "export-menu") $(".menu").classList.remove("open");
    switch (action) {
      case "export-menu":
        $(".menu").classList.toggle("open");
        break;
      case "use-suggestion":
        if (meeting?.tagSuggestion?.tag) await act("set-tags", { tags: [meeting.tagSuggestion.tag] });
        break;
      case "dismiss-suggestion":
        await act("dismiss-suggestion");
        break;
      case "retry-captions":
        send({ kind: "retry-captions" });
        captionsOff = false;
        offCause = null;
        waitingSince = Date.now();
        toast("Asked for captions again");
        render();
        break;
      case "copy-fix":
        await navigator.clipboard.writeText(aiHealth?.fix || "");
        toast("Copied. Paste it into Terminal.");
        break;
      case "discard":
        shadow.querySelector(".discardask").classList.toggle("hidden");
        break;
      case "discard-no":
        shadow.querySelector(".discardask").classList.add("hidden");
        break;
      case "discard-yes": {
        const res = await send({ kind: "discard-meeting" });
        if (!res?.ok) {
          toast("Couldn't delete this meeting. Try again, or delete it from All meetings.");
          break;
        }
        // Nothing of this meeting stays, on the page or in Earshot.
        meeting = null;
        segments.clear();
        clearTimeout(endedTimer);
        unmount();
        break;
      }
      case "stop":
        await send({ kind: "stop" });
        break;
      case "pause": {
        const res = await send({ kind: "set-paused", value: !paused });
        paused = !!res?.paused;
    aiHealth = res?.aiHealth || null;
        updatePauseButton();
        break;
      }
      case "dock":
        prefs.panelMode = prefs.panelMode === "docked" ? "floating" : "docked";
        send({ kind: "set-setting", key: "panelMode", value: prefs.panelMode });
        applyLayout();
        break;
      case "collapse":
        collapsed = true;
        applyLayout();
        break;
      case "meetings":
        send({ kind: "open-meetings", id: meeting?.id });
        break;
      case "settings":
        send({ kind: "open-meetings", id: "settings" });
        break;
      case "search-toggle":
        $(".search").classList.toggle("hidden");
        if (!$(".search").classList.contains("hidden")) $(".search").focus();
        else {
          query = "";
          $(".search").value = "";
          render();
        }
        break;
      case "latest":
        followLatest = true;
        $(".body").scrollTop = $(".body").scrollHeight;
        break;
      case "ask-send":
        askQuestion($(".askinput").value);
        break;
      case "delete-shot":
        await act("delete-screenshot", { shotId: button.dataset.id });
        break;
      case "copy-selection": {
        const hit = selectionIn();
        if (!hit) return placeSelectionCopy();
        await Earshot.copySelection(hit.range, { rich: hit.list === $(".chat") });
        toast("Copied");
        break;
      }
      case "copy-answer": {
        const chat = (meeting?.chats || []).find((c) => String(c.at) === button.dataset.at);
        if (!chat?.answer) return;
        await Earshot.copyFormatted(chat.answer);
        toast("Answer copied");
        break;
      }
      case "copy": {
        const full = await fullMeeting();
        if (!full?.segments.length) return toast("Nothing captured yet");
        const text = Earshot.paragraphs(full.segments)
          .map((p) => `${p.speaker} [${Earshot.elapsed(full.startedAt, p.startedAt)}]: ${p.text}`)
          .join("\n\n");
        await navigator.clipboard.writeText(text);
        toast("Transcript copied");
        break;
      }
      case "screenshot":
        await takeScreenshot();
        break;
      case "export-md":
      case "export-html":
      case "export-json": {
        const full = await fullMeeting(action !== "export-md");
        if (!full?.segments.length && !full?.screenshots?.length) return toast("Nothing captured yet");
        if (action === "export-md") download(Earshot.fileName(full, "md"), Earshot.toMarkdown(full), "text/markdown");
        else if (action === "export-html") download(Earshot.fileName(full, "html"), Earshot.toHtml(full), "text/html");
        else download(Earshot.fileName(full, "json"), JSON.stringify(full, null, 2), "application/json");
        break;
      }
      case "open-folder": {
        const res = await send({ kind: "helper", op: "open-folder", payload: { id: meeting?.id } });
        toast(res?.error ? "The Earshot helper isn't installed, so there's no folder yet." : "Opened in Finder");
        break;
      }
      case "hide-captions":
        prefs.hideAppCaptions = !prefs.hideAppCaptions;
        send({ kind: "set-setting", key: "hideAppCaptions", value: prefs.hideAppCaptions });
        applyAppCaptions();
        break;
      case "notify":
        await navigator.clipboard.writeText(NOTICE);
        toast("Copied. Paste it into the meeting chat.");
        break;
      case "debug":
        collectDiagnostics();
        break;
    }
  }

  function updatePauseButton() {
    const b = shadow?.querySelector('[data-act="pause"]');
    if (!b) return;
    b.innerHTML = paused ? ICONS.play : ICONS.pause;
    b.title = paused ? "Resume capture" : "Pause capture";
    b.classList.toggle("on", paused);
  }

  function setLanguage(id) {
    prefs.captionLanguage = id;
    send({ kind: "set-language", id });
    toast(`Switching captions to ${Earshot.languageById(id).name}…`);
  }

  function collectDiagnostics() {
    // Every hooked frame answers; collect them for a moment, then save one file.
    pendingDiagnostics = [];
    send({ kind: "panel-cmd", cmd: { type: "diagnostics" } });
    setTimeout(() => {
      const report = {
        createdAt: new Date().toISOString(),
        extensionVersion: chrome.runtime.getManifest().version,
        userAgent: navigator.userAgent,
        topUrl: location.href,
        platform,
        panelStatus: status,
        capturedSegments: segments.size,
        screenShareScan: describeShareScan(scanForShare()),
        frames: pendingDiagnostics,
      };
      pendingDiagnostics = null;
      download(`earshot-debug-${Date.now()}.json`, JSON.stringify(report, null, 2), "application/json");
    }, 1500);
  }

  // ---------------------------------------------------------------- screenshots of what's being presented

  const isDocked = () => document.documentElement.hasAttribute("data-earshot-docked");

  // Every visible video/canvas (including same-origin frames), scored for how
  // likely it is to be a screen share rather than someone's camera:
  //   +6 it matches where the app is known to put shares
  //   +4 it sits inside something labelled presentation / screen share
  //   +2 the app fits it whole (object-fit: contain), as apps do for shares;
  //   -3 cropped to fill a tile (cover), as apps do for cameras
  //   +1 it's the biggest thing on the stage; +1 it's wider than cameras send (1600px+)
  // Under 3 it isn't treated as a presentation on its own (see takeScreenshot).
  function scanForShare() {
    const found = [];
    const usableWidth = window.innerWidth - (isDocked() ? DOCK_SPACE : 0);
    const collect = (doc, offsetX, offsetY) => {
      const known = new Set();
      for (const sel of SHARE_SELECTORS[platform]) {
        try {
          doc.querySelectorAll(sel).forEach((el) => known.add(el));
        } catch {}
      }
      for (const el of doc.querySelectorAll("video, canvas")) {
        if (host && host.contains(el)) continue;
        const r = el.getBoundingClientRect();
        const rect = { left: r.left + offsetX, top: r.top + offsetY, width: r.width, height: r.height };
        const visW = Math.min(rect.left + rect.width, usableWidth) - Math.max(rect.left, 0);
        const visH = Math.min(rect.top + rect.height, window.innerHeight) - Math.max(rect.top, 0);
        const style = el.ownerDocument.defaultView.getComputedStyle(el);
        if (visW < 200 || visH < 112 || style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) continue;
        let score = 0;
        const reasons = [];
        if (known.has(el)) (score += 6), reasons.push("known share spot");
        let node = el;
        for (let i = 0; i < 7 && node; i++, node = node.parentElement) {
          const label = [node.id, typeof node.className === "string" ? node.className : "", node.getAttribute?.("aria-label"), node.getAttribute?.("data-tid"), node.getAttribute?.("data-stream-type"), node.getAttribute?.("data-participant-id")].join(" ");
          if (SHARE_WORDS.test(label)) {
            score += 4;
            reasons.push("labelled as a share");
            break;
          }
        }
        if (style.objectFit === "contain" || style.objectFit === "scale-down") (score += 2), reasons.push("fitted whole");
        if (style.objectFit === "cover") (score -= 3), reasons.push("cropped like a camera");
        if ((el.videoWidth || el.width) >= 1600) (score += 1), reasons.push("high resolution");
        found.push({ el, rect, area: visW * visH, score, reasons });
      }
      for (const frame of doc.querySelectorAll("iframe")) {
        try {
          const inner = frame.contentDocument;
          if (!inner) continue;
          const fr = frame.getBoundingClientRect();
          collect(inner, offsetX + fr.left, offsetY + fr.top);
        } catch {}
      }
    };
    collect(document, 0, 0);
    const biggest = found.reduce((max, c) => (c.area > (max?.area || 0) ? c : max), null);
    if (biggest) {
      biggest.score += 1;
      biggest.reasons.push("biggest on stage");
    }
    lastShareScan = found.sort((a, b) => b.score - a.score || b.area - a.area);
    return lastShareScan;
  }

  const describeShareScan = (list) =>
    list.map((c) => ({ tag: c.el.tagName.toLowerCase(), score: c.score, reasons: c.reasons, shown: `${Math.round(c.rect.width)}x${Math.round(c.rect.height)}`, native: `${c.el.videoWidth || c.el.width}x${c.el.videoHeight || c.el.height}` }));

  // A frame that came out empty (unreadable WebGL canvas, black video) isn't worth keeping.
  function looksBlank(source, w, h) {
    const probe = document.createElement("canvas");
    probe.width = 24;
    probe.height = 24;
    const ctx = probe.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(source, 0, 0, w, h, 0, 0, 24, 24);
    const px = ctx.getImageData(0, 0, 24, 24).data;
    let min = 255;
    let max = 0;
    let alpha = 0;
    for (let i = 0; i < px.length; i += 4) {
      const lum = (px[i] + px[i + 1] + px[i + 2]) / 3;
      min = Math.min(min, lum);
      max = Math.max(max, lum);
      alpha += px[i + 3];
    }
    return alpha === 0 || max - min < 4;
  }

  function encodeFrame(source, w, h) {
    const scale = Math.min(1, 2560 / w);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    canvas.getContext("2d").drawImage(source, 0, 0, canvas.width, canvas.height);
    return { dataUrl: canvas.toDataURL("image/jpeg", 0.88), width: canvas.width, height: canvas.height };
  }

  function grabElement({ el }) {
    try {
      if (el.tagName === "VIDEO" && el.videoWidth && el.readyState >= 2 && !looksBlank(el, el.videoWidth, el.videoHeight))
        return { ...encodeFrame(el, el.videoWidth, el.videoHeight), source: "video" };
      if (el.tagName === "CANVAS" && el.width && el.height && !looksBlank(el, el.width, el.height))
        return { ...encodeFrame(el, el.width, el.height), source: "canvas" };
    } catch {
      // Tainted or unreadable; fall back to cropping a capture of the tab.
    }
    return null;
  }

  // Capture what's on screen and keep only `rect` (page CSS pixels).
  async function grabTabArea(rect) {
    host.style.visibility = "hidden";
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const res = await send({ kind: "capture-tab" });
    host.style.visibility = "";
    if (!res?.dataUrl) return null;
    const img = new Image();
    img.src = res.dataUrl;
    await img.decode();
    const scale = img.width / window.innerWidth;
    const sx = Math.max(0, rect.left * scale);
    const sy = Math.max(0, rect.top * scale);
    const sw = Math.min(img.width - sx, rect.width * scale);
    const sh = Math.min(img.height - sy, rect.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(sw);
    canvas.height = Math.round(sh);
    canvas.getContext("2d").drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    return { dataUrl: canvas.toDataURL("image/jpeg", 0.88), width: canvas.width, height: canvas.height, source: "tab-crop" };
  }

  // The app announcing a share in words, as Teams does ("You are viewing
  // Robin Hayes's screen"), even when its share surface carries no label.
  const SHARE_BANNER = /you(?:'re| are) viewing .{1,80}?(?:screen|window|presentation)|is (?:presenting|sharing)(?: (?:their|a|the) (?:screen|window|presentation))?/i;
  function shareAnnounced() {
    const text = (document.body?.innerText || "").slice(0, 50000);
    return SHARE_BANNER.test(text);
  }

  // The meeting's part of the window: everything left of a docked panel.
  const stageRect = () => ({ left: 0, top: 0, width: window.innerWidth - (isDocked() ? DOCK_SPACE : 0), height: window.innerHeight });

  // What the button saves, best first:
  //  1. what's being presented, when it can be told apart from the cameras;
  //  2. when the app says someone is sharing but doesn't label it (Teams),
  //     the biggest picture on the stage that isn't a cropped camera tile;
  //  3. otherwise the whole meeting screen, left of the panel.
  async function takeScreenshot() {
    try {
      let shot = null;
      let what = "the presentation";
      if (mac) {
        // The Mac app captures the call's window; there's no page here to scan or crop.
        const res = await send({ kind: "capture-tab" });
        if (res?.dataUrl) shot = { dataUrl: res.dataUrl, width: res.width, height: res.height, source: "meeting-view" };
        what = "the meeting screen";
      } else {
        const scan = scanForShare();
        let share = scan.find((c) => c.score >= 3);
        if (!share && shareAnnounced()) share = scan.filter((c) => !c.reasons.includes("cropped like a camera")).sort((a, b) => b.area - a.area)[0];
        shot = share ? grabElement(share) || (await grabTabArea(share.rect)) : null;
      }
      if (!shot && !mac) {
        shot = await grabTabArea(stageRect());
        if (shot) shot.source = "meeting-view";
        what = "the meeting screen";
      }
      if (!shot) return toast("Couldn't capture the screen");
      const res = await send({ kind: "add-screenshot", ...shot, at: Date.now() });
      if (!res?.ok) return toast(res?.reason === "no-meeting" ? "Screenshots start once the meeting is detected" : "Couldn't save the screenshot");
      shotCache.set(res.shot.id, shot.dataUrl);
      toast(`Saved ${what} (${shot.width}×${shot.height})`);
    } catch (err) {
      toast("Couldn't capture the screen");
      console.warn("Earshot screenshot failed", err);
    }
  }

  // ---------------------------------------------------------------- rendering

  function queueRender() {
    if (renderQueued || !shadow) return;
    renderQueued = true;
    setTimeout(() => {
      renderQueued = false;
      render();
    }, 150);
  }

  function currentMeeting() {
    const segs = [...segments.values()].sort((a, b) => a.startedAt - b.startedAt);
    return { ...(meeting || {}), startedAt: meeting?.startedAt || new Date(segs[0]?.startedAt || Date.now()).toISOString(), segments: segs, screenshots: meeting?.screenshots || [] };
  }

  function render() {
    if (!shadow || editing) return;
    const m = currentMeeting();
    colorFor = Earshot.speakerPalette(m);
    const shown = cutOff
      ? { level: "problem", text: "Earshot was reloaded. Reload this tab to keep capturing." }
      : captionsOff
        ? { level: "problem", text: offCause?.text || "No captions: the host may have them off" }
        : status;
    shadow.querySelectorAll(".logo").forEach((l) => (l.className = `logo dot ${shown.level}`));
    $(".status").textContent = shown.text;
    // The warning bar gives the reason: the hook's own finding (status.health,
    // raised at any point in the call), or why the wait for captions ran out.
    const warning = cutOff ? null : captionsOff ? offCause || {} : status.health ? status : null;
    $(".capwarn").classList.toggle("hidden", !warning);
    $(".capwarn span").textContent = warning?.hint || NO_CAPTIONS_HINT;
    $(".capwarn button").classList.toggle("hidden", warning?.retry === false);
    $(".meta").textContent = meeting ? Earshot.titleOf(meeting) : "Earshot";
    renderChips();
    renderSuggestion();
    const lang = Earshot.languageFromPlatform(meeting?.platform || platform, meeting?.captionLanguage) || Earshot.languageById(prefs.captionLanguage);
    $(".langbtn").title = `Caption language: ${lang.name}`;
    if (shadow.activeElement !== $(".langpick")) $(".langpick").value = lang.id;
    renderAiWarning();
    updatePauseButton();
    if (shadow.activeElement !== $(".notes-text") && !notesDirty && typeof meeting?.notes === "string" && $(".notes-text").value !== meeting.notes) $(".notes-text").value = meeting.notes;
    // Rebuilding the list would wipe text the reader has selected (to copy, say),
    // so it waits until the selection is gone.
    const list = tab === "transcript" ? $(".body") : $(".chat");
    if (selectingIn(list)) renderDeferred = true;
    else if (tab === "transcript") renderTranscript(m);
    else renderChat();
  }

  function selectingIn(el) {
    const sel = selection();
    return !!sel && !sel.isCollapsed && sel.rangeCount > 0 && el.contains(sel.getRangeAt(0).commonAncestorContainer);
  }

  function renderAiWarning() {
    const bad = aiHealth && !aiHealth.ok;
    $(".aiwarn").classList.toggle("hidden", !bad);
    if (!bad) return;
    const text = $(".aiwarn-text");
    text.textContent = `${aiHealth.problem} `;
    if (aiHealth.fix) {
      const code = document.createElement("code");
      code.textContent = aiHealth.fix;
      text.append("Fix: ", code);
    }
  }

  function renderChips() {
    const chips = $(".chips");
    chips.replaceChildren(
      ...(meeting?.tags || []).map((t) => {
        const c = document.createElement("span");
        c.className = "chip";
        c.textContent = t;
        return c;
      })
    );
    const add = document.createElement("span");
    add.className = "chip add";
    add.textContent = meeting?.tags?.length ? "Edit" : "+ Tag";
    add.title = "Tag this meeting";
    chips.appendChild(add);
  }

  // A company for an untitled call, from who's on it (the Mac app looks it up).
  function renderSuggestion() {
    const s = meeting?.tagSuggestion;
    const show = !!s?.tag && !(meeting.tags || []).length;
    $(".suggest").classList.toggle("hidden", !show);
    if (show) $(".suggest-text").textContent = s.person ? `${s.tag}? (from ${s.person})` : `${s.tag}?`;
  }

  // Blocks: one per caption segment, with long ones split at sentence ends;
  // the speaker's name only where the speaker changes or after a long pause.
  function renderTranscript(m) {
    const frag = document.createDocumentFragment();
    let shown = 0;
    let lastSpeaker = null;
    let lastEnd = 0;
    let turn = null; // the paragraph a speaker's lines flow into
    const items = [...m.segments.map((s) => ({ kind: "seg", at: s.startedAt, s })), ...m.screenshots.map((shot) => ({ kind: "shot", at: shot.at, shot }))].sort((a, b) => a.at - b.at);
    for (const item of items) {
      if (item.kind === "shot") {
        if (!query) frag.appendChild(renderShot(m, item.shot));
        turn = null;
        continue;
      }
      const s = item.s;
      if (query && !`${s.speaker} ${s.text}`.toLowerCase().includes(query)) continue;
      shown += 1;
      if (s.speakerId !== lastSpeaker || s.startedAt - lastEnd > BLOCK_GAP_MS * 4) {
        const who = document.createElement("div");
        who.className = "who";
        who.style.color = colorFor(s.speakerId);
        const name = document.createElement("span");
        name.className = "name";
        name.dataset.speaker = s.speakerId;
        name.title = "Click to rename this speaker";
        name.textContent = s.speaker;
        const when = document.createElement("span");
        when.className = "when";
        when.textContent = Earshot.elapsed(m.startedAt, s.startedAt);
        who.append(name, when);
        frag.appendChild(who);
        turn = null;
      }
      if (!turn) {
        turn = document.createElement("div");
        turn.className = "turn";
        frag.appendChild(turn);
      } else turn.appendChild(document.createTextNode(" "));
      lastSpeaker = s.speakerId;
      lastEnd = s.lastAt || s.startedAt;
      const block = document.createElement("span");
      block.className = `block${s.edited ? " edited" : ""}`;
      block.dataset.id = s.id;
      block.title = "Click to fix this text";
      const tag = Earshot.tagOf(s.reaction);
      block.appendChild(document.createTextNode(s.text));
      if (tag) {
        const badge = document.createElement("span");
        badge.className = "badge";
        badge.contentEditable = "false";
        badge.textContent = `#${tag.tag}`;
        block.appendChild(badge);
      }
      const reacts = document.createElement("span");
      reacts.className = `reacts${s.id === openReacts ? " open" : ""}`;
      reacts.contentEditable = "false";
      const opener = document.createElement("button");
      opener.className = "tagopen";
      opener.title = "Tag this line for your notes and the vault agent";
      opener.textContent = "#";
      reacts.appendChild(opener);
      for (const t of Earshot.TAGS) {
        const b = document.createElement("button");
        b.dataset.reaction = t.id;
        b.title = `Add to your notes with #${t.tag}`;
        b.textContent = t.label;
        if (tag?.id === t.id) b.classList.add("on");
        reacts.appendChild(b);
      }
      block.appendChild(reacts);
      turn.appendChild(block);
    }
    if (!shown && !m.screenshots.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = query ? "No lines match your search." : "Start talking during the meeting to see the transcript here.";
      frag.appendChild(empty);
    }
    $(".body").replaceChildren(frag);
    if (followLatest && !query) $(".body").scrollTop = $(".body").scrollHeight;
  }

  function renderShot(m, shot) {
    const wrap = document.createElement("div");
    wrap.className = "shot";
    const img = document.createElement("img");
    img.alt = "Screenshot";
    const cached = shotCache.get(shot.id);
    if (cached) img.src = cached;
    else
      send({ kind: "get-screenshot", id: shot.id }).then((res) => {
        if (res?.dataUrl) {
          shotCache.set(shot.id, res.dataUrl);
          img.src = res.dataUrl;
        }
      });
    const cap = document.createElement("div");
    cap.className = "cap";
    cap.innerHTML = `<span>${shot.source === "meeting-view" ? "Meeting screen" : "Presentation"} at ${Earshot.elapsed(m.startedAt, shot.at)}</span><button data-act="delete-shot" data-id="${shot.id}">Remove</button>`;
    wrap.append(img, cap);
    return wrap;
  }

  // render() calls this on every meeting update (each caption line, mid-call), so
  // it keeps the reader's place unless asked to move: to the bottom when a question
  // is sent, and to the top of the new answer when it arrives.
  function renderChat({ scroll } = {}) {
    if (!shadow) return;
    const chat = $(".chat");
    const kept = chat.scrollTop;
    const chats = meeting?.chats || [];
    const frag = document.createDocumentFragment();
    if (!chats.length && !asking) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "Ask anything about the meeting so far: what was decided, who owns what, numbers you missed. Answers come from your AI CLI and are saved with this meeting.";
      frag.appendChild(empty);
    }
    for (const c of chats) {
      const q = document.createElement("div");
      q.className = "q";
      q.textContent = c.question;
      const a = document.createElement("div");
      a.className = `a${c.error ? " err" : " md"}`;
      if (c.error) a.textContent = c.error;
      else a.innerHTML = Earshot.markdownToHtml(c.answer || "");
      const meta = document.createElement("span");
      meta.className = "meta2";
      meta.textContent = `${new Date(c.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}${c.model ? ` · ${c.model}` : ""}${c.ms ? ` · ${(c.ms / 1000).toFixed(1)}s` : ""}`;
      if (c.answer) {
        const copy = document.createElement("button");
        copy.dataset.act = "copy-answer";
        copy.dataset.at = String(c.at);
        copy.title = "Copy, formatted for Word and Teams";
        copy.textContent = "Copy";
        meta.appendChild(copy);
      }
      a.appendChild(meta);
      frag.append(q, a);
    }
    if (asking) {
      const q = document.createElement("div");
      q.className = "q";
      q.textContent = asking;
      const a = document.createElement("div");
      a.className = "a";
      a.textContent = "Thinking…";
      frag.append(q, a);
    }
    chat.replaceChildren(frag);
    const lastQ = [...chat.querySelectorAll(".q")].pop();
    chat.scrollTop = scroll === "bottom" ? chat.scrollHeight : kept;
    if (scroll === "last-question" && lastQ) chat.scrollTop += lastQ.getBoundingClientRect().top - chat.getBoundingClientRect().top;
  }

  // ---------------------------------------------------------------- messages from the background worker

  function adoptMeeting(next) {
    // A new call in the same tab (Teams) starts with an empty panel.
    if (meeting && meeting.id !== next.id) {
      segments.clear();
      shotCache.clear();
    }
    meeting = { ...(meeting && meeting.id === next.id ? meeting : {}), ...next };
    if (Array.isArray(next.segments)) {
      segments.clear();
      for (const s of next.segments) segments.set(s.id, s);
    }
    delete meeting.segments;
  }

  // Settings arrive with panel-hello. A meeting can be detected before that answer, so the
  // first open is laid out again once they're in, or "Open the panel" would be ignored.
  let settingsLoaded = false;
  let joinLayoutPending = false;
  function openForMeeting() {
    const first = !shadow;
    mount();
    if (first) {
      collapsed = !prefs.panelOpenOnJoin;
      joinLayoutPending = !settingsLoaded;
      applyLayout();
    }
  }

  // Keyboard shortcuts, set in chrome://extensions/shortcuts.
  function runCommand(command) {
    if (!shadow) return;
    if (command === "take-screenshot") return takeScreenshot();
    if (command === "toggle-panel") {
      collapsed = !collapsed;
      return applyLayout();
    }
    if (command === "focus-notes") {
      collapsed = false;
      applyLayout();
      showTab("transcript");
      $(".notes-text").focus();
    }
  }

  chrome.runtime.onMessage.addListener((req) => {
    if (req.kind !== "overlay") return;
    if (req.type === "diagnostics") {
      if (pendingDiagnostics) pendingDiagnostics.push({ frameUrl: req.frameUrl, ...req.data });
      return;
    }
    if (req.type === "toast") return toast(req.text);
    if (req.type === "command") return runCommand(req.command);
    // The Mac app's menu paused or resumed the capture.
    if (req.type === "paused") {
      paused = !!req.paused;
      updatePauseButton();
      return queueRender();
    }
    if (req.type === "ai-health") {
      aiHealth = req.health;
      return queueRender();
    }
    if (req.type === "ended") {
      if (req.meeting) adoptMeeting(req.meeting);
      status = { level: "ended", text: "Meeting ended · transcript saved" };
      queueRender();
      clearTimeout(endedTimer);
      // Panel and launcher both go away; nothing of Earshot stays on the page.
      // Before settings are in, "collapsed" is only a guess: wait as for an open panel.
      endedTimer = setTimeout(unmount, shadow && (!collapsed || joinLayoutPending) ? ENDED_CLOSE_MS : 0);
      return;
    }
    // Edits made elsewhere (meetings page) refresh an open panel but never reopen a closed one.
    if (req.type === "meeting-full" && (!shadow || status.level === "ended") && req.meeting?.endedAt) {
      adoptMeeting(req.meeting);
      return queueRender();
    }
    // A meeting that's live again (rejoin, next Teams call) cancels the pending close.
    if (req.meeting && !req.meeting.endedAt) clearTimeout(endedTimer);
    if (status.level === "ended" && !(req.meeting && !req.meeting.endedAt)) return;
    openForMeeting();
    if (req.type === "status") status = req.status;
    // New lines mean the meeting is going, whatever was last said about it.
    else if (status.level === "ended" || (req.type === "segments" && status.level !== "live" && status.level !== "paused")) status = { level: "live", text: "Capturing" };
    if (req.meeting) adoptMeeting(req.meeting);
    const firstLines = req.type === "segments" && req.segments?.length && !paused && meeting && (captionsOff || (confirmedFor !== meeting.id && segments.size === 0));
    const wasOff = captionsOff;
    if (req.type === "segments") for (const s of req.segments) segments.set(s.id, s);
    watchCaptions();
    if (firstLines) confirmCapturing(wasOff ? "Captions are back. Capturing." : "Capturing: the first lines are in.");
    queueRender();
  });

  // Earshot asks the meeting app to turn captions on, but a host can have them
  // switched off, and then nothing arrives and nothing says why. Waiting too long
  // turns the panel red and sends one notification; captions arriving clear it.
  function watchCaptions() {
    if (status.level !== "waiting") {
      waitingSince = null;
      captionsOff = false;
      offCause = null;
    } else waitingSince ??= Date.now();
  }
  setInterval(() => {
    if (mac || !shadow || !waitingSince || captionsOff || paused) return;
    if (Date.now() - waitingSince < (prefs.captionsOffSeconds ?? 60) * 1000) return;
    captionsOff = true;
    offCause = null;
    send({ kind: "captions-off" }).then((cause) => {
      if (!captionsOff || !cause?.hint) return;
      offCause = cause;
      queueRender();
    });
    queueRender();
  }, 2000);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.tags) prefs.tags = changes.tags.newValue || [];
    if (area === "local" && changes.launcherPos && shadow) placeLauncher(changes.launcherPos.newValue);
  });

  async function start() {
    const res = await send({ kind: "panel-hello" });
    if (res?.settings) prefs = { ...prefs, ...res.settings };
    settingsLoaded = true;
    if (joinLayoutPending && shadow) {
      joinLayoutPending = false;
      collapsed = !prefs.panelOpenOnJoin;
      applyLayout();
    }
    paused = !!res?.paused;
    if (res?.status) status = res.status;
    watchCaptions();
    if (res?.meeting) adoptMeeting(res.meeting);
    // Mid-meeting reload: show again at once. Otherwise wait for a meeting to be detected.
    if (res?.meeting && !res.meeting.endedAt) openForMeeting();
    queueRender();
  }

  window.addEventListener("pagehide", undock);
  document.addEventListener("selectionchange", () => {
    placeSelectionCopy();
    if (!renderDeferred || !shadow) return;
    if (selectingIn($(".body")) || selectingIn($(".chat"))) return;
    renderDeferred = false;
    queueRender();
  });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
