// The Mac panel's "background": what extension/background.js is to a meeting
// tab's panel, for the Mac meetings. It owns the meeting records, answers the
// panel's messages (through mac-shim.js) with the same reply shapes, applies
// edits with the shared meeting core, and saves through the helper (native
// "helper" calls). The native side creates the record and drives it:
//
//   earshotMac.start({meeting, settings, status})  a meeting (new, or the same id again)
//   earshotMac.segments({meetingId, segments})     live lines, new or revised (by id), for that meeting
//                                                  only if it's on show (a bare array: the one on show)
//   earshotMac.replaceSegments([Segment])          the Whisper pass: each capture's lines replaced whole
//   earshotMac.status({level, text, meetingId?})   ignored once another meeting is on show
//   earshotMac.ended()                             after replaceSegments; minutes follow after the delay
//   earshotMac.setPaused(bool)                     the menu paused or resumed: the panel follows
//   earshotMac.isIdle()                            nothing on show or pending (answered at once)
//   earshotMac.renameSpeaker({speakerId, name})    names a speaker you haven't named (a manual capture's mic)
//   earshotMac.finish({meeting, segments, endedAt, rename})
//                                                  ends a meeting by its id, on show or not (a capture's
//                                                  write-up, one recovered after a quit, minutes a quit
//                                                  cut off): its Whisper lines, endedAt if it has none,
//                                                  minutes when they're due
//
// When nothing is on show or pending (no live meeting, no save or minutes to
// come) the page tells native "idle", so the app can let its web view go.
//
// Each returns a promise (native should use callAsyncJavaScript); they run one
// at a time, in the order called.
//
// Two writers share a meeting's file: this panel and the meetings page in
// Chrome. Each record here keeps the updatedAt of the disk copy it's built on
// (`base`) and a log of the changes made since its last good save. A save
// sends the base; if the file changed since, the helper refuses it and sends
// the disk copy back, the log is redone on that copy, and the save goes again.
(function (root) {
  const Earshot = root.Earshot;
  const shim = Earshot.macShim;

  const SAVE_AFTER_MS = 1000;
  const SAVE_RETRY_MS = 5000;
  const SAVE_ATTEMPTS = 3;
  const MIN_SEGMENTS_FOR_MINUTES = 5; // as extension/background.js endMeeting
  const PREFS_KEY = "earshot:mac-prefs"; // panel prefs from set-setting, this web view only
  const PAUSED_STATUS = { level: "paused", text: "Paused. Click play to resume." };
  const LIVE_STATUS = { level: "live", text: "Capturing" };

  const docs = new Map(); // meeting id -> Doc: the current meeting, and any whose minutes are pending
  let current = null;
  let status = { level: "idle", text: "Waiting for a meeting…" };
  let paused = false;
  let settings = buildSettings(null, {});
  const shots = new Map(); // screenshot id -> data URL, for this run of the app
  let startedOnce = false;
  let markStarted;
  const started = new Promise((resolve) => (markStarted = resolve));

  // ---------------------------------------------------------------- native and helper

  // Everything from Swift comes through WebKit, which keeps Swift's shared objects shared: every empty
  // list of a record (segments, tags, refs, chats, screenshots) arrives as ONE array, so a live line pushed
  // onto segments also became a tag. That holds for native's calls into the page and for its
  // replies (a record read back from disk). A JSON copy makes every value its own.
  const own = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x)));

  function native(name, payload = {}) {
    const bridge = root.earshotNative;
    if (!bridge) return Promise.reject(new Error("The Earshot app isn't connected."));
    return Promise.resolve().then(() => bridge.call(name, payload)).then(own);
  }
  const helper = (op, payload = {}) => native("helper", { op, payload });

  async function fetchMeeting(id) {
    try {
      const disk = await helper("get-meeting", { id });
      if (disk && typeof disk === "object" && disk.id === id) return disk;
    } catch {}
    return null;
  }

  // ---------------------------------------------------------------- settings

  function localPrefs() {
    try {
      return JSON.parse(localStorage.getItem(PREFS_KEY) || "{}") || {};
    } catch {
      return {};
    }
  }

  function setPref(key, value) {
    const prefs = { ...localPrefs(), [key]: value };
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {}
    settings = { ...settings, [key]: value };
  }

  // Earshot.DEFAULTS with config.json's tags, vendors, aliases (added to the
  // built-in ones, as the extension does) and `mac`; then this panel's own
  // prefs; then whatever native passed in start. Minutes timing comes from
  // DEFAULTS: the extension's settings live in Chrome, out of reach here.
  function buildSettings(config, overrides) {
    const D = Earshot.DEFAULTS;
    const c = config && typeof config === "object" ? config : {};
    const tagAliases = { ...D.tagAliases };
    for (const [t, words] of Object.entries(c.tagAliases || {})) if (Array.isArray(words)) tagAliases[t] = [...new Set([...(tagAliases[t] || []), ...words])];
    return {
      ...D,
      ...(Array.isArray(c.tags) && c.tags.length ? { tags: c.tags } : {}),
      ...(Array.isArray(c.vendors) ? { vendors: c.vendors } : {}),
      tagAliases,
      mac: { ...(c.mac || {}) },
      ...localPrefs(),
      ...(overrides || {}),
    };
  }

  // ---------------------------------------------------------------- changes to a record

  // Live edits have side effects (the tag list, screenshot files); redoing an
  // edit on a newer disk copy mustn't repeat them.
  const hooks = {
    settings: async () => settings,
    async saveTags(tags) {
      settings = { ...settings, tags };
      shim.storageChanged({ tags: { newValue: tags } });
      helper("set-config", { patch: { tags } }).catch(() => {});
    },
    async removeShot(shotId) {
      shots.delete(shotId);
      if (current) helper("delete-screenshot", { meeting: current.rec, shotId }).catch(() => {});
    },
  };
  const replayHooks = { settings: async () => settings, saveTags: async () => {}, removeShot: async () => {} };

  function withName(rec, seg) {
    const name = rec.speakerNames[seg.speakerId];
    if (name) {
      seg.speaker = name;
      seg.speakerResolved = true;
    }
    return seg;
  }

  const validSegment = (s) => s && typeof s.id === "string" && Number.isFinite(s.startedAt);

  // Live lines, new or revised by id. Returns the lines that changed.
  function upsertSegments(rec, list) {
    const index = Earshot.segmentsById(rec);
    const changed = [];
    let added = false;
    for (const raw of list) {
      let seg = index.get(raw.id);
      if (seg) {
        const text = seg.edited ? seg.text : raw.text; // your fixes stand when the recognizer revises a line
        if (text === seg.text && seg.lastAt === raw.lastAt) continue;
        seg.text = text;
        seg.lastAt = raw.lastAt;
      } else {
        seg = withName(rec, { ...raw });
        rec.segments.push(seg);
        index.set(seg.id, seg);
        added = true;
      }
      changed.push(seg);
    }
    if (added) rec.segments.sort((a, b) => a.startedAt - b.startedAt);
    return changed;
  }

  // The Whisper pass. Ids are "mac-<captureId>-<track>-<n>" (captureId has no dashes).
  // Each capture whose Whisper lines land is listed in rec.macWhisperDone, in
  // the same save, so a later re-run (a recovery after a save that landed late)
  // doesn't replace lines edited since.
  function replaceIn(rec, list) {
    const byCapture = new Map();
    for (const raw of list) {
      const id = /^mac-([^-]+)-/.exec(raw.id)?.[1];
      if (!id) continue;
      if (!byCapture.has(id)) byCapture.set(id, []);
      byCapture.get(id).push(withName(rec, { ...raw }));
    }
    let changed = false;
    for (const [captureId, lines] of byCapture) {
      lines.sort((a, b) => a.startedAt - b.startedAt);
      changed = Earshot.mergeMacSegments(rec, captureId, lines) || changed;
      if (!(rec.macWhisperDone || []).includes(captureId)) {
        rec.macWhisperDone = [...(rec.macWhisperDone || []), captureId];
        changed = true;
      }
    }
    return changed;
  }

  const whisperDone = (rec, raw) => (rec.macWhisperDone || []).includes(/^mac-([^-]+)-/.exec(raw.id)?.[1]);

  // One logged change, applied to a record. Returns whether it changed anything.
  async function applyEntry(rec, e, h) {
    switch (e.kind) {
      case "new":
        return true; // a record not on disk yet
      case "segments":
        return upsertSegments(rec, e.list).length > 0;
      case "replace":
        return replaceIn(rec, e.list);
      case "autotag": {
        const before = JSON.stringify(rec.tags);
        Earshot.autoTag(rec, settings);
        return JSON.stringify(rec.tags) !== before;
      }
      case "shot":
        if (rec.screenshots.some((s) => s.id === e.shot.id)) return false;
        rec.screenshots.push({ ...e.shot });
        return true;
      case "suggestion":
        rec.tagSuggestion = { ...e.value };
        return true;
      case "ended":
        if (rec.endedAt) return false;
        rec.endedAt = e.at;
        return true;
    }
    // action, chat, minutes, minutes-error, filing: the same as in Chrome's background.
    return Earshot.redoChange(rec, e, h);
  }

  const settle = Earshot.settleChange;

  const stampAfter = Earshot.stampAfter;

  // ---------------------------------------------------------------- one meeting's record

  class Doc {
    constructor(rec, base) {
      this.rec = rec;
      this.base = base; // updatedAt of the disk copy rec is built on; null if none yet
      this.log = []; // changes since the last good save
      this.timer = null;
      this.chain = Promise.resolve();
      this.error = null; // the last save that didn't reach the helper
      this.minutesTimer = null;
      this.minutesRunning = false;
      this.endShown = false; // the panel has shown this meeting as ended
    }

    get id() {
      return this.rec.id;
    }

    // Apply a change now and keep it until a save carries it.
    async change(entry) {
      const rec = this.rec;
      if (!(await applyEntry(rec, entry, hooks))) return false;
      settle(rec, entry);
      // Swapped for a disk copy while that ran: the copy takes the change too.
      if (this.rec !== rec) await applyEntry(this.rec, entry, replayHooks);
      this.record(entry);
      return true;
    }

    // A change already applied to rec.
    record(entry) {
      this.log.push(entry);
      this.schedule();
    }

    async commit(entry) {
      await this.change(entry);
      return this.save();
    }

    schedule(ms = SAVE_AFTER_MS) {
      if (!this.timer) this.timer = setTimeout(() => this.save(), ms);
    }

    // Save now if there are changes; resolves when every save so far is done.
    save() {
      clearTimeout(this.timer);
      this.timer = null;
      this.chain = this.chain.then(() => this.flush()).catch((err) => console.warn("Earshot: save", err));
      return this.chain;
    }

    async flush() {
      for (let attempt = 0; attempt < SAVE_ATTEMPTS && this.log.length; attempt++) {
        const rec = this.rec;
        const sent = this.log.length;
        delete rec.saveError;
        const stamp = (rec.updatedAt = stampAfter(this.base));
        let res;
        try {
          res = await helper("save-meeting", { meeting: rec, base: this.base });
        } catch (err) {
          // The write may have landed before the error (a later file failed, the
          // reply was lost): if disk carries this stamp, it did.
          const disk = await fetchMeeting(this.id);
          if (disk?.updatedAt === stamp) res = { landed: true };
          else {
            this.error = String(err.message || err);
            console.warn("Earshot: helper save failed", err);
            this.schedule(SAVE_RETRY_MS);
            return;
          }
        }
        this.error = null;
        if (!res?.stale) {
          this.base = rec.updatedAt;
          this.log.splice(0, sent);
          if (!this.log.length) setTimeout(tellIfIdle, 0);
          return;
        }
        // Written since by someone else: redo the log on their copy, then try again.
        // (A helper older than `base` refuses without sending the copy.)
        const disk = res.meeting?.id === this.id ? res.meeting : await fetchMeeting(this.id);
        if (!disk) break;
        await this.rebase(disk);
      }
      if (this.log.length) {
        this.rec.saveError = "Couldn't save: the meeting kept changing on disk, or the helper had no copy to build on. Trying again.";
        this.schedule(SAVE_RETRY_MS);
      }
    }

    // The disk copy becomes the record, with the unsaved changes redone on it.
    // The Mac's own lines are this app's to keep: any the copy lacks (or has
    // older text for, unedited) go back in.
    async rebase(disk) {
      const old = this.rec;
      const rec = Earshot.upgrade(structuredClone(disk));
      this.base = disk.updatedAt ?? null;
      for (const entry of this.log) await applyEntry(rec, entry, replayHooks);
      const index = Earshot.segmentsById(rec);
      let added = false;
      for (const s of old.segments) {
        if (!String(s.id).startsWith("mac-")) continue;
        const d = index.get(s.id);
        if (!d) {
          const copy = withName(rec, { ...s });
          rec.segments.push(copy);
          index.set(copy.id, copy);
          added = true;
        } else if (!d.edited && (d.text !== s.text || d.lastAt !== s.lastAt)) {
          d.text = s.text;
          d.lastAt = s.lastAt;
        }
      }
      if (added) rec.segments.sort((a, b) => a.startedAt - b.startedAt);
      this.rec = rec;
      if (current === this) shim.toPanel({ type: "meeting-full", meeting: rec });
    }

    // Take a newer disk copy now, if there is one (in turn with saves).
    refresh() {
      this.chain = this.chain
        .then(async () => {
          const disk = await fetchMeeting(this.id);
          if (disk && disk.updatedAt !== undefined && disk.updatedAt !== this.base) await this.rebase(disk);
        })
        .catch((err) => console.warn("Earshot: refresh", err));
      return this.chain;
    }
  }

  // Records that are done with: not shown, saved, no minutes to come.
  function prune() {
    for (const [id, doc] of docs) if (doc !== current && !doc.minutesTimer && !doc.minutesRunning && !doc.log.length) docs.delete(id);
    tellIfIdle();
  }

  // Nothing live on show, nothing left to save or write: native may let the page go.
  function isIdle() {
    if (current && !current.rec.endedAt) return false;
    for (const doc of docs.values()) if (doc.minutesTimer || doc.minutesRunning || doc.log.length || doc.timer) return false;
    return true;
  }
  function tellIfIdle() {
    if (isIdle()) native("idle", {}).catch(() => {});
  }

  // ---------------------------------------------------------------- company suggestion

  const wantsSuggestion = (rec) => !rec.title && !(rec.tags || []).length;
  const notMe = (name) => name && name !== settings.mac?.myName;

  function knownNames(rec) {
    return [...new Set([...Object.values(rec.speakerNames || {}), ...Object.values(rec.participants || {})])].map((n) => String(n).trim()).filter(notMe);
  }

  // An untitled, untagged meeting: who you're talking to may say which company
  // it is. One you dismissed isn't suggested again.
  async function suggestCompany(doc, names) {
    if (!wantsSuggestion(doc.rec) || !names.length) return;
    let hit;
    try {
      hit = await helper("suggest-company", { names });
    } catch {
      return; // an older helper without the op, or no vault: no suggestion
    }
    const rec = doc.rec;
    if (!hit?.tag || !wantsSuggestion(rec) || (rec.tagSuggestionDismissed || []).includes(hit.tag)) return;
    const value = { tag: String(hit.tag), person: String(hit.person || "") };
    if (rec.tagSuggestion?.tag === value.tag && rec.tagSuggestion?.person === value.person) return;
    await doc.change({ kind: "suggestion", value });
    if (current === doc) shim.toPanel({ type: "meeting-full", meeting: doc.rec });
  }

  // ---------------------------------------------------------------- start, status, end

  async function start({ meeting: m, settings: overrides = {}, status: st = null } = {}) {
    if (!m || typeof m.id !== "string") throw new Error("earshotMac.start needs a meeting record");
    if (current && current.id !== m.id) {
      await current.save(); // the last meeting's edits reach disk first
      shots.clear();
    }
    let config = null;
    try {
      config = await helper("get-config");
    } catch {}
    settings = buildSettings(config, overrides);
    let doc = docs.get(m.id);
    if (doc) {
      // The same meeting again: its pending minutes wait for the new end.
      clearTimeout(doc.minutesTimer);
      doc.minutesTimer = null;
      doc.endShown = false;
      await doc.refresh();
    } else {
      // A copy on disk (saved before a restart, edited on the meetings page) is the record.
      const disk = await fetchMeeting(m.id);
      doc = disk ? new Doc(Earshot.upgrade(disk), disk.updatedAt ?? null) : new Doc(Earshot.upgrade(structuredClone(m)), null);
      if (!disk) doc.record({ kind: "new" });
      docs.set(m.id, doc);
    }
    // Lines native passed that the record lacks (or has older) go in.
    if (Array.isArray(m.segments)) {
      const list = m.segments.filter(validSegment).map((s) => ({ ...s }));
      if (upsertSegments(doc.rec, list).length) doc.record({ kind: "segments", list });
    }
    await doc.change({ kind: "autotag" });
    current = doc;
    status = st || { level: "live", text: "Capturing" };
    paused = false;
    if (!startedOnce) {
      startedOnce = true;
      markStarted(); // panel-hello answers with this meeting
    } else {
      // Meeting before status: an ended panel only reopens for a live meeting.
      shim.toPanel({ type: "meeting-full", meeting: doc.rec });
      shim.toPanel({ type: "status", status });
      shim.storageChanged({ tags: { newValue: settings.tags } });
    }
    prune();
    suggestCompany(doc, knownNames(doc.rec));
  }

  function takeSegments(arg) {
    const doc = current;
    const list = Array.isArray(arg) ? arg : arg?.segments;
    // Lines for a meeting no longer on show (the next one started) never land on this one.
    if (!Array.isArray(list) || !doc || (arg?.meetingId && arg.meetingId !== doc.id)) return;
    const lines = list.filter(validSegment).map((s) => ({ ...s }));
    const changed = upsertSegments(doc.rec, lines);
    if (!changed.length) return;
    doc.record({ kind: "segments", list: lines });
    shim.toPanel({ type: "segments", segments: changed, meeting: Earshot.summaryOf(doc.rec) });
  }

  function replaceSegments(list) {
    const doc = current;
    if (!doc || !Array.isArray(list)) return;
    const lines = list.filter(validSegment).map((s) => ({ ...s }));
    if (!replaceIn(doc.rec, lines)) return;
    doc.record({ kind: "replace", list: lines });
    shim.toPanel({ type: "meeting-full", meeting: doc.rec });
  }

  function setStatus(next) {
    if (!next || typeof next !== "object") return;
    // A line for a meeting that's no longer on show (one being written up while the next is live).
    if (next.meetingId && next.meetingId !== current?.id) return;
    status = { level: String(next.level || "live"), text: String(next.text || "") };
    shim.toPanel({ type: "status", status });
  }

  // Saved at once; minutes and filing after minutesDelayMinutes, as in the extension.
  async function ended() {
    const doc = current;
    if (!doc || doc.rec.endedAt) return;
    await doc.change({ kind: "ended", at: new Date().toISOString() });
    status = { level: "ended", text: "Meeting ended · transcript saved" };
    await doc.save();
    doc.endShown = true;
    shim.toPanel({ type: "ended", meeting: Earshot.summaryOf(doc.rec) });
    if (!scheduleMinutes(doc, settings)) prune();
  }

  // Minutes and filing minutesDelayMinutes after the meeting's endedAt (at
  // once if that's past). Returns whether they're on the way.
  function scheduleMinutes(doc, s) {
    clearTimeout(doc.minutesTimer);
    doc.minutesTimer = null;
    if (!s.autoMinutes || doc.rec.segments.length < MIN_SEGMENTS_FOR_MINUTES) return false;
    const delay = Math.max(0, Number(s.minutesDelayMinutes) || 0) * 60000;
    const due = (Date.parse(doc.rec.endedAt) || Date.now()) + delay;
    doc.minutesTimer = setTimeout(() => {
      doc.minutesTimer = null;
      writeMinutes(doc)
        .catch((err) => console.warn("Earshot: minutes", err))
        .finally(prune);
    }, Math.max(0, due - Date.now()));
    return true;
  }

  // A meeting that isn't on show, ended through the same record logic: a
  // capture recovered after a quit or crash (its Whisper lines, endedAt when
  // it has none), or one whose minutes timer was lost when the app quit. The
  // panel stays as it is unless this is the meeting it shows.
  async function finish({ meeting: m, segments: list = null, endedAt = null, rename = null } = {}) {
    if (!m || typeof m.id !== "string") throw new Error("earshotMac.finish needs a meeting record");
    let config = null;
    try {
      config = await helper("get-config");
    } catch {}
    const s = buildSettings(config, {});
    let doc = docs.get(m.id);
    if (doc) await doc.refresh();
    else {
      const disk = await fetchMeeting(m.id);
      doc = disk ? new Doc(Earshot.upgrade(disk), disk.updatedAt ?? null) : new Doc(Earshot.upgrade(structuredClone(m)), null);
      if (!disk) doc.record({ kind: "new" });
      docs.set(m.id, doc);
    }
    if (rename?.speakerId && rename.name && !doc.rec.speakerNames[rename.speakerId]) {
      await doc.change({ kind: "action", req: { action: "rename-speaker", speakerId: rename.speakerId, name: rename.name } });
    }
    if (Array.isArray(list)) {
      // A capture whose Whisper lines already landed keeps its lines as they are now (edits included).
      const lines = list.filter(validSegment).filter((x) => !whisperDone(doc.rec, x)).map((x) => ({ ...x }));
      if (lines.length && replaceIn(doc.rec, lines)) doc.record({ kind: "replace", list: lines });
    }
    if (!doc.rec.endedAt) await doc.change({ kind: "ended", at: typeof endedAt === "string" && endedAt ? endedAt : new Date().toISOString() });
    // Native must not count this meeting as finished unless what it changed reached disk: a save that
    // didn't stays queued (and retried), and finish rejects so native keeps the capture to finish again.
    // Changes made while the save was on its way (an edit in the panel) don't count against it.
    const last = doc.log.at(-1);
    await doc.save();
    if (last && doc.log.includes(last)) throw new Error(`The meeting couldn't be saved: ${doc.error || doc.rec.saveError || "the helper didn't take it"}`);
    if (current === doc && !doc.endShown) {
      // The meeting on show: its panel ends as after a call, and goes (once, whichever finish got here).
      doc.endShown = true;
      status = { level: "ended", text: "Meeting ended · transcript saved" };
      shim.toPanel({ type: "ended", meeting: Earshot.summaryOf(doc.rec) });
    } else if (current === doc) shim.toPanel({ type: "meeting-full", meeting: doc.rec });
    // Minutes already written (or under way) aren't written again.
    if (doc.rec.minutes || doc.minutesRunning || !scheduleMinutes(doc, s)) prune();
  }

  // The menu's Pause/Resume: native has already paused, so the panel just follows.
  function setPausedFromNative(value) {
    paused = !!value;
    setStatus(paused ? PAUSED_STATUS : LIVE_STATUS);
    shim.toPanel({ type: "paused", paused });
  }

  // A manual capture's mic is "Speaker" until the Mac's audio has lines; then
  // it's you. A name you gave it stands.
  async function renameSpeaker({ speakerId, name } = {}) {
    const doc = current;
    if (!doc || typeof speakerId !== "string" || !name || doc.rec.speakerNames[speakerId]) return false;
    const ok = await doc.change({ kind: "action", req: { action: "rename-speaker", speakerId, name: String(name) } });
    if (ok) shim.toPanel({ type: "meeting-full", meeting: doc.rec });
    return ok;
  }

  // Minutes from the newest copy, then the vault. Each is a logged change of
  // its own fields, so a save that finds the file changed redoes just those on
  // the disk copy: edits made meanwhile (on the meetings page, say) stay. A
  // change that can't be saved stays in the log and is tried again.
  async function writeMinutes(doc) {
    doc.minutesRunning = true;
    try {
      await doc.save();
      await doc.refresh();
      if (doc.rec.segments.length < MIN_SEGMENTS_FOR_MINUTES) return;
      let res;
      try {
        res = await helper("minutes", { meeting: doc.rec });
      } catch (err) {
        await doc.commit({ kind: "minutes-error", error: String(err.message || err) });
        return;
      }
      await doc.commit({ kind: "minutes", res, at: new Date().toISOString() });
      let filing;
      try {
        filing = await helper("file-to-vault", { meeting: doc.rec, auto: true });
      } catch (err) {
        console.warn("Earshot: vault filing failed", err);
        return;
      }
      await doc.commit({ kind: "filing", res: filing, at: new Date().toISOString() });
    } finally {
      doc.minutesRunning = false;
    }
  }

  // ---------------------------------------------------------------- the panel's messages

  function diagnostics() {
    return {
      app: "Earshot for Mac",
      meetingId: current?.id || null,
      platform: current?.rec.platform || null,
      status,
      paused,
      segments: current?.rec.segments.length || 0,
      unsaved: current?.log.length || 0,
      base: current?.base ?? null,
      lastSaveError: current?.error || current?.rec.saveError || null,
      minutesPending: [...docs.values()].filter((d) => d.minutesTimer || d.minutesRunning).map((d) => d.id),
      nativeBridge: !!root.earshotNative,
    };
  }

  async function onMessage(req) {
    const doc = current;
    switch (req?.kind) {
      case "panel-hello":
        await started;
        return { meeting: current?.rec || null, status, paused, settings, aiHealth: null };

      case "get-meeting":
        if (!doc) return null;
        return req.withImages ? { ...doc.rec, screenshots: doc.rec.screenshots.map((s) => ({ ...s, dataUrl: shots.get(s.id) || null })) } : doc.rec;

      case "meeting-action": {
        if (!doc) return { ok: false };
        const ok = await doc.change({ kind: "action", req });
        if (ok) {
          if (current === doc) shim.toPanel({ type: "meeting-full", meeting: doc.rec });
          if (req.action === "rename-speaker") suggestCompany(doc, [String(req.name || "").trim()].filter(notMe));
        }
        return { ok, meeting: doc.rec };
      }

      case "ask": {
        if (!doc) return { error: "No meeting yet. Ask AI works once the meeting is being captured." };
        const at = Date.now();
        const question = String(req.question).trim();
        let outcome;
        try {
          outcome = await helper("ask", { meeting: doc.rec, question });
        } catch (err) {
          outcome = err instanceof Error ? err : new Error(String(err));
        }
        const chat = Earshot.chatFor(question, outcome, at);
        // On this meeting's record, even if another meeting has started since.
        await doc.change({ kind: "chat", chat });
        if (current === doc) shim.toPanel({ type: "meeting-full", meeting: doc.rec });
        return chat;
      }

      // The app captures the call's window (or the screen); the panel has no page to capture.
      case "capture-tab": {
        const shot = await native("screenshot", {});
        if (!shot?.dataUrl) return { error: "Couldn't capture the screen" };
        return { dataUrl: shot.dataUrl, width: shot.width, height: shot.height };
      }

      case "add-screenshot": {
        if (!doc) return { ok: false, reason: "no-meeting" };
        const shot = Earshot.screenshotRecord(doc.id, req);
        shots.set(shot.id, req.dataUrl);
        await doc.change({ kind: "shot", shot });
        helper("save-screenshot", { meeting: doc.rec, shot, dataUrl: req.dataUrl }).catch((err) => console.warn("Earshot: screenshot file", err));
        if (current === doc) shim.toPanel({ type: "meeting-full", meeting: doc.rec });
        return { ok: true, shot };
      }

      case "get-screenshot":
        return { dataUrl: shots.get(req.id) || null };

      case "set-paused": {
        // Native refuses when it couldn't pause (nothing recording): the panel then stays as it was.
        const value = !!req.value;
        await native("set-paused", { value });
        paused = value;
        setStatus(value ? PAUSED_STATUS : LIVE_STATUS);
        return { paused };
      }

      case "stop":
        // Same as Stop in the menu bar: the capture ends and the panel shows it ended.
        await native("stop", {});
        return { ok: true };

      // The browser's "Don't record this meeting" has no Mac counterpart: Stop is the Mac's button.
      case "discard-meeting":
        return { ok: false };

      case "set-language":
        setPref("captionLanguage", req.id);
        return { ok: true };

      case "get-settings":
        return settings;

      case "set-setting":
        setPref(req.key, req.value);
        return { ok: true };

      case "open-meetings":
        native("open-meetings", { id: req.id ?? null }).catch(() => {});
        return undefined;

      // The extension asks the meeting tab's hooked frames; here the app answers for itself.
      case "panel-cmd":
        if (req.cmd?.type === "diagnostics") setTimeout(() => shim.toPanel({ type: "diagnostics", frameUrl: location.href, data: diagnostics() }), 0);
        return undefined;

      case "diagnostics":
        return diagnostics();

      case "helper":
        return helper(req.op, req.payload || {});

      // Captions belong to browser meetings.
      case "retry-captions":
        return { ok: true };
      case "captions-off":
        return undefined;
    }
    return undefined;
  }

  // Failures answer {error}, as extension/background.js respond() does.
  shim.setHandler((req) => onMessage(req).catch((err) => ({ error: String(err.message || err) })));

  // ---------------------------------------------------------------- calls from native, one at a time

  let chain = Promise.resolve();
  const inOrder = (fn) => (...args) => {
    args = args.map(own);
    const run = chain.then(() => fn(...args));
    chain = run.catch((err) => console.error("Earshot:", err));
    return run;
  };

  root.earshotMac = {
    start: inOrder(start),
    segments: inOrder(takeSegments),
    replaceSegments: inOrder(replaceSegments),
    status: inOrder(setStatus),
    ended: inOrder(ended),
    setPaused: inOrder(setPausedFromNative),
    renameSpeaker: inOrder(renameSpeaker),
    finish: inOrder(finish),
    isIdle: () => isIdle(),
  };
})(typeof self !== "undefined" ? self : globalThis);
