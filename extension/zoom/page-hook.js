// Runs inside Zoom's own page (MAIN world), in every zoom.us frame.
//
// The Zoom web client keeps live-transcription captions in its Redux store,
// already tagged with each speaker's Zoom ID and display name, whether or not
// captions are shown on screen. This script finds that store, watches it, and
// hands captions, roster and meeting info to the extension's bridge script
// through DOM events. The only thing it ever sends to Zoom is the optional
// "turn captions on" request, over Zoom's own existing socket.
(() => {
  if (window.__earshotZoomHook) return;
  window.__earshotZoomHook = true;

  // Sent with every event (Earshot.HOOK_VERSION): a copy left running by an
  // older Earshot is told apart by it.
  const HOOK = 3;

  const OUT = "earshot:page";
  const IN = "earshot:cmd";
  const SCAN_EVERY_MS = 1000;
  const GIVE_UP_AFTER_MS = 10 * 60 * 1000;
  const ROSTER_EVERY_MS = 2000;

  const log = [];
  function note(message, extra) {
    log.push({ at: new Date().toISOString(), message, extra });
    if (log.length > 200) log.shift();
  }

  // The meeting number is in the web client's URL: /wc/<number>/join.
  const meetingRef = /\/wc\/(\d+)/.exec(location.pathname)?.[1] || null;

  function emit(type, data = {}) {
    try {
      // Strings cross the page/extension boundary reliably; objects may not.
      document.documentElement.dispatchEvent(
        new CustomEvent(OUT, { detail: JSON.stringify({ type, platform: "zoom", hook: HOOK, ref: meetingRef, ...data }) })
      );
    } catch (err) {
      note("emit failed", String(err));
    }
  }

  // ---------------------------------------------------------------- store discovery

  let store = null;
  let foundVia = null;

  const isStore = (x) =>
    !!x &&
    typeof x === "object" &&
    typeof x.getState === "function" &&
    typeof x.subscribe === "function" &&
    typeof x.dispatch === "function";

  function stateOf(s) {
    try {
      const st = s.getState();
      return st && typeof st === "object" ? st : null;
    } catch {
      return null;
    }
  }

  // The meeting store is the one with Zoom's live-transcription slice. Accept a
  // store that only has the meeting slices too, so diagnostics can show what
  // changed if Zoom ever renames the captions slice.
  function looksLikeZoomMeeting(s) {
    const st = stateOf(s);
    return !!st && ("newLiveTranscription" in st || ("meeting" in st && "attendeesList" in st));
  }

  function consider(candidate, via) {
    if (store || !isStore(candidate) || !looksLikeZoomMeeting(candidate)) return false;
    adopt(candidate, via);
    return true;
  }

  // Route 1: wrap the global Redux / Redux Toolkit library before Zoom creates
  // its store. UMD bundles assign `window.Redux = {}` and fill it in right
  // after, so wrap on the next microtask.
  const wrappedLibs = new WeakSet();
  function wrapLib(lib) {
    if (!lib || (typeof lib !== "object" && typeof lib !== "function") || wrappedLibs.has(lib)) return;
    wrappedLibs.add(lib);
    for (const name of ["createStore", "legacy_createStore", "configureStore"]) {
      const original = lib[name];
      if (typeof original !== "function") continue;
      try {
        lib[name] = function (...args) {
          const created = original.apply(this, args);
          try {
            consider(created, `redux-global.${name}`);
          } catch (err) {
            note("consider failed", String(err));
          }
          return created;
        };
      } catch (err) {
        note(`could not wrap Redux.${name}`, String(err));
      }
    }
  }

  for (const globalName of ["Redux", "RTK"]) {
    if (window[globalName]) {
      wrapLib(window[globalName]);
      continue;
    }
    let value;
    try {
      Object.defineProperty(window, globalName, {
        configurable: true,
        enumerable: true,
        get: () => value,
        set: (v) => {
          value = v;
          queueMicrotask(() => wrapLib(v));
        },
      });
    } catch (err) {
      note(`could not watch window.${globalName}`, String(err));
    }
  }

  // Route 2: find the store on the React tree (the <Provider store=...> props).
  function reactRootsIn(doc) {
    const roots = [];
    if (!doc.body) return roots;
    const els = doc.body.querySelectorAll(":scope > *, :scope > * > *, :scope > * > * > *");
    for (const el of els) {
      for (const key of Object.keys(el)) {
        if (key.startsWith("__reactContainer")) roots.push(el[key]);
        else if (key === "_reactRootContainer") {
          const r = el[key];
          const current = r?._internalRoot?.current || r?.current;
          if (current) roots.push(current);
        }
      }
    }
    return roots;
  }

  function findStoreOnReactTree() {
    for (const root of reactRootsIn(document)) {
      const stack = [root];
      let visited = 0;
      while (stack.length && visited < 20000) {
        const fiber = stack.pop();
        visited += 1;
        if (!fiber) continue;
        const candidate = fiber.memoizedProps?.store;
        if (isStore(candidate) && looksLikeZoomMeeting(candidate)) return candidate;
        if (fiber.sibling) stack.push(fiber.sibling);
        if (fiber.child) stack.push(fiber.child);
      }
    }
    return null;
  }

  const startedAt = Date.now();
  const scanTimer = setInterval(() => {
    if (store) return clearInterval(scanTimer);
    if (Date.now() - startedAt > GIVE_UP_AFTER_MS) {
      note("gave up looking for the Zoom store");
      return clearInterval(scanTimer);
    }
    try {
      const found = findStoreOnReactTree();
      if (found) consider(found, "react-tree");
    } catch (err) {
      note("react tree scan failed", String(err));
    }
  }, SCAN_EVERY_MS);

  // ---------------------------------------------------------------- watching the store

  let scanQueued = false;
  let lastJoinStatus;
  let leftReported = false;
  let lastTopic;
  let lastLanguage;
  let lastRoster = null;
  let lastRosterEmit = 0;
  let rosterTimer = null;
  const sentText = new Map(); // caption id -> last text sent

  function adopt(found, via) {
    store = found;
    foundVia = via;
    const st = stateOf(found) || {};
    note("adopted store", via);
    emit("store-found", {
      via,
      hasCaptions: "newLiveTranscription" in st,
      stateKeys: Object.keys(st).slice(0, 100),
      href: location.href,
    });
    found.subscribe(queueScan);
    scan();
    reportHealth();
  }

  // ---------------------------------------------------------------- health

  // How capture is going, sent when the store is found, on joining and every
  // 15 s while in the meeting, so the panel can say what is wrong instead of
  // looking live.
  const HEALTH_EVERY_MS = 15000;
  let captionsAccepted = 0;
  let reportedAccepted = 0;
  let lastCaptionAt = 0;
  let joinedAt = 0;

  function reportHealth() {
    if (!store) return;
    const now = Date.now();
    const recent = { accepted: captionsAccepted - reportedAccepted, rejected: 0, control: 0 };
    reportedAccepted = captionsAccepted;
    const quietSince = Math.max(lastCaptionAt, joinedAt);
    emit("health", {
      joined: lastJoinStatus === "joined",
      attached: "newLiveTranscription" in (stateOf(store) || {}),
      accepted: captionsAccepted,
      rejected: 0,
      control: 0,
      recent,
      quietMs: quietSince ? now - quietSince : null,
    });
  }
  setInterval(() => {
    if (store && lastJoinStatus === "joined") reportHealth();
  }, HEALTH_EVERY_MS);

  // Zoom dispatches many actions per second; look at the state at most every 150ms.
  function queueScan() {
    if (scanQueued) return;
    scanQueued = true;
    setTimeout(() => {
      scanQueued = false;
      scan();
    }, 150);
  }

  function cleanText(raw) {
    if (typeof raw !== "string") return "";
    let t = raw;
    if (t.codePointAt(0) === 12) t = t.slice(1);
    return t.replace(/\u0000/g, "").replace(/�/g, "").trim();
  }

  function toCaption(key, msg) {
    const text = cleanText(msg.text ?? msg.message);
    if (!text) return null;
    const user = msg.user || {};
    const speakerId = String(user.zoomID ?? user.userId ?? msg.userId ?? "unknown");
    return {
      id: `${msg.msgId ?? key}/${speakerId}`,
      speakerId,
      speaker: user.displayName ?? msg.displayName ?? "Unknown speaker",
      speakerResolved: !!(user.displayName ?? msg.displayName),
      text,
      language: msg.language ?? null,
      at: Date.now(),
    };
  }

  function scan() {
    const st = store && stateOf(store);
    if (!st) return;

    const meeting = st.meeting || {};
    // After a detected leave, a stale "joined" doesn't count; a real rejoin
    // passes through "connecting" first, which clears the leave.
    if (leftReported && meeting.meetingJoinStatus !== "joined") leftReported = false;
    if (meeting.meetingJoinStatus !== lastJoinStatus && !(leftReported && meeting.meetingJoinStatus === "joined")) {
      lastJoinStatus = meeting.meetingJoinStatus;
      emit("join-status", { status: lastJoinStatus ?? null });
      if (lastJoinStatus === "joined") {
        joinedAt = Date.now();
        reportHealth();
      }
    }
    if (meeting.meetingTopic && meeting.meetingTopic !== lastTopic) {
      lastTopic = meeting.meetingTopic;
      emit("title", { title: lastTopic });
    }

    const lt = st.newLiveTranscription;
    if (lt && lt.selectedTranscriptionLanguage !== lastLanguage) {
      lastLanguage = lt.selectedTranscriptionLanguage;
      emit("caption-language", { language: lastLanguage ?? null });
    }

    // Each caption message keeps its msgId while Zoom revises its text, so
    // compare text rather than trusting object identity.
    const messages = lt?.newLTMessage;
    if (messages && typeof messages === "object") {
      const changed = [];
      for (const [key, msg] of Object.entries(messages)) {
        if (!msg || typeof msg !== "object") continue;
        const caption = toCaption(key, msg);
        if (!caption || sentText.get(caption.id) === caption.text) continue;
        sentText.set(caption.id, caption.text);
        changed.push(caption);
      }
      if (changed.length) {
        captionsAccepted += changed.length;
        lastCaptionAt = Date.now();
        emit("captions", { captions: changed });
      }
    }

    const roster = st.attendeesList?.attendeesList;
    if (Array.isArray(roster) && roster !== lastRoster) {
      lastRoster = roster;
      const wait = ROSTER_EVERY_MS - (Date.now() - lastRosterEmit);
      if (wait <= 0) emitRoster();
      else if (!rosterTimer) rosterTimer = setTimeout(emitRoster, wait);
    }
  }

  // Leaving doesn't always update the join status: the web client may tear
  // the meeting app down or move to its "you left" page instead. Check every
  // few seconds that the meeting is still mounted.
  setInterval(() => {
    if (!store || lastJoinStatus !== "joined") return;
    const onLeavePage = /\/(leave|end|post)/i.test(location.pathname);
    let mounted = true;
    try {
      mounted = findStoreOnReactTree() === store || foundVia?.startsWith("redux-global");
      if (foundVia?.startsWith("redux-global") && !document.querySelector("#root, .meeting-app, .meeting-client")) mounted = false;
    } catch {}
    if ((onLeavePage || !mounted) && !leftReported) {
      leftReported = true;
      lastJoinStatus = "left";
      note("meeting no longer on screen", { onLeavePage, mounted });
      emit("join-status", { status: "left" });
    }
  }, 3000);

  function emitRoster() {
    rosterTimer = null;
    lastRosterEmit = Date.now();
    const people = (lastRoster || []).slice(0, 1000).map((a) => ({
      id: a.userId ?? a.zoomID ?? null,
      zoomId: a.zoomID ?? null,
      name: a.displayName ?? "",
      isHost: !!a.isHost,
    }));
    emit("roster", { people });
  }

  // ---------------------------------------------------------------- turning captions on

  // Zoom's web client talks to its meeting server over a socket of JSON
  // messages. Requesting live transcription (4285) and then choosing the
  // spoken language (4305, type 6) is what the CC button does.
  function sendToZoom(message) {
    const socket = window.WCSockets?.instance?.RWG?.socket;
    if (socket && typeof socket.send === "function" && (socket.readyState === undefined || socket.readyState === 1)) {
      socket.send(JSON.stringify(message));
      return true;
    }
    if (typeof window.sendSocketMessage === "function") {
      const thunk = window.sendSocketMessage(message);
      if (typeof thunk === "function") {
        thunk();
        return true;
      }
    }
    return false;
  }

  // Commands carry one of Earshot's language entries; Zoom wants its numeric id.
  const zoomLanguageId = (language) => (typeof language === "object" && language ? language.zoom : language) ?? 0;

  function setLanguage(language) {
    const ok = sendToZoom({ evt: 4305, body: { type: 6, lang: zoomLanguageId(language), nodeid: 0 } });
    emit("language-result", { ok });
  }

  async function enableCaptions({ language: requested, delayMs = 5000 } = {}) {
    const language = zoomLanguageId(requested);
    const began = Date.now();
    while (!sendToZoom({ evt: 4285 })) {
      if (Date.now() - began > 60000) {
        note("no Zoom socket to request captions on");
        emit("captions-request", { ok: false, reason: "no-socket" });
        return;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    await new Promise((r) => setTimeout(r, delayMs));
    const ok = sendToZoom({ evt: 4305, body: { type: 6, lang: language, nodeid: 0 } });
    note("requested captions", { language, ok });
    emit("captions-request", { ok, language, waitedMs: Date.now() - began });
  }

  // ---------------------------------------------------------------- diagnostics

  function shapeOf(value, depth = 2) {
    if (value === null || value === undefined) return value;
    if (Array.isArray(value)) return value.length ? [`array(${value.length})`, depth > 0 ? shapeOf(value[0], depth - 1) : "…"] : "array(0)";
    if (typeof value === "object") {
      if (depth <= 0) return `object(${Object.keys(value).length} keys)`;
      const out = {};
      for (const k of Object.keys(value).slice(0, 60)) out[k] = shapeOf(value[k], depth - 1);
      return out;
    }
    return typeof value;
  }

  function diagnostics() {
    const st = store ? stateOf(store) : null;
    const messages = st?.newLiveTranscription?.newLTMessage;
    const firstMessage = messages && typeof messages === "object" ? Object.values(messages)[0] : null;
    return {
      href: location.href,
      isTopFrame: window.top === window,
      hook: HOOK,
      storeFound: !!store,
      joinStatus: lastJoinStatus ?? null,
      captionsAccepted,
      lastCaptionAgoMs: lastCaptionAt ? Date.now() - lastCaptionAt : null,
      foundVia,
      hasReduxGlobal: !!window.Redux,
      hasRtkGlobal: !!window.RTK,
      hasZoomSocket: !!window.WCSockets?.instance?.RWG?.socket,
      hasSendSocketMessage: typeof window.sendSocketMessage === "function",
      reactRoots: reactRootsIn(document).length,
      stateKeys: st ? Object.keys(st) : null,
      meeting: shapeOf(st?.meeting, 1),
      liveTranscription: shapeOf(st?.newLiveTranscription, 2),
      sampleCaption: firstMessage ? shapeOf(firstMessage, 2) : null,
      rosterSample: shapeOf(st?.attendeesList?.attendeesList?.[0], 1),
      log,
    };
  }

  // ---------------------------------------------------------------- commands from the extension

  document.documentElement.addEventListener(IN, (event) => {
    let cmd;
    try {
      cmd = JSON.parse(event.detail);
    } catch {
      return;
    }
    if (cmd.type === "diagnostics") {
      emit("diagnostics", { data: diagnostics() });
      return;
    }
    // Only the frame that holds the meeting store acts on meeting commands.
    if (!store) return;
    if (cmd.type === "enable-captions") enableCaptions(cmd);
    else if (cmd.type === "set-language") setLanguage(cmd.language);
    else if (cmd.type === "resync") {
      // A bridge that arrived mid-meeting (Earshot reloaded) missed the join.
      emit("store-found", { via: foundVia, hasCaptions: "newLiveTranscription" in (stateOf(store) || {}), href: location.href });
      if (lastJoinStatus === "joined") emit("join-status", { status: "joined" });
      if (lastTopic) emit("title", { title: lastTopic });
      reportHealth();
    }
  });
})();
