// The Mac app's panel: extension/content/sidebar.js in a web page, laid out the
// way the app bundle holds it (mac/scripts/stage-web.sh), with a fake native
// bridge (window.earshotNative) that records every call and answers helper ops
// from a stub. No Swift and no helper process are involved.
//
//   PLAYWRIGHT_CORE=... CHROMIUM=... node test/mac-panel.mjs
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const playwrightPath = process.env.PLAYWRIGHT_CORE || "playwright-core"; // npm install, then npx playwright-core install chromium
const chromiumPath = process.env.CHROMIUM || undefined; // undefined: the Chromium Playwright installed

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, what, timeout = 6000) {
  const began = Date.now();
  let last;
  while (Date.now() - began < timeout) {
    last = await fn();
    if (last) return last;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(last)?.slice(0, 400)})`);
}
function assert(cond, message) {
  if (!cond) throw new Error(message);
}

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ok   ${name}`);
  } catch (err) {
    results.push({ name, ok: false });
    console.log(`  FAIL ${name}\n       ${String(err.message).split("\n").join("\n       ")}`);
  }
}

// ---------------------------------------------------------------- the bundle's web folder, served

const webDir = await mkdtemp(path.join(tmpdir(), "earshot-mac-web-"));
execFileSync(path.resolve(here, "../mac/scripts/stage-web.sh"), [webDir], { stdio: "inherit" });
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".woff2": "font/woff2", ".txt": "text/plain" };
const server = createServer(async (req, res) => {
  const file = path.join(webDir, decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (!file.startsWith(webDir)) return res.writeHead(403).end();
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" }).end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/`;

if (chromiumPath && !existsSync(chromiumPath)) throw new Error(`Chromium not found at ${chromiumPath}; unset CHROMIUM to use Playwright's`);
const { chromium } = require(playwrightPath);
const browser = await chromium.launch({ executablePath: chromiumPath, headless: true });
const context = await browser.newContext({ viewport: { width: 376, height: 760 } });
context.setDefaultTimeout(5000); // a missing element fails its check instead of hanging

// The fake native side. Helper ops answer like helper/host.js does, including
// save-meeting's guards (`base`, else updatedAt). The disk copies (one per
// meeting) outlive a page reload, as files outlive an app restart.
await context.addInitScript(() => {
  const clone = (v) => (v === undefined || v === null ? v : JSON.parse(JSON.stringify(v)));
  const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  const stub = (window.__stub = {
    calls: [],
    disks: JSON.parse(sessionStorage.getItem("test-disks") || "{}"),
    stales: 0,
    failAfterWrite: 0, // save-meeting writes, then throws, this many times
    failSave: 0, // save-meeting throws without writing, this many times
    onSave: null, // (meeting) => promise, awaited before a save is written
    failGet: 0, // get-meeting throws this many times
    onMinutes: null,
    suggest: { "idris oduya": { tag: "Globex", person: "Idris Oduya" }, "thea oduya": { tag: "Globex", person: "Thea Oduya" } },
    persist: () => sessionStorage.setItem("test-disks", JSON.stringify(stub.disks)),
    // Another writer (the meetings page) changes a meeting on disk.
    editOnDisk(id, patch) {
      // Its own stamp, never the same millisecond as the copy it replaces (the guard compares stamps).
      const prev = Date.parse(stub.disks[id].updatedAt) || 0;
      Object.assign(stub.disks[id], patch, { updatedAt: new Date(Math.max(Date.now(), prev + 1)).toISOString() });
      stub.persist();
    },
  });
  function writeMeeting(meeting, base) {
      const disk = stub.disks[meeting.id];
      if (base !== undefined) {
        if (disk && disk.updatedAt !== undefined && disk.updatedAt !== base) {
          stub.stales++;
          return { stale: true, meeting: clone(disk) };
        }
      } else if (disk && Date.parse(meeting.updatedAt) < Date.parse(disk.updatedAt)) return { stale: true };
      stub.disks[meeting.id] = clone(meeting);
      stub.persist();
      return { folder: "/tmp/earshot-test" };
  }
  const ops = {
    "get-config": () => ({ tags: ["Globex", "Acme", "Internal"], tagAliases: { Acme: ["Acme Corp"] }, mac: { myName: "Alex", audioKeepDays: 30 } }),
    "save-meeting": async ({ meeting, base }) => {
      if (stub.onSave) await stub.onSave(meeting);
      if (stub.failSave > 0) {
        stub.failSave--;
        throw new Error("helper unreachable");
      }
      const result = writeMeeting(meeting, base);
      // The file is written, then something fails (a later file, the lost reply).
      if (stub.failAfterWrite > 0 && result.folder) {
        stub.failAfterWrite--;
        throw new Error("transcript.md: disk full");
      }
      return result;
    },
    "get-meeting": ({ id }) => {
      if (stub.failGet > 0) {
        stub.failGet--;
        throw new Error("helper busy");
      }
      const m = clone(stub.disks[id] || null);
      // WebKit hands the page one JS array for every empty NSArray in a native reply.
      if (m && stub.shareEmptyReplies) {
        const shared = [];
        for (const k of Object.keys(m)) if (Array.isArray(m[k]) && !m[k].length) m[k] = shared;
      }
      return m;
    },

    ask: ({ question }) => ({ answer: `**Answer** to ${question}`, model: "fake-model", ms: 1500 }),
    minutes: ({ meeting }) => {
      if (stub.onMinutes) stub.onMinutes(meeting.id);
      return { minutes: "## Summary\n- Agreed the plan", oneLiner: "Agreed the plan", template: "default" };
    },
    "file-to-vault": () => ({ filed: true, note: "Inbox/meetings/earshot/Call.md", vault: "Test Vault", filedAt: "2026-11-04T12:00:00.000Z", dailyLines: ["- [[Call]]"] }),
    "suggest-company": ({ names }) => {
      for (const n of names || []) if (stub.suggest[String(n).toLowerCase()]) return stub.suggest[String(n).toLowerCase()];
      return null;
    },
    "save-screenshot": () => ({ file: "/tmp/earshot-test/screenshots/1.png" }),
  };
  window.earshotNative = {
    async call(name, payload) {
      stub.calls.push({ name, payload: clone(payload) });
      if (name === "helper") {
        const op = ops[payload.op];
        if (!op) throw new Error(`unknown op ${payload.op}`);
        const reply = await op(clone(payload.payload || {}));
        return payload.op === "get-meeting" && stub.shareEmptyReplies ? reply : clone(reply);
      }
      if (name === "screenshot") return { dataUrl: PNG, width: 1, height: 1 };
      if (name === "set-paused") {
        if (stub.refusePause) throw new Error("Nothing is being recorded.");
        return { paused: !!payload.value };
      }
      return null;
    },
  };
});

const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (err) => pageErrors.push(String(err)));
await page.goto(`${base}panel.html`);

const calls = () => page.evaluate(() => window.__stub.calls);
const helperCalls = async (op) => (await calls()).filter((c) => c.name === "helper" && c.payload.op === op);
const saves = async () => (await helperCalls("save-meeting")).map((c) => c.payload.payload.meeting);
const savedWith = (what, pred) => waitFor(async () => (await saves()).find(pred), what);
const panel = (sel) => page.locator(`earshot-overlay ${sel}`);
const shown = (sel) => panel(sel).isVisible().catch(() => false);

// A new meeting starts as the launcher; open the panel by clicking its E.
const ensureOpen = async () => {
  await waitFor(async () => (await shown(".panel")) || (await shown(".launcher")), "the launcher or the panel");
  if (!(await shown(".panel"))) await panel('.launcher [data-act="l-open"]').click();
  await waitFor(() => shown(".panel"), "the panel");
};

const t0 = Date.now() - 5 * 60000;
const cid = t0.toString(36);
const seg = (track, n, text, at, speaker = track === "mic" ? "Alex" : "Call") => ({
  id: `mac-${cid}-${track}-${n}`,
  speaker,
  speakerId: track,
  speakerResolved: true,
  startedAt: t0 + at * 1000,
  lastAt: t0 + at * 1000 + 2000,
  text,
});
const record = (id, extra = {}) => ({
  id,
  platform: "teams-desktop",
  meetingRef: null,
  title: "",
  url: null,
  startedAt: new Date(t0).toISOString(),
  endedAt: null,
  captionLanguage: null,
  participants: {},
  segments: [],
  speakerNames: {},
  notes: "",
  screenshots: [],
  titleEdited: false,
  tags: [],
  tagsAuto: true,
  chats: [],
  minutes: null,
  ...extra,
});
const MEETING_ID = "teams-desktop-mac-20261104-101500";
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

console.log("\nmac panel");

await check("a new meeting starts as the launcher (layout collapsed), and clicking E opens the panel", async () => {
  await page.evaluate((m) => window.earshotMac.start({ meeting: m, settings: { minutesDelayMinutes: 0 }, status: { level: "live", text: "Capturing" } }), record(MEETING_ID));
  await waitFor(() => shown(".launcher"), "the launcher");
  assert(!(await shown(".panel")), "the panel opened by itself");
  const first = (await calls()).filter((c) => c.name === "layout").at(-1);
  assert(first.payload.collapsed === true, JSON.stringify(first));
  await panel('.launcher [data-act="l-open"]').click();
  await waitFor(() => shown(".panel"), "the panel");
  const opened = (await calls()).filter((c) => c.name === "layout").at(-1);
  assert(opened.payload.collapsed === false, JSON.stringify(opened));
});

await check("start then segments shows the lines in the panel", async () => {
  await ensureOpen();
  await page.evaluate((list) => window.earshotMac.segments(list), [seg("mic", 1, "Thanks for joining.", 5), seg("call", 1, "Happy to be here.", 9), seg("mic", 2, "Lets go over the budget.", 14)]);
  await waitFor(async () => {
    const text = await panel(".body").innerText().catch(() => "");
    return text.includes("Thanks for joining.") && text.includes("Happy to be here.") && text.includes("Call") && text.includes("Alex") && text;
  }, "the lines in the transcript");
  // A revised live line (same id) replaces its text rather than adding a line.
  await page.evaluate((list) => window.earshotMac.segments(list), [seg("mic", 2, "Let's go over the budget.", 14)]);
  await waitFor(async () => (await panel(".body").innerText()).includes("Let's go over the budget."), "the revised line");
  assert((await panel(".block").count()) === 3, "three blocks");
});

await check("chrome.runtime.getURL resolves under the web folder and Inter loads", async () => {
  const url = await page.evaluate(() => chrome.runtime.getURL("fonts/inter-latin.woff2"));
  assert(url === `${base}fonts/inter-latin.woff2`, url);
  const faces = await page.evaluate(async () => (await document.fonts.load('14px "Earshot Inter"', "Earshot")).length);
  assert(faces > 0, "Earshot Inter did not load");
});

await check("clicking E collapses to the launcher and tells native the layout", async () => {
  const opened = (await calls()).filter((c) => c.name === "layout");
  assert(opened.length && opened.at(-1).payload.collapsed === false, `layout on open: ${JSON.stringify(opened)}`);
  await panel("header .logo").click();
  await waitFor(() => shown(".launcher"), "the launcher");
  assert(!(await shown(".panel")), "panel still shown");
  const layout = (await calls()).filter((c) => c.name === "layout").at(-1);
  assert(layout.payload.collapsed === true && layout.payload.width > 0 && layout.payload.height > 0, JSON.stringify(layout));
});

await check("dragging the launcher moves the window through native drag", async () => {
  const box = await panel(".launcher .grip").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(box.x + box.width / 2 + i * 5, box.y + box.height / 2 + i * 3);
  await page.mouse.up();
  const drags = (await calls()).filter((c) => c.name === "drag");
  const dx = drags.reduce((s, c) => s + c.payload.dx, 0);
  const dy = drags.reduce((s, c) => s + c.payload.dy, 0);
  assert(drags.length && Math.abs(dx - 30) <= 4 && Math.abs(dy - 18) <= 4, `drags ${JSON.stringify(drags)}`);
  // The launcher itself stays put in the window; the window moves.
  const after = await panel(".launcher .grip").boundingBox();
  assert(Math.abs(after.x - box.x) < 1 && Math.abs(after.y - box.y) < 1, "the launcher moved inside the window");
});

await check("the launcher's E opens the panel again", async () => {
  await sleep(50);
  await panel('.launcher [data-act="l-open"]').click();
  await waitFor(() => shown(".panel"), "the panel");
  const layout = (await calls()).filter((c) => c.name === "layout").at(-1);
  assert(layout.payload.collapsed === false, JSON.stringify(layout));
});

await check("dragging the panel by its header (even from E) moves the window and doesn't collapse it", async () => {
  const before = (await calls()).filter((c) => c.name === "drag").length;
  const box = await panel("header .logo").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 4; i++) await page.mouse.move(box.x + box.width / 2 + i * 6, box.y + box.height / 2);
  // Released back over E, so the browser's click lands on E itself.
  await page.mouse.move(box.x + box.width / 2 + 2, box.y + box.height / 2);
  await page.mouse.up();
  const drags = (await calls()).filter((c) => c.name === "drag").slice(before);
  assert(drags.length >= 4 && Math.abs(drags.reduce((s, c) => s + c.payload.dx, 0) - 2) <= 2, `drags ${JSON.stringify(drags)}`);
  await sleep(100);
  assert(await shown(".panel"), "the panel collapsed after a drag");
});

await check("typing notes saves them through helper save-meeting", async () => {
  await panel(".notes-text").click();
  await page.keyboard.type("- Budget is 40k");
  const m = await savedWith("notes saved", (m) => m.notes.includes("Budget is 40k"));
  assert(ISO.test(m.updatedAt), `updatedAt ${m.updatedAt}`);
});

await check("a text field takes the keyboard only while it has focus (native focus)", async () => {
  const focusCalls = async () => (await calls()).filter((c) => c.name === "focus").map((c) => c.payload.editing);
  assert((await focusCalls()).at(-1) === true, `after clicking the notes: ${JSON.stringify(await focusCalls())}`);
  await panel(".tabs button").first().click();
  await waitFor(async () => (await focusCalls()).at(-1) === false, "focus {editing: false} after clicking a button");
  const before = (await focusCalls()).length;
  await panel(".notes-text").click();
  await waitFor(async () => (await focusCalls()).length > before && (await focusCalls()).at(-1) === true, "focus {editing: true} again");
  // A press on the field that already has focus asks again (the window may have lost key meanwhile).
  const again = (await focusCalls()).length;
  await panel(".notes-text").click();
  await waitFor(async () => (await focusCalls()).length > again, "another focus {editing: true}");
});

await check("renaming a speaker saves the name and suggests a company", async () => {
  await panel('.name[data-speaker="call"]').click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("Idris Oduya");
  await page.keyboard.press("Enter");
  await savedWith("speaker renamed", (m) => m.speakerNames.call === "Idris Oduya" && m.segments.filter((s) => s.speakerId === "call").every((s) => s.speaker === "Idris Oduya"));
  const asked = await waitFor(async () => (await helperCalls("suggest-company")).find((c) => c.payload.payload.names.includes("Idris Oduya")), "suggest-company");
  assert(!asked.payload.payload.names.includes("Alex"), "my own name was looked up");
  const row = await waitFor(async () => (await shown(".suggest")) && (await panel(".suggest").innerText()), "the suggestion row");
  assert(/Globex\? \(from Idris Oduya\)/.test(row), row);
  await savedWith("suggestion saved", (m) => m.tagSuggestion?.tag === "Globex" && m.tagSuggestion?.person === "Idris Oduya");
});

await check("Use sets the tag and the suggestion row goes", async () => {
  await panel('.suggest [data-act="use-suggestion"]').click();
  await savedWith("tags set", (m) => JSON.stringify(m.tags) === '["Globex"]' && m.tagsAuto === false);
  await waitFor(async () => !(await shown(".suggest")), "the row to go");
  assert((await panel(".chips").innerText()).includes("Globex"), "chip");
});

await check("tagging a line saves the tag and the notes line", async () => {
  const block = panel(`.block[data-id="mac-${cid}-call-1"]`);
  await block.hover();
  await block.locator(".tagopen").click();
  await block.locator('[data-reaction="todo"]').click();
  await savedWith("line tagged", (m) => m.segments.find((s) => s.id === `mac-${cid}-call-1`)?.reaction === "todo" && m.notes.includes("Happy to be here. #todo"));
});

await check("editing a line saves the new text", async () => {
  const block = panel(`.block[data-id="mac-${cid}-mic-1"]`);
  await block.click({ position: { x: 4, y: 6 } });
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("Thanks for joining, everyone.");
  await page.keyboard.press("Enter");
  await savedWith("line edited", (m) => {
    const s = m.segments.find((x) => x.id === `mac-${cid}-mic-1`);
    return s?.text === "Thanks for joining, everyone." && s.edited === true;
  });
});

await check("Ask AI goes to helper ask and shows the answer", async () => {
  await panel('.tabs [data-tab="ask"]').click();
  await panel(".askinput").fill("What was decided?");
  await page.keyboard.press("Enter");
  const asked = await waitFor(async () => (await helperCalls("ask"))[0], "helper ask");
  assert(asked.payload.payload.question === "What was decided?" && asked.payload.payload.meeting.id === MEETING_ID, JSON.stringify(asked.payload.payload).slice(0, 200));
  await waitFor(async () => (await panel(".chat").innerText()).includes("Answer to What was decided?"), "the answer");
  await savedWith("chat saved", (m) => m.chats.length === 1 && m.chats[0].model === "fake-model");
  await panel('.tabs [data-tab="transcript"]').click();
});

await check("Screenshot takes the native screenshot and saves it through the helper", async () => {
  await panel('footer [data-act="screenshot"]').click();
  const saved = await waitFor(async () => (await helperCalls("save-screenshot"))[0], "save-screenshot");
  assert(saved.payload.payload.dataUrl.startsWith("data:image/png"), "image");
  assert((await calls()).some((c) => c.name === "screenshot"), "native screenshot");
  await savedWith("screenshot listed", (m) => m.screenshots.length === 1 && m.screenshots[0].id === saved.payload.payload.shot.id);
  await waitFor(async () => (await panel(".shot img").getAttribute("src"))?.startsWith("data:image/png"), "the screenshot in the transcript");
});

await check("pause goes to native set-paused", async () => {
  await panel('header [data-act="pause"]').click();
  await waitFor(async () => (await calls()).some((c) => c.name === "set-paused" && c.payload.value === true), "set-paused");
  await waitFor(async () => (await panel(".status").innerText()).startsWith("Paused"), "paused status");
  await panel('header [data-act="pause"]').click();
  await waitFor(async () => (await panel(".status").innerText()) === "Capturing", "capturing again");
});

await check("the Stop button goes to native stop; the browser-only Don't-record button is hidden here", async () => {
  assert(!(await panel('header [data-act="discard"]').isVisible()), "Don't-record button shows in the Mac panel");
  await panel('header [data-act="stop"]').click();
  await waitFor(async () => (await calls()).some((c) => c.name === "stop"), "native stop");
});

const disk = (id) => page.evaluate((x) => window.__stub.disks[x], id);
const pauseTitle = () => panel('header [data-act="pause"]').getAttribute("title");

await check("the menu's pause flips the panel's button and status (native setPaused)", async () => {
  const before = (await calls()).filter((c) => c.name === "set-paused").length;
  await page.evaluate(() => window.earshotMac.setPaused(true));
  await waitFor(async () => (await pauseTitle()) === "Resume capture", "the play button");
  await waitFor(async () => (await panel(".status").innerText()).startsWith("Paused"), "paused status");
  await page.evaluate(() => window.earshotMac.setPaused(false));
  await waitFor(async () => (await pauseTitle()) === "Pause capture", "the pause button");
  await waitFor(async () => (await panel(".status").innerText()) === "Capturing", "capturing again");
  // Native already paused: the page doesn't ask it again.
  assert((await calls()).filter((c) => c.name === "set-paused").length === before, "setPaused called native set-paused");
});

await check("a pause native refuses leaves the panel capturing", async () => {
  await page.evaluate(() => (window.__stub.refusePause = true));
  await panel('header [data-act="pause"]').click();
  await waitFor(async () => (await calls()).filter((c) => c.name === "set-paused").at(-1)?.payload.value === true, "set-paused asked");
  await sleep(300);
  assert((await pauseTitle()) === "Pause capture", "the button shows paused");
  assert((await panel(".status").innerText()) === "Capturing", `status ${await panel(".status").innerText()}`);
  await page.evaluate(() => (window.__stub.refusePause = false));
});

await check("renameSpeaker names the mic once, and never over a name you gave it", async () => {
  await page.evaluate(() => window.earshotMac.renameSpeaker({ speakerId: "mic", name: "Alex" }));
  await savedWith("the mic named", (m) => m.id === MEETING_ID && m.speakerNames.mic === "Alex");
  await page.evaluate(() => window.earshotMac.renameSpeaker({ speakerId: "mic", name: "Someone else" }));
  await sleep(1300);
  assert((await disk(MEETING_ID)).speakerNames.mic === "Alex", "an existing name was replaced");
  assert(!(await panel(".body").innerText()).includes("Someone else"), "the panel shows the replaced name");
});

await check("ending after the Whisper pass writes minutes, then files; notes edited on disk meanwhile survive", async () => {
  const before = (await saves()).at(-1);
  const whisper = [
    seg("mic", 1, "Thanks for joining everyone.", 5),
    seg("call", 1, "Happy to be here.", 9, "Call"),
    seg("mic", 2, "Let's go over the budget.", 14),
    seg("call", 2, "The budget is forty thousand.", 20, "Call"),
    seg("mic", 3, "Agreed, ship on Friday.", 26),
    seg("call", 3, "Sounds good.", 31, "Call"),
  ];
  await page.evaluate(() => {
    // The meetings page edits the notes on disk while the minutes are written.
    window.__stub.onMinutes = (id) => {
      window.__stub.editOnDisk(id, { notes: `${window.__stub.disks[id].notes}\n- Added on the meetings page` });
    };
  });
  const callsBefore = (await calls()).length;
  await page.evaluate((list) => window.earshotMac.replaceSegments(list), whisper);
  await page.evaluate(() => window.earshotMac.ended());
  const filedSave = await savedWith("filing saved", (m) => m.vaultNote === "Inbox/meetings/earshot/Call.md");
  const after = (await calls()).slice(callsBefore).filter((c) => c.name === "helper").map((c) => c.payload.op);
  const iMinutes = after.indexOf("minutes");
  const iFile = after.indexOf("file-to-vault");
  assert(iMinutes >= 0 && iFile > iMinutes, `helper order ${after.join(", ")}`);
  const ended = (await saves()).find((m) => m.endedAt);
  assert(ended && ended.segments.length === 6, "ended save carries the Whisper lines");
  assert(ended.segments.filter((s) => s.speakerId === "call").every((s) => s.speaker === "Idris Oduya"), "renamed speaker kept for the Whisper lines");
  const minutesCall = (await helperCalls("minutes")).at(-1).payload.payload.meeting;
  assert(minutesCall.segments.some((s) => s.text === "The budget is forty thousand."), "minutes from the Whisper text");
  const disk = await page.evaluate((id) => window.__stub.disks[id], MEETING_ID);
  assert(disk.minutes === "## Summary\n- Agreed the plan" && disk.oneLiner === "Agreed the plan" && disk.minutesTemplate === "default" && ISO.test(disk.minutesAt), "minutes fields");
  assert(disk.filedAt === "2026-11-04T12:00:00.000Z" && disk.vaultName === "Test Vault" && disk.lastFiling?.filed === true && disk.vaultDailyLines?.length === 1, "vault fields");
  assert(disk.notes === `${before.notes}\n- Added on the meetings page`, `notes: ${JSON.stringify(disk.notes)}`);
  assert(JSON.stringify(disk.tags) === JSON.stringify(before.tags), "tags changed");
  assert(disk.title === before.title, "title changed");
  assert(JSON.stringify(disk.chats) === JSON.stringify(before.chats), "chats changed");
  assert(ISO.test(disk.updatedAt) && filedSave.updatedAt === disk.updatedAt, "updatedAt");
  for (const m of await saves()) assert(ISO.test(m.updatedAt), `a save without an ISO updatedAt: ${m.updatedAt}`);
});

await check("after the meeting ends the panel goes and tells native to hide the window", async () => {
  await waitFor(async () => (await calls()).filter((c) => c.name === "layout").at(-1)?.payload.hidden === true, "layout {hidden: true}", 8000);
  assert(!(await page.locator("earshot-overlay").count()), "the panel is still mounted");
});

const SECOND_ID = "zoom-desktop-mac-20261104-120000";
const stales = () => page.evaluate(() => window.__stub.stales);

await check("a second meeting in the same panel: suggestion from a known name, and × dismisses it for good", async () => {
  await page.evaluate((m) => window.earshotMac.start({ meeting: m, settings: { minutesDelayMinutes: 0 }, status: { level: "live", text: "Capturing" } }), record(SECOND_ID, { platform: "zoom-desktop", speakerNames: { call: "Idris Oduya" } }));
  await ensureOpen();
  await page.evaluate((list) => window.earshotMac.segments(list), [seg("call", 1, "Hello again.", 3, "Idris Oduya")]);
  await waitFor(async () => (await panel(".body").innerText()).includes("Hello again."), "the new meeting's line");
  assert(!(await panel(".body").innerText()).includes("Happy to be here."), "old meeting's lines still shown");
  await waitFor(async () => (await shown(".suggest")) && (await panel(".suggest").innerText()).includes("Globex? (from Idris Oduya)"), "the suggestion row");
  await panel('.suggest [data-act="dismiss-suggestion"]').click();
  await waitFor(async () => !(await shown(".suggest")), "the row to go");
  await savedWith("suggestion cleared", (m) => m.id === SECOND_ID && !m.tagSuggestion && m.tags.length === 0 && JSON.stringify(m.tagSuggestionDismissed) === '["Globex"]');
  // Renaming the speaker again finds the same company: not suggested again.
  await panel('.name[data-speaker="call"]').click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("Thea Oduya");
  await page.keyboard.press("Enter");
  await waitFor(async () => (await helperCalls("suggest-company")).some((c) => c.payload.payload.names.includes("Thea Oduya")), "suggest-company for the new name");
  await sleep(400);
  assert(!(await shown(".suggest")), "a dismissed company came back");
});

await check("the meetings page edits notes mid-call, then a live line arrives: disk keeps both", async () => {
  await savedWith("the rename saved", (m) => m.id === SECOND_ID && m.speakerNames.call === "Thea Oduya");
  await sleep(1200); // nothing left to save
  const stalesBefore = await stales();
  // The page's edit carries an earlier stamp than the panel's next save will: only the base can tell.
  await page.evaluate((id) => window.__stub.editOnDisk(id, { notes: "Written by the meetings page" }), SECOND_ID);
  await page.evaluate((list) => window.earshotMac.segments(list), [seg("call", 2, "One more thing.", 8, "Idris Oduya")]);
  await waitFor(async () => {
    const d = await disk(SECOND_ID);
    return d.notes === "Written by the meetings page" && d.segments.some((s) => s.text === "One more thing." && s.speaker === "Thea Oduya") && d;
  }, "the page's notes and the new line on disk");
  assert((await stales()) > stalesBefore, "the save wasn't refused first");
  await waitFor(async () => (await panel(".notes-text").inputValue()) === "Written by the meetings page", "the disk notes in the panel");
  assert((await panel(".body").innerText()).includes("One more thing."), "the new line was dropped from the panel");
});

await check("a stale reply while ending still leaves endedAt and the latest chat on disk", async () => {
  await panel('.tabs [data-tab="ask"]').click();
  await panel(".askinput").fill("Who owns the budget?");
  await page.keyboard.press("Enter");
  await waitFor(async () => (await panel(".chat").innerText()).includes("Answer to Who owns the budget?"), "the answer");
  const stalesBefore = await stales();
  // In one go, before the chat's save: the page edits the file, and the call ends.
  const chatAlreadyOnDisk = await page.evaluate((id) => {
    const had = window.__stub.disks[id].chats.some((c) => c.question === "Who owns the budget?");
    window.__stub.editOnDisk(id, { notes: "Edited again on the page" });
    window.earshotMac.ended();
    return had;
  }, SECOND_ID);
  assert(!chatAlreadyOnDisk, "the chat was saved before the end, so this didn't test the stale path");
  const d = await waitFor(async () => {
    const x = await disk(SECOND_ID);
    return x.endedAt && x.chats.some((c) => c.question === "Who owns the budget?") && x;
  }, "endedAt and the chat on disk");
  assert(d.notes === "Edited again on the page", `notes ${d.notes}`);
  assert((await stales()) > stalesBefore, "no stale reply happened");
  await panel('.tabs [data-tab="transcript"]').click().catch(() => {});
});

await check("a restart with the same id takes the saved copy: notes, chats and a dismissal stay", async () => {
  const id = "teams-desktop-mac-20261104-140000";
  await page.evaluate((m) => window.earshotMac.start({ meeting: m, settings: { minutesDelayMinutes: 0 }, status: { level: "live", text: "Capturing" } }), record(id, { speakerNames: { call: "Idris Oduya" } }));
  await ensureOpen();
  await page.evaluate((list) => window.earshotMac.segments(list), [seg("call", 1, "Before the restart.", 3, "Idris Oduya")]);
  await waitFor(async () => (await shown(".suggest")) && (await panel(".suggest").innerText()).includes("Globex?"), "the suggestion row");
  await panel('.suggest [data-act="dismiss-suggestion"]').click();
  await panel(".notes-text").click();
  await page.keyboard.type("- Notes before the restart");
  await panel('.tabs [data-tab="ask"]').click();
  await panel(".askinput").fill("Anything decided?");
  await page.keyboard.press("Enter");
  await waitFor(async () => {
    const d = await disk(id);
    return d && d.notes.includes("Notes before the restart") && d.chats.length === 1 && d.tagSuggestionDismissed?.includes("Globex") && d;
  }, "notes, chat and dismissal saved");
  // The app restarts; native starts the same meeting from its bare record.
  await page.reload();
  await page.evaluate((m) => window.earshotMac.start({ meeting: m, settings: { minutesDelayMinutes: 0 }, status: { level: "live", text: "Capturing" } }), record(id, { speakerNames: { call: "Idris Oduya" } }));
  await ensureOpen();
  await waitFor(async () => (await panel(".notes-text").inputValue().catch(() => "")).includes("Notes before the restart"), "the saved notes in the panel");
  assert((await panel(".body").innerText()).includes("Before the restart."), "the saved line is missing");
  await page.evaluate((list) => window.earshotMac.segments(list), [seg("call", 2, "After the restart.", 9, "Idris Oduya")]);
  const d = await waitFor(async () => {
    const x = await disk(id);
    return x.segments.some((s) => s.text === "After the restart.") && x;
  }, "the new line saved");
  assert(d.notes.includes("Notes before the restart") && d.chats.length === 1 && d.chats[0].question === "Anything decided?", "notes or chat lost");
  await sleep(400);
  assert(!(await shown(".suggest")), "the dismissed suggestion came back after the restart");
});

const THIRD_ID = "teams-desktop-mac-20261104-140000";
const unsaved = () => page.evaluate(async () => (await chrome.runtime.sendMessage({ kind: "diagnostics" })).unsaved);
const tagLines = (notes, text, tag) => notes.split("\n").filter((l) => l.includes(text) && l.endsWith(`#${tag}`)).length;
async function tagLine(n, reaction) {
  const block = panel(`.block[data-id="mac-${cid}-call-${n}"]`);
  await block.hover();
  await block.locator(".tagopen").click();
  await block.locator(`[data-reaction="${reaction}"]`).click();
}

await check("a save that wrote the file and then errored counts as landed: a line's tag survives", async () => {
  await sleep(1200); // nothing left to save
  const stalesBefore = await stales();
  await page.evaluate(() => (window.__stub.failAfterWrite = 1));
  await tagLine(1, "todo");
  await waitFor(async () => (await page.evaluate(() => window.__stub.failAfterWrite)) === 0, "the failing save");
  await waitFor(async () => (await unsaved()) === 0, "the log emptied without a retry");
  await sleep(1300);
  const d = await disk(THIRD_ID);
  assert(d.segments.find((x) => x.id === `mac-${cid}-call-1`)?.reaction === "todo", "the tag was lost");
  assert(tagLines(d.notes, "Before the restart.", "todo") === 1, `notes: ${d.notes}`);
  assert((await stales()) === stalesBefore, "it went stale against its own write");
});

await check("if that can't be confirmed, the retry redoes a line's tag as a state, not a toggle", async () => {
  const stalesBefore = await stales();
  // The write lands and errors, and the check read fails too: the save is retried in 5 s, finds its own write, and redoes the log.
  await page.evaluate(() => {
    window.__stub.failAfterWrite = 1;
    window.__stub.failGet = 1;
  });
  await tagLine(2, "followup");
  await waitFor(async () => (await stales()) > stalesBefore && (await unsaved()) === 0, "the retry after the stale reply", 12000);
  const d = await disk(THIRD_ID);
  assert(d.segments.find((x) => x.id === `mac-${cid}-call-2`)?.reaction === "followup", "the redone tag was toggled off");
  assert(tagLines(d.notes, "After the restart.", "followup") === 1, `notes: ${d.notes}`);
  assert(d.segments.find((x) => x.id === `mac-${cid}-call-1`)?.reaction === "todo", "the earlier tag changed");
  assert(tagLines(d.notes, "Before the restart.", "todo") === 1, `notes: ${d.notes}`);
  await waitFor(async () => (await panel(`.block[data-id="mac-${cid}-call-2"] .badge`).innerText().catch(() => "")) === "#followup", "the tag in the panel");
});

// ---------------------------------------------------------------- finish: endings that aren't on show

const lines = (capture, n, from = 0) => Array.from({ length: n }, (_, i) => ({ ...seg("mic", i + 1, `Line ${i + 1}`, from + i * 5), id: `mac-${capture}-mic-${i + 1}` }));
const putDisk = (m) => page.evaluate((x) => { window.__stub.disks[x.id] = x; window.__stub.persist(); }, m);
const minutesFor = async (id) => (await helperCalls("minutes")).filter((c) => c.payload.payload.meeting.id === id);
const bodyText = () => panel(".body").innerText().catch(() => "");

await check("finish ends a recovered capture off screen: Whisper lines, endedAt, then minutes and filing when due", async () => {
  const id = "teams-desktop-mac-20261104-160000";
  await putDisk({ ...record(id), segments: lines("live1", 6), updatedAt: new Date(t0).toISOString() });
  const endedAt = new Date(Date.now() - 10 * 60000).toISOString(); // the delay (5 min) has passed
  const whisper = lines("live1", 6).map((s) => ({ ...s, text: `${s.text}, from Whisper.` }));
  const shownBefore = await bodyText();
  await page.evaluate((a) => window.earshotMac.finish(a), { meeting: await disk(id), segments: whisper, endedAt, rename: { speakerId: "mic", name: "Alex" } });
  const d = await waitFor(async () => {
    const x = await disk(id);
    return x.vaultNote && x;
  }, "minutes and filing on disk", 8000);
  assert(d.endedAt === endedAt, `endedAt ${d.endedAt}`);
  assert(d.segments.length === 6 && d.segments.every((s) => s.text.endsWith("from Whisper.")), "the Whisper lines");
  assert(d.speakerNames.mic === "Alex", "the mic wasn't named");
  assert(d.minutes === "## Summary\n- Agreed the plan" && ISO.test(d.minutesAt) && ISO.test(d.updatedAt), "minutes");
  assert((await minutesFor(id)).length === 1, "minutes written more than once");
  assert((await bodyText()) === shownBefore, "the panel changed for a meeting that isn't on show");
});

await check("finish for a meeting that already has minutes writes none", async () => {
  const id = "zoom-desktop-mac-20261104-161000";
  await putDisk({ ...record(id, { platform: "zoom-desktop" }), segments: lines("live2", 6), endedAt: new Date(Date.now() - 3600000).toISOString(), minutes: "## Done", updatedAt: new Date(t0).toISOString() });
  await page.evaluate(async (id) => window.earshotMac.finish({ meeting: window.__stub.disks[id] }), id);
  await sleep(500);
  assert(!(await minutesFor(id)).length, "minutes written again");
  assert((await disk(id)).minutes === "## Done", "minutes changed");
});

await check("finish for a meeting whose minutes were waiting writes them when the rest of the delay is up", async () => {
  const id = "mac-mac-20261104-162000";
  const endedAt = new Date(Date.now() - 5 * 60000 + 2500).toISOString(); // due in 2.5 s
  await putDisk({ ...record(id, { platform: "mac" }), segments: lines("live3", 6), endedAt, updatedAt: new Date(t0).toISOString() });
  await page.evaluate(async (id) => window.earshotMac.finish({ meeting: window.__stub.disks[id] }), id);
  await sleep(800);
  assert(!(await minutesFor(id)).length, "minutes written before they were due");
  await waitFor(async () => (await minutesFor(id)).length === 1, "minutes when due", 6000);
  const d = await waitFor(async () => {
    const x = await disk(id);
    return x.minutes && x;
  }, "minutes on disk");
  assert(d.endedAt === endedAt, "endedAt changed");
});

await check("finish keeps a name you gave the mic", async () => {
  const id = "mac-mac-20261104-163000";
  await putDisk({ ...record(id, { platform: "mac", speakerNames: { mic: "Pat" } }), segments: lines("live4", 2), updatedAt: new Date(t0).toISOString() });
  await page.evaluate(async (id) => window.earshotMac.finish({ meeting: window.__stub.disks[id], rename: { speakerId: "mic", name: "Alex" } }), id);
  const d = await waitFor(async () => {
    const x = await disk(id);
    return x.endedAt && x;
  }, "endedAt on disk");
  assert(d.speakerNames.mic === "Pat", `mic ${d.speakerNames.mic}`);
  assert(ISO.test(d.endedAt), "endedAt");
  await sleep(300);
  assert(!(await minutesFor(id)).length, "minutes for a 2-line meeting");
});

// ---------------------------------------------------------------- back to back: one written up while the next is live

const A_ID = "teams-desktop-mac-20261104-170000";
const B_ID = "mac-mac-20261104-171000";

await check("a status for a meeting no longer on show is ignored", async () => {
  const before = await panel(".status").innerText();
  await page.evaluate((id) => window.earshotMac.status({ level: "waiting", text: "Writing the full transcript…", meetingId: id }), "some-other-meeting");
  await sleep(300);
  assert((await panel(".status").innerText()) === before, `status ${await panel(".status").innerText()}`);
  await page.evaluate((id) => window.earshotMac.status({ level: "waiting", text: "Writing the full transcript…", meetingId: id }), THIRD_ID);
  await waitFor(async () => (await panel(".status").innerText()) === "Writing the full transcript…", "the meeting's own status");
});

await check("finish by id lands on the meeting written up while the next one is on show", async () => {
  await page.evaluate((m) => window.earshotMac.start({ meeting: m, status: { level: "live", text: "Capturing" } }), record(A_ID));
  await ensureOpen();
  await page.evaluate((list) => window.earshotMac.segments(list), lines("cA", 6));
  await savedWith("A's live lines", (m) => m.id === A_ID && m.segments.length === 6);
  // A stops; B starts at once; A's Whisper pass finishes afterwards.
  await page.evaluate((m) => window.earshotMac.start({ meeting: m, status: { level: "live", text: "Capturing" } }), record(B_ID, { platform: "mac" }));
  await ensureOpen();
  await page.evaluate((list) => window.earshotMac.segments(list), [{ ...seg("mic", 1, "B is live", 400), id: "mac-cB-mic-1" }]);
  await waitFor(async () => (await bodyText()).includes("B is live"), "B's line on show");
  await savedWith("B's live line", (m) => m.id === B_ID && m.segments.length === 1);
  await page.evaluate((id) => window.earshotMac.status({ level: "waiting", text: "Writing the full transcript…", meetingId: id }), A_ID);
  const whisper = lines("cA", 6).map((x) => ({ ...x, text: `${x.text}, A from Whisper.` }));
  const endedAt = new Date(Date.now() - 10 * 60000).toISOString();
  await page.evaluate((a) => window.earshotMac.finish(a), { meeting: record(A_ID), segments: whisper, endedAt, rename: null });
  const a = await waitFor(async () => {
    const x = await disk(A_ID);
    return x.endedAt && x.vaultNote && x;
  }, "A ended, with minutes", 8000);
  assert(a.endedAt === endedAt && a.segments.every((x) => x.text.endsWith("A from Whisper.")), "A's lines or end");
  await sleep(1200); // any save of B the finish might have caused
  const b = await disk(B_ID);
  assert(!b.endedAt && b.segments.length === 1 && !b.segments.some((x) => x.id.startsWith("mac-cA-")), "B got A's lines or end");
  const text = await bodyText();
  assert(text.includes("B is live") && !text.includes("A from Whisper"), "the panel shows A's lines");
  assert((await panel(".status").innerText()) === "Capturing", `B's status: ${await panel(".status").innerText()}`);
});

await check("finish on the meeting on show ends its panel, and the page says idle when nothing is left", async () => {
  const idles = async () => (await calls()).filter((c) => c.name === "idle").length;
  const before = await idles();
  await page.evaluate((id) => window.earshotMac.finish({ meeting: { id }, segments: null, endedAt: null, rename: null }), B_ID);
  await waitFor(async () => (await panel(".status").innerText().catch(() => "")).startsWith("Meeting ended"), "the ended panel");
  const b = await waitFor(async () => {
    const x = await disk(B_ID);
    return x.endedAt && x;
  }, "B's endedAt");
  assert(ISO.test(b.endedAt), "endedAt");
  await waitFor(async () => (await calls()).filter((c) => c.name === "layout").at(-1)?.payload.hidden === true, "the window hidden", 8000);
  await waitFor(async () => (await idles()) > before, "native idle");
});

await check("finish rejects when the meeting couldn't be saved, so native keeps it for later", async () => {
  const id = "teams-desktop-mac-20261104-180000";
  await putDisk({ ...record(id), segments: lines("cF", 2), updatedAt: new Date(t0).toISOString() });
  await page.evaluate(() => (window.__stub.failSave = 50));
  const outcome = await page.evaluate(async (id) => {
    try {
      await window.earshotMac.finish({ meeting: window.__stub.disks[id], endedAt: new Date().toISOString() });
      return "resolved";
    } catch (err) {
      return `rejected: ${err.message}`;
    }
  }, id);
  await page.evaluate(() => (window.__stub.failSave = 0));
  assert(outcome.startsWith("rejected") && outcome.includes("helper unreachable"), outcome);
  assert(!(await disk(id)).endedAt, "endedAt on disk although the save failed");
  // The page's own retry saves it later.
  await waitFor(async () => (await disk(id)).endedAt, "the retry's save", 8000);
});

await check("live lines addressed to another meeting don't land on the one on show", async () => {
  const id = "mac-mac-20261104-181000";
  await page.evaluate((m) => window.earshotMac.start({ meeting: m, status: { level: "live", text: "Capturing" } }), record(id, { platform: "mac" }));
  await ensureOpen();
  await page.evaluate((a) => window.earshotMac.segments({ meetingId: a.id, segments: a.list }), { id, list: [{ ...seg("mic", 1, "Mine", 500), id: "mac-cC-mic-1" }] });
  await waitFor(async () => (await bodyText()).includes("Mine"), "the meeting's own line");
  await page.evaluate((list) => window.earshotMac.segments({ meetingId: "teams-desktop-mac-20261104-170000", segments: list }), [{ ...seg("mic", 9, "Not mine", 501), id: "mac-cA-mic-9" }]);
  await sleep(1300);
  assert(!(await bodyText()).includes("Not mine"), "another meeting's line on show");
  assert(!(await disk(id)).segments.some((x) => x.text === "Not mine"), "another meeting's line saved here");
  assert(!(await disk("teams-desktop-mac-20261104-170000")).segments.some((x) => x.text === "Not mine"), "a live line reached a meeting not on show");
});

await check("isIdle answers whether anything is on show or pending", async () => {
  assert((await page.evaluate(() => window.earshotMac.isIdle())) === false, "idle with a live meeting on show");
});

// ---------------------------------------------------------------- finish retried, edited, re-run

const startShown = async (id, n) => {
  await page.evaluate((m) => window.earshotMac.start({ meeting: m, status: { level: "live", text: "Capturing" } }), record(id, { platform: "mac" }));
  await ensureOpen();
  await page.evaluate((list) => window.earshotMac.segments(list), lines(id.slice(-4), n));
  await savedWith(`${id} saved`, (m) => m.id === id && m.segments.length === n);
};

await check("a finish that failed after ending the meeting, then succeeds, still ends the panel on show", async () => {
  const id = "mac-mac-20261104-190000";
  await startShown(id, 2);
  await page.evaluate((id) => window.earshotMac.status({ level: "waiting", text: "Writing the full transcript…", meetingId: id }), id);
  await page.evaluate(() => (window.__stub.failSave = 50));
  const first = await page.evaluate((id) => window.earshotMac.finish({ meeting: { id }, endedAt: new Date().toISOString() }).then(() => "resolved", (e) => `rejected: ${e.message}`), id);
  await page.evaluate(() => (window.__stub.failSave = 0));
  assert(first.startsWith("rejected"), first);
  const second = await page.evaluate((id) => window.earshotMac.finish({ meeting: { id }, endedAt: new Date().toISOString() }).then(() => "resolved", (e) => `rejected: ${e.message}`), id);
  assert(second === "resolved", second);
  await waitFor(async () => (await panel(".status").innerText().catch(() => "")).startsWith("Meeting ended"), "the ended panel");
  await waitFor(async () => (await calls()).filter((c) => c.name === "layout").at(-1)?.payload.hidden === true, "the window hidden", 8000);
});

await check("an edit made while finish saves doesn't make finish fail", async () => {
  const id = "mac-mac-20261104-191000";
  await startShown(id, 2);
  // While the finish's save is on its way, Alex types a note.
  await page.evaluate((id) => {
    window.__stub.onSave = async (m) => {
      if (m.id !== id || !m.endedAt) return;
      window.__stub.onSave = null;
      await chrome.runtime.sendMessage({ kind: "meeting-action", action: "notes", text: "- typed during the save" });
      await new Promise((r) => setTimeout(r, 50));
    };
  }, id);
  const outcome = await page.evaluate((id) => window.earshotMac.finish({ meeting: { id }, endedAt: new Date().toISOString() }).then(() => "resolved", (e) => `rejected: ${e.message}`), id);
  assert(outcome === "resolved", outcome);
  await waitFor(async () => (await disk(id)).notes === "- typed during the save", "the note saved after", 6000);
  assert((await disk(id)).endedAt, "endedAt");
});

await check("finish skips Whisper lines for a capture whose Whisper pass already landed", async () => {
  const id = "teams-desktop-mac-20261104-192000";
  await putDisk({ ...record(id), segments: lines("cW", 2), updatedAt: new Date(t0).toISOString() });
  const whisper = lines("cW", 2).map((x) => ({ ...x, text: `${x.text}, Whisper.` }));
  await page.evaluate((a) => window.earshotMac.finish(a), { meeting: { id }, segments: whisper, endedAt: null, rename: null });
  let d = await disk(id);
  assert(JSON.stringify(d.macWhisperDone) === '["cW"]' && d.segments.every((x) => x.text.endsWith("Whisper.")), "the first pass");
  // Alex fixes a line on the meetings page; then a re-run (after a late save) brings the same capture again.
  await page.evaluate((id) => window.__stub.editOnDisk(id, { segments: window.__stub.disks[id].segments.map((x, i) => (i === 0 ? { ...x, text: "Fixed by hand.", edited: true } : x)) }), id);
  await page.evaluate((a) => window.earshotMac.finish(a), { meeting: { id }, segments: whisper.map((x) => ({ ...x, text: "Whisper again." })), endedAt: null, rename: null });
  d = await disk(id);
  assert(d.segments[0].text === "Fixed by hand." && !d.segments.some((x) => x.text === "Whisper again."), `segments ${JSON.stringify(d.segments.map((x) => x.text))}`);
  assert(d.endedAt, "endedAt");
});

await check("a manual recording: live lines never end up in the meeting's tags", async () => {
  const id = "mac-mac-tagsbug";
  // Swift's new record uses one empty-array object for every empty list, and WebKit hands the page one
  // JS array for all of them: segments, tags, refs, chats and screenshots are the same array.
  await page.evaluate((m) => {
    const shared = [];
    const both = {};
    Object.assign(m, { segments: shared, tags: shared, refs: shared, chats: shared, screenshots: shared, participants: both, speakerNames: both });
    return window.earshotMac.start({ meeting: m, settings: { minutesDelayMinutes: 0 }, status: { level: "live", text: "Capturing" } });
  }, record(id, { platform: "mac" }));
  for (let i = 1; i <= 6; i++) {
    await page.evaluate((a) => window.earshotMac.segments(a), { meetingId: id, segments: [seg("mic", i, "To see if ".repeat(i).trim(), 10 + i, "Speaker")] });
    await sleep(150);
  }
  await sleep(2500);
  const live = await disk(id);
  const chips = await panel(".chips").innerText().catch(() => "");
  assert(!chips.includes("object"), `chips: ${chips}`);
  assert((live?.tags || []).every((t) => typeof t === "string"), `tags while live: ${JSON.stringify(live?.tags).slice(0, 300)}`);
});

await check("a record read back from disk with shared empty lists keeps live lines out of its tags", async () => {
  const id = "mac-shared-reply-1";
  // Swift saved the new record before the panel was told; the panel reads it back through WebKit.
  await page.evaluate((m) => {
    window.__stub.disks[m.id] = m;
    window.__stub.shareEmptyReplies = true;
  }, record(id, { platform: "mac" }));
  try {
    await page.evaluate((m) => window.earshotMac.start({ meeting: m, settings: { minutesDelayMinutes: 0 }, status: { level: "live", text: "Capturing" } }), record(id, { platform: "mac" }));
    for (let i = 1; i <= 4; i++) {
      await page.evaluate((a) => window.earshotMac.segments(a), { meetingId: id, segments: [seg("mic", i, `Line ${i}`, 10 + i, "Speaker")] });
      await sleep(100);
    }
    await sleep(500);
    const chips = await panel(".chips").innerText().catch(() => "");
    assert(!chips.includes("object"), `chips: ${chips}`);
  } finally {
    await page.evaluate(() => (window.__stub.shareEmptyReplies = false));
  }
});

await check("no page errors", async () => {
  assert(!pageErrors.length, pageErrors.join("\n"));
});

await browser.close();
server.close();
await rm(webDir, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
