import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
require("../extension/shared/transcript.js");
require("../extension/shared/defaults.js");
require("../extension/shared/meeting-core.js");
const E = globalThis.Earshot;

const seg = (id, startedAt, extra = {}) => ({ id, startedAt, speaker: "A", speakerId: "a", text: id, ...extra });
const meeting = (segments, extra = {}) =>
  E.upgrade({ id: "m1", platform: "meet", title: "", startedAt: 0, segments, ...extra });

test("mergeMacSegments replaces one capture, keeps the rest, sorts by start", () => {
  const m = meeting([seg("mac-a-mic-1", 10), seg("cap", 20), seg("mac-b-mic-1", 25), seg("mac-a-old", 99)]);
  const fresh = [seg("mac-a-mic-1", 10), seg("mac-a-mic-2", 30)];
  assert.equal(E.mergeMacSegments(m, "a", fresh), true);
  assert.deepEqual(m.segments.map((s) => s.id), ["mac-a-mic-1", "cap", "mac-b-mic-1", "mac-a-mic-2"]);
  assert.equal(E.mergeMacSegments(m, "a", fresh), false);
});

test("autoTag tags from the title and respects tagsAuto", () => {
  const m = meeting([], { title: "Globex Corporation sync" });
  E.autoTag(m, E.DEFAULTS);
  assert.deepEqual(m.tags, ["Globex"]);
  const off = meeting([], { title: "Globex Corporation sync", tagsAuto: false });
  E.autoTag(off, E.DEFAULTS);
  assert.deepEqual(off.tags, []);
});

test("applyAction react adds the note line and toggles it off", async () => {
  const m = meeting([seg("s1", 5000, { text: "hello" })]);
  const hooks = { settings: async () => E.DEFAULTS, saveTags() {}, removeShot() {} };
  assert.equal(await E.applyAction(m, { action: "react", segmentId: "s1", reaction: "insight" }, hooks), true);
  assert.match(m.notes, /hello #insight$/);
  await E.applyAction(m, { action: "react", segmentId: "s1", reaction: "insight" }, hooks);
  assert.equal(m.notes.trim(), "");
  assert.equal(m.segments[0].reaction, null);
});

test("desktop platform labels", () => {
  assert.equal(E.platformLabel("zoom-desktop"), "Zoom (desktop)");
  assert.equal(E.platformLabel("teams-desktop"), "Teams (desktop)");
  assert.equal(E.platformLabel("mac"), "Mac recording");
});

test("defaults carry captionsLostSeconds", () => {
  assert.equal(E.DEFAULTS.captionsLostSeconds, 120);
});

test("dismiss-suggestion clears the Mac panel's company suggestion and remembers it", async () => {
  const m = meeting([], { tagSuggestion: { tag: "Globex", person: "Idris Oduya" } });
  assert.equal(await E.applyAction(m, { action: "dismiss-suggestion" }, {}), true);
  assert.equal(m.tagSuggestion, null);
  assert.deepEqual(m.tagSuggestionDismissed, ["Globex"]);
  assert.equal(await E.applyAction(m, { action: "dismiss-suggestion" }, {}), false);
  m.tagSuggestion = { tag: "Globex", person: "Idris" };
  await E.applyAction(m, { action: "dismiss-suggestion" }, {});
  assert.deepEqual(m.tagSuggestionDismissed, ["Globex"]);
});

test("set-tags clears a suggestion, and leaves records without one alone", async () => {
  const m = meeting([], { tagSuggestion: { tag: "Globex", person: "Idris Oduya" } });
  await E.applyAction(m, { action: "set-tags", tags: ["Globex"] }, {});
  assert.equal(m.tagSuggestion, null);
  const plain = meeting([]);
  await E.applyAction(plain, { action: "set-tags", tags: ["Umbrella"] }, {});
  assert.equal("tagSuggestion" in plain, false);
});

test("applyMinutes and applyFiling set only their own fields", () => {
  const m = meeting([], { notes: "keep", oneLiner: "old", minutesError: "boom" });
  E.applyMinutes(m, { minutes: "## M", template: "default" }, "2026-11-04T12:00:00.000Z");
  assert.deepEqual([m.minutes, m.oneLiner, m.minutesAt, m.minutesTemplate, "minutesError" in m, m.notes], ["## M", "old", "2026-11-04T12:00:00.000Z", "default", false, "keep"]);
  E.applyMinutes(m, { minutes: "## N", oneLiner: "new", template: "t" });
  assert.equal(m.oneLiner, "new");
  E.applyFiling(m, { filed: false, reason: "off" }, "2026-11-04T12:01:00.000Z");
  assert.deepEqual(m.lastFiling, { filed: false, reason: "off", at: "2026-11-04T12:01:00.000Z" });
  assert.equal(m.vaultNote, undefined);
  E.applyFiling(m, { filed: true, note: "N.md", vault: "V", filedAt: "F" });
  assert.deepEqual([m.vaultNote, m.vaultName, m.filedAt, m.vaultDailyLines], ["N.md", "V", "F", []]);
});

test("chatFor and screenshotRecord build the records", () => {
  assert.deepEqual(E.chatFor("  Q? ", { answer: "A", model: "m", ms: 5 }, 7), { at: 7, question: "Q?", answer: "A", model: "m", ms: 5 });
  assert.deepEqual(E.chatFor("Q", new Error("signed out"), 8), { at: 8, question: "Q", answer: null, error: "signed out" });
  assert.deepEqual(E.chatFor("Q", null, 9), { at: 9, question: "Q", answer: null, error: "The AI gave no answer." });
  assert.equal(E.chatFor("Q", undefined, 9).error, "The AI gave no answer.");
  assert.deepEqual(E.screenshotRecord("m1", { width: 4, height: 3, source: "video" }, 36), { id: "m1-10", at: 36, width: 4, height: 3, source: "video" });
  assert.equal(E.screenshotRecord("m1", { at: 5 }, 36).at, 5);
});

// ---------------------------------------------------------------- capture health

const health = (extra = {}) => ({ hook: E.HOOK_VERSION, joined: true, accepted: 0, rejected: 0, control: 0, recent: { accepted: 0, rejected: 0, control: 0 }, quietMs: 0, ...extra });

test("a healthy report, or one from outside a call, raises nothing", () => {
  assert.equal(E.captureProblem(health({ accepted: 40, recent: { accepted: 4, rejected: 0, control: 9 }, quietMs: 2000, speechAgoMs: 500 }), "Google Meet"), null);
  assert.equal(E.captureProblem(health({ joined: false, recent: { rejected: 9 } }), "Google Meet"), null);
  assert.equal(E.captureProblem(null), null);
});

test("rejected caption packets with none read is a format problem; a stray one is not", () => {
  assert.equal(E.captureProblem(health({ recent: { accepted: 0, rejected: 12, control: 0 } }), "Google Meet").code, "format");
  assert.equal(E.captureProblem(health({ recent: { accepted: 0, rejected: 1, control: 0 } }), "Google Meet"), null);
  assert.equal(E.captureProblem(health({ recent: { accepted: 5, rejected: 12, control: 0 } }), "Google Meet"), null);
});

test("talking with no captions for half a minute is raised at any point in the call", () => {
  const quiet = health({ accepted: 80, quietMs: 31000, speechAgoMs: 1000 });
  assert.equal(E.captureProblem(quiet, "Google Meet").code, "silent");
  assert.match(E.captureProblem(quiet, "Google Meet").hint, /Google Meet/);
  assert.equal(E.captureProblem({ ...quiet, recent: { accepted: 0, rejected: 0, control: 7 } }, "Google Meet").code, "unread");
  // A quiet room is not a problem, and nor is a hook that can't hear speech.
  assert.equal(E.captureProblem({ ...quiet, speechAgoMs: 40000 }, "Google Meet"), null);
  assert.equal(E.captureProblem({ ...quiet, speechAgoMs: null }, "Google Meet"), null);
  assert.equal(E.captureProblem({ ...quiet, quietMs: 20000 }, "Google Meet"), null);
});

test("a hook put in after the call started says to refresh, only when a call is on the page", () => {
  assert.equal(E.captureProblem({ hook: 3, late: true, joined: false, inCall: true }, "Google Meet").code, "late");
  assert.equal(E.captureProblem({ hook: 3, late: true, joined: false, inCall: false }, "Google Meet"), null);
});

test("when the wait for captions runs out, the cause comes from the hook where it knows one", () => {
  assert.equal(E.noCaptionsCause(health(), "Zoom", E.HOOK_VERSION), null);
  assert.equal(E.noCaptionsCause(null, "Zoom", undefined), null);
  assert.equal(E.noCaptionsCause(health(), "Zoom", 0).code, "stale");
  assert.equal(E.noCaptionsCause(health({ rejected: 4 }), "Google Meet", E.HOOK_VERSION).code, "format");
  assert.equal(E.noCaptionsCause(health({ control: 6 }), "Microsoft Teams", E.HOOK_VERSION).code, "unread");
  // Meet sends control packets in a silent room too: no speech, no alarm.
  assert.equal(E.noCaptionsCause(health({ control: 6, hearsSpeech: true, speechAgoMs: null }), "Google Meet", E.HOOK_VERSION), null);
  assert.equal(E.noCaptionsCause(health({ control: 6, hearsSpeech: true, speechAgoMs: 3000 }), "Google Meet", E.HOOK_VERSION).code, "unread");
  assert.equal(E.noCaptionsCause(health({ hearsSpeech: true, speechAgoMs: 3000 }), "Google Meet", E.HOOK_VERSION).code, "silent");
  // Captions that did arrive once mean the format is fine.
  assert.equal(E.noCaptionsCause(health({ accepted: 3, rejected: 4 }), "Google Meet", E.HOOK_VERSION), null);
});
