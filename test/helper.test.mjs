// Helper ops used by the Mac app: browser state, segment relay, folders, company lookup.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const hostJs = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../helper/host.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmp = mkdtempSync(path.join(tmpdir(), "earshot-helper-"));
const home = path.join(tmp, "Earshot");
const vaultPath = path.join(tmp, "Vault");
mkdirSync(path.join(vaultPath, "people"), { recursive: true });
writeFileSync(path.join(vaultPath, "people", "Idris Oduya.md"), '---\nclient: "[[Globex]]"\ntype: person\n---\n# Idris Oduya\n');
writeFileSync(path.join(vaultPath, "people", "Sam Okonkwo.md"), '---\nclient: "[[Umbrella]]"\n---\n');
writeFileSync(path.join(vaultPath, "people", "Sam Fox.md"), '---\nclient: "[[Initech]]"\n---\n');
writeFileSync(path.join(vaultPath, "people", "Taylor Penhallow.md"), '---\ntype: person\nclient: "[[Internal]]"\ntitle: "Engineering lead"\n---\n');
writeFileSync(path.join(vaultPath, "people", "Dana Wu.md"), "---\nrole: advisor\n---\n");
mkdirSync(home, { recursive: true });
writeFileSync(path.join(home, "config.json"), JSON.stringify({ vault: { path: vaultPath } }));

const child = spawn(process.execPath, [hostJs], { env: { ...process.env, EARSHOT_HOME: home }, stdio: ["pipe", "pipe", "inherit"] });
let buf = Buffer.alloc(0);
const replies = new Map();
const pushes = [];
child.stdout.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0);
    if (buf.length < 4 + len) break;
    const msg = JSON.parse(buf.subarray(4, 4 + len).toString("utf8"));
    buf = buf.subarray(4 + len);
    if (msg.push) pushes.push(msg);
    else replies.get(msg.id)?.(msg);
  }
});
let nextId = 1;
function call(op, args = {}) {
  const rid = nextId++;
  const body = Buffer.from(JSON.stringify({ op, rid, ...args }));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  child.stdin.write(Buffer.concat([header, body]));
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no reply to ${op}`)), 5000);
    replies.set(rid, (m) => {
      clearTimeout(t);
      m.ok ? resolve(m.result) : reject(new Error(m.error));
    });
  });
}
async function until(fn, what, timeout = 8000) {
  const began = Date.now();
  while (Date.now() - began < timeout) {
    const v = await fn();
    if (v) return v;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

test.after(() => {
  child.kill();
  rmSync(tmp, { recursive: true, force: true });
});

test("an AI call that times out keeps what the CLI last said", async () => {
  const config = readFileSync(path.join(home, "config.json"), "utf8");
  const stuck = "process.stderr.write('Usage limit reached, retrying in 60s\\n'); setInterval(() => {}, 1000)";
  writeFileSync(path.join(home, "config.json"), JSON.stringify({ ...JSON.parse(config), ai: { minutes: { command: process.execPath, args: ["-e", stuck], timeoutSec: 1 } } }));
  try {
    const meeting = { id: "timeout-1", platform: "meet", title: "Stuck", startedAt: new Date().toISOString(), segments: [{ id: "a", speaker: "Ana", speakerId: "a", text: "Hello.", startedAt: Date.now() }] };
    await assert.rejects(call("minutes", { meeting }), /took longer than 1 seconds and was stopped\. It last said: Usage limit reached, retrying in 60s\. Try again/);
  } finally {
    writeFileSync(path.join(home, "config.json"), config);
  }
});

test("browser-state writes run/browser.json atomically", async () => {
  const meetings = [{ meetingId: "zoom-123-20261104-101500", tabId: 7, platform: "zoom", title: "Standup", captions: "arriving", startedAt: 1 }];
  await call("browser-state", { meetings });
  const file = JSON.parse(readFileSync(path.join(home, "run", "browser.json"), "utf8"));
  assert.deepEqual(file.meetings, meetings);
  assert.ok(Math.abs(file.at - Date.now()) < 2000);
});

test("suggest-company reads people notes", async () => {
  assert.deepEqual(await call("suggest-company", { names: ["idris oduya"] }), { tag: "Globex", person: "Idris Oduya" });
  assert.equal(await call("suggest-company", { names: ["Call"] }), null);
  assert.deepEqual(await call("suggest-company", { names: ["Call", "Dana", "kestrel"] }), null); // Dana has no client; "rivera" is a surname
  assert.deepEqual(await call("suggest-company", { names: ["Idris"] }), { tag: "Globex", person: "Idris Oduya" }); // unique first name
  // Your own team (client: Internal) says nothing about the company: the next person decides.
  assert.deepEqual(await call("suggest-company", { names: ["Taylor Penhallow", "Sam Fox"] }), { tag: "Initech", person: "Sam Fox" });
  assert.equal(await call("suggest-company", { names: ["Sam"] }), null); // ambiguous first name
});

test("suggest-company returns null without a vault", async () => {
  const cfg = path.join(home, "config.json");
  const was = readFileSync(cfg, "utf8");
  writeFileSync(cfg, JSON.stringify({ vault: { path: path.join(tmp, "nope") } }));
  assert.equal(await call("suggest-company", { names: ["Idris Oduya"] }), null);
  writeFileSync(cfg, was);
});

test("watch-mac pushes new and changed segment files, ack moves them", async () => {
  await call("watch-mac");
  const file = path.join(home, "run", "mac-segments-m1-a.json");
  const write = (segments, done = false) => {
    writeFileSync(file + ".tmp", JSON.stringify({ meetingId: "m1", captureId: "a", segments, done }));
    renameSync(file + ".tmp", file);
  };
  write([{ speaker: "Me", text: "hi", at: 1 }]);
  await until(() => pushes.length >= 1, "first push");
  assert.equal(pushes[0].push, "mac-segments");
  assert.equal(pushes[0].meetingId, "m1");
  assert.equal(pushes[0].captureId, "a");
  assert.equal(pushes[0].segments.length, 1);
  await sleep(400);
  assert.equal(pushes.length, 1, "duplicate fs events must not re-push");
  write([{ speaker: "Me", text: "hi", at: 1 }, { speaker: "Me", text: "there", at: 2 }]);
  await until(() => pushes.length >= 2, "second push");
  assert.equal(pushes[1].segments.length, 2);
  await sleep(400);
  assert.equal(pushes.length, 2);
  await call("mac-segments-ack", { meetingId: "m1", captureId: "a", done: true });
  assert.ok(!existsSync(file));
  assert.ok(existsSync(path.join(home, "run", "done", "mac-segments-m1-a.json")));
});

test("watch-mac ignores a file that does not parse yet", async () => {
  const before = pushes.length;
  const file = path.join(home, "run", "mac-segments-m2-b.json");
  writeFileSync(file, '{"meetingId": "m2", "capt');
  await sleep(400);
  assert.equal(pushes.length, before);
  writeFileSync(file, JSON.stringify({ meetingId: "m2", captureId: "b", segments: [], done: false }));
  await until(() => pushes.length > before, "push after complete write");
  assert.equal(pushes.at(-1).meetingId, "m2");
});

test("meeting-folder returns saved folder or run/audio/<id>", async () => {
  const meeting = { id: "zoom-1-1", platform: "zoom", title: "Saved one", startedAt: Date.now(), segments: [], notes: "" };
  const saved = await call("save-meeting", { meeting });
  assert.equal(await call("meeting-folder", { id: "zoom-1-1" }), saved.folder);
  const dir = await call("meeting-folder", { id: "x" });
  assert.equal(dir, path.join(home, "run", "audio", "x"));
  assert.ok(existsSync(dir));
});

test("save-meeting drops tags that aren't names and still writes the transcript", async () => {
  const startedAt = "2024-06-09T17:10:00.000Z";
  const line = { id: "mac-c-mic-1", speakerId: "mic", speaker: "Speaker", text: "Testing the transcript.", startedAt: Date.parse(startedAt) + 1000, lastAt: Date.parse(startedAt) + 2000 };
  const meeting = { id: "mac-mac-tags", platform: "mac", title: "", startedAt, segments: [line], tags: [{ ...line }, "Internal"], refs: [{ ...line }], chats: [{ ...line }], screenshots: [{ ...line }], notes: "" };
  const saved = await call("save-meeting", { meeting });
  const onDisk = JSON.parse(readFileSync(path.join(saved.folder, "meeting.json"), "utf8"));
  assert.deepEqual(onDisk.tags, ["Internal"]);
  assert.deepEqual([onDisk.refs, onDisk.chats, onDisk.screenshots], [[], [], []]);
  assert.ok(!readFileSync(path.join(saved.folder, "transcript.md"), "utf8").includes("Screenshot"));
  assert.ok(readFileSync(path.join(saved.folder, "transcript.md"), "utf8").includes("Testing the transcript."));
});

test("config gains mac defaults", async () => {
  const cfg = await call("get-config");
  assert.equal(cfg.mac.myName, "Alex");
  assert.equal(cfg.mac.audioKeepDays, 30);
  assert.equal(cfg.mac.whisperModel, "~/Earshot/models/ggml-large-v3-turbo-q5_0.bin");
});

test("meeting-folder rejects ids that escape run/audio", async () => {
  for (const id of ["../x", "..", ".", "a/b", "", 5]) await assert.rejects(call("meeting-folder", { id }), /bad meeting id/, JSON.stringify(id));
  await assert.rejects(call("meeting-folder", {}), /bad meeting id/);
  assert.ok(!existsSync(path.join(home, "run", "audio", "undefined")));
  assert.ok(!existsSync(path.join(home, "x")));
});

test("suggest-company with no vault path returns null and ignores cwd", async () => {
  const cfg = path.join(home, "config.json");
  const was = readFileSync(cfg, "utf8");
  writeFileSync(cfg, JSON.stringify({}));
  assert.equal(await call("suggest-company", { names: ["Idris Oduya"] }), null);
  writeFileSync(cfg, was);
});

test("browser-state validates its input", async () => {
  await assert.rejects(call("browser-state", { meetings: "nope" }), /array/);
  await assert.rejects(call("browser-state", {}), /array/);
  await call("browser-state", { meetings: [{ meetingId: "ok-1", tabId: 1 }, { tabId: 2 }, null, { meetingId: 5 }] });
  const file = JSON.parse(readFileSync(path.join(home, "run", "browser.json"), "utf8"));
  assert.deepEqual(file.meetings, [{ meetingId: "ok-1", tabId: 1 }]);
});

test("overlapping browser-state calls all succeed and the last one wins", async () => {
  const calls = [];
  for (let i = 0; i < 20; i++) calls.push(call("browser-state", { meetings: [{ meetingId: `m-${i}`, n: i }] }));
  await Promise.all(calls);
  const file = JSON.parse(readFileSync(path.join(home, "run", "browser.json"), "utf8"));
  assert.equal(file.meetings[0].meetingId, "m-19");
});

test("save-meeting refuses a copy older than the one on disk", async () => {
  const base = {
    id: "mac-20261104-stale1", platform: "mac", title: "Stale check", startedAt: "2026-11-04T10:00:00.000Z", endedAt: "2026-11-04T10:10:00.000Z",
    participants: {}, speakerNames: {}, screenshots: [], tags: [], chats: [], minutes: null,
    segments: [{ id: "mac-s-mic-1", speakerId: "mac-mic", speaker: "Speaker", speakerResolved: true, text: "Hello.", startedAt: 1, lastAt: 2 }],
  };
  const onDisk = async () => call("get-meeting", { id: base.id });
  const saved = await call("save-meeting", { meeting: { ...base, notes: "Newer.", updatedAt: "2026-11-04T10:20:00.000Z" } });
  assert.ok(saved.folder);
  assert.deepEqual(await call("save-meeting", { meeting: { ...base, notes: "Older.", updatedAt: "2026-11-04T10:15:00.000Z" } }), { stale: true });
  assert.equal((await onDisk()).notes, "Newer.");
  // The same time, or a newer one, writes as before.
  assert.ok((await call("save-meeting", { meeting: { ...base, notes: "Same time.", updatedAt: "2026-11-04T10:20:00.000Z" } })).folder);
  assert.equal((await onDisk()).notes, "Same time.");
  // Without an updatedAt on either side it writes as it always did.
  assert.ok((await call("save-meeting", { meeting: { ...base, notes: "No time." } })).folder);
  assert.equal((await onDisk()).notes, "No time.");
  assert.ok((await call("save-meeting", { meeting: { ...base, notes: "Old time over none.", updatedAt: "2026-11-01T00:00:00.000Z" } })).folder);
  assert.equal((await onDisk()).notes, "Old time over none.");
});

test("save-meeting with a base writes only over the copy it was built on", async () => {
  const rec = {
    id: "mac-20261104-base1", platform: "mac", title: "Base check", startedAt: "2026-11-04T11:00:00.000Z", endedAt: null,
    participants: {}, speakerNames: {}, screenshots: [], tags: [], chats: [], minutes: null, segments: [],
  };
  const onDisk = async () => call("get-meeting", { id: rec.id });
  // Never on disk: a null base writes.
  assert.ok((await call("save-meeting", { meeting: { ...rec, notes: "First.", updatedAt: "2026-11-04T11:01:00.000Z" }, base: null })).folder);
  // Base matches the disk copy: written.
  assert.ok((await call("save-meeting", { meeting: { ...rec, notes: "Second.", updatedAt: "2026-11-04T11:02:00.000Z" }, base: "2026-11-04T11:01:00.000Z" })).folder);
  assert.equal((await onDisk()).notes, "Second.");
  // Someone else wrote since (base differs), even with an older time than ours: stale, with the disk copy, nothing written.
  const stale = await call("save-meeting", { meeting: { ...rec, notes: "Third.", updatedAt: "2026-11-04T12:00:00.000Z" }, base: "2026-11-04T11:01:00.000Z" });
  assert.equal(stale.stale, true);
  assert.equal(stale.meeting.notes, "Second.");
  assert.equal(stale.meeting.updatedAt, "2026-11-04T11:02:00.000Z");
  assert.equal((await onDisk()).notes, "Second.");
  // A null base over an existing copy is stale too.
  assert.equal((await call("save-meeting", { meeting: { ...rec, notes: "Fresh.", updatedAt: "2026-11-04T12:00:00.000Z" }, base: null })).stale, true);
  // No base: the old rule (a newer updatedAt writes, an older one is refused, with no copy sent back).
  assert.ok((await call("save-meeting", { meeting: { ...rec, notes: "No base.", updatedAt: "2026-11-04T11:03:00.000Z" } })).folder);
  assert.equal((await onDisk()).notes, "No base.");
  assert.deepEqual(await call("save-meeting", { meeting: { ...rec, notes: "No base, older.", updatedAt: "2026-11-04T11:00:30.000Z" } }), { stale: true });
  assert.equal((await onDisk()).notes, "No base.");
});

test("watch-mac doesn't push a file too big for one native message", async () => {
  await call("watch-mac");
  const put = (name, segments) => {
    const file = path.join(home, "run", name);
    writeFileSync(file + ".tmp", JSON.stringify({ meetingId: name.slice(13, -7), captureId: "a", segments, done: false }));
    renameSync(file + ".tmp", file);
  };
  const before = pushes.length;
  // About 1.2 MB of lines: Chrome would drop the connection on a frame this size.
  const big = Array.from({ length: 3000 }, (_, i) => ({ id: `mac-a-mic-${i}`, speakerId: "mac-mic", speaker: "Speaker", text: "x".repeat(400), startedAt: i, lastAt: i }));
  put("mac-segments-big1-a.json", big);
  await sleep(300);
  put("mac-segments-small1-a.json", [{ id: "mac-a-mic-1", speakerId: "mac-mic", speaker: "Speaker", text: "small", startedAt: 1, lastAt: 2 }]);
  await until(() => pushes.some((p) => p.meetingId === "small1"), "the small file's push");
  await sleep(5500); // past the rescan: the big one stays unsent
  assert.ok(!pushes.slice(before).some((p) => p.meetingId === "big1"), "no oversized push");
  assert.equal((await call("browser-state", { meetings: [] })).ok, true, "the helper still answers");
});

test("vault sync and duplicates: a partial copy isn't filed automatically; disk-only meetings are synced on disk", async () => {
  writeFileSync(path.join(home, "config.json"), JSON.stringify({ vault: { path: vaultPath } }));
  mkdirSync(path.join(vaultPath, ".obsidian"), { recursive: true });
  const line = (i) => ({ id: `l${i}`, startedAt: Date.parse("2024-06-09T15:40:00Z") + i * 1000, speaker: "Me", speakerId: "me", text: `line ${i}` });
  const mac = { id: "mac-full-1", platform: "mac", title: "Calloway demo", tags: [], startedAt: "2024-06-09T15:35:51Z", endedAt: "2024-06-09T16:02:13Z", updatedAt: "2024-06-09T16:02:00Z", segments: Array.from({ length: 20 }, (_, i) => line(i)) };
  const meet = { id: "meet-part-1", platform: "meet", title: "abc-defg-hij", meetingRef: "abc-defg-hij", tags: [], startedAt: "2024-06-09T15:32:17Z", endedAt: "2024-06-09T16:01:20Z", segments: [line(1), line(2)] };
  await call("save-meeting", { meeting: mac });
  const auto = await call("file-to-vault", { meeting: meet, auto: true });
  assert.equal(auto.filed, false);
  assert.equal(auto.duplicateOf.id, "mac-full-1");
  assert.match(auto.reason, /partial copy of "Calloway demo"/);
  assert.deepEqual(Object.keys(await call("find-duplicates", { rows: [meet] })), ["meet-part-1"]);
  // Filed by hand it goes in; then the Mac meeting (only on disk) is renamed in the vault.
  const filing = await call("file-to-vault", { meeting: mac });
  assert.ok(filing.filed);
  const disk = await call("get-meeting", { id: "mac-full-1" });
  disk.vaultNote = filing.note;
  disk.lastFiling = { ...filing };
  await call("save-meeting", { meeting: { ...disk, updatedAt: "2024-06-09T16:03:00Z" } });
  const note = path.join(vaultPath, filing.note);
  writeFileSync(note, readFileSync(note, "utf8").replace(/^title: .*$/m, 'title: "Bluth Health x Globex demo"'));
  const res = await call("vault-sync", { held: [] });
  assert.equal(res.ok, true);
  assert.equal(res.changedOnDisk >= 1, true, JSON.stringify(res));
  assert.equal((await call("get-meeting", { id: "mac-full-1" })).title, "Bluth Health x Globex demo");
  assert.equal((await call("vault-sync", { held: [] })).changedOnDisk, 0, "settled");
});
