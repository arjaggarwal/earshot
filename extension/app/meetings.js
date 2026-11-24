// Earshot meetings page: the history of every meeting, grouped by day and
// filterable by tag, with minutes, the editable transcript, notes, Ask AI
// (saved per meeting) and settings. Meetings live in Chrome and, with the
// helper installed, as files in ~/Earshot; meetings found only on disk (say,
// after reinstalling the extension) are listed too and brought back on open.

// A message that fails (the worker restarting, the extension reloaded) answers
// null instead of throwing, so each caller's "nothing came back" path covers it.
const send = async (msg) => {
  try {
    return await chrome.runtime.sendMessage(msg);
  } catch (e) {
    console.warn("Earshot: message failed", msg?.kind, e?.message || e);
    return null;
  }
};
const QUICK_PROMPTS = ["Summarize this meeting", "List the action items with owners", "What decisions were made?", "What should I follow up on?"];

let rows = []; // meeting summaries
let current = null; // full meeting with screenshot images
let tab = "minutes";
let filter = "";
let searchIds = null; // ids the helper found for the search box, across every saved meeting
const tagFilter = new Set();
const stored = (key, fallback) => {
  try {
    return JSON.parse(localStorage.getItem(`earshot:${key}`)) ?? fallback;
  } catch {
    return fallback;
  }
};
const store = (key, value) => {
  try {
    localStorage.setItem(`earshot:${key}`, JSON.stringify(value));
  } catch {}
};
let view = stored("view", "day"); // "day" or "company"
const groupState = stored("groups", {}); // company -> true (open) / false (closed), once clicked
const PAGE = 150; // meetings shown by day before "Show older"
let dayLimit = PAGE;
let settings = {};
let helperInfo = null;
let editing = false;
let asking = null; // { id, question } while an answer is being written
let rowsError = false; // the meeting list could not be read
let dupes = {}; // meeting id -> the fuller copy it duplicates { id, title, platform, segmentCount }
let loadFailed = null; // id of a meeting that would not open
let rowsSeq = 0; // these three drop answers that come back out of order
let listSeq = 0;
let openSeq = 0;
const contentCache = new Map(); // meeting id -> lowercased text for search

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

function toast(text) {
  const t = document.querySelector(".toast");
  t.textContent = text;
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), 2400);
}

function download(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// Notes editing: Enter continues a list, an empty bullet ends it, Tab indents, "[] " starts an action item.
function bulletKeys(box, onChange) {
  box.addEventListener("keydown", (e) => {
    const v = box.value;
    const start = v.lastIndexOf("\n", box.selectionStart - 1) + 1;
    const endAt = v.indexOf("\n", box.selectionStart);
    const end = endAt === -1 ? v.length : endAt;
    const line = v.slice(start, end);
    const bullet = /^(\s*)(- \[ \] |- \[x\] |[-*•] |\d+\. )/.exec(line);
    const put = (from, to, text) => {
      box.setRangeText(text, from, to, "end");
      onChange();
    };
    if (e.key === "Enter" && !e.shiftKey && bullet) {
      e.preventDefault();
      if (line.trim() === bullet[2].trim()) return put(start, end, "");
      let marker = bullet[2] === "- [x] " ? "- [ ] " : bullet[2];
      const n = /^(\d+)\. $/.exec(marker);
      if (n) marker = `${Number(n[1]) + 1}. `;
      put(box.selectionStart, box.selectionEnd, `\n${bullet[1]}${marker}`);
    } else if (e.key === "Tab") {
      e.preventDefault();
      if (e.shiftKey) put(start, end, line.replace(/^ {1,2}/, ""));
      else put(start, start, "  ");
    } else if (e.key === " " && line === "[]" && box.selectionStart === end) {
      e.preventDefault();
      put(start, end, "- [ ] ");
    }
  });
}

// ---------------------------------------------------------------- list

async function loadRows() {
  const seq = ++rowsSeq;
  const listed = await send({ kind: "list-meetings" });
  const next = Array.isArray(listed) ? listed.filter(Boolean) : [];
  if (helperInfo) {
    // Meetings that exist only as files (e.g. after reinstalling the extension).
    const files = await send({ kind: "helper", op: "list-meetings" });
    const have = new Set(next.map((r) => r.id));
    if (Array.isArray(files)) for (const f of files) if (f && !have.has(f.id)) next.push({ ...f, fileOnly: true });
  }
  if (seq !== rowsSeq) return; // a newer load is on its way
  next.sort((a, b) => String(b.startedAt || "").localeCompare(String(a.startedAt || "")));
  rows = next;
  rowsError = listed == null;
  if (helperInfo) {
    // Two captures of one call (browser captions and the Mac app): the shorter is marked.
    const found = await send({ kind: "helper", op: "find-duplicates", payload: { rows: next.filter((r) => !r.fileOnly) } });
    if (seq !== rowsSeq) return;
    dupes = found && typeof found === "object" && !found.error ? found : {};
  }
  // The open meeting was deleted somewhere else (the panel, another tab).
  if (current && !rowsError && !rows.some((r) => r.id === current.id)) {
    current = null;
    history.replaceState(null, "", location.pathname);
    renderDetail();
  }
  renderTagFilter();
  renderList();
}

async function matches(row) {
  if (tagFilter.size && !(row.tags || []).some((t) => tagFilter.has(t))) return false;
  if (!filter) return true;
  if (`${Earshot.titleOf(row)} ${(row.speakers || []).join(" ")} ${(row.tags || []).join(" ")}`.toLowerCase().includes(filter)) return true;
  if (searchIds) return searchIds.has(row.id);
  if (row.fileOnly) return false;
  if (!contentCache.has(row.id)) {
    const m = await send({ kind: "get-meeting", id: row.id });
    if (!m) return false; // not cached, so the next search reads it again
    contentCache.set(row.id, `${m?.notes || ""} ${m?.minutes || ""} ${(m?.segments || []).map((s) => s.text).join(" ")}`.toLowerCase());
  }
  return contentCache.get(row.id).includes(filter);
}

function dayLabel(iso) {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}

// The tags in use: companies and teams first, then vendors on their own line.
function renderTagFilter() {
  const box = document.getElementById("tagFilter");
  const used = new Set(rows.flatMap((r) => r.tags || []));
  const vendors = new Set(settings.vendors || []);
  const known = (settings.tags || []).filter((t) => used.has(t) && !vendors.has(t));
  const others = [...used].filter((t) => !(settings.tags || []).includes(t) && !vendors.has(t));
  const chip = (t) => {
    const b = el("button", `chip${tagFilter.has(t) ? "" : " off"}`, t);
    b.addEventListener("click", () => {
      tagFilter.has(t) ? tagFilter.delete(t) : tagFilter.add(t);
      renderTagFilter();
      renderList();
    });
    return b;
  };
  const line = (label, tags) => {
    const row = el("div", "tagline");
    if (label) row.append(el("span", "taglabel", label));
    row.append(...tags.map(chip));
    return row;
  };
  const parts = [line(null, [...known, ...others])];
  const usedVendors = (settings.vendors || []).filter((v) => used.has(v));
  if (usedVendors.length) parts.push(line("Vendors", usedVendors));
  box.replaceChildren(...parts);
}

// The company a meeting belongs to: its first tag, the same one vault filing uses.
const companyOf = (row) => (row.tags || [])[0] || "No company";

function itemFor(row, { showDate = false } = {}) {
  const item = el("div", `item${current?.id === row.id ? " on" : ""}`);
  const start = new Date(row.startedAt);
  const when = showDate ? start.toLocaleDateString([], { month: "short", day: "numeric" }) : start.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const sub = el("div", "s");
  for (const bit of [when, row.endedAt ? null : "live", row.platform === "import" ? "Imported" : null, dupes[row.id] ? "Partial copy" : null]) if (bit) sub.append(el("span", bit === "live" ? "live" : bit === "Partial copy" ? "dupe" : null, bit));
  // Just the meeting's main tag here; all of them show on the meeting.
  if (!showDate && (row.tags || []).length) sub.append(el("span", "tags", row.tags[0]));
  item.append(el("div", "t", Earshot.titleOf(row)), sub);
  item.tabIndex = 0;
  item.setAttribute("role", "button");
  item.addEventListener("click", () => {
    openMeeting(row.id);
  });
  item.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    openMeeting(row.id);
  });
  return item;
}

// A plain message with a way to try again.
function retryBox(text, retry) {
  const box = el("div", "empty");
  const again = el("button", "quiet", "Try again");
  again.addEventListener("click", () => {
    again.disabled = true;
    retry();
  });
  box.append(el("div", null, text), again);
  return box;
}

async function renderList() {
  const list = document.getElementById("list");
  const seq = ++listSeq;
  for (const b of document.querySelectorAll(".viewswitch button")) {
    b.classList.toggle("on", b.dataset.view === view);
    b.setAttribute("aria-selected", String(b.dataset.view === view));
  }
  const shown = [];
  for (const row of rows) if (await matches(row)) shown.push(row);
  if (seq !== listSeq) return; // a newer search or filter has taken over
  const narrowed = !!(filter || tagFilter.size);
  const out = [];
  if (view === "company") {
    const groups = new Map();
    for (const row of shown) {
      const name = companyOf(row);
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push(row);
    }
    const order = [...groups.keys()].sort((a, b) => (a === "No company") - (b === "No company") || groups.get(b)[0].startedAt.localeCompare(groups.get(a)[0].startedAt));
    for (const name of order) {
      const items = groups.get(name);
      const open = groupState[name] ?? narrowed;
      const head = el("button", `group${open ? " open" : ""}`);
      head.append(el("span", "name", name), el("span", "count", String(items.length)), el("span", "last", dayLabel(items[0].startedAt)));
      head.addEventListener("click", () => {
        groupState[name] = !open;
        store("groups", groupState);
        renderList();
      });
      out.push(head);
      if (open) for (const row of items) out.push(itemFor(row, { showDate: true }));
    }
  } else {
    let lastDay = null;
    for (const row of narrowed ? shown : shown.slice(0, dayLimit)) {
      const day = dayLabel(row.startedAt);
      if (day !== lastDay) out.push(el("div", "day", day)), (lastDay = day);
      out.push(itemFor(row));
    }
    if (!narrowed && shown.length > dayLimit) {
      const more = el("button", "more", `Show older meetings (${shown.length - dayLimit} more)`);
      more.addEventListener("click", () => {
        dayLimit += PAGE * 2;
        renderList();
      });
      out.push(more);
    }
  }
  if (!shown.length) {
    if (rowsError) out.push(retryBox("Couldn't load your meetings.", loadRows));
    else out.push(el("div", "empty", narrowed ? "No meetings match." : "No meetings captured yet."));
  }
  const hadFocus = list.contains(document.activeElement) && document.activeElement.classList.contains("item");
  list.replaceChildren(...out);
  if (hadFocus) list.querySelector(".item.on")?.focus();
}

// ---------------------------------------------------------------- detail

// The Mac app writes its meetings on disk, so each open takes the disk copy
// in when it's newer (the import keeps Chrome's copy otherwise).
const DISK_EDITED = new Set(["teams-desktop", "zoom-desktop", "mac"]);

async function openMeeting(id) {
  const seq = ++openSeq;
  const row = rows.find((r) => r.id === id);
  if (row && (row.fileOnly || DISK_EDITED.has(row.platform))) {
    const fromDisk = await send({ kind: "helper", op: "get-meeting", payload: { id } });
    if (fromDisk && !fromDisk.error) {
      await send({ kind: "import-meeting", meeting: fromDisk });
      row.fileOnly = false;
    }
    contentCache.delete(id);
  }
  const m = await send({ kind: "get-meeting", id, withImages: true });
  if (seq !== openSeq) return; // another meeting was clicked meanwhile
  current = m || null;
  loadFailed = m ? null : id;
  history.replaceState(null, "", `#${encodeURIComponent(id)}`);
  renderList();
  renderDetail();
}

// Read a meeting again after something changed it. It is only shown if it is
// still the one open; a failed read keeps what is on screen.
async function reloadCurrent(id) {
  const m = await send({ kind: "get-meeting", id, withImages: true });
  if (current?.id !== id) return;
  if (m) current = m;
  renderDetail();
}

const act = async (action, extra = {}, id = current?.id) => {
  if (!id) return null;
  const res = await send({ kind: "meeting-action", meetingId: id, action, ...extra });
  contentCache.delete(id);
  return res;
};

// Text is selected (a drag, a double or triple click): a click that ends it is for copying, not editing.
const selecting = (e) => e.detail > 1 || (!getSelection().isCollapsed && !!String(getSelection()).trim());

// Where in a line's text a click left the cursor (null: not in its text).
function clickOffset(node) {
  const sel = getSelection();
  return sel.isCollapsed && sel.anchorNode === node.firstChild && sel.anchorNode?.nodeType === 3 ? sel.anchorOffset : null;
}

// `caret` puts the cursor at that character instead of selecting the whole text.
function editInPlace(node, onSave, initial, caret = null) {
  if (editing) return;
  editing = true;
  const before = initial ?? node.textContent;
  node.textContent = before;
  node.contentEditable = "true";
  node.focus();
  if (Number.isInteger(caret) && node.firstChild) getSelection().collapse(node.firstChild, Math.min(caret, node.firstChild.length));
  else getSelection().selectAllChildren(node);
  const finish = async (save) => {
    node.removeEventListener("keydown", onKey);
    node.removeEventListener("blur", onBlur);
    node.contentEditable = "false";
    editing = false;
    const after = node.textContent.trim();
    if (save && after && after !== before.trim()) await onSave(after);
    else renderDetail();
  };
  const onKey = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      node.blur();
    } else if (e.key === "Escape") {
      e.preventDefault();
      finish(false);
    }
  };
  const onBlur = () => finish(true);
  node.addEventListener("keydown", onKey);
  node.addEventListener("blur", onBlur);
}

function tagEditor(m) {
  const wrap = el("span");
  const render = () => {
    wrap.replaceChildren(...(m.tags || []).map((t) => el("span", "chip", t)));
    const edit = el("button", "chip add", m.tags?.length ? "Edit tags" : "+ Tag");
    edit.addEventListener("click", openMenu);
    wrap.append(edit);
  };
  const openMenu = () => {
    const box = el("div", "tagpick");
    const chosen = new Set(m.tags || []);
    for (const t of [...new Set([...(settings.tags || []), ...chosen])]) {
      const b = el("button", `chip${chosen.has(t) ? "" : " off"}`, t);
      b.addEventListener("click", async () => {
        chosen.has(t) ? chosen.delete(t) : chosen.add(t);
        b.classList.toggle("off");
        m.tags = [...chosen];
        await act("set-tags", { tags: m.tags });
      });
      box.append(b);
    }
    const input = el("input");
    input.placeholder = "New tag, then Enter";
    input.addEventListener("keydown", async (e) => {
      if (e.key !== "Enter" || !input.value.trim()) return;
      chosen.add(input.value.trim());
      m.tags = [...chosen];
      settings.tags = [...new Set([...(settings.tags || []), input.value.trim()])];
      await act("set-tags", { tags: m.tags, addToList: true });
    });
    const done = el("button", "ghost", "Done");
    done.addEventListener("click", render);
    box.append(input, done);
    wrap.replaceChildren(box);
  };
  render();
  return wrap;
}

function renderDetail() {
  const main = document.getElementById("detail");
  if (location.hash === "#settings") return renderSettings();
  if (!current) {
    if (loadFailed) {
      const id = loadFailed;
      main.replaceChildren(retryBox("This meeting couldn't be opened.", () => openMeeting(id)));
    } else main.replaceChildren(el("div", "empty", rows.length ? "Pick a meeting on the left." : "No meetings captured yet."));
    return;
  }
  const m = current;
  const title = el("h1", null, Earshot.titleOf(m));
  title.title = "Click to rename";
  title.addEventListener("click", () =>
    editInPlace(title, async (t) => {
      await act("rename", { title: t });
      toast("Meeting renamed");
    })
  );
  const mins = m.endedAt ? `${Math.max(1, Math.round((Date.parse(m.endedAt) - Date.parse(m.startedAt)) / 60000))} min` : "in progress";
  const sub = el("div", "sub");
  sub.append(
    el("span", null, new Date(m.startedAt).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })),
    el("span", null, mins),
    speakersButton(m),
    el("span", null, Earshot.platformLabel(m.platform)),
    tagEditor(m)
  );

  const bar = el("div", "bar actions");
  const button = (label, fn, cls = "quiet") => {
    const b = el("button", cls, label);
    b.addEventListener("click", fn);
    bar.append(b);
    return b;
  };
  if (helperInfo) {
    const fileBtn = button(m.vaultNote ? "Re-file to vault" : "File to vault", async () => {
      fileBtn.disabled = true;
      fileBtn.textContent = "Filing…";
      const res = await send({ kind: "file-to-vault", meetingId: m.id });
      toast(res?.filed ? `Filed to ${res.note}` : res?.reason || res?.error || "Couldn't file it");
      await reloadCurrent(m.id);
    });
  }
  if (m.vaultNote && m.vaultName && !m.vaultMissing) {
    button("Open in Obsidian", () => {
      location.href = `obsidian://open?vault=${encodeURIComponent(m.vaultName)}&file=${encodeURIComponent(m.vaultNote)}`;
    });
  }
  // Exports and the folder sit in one menu, so the bar stays short.
  const exports = el("div", "menuwrap");
  const exportBtn = el("button", "quiet", "Export");
  const menu = el("div", "menu");
  const item = (label, fn) => {
    const b = el("button", null, label);
    b.addEventListener("click", () => {
      exports.classList.remove("open");
      fn();
    });
    menu.append(b);
  };
  item("Markdown (.md)", () => download(Earshot.fileName(m, "md"), Earshot.toMarkdown(m), "text/markdown"));
  item("Web page with screenshots (.html)", () => download(Earshot.fileName(m, "html"), Earshot.toHtml(m), "text/html"));
  item("Data (.json)", () => download(Earshot.fileName(m, "json"), JSON.stringify(m, null, 2), "application/json"));
  if (helperInfo) item("Show in Finder", () => send({ kind: "helper", op: "open-folder", payload: { id: m.id } }));
  exportBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    exports.classList.toggle("open");
  });
  exports.append(exportBtn, menu);
  bar.append(exports);
  button("Delete", () => deleteMeeting(m), "danger");

  const filing = el("div", "sub filing");
  if (m.vaultNote && !m.vaultMissing) filing.textContent = `Filed to ${m.vaultNote} on ${shortWhen(m.filedAt)}`;
  else if (!m.vaultNote && m.lastFiling && !m.lastFiling.filed) filing.textContent = `Not in your vault yet: ${m.lastFiling.reason}`;
  const tabs = el("div", "tabs");
  for (const [id, label] of [["minutes", "Minutes"], ["transcript", "Transcript"], ["notes", "Notes"], ["ask", "Ask AI"]]) {
    const b = el("button", tab === id ? "on" : "", label);
    b.dataset.tab = id;
    b.addEventListener("click", () => {
      tab = id;
      renderDetail();
    });
    tabs.append(b);
  }

  const body = { minutes: minutesView, transcript: transcriptView, notes: notesView, ask: askView }[tab](m);
  const head = el("div", "head");
  const headText = el("div", "headtext");
  headText.append(title, sub, filing);
  head.append(headText, bar);
  const notices = vaultNotices(m);
  const grid = el("div", "grid");
  const content = el("div", "content");
  content.append(body);
  grid.append(content, sideColumn(m));
  main.replaceChildren(head, ...notices, tabs, grid);
}

const shortWhen = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "an earlier date" : d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
};

async function deleteMeeting(m, prompt = `Delete "${Earshot.titleOf(m)}"? Its files move to ~/Earshot/.trash.`) {
  if (!confirm(prompt)) return;
  await send({ kind: "delete-meeting", id: m.id });
  contentCache.delete(m.id);
  if (current?.id === m.id) {
    current = null;
    history.replaceState(null, "", location.pathname);
  }
  await loadRows();
  renderDetail();
}

// What the vault sync and the duplicate check found on this meeting, each with what to do about it.
function vaultNotices(m) {
  const out = [];
  const notice = (text, actions) => {
    const box = el("div", "notice");
    box.append(el("div", "text", text));
    const row = el("div", "noticeacts");
    for (const [label, fn, cls] of actions) {
      const b = el("button", cls || "quiet", label);
      b.addEventListener("click", async () => {
        b.disabled = true;
        await fn();
        b.disabled = false;
      });
      row.append(b);
    }
    if (actions.length) box.append(row);
    out.push(box);
  };
  const dup = dupes[m.id];
  if (dup) {
    const full = rows.find((r) => r.id === dup.id);
    const what = `${Earshot.platformLabel(dup.platform)}, ${dup.segmentCount} ${dup.segmentCount === 1 ? "line" : "lines"}`;
    notice(`This looks like a partial copy of "${dup.title || Earshot.titleOf(full || dup)}" (${what}), saved at the same time. It isn't filed to the vault automatically.`, [
      ["Open the full copy", () => openMeeting(dup.id)],
      ["Delete this copy", () => deleteMeeting(m, `Delete this partial copy ("${Earshot.titleOf(m)}", ${(m.segments || []).length} lines)? The full copy stays. Its files move to ~/Earshot/.trash.`), "danger"],
    ]);
  }
  if (m.vaultNote && m.vaultMissing) {
    const gone = m.vaultMissing.trashed ? `was deleted in Obsidian${m.vaultMissing.at ? ` on ${shortWhen(m.vaultMissing.at)}` : ""}` : "isn't in the vault any more";
    const acts = [];
    if (helperInfo) acts.push(["File it again", () => fileAgain(m)]);
    acts.push(["Delete this meeting", () => deleteMeeting(m), "danger"]);
    notice(`Its vault note (${m.vaultNote}) ${gone}.`, acts);
  }
  if (m.vaultTitle?.title && !m.vaultMissing) {
    notice(`In the vault this meeting is titled "${m.vaultTitle.title}".`, [
      [
        "Use that title",
        async () => {
          await act("vault-sync", { patch: { title: m.vaultTitle.title, planned: m.vaultTitle.planned, vaultTitle: null } });
          toast("Meeting renamed");
        },
      ],
    ]);
  }
  return out;
}

async function fileAgain(m) {
  const res = await send({ kind: "file-to-vault", meetingId: m.id });
  toast(res?.filed ? `Filed to ${res.note}` : res?.reason || res?.error || "Couldn't file it");
  await reloadCurrent(m.id);
}

// "4 speakers" opens a short list of who spoke and how much.
function speakersButton(m) {
  const talk = Earshot.talkTime(m);
  const wrap = el("span", "menuwrap");
  const b = el("button", "linkish", `${talk.length} ${talk.length === 1 ? "speaker" : "speakers"}`);
  b.title = "Who spoke";
  const menu = el("div", "menu speakers");
  const colorFor = Earshot.speakerPalette(m);
  for (const r of talk) {
    const row = el("div", "spk");
    const name = el("span", null, r.speaker);
    name.style.color = colorFor(r.speakerId);
    row.append(name, el("span", "share", `${Math.round(r.share * 100)}%`));
    menu.append(row);
  }
  const quiet = [...new Set(Object.values(m.participants || {}))].filter((n) => n && !talk.some((r) => r.speaker === n));
  if (quiet.length) menu.append(el("div", "also", `Also there: ${quiet.join(", ")}`));
  if (!talk.length && !quiet.length) menu.append(el("div", "also", "No one has spoken yet."));
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    wrap.classList.toggle("open");
  });
  wrap.append(b, menu);
  return wrap;
}

// Meetings that share the distinctive words of this one's title. Words are
// weighted by how rare they are across all titles, so "sync", "weekly",
// "AI" or your own name don't tie everything together.
const TITLE_NOISE = new Set("meeting meetings sync weekly biweekly bi call catch catchup up check checkin in connect with and the of for to on re update updates zoom transcription session".split(" "));
const titleWords = (t) =>
  new Set(
    String(t || "")
      .toLowerCase()
      .replace(/\b(19|20)\d\d[-/.]\d\d?[-/.]\d\d?\b/g, " ")
      .replace(/[^a-z0-9]+/g, " ")
      .split(" ")
      .filter((w) => w.length > 1 && !TITLE_NOISE.has(w) && !/^\d+$/.test(w))
  );
const GENERIC_TITLE = /^(meeting transcription|.*'s zoom meeting|.*personal meeting room|zoom meeting|google meet|teams meeting)$/i;
let idfCache = { rows: null, idf: null };
function relatedMeetings(m, limit = 8) {
  const title = Earshot.titleOf(m).trim();
  if (GENERIC_TITLE.test(title)) return [];
  if (idfCache.rows !== rows) {
    const df = new Map();
    for (const r of rows) for (const w of titleWords(Earshot.titleOf(r))) df.set(w, (df.get(w) || 0) + 1);
    idfCache = { rows, idf: (w) => Math.log((rows.length + 1) / ((df.get(w) || 0) + 1)) };
  }
  const { idf } = idfCache;
  const mine = titleWords(title);
  if (!mine.size) return [];
  const scored = [];
  for (const r of rows) {
    const theirTitle = Earshot.titleOf(r).trim();
    if (r.id === m.id || GENERIC_TITLE.test(theirTitle)) continue;
    const theirs = titleWords(theirTitle);
    let shared = 0;
    let all = 0;
    for (const w of new Set([...mine, ...theirs])) {
      all += idf(w);
      if (mine.has(w) && theirs.has(w)) shared += idf(w);
    }
    const score = theirTitle.toLowerCase() === title.toLowerCase() ? 2 : all ? shared / all : 0;
    if (score >= 0.5) scored.push({ r, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || b.r.startedAt.localeCompare(a.r.startedAt))
    .slice(0, limit)
    .map((x) => x.r);
}

// The column beside every tab: talk time on the transcript, your notes, related meetings.
function sideColumn(m) {
  const side = el("aside", "side");
  if (tab === "transcript" && m.segments.length) {
    const colorFor = Earshot.speakerPalette(m);
    const talk = el("section");
    talk.append(el("h2", null, "Talk time"));
    for (const r of Earshot.talkTime(m)) {
      const stat = el("div", "stat");
      const row = el("div", "row");
      const n = el("span", null, r.speaker);
      n.style.color = colorFor(r.speakerId);
      row.append(n, el("span", null, `${Math.round(r.share * 100)}%`));
      const meter = el("div", "meter");
      const fill = el("span");
      fill.style.width = `${Math.round(r.share * 100)}%`;
      fill.style.background = colorFor(r.speakerId);
      meter.append(fill);
      stat.append(row, meter);
      talk.append(stat);
    }
    side.append(talk);
  }
  if (tab !== "notes" && m.notes && m.notes.trim()) {
    const box = el("section", "mynotes");
    const h = el("button", "sidehead", "My notes");
    h.title = "Open your notes";
    h.addEventListener("click", () => {
      tab = "notes";
      renderDetail();
    });
    const text = el("div", "md");
    text.innerHTML = Earshot.markdownToHtml(m.notes);
    box.append(h, text);
    side.append(box);
  }
  const related = relatedMeetings(m);
  if (related.length) {
    const box = el("section", "related");
    box.append(el("h2", null, "Related meetings"));
    const thisYear = new Date().getFullYear();
    for (const r of related) {
      const d = new Date(r.startedAt);
      const a = el("button", "rel");
      a.append(el("span", "t", Earshot.titleOf(r)), el("span", "d", d.toLocaleDateString([], { month: "short", day: "numeric", year: d.getFullYear() === thisYear ? undefined : "numeric" })));
      a.addEventListener("click", () => openMeeting(r.id));
      box.append(a);
    }
    side.append(box);
  }
  return side;
}


function minutesView(m) {
  const wrap = el("div");
  const bar = el("div", "bar");
  const generate = el("button", m.minutes ? "quiet" : "primary", m.minutes ? "Regenerate minutes" : "Generate minutes");
  generate.addEventListener("click", async () => {
    if (!helperInfo) return toast("Install the Earshot helper to generate minutes.");
    generate.disabled = true;
    generate.textContent = "Writing minutes…";
    const res = await send({ kind: "generate-minutes", meetingId: m.id });
    if (!res) toast("Couldn't reach Earshot to write the minutes. Try again.");
    else if (res.error) toast(res.error);
    await reloadCurrent(m.id); // only if this meeting is still the one open
  });
  bar.append(generate);
  if (m.minutes) {
    const edit = el("button", "quiet", "Edit");
    edit.addEventListener("click", () => {
      const area = el("textarea");
      area.value = m.minutes;
      area.style.minHeight = "420px";
      const save = el("button", "primary", "Save");
      save.addEventListener("click", async () => {
        await act("set-minutes", { text: area.value }, m.id);
        m.minutes = area.value;
        if (current?.id === m.id) {
          current.minutes = area.value;
          renderDetail();
        }
      });
      wrap.replaceChildren(area, save);
    });
    const copy = el("button", "quiet", "Copy");
    copy.title = "Copy the minutes, formatted for Word and Teams";
    copy.addEventListener("click", async () => {
      await Earshot.copyFormatted(m.minutes);
      toast("Minutes copied");
    });
    bar.append(edit, copy);
    if (m.notes && m.notes.trim()) {
      const both = el("button", "quiet", "Copy with my notes");
      both.title = "Your notes first, then the minutes, formatted for Word and Teams";
      both.addEventListener("click", async () => {
        await Earshot.copyFormatted(`## My notes\n\n${m.notes.trim()}\n\n## Minutes\n\n${m.minutes.trim()}`);
        toast("Notes and minutes copied");
      });
      bar.append(both);
    }
  }
  const box = el("div", "minutes md");
  if (m.minutes) box.innerHTML = Earshot.markdownToHtml(m.minutes);
  else box.textContent = m.endedAt
    ? "No minutes yet. Generate them from the transcript and your notes, using your minutes template (Settings)."
    : "Minutes are written automatically when the meeting ends.";
  wrap.append(bar, box);
  return wrap;
}

function transcriptView(m) {
  const colorFor = Earshot.speakerPalette(m);
  const col = el("section");
  let last = null;
  let turn = null; // the paragraph a speaker's lines flow into
  for (const item of Earshot.timeline(m)) {
    if (item.kind === "screenshot") {
      const shot = el("div", "shot");
      const img = el("img");
      img.src = item.shot.dataUrl || "";
      img.addEventListener("click", () => {
        document.querySelector(".lightbox img").src = img.src;
        document.querySelector(".lightbox").classList.add("open");
      });
      const cap = el("div", "cap");
      const remove = el("button", "ghost", "Remove");
      remove.addEventListener("click", () => act("delete-screenshot", { shotId: item.shot.id }));
      cap.append(el("span", null, `${item.shot.source === "meeting-view" ? "Meeting screen" : "Presentation"} at ${Earshot.elapsed(m.startedAt, item.at)}, ${item.shot.width}×${item.shot.height}`), remove);
      shot.append(img, cap);
      col.append(shot);
      last = null;
      turn = null;
      continue;
    }
    const s = item.segment;
    if (s.speakerId !== last) {
      const who = el("div", "who");
      who.style.color = colorFor(s.speakerId);
      const name = el("span", "name", s.speaker);
      name.title = "Click to rename this speaker everywhere";
      name.addEventListener("click", (e) =>
        !selecting(e) &&
        editInPlace(name, async (n) => {
          await act("rename-speaker", { speakerId: s.speakerId, name: n });
          toast(`Renamed to ${n}`);
        })
      );
      who.append(name, el("span", "when", Earshot.elapsed(m.startedAt, s.startedAt)));
      col.append(who);
      turn = null;
    }
    last = s.speakerId;
    if (!turn) col.append((turn = el("div", "turn")));
    else turn.append(" ");
    const block = el("span", `block${s.edited ? " edited" : ""}`);
    block.title = "Click to fix this text";
    const tag = Earshot.tagOf(s.reaction);
    block.textContent = s.text;
    if (tag) block.append(el("span", "badge", `#${tag.tag}`));
    const reacts = el("span", "reacts");
    const opener = el("button", "tagopen", "#");
    opener.title = "Tag this line for your notes and the vault agent";
    // The tag buttons are only built when the picker opens: on a long meeting
    // that is thousands of buttons the page never has to make.
    let built = false;
    opener.addEventListener("click", (e) => {
      e.stopPropagation();
      for (const other of document.querySelectorAll(".reacts.open")) other.classList.remove("open");
      if (!built) {
        built = true;
        for (const x of Earshot.TAGS) {
          const b = el("button", tag?.id === x.id ? "on" : "", x.label);
          b.dataset.reaction = x.id;
          b.title = `Add to your notes with #${x.tag}`;
          b.addEventListener("click", (e) => {
            e.stopPropagation();
            reacts.classList.remove("open");
            act("react", { segmentId: s.id, reaction: x.id }, m.id);
          });
          reacts.append(b);
        }
      }
      reacts.classList.add("open");
    });
    reacts.append(opener);
    block.append(reacts);
    block.addEventListener("click", (e) => {
      if (e.target.closest(".reacts") || selecting(e)) return;
      editInPlace(block, (t) => act("edit-segment", { segmentId: s.id, text: t }), s.text, clickOffset(block));
    });
    turn.append(block);
  }
  if (!m.segments.length && !m.screenshots.length) col.append(el("div", "empty", "Nothing was captured in this meeting."));

  return col;
}

function notesView(m) {
  const wrap = el("div");
  const area = el("textarea");
  area.style.minHeight = "420px";
  area.placeholder = "Notes for this meeting. Type - for a bullet; Tab indents. Tag a line #todo, #followup, #ROI, #opportunity or #insight and the vault agent picks it up when the meeting is filed.";
  area.value = m.notes || "";
  const saved = el("div", "saved");
  let timer = null;
  const save = () => {
    saved.textContent = "Saving…";
    clearTimeout(timer);
    m.notes = area.value;
    timer = setTimeout(async () => {
      // Saved to the meeting these notes were typed on, even if another is open by now.
      const text = area.value;
      const res = await act("notes", { text }, m.id);
      if (current?.id === m.id) current.notes = text;
      saved.textContent = res === null ? "Couldn't save. Keep typing to try again." : "Saved";
    }, 600);
  };
  area.addEventListener("input", save);
  bulletKeys(area, save);
  const tools = el("div", "notetools");
  for (const t of Earshot.TAGS) {
    const b = el("button", null, `#${t.tag}`);
    b.title = `Tag this line #${t.tag}; the vault agent picks it up when the meeting is filed`;
    b.addEventListener("click", () => {
      const v = area.value;
      const start = v.lastIndexOf("\n", area.selectionStart - 1) + 1;
      const endAt = v.indexOf("\n", area.selectionStart);
      const end = endAt === -1 ? v.length : endAt;
      const next = Earshot.toggleLineTag(v.slice(start, end), t.tag);
      area.focus();
      area.setRangeText(next.text, start, end, "end");
      area.setSelectionRange(start + next.caret, start + next.caret);
      save();
    });
    tools.append(b);
  }
  wrap.append(tools, area, saved);
  return wrap;
}

function askView(m) {
  const wrap = el("div", "chat");
  if (!helperInfo) wrap.append(el("div", "a err", "Ask AI needs the Earshot helper. Run helper/install.sh on this Mac, then reload Earshot."));
  for (const c of m.chats || []) {
    const a = el("div", `a${c.error ? " err" : " md"}`);
    if (c.error) a.textContent = c.error;
    else a.innerHTML = Earshot.markdownToHtml(c.answer || "");
    const meta = el("small", null, `${new Date(c.at).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}${c.model ? ` · ${c.model}` : ""}`);
    if (c.answer) {
      const copy = el("button", "copyans", "Copy");
      copy.title = "Copy, formatted for Word and Teams";
      copy.addEventListener("click", async () => {
        await Earshot.copyFormatted(c.answer);
        toast("Answer copied");
      });
      meta.append(copy);
    }
    a.append(meta);
    wrap.append(el("div", "q", c.question), a);
  }
  if (asking?.id === m.id) wrap.append(el("div", "q", asking.question), el("div", "a", "Thinking…"));
  const prompts = el("div", "prompts");
  for (const p of QUICK_PROMPTS) {
    const b = el("button", null, p);
    b.addEventListener("click", () => ask(p));
    prompts.append(b);
  }
  const bar = el("div", "askbar");
  const input = el("textarea");
  input.rows = 1;
  input.placeholder = "Ask anything about this meeting…";
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      ask(input.value);
    }
  });
  const go = el("button", "primary", "Ask");
  go.addEventListener("click", () => ask(input.value));
  bar.append(input, go);
  wrap.append(prompts, bar);
  return wrap;
}

async function ask(question) {
  question = String(question || "").trim();
  if (!question || !current) return;
  if (asking) return toast("Still answering your last question.");
  const id = current.id;
  asking = { id, question };
  renderDetail();
  const res = await send({ kind: "ask", meetingId: id, question });
  asking = null;
  if (!res) toast("Couldn't reach Earshot to ask. Try again.");
  else if (res.error && !res.question) toast(res.error);
  await reloadCurrent(id); // the answer belongs to the meeting it was asked on
}

// ---------------------------------------------------------------- settings

// One setting per row: what it is and a line on what it does, with its control beside it.
function setRow(label, hint, control, { wide = false } = {}) {
  const row = el("div", `setrow${wide ? " wide" : ""}`);
  const text = el("div", "settext");
  text.append(el("div", "setlabel", label));
  if (hint) text.append(el("div", "hint", hint));
  row.append(text);
  if (control) row.append(control);
  return row;
}
function switchFor(checked, onChange) {
  const box = el("input");
  box.type = "checkbox";
  box.className = "switch";
  box.checked = !!checked;
  box.addEventListener("change", () => onChange(box.checked));
  return box;
}
function textField(value, { mono = true } = {}) {
  const input = el("input");
  input.type = "text";
  input.value = value ?? "";
  if (!mono) input.classList.add("plain");
  return input;
}
function textBox(value, rows = 6) {
  const area = el("textarea");
  area.rows = rows;
  area.value = value;
  return area;
}
function actionsRow(...buttons) {
  const row = el("div", "actions-row");
  row.append(...buttons);
  return row;
}
function section(id, title, intro) {
  const box = el("section");
  box.id = `set-${id}`;
  box.append(el("h3", null, title));
  if (intro) box.append(el("p", "intro", intro));
  return box;
}
const linesOf = (text) => text.split("\n").map((t) => t.trim()).filter(Boolean);
// "Name: other, other" lines <-> { Name: [other, other] }
const pairsText = (obj) => Object.entries(obj || {}).map(([k, v]) => `${k}: ${(v || []).join(", ")}`).join("\n");
function pairsOf(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const at = line.indexOf(":");
    if (at > 0) out[line.slice(0, at).trim()] = line.slice(at + 1).split(",").map((a) => a.trim()).filter(Boolean);
  }
  return out;
}

async function renderSettings() {
  const main = document.getElementById("detail");
  const wrap = el("div", "settings");
  const config = helperInfo ? await send({ kind: "helper", op: "get-config" }) : null;

  // Appearance
  const look = section("look", "Appearance");
  const theme = el("div", "segmented");
  for (const [value, label] of [["dark", "Dark"], ["light", "Light"]]) {
    const b = el("button", (settings.theme || "dark") === value ? "on" : "", label);
    b.addEventListener("click", async () => {
      settings.theme = value;
      await send({ kind: "set-setting", key: "theme", value });
      applyTheme();
      renderSettings();
    });
    theme.append(b);
  }
  look.append(setRow("Background", "For this page. The panel in your meetings stays dark.", theme));

  // Capture
  const capture = section("capture", "Capture");
  for (const [key, label, hint] of [
    ["autoCaptions", "Turn on captions when I join", "Earshot reads the meeting's own captions, so they need to be on."],
    ["panelOpenOnJoin", "Open the panel when a meeting starts", "Otherwise only the small launcher shows."],
    ["autoMinutes", "Write minutes when a meeting ends", "Uses the minutes command under Helper and AI."],
    ["notifyEnded", "Tell me when a meeting is saved", "A notification shortly after a meeting ends. Click it to open the meeting."],
    ["redirectZoom", "Open Zoom links in the browser", "Zoom's desktop app can't be captured."],
  ]) {
    capture.append(setRow(label, hint, switchFor(settings[key] !== false, (on) => send({ kind: "set-setting", key, value: on }))));
  }
  const wait = el("select");
  for (const [value, label] of [[0, "Right away"], [2, "2 minutes"], [5, "5 minutes"], [10, "10 minutes"], [15, "15 minutes"]]) {
    const o = el("option", null, label);
    o.value = String(value);
    wait.append(o);
  }
  wait.value = String(settings.minutesDelayMinutes ?? 5);
  wait.addEventListener("change", () => {
    settings.minutesDelayMinutes = Number(wait.value);
    send({ kind: "set-setting", key: "minutesDelayMinutes", value: Number(wait.value) });
  });
  capture.append(setRow("Wait before writing minutes", "After a meeting ends. If it comes back in that time (a refresh, a rejoin, a browser restart), it carries on and the minutes wait for the real end.", wait));

  // Tags and vendors
  const tags = section("tags", "Companies, vendors and tags", "A meeting is tagged automatically when its title names a company, a vendor or one of their aliases. You can always change the tags on a meeting.");
  const tagArea = textBox((settings.tags || []).join("\n"), 8);
  const vendorArea = textBox((settings.vendors || []).join("\n"), 6);
  const aliasArea = textBox(pairsText(settings.tagAliases), 6);
  tags.append(
    setRow("Companies and teams", "One per line. The first tag on a meeting decides its vault folder and its group in By company.", tagArea, { wide: true }),
    setRow("Vendors", "One per line. Shown as their own group in the tag filter.", vendorArea, { wide: true }),
    setRow("Aliases", "Other words in a title that mean the same tag, as  Tag: word, other word", aliasArea, { wide: true })
  );
  const saveTags = el("button", "primary", "Save tags");
  saveTags.addEventListener("click", async () => {
    const list = linesOf(tagArea.value);
    const vendors = linesOf(vendorArea.value);
    const aliases = pairsOf(aliasArea.value);
    await send({ kind: "set-setting", key: "tags", value: list });
    await send({ kind: "set-setting", key: "vendors", value: vendors });
    await send({ kind: "set-setting", key: "tagAliases", value: aliases });
    Object.assign(settings, { tags: list, vendors, tagAliases: aliases });
    if (helperInfo) await send({ kind: "helper", op: "set-config", payload: { patch: { tags: list, vendors, tagAliases: aliases } } });
    toast("Tags saved");
    renderTagFilter();
  });
  tags.append(actionsRow(saveTags));

  // Names and spellings
  const words = section("words", "Names and spellings", "Captions mishear names. The minutes and Ask AI use this list to spell people, companies and products correctly.");
  if (helperInfo) {
    const glossary = textBox(pairsText(config?.glossary), 10);
    words.append(setRow("Correct spelling: what captions write instead", "One per line, as  Kubernetes: Cube Nettys", glossary, { wide: true }));
    const save = el("button", "primary", "Save names");
    save.addEventListener("click", async () => {
      await send({ kind: "helper", op: "set-config", payload: { patch: { glossary: pairsOf(glossary.value) } } });
      toast("Names saved");
    });
    words.append(actionsRow(save));
  } else words.append(el("p", "intro", "Available once the helper is installed."));

  // Helper and AI
  const ai = section("ai", "Helper and AI");
  if (!helperInfo) {
    ai.append(el("p", "intro", "The Earshot helper isn't connected. It saves meetings as files in ~/Earshot and runs your AI CLI for Ask AI and minutes. Install it by running helper/install.sh from the Earshot folder in Terminal, then reload Earshot in chrome://extensions."));
  } else {
    const where = el("div", "inline");
    const open = el("button", "quiet", "Show in Finder");
    open.addEventListener("click", () => send({ kind: "helper", op: "open-folder", payload: {} }));
    where.append(open);
    ai.append(setRow("Meetings folder", `Saving to ${helperInfo.root}. Helper ${helperInfo.version}.`, where));
    const account = config?.ai?.account;
    const healthLine = el("div", "hint");
    const check = el("button", "quiet", "Check sign-in");
    check.addEventListener("click", async () => {
      check.disabled = true;
      healthLine.textContent = "Checking…";
      const h = (await send({ kind: "check-ai" })) || { ok: false, problem: "Couldn't reach Earshot.", fix: "Reload this page and try again." };
      check.disabled = false;
      healthLine.textContent = h.ok ? `Signed in${h.orgName ? ` to ${h.orgName}` : ""} and answering. Checked ${new Date(h.checkedAt).toLocaleTimeString()}.` : `${h.problem} Fix: ${h.fix || ""}`;
      showAiHealth(h);
    });
    const accountText = account ? `${account.orgName || "Personal"}${account.subscriptionType ? ` (${account.subscriptionType})` : ""}, from ${account.configDir}.` : "Not set.";
    const accountRow = setRow("Claude account", accountText, check);
    accountRow.querySelector(".settext").append(healthLine);
    ai.append(accountRow);
    const fields = {};
    for (const [key, label, hint] of [["ask", "Ask AI command", "Fast and cheap. The prompt goes in on stdin."], ["minutes", "Minutes command", "Better writing. The prompt goes in on stdin."]]) {
      const spec = config?.ai?.[key] || {};
      const input = textField([spec.command, ...(spec.args || [])].map((a) => (/\s|^$/.test(a) ? JSON.stringify(a) : a)).join(" "));
      fields[key] = { input, spec };
      ai.append(setRow(label, hint, input, { wide: true }));
    }
    const saveAi = el("button", "primary", "Save AI commands");
    saveAi.addEventListener("click", async () => {
      const patch = { ai: {} };
      for (const [key, { input, spec }] of Object.entries(fields)) {
        const parts = input.value.match(/"[^"]*"|\S+/g) || [];
        const words = parts.map((p) => (p.startsWith('"') ? JSON.parse(p) : p));
        if (!words.length) continue;
        patch.ai[key] = { ...spec, command: words[0], args: words.slice(1), label: spec.label || words[0].split("/").pop() };
      }
      await send({ kind: "helper", op: "set-config", payload: { patch } });
      toast("AI commands saved");
    });
    ai.append(actionsRow(saveAi));
  }

  // Minutes template
  const template = section("template", "Minutes template");
  if (helperInfo) {
    const t = await send({ kind: "helper", op: "get-template", payload: { name: "default.md" } });
    const area = textBox(t?.text || "", 16);
    area.classList.add("code");
    template.append(setRow("The prompt the minutes are written from", "Placeholders: {{title}} {{date}} {{time}} {{attendees}} {{attendee_links}} {{tags}} {{tag_hashtags}} {{context}} {{notes}} {{transcript}}. Saved as ~/Earshot/templates/default.md.", area, { wide: true }));
    const save = el("button", "primary", "Save template");
    save.addEventListener("click", async () => {
      await send({ kind: "helper", op: "set-template", payload: { name: "default.md", text: area.value } });
      toast("Template saved");
    });
    template.append(actionsRow(save));
  } else template.append(el("p", "intro", "Available once the helper is installed."));

  const sections = [look, capture, tags, words, ai, template, await obsidianSettings()];
  const nav = el("nav", "setnav");
  nav.append(el("div", "navtitle", "Settings"));
  for (const s of sections) {
    const b = el("button", null, s.querySelector("h3").textContent);
    b.addEventListener("click", () => s.scrollIntoView({ behavior: "smooth", block: "start" }));
    nav.append(b);
  }
  const body = el("div", "setbody");
  body.append(el("h1", null, "Settings"), ...sections);
  wrap.append(nav, body);
  if (location.hash !== "#settings") return; // a meeting was opened while settings loaded
  main.replaceChildren(wrap);
}

// Obsidian filing: which vault, where each meeting's note goes, the daily-note line.
async function obsidianSettings() {
  const box = section("vault", "Obsidian vault", "Where each meeting's note goes, and the line it adds to that day's daily note.");
  if (!helperInfo) {
    box.append(el("p", "intro", "Available once the helper is installed."));
    return box;
  }
  const v = await send({ kind: "helper", op: "get-vault-settings" });
  if (!v || v.error || !v.dailyNote) {
    box.append(el("p", "intro", "Couldn't read the vault settings from the helper. Reload this page to try again."));
    return box;
  }
  const path = textField(v.path);
  const find = el("button", "quiet", "Find vaults on this Mac");
  const found = el("div", "found");
  find.addEventListener("click", async () => {
    found.textContent = "Looking…";
    const list = await send({ kind: "helper", op: "find-vaults" });
    found.replaceChildren(...(list || []).map((p) => {
      const b = el("button", "ghost", p);
      b.addEventListener("click", () => (path.value = p));
      return b;
    }));
    if (!list?.length) found.textContent = "No vaults found under your home folder.";
  });
  const vaultRow = setRow("Vault folder", "The folder that holds .obsidian.", path, { wide: true });
  const finder = el("div", "inline");
  finder.append(find, found);
  vaultRow.append(finder);
  let auto = v.autoFile;
  let daily = v.dailyNote.enabled;
  let shots = v.screenshots;
  const folder = textField(v.folderPattern);
  const name = textField(v.fileNamePattern);
  const map = textBox(Object.entries(v.departments || {}).map(([t, f]) => `${t}: ${f}`).join("\n"), 5);
  const unfiled = textField(v.unfiledFolder);
  const dailyFolder = textField(v.dailyNote.folder ?? "");
  const dailyFormat = textField(v.dailyNote.format ?? "");
  const heading = textField(v.dailyNote.heading);
  const line = textField(v.dailyNote.line);
  const transcript = el("select");
  for (const [value, label] of [["folded", "Folded away at the bottom"], ["full", "In full at the bottom"], ["none", "Left out"]]) {
    const o = el("option", null, label);
    o.value = value;
    transcript.append(o);
  }
  transcript.value = v.transcript;
  box.append(
    vaultRow,
    setRow("File meetings automatically", "Once a meeting's minutes are written.", switchFor(auto, (on) => (auto = on))),
    setRow("Folder for meeting notes", "{department} is the tag's folder below; also {year} {month} {tag}.", folder, { wide: true }),
    setRow("Note name", "{date} is YYYY-MM-DD; also {title} {time} {platform}.", name, { wide: true }),
    setRow("Tag to folder", "One per line, as  Tag: folder. Other tags use departments/<Tag> when it exists; an empty folder means don't file.", map, { wide: true }),
    setRow("Folder for untagged meetings", null, unfiled, { wide: true }),
    setRow("Add a line to the daily note", "With your tagged notes under it, for the vault agent.", switchFor(daily, (on) => (daily = on))),
    setRow("Daily notes folder", "Blank uses the vault's own daily-notes setting.", dailyFolder, { wide: true }),
    setRow("Daily note date format", "Blank uses the vault's setting (e.g. MM.DD.YY).", dailyFormat, { wide: true }),
    setRow("Heading the line goes under", null, heading, { wide: true }),
    setRow("The line", "{link} {title} {time} {summary} {tags}", line, { wide: true }),
    setRow("Transcript in the note", null, transcript),
    setRow("Copy presentation screenshots", "Into the vault's images folder.", switchFor(shots, (on) => (shots = on)))
  );
  const save = el("button", "primary", "Save vault settings");
  save.addEventListener("click", async () => {
    const departments = {};
    for (const row of map.value.split("\n")) {
      const at = row.indexOf(":");
      if (at > 0) departments[row.slice(0, at).trim()] = row.slice(at + 1).trim();
    }
    await send({
      kind: "helper",
      op: "set-vault-settings",
      payload: {
        settings: {
          path: path.value.trim() || null,
          autoFile: auto,
          folderPattern: folder.value.trim(),
          fileNamePattern: name.value.trim(),
          departments,
          unfiledFolder: unfiled.value.trim(),
          dailyNote: { enabled: daily, folder: dailyFolder.value.trim() || null, format: dailyFormat.value.trim() || null, heading: heading.value.trim(), line: line.value, createIfMissing: true },
          transcript: transcript.value,
          screenshots: shots,
        },
      },
    });
    toast("Vault settings saved");
  });
  box.append(actionsRow(save));
  return box;
}

// ---------------------------------------------------------------- wiring

// Search waits for a pause in typing, then asks the helper, which reads every saved meeting.
let searchTimer = null;
let searchSeq = 0; // only the latest search's answer is used
document.getElementById("filter").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    const seq = ++searchSeq;
    const query = e.target.value.trim().toLowerCase();
    let ids = null;
    if (query && helperInfo) ids = await send({ kind: "helper", op: "search-meetings", payload: { query } });
    if (seq !== searchSeq) return;
    filter = query;
    searchIds = Array.isArray(ids) ? new Set(ids) : null;
    renderList();
  }, 200);
});
// Keys: / to search, Esc to clear it, ↑ ↓ (or j k) to move between meetings.
// Copying part of a transcript gives just that text: names and times on their own lines,
// none of the tag buttons or badges.
document.addEventListener("copy", (e) => {
  const sel = getSelection();
  if (sel.isCollapsed || !sel.rangeCount || !e.clipboardData) return;
  const range = sel.getRangeAt(0);
  const root = range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
  // Only transcripts: minutes and answers keep the browser's own rich copy, for Word and Teams.
  const inTranscript = root && (root.closest(".turn, .who") || root.querySelector(".turn"));
  if (!inTranscript || root.isContentEditable) return;
  e.clipboardData.setData("text/plain", Earshot.selectionText(range));
  e.preventDefault();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && e.target.id === "filter") {
    clearTimeout(searchTimer);
    searchSeq++;
    e.target.value = "";
    filter = "";
    searchIds = null;
    e.target.blur();
    renderList();
    return;
  }
  if (e.target.closest?.("input, textarea, select, [contenteditable='true']") || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === "/") {
    e.preventDefault();
    if (document.body.classList.contains("listhidden")) setListHidden(false);
    document.getElementById("filter").focus();
    return;
  }
  if (e.key === "[") {
    e.preventDefault();
    setListHidden(!document.body.classList.contains("listhidden"));
    return;
  }
  const step = { ArrowDown: 1, j: 1, ArrowUp: -1, k: -1 }[e.key];
  if (!step) return;
  const items = [...document.querySelectorAll("#list .item")];
  if (!items.length) return;
  e.preventDefault();
  const at = items.findIndex((i) => i.classList.contains("on"));
  const next = items[Math.min(items.length - 1, Math.max(0, at < 0 ? 0 : at + step))];
  next.click();
  next.scrollIntoView({ block: "nearest" });
});
for (const b of document.querySelectorAll(".viewswitch button")) {
  b.addEventListener("click", () => {
    view = b.dataset.view;
    store("view", view);
    renderList();
  });
}
document.getElementById("settingsBtn").addEventListener("click", () => {
  openSeq++; // a meeting still loading must not replace settings
  current = null;
  loadFailed = null;
  history.replaceState(null, "", "#settings");
  renderList();
  renderSettings();
});
document.querySelector(".lightbox").addEventListener("click", (e) => e.currentTarget.classList.remove("open"));
document.addEventListener("click", (e) => {
  if (!e.target.closest(".menuwrap")) for (const m of document.querySelectorAll(".menuwrap.open")) m.classList.remove("open");
  if (!e.target.closest(".reacts")) for (const r of document.querySelectorAll(".reacts.open")) r.classList.remove("open");
});

function showAiHealth(health) {
  if (!health) return;
  const state = document.getElementById("helperState");
  state.textContent = health.ok
    ? `Saving to ${helperInfo.root} · AI: ${helperInfo.ai?.ask || "?"}${health.orgName ? ` (${health.orgName})` : ""} · signed in`
    : `AI is off: ${health.problem} Fix: ${health.fix || ""}`;
  state.classList.toggle("bad", !health.ok);
}
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.kind === "ai-health") showAiHealth(msg.health);
});

// Edits made in the in-meeting panel (or another meetings tab) show up here.
// While you're typing, have text selected, or have a menu or line-tag picker open,
// the redraw waits (it would wipe all of those) and tries again shortly.
let refreshTimer = null;
let rowsTimer = null;
function detailBusy() {
  const sel = document.getSelection();
  const detail = document.getElementById("detail");
  return (
    editing ||
    ["TEXTAREA", "INPUT"].includes(document.activeElement?.tagName) ||
    (sel && !sel.isCollapsed && sel.rangeCount > 0 && detail.contains(sel.getRangeAt(0).commonAncestorContainer)) ||
    !!document.querySelector("#detail .open, .lightbox.open")
  );
}
function refreshMeeting(id, delay) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    if (current?.id !== id) return;
    if (detailBusy()) return refreshMeeting(id, 1000);
    await reloadCurrent(id);
  }, delay);
}
// Back on this page with a Mac app meeting open: it may have written to it
// since (minutes after the Whisper pass, say), so a newer disk copy is taken in.
async function takeNewerDiskCopy() {
  if (!current || !DISK_EDITED.has(current.platform)) return;
  const id = current.id;
  const fromDisk = await send({ kind: "helper", op: "get-meeting", payload: { id } });
  if (!fromDisk || fromDisk.error) return;
  const res = await send({ kind: "import-meeting", meeting: fromDisk });
  if (!res?.imported) return;
  contentCache.delete(id);
  refreshMeeting(id, 0);
  loadRows();
}
window.addEventListener("focus", () => takeNewerDiskCopy());
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && takeNewerDiskCopy());

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.kind !== "meeting-changed") return;
  contentCache.delete(msg.id);
  clearTimeout(rowsTimer);
  rowsTimer = setTimeout(loadRows, 300);
  refreshMeeting(msg.id, 300);
});

// Light or dark, from Settings; the list column can be folded away.
function applyTheme() {
  document.documentElement.dataset.theme = settings.theme === "light" ? "light" : "dark";
}
function setListHidden(hidden) {
  document.body.classList.toggle("listhidden", hidden);
  document.getElementById("listToggle").title = hidden ? "Show the meeting list ([)" : "Hide the meeting list ([)";
  store("listHidden", hidden);
}
document.getElementById("listToggle").addEventListener("click", () => setListHidden(!document.body.classList.contains("listhidden")));
setListHidden(stored("listHidden", false));

(async () => {
  settings = (await send({ kind: "get-settings" })) || {};
  applyTheme();
  const status = await send({ kind: "helper-status" });
  helperInfo = status?.info || null;
  const state = document.getElementById("helperState");
  state.textContent = helperInfo ? `Saving to ${helperInfo.root} · AI: ${helperInfo.ai?.ask || "not set"}` : "Helper not installed: meetings stay in Chrome only, and AI is off.";
  state.classList.toggle("bad", !helperInfo);
  if (helperInfo) {
    try {
      showAiHealth((await chrome.storage.session.get("aiHealth")).aiHealth);
    } catch {}
  }
  await loadRows();
  // Titles changed in the vault, notes deleted there: the background applies them and says which changed.
  if (helperInfo) send({ kind: "vault-sync" });
  const fromHash = decodeURIComponent(location.hash.slice(1));
  if (fromHash === "settings") renderSettings();
  else if (fromHash && rows.some((r) => r.id === fromHash)) openMeeting(fromHash);
  else if (rows[0]) openMeeting(rows[0].id);
  else renderDetail();
})();
