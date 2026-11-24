// Meeting record logic shared by the Chrome background worker and the Mac app.
// Chrome-specific work (storage writes, helper calls) comes in through `hooks`.
(function (root) {
  const Earshot = (root.Earshot = root.Earshot || {});

  // Records saved by earlier versions lack the newer fields.
  Earshot.upgrade = function (meeting) {
    meeting.speakerNames ??= {};
    meeting.notes ??= "";
    meeting.screenshots ??= [];
    meeting.titleEdited ??= false;
    meeting.tags ??= [];
    meeting.tagsAuto ??= true;
    meeting.chats ??= [];
    meeting.minutes ??= null;
    return meeting;
  };

  // ---------------------------------------------------------------- capture health

  // Each page hook reports how capture is going (a "health" event when a call
  // starts and every few seconds after). These turn a report into the reason
  // nothing is being captured, so the panel can say what is wrong instead of
  // looking live. A hook left in a tab by an older Earshot carries a lower
  // number (or none) and is told apart by it.
  Earshot.HOOK_VERSION = 3;

  function captureProblems(label) {
    return {
      late: {
        code: "late",
        text: "Refresh this tab to capture",
        hint: `Earshot started after this ${label} call did, so it can't see the captions. Refresh the tab to capture the call.`,
        retry: false,
      },
      stale: {
        code: "stale",
        text: "Refresh this tab to capture",
        hint: "Earshot was updated after this tab opened, and the tab is still running the old version. Refresh the tab so it can capture.",
        retry: false,
      },
      format: {
        code: "format",
        text: `Can't read ${label}'s captions`,
        hint: `${label} is sending captions in a form Earshot can't read, so nothing is being saved. Save Debug info from the menu so it can be fixed.`,
        retry: false,
      },
      unread: {
        code: "unread",
        text: "No captions while people talk",
        hint: `${label} is sending caption data, but none of it is captions Earshot can read. Try again. If it stays like this, save Debug info from the menu.`,
      },
      silent: {
        code: "silent",
        text: "No captions while people talk",
        hint: `People are talking but no captions are arriving. Try again, or turn captions on in ${label}.`,
      },
    };
  }

  // From one report, at any point in a call: null when capture looks fine.
  // Only reports with real evidence raise a problem: packets that were
  // rejected, or speech heard with no captions for half a minute.
  Earshot.captureProblem = function (health, label = "The meeting app") {
    if (!health || typeof health !== "object") return null;
    const problems = captureProblems(label);
    const recent = health.recent || {};
    if (!health.joined) return health.late && health.inCall ? problems.late : null;
    if ((recent.rejected || 0) >= 3 && !recent.accepted) return problems.format;
    const talking = Number.isFinite(health.speechAgoMs) && health.speechAgoMs < 15000;
    if (!talking || !(health.quietMs > 30000)) return null;
    return recent.control > 0 ? problems.unread : problems.silent;
  };

  // When the panel has given up waiting for the first captions: the reason, if
  // the hook knows one. Null leaves the usual guess (the host has captions off).
  // `hookVersion` is the number on the tab's latest page events, when known.
  Earshot.noCaptionsCause = function (health, label = "The meeting app", hookVersion) {
    const problems = captureProblems(label);
    if (hookVersion !== undefined && !(hookVersion >= Earshot.HOOK_VERSION)) return problems.stale;
    if (!health || typeof health !== "object" || health.accepted) return null;
    if (health.rejected > 0) return problems.format;
    const heardSpeech = !health.hearsSpeech || (Number.isFinite(health.speechAgoMs) && health.speechAgoMs < 60000);
    if (health.control > 0 && heardSpeech) return problems.unread;
    if (health.hearsSpeech && Number.isFinite(health.speechAgoMs) && health.speechAgoMs < 15000) return problems.silent;
    return null;
  };

  // Tag from the title: a company, team or vendor (or one of its aliases) named
  // in the title. Built-in aliases and yours are combined.
  Earshot.autoTag = function (meeting, settings) {
    if (!meeting.tagsAuto || !meeting.title) return;
    const { tags, vendors, tagAliases: aliases } = settings;
    const title = ` ${meeting.title.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
    const hit = (word) => title.includes(` ${word.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `);
    const found = [...tags, ...(vendors || [])].filter((t) => hit(t) || ((aliases || {})[t] || []).some(hit));
    meeting.tags = Earshot.orderTags(found, vendors).slice(0, 3);
  };

  Earshot.summaryOf = function (meeting) {
    return {
      id: meeting.id,
      platform: meeting.platform,
      meetingRef: meeting.meetingRef,
      title: meeting.title,
      tags: meeting.tags,
      startedAt: meeting.startedAt,
      endedAt: meeting.endedAt,
      captionLanguage: meeting.captionLanguage,
      segmentCount: meeting.segments.length,
      screenshotCount: meeting.screenshots.length,
      chatCount: meeting.chats.length,
      hasMinutes: !!meeting.minutes,
      speakers: Earshot.speakers(meeting),
    };
  };

  // What a helper result does to a meeting record, the same in every background.
  // `at` is passed in so a change replayed onto a newer copy lands identically.

  // helper `minutes` -> {minutes, oneLiner, template}
  Earshot.applyMinutes = function (meeting, res, at = new Date().toISOString()) {
    meeting.minutes = res.minutes;
    meeting.oneLiner = res.oneLiner || meeting.oneLiner || null;
    meeting.minutesAt = at;
    meeting.minutesTemplate = res.template;
    delete meeting.minutesError;
    delete meeting.minutesAttempts;
  };

  // helper `file-to-vault` -> {filed, note, vault, filedAt, dailyLines, ...}
  Earshot.applyFiling = function (meeting, res, at = new Date().toISOString()) {
    // A filing that didn't happen keeps the last one's path and title: the vault sync's base.
    const prev = meeting.lastFiling || {};
    const kept = res.filed ? {} : Object.fromEntries(["planned", "title"].filter((k) => k in prev).map((k) => [k, prev[k]]));
    meeting.lastFiling = { ...kept, ...res, at };
    if (res.filed) {
      meeting.vaultNote = res.note;
      meeting.vaultName = res.vault;
      meeting.filedAt = res.filedAt;
      meeting.vaultDailyLines = res.dailyLines || []; // replaced, not repeated, on the next filing
      delete meeting.vaultMissing;
    }
  };

  // helper `vault-sync` -> one meeting's patch (see helper/vault.js applyVaultSync, which is the same):
  // the vault's title taken, the note's new place, its note gone from the vault, a vault title to offer.
  Earshot.applyVaultSync = function (meeting, patch, at = new Date().toISOString()) {
    if (!patch || typeof patch !== "object") return false;
    if ("title" in patch && patch.title) {
      meeting.title = String(patch.title);
      meeting.titleEdited = true;
      meeting.lastFiling = { ...(meeting.lastFiling || {}), title: meeting.title, ...(patch.planned ? { planned: patch.planned } : {}) };
    }
    if (patch.vaultNote) meeting.vaultNote = patch.vaultNote;
    for (const k of ["vaultMissing", "vaultTitle"]) {
      if (!(k in patch)) continue;
      if (patch[k] === null) delete meeting[k];
      else meeting[k] = patch[k];
    }
    meeting.vaultCheckedAt = at;
    return true;
  };

  // ---------------------------------------------------------------- changes redone on a newer copy
  // Chrome and the Mac panel both write Mac meetings. Each keeps a log of its
  // unsaved changes and, when the helper says disk moved on, redoes them on the
  // disk copy. These are the kinds both backgrounds log.

  // A line's tag set to `want` (a tag id, or null for none), notes bullet included.
  Earshot.setReaction = async function (rec, segmentId, want, hooks) {
    const seg = segmentsById(rec).get(segmentId);
    if (!seg) return false;
    const now = Earshot.tagOf(seg.reaction)?.id ?? null;
    if (now === want) return false;
    // The core's react toggles: naming the current tag takes it off, naming another puts that one on.
    return Earshot.applyAction(rec, { action: "react", segmentId, reaction: want ?? now }, hooks);
  };

  // After a live change: what a redo must reproduce, where a plain repeat wouldn't.
  Earshot.settleChange = function (rec, entry) {
    if (entry.kind === "action" && entry.req.action === "react") {
      entry.result = Earshot.tagOf(segmentsById(rec).get(entry.req.segmentId)?.reaction)?.id ?? null;
    }
  };

  // updatedAt for a write built on `base`: now, or just after base if that's later.
  Earshot.stampAfter = (base) => new Date(Math.max(Date.now(), (Date.parse(base) || 0) + 1)).toISOString();

  // One logged change redone on a record. Returns whether it changed anything.
  Earshot.redoChange = async function (rec, e, hooks) {
    switch (e.kind) {
      case "action":
        // A tag on a line is redone as the state it left, not as another toggle.
        if (e.req.action === "react" && "result" in e) return Earshot.setReaction(rec, e.req.segmentId, e.result, hooks);
        return Earshot.applyAction(rec, e.req, hooks);
      case "chat":
        if (rec.chats.some((c) => c.at === e.chat.at && c.question === e.chat.question)) return false;
        rec.chats.push(structuredClone(e.chat));
        return true;
      case "minutes":
        Earshot.applyMinutes(rec, e.res, e.at);
        return true;
      case "minutes-error":
        rec.minutesError = e.error;
        return true;
      case "filing":
        Earshot.applyFiling(rec, e.res, e.at);
        return true;
    }
    return false;
  };

  // One Ask AI exchange: `outcome` is helper `ask`'s {answer, model, ms}, or the Error it failed with.
  Earshot.chatFor = function (question, outcome, at = Date.now()) {
    const chat = { at, question: String(question).trim(), answer: null };
    if (outcome instanceof Error) chat.error = String(outcome.message || outcome);
    else if (outcome && typeof outcome === "object") Object.assign(chat, { answer: outcome.answer, model: outcome.model, ms: outcome.ms });
    else chat.error = "The AI gave no answer.";
    return chat;
  };

  // The screenshot's entry in the record (its image is kept apart). req = {at, width, height, source}.
  Earshot.screenshotRecord = function (meetingId, req, now = Date.now()) {
    return { id: `${meetingId}-${now.toString(36)}`, at: req.at || now, width: req.width, height: req.height, source: req.source };
  };

  // Replace one Mac capture's segments (ids "mac-<captureId>-...") with a fresh
  // set, keeping captions and other captures. Returns whether anything changed.
  Earshot.mergeMacSegments = function (meeting, captureId, segments) {
    const prefix = `mac-${captureId}-`;
    const old = meeting.segments.filter((s) => s.id.startsWith(prefix));
    const same = old.length === segments.length && old.every((s, i) => JSON.stringify(s) === JSON.stringify(segments[i]));
    if (same) return false;
    const kept = meeting.segments.filter((s) => !s.id.startsWith(prefix));
    meeting.segments = [...kept, ...segments].sort((a, b) => a.startedAt - b.startedAt);
    indexes.delete(meeting);
    return true;
  };

  function reactionNoteLine(meeting, seg) {
    const when = Earshot.elapsed(meeting.startedAt, seg.startedAt);
    return `- ${seg.speaker} [${when}]: ${seg.text} #${Earshot.tagOf(seg.reaction).tag}`;
  }

  // The line an emoji reaction (from before the tags) added, so untagging removes it.
  const LEGACY_EMOJI = { key: "🎯", action: "✅", question: "❓", idea: "💡" };
  function legacyNoteLine(meeting, seg) {
    const when = Earshot.elapsed(meeting.startedAt, seg.startedAt);
    if (!LEGACY_EMOJI[seg.reaction]) return null;
    return seg.reaction === "action" ? `- [ ] ✅ [${when}] ${seg.speaker}: ${seg.text}` : `- ${LEGACY_EMOJI[seg.reaction]} [${when}] ${seg.speaker}: ${seg.text}`;
  }

  const indexes = new WeakMap(); // meeting -> Map(segment id -> segment)
  function segmentsById(meeting) {
    let index = indexes.get(meeting);
    if (!index) {
      index = new Map(meeting.segments.map((s) => [s.id, s]));
      indexes.set(meeting, index);
    }
    return index;
  }
  Earshot.segmentsById = segmentsById;

  // Apply one edit from the panel / meetings page. hooks = { settings(), saveTags(list), removeShot(shotId) }.
  // Returns true when the meeting changed (the caller then saves it).
  Earshot.applyAction = async function (meeting, req, hooks) {
    const index = segmentsById(meeting);
    switch (req.action) {
      case "rename": {
        meeting.title = String(req.title || "").trim();
        meeting.titleEdited = !!meeting.title;
        if (meeting.tagsAuto && meeting.title) Earshot.autoTag(meeting, await hooks.settings());
        return true;
      }
      case "vault-sync":
        return Earshot.applyVaultSync(meeting, req.patch, req.at);
      case "set-tags": {
        meeting.tags = [...new Set((req.tags || []).map((t) => String(t).trim()).filter(Boolean))];
        meeting.tagsAuto = false;
        if (meeting.tagSuggestion) meeting.tagSuggestion = null; // tagged by hand: the Mac panel's suggestion is done with
        if (req.addToList) {
          const s = await hooks.settings();
          const missing = meeting.tags.filter((t) => !s.tags.includes(t));
          if (missing.length) await hooks.saveTags([...s.tags, ...missing]);
        }
        return true;
      }
      case "edit-segment": {
        const seg = index.get(req.segmentId);
        if (!seg) return false;
        seg.text = String(req.text).trim();
        seg.edited = true;
        return true;
      }
      case "react": {
        // Tag a transcript block (#todo, #followup...); it's added to your notes as a tagged bullet.
        const seg = index.get(req.segmentId);
        if (!seg || !Earshot.tagOf(req.reaction)) return false;
        const before = Earshot.tagOf(seg.reaction);
        if (before) {
          const old = [reactionNoteLine(meeting, seg), legacyNoteLine(meeting, seg)].filter(Boolean);
          meeting.notes = meeting.notes.split("\n").filter((l) => !old.includes(l.trim())).join("\n");
        }
        seg.reaction = before?.id === req.reaction ? null : req.reaction;
        if (seg.reaction) meeting.notes = `${meeting.notes.replace(/\s+$/, "")}${meeting.notes.trim() ? "\n" : ""}${reactionNoteLine(meeting, seg)}`;
        return true;
      }
      case "rename-speaker": {
        const name = String(req.name || "").trim();
        if (!name) return false;
        meeting.speakerNames[req.speakerId] = name;
        for (const seg of meeting.segments) {
          if (seg.speakerId === req.speakerId) {
            seg.speaker = name;
            seg.speakerResolved = true;
          }
        }
        return true;
      }
      case "notes": {
        meeting.notes = String(req.text ?? "");
        return true;
      }
      case "delete-screenshot": {
        meeting.screenshots = meeting.screenshots.filter((s) => s.id !== req.shotId);
        await hooks.removeShot(req.shotId);
        return true;
      }
      case "dismiss-suggestion": {
        // The company the Mac panel suggested (tagSuggestion) wasn't right: it's
        // remembered, so it isn't suggested again. Null, not deleted: the panel
        // merges updates over its copy, so a missing key wouldn't clear it.
        if (!meeting.tagSuggestion) return false;
        meeting.tagSuggestionDismissed = [...new Set([...(meeting.tagSuggestionDismissed || []), meeting.tagSuggestion.tag])];
        meeting.tagSuggestion = null;
        return true;
      }
      case "set-minutes": {
        meeting.minutes = String(req.text ?? "");
        return true;
      }
      default:
        return false;
    }
  };
})(typeof self !== "undefined" ? self : globalThis);
