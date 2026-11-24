// Files Earshot meetings into an Obsidian vault.
//
// Each meeting becomes one note in its department's folder, by default
//   <department folder>/Meeting Minutes/<YYYY-MM-DD> <Title>.md
// with frontmatter, the AI minutes, your notes, presentation screenshots and
// the transcript folded away. The day's daily note gets a line under its
// meetings heading linking to it with a one-sentence summary.
//
// Lines in your notes tagged with one of the vault's routing tags (#todo,
// #followup, #ROI...), and open [ ] checkboxes, are also written under the
// meeting's daily-note line with a [[Company]] link, which is where the vault agent picks
// tags up. Only your own notes go there, never the AI minutes.
//
// Earshot's part of each note sits between %% earshot:start %% and
// %% earshot:end %% markers, and the daily-note line carries an
// <!-- earshot:<id> --> marker, so filing again updates them in place and
// leaves anything you added yourself alone.
//
// Everything is driven by config.vault (see DEFAULTS); the meetings page edits it.
"use strict";

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

const DEFAULTS = {
  path: null, // the vault folder (the one with .obsidian in it)
  autoFile: true, // file each meeting once its minutes are written
  folderPattern: "{department}/Meeting Minutes",
  fileNamePattern: "{date} {title}",
  // Tag -> folder in the vault. An empty folder means "don't file" (e.g. Personal).
  departments: {
    Internal: "internal",
    Hiring: "internal/hiring",
    Vendor: "vendors",
    Personal: "",
  },
  departmentsRoot: "departments", // any other tag files to <root>/<tag> if that folder exists
  unfiledFolder: "Inbox/meetings/earshot", // untagged meetings, or tags with no folder
  dailyNote: {
    enabled: true,
    folder: null, // null = the vault's daily-notes setting (daily/notes)
    format: null, // null = the vault's daily-notes setting (MM.DD.YY)
    heading: "## Meetings",
    line: "- [[{link}|{title}]] · {time}: {summary}",
    createIfMissing: true,
  },
  transcript: "folded", // "folded" (collapsed callout), "full", or "none"
  screenshots: true, // copy presentation screenshots into the vault
  screenshotFolder: "images/earshot",
};

const pad = (n) => String(n).padStart(2, "0");

function vaultSettings(config) {
  const v = config.vault || {};
  return {
    ...DEFAULTS,
    ...v,
    departments: { ...DEFAULTS.departments, ...(v.departments || {}) },
    dailyNote: { ...DEFAULTS.dailyNote, ...(v.dailyNote || {}) },
  };
}

// Obsidian's own daily-notes settings, when the vault has them.
function obsidianDailySettings(vaultPath) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(vaultPath, ".obsidian", "daily-notes.json"), "utf8"));
    return { folder: s.folder || "", format: s.format || "YYYY-MM-DD" };
  } catch {
    return { folder: "", format: "YYYY-MM-DD" };
  }
}

// The subset of moment.js date tokens daily notes use.
function formatDate(d, format) {
  const tokens = { YYYY: d.getFullYear(), YY: String(d.getFullYear()).slice(-2), MM: pad(d.getMonth() + 1), M: d.getMonth() + 1, DD: pad(d.getDate()), D: d.getDate() };
  return format.replace(/YYYY|YY|MM|M|DD|D/g, (t) => tokens[t]);
}

const clean = (s) => String(s).replace(/[\\/:*?"<>|#^[\]]+/g, " ").replace(/\s+/g, " ").trim();
const fill = (pattern, values) => pattern.replace(/\{(\w+)\}/g, (all, k) => (k in values ? values[k] : all));

const PLATFORM_LABELS = {
  zoom: "Zoom",
  teams: "Teams",
  meet: "Google Meet",
  "teams-desktop": "Teams (desktop)",
  "zoom-desktop": "Zoom (desktop)",
  mac: "Mac recording",
};

function titleOf(m) {
  return m.title || `${PLATFORM_LABELS[m.platform] || "Meeting"} meeting`;
}

function timeOf(d) {
  let h = d.getHours();
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${pad(d.getMinutes())} ${ampm}`;
}

// Which vault folder a meeting belongs in, from its first tag that has one.
function departmentFolder(meeting, settings) {
  for (const tag of meeting.tags || []) {
    if (tag in settings.departments) {
      if (settings.departments[tag] === "") return { tag, folder: null }; // explicitly not filed
      return { tag, folder: settings.departments[tag] };
    }
    const guess = path.join(settings.departmentsRoot, tag);
    if (settings.path && fs.existsSync(path.join(settings.path, guess))) return { tag, folder: guess };
  }
  return { tag: null, folder: settings.unfiledFolder };
}

function notePath(meeting, settings) {
  const where = departmentFolder(meeting, settings);
  if (!where.folder) return { skip: `Meetings tagged ${where.tag} aren't filed (see Settings).` };
  const d = new Date(meeting.startedAt);
  const values = {
    department: where.folder,
    tag: where.tag || "",
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}${pad(d.getMinutes())}`,
    year: d.getFullYear(),
    month: pad(d.getMonth() + 1),
    title: clean(titleOf(meeting)).slice(0, 90),
    platform: meeting.platform,
  };
  // Untagged meetings go straight into the untagged folder; department ones follow the pattern.
  const folder = (where.tag ? fill(settings.folderPattern, values) : where.folder).replace(/^\/+|\/+$/g, "");
  const name = clean(fill(settings.fileNamePattern, values)) || values.date;
  return { folder, file: `${folder}/${name}.md`, department: where.folder, tag: where.tag };
}

// The one-sentence summary the minutes end with ("One-line summary: …"), or the first summary bullet.
function oneLiner(meeting) {
  if (meeting.oneLiner) return meeting.oneLiner;
  const minutes = meeting.minutes || "";
  const bullet = /\*\*Summary\*\*\s*\n+\s*[-*] (.+)/i.exec(minutes) || /^\s*[-*] (.+)$/m.exec(minutes);
  return bullet ? bullet[1].trim() : `${(meeting.segments || []).length} lines captured.`;
}

function elapsed(fromIso, atMs) {
  const total = Math.max(0, Math.round((atMs - Date.parse(fromIso)) / 1000));
  const h = Math.floor(total / 3600);
  const mm = Math.floor((total % 3600) / 60);
  const ss = total % 60;
  return h ? `${h}:${pad(mm)}:${pad(ss)}` : `${pad(mm)}:${pad(ss)}`;
}

function rawAttendees(m) {
  const names = new Set(Object.values(m.participants || {}));
  for (const s of m.segments || []) if (s.speakerResolved !== false) names.add(s.speaker);
  return [...names].filter(Boolean);
}

// ---------------------------------------------------------------- the vault's people (shared with the vault agent)
//
// Your vault agent keeps who's who in the vault: a page per person in people/ (with the
// spellings captions produce as `aliases:`), and each company's departments/<Co>/<Co> Names.md
// (`### Full Name` entries with a "Spelling variants" line). Earshot uses the same list, so the
// names it files are the ones the vault agent would write, and the AI minutes spell them right.

// Labels that aren't people: the Mac recorder's far-side track, platform placeholders.
const NOT_PEOPLE = /^(call|me|you|unknown|guest|host|speaker(\s*\d+)?|participant(\s*\d+)?|room|meeting room|conference room(\s*\S+)?)$/i;

function vaultPeople(vaultPath) {
  const people = []; // { name, aliases: [], client }
  const byName = new Map();
  const add = (name, aliases, client) => {
    name = String(name || "").replace(/\[\[|\]\]/g, "").trim();
    if (!/^\S+( \S+){1,3}$/.test(name)) return; // full names only
    let p = byName.get(name.toLowerCase());
    if (!p) byName.set(name.toLowerCase(), (p = { name, aliases: [], client: client || null })), people.push(p);
    for (const a of aliases) if (a && a.toLowerCase() !== name.toLowerCase() && !p.aliases.includes(a)) p.aliases.push(a);
    if (!p.client && client) p.client = client;
  };
  if (!vaultPath) return people;
  const peopleDir = path.join(vaultPath, "people");
  for (const file of safeList(peopleDir)) {
    if (!file.endsWith(".md")) continue;
    const head = readHead(path.join(peopleDir, file));
    const fm = (head.match(/^---\r?\n([\s\S]*?)\r?\n---/) || [])[1] || "";
    const aliases = [...((fm.match(/^aliases:\s*\[(.*)\]\s*$/m) || [])[1] || "").matchAll(/"([^"]+)"|'([^']+)'/g)].map((m) => m[1] || m[2]);
    const client = (fm.match(/^client:\s*["']?\[\[([^\]|#]+)/m) || [])[1] || null;
    add(file.slice(0, -3), aliases, client);
  }
  const depts = path.join(vaultPath, "departments");
  for (const co of safeList(depts)) {
    const text = readHead(path.join(depts, co, `${co} Names.md`), 400 * 1024);
    for (const section of text.split(/^### /m).slice(1)) {
      const lines = section.split("\n");
      const variants = lines.slice(1, 12).find((l) => /spelling variant/i.test(l)) || "";
      add(lines[0], [...variants.matchAll(/["“]([^"”]+)["”]/g)].map((m) => m[1]), co);
    }
  }
  return people;
}

function safeList(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function readHead(file, bytes = 4096) {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(bytes);
      return buf.subarray(0, fs.readSync(fd, buf, 0, bytes, 0)).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

// One caption name -> the vault's spelling, or the name as captured when nothing is sure.
// Returns null for labels that aren't people.
function resolveName(raw, people) {
  let name = String(raw || "").replace(/\[\[|\]\]/g, "").replace(/\s+/g, " ").trim();
  if (!name || NOT_PEOPLE.test(name)) return null;
  if (!name.includes(" ")) name = name.replace(/([a-z])([A-Z])/g, "$1 $2"); // "DanaPark"
  const match = (candidate) => {
    const low = candidate.toLowerCase();
    const exact = people.filter((p) => p.name.toLowerCase() === low || p.aliases.some((a) => a.toLowerCase() === low));
    if (exact.length === 1) return exact[0].name;
    // "averywong", "Avery  Wong": the same letters as a vault name, spaces aside.
    const squashed = low.replace(/[^a-z0-9]/g, "");
    const same = squashed.length > 5 ? people.filter((p) => p.name.toLowerCase().replace(/[^a-z0-9]/g, "") === squashed) : [];
    if (same.length === 1) return same[0].name;
    if (!candidate.includes(" ")) {
      const first = people.filter((p) => p.name.toLowerCase().split(" ")[0] === low);
      if (first.length === 1) return first[0].name;
    }
    return null;
  };
  // Zoom and Teams add a company or a device to the display name: "Robin Hayes, Acme IT",
  // "Robin (mobile)". Those count only when the bare name is someone the vault knows.
  const bare = name.replace(/\s*\([^)]*\)\s*$/, "").replace(/,.*$/, "").trim();
  return match(name) || (bare && bare !== name && match(bare)) || name;
}

function attendees(m, people = []) {
  const out = [];
  for (const raw of rawAttendees(m)) {
    const name = resolveName(raw, people);
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

// The meeting's people as the vault spells them (for the minutes prompt and the filed note).
function resolveAttendees(meeting, config) {
  return attendees(meeting, vaultPeople(vaultSettings(config).path));
}

// Spellings the vault has learned (people with aliases), for the minutes prompt's glossary.
// Only people at the meeting's companies, plus your own team (Internal), so the prompt stays short.
function vaultGlossary(meeting, config) {
  const companies = new Set([...(meeting.tags || []), "Internal"]);
  const out = {};
  for (const p of vaultPeople(vaultSettings(config).path)) {
    if (!p.aliases.length || (p.client && !companies.has(p.client))) continue;
    out[p.name] = p.aliases;
  }
  return out;
}

// The vault's routing tags (the daily note's tag legend). The first five are
// the ones Earshot offers as buttons; the rest are honoured when typed.
const NOTE_TAGS = ["todo", "followup", "ROI", "opportunity", "insight", "timeline", "background", "research", "vendor"];
const LINE_TAGS = { todo: "To-do", followup: "Follow-up", roi: "ROI", opportunity: "Opportunity", insight: "Insight" };
// Tags on transcript blocks from before (key, action, question, idea) read as the nearest one.
const LEGACY_TAGS = { action: "todo", question: "followup", idea: "opportunity", key: "insight" };
function lineTag(id) {
  const key = LEGACY_TAGS[id] || id;
  return LINE_TAGS[key] ? { id: key, tag: key === "roi" ? "ROI" : key, label: LINE_TAGS[key] } : null;
}

const TAG_WORD = new RegExp(`(^|\\s)#(${NOTE_TAGS.join("|")})(?![\\w-])`, "gi");
const canonical = (t) => NOTE_TAGS.find((v) => v.toLowerCase() === t.toLowerCase());

// The company note a [[link]] can point at: departments/<Co>/<Co>.md.
function companyLink(folder, settings) {
  if (!folder || !settings.path) return null;
  const name = path.basename(folder);
  return fs.existsSync(path.join(settings.path, folder, `${name}.md`)) ? name : null;
}

// Your tagged note lines (and open checkboxes, as #todo), as daily-note bullets.
function taggedLines(meeting, company) {
  const out = [];
  for (const raw of String(meeting.notes || "").split("\n")) {
    const line = raw.trim();
    const box = /^[-*] \[([ xX])\]/.exec(line);
    const tags = [...line.matchAll(TAG_WORD)].map((m) => canonical(m[2]));
    if (!tags.length && !(box && box[1] === " ")) continue;
    if (box && box[1] !== " ") continue; // a ticked box is already done
    let text = line.replace(/^([-*•]|\d+[.)])\s+(\[[ xX]\]\s+)?/, "").replace(TAG_WORD, " ").replace(/\s+/g, " ").trim();
    if (!text) continue;
    if (company && !text.includes(`[[${company}`)) text += ` [[${company}]]`;
    out.push(`\t- ${text} ${[...new Set(tags.length ? tags : ["todo"])].map((t) => `#${t}`).join(" ")}`);
  }
  return out;
}

// `people` (the vault's) gives the transcript the same spelling of each speaker as the attendees.
function noteBody(meeting, settings, screenshotLinks, people = []) {
  const d = new Date(meeting.startedAt);
  const lines = [];
  const minutes = (meeting.minutes || "").trim();
  // Your own notes first: they're what you chose to write down.
  if (meeting.notes && meeting.notes.trim()) lines.push("## My notes", "", meeting.notes.trim(), "");
  lines.push(minutes ? minutes.replace(/^#{1,3} .+\n+/, "") : "_Minutes haven't been written yet._", "");
  if (screenshotLinks.length) {
    lines.push("## Presented", "");
    for (const s of screenshotLinks) lines.push(`![[${s.link}]]`, `*${s.when}*`, "");
  }
  if (settings.transcript !== "none" && (meeting.segments || []).length) {
    const body = [];
    let last = null;
    const names = new Map();
    const label = (raw) => {
      if (!names.has(raw)) names.set(raw, resolveName(raw, people) || raw);
      return names.get(raw);
    };
    for (const s of meeting.segments) {
      if (s.speakerId !== last) body.push(`**${label(s.speaker)}** [${elapsed(meeting.startedAt, s.startedAt)}]`);
      body.push(`${lineTag(s.reaction) ? `[${lineTag(s.reaction).label}] ` : ""}${s.text}`, "");
      last = s.speakerId;
    }
    if (settings.transcript === "folded") lines.push(`> [!quote]- Transcript (${meeting.segments.length} lines)`, ...body.map((l) => `> ${l}`.trimEnd()), "");
    else lines.push("## Transcript", "", ...body);
  }
  lines.push(`*Captured by Earshot from ${PLATFORM_LABELS[meeting.platform] || meeting.platform} on ${d.toDateString()} at ${timeOf(d)}.*`);
  return lines.join("\n");
}

function frontmatter(meeting, where, people = []) {
  const d = new Date(meeting.startedAt);
  const list = (items) => `[${items.map((t) => JSON.stringify(t)).join(", ")}]`;
  return [
    "---",
    "type: meeting",
    `title: ${JSON.stringify(titleOf(meeting))}`,
    `date: ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    `time: "${pad(d.getHours())}:${pad(d.getMinutes())}"`,
    `company: ${JSON.stringify(where.tag || "")}`,
    `tags: ${list(["meeting", ...(meeting.tags || []).map((t) => t.replace(/\s+/g, "-"))])}`,
    `attendees: ${list(attendees(meeting, people).map((a) => `[[${a}]]`))}`,
    `platform: ${meeting.platform}`,
    `summary: ${JSON.stringify(oneLiner(meeting))}`,
    `earshot_id: ${meeting.id}`,
    "---",
    "",
  ].join("\n");
}

const START = "%% earshot:start %%";
const END = "%% earshot:end %%";

// Replace Earshot's section (and frontmatter) of an existing note; keep the rest.
function mergeNote(existing, frontmatterText, body) {
  const section = `${START}\n${body}\n${END}`;
  if (!existing) return `${frontmatterText}${section}\n`;
  const rest = existing.replace(/^---\n[\s\S]*?\n---\n\n?/, "");
  // A function, not the string: "$&" or "$$" in a transcript would otherwise be read as a replace pattern.
  const merged = rest.includes(START) && rest.includes(END) ? rest.replace(new RegExp(`${START}[\\s\\S]*?${END}`), () => section) : `${section}\n\n${rest}`;
  return `${frontmatterText}${merged.replace(/\n*$/, "\n")}`;
}

async function writeFileAtomic(file, text) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.earshot-tmp-${process.pid}`; // the helper and the MCP server can file at once
  try {
    await fsp.writeFile(tmp, text);
    await fsp.rename(tmp, file);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

async function updateDailyNote(meeting, settings, link, children = []) {
  const daily = settings.dailyNote;
  if (!daily.enabled) return null;
  const fromObsidian = obsidianDailySettings(settings.path);
  const d = new Date(meeting.startedAt);
  const rel = path.join(daily.folder ?? fromObsidian.folder, `${formatDate(d, daily.format || fromObsidian.format)}.md`);
  const file = path.join(settings.path, rel);
  const marker = `<!-- earshot:${meeting.id} -->`;
  const line = `${fill(daily.line, { link, title: titleOf(meeting), time: timeOf(d), summary: oneLiner(meeting), tags: (meeting.tags || []).join(", ") })} ${marker}`;
  let text = fs.existsSync(file) ? await fsp.readFile(file, "utf8") : null;
  if (text === null) {
    if (!daily.createIfMissing) return null;
    text = `${daily.heading}\n\n`;
  }
  const lines = text.split("\n");
  let at = lines.findIndex((l) => l.includes(marker));
  if (at >= 0) {
    lines[at] = line;
    // Take out the tagged lines Earshot wrote last time; anything you added stays.
    // ...and the ones about to be written again, when the record of last time's lines was lost
    // (filed from Claude, then again from Chrome), so filing twice never doubles them.
    const written = new Set([...(meeting.vaultDailyLines || []), ...children]);
    while (at + 1 < lines.length && written.has(lines[at + 1])) lines.splice(at + 1, 1);
  } else {
    const h = lines.findIndex((l) => l.trim() === daily.heading.trim());
    if (h < 0) lines.push("", daily.heading, "", line);
    else {
      // Right under the heading, after any earlier Earshot lines (oldest first)
      // and the tagged lines indented under them.
      at = h + 1;
      while (at < lines.length && lines[at].trim() === "") at++;
      while (at < lines.length && (lines[at].includes("<!-- earshot:") || (/^\s+- /.test(lines[at]) && at > h + 1 && /<!-- earshot:|^\s+- /.test(lines[at - 1])))) at++;
      lines.splice(at, 0, line);
    }
    if (h < 0) at = lines.length - 1;
  }
  lines.splice(at + 1, 0, ...children);
  await writeFileAtomic(file, lines.join("\n"));
  return rel;
}

// Where the meeting's note is now: where Earshot last put it, or (when the vault agent moved it) wherever a
// note with its earshot_id sits. The vault agent keeps the file name, so only notes dated that day are read.
function findNote(meeting, settings, previous) {
  if (previous && fs.existsSync(path.join(settings.path, previous))) return previous;
  const d = new Date(meeting.startedAt);
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const marker = new RegExp(`^earshot_id: ${meeting.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m");
  const folders = [settings.unfiledFolder, path.join("Inbox", "meetings", "personal")];
  for (const root of [settings.departmentsRoot, ...Object.values(settings.departments).filter(Boolean)]) {
    folders.push(path.join(root, "Meeting Minutes"));
    if (root === settings.departmentsRoot) for (const co of safeList(path.join(settings.path, root))) folders.push(path.join(root, co, "Meeting Minutes"));
  }
  for (const folder of [...new Set(folders)]) {
    for (const file of safeList(path.join(settings.path, folder))) {
      if (!file.startsWith(day) || !file.endsWith(".md")) continue;
      const rel = path.join(folder, file);
      if (marker.test(readHead(path.join(settings.path, rel)))) return rel;
    }
  }
  return null;
}

// The vault agent's overnight fixes (agent_checked: in the frontmatter): it files what Earshot couldn't, and
// sets company, tags, attendees and (for a generic or wrong title) the title from the vault. A re-file keeps them, and the note's place,
// unless you changed the meeting's tags or title in Earshot since, which starts the vault agent over.
const AGENT_KEYS = ["title", "company", "tags", "attendees", "agent_checked"];
function keepAgentFixes(existing, frontmatterText, merged) {
  const fm = (existing.match(/^---\n([\s\S]*?)\n---/) || [])[1] || "";
  if (!/^agent_checked:/m.test(fm)) return merged;
  let front = frontmatterText;
  for (const key of AGENT_KEYS) {
    const line = (fm.match(new RegExp(`^${key}:.*$`, "m")) || [])[0];
    if (!line) continue;
    const re = new RegExp(`^${key}:.*$`, "m");
    front = re.test(front) ? front.replace(re, () => line) : front.replace(/\n---\n$/, () => `\n${line}\n---\n`);
  }
  let out = merged.replace(frontmatterText, () => front);
  // The Attendees: and Tags: lines at the top of the minutes are the vault agent's too.
  const oldSection = (existing.match(new RegExp(`${START}([\\s\\S]*?)${END}`)) || [])[1] || "";
  for (const key of ["Attendees", "Tags"]) {
    const line = (oldSection.match(new RegExp(`^${key}: .*$`, "m")) || [])[0];
    if (line) out = out.replace(new RegExp(`(${START}[\\s\\S]*?)^${key}: .*$`, "m"), (all, before) => `${before}${line}`);
  }
  return out;
}

// File (or re-file) a meeting. `previous` is where it was filed before, so a
// changed title or tag moves the note instead of leaving a copy behind.
async function fileMeeting(meeting, config, { previous = null, shotFile = null } = {}) {
  const settings = vaultSettings(config);
  if (!settings.path) return { filed: false, reason: "No vault is set. Choose it in Earshot's settings." };
  if (!fs.existsSync(path.join(settings.path, ".obsidian"))) return { filed: false, reason: `${settings.path} isn't an Obsidian vault.` };
  const where = notePath(meeting, settings);
  if (where.skip) return { filed: false, reason: where.skip };
  // Earshot's own choice last time (`planned`); older records only have where the note went.
  const lastPlanned = meeting.lastFiling?.planned || previous;
  const changedHere = Boolean(lastPlanned && lastPlanned !== where.file);
  const found = findNote(meeting, settings, previous);
  let rel = where.file;
  if (found && !changedHere) rel = found; // where the vault agent (or Earshot before) put it
  else if (found && found !== where.file && !fs.existsSync(path.join(settings.path, where.file))) {
    await fsp.mkdir(path.dirname(path.join(settings.path, where.file)), { recursive: true });
    await fsp.rename(path.join(settings.path, found), path.join(settings.path, where.file));
  }
  // Another meeting's note already has this name (same title, same day): it isn't written over;
  // this one gets the end of its id in the name (the same name every time, so a re-file finds it).
  const taken = readHead(path.join(settings.path, rel)).match(/^earshot_id: (.+?)\s*$/m);
  if (taken && taken[1] !== String(meeting.id)) rel = rel.replace(/\.md$/, ` ${String(meeting.id).replace(/[^A-Za-z0-9]/g, "").slice(-6) || "2"}.md`);
  const file = path.join(settings.path, rel);
  const department = path.dirname(rel).replace(/\/Meeting Minutes$/, "");

  const screenshotLinks = [];
  if (settings.screenshots && shotFile) {
    for (const shot of meeting.screenshots || []) {
      const src = shotFile(shot);
      if (!src || !fs.existsSync(src)) continue;
      const shotRel = path.join(settings.screenshotFolder, `${path.basename(rel, ".md")} ${elapsed(meeting.startedAt, shot.at).replace(/:/g, "-")}.jpg`);
      await fsp.mkdir(path.join(settings.path, path.dirname(shotRel)), { recursive: true });
      await fsp.copyFile(src, path.join(settings.path, shotRel));
      screenshotLinks.push({ link: shotRel, when: `Presented at ${elapsed(meeting.startedAt, shot.at)}` });
    }
  }

  const existing = fs.existsSync(file) ? await fsp.readFile(file, "utf8") : null;
  const people = vaultPeople(settings.path);
  const front = frontmatter(meeting, where, people);
  let text = mergeNote(existing, front, noteBody(meeting, settings, screenshotLinks, people));
  if (existing && !changedHere) text = keepAgentFixes(existing, front, text);
  await writeFileAtomic(file, text);
  const link = rel.replace(/\.md$/, "");
  const dailyLines = settings.dailyNote.enabled ? taggedLines(meeting, companyLink(department, settings)) : [];
  const daily = await updateDailyNote(meeting, settings, link, dailyLines);
  // `title` is Earshot's title as filed: the base the vault sync compares both sides with.
  return { filed: true, note: rel, planned: where.file, title: titleOf(meeting), daily, dailyLines: daily ? dailyLines : [], vault: path.basename(settings.path), filedAt: new Date().toISOString() };
}

// ---------------------------------------------------------------- the vault sync
//
// Code, not AI: each filed note carries `earshot_id:`, so a note is found by id wherever the vault agent (or
// you) moved it, and its frontmatter title is compared with Earshot's. The base is the title
// Earshot last filed (lastFiling.title):
//   vault changed, Earshot didn't   -> Earshot takes the vault's title (the vault agent fixed it, or you did)
//   Earshot changed, vault didn't   -> the note is filed again, so the vault gets Earshot's title
//   both changed                    -> Earshot keeps its own; the meeting shows the vault's, to pick
//   no base (filed before the sync) -> a placeholder title (Meet's room code, "Zoom meeting") takes
//                                      the vault's; any other difference is only shown
// A filed meeting whose note is gone from the vault is marked (`vaultMissing`), and says whether
// it's in the vault's .trash (deleted in Obsidian).

const SKIP_DIRS = new Set([".obsidian", ".git", ".trash", "node_modules", ".earshot"]);
const ID_LINE = /^earshot_id:\s*["']?([^"'\s]+)["']?\s*$/m;

function frontTitle(fm) {
  const raw = (fm.match(/^title:\s*(.*)$/m) || [])[1];
  if (raw === undefined) return null;
  const v = raw.trim();
  if (/^".*"$/.test(v)) {
    try {
      return JSON.parse(v).trim();
    } catch {}
  }
  return v.replace(/^['"]|['"]$/g, "").trim() || null;
}

function scanNotes(root, rel, out, skip) {
  let entries;
  try {
    entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const child = rel ? path.join(rel, e.name) : e.name;
    if (e.isDirectory()) {
      if (!skip.has(e.name)) scanNotes(root, child, out, skip);
    } else if (e.isFile() && e.name.endsWith(".md")) {
      const head = readHead(path.join(root, child));
      const fm = (head.match(/^---\r?\n([\s\S]*?)\r?\n---/) || [])[1];
      const id = fm && (fm.match(ID_LINE) || [])[1];
      if (!id) continue;
      let mtime = null;
      try {
        mtime = fs.statSync(path.join(root, child)).mtime.toISOString();
      } catch {}
      const list = out.get(id) || out.set(id, []).get(id);
      list.push({ rel: child, title: frontTitle(fm), agentChecked: /^agent_checked:/m.test(fm), mtime });
    }
  }
}

// earshot_id -> the notes that carry it, in the vault and in its .trash.
function vaultNotes(vaultPath) {
  const notes = new Map();
  const trashed = new Map();
  if (!vaultPath) return { notes, trashed };
  scanNotes(vaultPath, "", notes, SKIP_DIRS);
  scanNotes(path.join(vaultPath, ".trash"), "", trashed, new Set([".git"]));
  return { notes, trashed };
}

const normTitle = (t) => String(t || "").replace(/\s+/g, " ").trim();
// Titles that are only a stand-in: a Meet room code, a Zoom number, "Zoom meeting", nothing.
function placeholderTitle(m) {
  const t = normTitle(m.title);
  if (!t) return true;
  if (/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(t) || /^\d[\d\s-]{7,14}$/.test(t)) return true;
  if (m.meetingRef && t === String(m.meetingRef)) return true;
  if (Object.values(PLATFORM_LABELS).some((l) => t.toLowerCase() === `${l} meeting`.toLowerCase())) return true;
  return /^(untitled|meeting|zoom meeting|microsoft teams meeting|google meet|new meeting|meeting transcription)$/i.test(t);
}

// What the sync changes on one meeting record (the same on every copy; see applyVaultSync).
// Returns null when nothing changes, else { patch, refile }.
function syncDecision(m, found, trashed, settings) {
  const filed = m.vaultNote || null;
  const notes = found || [];
  // Where its note is: the one Earshot filed to if it's still there, else wherever its id is.
  const note = notes.find((n) => n.rel === filed) || notes[0] || null;
  const patch = {};
  if (!note) {
    if (!filed) return null;
    const bin = (trashed || [])[0];
    const missing = { note: filed, trashed: !!bin, at: bin?.mtime || null };
    const had = m.vaultMissing;
    if (had && had.note === missing.note && had.trashed === missing.trashed) return null;
    return { patch: { vaultMissing: missing }, refile: false };
  }
  if (m.vaultMissing) patch.vaultMissing = null;
  if (note.rel !== filed) patch.vaultNote = note.rel; // moved (the vault agent files Inbox notes to their company)
  const vaultTitle = normTitle(note.title);
  const ours = normTitle(m.title);
  const base = m.lastFiling && typeof m.lastFiling.title === "string" ? normTitle(m.lastFiling.title) : null;
  let refile = false;
  // Earshot's own choice of path for the vault's title: a filing after taking it keeps the note where it is.
  const plannedFor = (title) => {
    const where = notePath({ ...m, title }, settings);
    return where.skip ? null : where.file;
  };
  const adopt = () => {
    patch.title = vaultTitle;
    patch.planned = plannedFor(vaultTitle);
    if (m.vaultTitle) patch.vaultTitle = null;
  };
  // Shown on the meeting, with a button to take it (the same patch as adopt()).
  const offer = () => {
    if (m.vaultTitle?.title !== vaultTitle) patch.vaultTitle = { title: vaultTitle, planned: plannedFor(vaultTitle) };
  };
  // The vault's title cut short at a " - " or ":" (how notes from other tools are often named) isn't a fix.
  const shortened = vaultTitle && ours.toLowerCase().startsWith(vaultTitle.toLowerCase()) && /^\s*[-–—:|]/.test(ours.slice(vaultTitle.length));
  if (vaultTitle && vaultTitle !== ours) {
    if (base !== null && vaultTitle === base) refile = true; // only Earshot's changed
    else if (shortened) {
      if (m.vaultTitle) patch.vaultTitle = null;
    } else if (base !== null) {
      if (ours === base) adopt();
      else offer(); // both changed
    } else if (placeholderTitle(m) && !placeholderTitle({ title: vaultTitle })) adopt();
    else offer();
  } else if (m.vaultTitle) patch.vaultTitle = null;
  if (!Object.keys(patch).length && !refile) return null;
  return { patch, refile };
}

// A sync patch on a meeting record. The extension's core has the same (Earshot.applyVaultSync).
function applyVaultSync(m, patch) {
  if ("title" in patch && patch.title) {
    m.title = patch.title;
    m.titleEdited = true;
    m.lastFiling = { ...(m.lastFiling || {}), title: patch.title, ...(patch.planned ? { planned: patch.planned } : {}) };
  }
  if (patch.vaultNote) m.vaultNote = patch.vaultNote;
  for (const k of ["vaultMissing", "vaultTitle"]) {
    if (!(k in patch)) continue;
    if (patch[k] === null) delete m[k];
    else m[k] = patch[k];
  }
  m.vaultCheckedAt = new Date().toISOString();
  return m;
}

// The decisions for a set of meetings ({id, title, meetingRef, platform, tags, startedAt,
// vaultNote, lastFiling, vaultMissing, vaultTitle}).
function syncVault(meetings, config) {
  const settings = vaultSettings(config);
  if (!settings.path || !fs.existsSync(path.join(settings.path, ".obsidian"))) return { ok: false, reason: "No vault is set.", results: [] };
  const { notes, trashed } = vaultNotes(settings.path);
  const results = [];
  for (const m of meetings) {
    if (!m || !m.id) continue;
    const d = syncDecision(m, notes.get(String(m.id)), trashed.get(String(m.id)), settings);
    if (d) results.push({ id: m.id, ...d });
  }
  return { ok: true, results, notes: notes.size, checkedAt: new Date().toISOString() };
}

// ---------------------------------------------------------------- two captures of one call
//
// The browser (captions) and the Mac app (audio) can each save the same call. When two meetings
// overlap for most of the shorter one, and either one is a desktop recording or they share two
// speakers, the one with fewer lines is a copy of the other. It isn't filed automatically.

const DESKTOP = new Set(["mac", "teams-desktop", "zoom-desktop"]);
const isImported = (r) => r.platform === "import" || r.source === "import"; // imported history, not a capture
const RECENT_MS = 6 * 60 * 60 * 1000;
function span(r, now) {
  const start = Date.parse(r.startedAt);
  let end = Date.parse(r.endedAt);
  if (!Number.isFinite(end)) end = now - start < RECENT_MS ? now : NaN; // still going, or never ended
  return Number.isFinite(start) && Number.isFinite(end) && end > start ? [start, end] : null;
}

function sameCall(a, b, now) {
  if (a.id === b.id) return false;
  const sa = span(a, now);
  const sb = span(b, now);
  if (!sa || !sb) return false;
  const overlap = Math.min(sa[1], sb[1]) - Math.max(sa[0], sb[0]);
  const shorter = Math.min(sa[1] - sa[0], sb[1] - sb[0]);
  if (overlap < 0.5 * shorter) return false;
  if (DESKTOP.has(a.platform) !== DESKTOP.has(b.platform)) return true;
  const theirs = new Set((b.speakers || []).map((s) => String(s).toLowerCase()));
  return (a.speakers || []).filter((s) => theirs.has(String(s).toLowerCase())).length >= 2;
}

// The fuller copy `row` duplicates, or null. Fewer lines is the copy; a tie goes to the longer.
function duplicateOf(row, rows, now = Date.now()) {
  let best = null;
  for (const other of rows) {
    if (!other || isImported(other) || isImported(row) || !sameCall(row, other, now)) continue;
    const mine = row.segmentCount ?? (row.segments || []).length;
    const theirs = other.segmentCount ?? (other.segments || []).length;
    const sr = span(row, now);
    const so = span(other, now);
    const fuller = theirs > mine || (theirs === mine && so[1] - so[0] > sr[1] - sr[0]) || (theirs === mine && so[1] - so[0] === sr[1] - sr[0] && String(other.id) < String(row.id));
    if (fuller && (!best || theirs > (best.segmentCount ?? 0))) best = { id: other.id, title: other.title || null, platform: other.platform, segmentCount: theirs };
  }
  return best;
}

function findDuplicates(rows, now = Date.now()) {
  const out = {};
  for (const r of rows) {
    const d = duplicateOf(r, rows, now);
    if (d) out[r.id] = d;
  }
  return out;
}

// Where a meeting would go, without writing anything.
function preview(meeting, config) {
  const settings = vaultSettings(config);
  const where = notePath(meeting, settings);
  return where.skip ? { filed: false, reason: where.skip } : { note: where.file, department: where.department };
}

module.exports = { PLATFORM_LABELS, DEFAULTS, vaultSettings, fileMeeting, preview, oneLiner, formatDate, lineTag, taggedLines, resolveAttendees, vaultGlossary, vaultPeople, resolveName, syncVault, syncDecision, applyVaultSync, vaultNotes, placeholderTitle, duplicateOf, findDuplicates };
