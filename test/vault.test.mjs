// Filing into the vault alongside a vault agent (an overnight AI job): it files what Earshot couldn't place,
// fixes company, tags and attendee names, and stamps agent_checked. Re-filing keeps that work.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const vault = require("../helper/vault.js");
require("../extension/shared/transcript.js");
require("../extension/shared/defaults.js");
require("../extension/shared/meeting-core.js");
const E = globalThis.Earshot;

function makeVault() {
  const dir = mkdtempSync(path.join(tmpdir(), "earshot-vault-"));
  mkdirSync(path.join(dir, ".obsidian"), { recursive: true });
  writeFileSync(path.join(dir, ".obsidian", "daily-notes.json"), JSON.stringify({ folder: "daily/notes", format: "MM.DD.YY" }));
  mkdirSync(path.join(dir, "people"), { recursive: true });
  writeFileSync(path.join(dir, "people", "Alex Kestrel.md"), '---\ntype: person\nclient: "[[Internal]]"\n---\n');
  writeFileSync(path.join(dir, "people", "Morgan Hale.md"), '---\ntype: person\nclient: "[[Globex]]"\naliases: ["Morgan Hail", "Morgen"]\n---\n');
  writeFileSync(path.join(dir, "people", "Avery Wong.md"), '---\nclient: "[[Initech]]"\n---\n');
  writeFileSync(path.join(dir, "people", "Avery Lindqvist.md"), '---\nclient: "[[Umbrella]]"\n---\n');
  mkdirSync(path.join(dir, "departments", "Globex"), { recursive: true });
  writeFileSync(path.join(dir, "departments", "Globex", "Globex.md"), "# Globex\n");
  writeFileSync(
    path.join(dir, "departments", "Globex", "Globex Names.md"),
    '# Globex Names\n\n### Chris Doyle\n- **Title:** Founder, Brightwater\n- Spelling variants: "Chris Doil"\n'
  );
  return dir;
}

const startedAt = new Date(2026, 2, 2, 9, 30).toISOString();
const meeting = (extra = {}) => ({
  id: "zoom-555-20260302-093015",
  platform: "zoom",
  title: "Alex Kestrel: Intro Call",
  tags: [],
  startedAt,
  participants: { a: "Alex", b: "Chris Doil", c: "Call" },
  segments: [{ speaker: "Morgen", speakerId: "c", startedAt: Date.parse(startedAt) + 1000, text: "Hi" }],
  minutes: "**Summary**\n- Brightwater metrics for the Q3 pilot.\n\nOne-line summary: Brightwater metrics.",
  oneLiner: "Brightwater metrics.",
  notes: "",
  ...extra,
});

test("attendees are filed as the vault spells them; labels that aren't people are dropped", () => {
  const people = vault.vaultPeople(makeVault());
  assert.equal(vault.resolveName("Alex", people), "Alex Kestrel"); // the only Alex
  assert.equal(vault.resolveName("Morgen", people), "Morgan Hale"); // a known spelling
  assert.equal(vault.resolveName("Chris Doil", people), "Chris Doyle"); // Names file variant
  assert.equal(vault.resolveName("Avery", people), "Avery"); // two Averys: left as captured
  assert.equal(vault.resolveName("DanaPark", people), "Dana Park");
  assert.equal(vault.resolveName("Call", people), null);
  assert.equal(vault.resolveName("Speaker 2", people), null);
  assert.equal(vault.resolveName("Conference Room 2", people), null);
  assert.equal(vault.resolveName("averywong", people), "Avery Wong"); // Zoom display name, squashed
  assert.equal(vault.resolveName("Morgan Hale, Globex", people), "Morgan Hale"); // company added
  assert.equal(vault.resolveName("Alex (mobile)", people), "Alex Kestrel"); // device added
  assert.equal(vault.resolveName("Zed Okafor (Board)", people), "Zed Okafor (Board)"); // unknown: as captured
});

test("the filed transcript names speakers as the vault spells them", async () => {
  const dir = makeVault();
  const m = meeting({
    segments: [
      { speaker: "averywong", speakerId: "k", startedAt: Date.parse(startedAt) + 1000, text: "Hello." },
      { speaker: "DanaPark", speakerId: "g", startedAt: Date.parse(startedAt) + 2000, text: "Hi Avery." },
      { speaker: "Call", speakerId: "c", startedAt: Date.parse(startedAt) + 3000, text: "Far side." },
    ],
  });
  const res = await vault.fileMeeting(m, { vault: { path: dir } });
  const text = readFileSync(path.join(dir, res.note), "utf8");
  assert.match(text, /> \*\*Avery Wong\*\* \[00:01\]/);
  assert.match(text, /> \*\*Dana Park\*\* \[00:02\]/);
  assert.match(text, /> \*\*Call\*\* \[00:03\]/, "a label that isn't a person stays as it was");
  assert.ok(!/averywong|DanaPark/.test(text));
});

test("the minutes glossary carries the vault's learned spellings for the meeting's companies", () => {
  const dir = makeVault();
  const config = { vault: { path: dir } };
  assert.deepEqual(vault.vaultGlossary({ tags: ["Globex"] }, config), {
    "Morgan Hale": ["Morgan Hail", "Morgen"],
    "Chris Doyle": ["Chris Doil"],
  });
  assert.deepEqual(vault.vaultGlossary({ tags: ["Umbrella"] }, config), {});
});

test("re-filing keeps the place and the fixes the vault agent made, and follows a tag you change", async () => {
  const dir = makeVault();
  const config = { vault: { path: dir } };
  const m = meeting();
  const first = await vault.fileMeeting(m, config);
  assert.equal(first.note, "Inbox/meetings/earshot/2026-03-02 Alex Kestrel Intro Call.md");
  assert.equal(first.planned, first.note);
  let text = readFileSync(path.join(dir, first.note), "utf8");
  assert.match(text, /attendees: \["\[\[Alex Kestrel\]\]", "\[\[Chris Doyle\]\]", "\[\[Morgan Hale\]\]"\]/);
  E.applyFiling(m, first);

  // Overnight, the vault agent files it with Globex and fixes the names and tags.
  const moved = "departments/Globex/Meeting Minutes/2026-03-02 Alex Kestrel Intro Call.md";
  mkdirSync(path.join(dir, path.dirname(moved)), { recursive: true });
  renameSync(path.join(dir, first.note), path.join(dir, moved));
  text = readFileSync(path.join(dir, moved), "utf8")
    .replace(/^title: .*$/m, 'title: "Brightwater metrics kickoff"')
    .replace('company: ""', 'company: "Globex"')
    .replace('tags: ["meeting"]', 'tags: ["meeting", "Globex", "Vendor"]')
    .replace(/^attendees: .*$/m, 'attendees: ["[[Chris Doyle]]", "[[Taylor Penhallow]]", "[[Alex Kestrel]]"]')
    .replace("earshot_id: zoom-555-20260302-093015\n---", "earshot_id: zoom-555-20260302-093015\nagent_checked: 2026-03-03\n---")
    .replace(/%% earshot:end %%\n?$/, "%% earshot:end %%\n\nMy follow-up thoughts.\n");
  writeFileSync(path.join(dir, moved), text);
  const daily = path.join(dir, "daily", "notes", "03.02.26.md");
  writeFileSync(daily, readFileSync(daily, "utf8").replace("Inbox/meetings/earshot/", "departments/Globex/Meeting Minutes/"));

  // You regenerate the minutes: Earshot re-files where the vault agent put it, keeping the vault agent's frontmatter.
  m.minutes = "**Summary**\n- Brightwater will propose metrics.\n\nOne-line summary: Brightwater proposes metrics.";
  m.oneLiner = "Brightwater proposes metrics.";
  const again = await vault.fileMeeting(m, config, { previous: m.vaultNote });
  assert.equal(again.note, moved);
  assert.equal(existsSync(path.join(dir, first.note)), false, "no copy back in the Inbox");
  text = readFileSync(path.join(dir, moved), "utf8");
  assert.match(text, /title: "Brightwater metrics kickoff"/, "the vault agent's retitle is kept");
  assert.match(text, /company: "Globex"/);
  assert.match(text, /tags: \["meeting", "Globex", "Vendor"\]/);
  assert.match(text, /Taylor Penhallow/);
  assert.match(text, /agent_checked: 2026-03-03\n---\n%% earshot:start %%/);
  assert.match(text, /summary: "Brightwater proposes metrics\."/);
  assert.match(text, /Brightwater will propose metrics/);
  assert.match(text, /My follow-up thoughts\./);
  const line = readFileSync(daily, "utf8").split("\n").find((l) => l.includes("<!-- earshot:zoom-555"));
  assert.match(line, /^- \[\[departments\/Globex\/Meeting Minutes\/2026-03-02 Alex Kestrel Intro Call\|/);
  E.applyFiling(m, again);

  // A third re-file still finds it (vaultNote now points at the vault agent's place).
  const third = await vault.fileMeeting(m, config, { previous: m.vaultNote });
  assert.equal(third.note, moved);
  E.applyFiling(m, third);

  // You tag it Initech in Earshot: that's your call, so it moves and the vault agent starts over.
  mkdirSync(path.join(dir, "departments", "Initech"), { recursive: true });
  m.tags = ["Initech"];
  const retagged = await vault.fileMeeting(m, config, { previous: m.vaultNote });
  assert.equal(retagged.note, "departments/Initech/Meeting Minutes/2026-03-02 Alex Kestrel Intro Call.md");
  assert.equal(existsSync(path.join(dir, moved)), false);
  text = readFileSync(path.join(dir, retagged.note), "utf8");
  assert.match(text, /company: "Initech"/);
  assert.doesNotMatch(text, /agent_checked/);
  assert.match(text, /My follow-up thoughts\./);
});

test("a hiring call files under Hiring and a team standup under Internal", () => {
  const tag = (title) => {
    const m = E.upgrade({ id: "x", platform: "zoom", title, startedAt: 0, segments: [] });
    E.autoTag(m, E.DEFAULTS);
    return m.tags;
  };
  assert.deepEqual(tag("Candidate interview: backend engineer"), ["Hiring"]);
  assert.deepEqual(tag("Weekly team standup"), ["Internal"]);
  assert.deepEqual(tag("Globex Stripe working session"), ["Globex", "Stripe"]); // a client, then its vendor
  assert.deepEqual(tag("Globex standup")[0], "Globex"); // a client call that is also a standup files with the client
});
