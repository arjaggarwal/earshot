#!/usr/bin/env node
// Earshot helper: Chrome's native-messaging host for the Earshot extension.
//
// Chrome starts this process when the extension connects, and talks to it over
// stdin/stdout (4-byte little-endian length + JSON). It:
//   - keeps every meeting as files under ~/Earshot/meetings/<year>/<month>/<folder>/
//       meeting.json   full record (what the extension stores)
//       transcript.md  readable transcript with frontmatter (Obsidian-friendly)
//       notes.md       your notes
//       minutes.md     AI-written minutes, once generated
//       chat.md        Ask AI questions and answers
//       screenshots/   presented-screen captures
//   - runs your AI CLI (claude, codex, gemini, ...) for Ask AI and minutes,
//     with the prompt on stdin, using the commands in ~/Earshot/config.json.
//
// `node host.js --self-test` checks the setup and makes one tiny AI call.
"use strict";

const fs = require("fs");
const fsp = fs.promises;
const os = require("os");
const path = require("path");
const { spawn, execFile } = require("child_process");
const vault = require("./vault.js");

const VERSION = "0.5.0";
const ROOT = process.env.EARSHOT_HOME || path.join(os.homedir(), "Earshot");
const MEETINGS = path.join(ROOT, "meetings");
const TEMPLATES = path.join(ROOT, "templates");
const CONFIG = path.join(ROOT, "config.json");
const INDEX = path.join(ROOT, "index.json");
const TRASH = path.join(ROOT, ".trash");

const DEFAULT_TAGS = ["Acme", "Globex", "Initech", "Hiring", "Internal", "Vendor", "Personal"];

// ---------------------------------------------------------------- config

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(file, value) {
  await writeText(file, JSON.stringify(value, null, 2));
}

// Temp file, flushed to disk, then renamed over the old one: a crash leaves the
// old file or the new one, never half of one. The temp name is unique per write,
// because two saves in this process (two meetings, both writing the index) used
// to share one temp file and could interleave.
let tmpSeq = 0;
async function writeText(file, text) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${++tmpSeq}`;
  try {
    const fh = await fsp.open(tmp, "w");
    try {
      await fh.writeFile(text);
      await fh.sync().catch(() => {});
    } finally {
      await fh.close();
    }
    await fsp.rename(tmp, file);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

async function loadConfig() {
  const config = await readJson(CONFIG, {});
  config.tags ??= DEFAULT_TAGS;
  config.ai ??= {};
  config.minutesTemplates ??= {}; // tag -> template file name in ~/Earshot/templates
  config.mac = {
    myName: "Alex",
    audioKeepDays: 30,
    whisperModel: "~/Earshot/models/ggml-large-v3-turbo-q5_0.bin",
    ...(config.mac || {}),
  };
  return config;
}

// ---------------------------------------------------------------- meeting folders

const pad = (n) => String(n).padStart(2, "0");
const MONTHS = ["01 January", "02 February", "03 March", "04 April", "05 May", "06 June", "07 July", "08 August", "09 September", "10 October", "11 November", "12 December"];

function titleOf(m) {
  const label = vault.PLATFORM_LABELS[m.platform] || "Meeting";
  return m.title || `${label} meeting`;
}

function folderFor(m) {
  const d = new Date(m.startedAt);
  const safe = titleOf(m).replace(/[\\/:*?"<>|#^[\]]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  const name = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())} ${safe}`;
  return path.join(MEETINGS, String(d.getFullYear()), MONTHS[d.getMonth()], name);
}

// The index is cached, but another process (an importer, or the MCP
// server) may write it too, so it's read again whenever the file has changed.
let indexCache = null;
let indexStamp = null;
function stampOfIndex() {
  try {
    const st = fs.statSync(INDEX);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
}
async function loadIndex() {
  if (!indexCache || stampOfIndex() !== indexStamp) {
    indexCache = await readIndexFile();
    indexStamp = stampOfIndex();
  }
  return indexCache;
}
// An index that can't be read used to count as empty, and the next save then
// wrote that near-empty index over the real one (every other meeting gone from
// the list). Now: no file, or a file that stays unreadable, is rebuilt from the
// meeting folders, and the unreadable one is kept beside it.
async function readIndexFile() {
  for (let attempt = 0; ; attempt++) {
    let text;
    try {
      text = await fsp.readFile(INDEX, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") return rebuildIndex();
      throw new Error(`Can't read ${INDEX}: ${err.message}`);
    }
    try {
      const index = JSON.parse(text);
      if (index && typeof index === "object" && index.meetings && typeof index.meetings === "object" && !Array.isArray(index.meetings)) {
        for (const [id, entry] of Object.entries(index.meetings)) if (!entry || typeof entry.folder !== "string") delete index.meetings[id];
        return index;
      }
    } catch {}
    if (attempt < 2) {
      await new Promise((r) => setTimeout(r, 100)); // another process may be mid-write
      continue;
    }
    const aside = `${INDEX}.corrupt-${Date.now()}`;
    await fsp.copyFile(INDEX, aside).catch(() => {});
    console.error(`Earshot helper: index.json was unreadable; kept as ${aside} and rebuilt from the meeting folders`);
    return rebuildIndex();
  }
}
async function rebuildIndex() {
  const meetings = {};
  const ls = (dir) => fsp.readdir(dir).catch(() => []);
  for (const year of await ls(MEETINGS)) {
    for (const month of await ls(path.join(MEETINGS, year))) {
      for (const name of await ls(path.join(MEETINGS, year, month))) {
        const folder = path.join(MEETINGS, year, month, name);
        const m = await readJson(path.join(folder, "meeting.json"), null);
        if (m && typeof m.id === "string" && m.startedAt) meetings[m.id] = { folder, ...summaryOf(m) };
      }
    }
  }
  return { meetings };
}
async function saveIndex() {
  await writeJson(INDEX, indexCache);
  indexStamp = stampOfIndex();
}

function summaryOf(m) {
  const speakers = [];
  for (const s of m.segments || []) if (!speakers.includes(s.speaker)) speakers.push(s.speaker);
  return {
    id: m.id,
    platform: m.platform,
    meetingRef: m.meetingRef,
    title: m.title,
    tags: m.tags || [],
    startedAt: m.startedAt,
    endedAt: m.endedAt,
    segmentCount: (m.segments || []).length,
    screenshotCount: (m.screenshots || []).length,
    hasMinutes: !!m.minutes,
    chatCount: (m.chats || []).length,
    speakers,
  };
}

// Keep the folder name in step with the title; returns the folder to use.
async function placeMeeting(m) {
  const index = await loadIndex();
  const want = folderFor(m);
  const had = index.meetings[m.id]?.folder;
  if (had && had !== want && fs.existsSync(had) && !fs.existsSync(want)) {
    await fsp.mkdir(path.dirname(want), { recursive: true });
    await fsp.rename(had, want);
  }
  const folder = had && !fs.existsSync(want) && fs.existsSync(had) ? had : want;
  index.meetings[m.id] = { folder, ...summaryOf(m) };
  return folder;
}

function elapsed(fromIso, atMs) {
  const total = Math.max(0, Math.round((atMs - Date.parse(fromIso)) / 1000));
  const h = Math.floor(total / 3600);
  const mm = Math.floor((total % 3600) / 60);
  const ss = total % 60;
  return h ? `${h}:${pad(mm)}:${pad(ss)}` : `${pad(mm)}:${pad(ss)}`;
}

const yamlList = (items) => `[${items.map((t) => JSON.stringify(t)).join(", ")}]`;

function frontmatter(m, kind) {
  const d = new Date(m.startedAt);
  const lines = [
    "---",
    `title: ${JSON.stringify(titleOf(m))}`,
    `date: ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    `time: "${pad(d.getHours())}:${pad(d.getMinutes())}"`,
    `platform: ${m.platform}`,
    `tags: ${yamlList((m.tags || []).map((t) => t.replace(/\s+/g, "-")))}`,
    `attendees: ${yamlList(attendees(m))}`,
    `earshot_id: ${m.id}`,
    `kind: ${kind}`,
    "---",
    "",
  ];
  return lines.join("\n");
}

function attendees(m) {
  const names = new Set(Object.values(m.participants || {}));
  for (const s of m.segments || []) if (s.speakerResolved !== false) names.add(s.speaker);
  return [...names].filter(Boolean);
}

// Transcript lines grouped by speaker turn, as "Name [mm:ss]: text".
function transcriptText(m) {
  const out = [];
  let last = null;
  for (const s of m.segments || []) {
    const when = elapsed(m.startedAt, s.startedAt);
    const tag = vault.lineTag(s.reaction);
    const mark = tag ? ` [${tag.label}]` : "";
    if (s.speakerId !== last) out.push(`\n${s.speaker} [${when}]:${mark} ${s.text}`);
    else out.push(`${mark ? `[${when}]${mark} ` : ""}${s.text}`);
    last = s.speakerId;
  }
  return out.join(" ").replace(/ \n/g, "\n").trim();
}

function transcriptMarkdown(m) {
  const items = (m.segments || []).map((s) => ({ kind: "seg", at: s.startedAt, s }));
  for (const shot of m.screenshots || []) items.push({ kind: "shot", at: shot.at, shot });
  items.sort((a, b) => a.at - b.at);
  const out = [frontmatter(m, "transcript"), `# ${titleOf(m)}`, ""];
  let last = null;
  for (const item of items) {
    if (item.kind === "shot") {
      out.push(`![Screenshot ${elapsed(m.startedAt, item.at)}](screenshots/${shotName(m, item.shot)})`, "");
      last = null;
      continue;
    }
    const s = item.s;
    if (s.speakerId !== last) out.push(`**${s.speaker}** [${elapsed(m.startedAt, s.startedAt)}]`);
    out.push(`${vault.lineTag(s.reaction) ? `[${vault.lineTag(s.reaction).label}] ` : ""}${s.text}`, "");
    last = s.speakerId;
  }
  return out.join("\n");
}

const shotName = (m, shot) => `${elapsed(m.startedAt, shot.at).replace(/:/g, "-")} ${shot.id.slice(-6)}.jpg`;

function chatMarkdown(m) {
  const out = [frontmatter(m, "chat"), `# Ask AI · ${titleOf(m)}`, ""];
  for (const c of m.chats || []) {
    out.push(`**Q** (${new Date(c.at).toLocaleString()}): ${c.question}`, "", c.answer || `_${c.error || "no answer"}_`, "", "---", "");
  }
  return out.join("\n");
}

// A copy older than the one on disk (the Mac app and Chrome both write
// meetings) isn't written: {stale: true} tells the writer to take the disk
// copy instead. Without a time on either side it writes, as it always did.
async function staleAgainstDisk(m) {
  const incoming = Date.parse(m.updatedAt);
  if (!Number.isFinite(incoming)) return false;
  const onDisk = Date.parse((await diskMeeting(m.id))?.updatedAt);
  return Number.isFinite(onDisk) && incoming < onDisk;
}

async function diskMeeting(id) {
  const entry = (await loadIndex()).meetings[id];
  return entry?.folder ? readJson(path.join(entry.folder, "meeting.json"), null) : null;
}

// `base` (optional) is the updatedAt of the copy the writer built on (the Mac
// panel sends it; null for a record it has never seen on disk). If the disk
// copy has since been written by anyone else (its updatedAt differs), nothing
// is written and the disk copy comes back, for the writer to redo its changes
// on. Writers without a base keep the rule above.
async function saveMeeting(m, base) {
  if (!m || typeof m !== "object" || typeof m.id !== "string" || !m.id) throw new Error("save-meeting needs a meeting with an id");
  if (Number.isNaN(new Date(m.startedAt).getTime())) throw new Error(`meeting ${m.id} has no valid start time (startedAt: ${JSON.stringify(m.startedAt)})`);
  // A shared array let live lines leak into tags, refs, chats and screenshots, and a line
  // object as a tag broke every file below. Tags and refs are strings; no list keeps a transcript line.
  const isLine = (x) => !!x && typeof x === "object" && "speakerId" in x;
  for (const k of ["tags", "refs", "chats", "screenshots"]) {
    if (!Array.isArray(m[k])) m[k] = [];
    else if (m[k].some(isLine) || ((k === "tags" || k === "refs") && m[k].some((x) => typeof x !== "string"))) {
      m[k] = m[k].filter((x) => !isLine(x) && (k === "chats" || k === "screenshots" || typeof x === "string"));
    }
  }
  if (base !== undefined) {
    const disk = await diskMeeting(m.id);
    if (disk && disk.updatedAt !== undefined && disk.updatedAt !== base) return { stale: true, meeting: disk };
  } else if (await staleAgainstDisk(m)) return { stale: true };
  const folder = await placeMeeting(m);
  await fsp.mkdir(folder, { recursive: true });
  await writeJson(path.join(folder, "meeting.json"), m);
  await writeText(path.join(folder, "transcript.md"), transcriptMarkdown(m));
  if (m.notes && m.notes.trim()) await writeText(path.join(folder, "notes.md"), `${frontmatter(m, "notes")}# Notes · ${titleOf(m)}\n\n${m.notes.trim()}\n`);
  if (m.minutes) await writeText(path.join(folder, "minutes.md"), `${frontmatter(m, "minutes")}${m.minutes.trim()}\n`);
  if ((m.chats || []).length) await writeText(path.join(folder, "chat.md"), chatMarkdown(m));
  // Re-read in case another process wrote the index while the files were saved.
  // (Built here, not read back from the cache: a reload in between dropped the
  // entry, and the meeting was then saved on disk but missing from the list.)
  const entry = { folder, ...summaryOf(m) };
  (await loadIndex()).meetings[m.id] = entry;
  await saveIndex();
  return { folder };
}

async function folderOf(id) {
  const entry = (await loadIndex()).meetings[id];
  if (!entry) throw new Error(`unknown meeting ${id}`);
  return entry.folder;
}

async function saveScreenshot({ meeting, shot, dataUrl }) {
  const folder = await placeMeeting(meeting);
  const file = path.join(folder, "screenshots", shotName(meeting, shot));
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, Buffer.from(dataUrl.split(",")[1], "base64"));
  await saveIndex();
  return { file };
}

async function deleteScreenshot({ meeting, shotId }) {
  const folder = await folderOf(meeting.id);
  const dir = path.join(folder, "screenshots");
  for (const f of await fsp.readdir(dir).catch(() => [])) if (f.includes(shotId.slice(-6))) await fsp.rm(path.join(dir, f), { force: true });
  return { ok: true };
}

async function deleteMeeting({ id }) {
  const index = await loadIndex();
  const entry = index.meetings[id];
  if (entry && fs.existsSync(entry.folder)) {
    // Kept in ~/Earshot/.trash rather than erased, in case it was a mistake.
    const dest = path.join(TRASH, `${path.basename(entry.folder)} ${Date.now()}`);
    await fsp.mkdir(TRASH, { recursive: true });
    await fsp.rename(entry.folder, dest);
  }
  delete index.meetings[id];
  await saveIndex();
  return { ok: true };
}

async function listMeetings() {
  const index = await loadIndex();
  return Object.values(index.meetings).filter(Boolean).map(({ folder, ...rest }) => rest);
}

// Every saved meeting whose title, people, tags, notes, minutes or transcript
// has all the words: the meetings page's search box, which would otherwise
// only reach meetings kept in Chrome. Texts are cached until a file changes.
const searchCache = new Map();
async function searchMeetings({ query }) {
  const words = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const hits = [];
  for (const entry of Object.values((await loadIndex()).meetings)) {
    if (!entry || !entry.folder) continue;
    const file = path.join(entry.folder, "meeting.json");
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      continue;
    }
    const stamp = `${st.mtimeMs}:${st.size}`;
    let cached = searchCache.get(entry.id);
    if (!cached || cached.stamp !== stamp) {
      const m = await readJson(file, null);
      if (!m) continue;
      const text = [titleOf(m), ...attendees(m), ...(m.tags || []), m.notes, m.minutes, ...(m.segments || []).map((s) => s.text)].join(" ").toLowerCase();
      cached = { stamp, text };
      searchCache.set(entry.id, cached);
    }
    if (words.every((w) => cached.text.includes(w))) hits.push(entry.id);
  }
  return hits;
}

async function getMeeting({ id }) {
  return readJson(path.join(await folderOf(id), "meeting.json"), null);
}

// ---------------------------------------------------------------- AI

// Claude runs on your sign-in. An API key in the environment would take over
// from it (and bill that key), so it's dropped.
function cliEnv(spec) {
  const env = { ...process.env, ...(spec.env || {}) };
  if (path.basename(spec.command) === "claude") {
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
  }
  return env;
}

function runCli(spec, prompt) {
  return new Promise((resolve, reject) => {
    if (!spec?.command) return reject(new Error("No AI command set. Run the installer again, or set ai.ask in ~/Earshot/config.json."));
    const started = Date.now();
    const env = cliEnv(spec);
    const child = spawn(spec.command, spec.args || [], { cwd: ROOT, env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const limitSec = spec.timeoutSec || 180;
    let timedOut = false;
    let killer = null;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killer = setTimeout(() => child.kill("SIGKILL"), 5000); // a CLI that ignores SIGTERM
    }, limitSec * 1000);
    // A CLI that exits before reading its prompt (signed out, bad flag) makes this
    // write fail; without a listener that error ended the whole helper.
    child.stdin.on("error", () => {});
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`Couldn't start ${spec.command}: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      clearTimeout(killer);
      if (timedOut) {
        // What the CLI last said (a retry notice, a usage limit) is the likely cause; keep it.
        const said = `${err}\n${out}`.split("\n").map((l) => l.trim()).filter((l) => l && !/^Permission deny rule/.test(l)).pop();
        return reject(new Error(`The AI took longer than ${limitSec} seconds and was stopped.${said ? ` It last said: ${said.slice(0, 300).replace(/[.\s]*$/, ".")}` : ""} Try again; the meeting is saved.`));
      }
      if (code === 0 && !out.trim() && !err.trim()) return reject(new Error("The AI returned nothing. Try again; the meeting is saved."));
      if (code === 0 && out.trim()) return resolve({ text: out.trim(), ms: Date.now() - started });
      // The reason can be on either stream; skip managed-policy chatter.
      const lines = `${out}\n${err}`.split("\n").map((l) => l.trim()).filter((l) => l && !/^Permission deny rule/.test(l));
      const signedOut = lines.find((l) => SIGNED_OUT.test(l));
      const error = new Error(signedOut ? `The AI CLI isn't signed in: ${signedOut}` : lines.slice(-4).join("\n") || `exited with ${code}`);
      error.signedOut = !!signedOut;
      reject(error);
    });
    child.stdin.end(prompt);
  });
}

const SIGNED_OUT = /authenticat|log ?in|logged out|oauth|session expired|credential|unauthori[sz]ed|401/i;

// Is the AI CLI there and signed in to the right account? For Claude this
// asks `claude auth status`, which costs nothing; other CLIs just need to start.
async function aiHealth({ live = false } = {}) {
  const config = await loadConfig();
  const spec = config.ai.ask;
  const checkedAt = new Date().toISOString();
  if (!spec?.command) return { ok: false, checkedAt, problem: "No AI CLI is set up.", fix: "Run helper/install.sh again." };
  if (!fs.existsSync(spec.command)) return { ok: false, checkedAt, problem: `The AI CLI isn't at ${spec.command} any more.`, fix: "Run helper/install.sh again so Earshot finds it." };
  const isClaude = path.basename(spec.command) === "claude";
  const account = config.ai.account || {};
  const configDir = spec.env?.CLAUDE_CONFIG_DIR || account.configDir || null;
  // Full path to the CLI, since `claude` may not be on your Terminal's PATH;
  // the config folder only when it isn't the default one.
  const custom = configDir && configDir !== path.join(os.homedir(), ".claude");
  const loginFix = `${custom ? `CLAUDE_CONFIG_DIR=${configDir.replace(os.homedir(), "~")} ` : ""}${spec.command} auth login`;
  if (!isClaude) {
    try {
      await runCli({ ...spec, args: ["--version"], timeoutSec: 20 }, "");
      return { ok: true, checkedAt, cli: path.basename(spec.command) };
    } catch (err) {
      return { ok: false, checkedAt, problem: `${path.basename(spec.command)} didn't start: ${err.message}`, fix: "Run helper/install.sh again." };
    }
  }
  // `auth status` exits non-zero when signed out, but still prints its JSON.
  let status;
  try {
    const raw = await new Promise((resolve, reject) => {
      execFile(spec.command, ["auth", "status", "--json"], { cwd: ROOT, env: cliEnv(spec), timeout: 30000 }, (err, stdout) => {
        const start = stdout.indexOf("{");
        if (start >= 0) resolve(stdout.slice(start));
        else reject(err || new Error("no status output"));
      });
    });
    status = JSON.parse(raw);
  } catch (err) {
    return { ok: false, checkedAt, cli: "claude", configDir, problem: `Couldn't check the Claude sign-in: ${String(err.message).split("\n")[0]}`, fix: loginFix };
  }
  const result = { checkedAt, cli: "claude", configDir, loggedIn: !!status.loggedIn, orgName: status.orgName || null, subscriptionType: status.subscriptionType || null, expectedOrg: account.orgName || null };
  if (!status.loggedIn) return { ...result, ok: false, problem: `Claude${account.orgName ? ` (${account.orgName})` : ""} is signed out, so Ask AI and minutes are off.`, fix: loginFix };
  if (account.orgName && status.orgName && status.orgName !== account.orgName)
    return { ...result, ok: false, problem: `Claude is signed in to ${status.orgName}, not ${account.orgName}.`, fix: loginFix };
  if (!live) return { ...result, ok: true, live: false };
  // "Signed in" can still mean an expired session that won't refresh; only a
  // real call shows that. Keep it tiny: no default system prompt, one word back.
  try {
    await runCli({ ...spec, args: [...(spec.args || []), "--system-prompt", "Reply with the single word: ok"], timeoutSec: 60 }, "ping");
    return { ...result, ok: true, live: true };
  } catch (err) {
    return err.signedOut
      ? { ...result, ok: false, live: true, problem: `Claude${account.orgName ? ` (${account.orgName})` : ""}'s sign-in has expired, so Ask AI and minutes are off.`, fix: loginFix }
      : { ...result, ok: false, live: true, problem: `The AI test call failed: ${err.message.split("\n")[0]}`, fix: "Check the AI command in Earshot's settings, or run helper/install.sh again." };
  }
}

function meetingContext(m) {
  const d = new Date(m.startedAt);
  return [
    `Meeting: ${titleOf(m)}`,
    `Platform: ${m.platform}`,
    `Date: ${d.toDateString()} ${pad(d.getHours())}:${pad(d.getMinutes())}`,
    `Tags: ${(m.tags || []).join(", ") || "none"}`,
    `Attendees: ${attendees(m).join(", ") || "unknown"}`,
  ].join("\n");
}

// The spelling list from Settings (config.glossary: { Right: [wrong, wrong] }),
// as lines the AI can follow when captions mishear names.
function glossaryText(config, fromVault = {}) {
  // Yours (Settings) first; the vault's learned spellings (the vault agent keeps them) fill in the rest.
  const merged = { ...fromVault };
  for (const [right, wrong] of Object.entries(config.glossary || {})) merged[right] = [...new Set([...(wrong || []), ...(merged[right] || [])])];
  const lines = Object.entries(merged)
    .filter(([right]) => right)
    .map(([right, wrong]) => `- ${right}${wrong?.length ? ` (captions may write: ${wrong.join(", ")})` : ""}`);
  return lines.length ? `Correct spellings of names, companies and products that come up:\n${lines.join("\n")}` : "";
}

// Quick questions get answers shaped to what was asked, so a lookup comes back as
// a sentence, not a page. First match wins, so the narrow kinds come first.
const ANSWER_SHAPES = [
  [/\b(suggest|what (should|could|can) i ask|questions? (to|i could|i should) ask)\b/i, "Give 3 questions to ask next, one line each, specific to what was said. Nothing else."],
  [/\b(last|past) (\d+|few|couple of) min|\bjust now\b|\bdid i miss\b|\bwhat did i miss\b/i, "Cover only the stretch asked about (go by the [mm:ss] times): at most 4 short bullets, newest last. If little happened, say so in one line."],
  [/\b(action items?|to-?dos?|next steps|who owns|owners?|assigned|follow-?ups?)\b/i, "One line per item: Owner: action (and the due date, if one was said). Leave out anything nobody agreed to."],
  [/\b(decided|decisions?|agreed|conclusion)\b/i, "One line per decision, with who made or agreed to it. If nothing was decided, say so in one line."],
  [/\b(summar\w*|key points|recap|overview|catch me up|so far|main points|highlights)\b/i, "At most 6 bullets, most important first, one line each. No headings."],
  [/^\s*(what|who|when|where|which|how (much|many|long)|did|does|do|is|was|were|are|has|have)\b/i, "Answer in one or two sentences. Lead with the answer itself, then who said it and the [mm:ss] time. Quote numbers exactly."],
];
// The newest line's time, which is "now" for a question asked mid-meeting.
function latestAt(meeting) {
  return Math.max(0, ...(meeting.segments || []).map((s) => s.lastAt || s.startedAt || 0)) || null;
}
function answerShape(question) {
  return ANSWER_SHAPES.find(([re]) => re.test(question))?.[1] || "A few sentences or short bullets at most.";
}

async function ask({ meeting, question }) {
  const config = await loadConfig();
  const earlier = (meeting.chats || []).slice(-6).map((c) => `Q: ${c.question}\nA: ${c.answer || ""}`).join("\n\n");
  const prompt = [
    "You answer questions about one meeting, using only its transcript and the note-taker's notes below.",
    "The reader is in the meeting and glancing at a side panel: be brief and concrete, use people's names, quote numbers exactly.",
    "No preamble, no restating the question, no closing offer. If the answer isn't in the transcript, say so in one line.",
    "Captions can mishear words; read past obvious errors.",
    "",
    meetingContext(meeting),
    "",
    glossaryText(config),
    "",
    "Notes from the note-taker (authoritative):",
    meeting.notes?.trim() || "(none)",
    "",
    "Transcript so far (Speaker [mm:ss]: text):",
    transcriptText(meeting) || "(nothing yet)",
    latestAt(meeting) ? `(The meeting is now at about [${elapsed(meeting.startedAt, latestAt(meeting))}].)` : "",
    earlier ? `\nEarlier questions in this chat:\n${earlier}` : "",
    "",
    `Answer shape: ${answerShape(question)}`,
    "",
    `Question: ${question}`,
  ].join("\n");
  const res = await runCli(config.ai.ask, prompt);
  return { answer: res.text, ms: res.ms, model: config.ai.ask?.label || config.ai.ask?.command };
}

const DEFAULT_TEMPLATE = `You are writing meeting minutes that go into an Obsidian vault. Use only what's in the transcript and the note-taker's notes. Captions can mishear words; fix obvious errors (names, numbers in context) but never invent facts. The notes are authoritative: every line in them tagged #todo, #followup, #ROI, #opportunity or #insight, and every [ ] checkbox, must appear in the minutes. Write the tags as plain words in the minutes (to-do, follow-up), never as #tags.

Write Markdown only, in exactly this shape. Leave out any section with nothing in it.

### {{title}} · {{time}}
Attendees: {{attendee_links}}
Tags: {{tag_hashtags}}

**Summary**
- 3 to 6 bullets: what was discussed and where it landed.

**Decisions**
- One bullet per decision.

**Action Items**
- [ ] Owner — task (due date if one was said)

**Open Questions**
- Unresolved questions and who should answer them.

**Key Numbers**
- Figures that came up, with what they refer to.

Finish with one last line, exactly: One-line summary: <one sentence on what the meeting was about and where it landed>

---
Meeting details:
{{context}}

Note-taker's notes:
{{notes}}

Transcript (Speaker [mm:ss]: text):
{{transcript}}
`;

async function templateFor(meeting) {
  const config = await loadConfig();
  const named = (meeting.tags || []).map((t) => config.minutesTemplates[t]).find(Boolean) || "default.md";
  const file = path.join(TEMPLATES, named);
  try {
    return { name: named, text: await fsp.readFile(file, "utf8") };
  } catch {
    await writeText(path.join(TEMPLATES, "default.md"), DEFAULT_TEMPLATE);
    return { name: "default.md", text: DEFAULT_TEMPLATE };
  }
}

async function minutes({ meeting }) {
  const config = await loadConfig();
  const template = await templateFor(meeting);
  const d = new Date(meeting.startedAt);
  const fill = {
    title: titleOf(meeting),
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
    // Names as the vault spells them (people/ and the Names files the vault agent keeps), not as captioned.
    attendees: vault.resolveAttendees(meeting, config).join(", "),
    attendee_links: vault.resolveAttendees(meeting, config).map((a) => `[[${a}]]`).join(", "),
    tags: (meeting.tags || []).join(", "),
    tag_hashtags: (meeting.tags || []).map((t) => `#${t.replace(/\s+/g, "-")}`).join(" "),
    context: meetingContext(meeting),
    notes: meeting.notes?.trim() || "(none)",
    transcript: transcriptText(meeting) || "(empty)",
    glossary: glossaryText(config, vault.vaultGlossary(meeting, config)),
  };
  let prompt = template.text.replace(/\{\{(\w+)\}\}/g, (all, key) => (key in fill ? fill[key] : all));
  // Templates without a {{glossary}} slot still get the spelling list, ahead of the details.
  if (fill.glossary && !template.text.includes("{{glossary}}")) prompt = prompt.replace("\n---\nMeeting details:", `\n---\n${fill.glossary}\n\nMeeting details:`).replace(/^(?![\s\S]*Correct spellings)/, `${fill.glossary}\n\n`);
  const res = await runCli(config.ai.minutes || config.ai.ask, prompt);
  // The last line carries the one-sentence summary used in the daily note.
  const match = /^\s*\**One-line summary:?\**:?\s*(.+)$/im.exec(res.text);
  const text = match ? res.text.replace(match[0], "").trim() : res.text;
  return { minutes: text, oneLiner: match ? match[1].trim() : null, template: template.name, ms: res.ms };
}

async function getTemplate({ name = "default.md" } = {}) {
  try {
    return { name, text: await fsp.readFile(path.join(TEMPLATES, name), "utf8") };
  } catch {
    return { name, text: DEFAULT_TEMPLATE };
  }
}

async function setTemplate({ name = "default.md", text }) {
  await writeText(path.join(TEMPLATES, path.basename(name)), text);
  return { ok: true };
}

// ---------------------------------------------------------------- requests

// Where a meeting's screenshots are on disk, for copying into the vault.
async function shotLocator(meeting) {
  const entry = (await loadIndex()).meetings[meeting.id];
  return (shot) => (entry ? path.join(entry.folder, "screenshots", shotName(meeting, shot)) : null);
}

async function fileToVault({ meeting, auto = false }) {
  const config = await loadConfig();
  const settings = vault.vaultSettings(config);
  if (auto && !settings.autoFile) return { filed: false, reason: "Automatic filing is off." };
  if (auto) {
    // A partial copy of a call that was also saved in full (browser captions and the Mac app) isn't filed on its own.
    const rows = Object.values((await loadIndex()).meetings).filter((r) => r && r.id !== meeting.id);
    const dup = vault.duplicateOf(summaryOf(meeting), rows);
    if (dup) return { filed: false, duplicateOf: dup, reason: `Not filed automatically: it looks like a partial copy of "${dup.title || "another meeting"}" (${dup.segmentCount} lines), saved at the same time.` };
  }
  return vault.fileMeeting(meeting, config, { previous: meeting.vaultNote || null, shotFile: await shotLocator(meeting) });
}

// ---------------------------------------------------------------- vault sync (see vault.js)
//
// Chrome sends the meetings it holds (`held`); this decides for them and for every meeting only on
// disk. Chrome applies its own; the disk-only ones (imported history, Mac meetings Chrome never
// opened) are changed here.

const SYNC_FIELDS = ["id", "title", "meetingRef", "platform", "source", "tags", "startedAt", "vaultNote", "lastFiling", "vaultMissing", "vaultTitle"];
const syncCache = new Map(); // id -> { stamp, fields }
async function syncFields(entry) {
  const file = path.join(entry.folder, "meeting.json");
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  const stamp = `${st.mtimeMs}:${st.size}`;
  const hit = syncCache.get(entry.id);
  if (hit && hit.stamp === stamp) return hit.fields;
  const m = await readJson(file, null);
  if (!m || m.id !== entry.id) return null;
  const fields = Object.fromEntries(SYNC_FIELDS.filter((k) => k in m).map((k) => [k, m[k]]));
  syncCache.set(entry.id, { stamp, fields });
  return fields;
}

async function vaultSync({ held = [] } = {}) {
  const config = await loadConfig();
  const index = await loadIndex();
  const heldIds = new Set(held.map((h) => h && h.id));
  const diskOnly = [];
  for (const entry of Object.values(index.meetings)) {
    if (!entry || heldIds.has(entry.id)) continue;
    const fields = await syncFields(entry);
    if (fields) diskOnly.push(fields);
  }
  const res = vault.syncVault([...held, ...diskOnly], config);
  if (!res.ok) return res;
  const results = [];
  let changedOnDisk = 0;
  for (const r of res.results) {
    if (heldIds.has(r.id)) results.push(r);
    else if (await applySyncOnDisk(r, config).catch((err) => console.error(`Earshot helper: vault sync of ${r.id} failed:`, err.message))) changedOnDisk++;
  }
  return { ok: true, results, changedOnDisk, notes: res.notes, checkedAt: res.checkedAt };
}

async function applySyncOnDisk(r, config) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const m = await diskMeeting(r.id);
    if (!m) return false;
    const base = m.updatedAt ?? null;
    vault.applyVaultSync(m, r.patch);
    if (r.refile) {
      const filing = await fileToVault({ meeting: m, auto: true });
      m.lastFiling = { ...(filing.filed ? {} : { planned: m.lastFiling?.planned, title: m.lastFiling?.title }), ...filing, at: new Date().toISOString() };
      if (filing.filed) Object.assign(m, { vaultNote: filing.note, vaultName: filing.vault, filedAt: filing.filedAt, vaultDailyLines: filing.dailyLines || [] }), delete m.vaultMissing;
    }
    m.updatedAt = new Date(Math.max(Date.now(), (Date.parse(base) || 0) + 1)).toISOString();
    const saved = await saveMeeting(m, base);
    if (!saved?.stale) return true;
  }
  return false;
}

// Meetings that are partial copies of another saved at the same time: { id: { id, title, platform, segmentCount } }.
// `rows` are the caller's own (Chrome's, which may not all be on disk); disk's are added.
async function findDuplicates({ rows = [] } = {}) {
  const byId = new Map(Object.values((await loadIndex()).meetings).filter(Boolean).map((r) => [r.id, r]));
  for (const r of rows) if (r && r.id) byId.set(r.id, r);
  return vault.findDuplicates([...byId.values()]);
}

// Obsidian vaults under your home folder (any folder holding .obsidian), for picking one in Settings.
function findVaults() {
  return new Promise((resolve) => {
    execFile("/usr/bin/find", [os.homedir(), "-maxdepth", "6", "-type", "d", "-name", ".obsidian", "-not", "-path", "*/Library/Caches/*", "-not", "-path", "*/node_modules/*", "-not", "-path", "*/.Trash/*"], { timeout: 20000 }, (err, stdout) => {
      resolve((stdout || "").split("\n").filter(Boolean).map((p) => path.dirname(p)));
    });
  });
}

// ---------------------------------------------------------------- Mac app exchange (files in ~/Earshot/run)

const RUN = path.join(ROOT, "run");

// The Mac app records into the saved meeting's folder, or run/audio/<id>/ before the meeting is saved.
async function meetingFolder({ id }) {
  const entry = (await loadIndex()).meetings[id];
  if (entry?.folder) return entry.folder;
  if (typeof id !== "string" || !/^[A-Za-z0-9._-]+$/.test(id) || id === "." || id === "..") throw new Error("bad meeting id");
  const audio = path.join(RUN, "audio");
  const dir = path.join(audio, id);
  if (path.dirname(dir) !== audio) throw new Error("bad meeting id");
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

// people/<Full Name>.md with `client: "[[Company]]"` in the frontmatter -> {tag, person}.
async function suggestCompany({ names }) {
  const vaultPath = vault.vaultSettings(await loadConfig()).path;
  if (!vaultPath || typeof vaultPath !== "string") return null;
  const dir = path.join(vaultPath, "people");
  let files;
  try {
    files = (await fsp.readdir(dir)).filter((f) => f.toLowerCase().endsWith(".md")).map((f) => f.slice(0, -3));
  } catch {
    return null;
  }
  for (const raw of names || []) {
    const name = String(raw || "").trim().toLowerCase();
    if (!name) continue;
    let hits = files.filter((f) => f.toLowerCase() === name);
    if (!hits.length && !name.includes(" ")) hits = files.filter((f) => f.toLowerCase().split(/\s+/)[0] === name);
    if (hits.length !== 1) continue;
    let text;
    try {
      text = await fsp.readFile(path.join(dir, `${hits[0]}.md`), "utf8");
    } catch {
      continue;
    }
    const front = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    // Your own team (client: [[Internal]]) works across clients, so they say nothing about
    // this meeting's company: the next person decides.
    const link = front && front[1].match(/^client:\s*["']?\[\[([^\]|#]+)/m);
    if (link && link[1].trim() === "Internal") continue;
    if (link) return { tag: link[1].trim(), person: hits[0] };
  }
  return null;
}

// Pushes mac-segments-*.json files from run/ to the extension (this process only, once asked).
let macWatching = false;
const macSeen = new Map(); // file name -> last content pushed
const macTooBig = new Set(); // files not sent for their size (logged once each)
const MAX_PUSH_BYTES = 900 * 1024;
async function scanMacSegments() {
  let names;
  try {
    names = (await fsp.readdir(RUN)).filter((f) => /^mac-segments-.+\.json$/.test(f));
  } catch {
    return;
  }
  for (const name of names) {
    let text;
    try {
      text = await fsp.readFile(path.join(RUN, name), "utf8");
    } catch {
      continue;
    }
    if (macSeen.get(name) === text) continue;
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      continue; // half-written; the next event or rescan retries
    }
    if (!data || !data.meetingId || !data.captureId) continue;
    macSeen.set(name, text);
    const frame = { push: "mac-segments", meetingId: data.meetingId, captureId: data.captureId, segments: data.segments || [], done: !!data.done };
    // Chrome drops the connection on a message over 1 MB, and the file would
    // only be sent again on the reconnect: one too big isn't sent (until it changes).
    if (Buffer.byteLength(JSON.stringify(frame)) > MAX_PUSH_BYTES) {
      if (!macTooBig.has(name)) console.error(`Earshot helper: ${name} is too big to pass to Chrome; not sent`);
      macTooBig.add(name);
      continue;
    }
    macTooBig.delete(name);
    send(frame);
  }
}
let macScanning = Promise.resolve();
const queueMacScan = () => (macScanning = macScanning.then(scanMacSegments).catch(() => {}));
async function watchMac() {
  if (macWatching) return { watching: true };
  await fsp.mkdir(RUN, { recursive: true });
  macWatching = true;
  try {
    fs.watch(RUN, () => queueMacScan()).on("error", () => {});
  } catch {}
  setInterval(queueMacScan, 5000).unref();
  await queueMacScan();
  return { watching: true };
}

async function macSegmentsAck({ meetingId, captureId, done }) {
  if (!done) return { moved: 0 };
  let moved = 0;
  for (const name of await fsp.readdir(RUN).catch(() => [])) {
    if (!/^mac-segments-.+\.json$/.test(name)) continue;
    let data;
    try {
      data = JSON.parse(await fsp.readFile(path.join(RUN, name), "utf8"));
    } catch {
      continue;
    }
    if (data.meetingId !== meetingId || data.captureId !== captureId) continue;
    await fsp.mkdir(path.join(RUN, "done"), { recursive: true });
    await fsp.rename(path.join(RUN, name), path.join(RUN, "done", name));
    macSeen.delete(name);
    moved++;
  }
  return { moved };
}

const OPS = {
  async "browser-state"({ meetings }) {
    if (!Array.isArray(meetings)) throw new Error("meetings must be an array");
    const clean = meetings.filter((m) => m && typeof m.meetingId === "string");
    await writeJson(path.join(RUN, "browser.json"), { at: Date.now(), meetings: clean });
    return { ok: true };
  },
  "watch-mac": watchMac,
  "mac-segments-ack": macSegmentsAck,
  "meeting-folder": meetingFolder,
  "suggest-company": suggestCompany,
  async hello() {
    const config = await loadConfig();
    return {
      version: VERSION,
      root: ROOT,
      tags: config.tags,
      ai: { ask: config.ai.ask?.label || config.ai.ask?.command || null, minutes: config.ai.minutes?.label || config.ai.minutes?.command || null },
    };
  },
  async "get-config"() {
    return loadConfig();
  },
  async "set-config"({ patch }) {
    const config = await loadConfig();
    const next = { ...config, ...patch, ai: { ...config.ai, ...(patch.ai || {}) } };
    await writeJson(CONFIG, next);
    return next;
  },
  "save-meeting": ({ meeting, base }) => saveMeeting(meeting, base),
  "save-screenshot": saveScreenshot,
  "delete-screenshot": deleteScreenshot,
  "delete-meeting": deleteMeeting,
  "list-meetings": listMeetings,
  "get-meeting": getMeeting,
  "search-meetings": searchMeetings,
  ask,
  minutes,
  "ai-health": aiHealth,
  "file-to-vault": fileToVault,
  "vault-sync": vaultSync,
  "find-duplicates": findDuplicates,
  async "vault-preview"({ meeting }) {
    return vault.preview(meeting, await loadConfig());
  },
  async "get-vault-settings"() {
    return vault.vaultSettings(await loadConfig());
  },
  async "set-vault-settings"({ settings }) {
    const config = await loadConfig();
    config.vault = { ...(config.vault || {}), ...settings };
    await writeJson(CONFIG, config);
    return vault.vaultSettings(config);
  },
  "find-vaults": findVaults,
  "get-template": getTemplate,
  "set-template": setTemplate,
  async "open-folder"({ id }) {
    const target = id ? await folderOf(id) : ROOT;
    await fsp.mkdir(target, { recursive: true });
    execFile("open", [target], () => {}); // with a callback, a failed start can't end the helper
    return { ok: true, folder: target };
  },
};

// Chrome drops the connection (and every waiting request with it) on a message
// over 1 MB from the helper. A reply that big goes back as an error instead.
const MAX_FRAME_BYTES = 1024 * 1024 - 1024;
function send(message) {
  let body = Buffer.from(JSON.stringify(message));
  if (body.length > MAX_FRAME_BYTES) {
    console.error(`Earshot helper: a ${body.length}-byte message is too big for Chrome; not sent`);
    if (!message || message.push) return;
    body = Buffer.from(JSON.stringify({ id: message.id, ok: false, error: `The helper's answer was too big to pass to Chrome (${(body.length / 1048576).toFixed(1)} MB; the limit is 1 MB). The meeting is safe in ${ROOT}.` }));
  }
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}

// Replies go to the request number `rid` (an older extension sent it as `id`).
async function handle(req) {
  const op = OPS[req.op];
  const reply = req.rid ?? req.id;
  try {
    if (!op) throw new Error(`unknown op ${req.op}`);
    send({ id: reply, ok: true, result: await op(req) });
  } catch (err) {
    send({ id: reply, ok: false, error: String(err.message || err) });
  }
}

// Writes for the same meeting go one at a time; AI calls run alongside.
const chains = new Map();
function schedule(req) {
  const key = ["ask", "minutes"].includes(req.op) ? null : req.op === "browser-state" ? "browser-state" : req.meeting?.id || req.id || req.rid || "global";
  if (!key) return void handle(req);
  const next = (chains.get(key) || Promise.resolve()).then(() => handle(req)).finally(() => {
    if (chains.get(key) === next) chains.delete(key); // or the map grows by one entry per request
  });
  chains.set(key, next);
}

function listen() {
  let buffer = Buffer.alloc(0);
  process.stdin.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const len = buffer.readUInt32LE(0);
      if (buffer.length < 4 + len) break;
      const raw = buffer.subarray(4, 4 + len).toString("utf8");
      buffer = buffer.subarray(4 + len);
      let req = null;
      try {
        req = JSON.parse(raw);
        if (!req || typeof req !== "object" || Array.isArray(req)) throw new Error("not an object");
        schedule(req);
      } catch (err) {
        send({ id: req && typeof req === "object" ? req.rid ?? req.id : undefined, ok: false, error: `bad message: ${err.message}` });
      }
    }
  });
  // Chrome closing the connection (quit, or the extension restarting) used to end
  // the helper in the middle of a save; the saves under way finish first.
  process.stdin.on("end", () => Promise.allSettled([...chains.values()]).then(() => process.exit(0)));
}

async function selfTest() {
  const config = await loadConfig();
  console.log(`Earshot helper ${VERSION}`);
  console.log(`Folder: ${ROOT}`);
  console.log(`Ask AI: ${config.ai.ask ? [config.ai.ask.command, ...(config.ai.ask.args || [])].join(" ") : "not set"}`);
  console.log(`Minutes: ${config.ai.minutes ? [config.ai.minutes.command, ...(config.ai.minutes.args || [])].join(" ") : "(same as Ask AI)"}`);
  if (!config.ai.ask) return process.exit(1);
  const health = await aiHealth({ live: true });
  console.log(health.cli === "claude"
    ? `Account: ${health.orgName || health.expectedOrg || "unknown"}${health.subscriptionType ? ` (${health.subscriptionType})` : ""} via ${health.configDir || "default Claude folder"}${health.ok ? "" : `\nProblem: ${health.problem}\nFix: ${health.fix}`}`
    : `CLI: ${health.ok ? "ok" : health.problem}`);
  if (!health.ok) process.exit(1);
  if (health.live) return console.log("Test AI call: ok");
  process.stdout.write("Test AI call… ");
  try {
    const res = await runCli(config.ai.ask, "Reply with exactly: Earshot is connected.");
    console.log(`ok (${(res.ms / 1000).toFixed(1)}s): ${res.text.split("\n")[0]}`);
  } catch (err) {
    console.log(`failed:\n${err.message}`);
    process.exit(1);
  }
}

const reloadIndex = () => (indexCache = indexStamp = null);

module.exports = { answerShape, ROOT, reloadIndex, loadConfig, loadIndex, saveMeeting, folderFor, listMeetings, getMeeting, transcriptText, attendees, titleOf, fileToVault, elapsed };

if (require.main === module) {
  if (process.argv.includes("--self-test")) selfTest();
  else listen();
}
