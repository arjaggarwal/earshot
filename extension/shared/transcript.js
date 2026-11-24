// Transcript formatting shared by the background worker, panel, popup and meetings page.
(function (root) {
  const Earshot = (root.Earshot = root.Earshot || {});

  const LABELS = {
    zoom: "Zoom",
    teams: "Teams",
    meet: "Google Meet",
    import: "Imported",
    "teams-desktop": "Teams (desktop)",
    "zoom-desktop": "Zoom (desktop)",
    mac: "Mac recording",
  };
  Earshot.platformLabel = (platform) => LABELS[platform] || "Meeting";
  Earshot.titleOf = (meeting) => meeting.title || `${Earshot.platformLabel(meeting.platform)} meeting`;

  // Line tags are the vault's own, so the vault agent routes them from the daily note
  // (#todo to the to-do list, #followup to the company's Follow Up, #ROI to
  // its ROI file...). Tagging a transcript block puts it in your notes with
  // the tag; tagged note lines are filed under the meeting's daily-note line.
  Earshot.TAGS = [
    { id: "todo", tag: "todo", label: "To-do" },
    { id: "followup", tag: "followup", label: "Follow-up" },
    { id: "roi", tag: "ROI", label: "ROI" },
    { id: "opportunity", tag: "opportunity", label: "Opportunity" },
    { id: "insight", tag: "insight", label: "Insight" },
  ];
  // Reactions from before the tags (key, action, question, idea) read as the nearest tag.
  const LEGACY_TAGS = { action: "todo", question: "followup", idea: "opportunity", key: "insight" };
  Earshot.tagOf = (id) => (id ? Earshot.TAGS.find((t) => t.id === (LEGACY_TAGS[id] || id)) || null : null);

  // A meeting's tags in the order that matters: the first decides its vault
  // folder and its group. Personal first (never filed), then the client,
  // then your own teams (Hiring before Internal), then vendors.
  const TEAM_TAGS = ["Internal", "Hiring", "Vendor"];
  Earshot.orderTags = function (tags, vendors = []) {
    // A client first: a client call that also says "standup" files with the client. A hiring
    // call files under Hiring before the catch-all Internal.
    const rank = (t) => (t === "Personal" ? 0 : vendors.includes(t) ? 3 : t === "Internal" ? 2.5 : TEAM_TAGS.includes(t) ? 2 : 1);
    return [...tags].sort((a, b) => rank(a) - rank(b));
  };

  // Add #tag to the end of a notes line, or take it off again. An empty line
  // becomes a bullet with the tag, and the caret goes where the words will go.
  Earshot.toggleLineTag = function (line, tag) {
    const mark = `#${tag}`;
    const has = new RegExp(`(^|\\s)${mark}(?![\\w-])`, "i");
    if (has.test(line)) {
      const text = line.replace(has, "").replace(/\s+$/, "");
      return { text, caret: text.length };
    }
    if (!line.trim()) return { text: `-  ${mark}`, caret: 2 };
    const text = `${line.replace(/\s+$/, "")} ${mark}`;
    return { text, caret: text.length };
  };

  // Consecutive segments from the same speaker read as one paragraph.
  Earshot.paragraphs = function (segments) {
    const out = [];
    for (const seg of segments) {
      const last = out[out.length - 1];
      if (last && last.speakerId === seg.speakerId) {
        last.text += " " + seg.text;
        last.endedAt = seg.lastAt;
        last.segments.push(seg);
      } else {
        out.push({ speakerId: seg.speakerId, speaker: seg.speaker, startedAt: seg.startedAt, endedAt: seg.lastAt, text: seg.text, segments: [seg] });
      }
    }
    return out;
  };

  Earshot.elapsed = function (fromIso, atMs) {
    const total = Math.max(0, Math.round((atMs - Date.parse(fromIso)) / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  };

  Earshot.speakers = function (meeting) {
    const seen = new Map();
    for (const seg of meeting.segments) if (!seen.has(seg.speakerId)) seen.set(seg.speakerId, seg.speaker);
    return [...seen.values()];
  };

  // Speaker colors by order of first appearance, so the first eight never clash.
  // Speaker colours: light ones for dark backgrounds, deeper ones for the light theme.
  const COLORS = ["#81c995", "#8ab4f8", "#fdd663", "#f6aea9", "#d7aefb", "#78d9ec", "#fcad70", "#c6dafc"];
  const COLORS_LIGHT = ["#2e7d4f", "#2f6690", "#9a6b00", "#b4483b", "#7b4fae", "#1f7a8c", "#b35c14", "#4a5f8a"];
  Earshot.speakerPalette = function (meeting) {
    const order = new Map();
    for (const seg of meeting.segments) if (!order.has(seg.speakerId)) order.set(seg.speakerId, order.size);
    const light = typeof document !== "undefined" && document.documentElement?.dataset?.theme === "light";
    const palette = light ? COLORS_LIGHT : COLORS;
    return (speakerId) => palette[(order.get(speakerId) ?? 0) % palette.length];
  };

  // Share of words spoken, per speaker, largest first.
  Earshot.talkTime = function (meeting) {
    const bySpeaker = new Map();
    let total = 0;
    for (const seg of meeting.segments) {
      const words = seg.text.split(/\s+/).filter(Boolean).length;
      total += words;
      const row = bySpeaker.get(seg.speakerId) || { speakerId: seg.speakerId, speaker: seg.speaker, words: 0, turns: 0 };
      row.speaker = seg.speaker;
      row.words += words;
      bySpeaker.set(seg.speakerId, row);
    }
    for (const p of Earshot.paragraphs(meeting.segments)) bySpeaker.get(p.speakerId).turns += 1;
    return [...bySpeaker.values()].map((r) => ({ ...r, share: total ? r.words / total : 0 })).sort((a, b) => b.words - a.words);
  };

  // Transcript segments and screenshots in time order.
  Earshot.timeline = function (meeting) {
    const items = meeting.segments.map((s) => ({ kind: "segment", at: s.startedAt, segment: s }));
    for (const shot of meeting.screenshots || []) items.push({ kind: "screenshot", at: shot.at, shot });
    return items.sort((a, b) => a.at - b.at);
  };

  const headerLines = (meeting) => [
    `- Platform: ${Earshot.platformLabel(meeting.platform)}`,
    `- Started: ${new Date(meeting.startedAt).toLocaleString()}`,
    `- Tags: ${(meeting.tags || []).join(", ") || "none"}`,
    `- Speakers: ${Earshot.speakers(meeting).join(", ") || "none yet"}`,
    `- Participants seen: ${Object.values(meeting.participants || {}).join(", ") || "unknown"}`,
  ];

  Earshot.shotFileName = (meeting, shot) =>
    `${Earshot.fileName(meeting, "").replace(/\.$/, "")} screenshot ${Earshot.elapsed(meeting.startedAt, shot.at).replace(/:/g, "-")}.jpg`;

  const reacted = (meeting) => meeting.segments.filter((s) => Earshot.tagOf(s.reaction));
  const tagLabel = (s) => (Earshot.tagOf(s.reaction) ? `[${Earshot.tagOf(s.reaction).label}] ` : "");

  Earshot.toMarkdown = function (meeting) {
    const lines = [`# ${Earshot.titleOf(meeting)}`, "", ...headerLines(meeting), ""];
    if (meeting.minutes && meeting.minutes.trim()) lines.push("## Minutes", "", meeting.minutes.trim(), "");
    if (meeting.notes && meeting.notes.trim()) lines.push("## Notes", "", meeting.notes.trim(), "");
    lines.push("## Transcript", "");
    let last = null;
    for (const item of Earshot.timeline(meeting)) {
      const when = Earshot.elapsed(meeting.startedAt, item.at);
      if (item.kind === "screenshot") {
        lines.push(`![Presentation ${when}](${encodeURI(Earshot.shotFileName(meeting, item.shot))})`, "");
        last = null;
        continue;
      }
      const s = item.segment;
      if (s.speakerId !== last) lines.push(`**${s.speaker}** [${when}]`);
      lines.push(`${tagLabel(s)}${s.text}`, "");
      last = s.speakerId;
    }
    return lines.join("\n");
  };

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  // One self-contained page: screenshots embedded, tagged moments marked.
  // Notes and minutes are Markdown; shared/markdown.js formats them when loaded.
  const formatted = (md) => (Earshot.markdownToHtml ? Earshot.markdownToHtml(md.trim()) : `<div class="box">${esc(md.trim())}</div>`);

  Earshot.toHtml = function (meeting) {
    const parts = [];
    let last = null;
    for (const item of Earshot.timeline(meeting)) {
      const when = Earshot.elapsed(meeting.startedAt, item.at);
      if (item.kind === "screenshot") {
        if (item.shot.dataUrl) parts.push(`<figure><img src="${item.shot.dataUrl}" alt="Presentation ${when}"><figcaption>${when}</figcaption></figure>`);
        last = null;
        continue;
      }
      const s = item.segment;
      if (s.speakerId !== last) parts.push(`<h4>${esc(s.speaker)} <span class="t">${when}</span></h4>`);
      parts.push(`<p>${esc(tagLabel(s))}${esc(s.text)}</p>`);
      last = s.speakerId;
    }
    const tagged = reacted(meeting);
    return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(Earshot.titleOf(meeting))}</title>
<style>body{font:15px/1.6 -apple-system,system-ui,sans-serif;max-width:820px;margin:32px auto;padding:0 16px;color:#1d1f24}
h1{font-size:24px}h4{margin:18px 0 2px;font-size:14px}ul.meta{color:#5b6070;padding-left:18px}.t{color:#8a8f9c;font-size:12px;font-weight:400}
p{margin:0 0 10px}figure{margin:16px 0}img{max-width:100%;border:1px solid #ddd;border-radius:6px}figcaption{color:#8a8f9c;font-size:12px}
.box{white-space:pre-wrap;background:#f6f7f9;padding:12px;border-radius:6px}
.md{background:#f6f7f9;padding:12px 16px;border-radius:6px}.md ul,.md ol{padding-left:22px;margin:4px 0}.md p{margin:6px 0}
.md table{border-collapse:collapse}.md th,.md td{border:1px solid #ccc;padding:4px 8px;text-align:left}</style></head><body>
<h1>${esc(Earshot.titleOf(meeting))}</h1><ul class="meta">${headerLines(meeting).map((l) => `<li>${esc(l.slice(2))}</li>`).join("")}</ul>
${meeting.notes && meeting.notes.trim() ? `<h2>Notes</h2><div class="md">${formatted(meeting.notes)}</div>` : ""}
${meeting.minutes && meeting.minutes.trim() ? `<h2>Minutes</h2><div class="md">${formatted(meeting.minutes)}</div>` : ""}
${tagged.length ? `<h2>Tagged moments</h2><ul>${tagged.map((s) => `<li>${esc(tagLabel(s))}<b>${esc(s.speaker)}</b>: ${esc(s.text)}</li>`).join("")}</ul>` : ""}
<h2>Transcript</h2>${parts.join("\n")}</body></html>`;
  };

  Earshot.fileName = function (meeting, ext) {
    const d = new Date(meeting.startedAt);
    const pad = (n) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`;
    const title = Earshot.titleOf(meeting).replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 80);
    return `${stamp} ${title}.${ext}`;
  };
})(typeof self !== "undefined" ? self : globalThis);
