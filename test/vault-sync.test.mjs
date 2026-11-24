// The vault sync (titles by earshot_id, notes deleted from the vault) and the duplicate check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const vault = require("../helper/vault.js");
require("../extension/shared/transcript.js");
require("../extension/shared/defaults.js");
require("../extension/shared/meeting-core.js");
const E = globalThis.Earshot;

function makeVault() {
  const dir = mkdtempSync(path.join(tmpdir(), "earshot-sync-"));
  mkdirSync(path.join(dir, ".obsidian"), { recursive: true });
  writeFileSync(path.join(dir, ".obsidian", "daily-notes.json"), JSON.stringify({ folder: "daily/notes", format: "MM.DD.YY" }));
  mkdirSync(path.join(dir, "departments", "Globex"), { recursive: true });
  writeFileSync(path.join(dir, "departments", "Globex", "Globex.md"), "# Globex\n");
  return dir;
}

const seg = (i) => ({ id: `s${i}`, startedAt: Date.parse("2024-06-09T15:34:00Z") + i * 1000, speaker: "Alex Kestrel", speakerId: "a", text: `line ${i}` });
const meeting = (extra = {}) =>
  E.upgrade({ id: "zoom-1-20240609-103217", platform: "zoom", title: "Weekly sync", tags: ["Globex"], startedAt: "2024-06-09T15:32:17Z", endedAt: "2024-06-09T16:01:20Z", segments: [seg(1), seg(2)], ...extra });

async function filed(dir, m) {
  const config = { vault: { path: dir } };
  E.applyFiling(m, await vault.fileMeeting(m, config));
  return config;
}

function setVaultTitle(dir, m, title) {
  const file = path.join(dir, m.vaultNote);
  writeFileSync(file, readFileSync(file, "utf8").replace(/^title: .*$/m, `title: ${JSON.stringify(title)}`));
}

const syncOne = (m, config) => vault.syncVault([m], config).results.find((r) => r.id === m.id) || null;

test("filing records Earshot's title as the sync's base", async () => {
  const dir = makeVault();
  const m = meeting();
  await filed(dir, m);
  assert.equal(m.lastFiling.title, "Weekly sync");
  assert.equal(syncOne(m, { vault: { path: dir } }), null, "nothing to do right after filing");
});

test("a title changed in the vault comes back to Earshot, and the next filing keeps the note in place", async () => {
  const dir = makeVault();
  const m = meeting();
  const config = await filed(dir, m);
  const before = m.vaultNote;
  setVaultTitle(dir, m, "Bluth Health x Globex demo");
  const r = syncOne(m, config);
  assert.equal(r.patch.title, "Bluth Health x Globex demo");
  assert.equal(r.refile, false);
  E.applyVaultSync(m, r.patch);
  assert.equal(m.title, "Bluth Health x Globex demo");
  assert.equal(m.titleEdited, true);
  assert.equal(syncOne(m, config), null, "settled");
  E.applyFiling(m, await vault.fileMeeting(m, config, { previous: m.vaultNote }));
  assert.equal(m.vaultNote, before, "re-filing after taking the vault's title doesn't move the note");
});

test("a title changed in Earshot is filed again; changed on both sides, the vault's is only offered", async () => {
  const dir = makeVault();
  const m = meeting();
  const config = await filed(dir, m);
  m.title = "Weekly sync (renamed here)";
  assert.deepEqual(syncOne(m, config), { id: m.id, patch: {}, refile: true });
  setVaultTitle(dir, m, "Vault's own name");
  const r = syncOne(m, config);
  assert.equal(r.refile, false);
  assert.equal(r.patch.vaultTitle.title, "Vault's own name");
  assert.equal(m.title, "Weekly sync (renamed here)", "Earshot keeps its own");
  E.applyVaultSync(m, r.patch);
  assert.equal(syncOne(m, config), null, "offered once");
});

test("The vault agent's title, kept by a re-file, is taken by Earshot once and then stays settled", async () => {
  const dir = makeVault();
  const m = meeting();
  const config = await filed(dir, m);
  const file = path.join(dir, m.vaultNote);
  writeFileSync(file, readFileSync(file, "utf8").replace(/^title: .*$/m, 'title: "Globex weekly (the vault agent)"\nagent_checked: 2026-11-12'));
  E.applyFiling(m, await vault.fileMeeting(m, config, { previous: m.vaultNote })); // keepAgentFixes keeps the vault agent's title
  const r = syncOne(m, config);
  assert.equal(r.patch.title, "Globex weekly (the vault agent)");
  E.applyVaultSync(m, r.patch);
  E.applyFiling(m, await vault.fileMeeting(m, config, { previous: m.vaultNote }));
  assert.equal(syncOne(m, config), null);
});

test("without a base, a placeholder title takes the vault's; a cut-short vault title is ignored", async () => {
  const dir = makeVault();
  const m = meeting({ platform: "meet", title: "abc-defg-hij", meetingRef: "abc-defg-hij" });
  const config = await filed(dir, m);
  delete m.lastFiling.title; // filed before the sync existed
  setVaultTitle(dir, m, "Bluth Health x Globex");
  assert.equal(syncOne(m, config).patch.title, "Bluth Health x Globex");
  const t = meeting({ id: "import-x", platform: "import", title: "URGENT - please attend. Budget review" });
  await filed(dir, t);
  delete t.lastFiling.title;
  setVaultTitle(dir, t, "URGENT");
  assert.equal(syncOne(t, config), null);
  setVaultTitle(dir, t, "Budget review");
  assert.equal(syncOne(t, config).patch.vaultTitle.title, "Budget review", "a real difference is offered, not taken");
});

test("a note deleted in Obsidian marks the meeting; filing again clears it; a moved note is followed", async () => {
  const dir = makeVault();
  const m = meeting();
  const config = await filed(dir, m);
  const note = m.vaultNote;
  mkdirSync(path.join(dir, ".trash"), { recursive: true });
  renameSync(path.join(dir, note), path.join(dir, ".trash", path.basename(note)));
  const r = syncOne(m, config);
  assert.deepEqual({ ...r.patch.vaultMissing, at: null }, { note, trashed: true, at: null });
  E.applyVaultSync(m, r.patch);
  assert.equal(syncOne(m, config), null, "marked once");
  E.applyFiling(m, await vault.fileMeeting(m, config, { previous: m.vaultNote }));
  assert.equal(m.vaultMissing, undefined);
  assert.equal(syncOne(m, config), null);
  mkdirSync(path.join(dir, "Archive"), { recursive: true });
  renameSync(path.join(dir, m.vaultNote), path.join(dir, "Archive", "moved.md"));
  assert.equal(syncOne(m, config).patch.vaultNote, path.join("Archive", "moved.md"));
});

test("a skipped filing keeps the base", () => {
  const m = meeting();
  E.applyFiling(m, { filed: true, note: "N.md", planned: "N.md", title: "Weekly sync" });
  E.applyFiling(m, { filed: false, reason: "Automatic filing is off." });
  assert.equal(m.lastFiling.title, "Weekly sync");
  assert.equal(m.lastFiling.planned, "N.md");
});

test("duplicates: a short browser capture of a call the Mac app saved in full", () => {
  const meet = { id: "meet-abc", platform: "meet", title: "abc-defg-hij", startedAt: "2024-06-09T15:32:17Z", endedAt: "2024-06-09T16:01:20Z", segmentCount: 12, speakers: ["Alex Kestrel", "Tobin Ashcroft"] };
  const mac = { id: "mac-1", platform: "mac", title: "Bluth Health x Globex", startedAt: "2024-06-09T15:35:51Z", endedAt: "2024-06-09T16:02:13Z", segmentCount: 95, speakers: ["Me", "Call"] };
  const later = { id: "zoom-2", platform: "zoom", title: "Next call", startedAt: "2024-06-09T16:05:00Z", endedAt: "2024-06-09T16:30:00Z", segmentCount: 40, speakers: ["Alex Kestrel"] };
  const imported = { ...meet, id: "import-1", platform: "import", segmentCount: 300 };
  const found = vault.findDuplicates([meet, mac, later, imported]);
  assert.deepEqual(Object.keys(found), ["meet-abc"]);
  assert.equal(found["meet-abc"].id, "mac-1");
  // Two browser captures at once need two shared speakers to be one call.
  const zoomA = { id: "zoom-a", platform: "zoom", startedAt: "2026-11-12T15:00:00Z", endedAt: "2026-11-12T15:30:00Z", segmentCount: 5, speakers: ["Alex Kestrel", "Morgan Hale"] };
  const teamsB = { id: "teams-b", platform: "teams", startedAt: "2026-11-12T15:02:00Z", endedAt: "2026-11-12T15:30:00Z", segmentCount: 50, speakers: ["Alex Kestrel"] };
  assert.deepEqual(vault.findDuplicates([zoomA, teamsB]), {});
  assert.equal(vault.findDuplicates([zoomA, { ...teamsB, speakers: ["Alex Kestrel", "Morgan Hale"] }])["zoom-a"].id, "teams-b");
});
