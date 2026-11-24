#!/usr/bin/env node
// Earshot MCP server: lets Claude (Code or Desktop) read your Earshot meetings
// in ~/Earshot and file them into your Obsidian vault.
//
// Speaks MCP over stdio (newline-delimited JSON-RPC). No dependencies; it
// reuses the helper's own code for reading meetings and filing them.
//
//   claude mcp add -s user earshot -- node ~/Earshot/helper/mcp.js
"use strict";

const fs = require("fs");
const path = require("path");
const helper = require("./host.js");
const vault = require("./vault.js");

const VERSION = "0.5.0";

// ---------------------------------------------------------------- reading meetings

const day = (iso) => String(iso || "").slice(0, 10);
const norm = (s) => String(s || "").toLowerCase();
const wordsOf = (q) => norm(q).split(/\s+/).filter(Boolean);
// For names and titles: every word appears somewhere.
const hasAll = (text, words) => {
  const t = norm(text);
  return words.every((w) => t.includes(w));
};

// For what was said: punctuation counts as a space ("no-show" finds "no show"),
// short words match whole ("no" isn't "know"), longer ones also as a prefix
// ("migrat" finds "migration"), and all the words must be close together,
// because one imported turn can run to thousands of characters.
const flat = (s) => norm(s).replace(/[^a-z0-9]/g, " ");
// Each word of the query is a term; a "quoted phrase" or a hyphenated word
// ("no-show") is one term whose parts must be next to each other.
const termsOf = (q) =>
  [...String(q || "").matchAll(/"([^"]+)"|(\S+)/g)]
    .map((m) => flat(m[1] ?? m[2]).trim().replace(/\s+/g, " "))
    .filter(Boolean);
const NEAR = 250;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const termRe = (w) => new RegExp(`(?<![a-z0-9])${escapeRe(w)}${w.length < 4 ? "(?![a-z0-9])" : ""}`, "g");
// Where the terms are found together in text (a character position), or -1.
function matchAt(text, terms) {
  if (!terms.length) return 0;
  const t = flat(text);
  if (terms.length > 1) {
    const phrase = termRe(terms.join(" ")).exec(t);
    if (phrase) return phrase.index;
  }
  const spots = terms.map((w) => [...t.matchAll(termRe(w))].map((m) => m.index));
  if (spots.some((at) => !at.length)) return -1;
  for (const at of spots[0]) if (spots.every((other) => other.some((o) => Math.abs(o - at) <= NEAR))) return at;
  return -1;
}

// Index rows (with their folder), newest first.
async function summaries({ from, to, tag, source } = {}) {
  const index = await helper.loadIndex();
  return Object.values(index.meetings)
    .filter((r) => r && r.folder)
    .filter((r) => (!from || day(r.startedAt) >= from) && (!to || day(r.startedAt) <= to))
    .filter((r) => !tag || (r.tags || []).some((t) => norm(t) === norm(tag)))
    .filter((r) => !source || (source === "import") === (r.platform === "import"))
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}

// Search reads every meeting, so records are kept in memory until their file changes.
const cache = new Map(); // id -> { stamp, meeting }
function load(row) {
  const file = path.join(row.folder, "meeting.json");
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  const stamp = `${st.mtimeMs}:${st.size}`;
  const hit = cache.get(row.id);
  if (hit && hit.stamp === stamp) return hit.meeting;
  try {
    const meeting = JSON.parse(fs.readFileSync(file, "utf8"));
    cache.set(row.id, { stamp, meeting });
    return meeting;
  } catch {
    return null;
  }
}

// A meeting by id, or the most recent one whose title contains the words given.
async function resolve(ref) {
  if (!ref) throw new Error("Give a meeting id or title.");
  const rows = await summaries();
  const words = wordsOf(ref);
  const row = rows.find((r) => r.id === ref) || rows.find((r) => hasAll(r.title, words));
  if (!row) throw new Error(`No meeting matches "${ref}". Use list_meetings or search_meetings to find it.`);
  const meeting = load(row);
  if (!meeting) throw new Error(`Meeting ${row.id} has no saved record.`);
  return { row, meeting };
}

function when(m) {
  const d = new Date(m.startedAt);
  return `${day(m.startedAt)} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function duration(m) {
  const ms = Date.parse(m.endedAt || "") - Date.parse(m.startedAt);
  return ms > 0 ? `${Math.round(ms / 60000)} min` : null;
}

const sourceOf = (m) => (m.platform === "import" ? "Imported" : "Earshot");

function rowLine(r) {
  const extras = [(r.tags || []).length ? `[${r.tags.join(", ")}]` : "", duration(r), `${r.segmentCount || 0} lines`, r.hasMinutes ? "minutes" : "", r.platform === "import" ? "imported" : ""];
  return `- ${when(r)} · ${helper.titleOf(r)} · ${extras.filter(Boolean).join(" · ")} · id: ${r.id}`;
}

// Where to open it: the meeting's folder, the vault note and the imported original.
async function links(m, row) {
  const out = [`Folder: ${row.folder}`];
  if (m.vaultNote) {
    const vaultPath = (await helper.loadConfig()).vault?.path;
    out.push(`Vault note: ${m.vaultNote}${vaultPath ? ` (obsidian://open?path=${encodeURIComponent(path.join(vaultPath, m.vaultNote))})` : ""}`);
  }
  if (m.imported?.url) out.push(`Original: ${m.imported.url}`);
  return out.join("\n");
}

// Consecutive lines from one speaker form a numbered turn. The numbers are
// stable, so a search hit (#12) can be widened with expand_excerpt.
function turnsOf(m) {
  const turns = [];
  for (const s of m.segments || []) {
    const tag = vault.lineTag(s.reaction);
    const text = `${tag ? `[${tag.label}] ` : ""}${s.text}`;
    const last = turns[turns.length - 1];
    if (last && last.speakerId === s.speakerId) last.text += ` ${text}`;
    else turns.push({ n: turns.length + 1, speakerId: s.speakerId, speaker: s.speaker, at: s.startedAt, text });
  }
  return turns;
}
const turnLine = (m, t) => `#${t.n} ${t.speaker} [${helper.elapsed(m.startedAt, t.at)}]: ${t.text}`;

// Fixed pages of about PAGE_CHARS, so the same page number always shows the same turns.
const PAGE_CHARS = 20000;
function pagesOf(m, turns) {
  const pages = [[]];
  let size = 0;
  for (const t of turns) {
    const len = turnLine(m, t).length + 2;
    if (size + len > PAGE_CHARS && pages[pages.length - 1].length) {
      pages.push([]);
      size = 0;
    }
    pages[pages.length - 1].push(t);
    size += len;
  }
  return pages;
}

// "mm:ss", "h:mm:ss" or plain minutes, as seconds from the start.
function offset(text) {
  if (text === undefined || text === null || text === "") return null;
  const parts = String(text).trim().split(":").map(Number);
  if (parts.some(Number.isNaN)) throw new Error(`Can't read the time "${text}"; use mm:ss or h:mm:ss.`);
  if (parts.length === 1) return parts[0] * 60;
  return parts.reduce((total, n) => total * 60 + n, 0);
}
const secondsIn = (m, t) => (t.at - Date.parse(m.startedAt)) / 1000;

// Long turns (some tools credit whole stretches to one speaker) are cut to the part around the match.
function snippet(text, at, width = 180) {
  if (text.length <= width * 2) return text;
  const start = Math.max(0, at - width);
  const end = Math.min(text.length, at + width);
  return `${start ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}

function attendeeNames(m) {
  return [...new Set([...Object.values(m.participants || {}), ...(m.segments || []).map((s) => s.speaker)])].filter(Boolean);
}

// Recurring meetings share a title once dates are taken out.
function seriesKey(title) {
  return norm(title)
    .replace(/\b(19|20)\d\d[-/.]\d\d?[-/.]\d\d?\b/g, " ")
    .replace(/\b\d{1,2}[/.]\d{1,2}([/.]\d{2,4})?\b/g, " ")
    .replace(/[^a-z0-9<>&+]+/g, " ")
    .trim();
}
const GENERIC_TITLE = /^(meeting transcription|zoom meeting|google meet|teams meeting|meeting|.* s zoom meeting|.* personal meeting room)$/;

function checkboxes(text) {
  return String(text || "")
    .split("\n")
    .filter((l) => /^\s*[-*] \[[ xX]\]/.test(l))
    .map((l) => l.trim());
}

// Action items in minutes: checkboxes, plus the plain bullets imported summaries use
// under an action heading ("## Next Steps"), under an action label
// ("- Action items:" with indented bullets), or after one ("- Action: …").
const ACTION = /\b(actions?|next steps?|follow.?ups?|to-?dos?)\b/i;
function actionItems(text) {
  const out = [];
  let section = false;
  let under = null; // indent of an action label whose nested bullets are items
  for (const raw of String(text || "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const indent = raw.length - raw.trimStart().length;
    if (/^#{1,6}\s/.test(line) || /^\*\*[^*]+\*\*:?$/.test(line)) {
      section = ACTION.test(line);
      under = null;
      continue;
    }
    if (under !== null && indent <= under) under = null;
    if (/^[-*] \[[ xX]\]/.test(line)) {
      out.push(line);
      continue;
    }
    const bullet = /^[-*] (.+)$/.exec(line);
    if (!bullet) continue;
    const label = /^(?:\*\*)?([^:*]{1,40})(?:\*\*)?:\s*(.*)$/.exec(bullet[1]);
    if (label && ACTION.test(label[1])) {
      if (label[2]) out.push(`- [ ] ${label[2]}`);
      else under = indent;
      continue;
    }
    if (section || under !== null) out.push(`- [ ] ${bullet[1]}`);
  }
  return out;
}

// ---------------------------------------------------------------- tools

const MEETING = { type: "string", description: "Meeting id, or words from its title (latest match)" };
const FILTERS = {
  from: { type: "string", description: "Earliest date, YYYY-MM-DD" },
  to: { type: "string", description: "Latest date, YYYY-MM-DD" },
  tag: { type: "string", description: "e.g. Acme, Globex, Internal, Vendor" },
  source: { type: "string", enum: ["earshot", "import"], description: "Only meetings Earshot captured, or only ones imported from another tool" },
};

const TOOLS = [
  {
    name: "list_meetings",
    description: "List meetings, newest first, with date, title, tags, length and id. Filter by date range, tag, source, a recurring series (from list_series), an attendee, or words in the title.",
    inputSchema: {
      type: "object",
      properties: {
        ...FILTERS,
        query: { type: "string", description: "Words in the title" },
        attendee: { type: "string", description: "Someone who was in the meeting (part of their name)" },
        series: { type: "string", description: "A recurring meeting's title, as list_series shows it" },
        limit: { type: "number", default: 25 },
      },
    },
    async run({ from, to, tag, source, query, attendee, series, limit = 25 }) {
      let rows = await summaries({ from, to, tag, source });
      if (query) rows = rows.filter((r) => hasAll(r.title, wordsOf(query)));
      if (series) rows = rows.filter((r) => seriesKey(r.title) === seriesKey(series));
      if (attendee) rows = rows.filter((r) => attendeeNames(load(r) || {}).some((n) => hasAll(n, wordsOf(attendee))));
      if (!rows.length) return "No meetings match.";
      return `${rows.length} meeting(s)${rows.length > limit ? `, showing the newest ${limit}` : ""}:\n${rows.slice(0, limit).map(rowLine).join("\n")}`;
    },
  },
  {
    name: "list_series",
    description: "Recurring meetings (the same title more than once), most recently held first, with how many there are and when the last one was. Pass a series to list_meetings to see its meetings.",
    inputSchema: {
      type: "object",
      properties: { ...FILTERS, include_generic: { type: "boolean", default: false, description: "Also group generic titles like 'Meeting Transcription' or a personal Zoom room" }, limit: { type: "number", default: 30 } },
    },
    async run({ from, to, tag, source, include_generic = false, limit = 30 }) {
      const groups = new Map();
      for (const r of await summaries({ from, to, tag, source })) {
        const key = seriesKey(r.title);
        if (!key || (!include_generic && GENERIC_TITLE.test(key))) continue;
        if (!groups.has(key)) groups.set(key, { title: helper.titleOf(r), rows: [] });
        groups.get(key).rows.push(r);
      }
      const series = [...groups.values()].filter((g) => g.rows.length > 1);
      if (!series.length) return "No recurring meetings found.";
      const tagsOf = (g) => [...new Set(g.rows.flatMap((r) => r.tags || []))];
      return series
        .slice(0, limit)
        .map((g) => `- ${g.title} · ${g.rows.length} meetings · last ${day(g.rows[0].startedAt)}, first ${day(g.rows[g.rows.length - 1].startedAt)}${tagsOf(g).length ? ` · [${tagsOf(g).join(", ")}]` : ""}`)
        .join("\n");
    },
  },
  {
    name: "search_meetings",
    description:
      "Search what people said, your notes and the minutes. Every word must appear (in any order). Hits come grouped by meeting, newest first, as numbered turns (#12) that expand_excerpt can widen. Filter by speaker, attendee, one meeting, date range, tag or source.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words to find; leave out to list everything a speaker said" },
        speaker: { type: "string", description: "Only what this person said (part of their name)" },
        attendee: { type: "string", description: "Only meetings this person was in" },
        meeting: MEETING,
        ...FILTERS,
        limit: { type: "number", default: 20, description: "Most hits to show" },
      },
    },
    async run({ query, speaker, attendee, meeting: ref, from, to, tag, source, limit = 20 }) {
      const words = termsOf(query);
      if (!words.length && !speaker) throw new Error("Give a query, a speaker, or both.");
      const rows = ref ? [(await resolve(ref)).row] : await summaries({ from, to, tag, source });
      const groups = [];
      let total = 0;
      for (const r of rows) {
        const m = load(r);
        if (!m) continue;
        if (attendee && !attendeeNames(m).some((n) => hasAll(n, wordsOf(attendee)))) continue;
        const hits = [];
        for (const t of turnsOf(m)) {
          if (speaker && !hasAll(t.speaker, wordsOf(speaker))) continue;
          const at = matchAt(t.text, words);
          if (at < 0) continue;
          hits.push(`  #${t.n} ${t.speaker} [${helper.elapsed(m.startedAt, t.at)}]: ${snippet(t.text, at)}`);
        }
        if (!speaker && words.length) {
          for (const [label, text] of [["your notes", m.notes], ["minutes", m.minutes]]) {
            for (const line of String(text || "").split("\n")) if (line.trim() && matchAt(line, words) >= 0) hits.push(`  (${label}) ${line.trim()}`);
          }
        }
        if (!hits.length) continue;
        total += hits.length;
        groups.push({ head: `${when(m)} · ${helper.titleOf(m)} · id: ${m.id}`, hits });
      }
      if (!groups.length) return `Nothing matches${query ? ` "${query}"` : ""}${speaker ? ` from ${speaker}` : ""}.`;
      const out = [`${total} hit(s) in ${groups.length} meeting(s)${total > limit ? `, showing the newest ${limit}` : ""}. Widen a turn with expand_excerpt.`];
      let shown = 0;
      for (const g of groups) {
        if (shown >= limit) break;
        const take = g.hits.slice(0, limit - shown);
        out.push("", g.head, ...take);
        if (take.length < g.hits.length) out.push(`  … ${g.hits.length - take.length} more in this meeting`);
        shown += take.length;
      }
      return out.join("\n");
    },
  },
  {
    name: "expand_excerpt",
    description: "The conversation around one turn of a meeting: the turn (#n from search_meetings or get_transcript) with the turns before and after it.",
    inputSchema: {
      type: "object",
      properties: { meeting: MEETING, turn: { type: "number", description: "Turn number, e.g. 12 for #12" }, before: { type: "number", default: 3 }, after: { type: "number", default: 3 } },
      required: ["meeting", "turn"],
    },
    async run({ meeting: ref, turn, before = 3, after = 3 }) {
      const { meeting: m } = await resolve(ref);
      const turns = turnsOf(m);
      if (!turns[turn - 1]) throw new Error(`"${helper.titleOf(m)}" has turns #1 to #${turns.length}.`);
      const from = Math.max(0, turn - 1 - before);
      const to = Math.min(turns.length, turn + after);
      const lines = turns.slice(from, to).map((t) => (t.n === turn ? `→ ${turnLine(m, t)}` : turnLine(m, t)));
      return `# ${helper.titleOf(m)} (${when(m)}) · turns #${from + 1} to #${to} of ${turns.length}\n\n${lines.join("\n\n")}`;
    },
  },
  {
    name: "get_meeting",
    description:
      "One meeting: details, links, and whichever of your notes, the minutes, the transcript (first page) or saved Ask AI chats you ask for. Your notes are what you chose to write down, so they come first and outrank the AI minutes.",
    inputSchema: {
      type: "object",
      properties: {
        meeting: MEETING,
        include: { type: "array", items: { type: "string", enum: ["notes", "minutes", "transcript", "chats"] }, default: ["notes", "minutes"] },
      },
      required: ["meeting"],
    },
    async run({ meeting: ref, include = ["notes", "minutes"] }) {
      const { row, meeting: m } = await resolve(ref);
      const turns = turnsOf(m);
      const pages = pagesOf(m, turns);
      const out = [
        `# ${helper.titleOf(m)}`,
        `Date: ${when(m)}${duration(m) ? ` · ${duration(m)}` : ""} · Source: ${sourceOf(m)} · Tags: ${(m.tags || []).join(", ") || "none"}`,
        `Attendees: ${attendeeNames(m).join(", ") || "unknown"}`,
        `Transcript: ${turns.length} turns on ${turns.length ? pages.length : 0} page(s) · Id: ${m.id}`,
        await links(m, row),
      ];
      if (m.vaultNote) out.push(`Filed in vault: ${m.vaultNote}`);
      if (include.includes("notes")) out.push("", "## Your notes", m.notes?.trim() || "(none)");
      if (include.includes("minutes")) out.push("", `## Minutes${m.platform === "import" ? " (imported summary)" : ""}`, m.minutes || "(not written yet)");
      if (include.includes("chats")) out.push("", "## Ask AI", ...(m.chats || []).map((c) => `Q: ${c.question}\nA: ${c.answer || c.error}`));
      if (include.includes("transcript")) {
        out.push("", "## Transcript", turns.length ? pages[0].map((t) => turnLine(m, t)).join("\n\n") : "(empty)");
        if (pages.length > 1) out.push("", `(page 1 of ${pages.length}; get_transcript with page 2 continues)`);
      }
      return out.join("\n");
    },
  },
  {
    name: "get_transcript",
    description:
      "A meeting's transcript as numbered turns ('#n Speaker [mm:ss]: text'), one page of about 20,000 characters at a time; the same page number always returns the same turns. Optionally only a stretch of time (from_time/to_time as mm:ss or h:mm:ss) or one speaker.",
    inputSchema: {
      type: "object",
      properties: {
        meeting: MEETING,
        page: { type: "number", default: 1 },
        from_time: { type: "string", description: "Start of the stretch, e.g. 12:00" },
        to_time: { type: "string", description: "End of the stretch, e.g. 25:30" },
        speaker: { type: "string", description: "Only this person's turns" },
      },
      required: ["meeting"],
    },
    async run({ meeting: ref, page = 1, from_time, to_time, speaker }) {
      const { row, meeting: m } = await resolve(ref);
      const all = turnsOf(m);
      const start = offset(from_time);
      const end = offset(to_time);
      const turns = all.filter((t) => (start === null || secondsIn(m, t) >= start) && (end === null || secondsIn(m, t) <= end) && (!speaker || hasAll(t.speaker, wordsOf(speaker))));
      const filtered = turns.length !== all.length;
      if (!turns.length) return `# ${helper.titleOf(m)} (${when(m)})\n\n${all.length ? "No turns match." : "(empty)"}`;
      const pages = pagesOf(m, turns);
      if (page < 1 || page > pages.length) throw new Error(`There ${pages.length === 1 ? "is 1 page" : `are ${pages.length} pages`}.`);
      return [
        `# ${helper.titleOf(m)} (${when(m)})`,
        `Page ${page} of ${pages.length} · ${turns.length}${filtered ? ` of ${all.length}` : ""} turns${page < pages.length ? ` · more on page ${page + 1}` : ""}`,
        await links(m, row),
        "",
        pages[page - 1].map((t) => turnLine(m, t)).join("\n\n"),
      ].join("\n");
    },
  },
  {
    name: "get_action_items",
    description: "Action items (checkboxes) from your notes and the minutes across meetings, grouped by meeting; yours are marked. Open ones only unless include_done is true.",
    inputSchema: {
      type: "object",
      properties: { ...FILTERS, include_done: { type: "boolean", default: false } },
    },
    async run({ from, to, tag, source, include_done = false }) {
      const out = [];
      for (const r of await summaries({ from, to, tag, source })) {
        const m = load(r);
        if (!m) continue;
        const open = (l) => include_done || /\[ \]/.test(l);
        const mine = checkboxes(m.notes).filter(open);
        const items = [...mine.map((l) => `${l} _(your note)_`), ...actionItems(m.minutes).filter(open).filter((l) => !mine.includes(l))];
        if (items.length) out.push(`### ${when(m)} · ${helper.titleOf(m)}${(m.tags || []).length ? ` [${m.tags.join(", ")}]` : ""} · id: ${m.id}`, ...items, "");
      }
      return out.length ? out.join("\n") : "No action items found.";
    },
  },
  {
    name: "file_meeting_to_vault",
    description: "File a meeting into the Obsidian vault: its note in the department's Meeting Minutes folder and a line in that day's daily note. Filing again updates both in place. Set dry_run to only see where it would go.",
    inputSchema: {
      type: "object",
      properties: { meeting: MEETING, dry_run: { type: "boolean", default: false } },
      required: ["meeting"],
    },
    async run({ meeting: ref, dry_run = false }) {
      const { meeting: m } = await resolve(ref);
      if (dry_run) {
        const p = vault.preview(m, await helper.loadConfig());
        return p.note ? `Would file "${helper.titleOf(m)}" to ${p.note}` : p.reason;
      }
      const res = await helper.fileToVault({ meeting: m });
      if (!res.filed) return `Not filed: ${res.reason}`;
      // Remember where it went, so a later re-file updates the same note.
      await rememberFiling(m, res);
      return `Filed "${helper.titleOf(m)}" to ${res.note}${res.daily ? ` and linked it from ${res.daily}` : ""}.`;
    },
  },
  {
    name: "vault_filing_settings",
    description: "Show how Earshot files meetings into the vault: the vault, folder and file-name patterns, the tag-to-folder mapping and the daily-note line.",
    inputSchema: { type: "object", properties: {} },
    async run() {
      return JSON.stringify(vault.vaultSettings(await helper.loadConfig()), null, 2);
    },
  },
];

async function rememberFiling(m, res) {
  const entry = (await helper.loadIndex()).meetings[m.id];
  if (!entry) return;
  const file = path.join(entry.folder, "meeting.json");
  try {
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    record.vaultNote = res.note;
    record.filedAt = res.filedAt;
    record.lastFiling = { ...res, at: new Date().toISOString() }; // `planned` tells the next re-file whether its tags changed
    record.vaultDailyLines = res.dailyLines || [];
    // Temp file then rename: writing meeting.json in place could leave half a record after a crash.
    const tmp = `${file}.tmp-mcp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2));
    fs.renameSync(tmp, file);
  } catch (err) {
    console.error(`Earshot MCP: filed, but couldn't note it in ${file}: ${err.message}`);
  }
}

// ---------------------------------------------------------------- MCP over stdio

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

const MAX_RESULT_CHARS = 150000;
async function handle(msg) {
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } });
  const { id, method } = msg;
  const params = msg.params && typeof msg.params === "object" ? msg.params : {};
  if (id === undefined) return; // notifications need no answer
  try {
    if (method === "initialize") {
      return send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: params.protocolVersion || "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "earshot", version: VERSION },
          instructions:
            "Earshot holds the user's meetings: the ones it captured from Google Meet, Zoom and Teams, plus any history imported from another note-taker (source: import). Each has a speaker-tagged transcript, the user's own notes, AI minutes and saved Ask AI chats. Find meetings with list_meetings, list_series (recurring meetings) or search_meetings; search hits are numbered turns (#n) that expand_excerpt widens. get_meeting gives details, links, notes and minutes; get_transcript pages through a transcript (one page at a time, or a stretch of time or one speaker). The user's notes are what they chose to write down: treat them as more important than the AI minutes. get_action_items collects checkboxes across meetings, and file_meeting_to_vault files a meeting into the Obsidian vault.",
        },
      });
    }
    if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });
    if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: TOOLS.map(({ run, ...t }) => t) } });
    if (method === "tools/call") {
      const tool = TOOLS.find((t) => t.name === params.name);
      if (!tool) return send({ jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool ${params.name}` } });
      try {
        const args = params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments) ? params.arguments : {};
        let text = String(await tool.run(args));
        if (text.length > MAX_RESULT_CHARS) text = `${text.slice(0, MAX_RESULT_CHARS)}\n\n(cut off at ${MAX_RESULT_CHARS} of ${text.length} characters; narrow it with a date range, tag, limit or page)`;
        return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });
      } catch (err) {
        return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: String(err.message || err) }], isError: true } });
      }
    }
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
  } catch (err) {
    send({ jsonrpc: "2.0", id, error: { code: -32603, message: String(err.message || err) } });
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    try {
      handle(JSON.parse(line)).catch((err) => console.error(`Earshot MCP: ${err.message}`));
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    }
  }
});
process.stdin.on("end", () => process.exit(0));
