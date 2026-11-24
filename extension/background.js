// Background worker: owns the meeting records and relays between the page
// hooks (any frame), the in-meeting panel (top frame), the meetings page and
// the Earshot helper (a local program that saves meetings as files in
// ~/Earshot and runs your AI CLI).
//
// Every hook event carries `platform` ("zoom", "teams", "meet") and `ref`,
// the platform's own id for the meeting (Zoom number, Teams call id, Meet code).
//
// chrome.storage.local:
//   meeting:<id>  full record (segments, notes, tags, chats, minutes, screenshot list)
//   shot:<id>     one screenshot's image, kept apart so the record stays small
//   meetingIndex  summaries for the meeting lists
// The helper mirrors each record to files; Chrome storage is what the
// extension reads, so Earshot keeps working (minus files and AI) without it.
importScripts("shared/transcript.js", "shared/languages.js", "shared/defaults.js", "shared/meeting-core.js");

const FLUSH_AFTER_MS = 1000;
const HELPER_SYNC_MS = 3000;
const RESUME_SAME_TITLE_WITHIN_MS = 15 * 60 * 1000; // a new record this young may merge into an earlier one
const DEFAULTS = Earshot.DEFAULTS;

const loaded = new Map(); // meeting id -> meeting object (in memory while the worker lives)
const dirty = new Set();
let flushTimer = null;
const tabQueues = new Map(); // tab id -> promise chain, so one tab's events apply in order
const tabStatus = new Map(); // tab id -> last status shown in the panel
const pendingRoster = new Map(); // tab id -> roster seen before the meeting record existed

// ---------------------------------------------------------------- settings

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get([...Object.keys(DEFAULTS), "joinCollapsedSet"]);
  const missing = {};
  for (const [k, v] of Object.entries(DEFAULTS)) if (current[k] === undefined) missing[k] = v;
  // New meetings start collapsed to the launcher. Applied once to an existing
  // install too; switching "Open the panel when a meeting starts" back on sticks after that.
  if (!current.joinCollapsedSet) Object.assign(missing, { panelOpenOnJoin: false, joinCollapsedSet: true });
  if (Object.keys(missing).length) await chrome.storage.local.set(missing);
  await applyRedirectSetting();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.redirectZoom) applyRedirectSetting();
});

async function applyRedirectSetting() {
  const { redirectZoom = true } = await chrome.storage.local.get("redirectZoom");
  await chrome.declarativeNetRequest.updateEnabledRulesets(
    redirectZoom ? { enableRulesetIds: ["zoom_web_client"] } : { disableRulesetIds: ["zoom_web_client"] }
  );
}

async function settings() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  const tagAliases = { ...DEFAULTS.tagAliases };
  for (const [t, words] of Object.entries(stored.tagAliases || {})) tagAliases[t] = [...new Set([...(tagAliases[t] || []), ...words])];
  return { ...DEFAULTS, ...stored, tagAliases };
}

// ---------------------------------------------------------------- helper connection

const helper = { port: null, pending: new Map(), nextId: 1, info: null, error: null, unsupported: new Set() };

function connectHelper() {
  if (helper.port) return helper.port;
  try {
    const port = chrome.runtime.connectNative("com.earshot.helper");
    helper.port = port;
    helper.unsupported = new Set();
    port.onMessage.addListener((msg) => {
      // Frames the helper sends unasked (the Mac app's lines) carry `push`, not a request number.
      if (msg?.push) return onHelperPush(msg);
      const waiter = helper.pending.get(msg.id);
      if (!waiter) return;
      helper.pending.delete(msg.id);
      clearTimeout(waiter.timer);
      msg.ok ? waiter.resolve(msg.result) : waiter.reject(new Error(msg.error));
    });
    port.onDisconnect.addListener(() => {
      helper.error = chrome.runtime.lastError?.message || "disconnected";
      helper.port = null;
      helper.info = null;
      for (const w of helper.pending.values()) clearTimeout(w.timer), w.reject(new Error(`Earshot helper isn't available (${helper.error}).`));
      helper.pending.clear();
    });
    // Each new helper process is asked to pass on the Mac app's lines.
    callNewOp("watch-mac");
    return port;
  } catch (err) {
    helper.error = String(err.message || err);
    return null;
  }
}

// The request number travels as `rid`: payloads carry their own `id` (a
// meeting's), which used to overwrite it, so those replies never arrived.
const HELPER_TIMEOUT_MS = 6 * 60 * 1000; // minutes can take up to 5
function callHelper(op, payload = {}) {
  const port = connectHelper();
  if (!port) return Promise.reject(new Error("Earshot helper isn't installed. Run helper/install.sh on this Mac."));
  const rid = helper.nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      helper.pending.delete(rid);
      reject(new Error(`The Earshot helper didn't answer (${op}).`));
    }, HELPER_TIMEOUT_MS);
    helper.pending.set(rid, { resolve, reject, timer });
    try {
      port.postMessage({ ...payload, rid, op });
    } catch (err) {
      clearTimeout(timer);
      helper.pending.delete(rid);
      reject(err);
    }
  });
}

// Ops added for the Mac app. A helper installed before them answers "unknown
// op": that connection is then not asked again, quietly (no errors, no notices).
async function callNewOp(op, payload = {}) {
  const unsupported = helper.unsupported;
  if (unsupported.has(op)) return null;
  try {
    return await callHelper(op, payload);
  } catch (err) {
    if (/unknown op/.test(String(err.message || err))) unsupported.add(op);
    return null;
  }
}

function onHelperPush(msg) {
  if (msg.push === "mac-segments") takeMacSegments(msg).catch((err) => console.warn("Earshot: Mac lines", err));
}

async function helperInfo({ retry = false } = {}) {
  if (helper.info) return helper.info;
  // Without the helper installed, don't retry on every save; once a minute is plenty.
  if (!retry && helper.failedAt && Date.now() - helper.failedAt < 60000) return null;
  try {
    helper.info = await callHelper("hello");
    helper.error = null;
    helper.failedAt = 0;
  } catch (err) {
    helper.info = null;
    helper.error = String(err.message || err);
    helper.failedAt = Date.now();
  }
  return helper.info;
}

// ---------------------------------------------------------------- AI sign-in health

// Is the AI CLI signed in (to the right account)? Checked when a meeting
// starts, every few hours, and after any AI call that fails on sign-in. A
// problem shows in the panel and as a macOS notification (at most every few
// hours for the same problem), so an expired sign-in never surprises you
// at the end of a meeting.
const AI_CHECK_MINUTES = 240;
const AI_NOTIFY_EVERY_MS = 3 * 60 * 60 * 1000;

async function checkAi({ live = false, notify = true } = {}) {
  if (!(await helperInfo({ retry: true }))) return null;
  let health;
  try {
    health = await callHelper("ai-health", { live });
  } catch (err) {
    health = { ok: false, checkedAt: new Date().toISOString(), problem: String(err.message || err), fix: "Run helper/install.sh again." };
  }
  await chrome.storage.session.set({ aiHealth: health });
  const tabs = await chrome.storage.session.get(null);
  for (const key of Object.keys(tabs)) if (key.startsWith("tab:")) toPanel(Number(key.slice(4)), { type: "ai-health", health });
  chrome.runtime.sendMessage({ kind: "ai-health", health }).catch(() => {});
  if (!health.ok && notify) await notifyAiProblem(health);
  return health;
}

async function notifyAiProblem(health) {
  const { aiNotified } = await chrome.storage.local.get("aiNotified");
  if (aiNotified?.problem === health.problem && Date.now() - aiNotified.at < AI_NOTIFY_EVERY_MS) return;
  await chrome.storage.local.set({ aiNotified: { problem: health.problem, at: Date.now() } });
  chrome.notifications.create("earshot-ai", {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: "Earshot: AI is off",
    message: `${health.problem}${health.fix ? `\nFix: ${health.fix}` : ""}`,
    priority: 2,
    requireInteraction: true,
  });
}

chrome.notifications.onClicked.addListener((id) => {
  if (id === "earshot-ai") chrome.tabs.create({ url: chrome.runtime.getURL("app/meetings.html#settings") });
  for (const prefix of ["earshot-saved:", MINUTES_FAILED]) {
    if (!id.startsWith(prefix)) continue;
    chrome.tabs.create({ url: chrome.runtime.getURL(`app/meetings.html#${encodeURIComponent(id.slice(prefix.length))}`) });
    chrome.notifications.clear(id);
  }
  if (id.startsWith("earshot-captions:")) {
    const tabId = Number(id.slice("earshot-captions:".length));
    chrome.tabs.update(tabId, { active: true }, (tab) => tab && chrome.windows.update(tab.windowId, { focused: true }));
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "earshot-ai-check") checkAi({ live: true });
  if (alarm.name === "earshot-stale") endStaleMeetings().catch((err) => console.warn("Earshot: stale check failed", err));
  if (alarm.name.startsWith("earshot-minutes:")) writeEndedMinutes(alarm.name.slice("earshot-minutes:".length));
  if (alarm.name.startsWith("earshot-saved:")) notifySaved(alarm.name.slice("earshot-saved:".length)).catch(() => {});
  if (alarm.name === BROWSER_ALARM) reportBrowserState().catch(() => {});
  if (alarm.name === VAULT_SYNC_ALARM) runVaultSync();
});
const scheduleAiChecks = () => {
  chrome.alarms.create("earshot-ai-check", { periodInMinutes: AI_CHECK_MINUTES, delayInMinutes: 1 });
  chrome.alarms.create("earshot-stale", { periodInMinutes: 2, delayInMinutes: 1 });
  chrome.alarms.create(VAULT_SYNC_ALARM, { periodInMinutes: VAULT_SYNC_MINUTES, delayInMinutes: 2 });
};
chrome.runtime.onInstalled.addListener(scheduleAiChecks);

// Reloading or updating Earshot cuts off the bridge and panel in meeting tabs
// that are already open, while the page hooks there keep running. Fresh copies
// go into those tabs, so capture carries on into the same meeting without
// refreshing the page (the panel replaces its cut-off copy).
// The page hooks (MAIN world) go in first: a tab opened while Earshot was off, or before it was
// installed, has none, and each hook skips itself if a copy is already running. Then the bridge
// and panel, whose new copies ask the hook to replay the meeting state.
async function reattachOpenTabs() {
  const entries = chrome.runtime.getManifest().content_scripts;
  const ordered = [...entries.filter((c) => c.world === "MAIN"), ...entries.filter((c) => c.world !== "MAIN")];
  for (const entry of ordered) {
    for (const tab of await chrome.tabs.query({ url: entry.matches })) {
      await chrome.scripting
        .executeScript({ target: { tabId: tab.id, allFrames: !!entry.all_frames }, files: entry.js, world: entry.world === "MAIN" ? "MAIN" : "ISOLATED" })
        .catch(() => {});
    }
  }
}
const reattach = () => reattachOpenTabs().catch((err) => console.warn("Earshot: re-attach failed", err));
chrome.runtime.onInstalled.addListener(reattach);
chrome.runtime.onStartup.addListener(reattach);
chrome.runtime.onStartup.addListener(scheduleAiChecks);

// Records go to the helper a few seconds apart while a meeting runs, and at once when it ends.
const helperTimers = new Map();
// Meetings deleted with "Don't record this meeting": a save already under way must not bring them back.
const discarded = new Set();
function syncToHelper(meeting, now = false) {
  if (discarded.has(meeting.id)) return;
  if (DISK_EDITED.has(meeting.platform)) return saveDiskEdited(meeting.id);
  clearTimeout(helperTimers.get(meeting.id));
  const run = async () => {
    helperTimers.delete(meeting.id);
    if (discarded.has(meeting.id)) return;
    // A copy taken from disk since replaced this one: it has nothing to save.
    if (loaded.has(meeting.id) && loaded.get(meeting.id) !== meeting) return;
    if (!(await helperInfo())) return;
    try {
      const res = await callHelper("save-meeting", { meeting });
      // Disk has a newer copy (the Mac app wrote it): take that one instead.
      if (res?.stale && (await enqueue(recordKey(meeting.id), () => refreshFromDisk(meeting.id)))) await broadcastMeeting(await loadMeeting(meeting.id));
    } catch (err) {
      console.warn("Earshot: helper save failed", err);
    }
  };
  if (now) return run();
  helperTimers.set(meeting.id, setTimeout(run, HELPER_SYNC_MS));
}

// ---------------------------------------------------------------- meeting records

function newMeetingId(platform, ref) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const safeRef = String(ref || "unknown").replace(/[^A-Za-z0-9]+/g, "").slice(-24) || "unknown";
  return `${platform}-${safeRef}-${stamp}`;
}

async function loadMeeting(id) {
  if (loaded.has(id)) return loaded.get(id);
  const key = `meeting:${id}`;
  const got = await chrome.storage.local.get(key);
  const meeting = got[key] || null;
  if (meeting) loaded.set(id, upgrade(meeting));
  return meeting;
}

const upgrade = Earshot.upgrade;

const segmentsById = Earshot.segmentsById;

const tabKey = (tabId) => `tab:${tabId}`;
const sameDay = (iso) => new Date(iso).toDateString() === new Date().toDateString();
const normTitle = (t) => String(t || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

async function tabMeetingId(tabId) {
  const got = await chrome.storage.session.get(tabKey(tabId));
  return got[tabKey(tabId)] || null;
}

async function bindTab(tabId, meetingId) {
  await chrome.storage.session.set({ [tabKey(tabId)]: meetingId });
}

async function indexRows() {
  return (await chrome.storage.local.get("meetingIndex")).meetingIndex || [];
}

// Rejoining the same meeting the same day picks the earlier record back up:
// same Zoom number or Meet code, or (Teams, where each join gets a new id) same title.
async function findResumable(platform, { ref, title } = {}) {
  const rows = (await indexRows()).filter((r) => r.platform === platform && sameDay(r.startedAt));
  const byRef = ref && platform !== "teams" ? rows.find((r) => r.meetingRef === ref) : null;
  if (byRef) return byRef.id;
  const t = normTitle(title);
  const byTitle = t ? rows.find((r) => normTitle(r.title) === t) : null;
  return byTitle?.id || null;
}

// A tab keeps one meeting record per platform meeting, so a page reload
// mid-meeting continues the same transcript instead of starting a new one.
async function meetingForTab(tab, msg, create) {
  const currentId = await tabMeetingId(tab.id);
  if (currentId) {
    const existing = await loadMeeting(currentId);
    if (existing && (!msg || (existing.platform === msg.platform && (!msg.ref || existing.meetingRef === msg.ref || existing.refs?.includes(msg.ref))))) return existing;
  }
  if (!create || !msg) return null;
  const resumeId = await findResumable(msg.platform, { ref: msg.ref });
  if (resumeId) {
    const resumed = await loadMeeting(resumeId);
    if (resumed) {
      revive(resumed, tab.id);
      await bindTab(tab.id, resumed.id);
      markDirty(resumed);
      return resumed;
    }
  }
  const meeting = upgrade({
    id: newMeetingId(msg.platform, msg.ref),
    platform: msg.platform,
    meetingRef: msg.ref || null,
    refs: msg.ref ? [msg.ref] : [],
    title: "",
    url: tab.url,
    startedAt: new Date().toISOString(),
    endedAt: null,
    captionLanguage: null,
    participants: {},
    segments: [],
  });
  if (pendingRoster.has(tab.id)) {
    addParticipants(meeting, pendingRoster.get(tab.id));
    pendingRoster.delete(tab.id);
  }
  loaded.set(meeting.id, meeting);
  await bindTab(tab.id, meeting.id);
  markDirty(meeting);
  return meeting;
}

// When a fresh record turns out (by its title) to be a meeting you were
// already in today, fold it into that one and carry on there.
async function mergeIntoEarlier(tabId, meeting) {
  if (Date.now() - Date.parse(meeting.startedAt) > RESUME_SAME_TITLE_WITHIN_MS) return meeting;
  const rows = (await indexRows()).filter((r) => r.id !== meeting.id);
  const t = normTitle(meeting.title);
  // Zoom numbers and Meet codes already identify a meeting: two different ones
  // with the same title are different meetings. Teams gets a new id per join,
  // so there the title decides.
  const sameMeeting = (r) => meeting.platform === "teams" || !r.meetingRef || !meeting.meetingRef || r.meetingRef === meeting.meetingRef;
  const match = t && rows.find((r) => r.platform === meeting.platform && sameDay(r.startedAt) && normTitle(r.title) === t && sameMeeting(r));
  if (!match) return meeting;
  const target = await loadMeeting(match.id);
  if (!target) return meeting;
  const index = segmentsById(target);
  for (const seg of meeting.segments) if (!index.has(seg.id)) {
    target.segments.push(seg);
    index.set(seg.id, seg);
  }
  target.segments.sort((a, b) => a.startedAt - b.startedAt);
  target.screenshots.push(...meeting.screenshots);
  Object.assign(target.participants, meeting.participants);
  if (meeting.notes.trim()) target.notes = `${target.notes.trim()}\n${meeting.notes.trim()}`.trim();
  target.refs = [...new Set([...(target.refs || []), ...(meeting.refs || [])])];
  revive(target, tabId);
  await bindTab(tabId, target.id);
  await removeMeeting(meeting.id, { keepScreenshots: true });
  markDirty(target);
  return target;
}

async function removeMeeting(id, { keepScreenshots = false } = {}) {
  const meeting = await loadMeeting(id);
  const keys = [`meeting:${id}`, ...(keepScreenshots ? [] : (meeting?.screenshots || []).map((s) => `shot:${s.id}`))];
  await chrome.storage.local.remove(keys);
  loaded.delete(id);
  dirty.delete(id);
  const rows = await indexRows();
  await chrome.storage.local.set({ meetingIndex: rows.filter((r) => r.id !== id) });
}

// Returns segments whose speaker name was filled in from the roster.
function addParticipants(meeting, people) {
  const named = new Map();
  for (const p of people) {
    if (p.id === null || p.id === undefined || !p.name) continue;
    meeting.participants[String(p.id)] = p.name;
    named.set(String(p.id), p.name);
  }
  return fillSpeakerNames(meeting, named);
}

// Some captions arrive before the speaker is on the roster and get a
// placeholder name; once the real name is known, fix them.
function fillSpeakerNames(meeting, names) {
  const fixed = [];
  if (!names.size) return fixed;
  for (const seg of meeting.segments) {
    if (seg.speakerResolved === false && names.has(seg.speakerId) && !meeting.speakerNames[seg.speakerId]) {
      seg.speaker = names.get(seg.speakerId);
      seg.speakerResolved = true;
      fixed.push(seg);
    }
  }
  return fixed;
}

async function autoTag(meeting) {
  if (!meeting.tagsAuto || !meeting.title) return;
  Earshot.autoTag(meeting, await settings());
}

function markDirty(meeting) {
  meeting.updatedAt = new Date().toISOString();
  dirty.add(meeting.id);
  if (!flushTimer) flushTimer = setTimeout(flushLater, FLUSH_AFTER_MS);
}
const flushLater = () => flush().catch((err) => console.warn("Earshot: couldn't save to Chrome storage", err));

const summaryOf = Earshot.summaryOf;

// Meetings the Mac app writes on disk too. The Mac panel is their other
// writer, so Chrome follows the helper's base protocol for them: each save
// names the disk copy it was built on (`diskBase`, kept on Chrome's copy
// only), and a save refused as stale takes the disk copy, redoes Chrome's
// unsaved changes on it (a log, as the Mac panel keeps) and tries again.
// Chrome writes one of these only to carry a change made here, and takes a
// newer disk copy on opening one, before every edit, and around AI calls.
const DISK_EDITED = new Set(["teams-desktop", "zoom-desktop", "mac"]);
const fromDisk = new Set(); // ids whose next flush stores a copy in Chrome only
const diskLogs = new Map(); // id -> changes made here, not yet on disk
const DISK_SAVE_ATTEMPTS = 3;
const recordKey = (id) => `page:${id}`; // the queue edits, imports and saves of one record share
const logOf = (id) => diskLogs.get(id) || diskLogs.set(id, []).get(id);
const replayHooks = { settings, saveTags: async () => {}, removeShot: async () => {} };

// Into Chrome storage without a helper save: it came from disk, or was just saved there.
function keepInChrome(rec) {
  fromDisk.add(rec.id);
  dirty.add(rec.id);
  return flush();
}

// A copy from disk goes into Chrome when Chrome has none, or an older one
// (for a Mac meeting: one written by someone else since Chrome's last look).
// It isn't written back to disk, where it came from, unless Chrome has
// unsaved changes, which are redone on it.
async function importMeeting(incoming) {
  const m = upgrade(structuredClone(incoming));
  const existing = await loadMeeting(m.id);
  const diskEdited = DISK_EDITED.has(m.platform);
  const newer = Date.parse(m.updatedAt) > (Date.parse(existing?.updatedAt) || 0);
  if (existing && !(newer && (!diskEdited || m.updatedAt !== existing.diskBase))) return false;
  clearTimeout(helperTimers.get(m.id));
  helperTimers.delete(m.id);
  if (diskEdited) {
    m.diskBase = incoming.updatedAt ?? null;
    for (const entry of diskLogs.get(m.id) || []) await Earshot.redoChange(m, entry, replayHooks);
  }
  loaded.set(m.id, m);
  await keepInChrome(m);
  if (diskLogs.get(m.id)?.length) saveDiskEdited(m.id);
  return true;
}

// Only from work already in the record's queue (recordKey).
async function refreshFromDisk(id) {
  if (!(await helperInfo())) return false;
  let disk;
  try {
    disk = await callHelper("get-meeting", { id });
  } catch {
    return false;
  }
  if (!disk || typeof disk !== "object" || disk.id !== id) return false;
  return importMeeting(disk);
}

// The newest copy of a Mac meeting, from its queue.
const freshDiskCopy = (id) => enqueue(recordKey(id), async () => (await refreshFromDisk(id), loadMeeting(id)));

// A change to a Mac meeting from here (a chat, minutes, filing), made on the
// newest copy and logged until it's on disk.
function changeDiskEdited(id, entry) {
  return enqueue(recordKey(id), async () => {
    await refreshFromDisk(id);
    const rec = await loadMeeting(id);
    if (rec && (await Earshot.redoChange(rec, entry, replayHooks))) {
      logOf(id).push(entry);
      markDirty(rec);
    }
    return rec;
  });
}

// Saves of a Mac meeting go one at a time in its queue; resolves once tried.
function saveDiskEdited(id) {
  return enqueue(recordKey(id), () => saveDiskEditedNow(id)).catch((err) => console.warn("Earshot: helper save failed", err));
}

async function saveDiskEditedNow(id) {
  const log = diskLogs.get(id);
  if (!log?.length || !(await helperInfo())) return;
  for (let attempt = 0; attempt < DISK_SAVE_ATTEMPTS && log.length; attempt++) {
    const rec = await loadMeeting(id);
    if (!rec) return;
    const sent = log.length;
    const base = rec.diskBase ?? null;
    const { diskBase, ...meeting } = rec;
    meeting.updatedAt = Earshot.stampAfter(base);
    const res = await callHelper("save-meeting", { meeting, base });
    if (!res?.stale) {
      rec.updatedAt = rec.diskBase = meeting.updatedAt;
      log.splice(0, sent);
      await keepInChrome(rec);
      return;
    }
    // Written since by the Mac panel: its copy, with Chrome's changes redone on it.
    // (A helper from before `base` refuses without sending the copy.)
    let disk = res.meeting?.id === id ? res.meeting : null;
    if (!disk) disk = await callHelper("get-meeting", { id }).catch(() => null);
    if (!disk || disk.id !== id) break;
    const next = upgrade(structuredClone(disk));
    next.diskBase = disk.updatedAt ?? null;
    for (const entry of log) await Earshot.redoChange(next, entry, replayHooks);
    loaded.set(id, next);
    await keepInChrome(next);
    await broadcastMeeting(next);
  }
  if (log.length) console.warn(`Earshot: couldn't save ${id}; the disk copy kept changing`);
}

// Saves go one at a time: two at once each read the meeting list, and the
// second write dropped the first one's row.
const FLUSH_RETRY_MS = 5000;
let flushChain = Promise.resolve();
function flush() {
  const run = flushChain.then(flushNow);
  flushChain = run.catch(() => {});
  return run;
}

async function flushNow() {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  const ids = [...dirty];
  dirty.clear();
  if (!ids.length) return;
  const meetingIndex = await indexRows();
  const writes = {};
  const wasFromDisk = [];
  for (const id of ids) {
    const meeting = loaded.get(id);
    if (!meeting || discarded.has(id)) continue;
    writes[`meeting:${id}`] = meeting;
    const row = summaryOf(meeting);
    const at = meetingIndex.findIndex((r) => r.id === id);
    if (at >= 0) meetingIndex[at] = row;
    else meetingIndex.push(row);
    if (fromDisk.delete(id)) wasFromDisk.push(id);
    else syncToHelper(meeting);
  }
  writes.meetingIndex = meetingIndex.filter((r) => !discarded.has(r.id));
  try {
    await chrome.storage.local.set(writes);
  } catch (err) {
    // The write failed (storage full, disk trouble): these stay unsaved and are tried again.
    for (const id of ids) dirty.add(id);
    for (const id of wasFromDisk) fromDisk.add(id);
    if (!flushTimer) flushTimer = setTimeout(flushLater, FLUSH_RETRY_MS);
    throw err;
  }
  // Deleted while this save was being put together: delete again.
  for (const id of ids) if (discarded.has(id)) await chrome.storage.local.remove(`meeting:${id}`);
}

// ---------------------------------------------------------------- panel relay

function toPanel(tabId, payload) {
  chrome.tabs.sendMessage(tabId, { kind: "overlay", ...payload }, { frameId: 0 }).catch(() => {});
}

// `extra` carries a capture-health problem: { health: code, hint, retry }.
function setStatus(tabId, level, text, extra) {
  const status = { level, text, ...extra };
  tabStatus.set(tabId, status);
  toPanel(tabId, { type: "status", status });
  queueBrowserState();
}

// ---------------------------------------------------------------- capture health

// Each page hook reports how capture is going when a call starts and every
// 15 s after (see Earshot.captureProblem). A report with real evidence that
// nothing is being captured turns the panel red with the reason, tells the
// Mac app (so it can offer to record) and sends one notification. Captions
// arriving clear it, as they clear any other status.
const healthKey = (tabId) => `health:${tabId}`;
const tabHook = new Map(); // tab id -> hook version on the tab's latest page event (0: an older hook)
const healthGrace = new Map(); // tab id -> when "no captions while people talk" may be raised again (after Try again)
const healthNotified = new Map(); // tab id -> when the last health notification went out
const HEALTH_GRACE_MS = 45000;
const HEALTH_NOTIFY_EVERY_MS = 5 * 60 * 1000;

async function onHealth(tab, msg) {
  chrome.storage.session.set({ [healthKey(tab.id)]: { ...msg, at: Date.now() } }).catch(() => {});
  const problem = Earshot.captureProblem(msg, Earshot.platformLabel(msg.platform));
  if (!problem) return;
  const shown = tabStatus.get(tab.id);
  if (shown?.health === problem.code || shown?.level === "paused" || shown?.level === "ended") return;
  if ((problem.code === "silent" || problem.code === "unread") && Date.now() < (healthGrace.get(tab.id) || 0)) return;
  if (await isPaused(tab.id)) return;
  const meeting = await meetingForTab(tab, null, false);
  const live = !!meeting && !meeting.endedAt;
  // A hook that came in late can't see the call, so there is no meeting; any
  // other problem is about the meeting being captured.
  if (problem.code === "late" ? live : !live) return;
  if (live && meeting.macCapture === "running") return; // the Mac app is recording it
  setStatus(tab.id, "problem", problem.text, { health: problem.code, hint: problem.hint, retry: problem.retry !== false });
  if (live) await setCaptionsOff(tab.id, meeting.id, true);
  if (Date.now() - (healthNotified.get(tab.id) || 0) < HEALTH_NOTIFY_EVERY_MS) return;
  healthNotified.set(tab.id, Date.now());
  chrome.notifications.create(`earshot-captions:${tab.id}`, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: "Earshot: nothing is being captured",
    message: `${live ? `"${Earshot.titleOf(meeting)}": ` : ""}${problem.hint}`,
    priority: 2,
  });
}

// ---------------------------------------------------------------- browser state for the Mac app

// The Mac app offers to record when a browser meeting has no captions, so
// ~/Earshot/run/browser.json (through the helper) says, per live meeting tab,
// whether captions are arriving: "waiting" before any, "off" once the panel
// gave up waiting, "arriving", or "lost" when they stopped for
// captionsLostSeconds. It's rewritten on every change and every 30 s while a
// meeting is live; the Mac app treats it as stale after 90 s.
const BROWSER_ALARM = "earshot-browser-state";
const captionWatch = new Map(); // tab id -> { meetingId, off, lastAt, reported, savedAt }
// Mirrored to session storage (lastAt every few seconds at most), so a worker
// restart keeps "off" and "lost".
const captionKey = (tabId) => `captions:${tabId}`;

async function captionEntry(tabId, meetingId) {
  let entry = captionWatch.get(tabId);
  if (!entry) {
    const saved = (await chrome.storage.session.get(captionKey(tabId)))[captionKey(tabId)];
    if (saved) captionWatch.set(tabId, (entry = { ...saved, reported: null, savedAt: saved.lastAt }));
  }
  if (!entry || entry.meetingId !== meetingId) captionWatch.set(tabId, (entry = { meetingId, off: false, lastAt: 0, reported: null, savedAt: 0 }));
  return entry;
}

function saveCaptionEntry(tabId, entry, force = false) {
  if (!force && entry.lastAt - entry.savedAt < 5000) return;
  entry.savedAt = entry.lastAt;
  chrome.storage.session.set({ [captionKey(tabId)]: { meetingId: entry.meetingId, off: entry.off, lastAt: entry.lastAt } }).catch(() => {});
}

async function setCaptionsOff(tabId, meetingId, off) {
  const entry = await captionEntry(tabId, meetingId);
  entry.off = off;
  saveCaptionEntry(tabId, entry, true);
  queueBrowserState();
}

function captionsState(entry, lostSeconds) {
  if (entry.off) return "off";
  if (!entry.lastAt) return "waiting";
  return Date.now() - entry.lastAt < lostSeconds * 1000 ? "arriving" : "lost";
}

// Only the platform's own captions count here, never merged Mac lines.
async function noteCaption(tabId, meetingId) {
  const entry = await captionEntry(tabId, meetingId);
  const wasOff = entry.off;
  entry.off = false;
  entry.lastAt = Date.now();
  saveCaptionEntry(tabId, entry, wasOff);
  if (entry.reported !== "arriving") queueBrowserState();
}

let browserStateTimer = null;
function queueBrowserState() {
  clearTimeout(browserStateTimer);
  browserStateTimer = setTimeout(() => reportBrowserState().catch(() => {}), 250);
}

let browserStateChain = Promise.resolve();
function reportBrowserState() {
  clearTimeout(browserStateTimer);
  browserStateTimer = null;
  const run = browserStateChain.then(writeBrowserState);
  browserStateChain = run.catch(() => {});
  return run;
}

async function writeBrowserState() {
  const { captionsLostSeconds } = await settings();
  const meetings = [];
  for (const [key, id] of Object.entries(await chrome.storage.session.get(null))) {
    if (!key.startsWith("tab:")) continue;
    const tabId = Number(key.slice(4));
    const meeting = await loadMeeting(id);
    if (!meeting || meeting.endedAt) continue;
    const entry = await captionEntry(tabId, meeting.id);
    entry.reported = captionsState(entry, captionsLostSeconds);
    meetings.push({ meetingId: meeting.id, tabId, platform: meeting.platform, title: Earshot.titleOf(meeting), captions: entry.reported, startedAt: meeting.startedAt, paused: await isPaused(tabId) });
  }
  if (!meetings.length) await chrome.alarms.clear(BROWSER_ALARM);
  else if (!(await chrome.alarms.get(BROWSER_ALARM))) await chrome.alarms.create(BROWSER_ALARM, { periodInMinutes: 0.5 });
  if (!(await helperInfo())) return;
  await callNewOp("browser-state", { meetings });
}

// ---------------------------------------------------------------- lines from the Mac app

// The Mac app records a browser meeting without captions into the same
// record. Each capture's lines (ids "mac-<captureId>-...") arrive whole, again
// as they grow; `done` marks its last write. An ended meeting takes them too.
const MAC_STATUS = "Capturing with Mac audio";

async function tabOfMeeting(meetingId) {
  for (const [key, id] of Object.entries(await chrome.storage.session.get(null))) if (key.startsWith("tab:") && id === meetingId) return Number(key.slice(4));
  return null;
}

async function takeMacSegments({ meetingId, captureId, segments, done }) {
  if (typeof meetingId !== "string" || typeof captureId !== "string" || !Array.isArray(segments)) return;
  const tabId = await tabOfMeeting(meetingId);
  const took = await enqueue(tabId ?? `page:${meetingId}`, async () => {
    const meeting = await loadMeeting(meetingId);
    if (!meeting) return null;
    const prefix = `mac-${captureId}-`;
    // Each push carries the capture's lines as recorded. Your fixes to them
    // stand: a renamed speaker always, a line's tag while the line is there,
    // and a text fix until the Whisper pass (done) rewrites the text.
    const before = new Map(meeting.segments.filter((s) => s.id.startsWith(prefix)).map((s) => [s.id, s]));
    const lines = segments
      .filter((s) => s && typeof s.id === "string" && s.id.startsWith(prefix) && Number.isFinite(s.startedAt))
      .map((raw) => {
        const seg = { ...raw };
        const name = meeting.speakerNames?.[seg.speakerId];
        if (name) {
          seg.speaker = name;
          seg.speakerResolved = true;
        }
        const was = before.get(seg.id);
        if (was?.reaction) seg.reaction = was.reaction;
        if (!done && was?.edited) {
          seg.text = was.text;
          seg.edited = true;
        }
        return seg;
      });
    const merged = Earshot.mergeMacSegments(meeting, captureId, lines);
    // The meeting's capture is "running" until every capture of it is done.
    const state = done ? "done" : "running";
    const stateChanged = meeting.macCaptures?.[captureId] !== state;
    if (stateChanged) {
      meeting.macCaptures = { ...(meeting.macCaptures || {}), [captureId]: state };
      meeting.macCapture = Object.values(meeting.macCaptures).includes("running") ? "running" : "done";
    }
    if (merged || stateChanged) {
      markDirty(meeting);
      await broadcastMeeting(meeting);
    }
    // A paused tab stays paused; resuming shows the Mac capture.
    if (tabId !== null && !meeting.endedAt && !(await isPaused(tabId))) {
      const shown = tabStatus.get(tabId)?.text;
      if (meeting.macCapture === "running") {
        if (shown !== MAC_STATUS) setStatus(tabId, "live", MAC_STATUS);
      } else if (shown === MAC_STATUS) {
        const entry = await captionEntry(tabId, meeting.id);
        if (captionsState(entry, (await settings()).captionsLostSeconds) === "arriving") setStatus(tabId, "live", "Capturing");
        else setStatus(tabId, "waiting", "Waiting for captions…");
      }
    }
    return { late: !!meeting.endedAt && (merged || (stateChanged && done)) };
  });
  if (!took) return;
  // A repeated done frame (it can come once more after the ack) is acked again, harmlessly.
  if (done) await callNewOp("mac-segments-ack", { meetingId, captureId, done: true });
  // Lines for a meeting that already ended (captions were off, the helper link
  // was down, or this is the Whisper pass) may be all its minutes have to go on.
  if (took.late) await minutesAfterMacLines(meetingId);
}

// Tell every view of this meeting (its tab's panel, any meetings page) it changed.
async function broadcastMeeting(meeting) {
  const tabs = await chrome.storage.session.get(null);
  for (const [key, id] of Object.entries(tabs)) {
    if (key.startsWith("tab:") && id === meeting.id) toPanel(Number(key.slice(4)), { type: "meeting-full", meeting });
  }
  chrome.runtime.sendMessage({ kind: "meeting-changed", id: meeting.id }).catch(() => {});
}

const pausedKey = (tabId) => `paused:${tabId}`;
// "Don't record this meeting": the tab's meeting was deleted; its events are ignored until that call ends.
const skipKey = (tabId) => `skip:${tabId}`;
async function skippedRefs(tabId) {
  return (await chrome.storage.session.get(skipKey(tabId)))[skipKey(tabId)] || null;
}
async function isPaused(tabId) {
  return !!(await chrome.storage.session.get(pausedKey(tabId)))[pausedKey(tabId)];
}

// ---------------------------------------------------------------- ending a meeting

async function endMeeting(tabId, meeting) {
  if (!meeting || meeting.endedAt) return;
  meeting.endedAt = new Date().toISOString();
  markDirty(meeting);
  // A failed Chrome save (it is retried) must not stop the file copy, the panel's "ended" or the minutes.
  await flush().catch((err) => console.warn("Earshot: couldn't save the ended meeting to Chrome storage", err));
  await syncToHelper(meeting, true);
  if (tabId !== undefined) {
    tabStatus.delete(tabId);
    toPanel(tabId, { type: "ended", meeting: summaryOf(meeting) });
  }
  queueBrowserState();
  await scheduleSavedNotice(meeting);
  const { autoMinutes, minutesDelayMinutes } = await settings();
  // A Mac capture still going may bring the lines yet.
  if (!autoMinutes || (meeting.segments.length < 5 && meeting.macCapture !== "running")) return;
  // A refresh, a rejoin or a browser restart ends a meeting for a moment; the
  // minutes (and the vault note) wait, and are dropped if it comes back.
  if (minutesDelayMinutes > 0) chrome.alarms.create(minutesAlarm(meeting.id), { delayInMinutes: minutesDelayMinutes });
  else writeEndedMinutes(meeting.id);
}

const minutesAlarm = (id) => `earshot-minutes:${id}`;
const savedNotice = (id) => `earshot-saved:${id}`;

// A short while after a meeting ends, if it's still over, say it's saved. Clicking the
// notification opens the meeting on the meetings page.
async function scheduleSavedNotice(meeting) {
  const { notifyEnded, endedNoticeSeconds } = await settings();
  if (notifyEnded === false || !meeting.segments?.length) return;
  if (endedNoticeSeconds > 0) chrome.alarms.create(savedNotice(meeting.id), { delayInMinutes: endedNoticeSeconds / 60 });
  else await notifySaved(meeting.id);
}

async function notifySaved(id) {
  const meeting = await loadMeeting(id);
  if (!meeting?.endedAt) return;
  const { autoMinutes } = await settings();
  const length = Math.max(1, Math.round((Date.parse(meeting.endedAt) - Date.parse(meeting.startedAt)) / 60000));
  const lines = meeting.segments.length;
  const minutes = !autoMinutes || lines < 5 ? "" : meeting.minutes ? " Minutes are ready." : " Minutes follow shortly.";
  chrome.notifications.create(savedNotice(id), {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: "Earshot: meeting saved",
    message: `"${Earshot.titleOf(meeting)}" · ${length} min · ${lines} ${lines === 1 ? "line" : "lines"}.${minutes} Click to open it.`,
    priority: 1,
  });
}
const MAC_WAIT_MINUTES = 2;
// Automatic minutes that fail (the AI timed out, was busy, or the helper was
// away) are tried again: 5 minutes later, then 15. The count is on the record,
// so a worker restart keeps it. A signed-out AI isn't retried (the sign-in
// warning covers it), and after the last try one notification says so.
const MINUTES_RETRY_MINUTES = [5, 15];
const MINUTES_FAILED = "earshot-minutes-failed:";
const MAC_WAIT_CAP_MS = 3 * 60 * 60 * 1000; // a Mac capture that never says done stops holding the minutes
const minutesWriting = new Set();

// Minutes for a meeting that's still over when its wait is up. While the Mac
// app is still recording or transcribing it, they wait for its lines (up to
// 3 hours after the meeting ended; then they're written from what's there).
async function writeEndedMinutes(id) {
  const meeting = await loadMeeting(id);
  if (!meeting || !meeting.endedAt || minutesWriting.has(id)) return;
  if (meeting.macCapture === "running" && Date.now() - Date.parse(meeting.endedAt) < MAC_WAIT_CAP_MS) {
    chrome.alarms.create(minutesAlarm(id), { delayInMinutes: MAC_WAIT_MINUTES });
    await helperInfo(); // connected, so the lines (and the done) can come in
    return;
  }
  await chrome.alarms.clear(minutesAlarm(id));
  if (meeting.segments.length < 5 || meeting.minutes) return;
  minutesWriting.add(id);
  try {
    await generateMinutes(meeting).catch((err) => minutesFailed(meeting, err));
  } finally {
    minutesWriting.delete(id);
  }
}

async function minutesFailed(meeting, err) {
  console.warn("Earshot: minutes failed", err);
  const error = String(err?.message || err);
  meeting.minutesError = error;
  meeting.minutesAttempts = (meeting.minutesAttempts || 0) + 1;
  markDirty(meeting);
  await flushLater();
  checkAi().catch(() => {});
  const signedOut = /isn't signed in|sign-in has expired/i.test(error);
  const wait = MINUTES_RETRY_MINUTES[meeting.minutesAttempts - 1];
  if (!signedOut && wait !== undefined) {
    chrome.alarms.create(minutesAlarm(meeting.id), { delayInMinutes: wait });
    return;
  }
  await chrome.notifications.create(`${MINUTES_FAILED}${meeting.id}`, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: "Earshot: no minutes for this meeting",
    message: `Minutes for "${Earshot.titleOf(meeting)}" couldn't be written${signedOut ? " because the AI isn't signed in" : ` after ${meeting.minutesAttempts} tries`}. The transcript is saved. Click to open it and use Generate minutes.`,
    priority: 1,
  });
}

// Mac lines came into an ended meeting that has no minutes: they're written
// after the usual wait (or now, when the Mac capture is done and there's no wait).
async function minutesAfterMacLines(id) {
  const meeting = await loadMeeting(id);
  const { autoMinutes, minutesDelayMinutes } = await settings();
  if (!meeting?.endedAt || meeting.minutes || !autoMinutes) return;
  const pending = await chrome.alarms.get(minutesAlarm(id));
  if (minutesDelayMinutes > 0) {
    if (!pending) chrome.alarms.create(minutesAlarm(id), { delayInMinutes: minutesDelayMinutes });
  } else if (meeting.macCapture !== "running" || !pending) await writeEndedMinutes(id);
}

// A meeting that had ended is back (rejoin, refresh, browser restart, captions
// again): its pending minutes are dropped, and its panel shows it as live.
function revive(meeting, tabId, [level, text] = ["live", "Capturing"]) {
  if (!meeting?.endedAt) return;
  meeting.endedAt = null;
  chrome.alarms.clear(minutesAlarm(meeting.id));
  chrome.alarms.clear(savedNotice(meeting.id));
  chrome.notifications.clear(savedNotice(meeting.id));
  if (tabId !== undefined) setStatus(tabId, level, text);
}

async function generateMinutes(meeting, { file = true } = {}) {
  if (DISK_EDITED.has(meeting.platform)) return generateDiskMinutes(meeting.id, { file });
  const res = await callHelper("minutes", { meeting });
  Earshot.applyMinutes(meeting, res);
  markDirty(meeting);
  await flush();
  await syncToHelper(meeting, true);
  if (file) await fileToVault(meeting, { auto: true }).catch((err) => console.warn("Earshot: vault filing failed", err));
  await broadcastMeeting(meeting);
  return meeting.minutes;
}

// A Mac meeting's minutes: written from its newest copy, and put on the
// newest copy when the AI is done (the Mac panel may have written meanwhile).
async function generateDiskMinutes(id, { file }) {
  const res = await callHelper("minutes", { meeting: await freshDiskCopy(id) });
  await changeDiskEdited(id, { kind: "minutes", res, at: new Date().toISOString() });
  await saveDiskEdited(id);
  if (file) await fileToVault(await loadMeeting(id), { auto: true }).catch((err) => console.warn("Earshot: vault filing failed", err));
  const rec = await loadMeeting(id);
  await broadcastMeeting(rec);
  return rec.minutes;
}

// Put the meeting's note in the Obsidian vault (and its line in the daily
// note). `auto` respects the "file automatically" setting.
async function fileToVault(meeting, { auto = false } = {}) {
  if (DISK_EDITED.has(meeting.platform)) {
    const id = meeting.id;
    await saveDiskEdited(id); // changes from here first, so the note has them
    const res = await callHelper("file-to-vault", { meeting: await freshDiskCopy(id), auto });
    await changeDiskEdited(id, { kind: "filing", res, at: new Date().toISOString() });
    await saveDiskEdited(id);
    return res;
  }
  await syncToHelper(meeting, true);
  const res = await callHelper("file-to-vault", { meeting, auto });
  Earshot.applyFiling(meeting, res);
  markDirty(meeting);
  await flush();
  await syncToHelper(meeting, true);
  return res;
}

// ---------------------------------------------------------------- vault sync
// Every hour (and when the meetings page opens) the helper compares each filed meeting with its
// note in the vault, found by earshot_id: a title the vault agent or you changed there comes back here, a
// title changed here is filed again, and a note deleted from the vault is marked on the meeting.
// The rules are in helper/vault.js; meetings only on disk are changed by the helper itself.
const VAULT_SYNC_ALARM = "earshot-vault-sync";
const VAULT_SYNC_MINUTES = 60;
let vaultSyncRun = null;
let vaultSyncAt = 0;
const SYNC_KEYS = ["id", "title", "meetingRef", "platform", "source", "tags", "startedAt", "vaultNote", "lastFiling", "vaultMissing", "vaultTitle"];

function runVaultSync({ force = false } = {}) {
  if (vaultSyncRun) return vaultSyncRun;
  if (!force && Date.now() - vaultSyncAt < 60 * 1000) return Promise.resolve({ ok: true, skipped: true });
  vaultSyncRun = vaultSyncNow()
    .catch((err) => (console.warn("Earshot: vault sync failed", err), { ok: false, error: String(err?.message || err) }))
    .finally(() => {
      vaultSyncAt = Date.now();
      vaultSyncRun = null;
    });
  return vaultSyncRun;
}

async function vaultSyncNow() {
  if (!(await helperInfo())) return { ok: false, error: "The helper isn't connected." };
  await flush();
  const held = [];
  for (const row of await indexRows()) {
    const m = await loadMeeting(row.id);
    if (m) held.push(Object.fromEntries(SYNC_KEYS.filter((k) => k in m).map((k) => [k, m[k]])));
  }
  const res = await callHelper("vault-sync", { held });
  if (!res?.ok) return res || { ok: false };
  let changed = 0;
  for (const r of res.results || []) {
    if (await applyVaultResult(r).catch((err) => console.warn(`Earshot: vault sync of ${r.id} failed`, err))) changed++;
  }
  return { ok: true, changed, changedOnDisk: res.changedOnDisk || 0, checkedAt: res.checkedAt };
}

async function applyVaultResult(r) {
  const req = { action: "vault-sync", patch: r.patch || {}, at: new Date().toISOString() };
  const first = await loadMeeting(r.id);
  if (!first) return false;
  if (DISK_EDITED.has(first.platform)) {
    if (Object.keys(req.patch).length) {
      await changeDiskEdited(r.id, { kind: "action", req });
      await saveDiskEdited(r.id);
    }
  } else if (Object.keys(req.patch).length) {
    await enqueue(recordKey(r.id), async () => {
      const meeting = await loadMeeting(r.id);
      if (!meeting || !Earshot.applyVaultSync(meeting, req.patch, req.at)) return;
      markDirty(meeting);
      await flush();
      await syncToHelper(meeting, true);
    });
  }
  // Renamed here since it was filed: filed again, so the vault has the new title (if filing is automatic).
  if (r.refile) await fileToVault(await loadMeeting(r.id), { auto: true });
  await broadcastMeeting(await loadMeeting(r.id));
  return true;
}

// ---------------------------------------------------------------- page events

async function onPageEvent(msg, sender) {
  const tab = sender.tab;
  tabHook.set(tab.id, msg.hook || 0);
  const skip = await skippedRefs(tab.id);
  if (skip) {
    const left = msg.type === "join-status" && msg.status !== "joined";
    const nextCall = msg.type === "join-status" && msg.status === "joined" && !!msg.ref && !skip.refs.includes(msg.ref);
    if (left || nextCall) await chrome.storage.session.remove(skipKey(tab.id));
    if (!nextCall) return;
  }
  const label = Earshot.platformLabel(msg.platform);
  switch (msg.type) {
    case "health": {
      await onHealth(tab, msg);
      break;
    }
    case "store-found": {
      if (msg.hasCaptions) setStatus(tab.id, "waiting", `Connected to ${label}. Waiting for captions…`);
      else setStatus(tab.id, "problem", `Found ${label}'s meeting data but no captions. Use Debug info.`);
      break;
    }
    case "join-status": {
      if (msg.status === "joined") {
        const meeting = await meetingForTab(tab, msg, true);
        revive(meeting, tab.id, ["waiting", "Back in the meeting. Waiting for captions…"]);
        if (msg.ref && !meeting.refs?.includes(msg.ref)) meeting.refs = [...(meeting.refs || []), msg.ref];
        checkAi({ live: true }).catch(() => {});
        markDirty(meeting);
        toPanel(tab.id, { type: "meeting-full", meeting });
        queueBrowserState();
      } else {
        await endMeeting(tab.id, await meetingForTab(tab, msg, false));
      }
      break;
    }
    case "title": {
      let meeting = await meetingForTab(tab, msg, true);
      // Your own name for the meeting wins; a code-only fallback never replaces a real title.
      if (meeting.titleEdited || (msg.fallback && meeting.title)) break;
      meeting.title = msg.title;
      if (!msg.fallback) meeting = await mergeIntoEarlier(tab.id, meeting);
      await autoTag(meeting);
      markDirty(meeting);
      toPanel(tab.id, { type: "meeting-full", meeting });
      break;
    }
    case "caption-language": {
      const meeting = await meetingForTab(tab, msg, false);
      if (meeting) {
        meeting.captionLanguage = msg.language;
        markDirty(meeting);
        toPanel(tab.id, { type: "meeting", meeting: summaryOf(meeting) });
      }
      break;
    }
    case "language-result": {
      toPanel(tab.id, { type: "toast", text: msg.ok ? "Caption language changed" : `Couldn't change the language here. Change it in ${label}'s caption settings.` });
      break;
    }
    case "captions": {
      if (await isPaused(tab.id)) {
        // Not kept, but captions are coming: the Mac app needn't offer to record.
        const id = await tabMeetingId(tab.id);
        if (id) await noteCaption(tab.id, id);
        break;
      }
      const meeting = await meetingForTab(tab, msg, true);
      await noteCaption(tab.id, meeting.id);
      revive(meeting, tab.id);
      const index = segmentsById(meeting);
      const changed = [];
      const knownNames = new Map();
      for (const c of msg.captions) {
        const renamed = meeting.speakerNames[c.speakerId];
        const speaker = renamed || c.speaker;
        const resolved = renamed ? true : c.speakerResolved;
        let seg = index.get(c.id);
        if (seg) {
          // Your edits stand even when the platform revises the caption later.
          if (!seg.edited) seg.text = c.text;
          // A segment can't fall back to a placeholder once it has a real name.
          if (!(seg.speakerResolved !== false && resolved === false)) {
            seg.speaker = speaker;
            seg.speakerResolved = resolved;
          }
          seg.lastAt = c.at;
        } else {
          const rosterName = resolved === false ? meeting.participants[c.speakerId] : null;
          seg = {
            id: c.id,
            speakerId: c.speakerId,
            speaker: rosterName || speaker,
            speakerResolved: rosterName ? true : resolved,
            text: c.text,
            language: c.language,
            startedAt: c.at,
            lastAt: c.at,
          };
          meeting.segments.push(seg);
          index.set(c.id, seg);
        }
        if (seg.speakerResolved !== false) knownNames.set(seg.speakerId, seg.speaker);
        changed.push(seg);
      }
      changed.push(...fillSpeakerNames(meeting, knownNames).filter((s) => !changed.includes(s)));
      markDirty(meeting);
      toPanel(tab.id, { type: "segments", segments: changed, meeting: summaryOf(meeting) });
      if (tabStatus.get(tab.id)?.level !== "live") setStatus(tab.id, "live", "Capturing");
      break;
    }
    case "roster": {
      const meeting = await meetingForTab(tab, msg, false);
      if (!meeting) {
        pendingRoster.set(tab.id, [...(pendingRoster.get(tab.id) || []), ...msg.people]);
        break;
      }
      const fixed = addParticipants(meeting, msg.people);
      markDirty(meeting);
      if (fixed.length) toPanel(tab.id, { type: "segments", segments: fixed, meeting: summaryOf(meeting) });
      break;
    }
    case "captions-request": {
      if (tabStatus.get(tab.id)?.level === "live") break;
      if (msg.ok) setStatus(tab.id, "waiting", `Asked ${label} to turn on captions. Waiting for speech…`);
      else setStatus(tab.id, "problem", msg.hint || `Couldn't turn captions on automatically. Turn them on in ${label}.`);
      break;
    }
    case "diagnostics": {
      toPanel(tab.id, { type: "diagnostics", frameUrl: sender.url, data: msg.data });
      break;
    }
  }
}

function enqueue(tabId, work) {
  const next = (tabQueues.get(tabId) || Promise.resolve()).then(work).catch((err) => {
    console.error("Earshot:", err);
    throw err;
  });
  tabQueues.set(tabId, next.catch(() => {}));
  return next;
}

// ---------------------------------------------------------------- edits from the panel and meetings page

// The edits themselves live in shared/meeting-core.js; the hooks are the Chrome-specific parts.
async function applyAction(meeting, req) {
  const hooks = {
    settings,
    saveTags: (tags) => chrome.storage.local.set({ tags }),
    async removeShot(shotId) {
      await chrome.storage.local.remove(`shot:${shotId}`);
      if (await helperInfo()) callHelper("delete-screenshot", { meeting, shotId }).catch(() => {});
    },
  };
  if (!(await Earshot.applyAction(meeting, req, hooks))) return false;
  markDirty(meeting);
  return true;
}

async function addScreenshot(meeting, req) {
  const shot = Earshot.screenshotRecord(meeting.id, req);
  await chrome.storage.local.set({ [`shot:${shot.id}`]: req.dataUrl });
  meeting.screenshots.push(shot);
  markDirty(meeting);
  if (await helperInfo()) callHelper("save-screenshot", { meeting, shot, dataUrl: req.dataUrl }).catch((err) => console.warn("Earshot: screenshot file", err));
  return shot;
}

async function askAi(meeting, question) {
  const at = Date.now();
  const q = String(question).trim();
  const diskEdited = DISK_EDITED.has(meeting.platform);
  if (diskEdited) meeting = await freshDiskCopy(meeting.id);
  let outcome;
  try {
    outcome = await callHelper("ask", { meeting, question: q });
  } catch (err) {
    outcome = err instanceof Error ? err : new Error(String(err));
  }
  const chat = Earshot.chatFor(q, outcome, at);
  if (chat.error && /signed in|sign-in|authenticat|oauth|expired/i.test(chat.error)) checkAi().catch(() => {});
  if (diskEdited) {
    // Onto the newest copy: the Mac panel may have written while the AI answered.
    await changeDiskEdited(meeting.id, { kind: "chat", chat });
    await saveDiskEdited(meeting.id);
    await broadcastMeeting(await loadMeeting(meeting.id));
    return chat;
  }
  meeting.chats.push(chat);
  markDirty(meeting);
  await broadcastMeeting(meeting);
  return chat;
}

// Whole meeting plus every screenshot's image, for exports.
async function meetingWithImages(id) {
  const meeting = await loadMeeting(id);
  if (!meeting) return null;
  const keys = meeting.screenshots.map((s) => `shot:${s.id}`);
  const images = keys.length ? await chrome.storage.local.get(keys) : {};
  return { ...meeting, screenshots: meeting.screenshots.map((s) => ({ ...s, dataUrl: images[`shot:${s.id}`] || null })) };
}

// ---------------------------------------------------------------- tabs closing or leaving the meeting

// A meeting still "live" with nothing captured for STALE_MINUTES is over: the
// leave wasn't seen, the tab went while the worker slept, or captions stopped.
// Ending it writes the minutes and closes the panel; captions arriving again,
// or rejoining, bring the same meeting back to live. Paused meetings wait.
const STALE_MINUTES = 10;
async function endStaleMeetings() {
  // Live ones on disk, plus any held in memory that haven't been written yet.
  const live = new Set((await indexRows()).filter((r) => !r.endedAt).map((r) => r.id));
  for (const m of loaded.values()) if (!m.endedAt) live.add(m.id);
  if (!live.size) return;
  const tabOf = new Map();
  for (const [key, id] of Object.entries(await chrome.storage.session.get(null))) if (key.startsWith("tab:")) tabOf.set(id, Number(key.slice(4)));
  for (const id of live) {
    const meeting = await loadMeeting(id);
    if (!meeting || meeting.endedAt) continue;
    if (DISK_EDITED.has(meeting.platform)) continue; // the Mac app ends its own meetings
    const last = meeting.segments.reduce((at, s) => Math.max(at, s.lastAt || s.startedAt || 0), Date.parse(meeting.startedAt) || 0);
    if (Date.now() - last < STALE_MINUTES * 60000) continue;
    const tab = tabOf.has(meeting.id) ? await chrome.tabs.get(tabOf.get(meeting.id)).catch(() => null) : null;
    if (tab && (await isPaused(tab.id))) continue;
    await enqueue(tab ? tab.id : `stale:${meeting.id}`, () => endMeeting(tab ? tab.id : undefined, meeting));
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  enqueue(tabId, async () => {
    const id = await tabMeetingId(tabId);
    if (id) {
      await endMeeting(undefined, await loadMeeting(id));
      await chrome.storage.session.remove([tabKey(tabId), pausedKey(tabId)]);
    }
    await chrome.storage.session.remove(skipKey(tabId));
    tabStatus.delete(tabId);
    tabQueues.delete(tabId);
    captionWatch.delete(tabId);
    tabHook.delete(tabId);
    healthGrace.delete(tabId);
    healthNotified.delete(tabId);
    await chrome.storage.session.remove([captionKey(tabId), healthKey(tabId)]);
  }).catch(() => {});
});

// Backstop for every platform: if the tab moves away from the meeting's
// address (back to the Meet home page, off the Zoom meeting, out of Teams),
// the meeting is over even if the app never said so.
function stillAtMeeting(meeting, url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (meeting.platform === "meet") return u.hostname === "meet.google.com" && (meeting.refs || [meeting.meetingRef]).some((r) => r && u.pathname.includes(r));
  if (meeting.platform === "zoom") return /(^|\.)zoom\.us$/.test(u.hostname) && /\/wc\//.test(u.pathname) && !/\/(leave|end|post)/i.test(u.pathname);
  return /teams\.(microsoft|live)\.com$|teams\.cloud\.microsoft$/.test(u.hostname);
}

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (!change.url) return;
  enqueue(tabId, async () => {
    const id = await tabMeetingId(tabId);
    const meeting = id && (await loadMeeting(id));
    if (meeting && !meeting.endedAt && !stillAtMeeting(meeting, change.url)) await endMeeting(tabId, meeting);
  }).catch(() => {});
});

// ---------------------------------------------------------------- messages

function respond(sendResponse, work) {
  work.then(sendResponse, (err) => {
    console.error("Earshot:", err);
    sendResponse({ error: String(err.message || err) });
  });
  return true;
}

// Requests about "this meeting" come from the panel (by tab) or the meetings page (by id).
async function targetMeeting(req, sender) {
  if (req.meetingId) return loadMeeting(req.meetingId);
  return sender.tab ? meetingForTab(sender.tab, null, false) : null;
}

// Keyboard shortcuts (chrome://extensions/shortcuts) go to the meeting tab's panel.
chrome.commands.onCommand.addListener(async (command, tab) => {
  const target = tab?.id ? tab : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (target?.id) chrome.tabs.sendMessage(target.id, { kind: "overlay", type: "command", command }).catch(() => {});
});

chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  switch (req.kind) {
    case "page-event":
      if (tabId !== undefined) enqueue(tabId, () => onPageEvent(req.msg, sender)).catch(() => {});
      return false;

    case "panel-hello":
      return respond(
        sendResponse,
        enqueue(tabId, async () => ({
          meeting: await meetingForTab(sender.tab, null, false),
          status: tabStatus.get(tabId) || null,
          paused: await isPaused(tabId),
          settings: await settings(),
          aiHealth: (await chrome.storage.session.get("aiHealth")).aiHealth || null,
        }))
      );

    case "panel-cmd":
      chrome.tabs.sendMessage(tabId, { kind: "page-cmd", cmd: req.cmd }).catch(() => {});
      return false;

    case "set-language":
      return respond(
        sendResponse,
        (async () => {
          await chrome.storage.local.set({ captionLanguage: req.id });
          if (tabId !== undefined) {
            chrome.tabs.sendMessage(tabId, { kind: "page-cmd", cmd: { type: "set-language", language: Earshot.languageById(req.id) } }).catch(() => {});
          }
          return { ok: true };
        })()
      );

    case "get-settings":
      return respond(sendResponse, settings());

    case "set-setting":
      return respond(sendResponse, chrome.storage.local.set({ [req.key]: req.value }).then(() => ({ ok: true })));

    // The panel gave up waiting for the first captions. The reason comes from
    // the hook's health report where it knows one; otherwise the usual guess.
    case "captions-off":
      return respond(
        sendResponse,
        (async () => {
          const meeting = await meetingForTab(sender.tab, null, false);
          if (meeting) setCaptionsOff(tabId, meeting.id, true).catch(() => {});
          const health = (await chrome.storage.session.get(healthKey(tabId)))[healthKey(tabId)];
          const cause = Earshot.noCaptionsCause(health, Earshot.platformLabel(meeting?.platform), tabHook.get(tabId));
          chrome.notifications.create(`earshot-captions:${tabId}`, {
            type: "basic",
            iconUrl: "icons/icon128.png",
            title: "Earshot: no captions",
            message: `Nothing is being captured${meeting ? ` in "${Earshot.titleOf(meeting)}"` : ""}. ${cause ? cause.hint : "If people are talking, the host has captions off: ask them to turn captions on."}`,
            priority: 2,
          });
          return cause ? { text: cause.text, hint: cause.hint, retry: cause.retry !== false } : {};
        })()
      );

    case "retry-captions":
      return respond(
        sendResponse,
        (async () => {
          const id = await tabMeetingId(tabId);
          if (id) await setCaptionsOff(tabId, id, false); // waiting again, as the panel is
          if (tabStatus.get(tabId)?.health) {
            // Give the request time to work before the same problem is raised again.
            healthGrace.set(tabId, Date.now() + HEALTH_GRACE_MS);
            setStatus(tabId, "waiting", "Asked for captions again. Waiting for speech…");
          }
          const { captionLanguage } = await settings();
          await chrome.tabs.sendMessage(tabId, { kind: "page-cmd", cmd: { type: "enable-captions", language: Earshot.languageById(captionLanguage) } }).catch(() => {});
          return { ok: true };
        })()
      );

    case "set-paused":
      return respond(
        sendResponse,
        (async () => {
          await chrome.storage.session.set({ [pausedKey(tabId)]: !!req.value });
          const macRunning = !req.value && (await meetingForTab(sender.tab, null, false))?.macCapture === "running";
          setStatus(tabId, req.value ? "paused" : "live", req.value ? "Paused. Click play to resume." : macRunning ? MAC_STATUS : "Capturing");
          return { paused: !!req.value };
        })()
      );

    case "meeting-action":
      return respond(
        sendResponse,
        // The meetings page names the meeting: its edits share the record's queue
        // with imports and saves. The in-meeting panel's go in its tab's queue.
        enqueue(req.meetingId ? recordKey(req.meetingId) : tabId, async () => {
          let meeting = await targetMeeting(req, sender);
          if (!meeting) return { ok: false };
          const diskEdited = DISK_EDITED.has(meeting.platform);
          // An edit lands on the newest copy, so it can't wipe what the Mac app wrote on disk.
          if (diskEdited && (await refreshFromDisk(meeting.id))) meeting = await loadMeeting(meeting.id);
          const ok = await applyAction(meeting, req);
          if (ok && diskEdited) {
            const entry = { kind: "action", req };
            Earshot.settleChange(meeting, entry);
            logOf(meeting.id).push(entry);
            saveDiskEdited(meeting.id); // at once (after this, in the same queue): the Mac panel saves every second or two
          }
          if (ok) await broadcastMeeting(meeting);
          return { ok, meeting };
        })
      );

    case "ask":
      return respond(
        sendResponse,
        (async () => {
          const meeting = await targetMeeting(req, sender);
          if (!meeting) return { error: "No meeting yet. Ask AI works once the meeting is being captured." };
          return askAi(meeting, req.question);
        })()
      );

    case "file-to-vault":
      return respond(
        sendResponse,
        (async () => {
          const meeting = await targetMeeting(req, sender);
          if (!meeting) return { filed: false, reason: "Meeting not found" };
          const res = await fileToVault(meeting);
          await broadcastMeeting(meeting);
          return res;
        })()
      );

    case "generate-minutes":
      return respond(
        sendResponse,
        (async () => {
          const meeting = await targetMeeting(req, sender);
          if (!meeting) return { error: "Meeting not found" };
          // Asked for by hand: any automatic retry still waiting is dropped.
          await chrome.alarms.clear(minutesAlarm(meeting.id));
          chrome.notifications.clear(`${MINUTES_FAILED}${meeting.id}`);
          return { minutes: await generateMinutes(meeting) };
        })()
      );

    case "check-ai":
      return respond(sendResponse, checkAi({ live: true, notify: false }).then((health) => health || { ok: false, problem: "The Earshot helper isn't installed." }));

    case "helper-status":
      return respond(sendResponse, helperInfo({ retry: true }).then((info) => ({ info, error: info ? null : helper.error })));

    case "helper":
      // Pass-through for the meetings page: templates, config, folders, files-only meetings.
      return respond(sendResponse, callHelper(req.op, req.payload || {}));

    case "capture-tab":
      return respond(
        sendResponse,
        chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: "png" }).then((dataUrl) => ({ dataUrl }))
      );

    case "add-screenshot":
      return respond(
        sendResponse,
        enqueue(tabId, async () => {
          const meeting = await meetingForTab(sender.tab, null, false);
          if (!meeting) return { ok: false, reason: "no-meeting" };
          const shot = await addScreenshot(meeting, req);
          await broadcastMeeting(meeting);
          return { ok: true, shot };
        })
      );

    case "get-screenshot":
      return respond(sendResponse, chrome.storage.local.get(`shot:${req.id}`).then((r) => ({ dataUrl: r[`shot:${req.id}`] || null })));

    case "list-meetings":
      return respond(
        sendResponse,
        (async () => {
          await flush();
          return (await indexRows()).slice().sort((a, b) => b.startedAt.localeCompare(a.startedAt));
        })()
      );

    case "get-meeting":
      return respond(
        sendResponse,
        (async () => {
          const meeting = await targetMeeting({ meetingId: req.id }, sender);
          if (!meeting) return null;
          return req.withImages ? meetingWithImages(meeting.id) : meeting;
        })()
      );

    case "import-meeting":
      // A meeting known only from ~/Earshot (e.g. after reinstalling) comes back
      // into Chrome. One Chrome has too is replaced only by a newer copy (the Mac
      // app edits its meetings on disk), so edits made here aren't undone.
      return respond(
        sendResponse,
        enqueue(recordKey(req.meeting?.id), async () => ({ ok: true, imported: await importMeeting(req.meeting) }))
      );

    case "discard-meeting":
      return respond(
        sendResponse,
        enqueue(tabId, async () => {
          const id = await tabMeetingId(tabId);
          const meeting = id ? await loadMeeting(id) : null;
          const refs = [...new Set([...(meeting?.refs || []), meeting?.meetingRef].filter(Boolean))];
          await chrome.storage.session.set({ [skipKey(tabId)]: { refs, at: Date.now() } });
          await chrome.storage.session.remove([tabKey(tabId), pausedKey(tabId)]);
          tabStatus.delete(tabId);
          captionWatch.delete(tabId);
          if (id) {
            discarded.add(id);
            clearTimeout(helperTimers.get(id));
            helperTimers.delete(id);
            await removeMeeting(id);
            if (await helperInfo()) await callHelper("delete-meeting", { id }).catch(() => {});
          }
          queueBrowserState();
          return { ok: true, deleted: id };
        })
      );

    case "vault-sync":
      // The meetings page, on opening and from its "Check the vault" button (force).
      return respond(sendResponse, runVaultSync({ force: !!req.force }));

    case "delete-meeting":
      return respond(
        sendResponse,
        (async () => {
          await removeMeeting(req.id);
          if (await helperInfo()) await callHelper("delete-meeting", { id: req.id }).catch(() => {});
          return { ok: true };
        })()
      );

    case "open-meetings":
      chrome.tabs.create({ url: chrome.runtime.getURL(`app/meetings.html${req.id ? `#${encodeURIComponent(req.id)}` : ""}`) });
      return false;
  }
  return false;
});
