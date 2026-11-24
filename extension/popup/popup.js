// Toolbar popup: settings and the most recent meetings.

async function loadSettings() {
  const s = await chrome.storage.local.get(["autoCaptions", "redirectZoom", "captionLanguage", "panelMode"]);
  for (const id of ["autoCaptions", "redirectZoom"]) {
    const box = document.getElementById(id);
    box.checked = s[id] ?? true;
    box.addEventListener("change", () => chrome.storage.local.set({ [id]: box.checked }));
  }
  const lang = document.getElementById("captionLanguage");
  lang.innerHTML = Earshot.LANGUAGES.map((l) => `<option value="${l.id}">${l.name}</option>`).join("");
  lang.value = s.captionLanguage || "en";
  lang.addEventListener("change", () => chrome.storage.local.set({ captionLanguage: lang.value }));
  const mode = document.getElementById("panelMode");
  mode.value = s.panelMode || "docked";
  mode.addEventListener("change", () => chrome.storage.local.set({ panelMode: mode.value }));
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function exportMeeting(id) {
  const meeting = await chrome.runtime.sendMessage({ kind: "get-meeting", id });
  if (meeting) download(Earshot.fileName(meeting, "md"), Earshot.toMarkdown(meeting), "text/markdown");
}

async function loadMeetings() {
  const list = document.getElementById("list");
  const meetings = ((await chrome.runtime.sendMessage({ kind: "list-meetings" })) || []).slice(0, 8);
  if (!meetings.length) {
    list.innerHTML = '<div class="empty">No meetings captured yet.</div>';
    return;
  }
  list.replaceChildren(
    ...meetings.map((m) => {
      const row = document.createElement("div");
      row.className = "meeting";
      const title = document.createElement("div");
      title.className = "title";
      title.textContent = Earshot.titleOf(m);
      const sub = document.createElement("div");
      sub.className = "sub";
      sub.textContent = `${Earshot.platformLabel(m.platform)} · ${new Date(m.startedAt).toLocaleString()} · ${m.segmentCount} lines · ${m.speakers.join(", ") || "no speakers yet"}`;
      const buttons = document.createElement("div");
      buttons.className = "row";
      const open = document.createElement("button");
      open.textContent = "Open";
      open.addEventListener("click", () => chrome.runtime.sendMessage({ kind: "open-meetings", id: m.id }));
      const md = document.createElement("button");
      md.textContent = "Download .md";
      md.addEventListener("click", () => exportMeeting(m.id));
      buttons.append(open, md);
      row.append(title, sub, buttons);
      return row;
    })
  );
}

document.getElementById("openAll").addEventListener("click", () => chrome.runtime.sendMessage({ kind: "open-meetings" }));
loadSettings();
loadMeetings();
