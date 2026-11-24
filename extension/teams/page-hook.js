// Runs inside the Teams web app (MAIN world).
//
// Signed-in Teams ("V2") exposes its calling engine as `window.msteamscalling`.
// From the active call we can start captions, read the participant list, and
// wrap the handler that receives caption results. Each result carries the
// speaker's Teams ID (MRI), which maps to a display name.
//
// Anonymous guest joins ("light meetings", /light-meetings/...) don't expose
// that engine. There we listen to the call's "main-channel" WebRTC data
// channel for the same caption results, and to roster updates on Teams' own
// notification socket for names.
//
// Events go to the extension's bridge script through DOM events, the same way
// as the Zoom hook.
(() => {
  if (window.__earshotTeamsHook) return;
  window.__earshotTeamsHook = true;

  // Sent with every event (Earshot.HOOK_VERSION): a copy left running by an
  // older Earshot is told apart by it.
  const HOOK = 3;
  document.documentElement?.setAttribute("data-earshot-teams-hook", "4");

  // Teams' own timers, taken before its code runs, in case it wraps them later.
  const nativeSetTimeout = window.setTimeout.bind(window);

  const OUT = "earshot:page";
  const IN = "earshot:cmd";
  const TICK_MS = 1000;
  const ROSTER_EVERY_MS = 2000;
  const GONE_TICKS = 3; // a call missing this many ticks in a row has ended (holds and reconnects are shorter)
  const isLightMeeting = location.pathname.startsWith("/light-meetings/");

  const log = [];
  function note(message, extra) {
    log.push({ at: new Date().toISOString(), message, extra });
    if (log.length > 200) log.shift();
  }

  let meetingRef = null;
  function emit(type, data = {}) {
    try {
      document.documentElement.dispatchEvent(
        new CustomEvent(OUT, { detail: JSON.stringify({ type, platform: "teams", hook: HOOK, ref: meetingRef, ...data }) })
      );
    } catch (err) {
      note("emit failed", String(err));
    }
  }

  const tryOr = (fn, fallback) => {
    try {
      const v = fn();
      return v === undefined ? fallback : v;
    } catch {
      return fallback;
    }
  };

  // ---------------------------------------------------------------- captions, shared by both routes

  const sent = new Map(); // caption id -> { version, text }
  const rosterNames = new Map(); // MRI -> display name (light meetings)
  let useRawText = false; // honour the user's Teams profanity-filter setting

  function cleanText(raw) {
    return typeof raw === "string" ? raw.replace(/\u0000/g, "").replace(/�/g, "").trim() : "";
  }

  // Teams spells the same person two ways: captions say "8:orgid:<guid>", while your own identity
  // (and sometimes the roster) says "orgid:<guid>". Drop the leading number so they compare equal.
  const personId = (id) => (id == null || id === "" ? null : String(id).replace(/^\d+:(?=[a-z])/i, ""));

  // One caption is identified by when its audio was sent plus who spoke; Teams
  // revises it in place, bumping the version after the "/" in `id`.
  function toCaption(result, call) {
    const speakerId = personId(result.userId) ?? "unknown";
    const version = Number.parseInt(String(result.id ?? "").split("/")[1], 10) || 0;
    const id = `${result.timestampAudioSent ?? String(result.id ?? "").split("/")[0]}/${speakerId}`;
    const text = cleanText(useRawText && result.rawText ? result.rawText : result.text);
    if (!text) return null;
    const last = sent.get(id);
    if (last && (last.version > version || last.text === text)) return null;
    sent.set(id, { version, text });
    const who = nameFor(speakerId, call);
    return {
      id,
      speakerId,
      speaker: who.name,
      speakerResolved: who.resolved,
      text,
      language: result.spokenLanguage || result.trackLanguage || null,
      at: Date.now(),
    };
  }

  // Counted for the health report and Debug info. A caption-channel payload
  // without recognition results may be something else Teams sends there, so it
  // is counted as "other", never as a failure by itself.
  let captionsAccepted = 0;
  let otherPayloads = 0;
  let lastOtherKeys = null;
  let lastCaptionAt = 0;
  let joinedAt = 0;

  function emitResults(payload, call) {
    const parsed = typeof payload === "string" ? JSON.parse(payload) : payload;
    const results = parsed?.recognitionResults;
    if (!Array.isArray(results)) {
      otherPayloads += 1;
      lastOtherKeys = parsed && typeof parsed === "object" ? Object.keys(parsed).slice(0, 20) : typeof parsed;
      return;
    }
    const captions = results.map((r) => toCaption(r, call)).filter(Boolean);
    if (!captions.length) return;
    captionsAccepted += captions.length;
    lastCaptionAt = Date.now();
    emit("captions", { captions });
  }

  // ---------------------------------------------------------------- health

  // How capture is going, sent when a call is found and every 15 s after, so
  // the panel can say what is wrong instead of looking live. Driven from the
  // call check, not its own timer: Teams stops page timers (see keepChecking).
  const HEALTH_EVERY_MS = 15000;
  const reported = { accepted: 0, control: 0 };
  let lastHealthAt = 0;

  function reportHealth(joined, attached) {
    const now = Date.now();
    lastHealthAt = now;
    const recent = { accepted: captionsAccepted - reported.accepted, rejected: 0, control: otherPayloads - reported.control };
    Object.assign(reported, { accepted: captionsAccepted, control: otherPayloads });
    const quietSince = Math.max(lastCaptionAt, joinedAt);
    emit("health", { joined, attached, accepted: captionsAccepted, rejected: 0, control: otherPayloads, recent, quietMs: quietSince ? now - quietSince : null });
  }
  const healthDue = () => Date.now() - lastHealthAt >= HEALTH_EVERY_MS;

  // ---------------------------------------------------------------- signed-in Teams (V2)

  let call = null;
  let hooked = null; // { on, original }
  let lastRosterKey = "";
  let lastRosterAt = 0;
  let joinedSent = false;
  let goneTicks = 0;
  let captionsFailedSeen = false;

  const callingEngine = () => tryOr(() => window.msteamscalling?.deref?.() ?? null, null);

  // getActiveCall() is the first choice, but real Teams (2026-11, teams.cloud.microsoft) can answer
  // null while the registry holds the connected call, so the registry is always checked too.
  const CONNECTED = 3;
  const registryCalls = (service) => {
    const calls = tryOr(() => service.callRegistry.calls, null);
    return Array.isArray(calls) ? calls : calls && typeof calls === "object" ? Object.values(calls) : [];
  };
  function activeCall() {
    const service = callingEngine()?.callingService;
    const calls = registryCalls(service);
    if (!calls.length) return null;
    const viaApi = typeof service.getActiveCall === "function" ? tryOr(() => service.getActiveCall(), null) : null;
    if (viaApi?.state === CONNECTED) return viaApi;
    const connected = calls.filter((c) => c?.state === CONNECTED);
    if (!connected.length) return null;
    const info = tryOr(() => service.lastOrCurrentCallInfo, null);
    return connected.find((c) => info && c._callId === info.callId) || connected[0];
  }

  const participantsOf = (c) => {
    const list = tryOr(() => c.participants, []);
    return Array.isArray(list) ? list : list && typeof list === "object" ? Object.values(list) : [];
  };

  function selfOf(c) {
    const identity = tryOr(() => c.currentUserSkypeIdentity, null);
    const self = tryOr(() => c.getSelfParticipant().$$state.value, null);
    return {
      mri: personId(identity?.mri ?? identity?.id ?? self?.mri),
      name: identity?.displayName || self?.displayName || null,
    };
  }

  function nameFor(mri, c) {
    if (c) {
      const p = participantsOf(c).find((x) => personId(x?.mri) === mri);
      if (p?.displayName) return { name: p.displayName, resolved: true };
      const self = selfOf(c);
      if (self.mri && self.mri === mri && self.name) return { name: self.name, resolved: true };
      // The participant list leaves you out. Without your own ID to compare,
      // assume an unlisted speaker is you, but keep it correctable.
      if (!self.mri && self.name) return { name: self.name, resolved: false };
    }
    if (rosterNames.has(mri)) return { name: rosterNames.get(mri), resolved: true };
    return { name: `Participant ${mri.slice(-4)}`, resolved: false };
  }

  function emitRoster(c) {
    const people = participantsOf(c)
      .filter((p) => p?.mri)
      .map((p) => ({ id: personId(p.mri), name: p.displayName || "" }));
    const self = selfOf(c);
    if (self.mri && self.name) people.push({ id: self.mri, name: self.name, isSelf: true });
    const key = people.map((p) => `${p.id}=${p.name}`).join("|");
    if (key === lastRosterKey) return;
    lastRosterKey = key;
    lastRosterAt = Date.now();
    emit("roster", { people });
  }

  async function titleOf(c) {
    const conversation = tryOr(() => c.getCallingConversation?.(), null);
    if (conversation?.meetingInfo?.subject) return conversation.meetingInfo.subject;
    const unparsed = tryOr(() => JSON.parse(conversation.unParsedMeetingInfo).subject, null);
    if (unparsed) return unparsed;
    const withTimeout = (p) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), 3000))]);
    try {
      const asyncConv = c.getCallingConversationAsync ? await withTimeout(c.getCallingConversationAsync()) : null;
      const topic = asyncConv?.conversation?.threadProperties?.topic;
      if (topic) return topic;
    } catch {}
    try {
      const details = c.getMeetingDetails ? await withTimeout(c.getMeetingDetails()) : null;
      const subject = details?.meetingChatProperties && JSON.parse(details.meetingChatProperties).subject;
      if (subject) return subject;
    } catch {}
    return null;
  }

  // Captions arrive through a data-channel subscription named
  // "remoteUserEventsReceived"; channel "3" carries recognition results.
  function hookCaptions(c) {
    const subscriptions = tryOr(() => c.dataChannel.subscriptions, null);
    if (!Array.isArray(subscriptions)) return false;
    const on = subscriptions.map((s) => s?.eventHandler?.on).find((o) => o?.name === "remoteUserEventsReceived");
    if (!on || typeof on.handler !== "function") return false;
    if (on.handler.__earshot) return true;
    const original = on.handler;
    const wrapped = function (channel, payload) {
      try {
        if (String(channel) === "3") emitResults(payload, call);
      } catch (err) {
        note("caption parse failed", String(err));
      }
      return original.apply(this, arguments);
    };
    wrapped.__earshot = true;
    on.handler = wrapped;
    hooked = { on, original };
    note("hooked caption handler");
    return true;
  }

  // Teams can rebuild the call's subscriptions mid-call; then the wrapped handler is no longer the one called.
  function stillHooked(c) {
    if (!hooked) return false;
    const subscriptions = tryOr(() => c.dataChannel.subscriptions, null);
    if (!Array.isArray(subscriptions)) return false;
    const on = subscriptions.map((s) => s?.eventHandler?.on).find((o) => o?.name === "remoteUserEventsReceived");
    return on === hooked.on && !!on.handler?.__earshot;
  }

  function unhookCaptions() {
    if (hooked && hooked.on.handler.__earshot) hooked.on.handler = hooked.original;
    hooked = null;
  }

  function attach(c) {
    call = c;
    meetingRef = c._callId || `call-${Date.now()}`;
    joinedSent = false;
    goneTicks = 0;
    captionsFailedSeen = false;
    lastRosterKey = "";
    // Teams keeps one page across calls: the health counts are per call.
    captionsAccepted = otherPayloads = lastCaptionAt = joinedAt = 0;
    Object.assign(reported, { accepted: 0, control: 0 });
    useRawText = tryOr(() => {
      const raw = callingEngine().myUserPreferencesStore.getUserPreferences().callAccessibilitySettings;
      return (typeof raw === "string" ? JSON.parse(raw) : raw)?.profanityFilterEnabled === false;
    }, false);
    note("attached to call", meetingRef);
    emit("store-found", {
      via: "msteamscalling",
      hasCaptions: typeof c.startClosedCaption === "function",
      stateKeys: tryOr(() => Object.keys(c).slice(0, 100), []),
      href: location.href,
    });
    titleOf(c).then((title) => title && call === c && emit("title", { title }));
    reportHealth(false, false);
  }

  function detach() {
    note("call ended", meetingRef);
    unhookCaptions();
    emit("join-status", { status: "left" });
    call = null;
    sent.clear();
  }

  // The same call can come back as a different object, and a hold or reconnect leaves it
  // briefly not "connected": match by call id, and end only once it's been gone a few ticks.
  const sameCall = (a, b) => a === b || (!!a?._callId && a._callId === b?._callId);

  function tick() {
    const current = activeCall();
    if (call && current && !sameCall(call, current)) detach();
    else if (call && !current) {
      if (++goneTicks >= GONE_TICKS) detach();
      return;
    }
    if (call && current) {
      goneTicks = 0;
      if (call !== current) {
        note("call object replaced", meetingRef);
        call = current;
      }
    }
    if (!call && current) attach(current);
    if (!call) return;
    const justJoined = !joinedSent && tryOr(() => call.callGotConnected, true);
    if (justJoined) {
      joinedSent = true;
      joinedAt = Date.now();
      emit("join-status", { status: "joined" });
    }
    if (!stillHooked(call)) {
      if (hooked) note("caption handler replaced; hooking again");
      hooked = null;
      hookCaptions(call);
    }
    if (justJoined || healthDue()) reportHealth(joinedSent, !!hooked);
    watchCaptionsFailed();
    if (Date.now() - lastRosterAt >= ROSTER_EVERY_MS) emitRoster(call);
  }

  // The check runs every second. An error in it would otherwise vanish into Teams' own error
  // handler and stop the call ever being picked up, so it's caught, counted and kept for diagnostics.
  let ticks = 0;
  let tickErrors = 0;
  let lastTickError = null;
  function safeTick() {
    ticks++;
    try {
      tick();
    } catch (err) {
      tickErrors++;
      lastTickError = String((err && (err.stack || err.message)) || err).slice(0, 400);
      if (tickErrors === 1 || tickErrors % 60 === 0) note("check failed", lastTickError);
    }
  }

  // Teams shows a banner when it can't start captions; say so instead of waiting in silence.
  function watchCaptionsFailed() {
    if (captionsFailedSeen || !document.getElementById("ufd_title_ClosedCaptionsStartFailed")) return;
    captionsFailedSeen = true;
    note("Teams says captions failed to start");
    emit("captions-request", { ok: false, hint: "Teams couldn't start captions for this call. Try More → Language and speech → Show live captions." });
  }

  // A bridge that came in late (Earshot reloaded, or the event was missed) asks for the state again.
  function resync() {
    note("resync requested", meetingRef);
    if (!isLightMeeting) safeTick(); // pick up a call now, not on the next timer
    if (isLightMeeting) {
      if (!joinedSent) return;
      emit("store-found", { via: "guest-meeting", hasCaptions: true, href: location.href });
      emit("join-status", { status: "joined" });
      return reportHealth(true, guestChannelSeen);
    }
    if (!call) return;
    emit("store-found", { via: "msteamscalling", hasCaptions: typeof call.startClosedCaption === "function", href: location.href });
    if (joinedSent) emit("join-status", { status: "joined" });
    reportHealth(joinedSent, !!hooked);
    const c = call;
    titleOf(c).then((title) => title && call === c && emit("title", { title }));
  }

  function setLanguage(language) {
    const code = language?.teams;
    try {
      if (!call || !code || typeof call.setClosedCaptionsLanguage !== "function") throw new Error("not available");
      call.setClosedCaptionsLanguage(code);
      emit("caption-language", { language: code });
      emit("language-result", { ok: true });
    } catch (err) {
      note("set language failed", String(err));
      emit("language-result", { ok: false });
    }
  }

  async function startCaptions(cmd = {}) {
    if (isLightMeeting) return startCaptionsFromMenu();
    if (!call || typeof call.startClosedCaption !== "function") {
      emit("captions-request", { ok: false, hint: "Teams didn't offer captions for this call. Try More → Language and speech → Show live captions." });
      return;
    }
    try {
      if (!tryOr(() => call.closedCaptionsHaveBeenStarted(), false)) call.startClosedCaption();
      const began = Date.now();
      while (Date.now() - began < 20000) {
        if (document.getElementById("ufd_title_ClosedCaptionsStartFailed")) return watchCaptionsFailed();
        if (tryOr(() => call.closedCaptionsHaveBeenStarted() && call.getClosedCaptionStatus() === 2, false)) {
          hookCaptions(call);
          const current = tryOr(() => call.getClosedCaptionsLanguage(), null);
          if (cmd.language?.teams && String(current).toLowerCase() !== cmd.language.teams) setLanguage(cmd.language);
          else emit("caption-language", { language: current });
          emit("captions-request", { ok: true });
          return;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      emit("captions-request", { ok: false, hint: "Teams didn't confirm captions started. Turn on live captions in Teams (More → Language and speech)." });
    } catch (err) {
      note("startClosedCaption failed", String(err));
      emit("captions-request", { ok: false, hint: "Couldn't start Teams captions. Turn them on in Teams (More → Language and speech)." });
    }
  }

  // ---------------------------------------------------------------- guest joins (light meetings)

  async function startCaptionsFromMenu() {
    const more = document.getElementById("callingButtons-showMoreBtn");
    if (more) {
      more.click();
      await new Promise((r) => setTimeout(r, 500));
      const cc = document.getElementById("closed-captions-button");
      if (cc) {
        cc.click();
        emit("captions-request", { ok: true });
        return;
      }
    }
    emit("captions-request", { ok: false, hint: "Turn on captions in Teams: More → Captions." });
  }

  async function inflateBase64(b64) {
    const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
    const asText = new TextDecoder().decode(bytes);
    if (/^\s*[{[]/.test(asText)) return asText;
    for (const format of ["gzip", "deflate", "deflate-raw"]) {
      try {
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
        return await new Response(stream).text();
      } catch {}
    }
    throw new Error("unreadable roster body");
  }

  let guestChannelSeen = false;
  function watchGuestMeeting() {
    meetingRef = `guest-${location.search.slice(0, 200) || location.pathname}`;

    // Caption results ride on the call's "main-channel" data channel.
    const proto = window.RTCPeerConnection?.prototype;
    const createDataChannel = proto?.createDataChannel;
    if (createDataChannel) {
      proto.createDataChannel = function () {
        const channel = createDataChannel.apply(this, arguments);
        if (channel?.label === "main-channel") {
          guestChannelSeen = true;
          note("listening on main-channel");
          channel.addEventListener("message", (event) => {
            try {
              const text = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data);
              const starts = [text.indexOf("{"), text.indexOf("[")].filter((i) => i >= 0);
              if (!starts.length) return;
              const payload = JSON.parse(text.slice(Math.min(...starts)));
              if (Array.isArray(payload?.recognitionResults)) {
                if (!joinedSent) {
                  joinedSent = true;
                  joinedAt = Date.now();
                  emit("join-status", { status: "joined" });
                }
                emitResults(payload, null);
              }
            } catch (err) {
              note("main-channel parse failed", String(err));
            }
          });
        }
        return channel;
      };
    }

    // Names come from roster updates on Teams' notification socket:
    // frames like `3:::{"url": ".../rosterUpdate/...", "body": "<base64>"}`.
    const NativeSocket = window.WebSocket;
    function WatchedSocket(url, protocols) {
      const socket = protocols === undefined ? new NativeSocket(url) : new NativeSocket(url, protocols);
      if (String(url).includes("teams.microsoft.com")) {
        socket.addEventListener("message", async (event) => {
          if (typeof event.data !== "string" || !event.data.startsWith("3:::")) return;
          try {
            const frame = JSON.parse(event.data.slice(4));
            if (!String(frame.url).includes("/rosterUpdate/")) return;
            const roster = JSON.parse(await inflateBase64(frame.body));
            const people = [];
            for (const p of Object.values(roster.participants || {})) {
              const id = personId(p?.details?.id);
              const name = p?.details?.displayName;
              if (id && name) {
                rosterNames.set(id, name);
                people.push({ id, name });
              }
            }
            if (people.length) emit("roster", { people });
          } catch (err) {
            note("roster parse failed", String(err));
          }
        });
      }
      return socket;
    }
    WatchedSocket.prototype = NativeSocket.prototype;
    for (const k of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) WatchedSocket[k] = NativeSocket[k];
    window.WebSocket = WatchedSocket;

    // There's no call object to ask, so the hang-up button stands for "in the
    // call": it appearing means joined, and it staying gone means you left.
    let missingTicks = 0;
    heartbeat = keepChecking(() => {
      const inCall = !!document.getElementById("hangup-button");
      if (inCall) missingTicks = 0;
      if (!joinedSent && inCall) {
        joinedSent = true;
        joinedAt = Date.now();
        emit("store-found", { via: "guest-meeting", hasCaptions: true, href: location.href });
        emit("join-status", { status: "joined" });
        reportHealth(true, guestChannelSeen);
      } else if (joinedSent && inCall && healthDue()) {
        reportHealth(true, guestChannelSeen);
      } else if (joinedSent && !inCall && ++missingTicks >= 3) {
        joinedSent = false;
        note("hang-up button gone; call ended");
        emit("join-status", { status: "left" });
      }
    });
    note("watching guest meeting");
  }

  // ---------------------------------------------------------------- keeping the check running

  // Real Teams stops page timers a few seconds after load (in testing, the hook's setInterval ran
  // 8 times, then never again), so one timer can't be trusted. The check is driven three ways, at
  // most once a second: a timer that re-arms itself, Teams' own screen changes (constant in a call),
  // and a heartbeat from the bridge. Whichever still fires restarts the timer if it has died.
  const drivers = { timer: 0, screen: 0, heartbeat: 0 };
  let lastCheckAt = 0;
  let lastTimerAt = 0;
  let timerArmed = false;
  function keepChecking(check) {
    function run(via) {
      if (via === "timer") lastTimerAt = Date.now();
      if (Date.now() - lastCheckAt < TICK_MS - 50) return;
      lastCheckAt = Date.now();
      drivers[via]++;
      check();
    }
    function arm() {
      timerArmed = true;
      nativeSetTimeout(() => {
        timerArmed = false;
        run("timer");
        arm();
      }, TICK_MS);
    }
    function revive() {
      if (timerArmed && Date.now() - lastTimerAt < 3 * TICK_MS) return;
      if (lastTimerAt) note("timer stopped; restarting it", { drivers: { ...drivers } });
      lastTimerAt = Date.now();
      arm();
    }
    arm();
    let observer = null;
    const observe = () => {
      if (observer || !document.documentElement) return;
      observer = new MutationObserver(() => {
        run("screen");
        revive();
      });
      observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    };
    observe();
    if (!observer) document.addEventListener("readystatechange", observe);
    return () => {
      run("heartbeat");
      revive();
    };
  }
  let heartbeat = () => {};

  // ---------------------------------------------------------------- diagnostics and commands

  function diagnostics() {
    const engine = callingEngine();
    const c = call || activeCall();
    return {
      href: location.href,
      isTopFrame: window.top === window,
      isLightMeeting,
      hasCallingEngine: !!engine,
      callingEngineKeys: engine ? tryOr(() => Object.keys(engine).slice(0, 80), []) : null,
      callCount: tryOr(() => engine.callingService.callRegistry.calls.length, null),
      registryCalls: engine ? registryCalls(engine.callingService).slice(0, 5).map((x) => ({ id: tryOr(() => x._callId, null), state: tryOr(() => x.state, null), connected: tryOr(() => x.callGotConnected, null) })) : null,
      getActiveCallAnswer: engine ? tryOr(() => (engine.callingService.getActiveCall?.() ? "a call" : "nothing"), "error") : null,
      activeCall: !!c,
      callState: c ? tryOr(() => c.state, null) : null,
      callKeys: c ? tryOr(() => Object.keys(c).slice(0, 150), []) : null,
      hasStartClosedCaption: c ? typeof c.startClosedCaption === "function" : null,
      captionStatus: c ? tryOr(() => c.getClosedCaptionStatus(), null) : null,
      dataChannelSubscriptions: c ? tryOr(() => c.dataChannel.subscriptions.map((s) => s?.eventHandler?.on?.name ?? null), null) : null,
      hook: HOOK,
      captionsHooked: !!hooked,
      guestChannelSeen,
      captionsAccepted,
      otherPayloads,
      lastOtherKeys,
      lastCaptionAgoMs: lastCaptionAt ? Date.now() - lastCaptionAt : null,
      participants: c ? participantsOf(c).length : null,
      selfKnown: c ? !!selfOf(c).mri : null,
      rosterNames: rosterNames.size,
      captionsSeen: sent.size,
      ticks,
      tickErrors,
      lastTickError,
      lastCheckAgoMs: lastCheckAt ? Date.now() - lastCheckAt : null,
      drivers: { ...drivers },
      log,
    };
  }

  document.documentElement.addEventListener(IN, (event) => {
    let cmd;
    try {
      cmd = JSON.parse(event.detail);
    } catch {
      return;
    }
    if (cmd.type === "diagnostics") emit("diagnostics", { data: diagnostics() });
    else if (cmd.type === "enable-captions" && (call || isLightMeeting)) startCaptions(cmd);
    else if (cmd.type === "set-language") setLanguage(cmd.language);
    else if (cmd.type === "resync") resync();
    else if (cmd.type === "heartbeat") heartbeat();
  });

  if (isLightMeeting) watchGuestMeeting();
  else heartbeat = keepChecking(safeTick);
})();
