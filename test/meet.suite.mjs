// Google Meet suite, plus the panel features (rename, edit, highlight, notes,
// screenshots, pause, language, docking, auto-close) exercised on Meet.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, renameSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fixture, sleep, waitFor, overlayText, menuDownload } from "./harness.mjs";

const REF = "abc-defg-hij";

// Minimal protobuf reader/writer for building and checking Meet messages.
function pb(entries) {
  const out = [];
  const varint = (v) => {
    v = BigInt(v);
    do {
      let b = Number(v & 0x7fn);
      v >>= 7n;
      if (v) b |= 0x80;
      out.push(b);
    } while (v);
  };
  for (const [field, value] of entries) {
    if (typeof value === "number" || typeof value === "bigint") {
      varint((field << 3) | 0);
      varint(value);
    } else {
      const body = Array.isArray(value) ? pb(value) : Buffer.from(value);
      varint((field << 3) | 2);
      varint(body.length);
      out.push(...body);
    }
  }
  return Uint8Array.from(out);
}
function read(bytes) {
  const fields = {};
  let pos = 0;
  const varint = () => {
    let r = 0n;
    let s = 0n;
    for (;;) {
      const b = bytes[pos++];
      r |= BigInt(b & 0x7f) << s;
      if (!(b & 0x80)) return r;
      s += 7n;
    }
  };
  while (pos < bytes.length) {
    const key = Number(varint());
    const f = key >>> 3;
    const w = key & 7;
    let v;
    if (w === 0) v = Number(varint());
    else {
      const len = Number(varint());
      v = bytes.slice(pos, pos + len);
      pos += len;
    }
    (fields[f] ||= []).push(v);
  }
  return fields;
}
const at = (fields, ...path) => path.reduce((f, n) => (f && f[n] ? (f[n][0] instanceof Uint8Array ? read(f[n][0]) : f[n][0]) : undefined), fields);
const text = (fields, n) => Buffer.from(fields[n][0]).toString();

// SyncMeetingSpaceCollections answer: base64 of {2: {2: {2: device, 2: device, ...}}}
const SYNC_BODY = Buffer.from(
  pb([[2, [[2, [
    [2, [[1, "spaces/sp1/devices/dev-me"], [2, "Alex Kestrel"]]],
    [2, [[1, "spaces/sp1/devices/dev-jordan"], [2, "Jordan Lee"]]],
    [2, [[1, "spaces/sp1/devices/dev-priya"], [2, "Priya Nair"]]],
  ]]]]])
).toString("base64");

export async function meetSuite({ context, worker, storage, check, meetings, earshotHome, vaultPath }) {
  await context.route(/^https:\/\/meet\.google\.com\//, (route) => {
    const url = route.request().url();
    if (url.includes("SyncMeetingSpaceCollections")) return route.fulfill({ status: 200, contentType: "application/x-protobuf", body: SYNC_BODY });
    route.fulfill({ status: 200, contentType: "text/html", body: fixture("fake-meet.html") });
  });
  const meeting = async () => (await meetings("meet", REF))[0];
  const panel = (page) => page.locator("earshot-overlay");

  // Short, so the no-captions warning can be seen before the first caption arrives.
  await worker.evaluate(() => chrome.storage.local.set({ captionsOffSeconds: 3 }));
  const page = await context.newPage();
  await page.setViewportSize({ width: 1400, height: 800 });
  await page.goto(`https://meet.google.com/${REF}`);

  await check("Meet: no panel in the lobby", async () => {
    await sleep(1200);
    assert.equal(await panel(page).count(), 0);
  });

  await page.evaluate(() => window.__join());

  await check("Meet: panel opens on join, docked, with the meeting title", async () => {
    await panel(page).locator(".panel.docked").waitFor({ timeout: 5000 });
    await waitFor(async () => (await panel(page).locator(".meta").innerText()) === "Project check-in", "title");
    assert.equal(await page.evaluate(() => document.documentElement.hasAttribute("data-earshot-docked")), true);
    const widths = await page.evaluate(() => ({ inner: window.innerWidth, outer: document.documentElement.getBoundingClientRect().width }));
    assert.equal(widths.inner, 1400 - 376, "Meet should see the window minus the panel");
  });

  await check("Meet: opens the caption channels itself", async () => {
    const opened = await waitFor(async () => {
      const o = await page.evaluate(() => window.__opened.map((c) => c.label + ":" + c.id));
      return o.some((x) => x.startsWith("captions_v2:")) && o;
    }, "caption channels", 6000);
    assert.ok(opened.some((x) => /^captions:5\d{4}$/.test(x)), opened.join(","));
    assert.ok(opened.some((x) => /^captions_v2:5\d{4}$/.test(x)), opened.join(","));
  });

  await check("Panel: no captions for a while turns it red, notifies, and can ask again", async () => {
    const warn = panel(page).locator(".capwarn");
    await waitFor(async () => !(await warn.evaluate((el) => el.classList.contains("hidden"))), "captions-off warning", 10000);
    assert.match(await panel(page).locator(".status").innerText(), /No captions/);
    assert.equal(await panel(page).locator(".logo.problem").count() > 0, true, "status dot is red");
    const notes = await worker.evaluate(() => new Promise((r) => chrome.notifications.getAll(r)));
    assert.ok(Object.keys(notes).some((id) => id.startsWith("earshot-captions:")), Object.keys(notes).join(","));
    const before = await page.evaluate(() => window.__opened.length);
    await warn.locator('button[data-act="retry-captions"]').click();
    assert.ok(await warn.evaluate((el) => el.classList.contains("hidden")), "warning clears on Try again");
    await sleep(500);
    assert.equal(await page.evaluate(() => window.__opened.length), before, "asking again doesn't open duplicate channels");
    await worker.evaluate(() => chrome.storage.local.set({ captionsOffSeconds: 60 }));
  });

  // The hook's health report (sent on joining and every 15 s) is what raises
  // these in a call; here a report is handed to the bridge directly.
  await check("Panel: a health report with real evidence says what is wrong, and Try again gives it time", async () => {
    const report = (extra) =>
      page.evaluate((extra) => {
        const health = { type: "health", platform: "meet", hook: 3, ref: "abc-defg-hij", joined: true, accepted: 0, rejected: 0, control: 0, recent: { accepted: 0, rejected: 0, control: 0 }, quietMs: 0, hearsSpeech: true, speechAgoMs: null, ...extra };
        document.documentElement.dispatchEvent(new CustomEvent("earshot:page", { detail: JSON.stringify(health) }));
      }, extra);
    const warn = panel(page).locator(".capwarn");
    const hidden = () => warn.evaluate((el) => el.classList.contains("hidden"));
    const statusText = () => panel(page).locator(".status").innerText();

    // Tabs whose captions the Mac app is told aren't arriving (other suites' tabs may be among them).
    const captionsOffTabs = () =>
      worker.evaluate(async () => Object.entries(await chrome.storage.session.get(null)).filter(([k, v]) => k.startsWith("captions:") && v.off).length);
    const offBefore = await captionsOffTabs();

    await report({});
    await sleep(400);
    assert.ok(await hidden(), "a healthy report raises nothing");

    await report({ rejected: 12, recent: { accepted: 0, rejected: 12, control: 0 } });
    await waitFor(async () => /Can't read Google Meet's captions/.test(await statusText()), "format problem in the status");
    assert.match(await warn.locator("span").innerText(), /form Earshot can't read/);
    assert.ok(await warn.locator("button").evaluate((el) => el.classList.contains("hidden")), "nothing to try again for a format problem");
    assert.equal(await panel(page).locator(".logo.problem").count() > 0, true, "status dot is red");

    await report({ quietMs: 31000, speechAgoMs: 1000 });
    await waitFor(async () => /No captions while people talk/.test(await statusText()), "talking with no captions");
    assert.match(await warn.locator("span").innerText(), /People are talking but no captions are arriving/);
    await waitFor(async () => (await captionsOffTabs()) === offBefore + 1, "the Mac app is told captions aren't arriving");

    await warn.locator('button[data-act="retry-captions"]').click();
    // "Asked for captions again", then Meet's own answer to the request.
    await waitFor(async () => /^Asked /.test(await statusText()), "waiting again after Try again");
    assert.ok(await hidden(), "warning clears on Try again");
    await report({ quietMs: 33000, speechAgoMs: 1000 });
    await sleep(500);
    assert.ok(await hidden(), "the same problem isn't raised again straight away");
  });

  await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__captionV2(9001, 1, "spaces/sp1/devices/dev-jordan", "So the");
    await wait(100);
    window.__captionV2(9001, 2, "spaces/sp1/devices/dev-jordan", "So the numbers look good.");
    // The older channel repeats the same words under its own id.
    window.__captionLegacy(555, 2, "spaces/sp1/devices/dev-jordan", "So the numbers look good.");
    window.__captionV2(9002, 1, "spaces/sp1/devices/dev-priya", "Margins are up three points.");
    window.__captionV2(9003, 1, "spaces/sp1/devices/dev-me", "Great, thanks both.");
    window.__captionV2(9004, 1, "spaces/sp1/devices/dev-zed", "Sorry, just joined.");
  });

  await check("Panel: the first lines show a one-time 'Capturing' confirmation", async () => {
    const toast = panel(page).locator(".toast.show");
    await toast.waitFor({ timeout: 3000 });
    assert.match(await toast.innerText(), /Capturing/);
  });

  await check("Meet: captions arrive under each person's name, once each", async () => {
    const t = await waitFor(async () => {
      const x = await overlayText(page);
      return x.includes("Sorry, just joined.") && x;
    }, "captions in panel");
    for (const s of ["Jordan Lee", "So the numbers look good.", "Priya Nair", "Margins are up three points.", "Alex Kestrel", "Great, thanks both."]) assert.ok(t.includes(s), `missing ${s}\n${t}`);
    assert.ok(await panel(page).locator(".capwarn").evaluate((el) => el.classList.contains("hidden")), "no warning once captions arrive");
    assert.equal(t.split("So the numbers look good.").length - 1, 1, `duplicated across channels:\n${t}`);
  });

  await check("Meet: acks each captions_v2 utterance on the channel it opened", async () => {
    const acks = await page.evaluate(() => window.__sent.filter((s) => s.label === "captions_v2").map((s) => s.bytes));
    const decoded = acks.map((b) => at(read(Uint8Array.from(b)), 1, 1));
    assert.ok(decoded.some((r) => r[1][0] === 9001 && r[2][0] === 2 && r[3][0] === 1), JSON.stringify(decoded));
  });

  await check("Meet: a late joiner gets their name from the collections channel", async () => {
    assert.ok((await overlayText(page)).includes("Participant -zed"));
    await page.evaluate(() => window.__device("spaces/sp1/devices/dev-zed", "Zed Okafor"));
    await waitFor(async () => (await overlayText(page)).includes("Zed Okafor"), "Zed named", 5000);
  });

  await check("Meet: caption language goes out on media-session after Meet's own numbers", async () => {
    const mediaSession = () => page.evaluate(() => window.__sent.filter((s) => s.label === "media-session").map((s) => s.bytes));
    // On join Earshot sets the saved language (English): command 8, acks 13 and 14.
    const onJoin = await waitFor(async () => {
      const sent = await mediaSession();
      return sent.length >= 5 && sent.slice(2, 5);
    }, "language on join");
    assert.equal(at(read(Uint8Array.from(onJoin[0])), 1, 2, 1), 8, "command number should follow Meet's 7");
    assert.equal(text(at(read(Uint8Array.from(onJoin[0])), 1, 2, 3, 1, 9), 1), "en-US");
    assert.equal(at(read(Uint8Array.from(onJoin[1])), 1, 1, 2), 13);
    assert.equal(at(read(Uint8Array.from(onJoin[2])), 1, 1, 2), 14);
    // Picking Spanish in the panel sends the next numbers. Each earlier "Try again"
    // sent the language once more (a command and two acks), so count those in.
    const before = (await mediaSession()).length;
    const again = (before - 5) / 3;
    await panel(page).locator(".langpick").selectOption("es");
    const packets = await waitFor(async () => {
      const sent = await mediaSession();
      return sent.length >= before + 3 && sent.slice(before, before + 3);
    }, "language packets");
    const update = read(Uint8Array.from(packets[0]));
    assert.equal(at(update, 1, 2, 1), 9 + again);
    assert.equal(text(at(update, 1, 2, 3, 1, 9), 1), "es-ES");
    assert.equal(at(read(Uint8Array.from(packets[1])), 1, 1, 2), 15 + 2 * again);
    assert.equal(at(read(Uint8Array.from(packets[2])), 1, 1, 2), 16 + 2 * again);
    await waitFor(async () => (await panel(page).locator(".langbtn").getAttribute("title")) === "Caption language: Spanish", "language label");
  });

  // ---------------------------------------------------------------- panel features

  await check("Panel: rename the meeting; a tag is picked from the title", async () => {
    await panel(page).locator(".meta").click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("Acme Q3 board prep");
    await page.keyboard.press("Enter");
    const m = await waitFor(async () => {
      const x = await meeting();
      return x?.title === "Acme Q3 board prep" && x;
    }, "renamed in storage");
    assert.equal(m.titleEdited, true);
    assert.deepEqual(m.tags, ["Acme"]);
    await waitFor(async () => (await panel(page).locator(".chips").innerText()).includes("Acme"), "tag chip");
  });

  await check("Panel: change the tag from the panel", async () => {
    await panel(page).locator(".chips .chip.add").click();
    await panel(page).locator(".tagmenu label", { hasText: "Globex" }).click();
    await waitFor(async () => (await meeting())?.tags.includes("Globex"), "Globex tag saved");
    assert.equal((await meeting()).tagsAuto, false);
    await panel(page).locator(".tagmenu .done").click();
    assert.ok(await panel(page).locator(".tagmenu").evaluate((m) => m.classList.contains("hidden")));
  });

  await check("Panel: fix a line in place, and later caption revisions don't undo it", async () => {
    await panel(page).locator(".block", { hasText: "Margins are up three points." }).click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("Margins are up 3.2 points.");
    await page.keyboard.press("Enter");
    await waitFor(async () => (await meeting())?.segments.some((s) => s.text === "Margins are up 3.2 points." && s.edited), "edit saved");
    await page.evaluate(() => window.__captionV2(9002, 2, "spaces/sp1/devices/dev-priya", "Margins are up three points overall."));
    await sleep(800);
    const seg = (await meeting()).segments.find((s) => s.speaker === "Priya Nair");
    assert.equal(seg.text, "Margins are up 3.2 points.");
    assert.ok((await overlayText(page)).includes("Margins are up 3.2 points."));
  });

  await check("Panel: rename a speaker everywhere", async () => {
    await panel(page).locator(".name", { hasText: "Zed Okafor" }).first().click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("Zed Okafor (Board)");
    await page.keyboard.press("Enter");
    await waitFor(async () => (await meeting())?.segments.some((s) => s.speaker === "Zed Okafor (Board)"), "speaker renamed");
    await page.evaluate(() => window.__captionV2(9010, 1, "spaces/sp1/devices/dev-zed", "One more thing."));
    await waitFor(async () => (await meeting())?.segments.find((s) => s.text === "One more thing.")?.speaker === "Zed Okafor (Board)", "new lines use the new name");
  });

  await check("Panel: tagging a block #todo adds it to your notes with the tag", async () => {
    const block = panel(page).locator(".block", { hasText: "So the numbers look good." });
    await block.hover();
    await block.locator(".tagopen").click();
    await block.locator('button[data-reaction="todo"]').click();
    const m = await waitFor(async () => {
      const x = await meeting();
      return x?.segments.find((s) => s.text === "So the numbers look good.")?.reaction === "todo" && x;
    }, "tag saved");
    assert.match(m.notes, /^- Jordan Lee \[\d\d:\d\d\]: So the numbers look good\. #todo$/m);
    await waitFor(async () => (await panel(page).locator(".notes-text").inputValue()).includes("#todo"), "notes box shows it");
    await block.locator(".badge", { hasText: "#todo" }).waitFor();
  });

  await check("Panel: notes take quick bullets, action items and tags", async () => {
    const box = panel(page).locator(".notes-text");
    await box.click();
    await box.evaluate((el) => el.setSelectionRange(el.value.length, el.value.length));
    await page.keyboard.press("Enter"); // continues the tagged bullet…
    await page.keyboard.press("Enter"); // …and an empty item ends the list
    await page.keyboard.type("- Follow up on margin bridge");
    await page.keyboard.press("Enter");
    await page.keyboard.type("with Priya");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter"); // empty bullet ends the list
    await page.keyboard.type("[] ");
    await page.keyboard.type("Send deck");
    await panel(page).locator('.notetools button[data-tag="followup"]').click();
    const notes = await waitFor(async () => {
      const x = await meeting();
      return x?.notes.includes("- [ ] Send deck #followup") && x.notes;
    }, "notes saved");
    assert.match(notes, /good\. #todo\n- Follow up on margin bridge\n- with Priya\n- \[ \] Send deck #followup$/);
  });

  await check("Panel: Ask AI answers from the transcript and saves the exchange", async () => {
    await panel(page).locator('.tabs button[data-tab="ask"]').click();
    await panel(page).locator(".askinput").fill("What was decided?");
    await page.keyboard.press("Enter");
    await waitFor(async () => (await panel(page).locator(".chat").innerText()).includes('Fake answer to "What was decided?"'), "answer shown", 10000);
    const m = await waitFor(async () => {
      const x = await meeting();
      return x?.chats.length === 1 && x;
    }, "chat saved");
    assert.match(m.chats[0].answer, /from \d+ speaker turns/);
    assert.match(m.chats[0].answer, /Shape: One line per decision/, "a decisions question gets a decisions-shaped answer");
    // New captions re-render the panel; reading an answer must not be yanked to the bottom.
    const chat = panel(page).locator(".chat");
    const overflows = await chat.evaluate((el) => {
      el.style.flex = "0 0 40px";
      el.scrollTop = 0;
      return el.scrollHeight > el.clientHeight;
    });
    assert.ok(overflows, "chat is scrollable for this check");
    await page.evaluate(() => window.__captionV2(9020, 1, "spaces/sp1/devices/dev-zed", "A line while reading the answer."));
    await waitFor(async () => (await meeting())?.segments.some((s) => s.text.includes("while reading")), "caption captured");
    await sleep(300);
    assert.equal(await chat.evaluate((el) => el.scrollTop), 0, "chat kept its place");
    await chat.evaluate((el) => (el.style.flex = ""));
    await panel(page).locator('.tabs button[data-tab="transcript"]').click();
  });

  // Live captions re-render the panel every moment; none of these may be undone by that.
  const captionArrives = async (id, text) => {
    await page.evaluate(([i, t]) => window.__captionV2(i, 1, "spaces/sp1/devices/dev-zed", t), [id, text]);
    await waitFor(async () => (await meeting())?.segments.some((s) => s.text === text), "caption captured");
    await sleep(300);
  };

  await check("Panel: an open line-tag picker stays open as captions arrive", async () => {
    const block = panel(page).locator(".block").first();
    await block.hover();
    await block.locator(".tagopen").click();
    await captionArrives(9030, "Picker check one.");
    assert.equal(await panel(page).locator(".reacts.open").count(), 1, "picker still open");
    await panel(page).locator(".status").click();
    assert.equal(await panel(page).locator(".reacts.open").count(), 0, "a click elsewhere closes it");
  });

  await check("Panel: selected transcript text survives new captions", async () => {
    await panel(page).locator(".block").first().evaluate((el) => el.getRootNode().getSelection().selectAllChildren(el.firstChild.parentNode));
    await captionArrives(9031, "Selection check one.");
    assert.ok(!(await panel(page).locator(".block").first().evaluate((el) => el.getRootNode().getSelection().isCollapsed)), "selection kept");
    assert.ok(!(await overlayText(page)).includes("Selection check one."), "list waits while text is selected");
    await panel(page).locator(".block").first().evaluate((el) => el.getRootNode().getSelection().removeAllRanges());
    await waitFor(async () => (await overlayText(page)).includes("Selection check one."), "list catches up once the selection is gone");
  });

  // Copying part of the text: a drag or a double click selects, it doesn't open the line's editor.
  const readClipboard = () => page.evaluate(() => navigator.clipboard.readText());
  await check("Panel: dragging across part of a line selects it, and Copy copies just that", async () => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "https://meet.google.com" });
    await page.evaluate(() => navigator.clipboard.writeText("before"));
    const block = panel(page).locator(".block", { hasText: "Margins are up 3.2 points." });
    const box = await block.boundingBox();
    const y = box.y + Math.min(box.height / 2, 9);
    await page.mouse.move(box.x + 2, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.5, y, { steps: 6 });
    await page.mouse.up();
    await sleep(150);
    assert.equal(await panel(page).locator('.block[contenteditable="true"]').count(), 0, "no editor opened");
    const selected = await block.evaluate((el) => String(el.getRootNode().getSelection()));
    assert.ok(selected.length > 2 && "Margins are up 3.2 points.".startsWith(selected), `part of the line selected: "${selected}"`);
    const copyBtn = panel(page).locator(".selcopy.show");
    await copyBtn.waitFor({ timeout: 2000 });
    await copyBtn.click();
    assert.equal(await waitFor(async () => ((await readClipboard()) !== "before" ? readClipboard() : null), "clipboard written"), selected.trim());
    await block.evaluate((el) => el.getRootNode().getSelection().removeAllRanges());
    await waitFor(async () => (await panel(page).locator(".selcopy.show").count()) === 0, "Copy goes with the selection");
  });

  await check("Panel: a selection across speakers copies names and times on their own lines, no buttons", async () => {
    const copied = await panel(page).locator(".body").evaluate((body) => {
      const whos = body.querySelectorAll(".who");
      const range = document.createRange();
      range.setStartBefore(whos[0]);
      range.setEndAfter(whos[1].nextElementSibling);
      const sel = body.getRootNode().getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      return { first: whos[0].querySelector(".name").textContent, second: whos[1].querySelector(".name").textContent };
    });
    await panel(page).locator(".selcopy.show").click();
    const text = await waitFor(async () => {
      const t = await readClipboard();
      return t.includes(copied.second) && t;
    }, "clipboard written");
    assert.match(text, new RegExp(`^${copied.first} \\[\\d\\d:\\d\\d\\]\\n\\S`), "first speaker's name and time, then their words");
    assert.match(text, new RegExp(`\\n\\n${copied.second} \\[\\d\\d:\\d\\d\\]\\n\\S`), "a blank line, then the next speaker");
    assert.ok(!/To-do|Follow-up|(^|\s)#(\s|$)/.test(text), `no tag buttons in the copy: ${JSON.stringify(text)}`);
    await panel(page).locator(".body").evaluate((el) => el.getRootNode().getSelection().removeAllRanges());
  });

  await check("Panel: a double click selects a word; a click edits with the cursor where you clicked", async () => {
    const block = panel(page).locator(".block", { hasText: "Margins are up 3.2 points." });
    const box = await block.boundingBox();
    await block.dblclick({ position: { x: 4, y: Math.min(box.height / 2, 9) } });
    await sleep(100);
    const word = await block.evaluate((el) => String(el.getRootNode().getSelection()).trim());
    assert.equal(word, "Margins", "the word is selected");
    await panel(page).locator(".status").click();
    await block.click({ position: { x: 4, y: Math.min(box.height / 2, 9) } });
    await panel(page).locator('.block[contenteditable="true"]').waitFor({ timeout: 2000 });
    const sel = await panel(page).locator('.block[contenteditable="true"]').evaluate((el) => {
      const s = el.getRootNode().getSelection();
      return { collapsed: s.isCollapsed, offset: s.anchorOffset };
    });
    assert.ok(sel.collapsed && sel.offset <= 2, `cursor at the click, not the whole line selected: ${JSON.stringify(sel)}`);
    await page.keyboard.press("Escape");
  });

  await check("Panel: a note typed just before tagging a line is kept", async () => {
    const box = panel(page).locator(".notes-text");
    await box.click();
    await box.evaluate((el) => el.setSelectionRange(el.value.length, el.value.length));
    await page.keyboard.press("Enter");
    await page.keyboard.type("Quick thought before tagging");
    const block = panel(page).locator(".block", { hasText: "Picker check one." });
    await block.hover();
    await block.locator(".tagopen").click();
    await block.locator('button[data-reaction="insight"]').click();
    const notes = await waitFor(async () => {
      const x = await meeting();
      return x?.notes.includes("#insight") && x.notes;
    }, "tagged line added");
    assert.match(notes, /Quick thought before tagging/);
    await sleep(800); // past the typing debounce: nothing may overwrite it later
    assert.match((await meeting()).notes, /Quick thought before tagging/);
    assert.match(await box.inputValue(), /Quick thought before tagging[\s\S]*#insight/);
  });

  await check("Screenshot: saves only the presented screen, at full size", async () => {
    await page.waitForFunction(() => document.getElementById("stage").readyState >= 2);
    await panel(page).locator("button[data-act=screenshot]").click();
    const m = await waitFor(async () => {
      const x = await meeting();
      return x?.screenshots.length === 1 && x;
    }, "screenshot saved", 6000);
    const shot = m.screenshots[0];
    assert.equal(shot.source, "video");
    assert.deepEqual([shot.width, shot.height], [1280, 720]);
    await panel(page).locator(".shot img").waitFor();
  });

  // Shots taken here are removed again, so later checks see just the one presentation.
  const removeLastShot = async () => {
    const before = (await meeting()).screenshots.length;
    await panel(page).locator(".shot").last().locator('button[data-act="delete-shot"]').click();
    await waitFor(async () => (await meeting()).screenshots.length === before - 1, "screenshot removed");
  };

  await check("Screenshot: with nobody presenting, it saves the meeting screen", async () => {
    await page.evaluate(() => (document.getElementById("stage").style.display = "none"));
    // A big camera tile, cropped to fill like cameras are, isn't taken for a presentation...
    await page.evaluate(() => Object.assign(document.getElementById("face").style, { width: "900px", height: "506px" }));
    await panel(page).locator("button[data-act=screenshot]").click();
    // ...so the whole meeting screen, left of the panel, is saved instead.
    const m = await waitFor(async () => {
      const x = await meeting();
      return x?.screenshots.length === 2 && x;
    }, "meeting screen saved", 6000);
    const shot = m.screenshots[1];
    assert.equal(shot.source, "meeting-view");
    const dpr = await page.evaluate(() => devicePixelRatio);
    assert.ok(shot.width < 1400 * dpr && shot.width > 900 * dpr, `${shot.width}x${shot.height}`);
    await waitFor(async () => (await panel(page).locator(".toast").innerText()).includes("meeting screen"), "toast");
    await removeLastShot();
    await page.evaluate(() => Object.assign(document.getElementById("face").style, { width: "", height: "" }));
  });

  await check("Screenshot: an unlabelled share is found when the app says someone is sharing (Teams)", async () => {
    // Teams says "You are viewing …'s screen" but its share surface has no share label.
    await page.evaluate(() => {
      const banner = document.createElement("div");
      banner.id = "test-banner";
      banner.textContent = "You are viewing Robin Hayes's screen";
      const share = document.createElement("canvas");
      share.id = "test-share";
      share.width = 1600;
      share.height = 900;
      const ctx = share.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, 1600, 900);
      ctx.fillStyle = "#1f3a6b";
      ctx.fillRect(100, 100, 700, 300);
      Object.assign(share.style, { position: "fixed", left: "20px", top: "60px", width: "800px", height: "450px" });
      document.body.append(banner, share);
    });
    await panel(page).locator("button[data-act=screenshot]").click();
    const m = await waitFor(async () => {
      const x = await meeting();
      return x?.screenshots.length === 2 && x;
    }, "share saved", 6000);
    const shot = m.screenshots[1];
    assert.equal(shot.source, "canvas");
    assert.deepEqual([shot.width, shot.height], [1600, 900]);
    await removeLastShot();
    await page.evaluate(() => {
      document.getElementById("test-banner").remove();
      document.getElementById("test-share").remove();
      document.getElementById("stage").style.display = "";
    });
  });

  await check("Panel: pause stops capture until resumed", async () => {
    await panel(page).locator("button[data-act=pause]").click();
    await waitFor(async () => (await panel(page).locator(".status").innerText()).includes("Paused"), "paused status");
    await page.evaluate(() => window.__captionV2(9020, 1, "spaces/sp1/devices/dev-jordan", "Off the record."));
    await sleep(800);
    assert.ok(!(await meeting()).segments.some((s) => s.text === "Off the record."));
    await panel(page).locator("button[data-act=pause]").click();
    await page.evaluate(() => window.__captionV2(9021, 1, "spaces/sp1/devices/dev-jordan", "Back on the record."));
    await waitFor(async () => (await meeting())?.segments.some((s) => s.text === "Back on the record."), "captured after resume");
  });

  await check("Panel: collapses to the 3-button launcher, which reopens on Ask AI", async () => {
    await panel(page).locator("button[data-act=collapse]").click();
    const launcher = panel(page).locator(".launcher");
    await launcher.waitFor();
    assert.equal(await launcher.locator("button").count(), 3);
    assert.equal(await page.evaluate(() => [document.documentElement.hasAttribute("data-earshot-docked"), window.innerWidth]).then((r) => r.join()), "false,1400");
    assert.match(await launcher.locator(".logo").getAttribute("class"), /live/);
    const before = await launcher.boundingBox();
    await launcher.locator(".grip").hover();
    await page.mouse.down();
    await page.mouse.move(before.x - 200, before.y + 120, { steps: 6 });
    await page.mouse.up();
    const after = await launcher.boundingBox();
    assert.ok(Math.abs(after.x - (before.x - 200)) < 30 && Math.abs(after.y - (before.y + 120)) < 30, "launcher should move");
    // The spot is kept by side and height share, so a smaller window keeps it on screen, same side.
    const insetRight = 1400 - (after.x + after.width);
    await page.setViewportSize({ width: 700, height: 420 });
    const small = await waitFor(async () => {
      const b = await launcher.boundingBox();
      return b && b.x + b.width <= 700 && b.y + b.height <= 420 && b;
    }, "launcher on screen in a small window");
    assert.ok(small.x >= 0 && small.y >= 0, "launcher should stay on screen");
    assert.ok(Math.abs(700 - (small.x + small.width) - insetRight) < 3, "same distance from the right edge");
    await page.setViewportSize({ width: 1400, height: 800 });
    const back = await waitFor(async () => {
      const b = await launcher.boundingBox();
      return b && Math.abs(b.x - after.x) < 3 && Math.abs(b.y - after.y) < 3 && b;
    }, "launcher back where it was");
    const { launcherPos } = await worker.evaluate(() => chrome.storage.local.get("launcherPos"));
    assert.equal(launcherPos.side, "right");
    // A re-render that drops the overlay gets it put back.
    await page.evaluate(() => document.querySelector("earshot-overlay").remove());
    await waitFor(async () => (await launcher.isVisible()) && (await page.evaluate(() => document.querySelector("earshot-overlay")?.parentNode === document.documentElement)), "launcher back after removal", 5000);
    // Element fullscreen renders only that element, so the launcher moves in and back out.
    await page.evaluate(() => {
      const stage = Object.assign(document.createElement("div"), { id: "fs-stage" });
      const go = Object.assign(document.createElement("button"), { id: "fs-go", textContent: "full screen" });
      go.onclick = () => stage.requestFullscreen();
      Object.assign(go.style, { position: "fixed", left: "10px", top: "10px", zIndex: 5 });
      stage.append(go);
      document.body.append(stage);
    });
    await page.click("#fs-go");
    await waitFor(() => page.evaluate(() => document.fullscreenElement?.id === "fs-stage" && document.querySelector("earshot-overlay")?.parentNode?.id === "fs-stage"), "launcher inside the fullscreen element", 5000);
    assert.ok(await launcher.isVisible(), "launcher visible in fullscreen");
    await page.evaluate(() => document.exitFullscreen());
    await waitFor(() => page.evaluate(() => !document.fullscreenElement && document.querySelector("earshot-overlay")?.parentNode === document.documentElement), "launcher back on the page after fullscreen", 5000);
    await page.evaluate(() => document.getElementById("fs-stage").remove());
    await launcher.locator('button[data-act="l-ask"]').click();
    await panel(page).locator('.panel.docked .tabs button[data-tab="ask"].on').waitFor();
    assert.equal(await page.evaluate(() => window.innerWidth), 1400 - 376);
    await panel(page).locator('.tabs button[data-tab="transcript"]').click();
  });

  await check("Panel: HTML export has the screenshot, notes and tagged moments", async () => {
    const download = await menuDownload(page, "export-html");
    const html = readFileSync(await download.path(), "utf8");
    assert.match(download.suggestedFilename(), /Acme Q3 board prep\.html$/);
    assert.match(html, /<img src="data:image\/jpeg;base64,/);
    assert.match(html, /\[To-do\] So the numbers look good\./);
    assert.match(html, /Send deck/);
    assert.match(html, /Margins are up 3\.2 points\./);
  });

  await check("Helper: the meeting is saved as files in ~/Earshot", async () => {
    const folder = await waitFor(async () => {
      const m = await meeting();
      const year = String(new Date(m.startedAt).getFullYear());
      const root = path.join(earshotHome, "meetings", year);
      if (!existsSync(root)) return null;
      for (const month of readdirSync(root)) for (const f of readdirSync(path.join(root, month))) if (f.includes("Acme Q3 board prep")) {
        const dir = path.join(root, month, f);
        if (existsSync(path.join(dir, "chat.md")) && existsSync(path.join(dir, "notes.md"))) return dir;
      }
      return null;
    }, "meeting folder with files", 10000);
    const transcript = readFileSync(path.join(folder, "transcript.md"), "utf8");
    assert.match(transcript, /^---\ntitle: "Acme Q3 board prep"/);
    assert.match(transcript, /tags: \["Acme", "Globex"\]/);
    assert.match(transcript, /\*\*Jordan Lee\*\* \[\d\d:\d\d\]\n\[To-do\] So the numbers look good\./);
    assert.match(readFileSync(path.join(folder, "notes.md"), "utf8"), /- \[ \] Send deck/);
    assert.match(readFileSync(path.join(folder, "chat.md"), "utf8"), /What was decided\?/);
    assert.equal(readdirSync(path.join(folder, "screenshots")).filter((f) => f.endsWith(".jpg")).length, 1);
    assert.equal(JSON.parse(readFileSync(path.join(folder, "meeting.json"), "utf8")).title, "Acme Q3 board prep");
  });

  await check("Meet: leaving closes the panel, gives the width back, and writes minutes", async () => {
    await worker.evaluate(() => chrome.storage.local.set({ endedNoticeSeconds: 0 }));
    await page.evaluate(() => window.__leaveQuietly());
    await waitFor(async () => (await panel(page).locator(".status").innerText().catch(() => "")).includes("Meeting ended"), "ended status", 6000);
    await waitFor(async () => (await panel(page).count()) === 0, "panel closed", 8000);
    assert.equal(await page.evaluate(() => [document.documentElement.hasAttribute("data-earshot-docked"), window.innerWidth]).then((r) => r.join()), "false,1400");
    const m = await waitFor(async () => {
      const x = await meeting();
      return x?.endedAt && x.minutes && x;
    }, "minutes written", 10000);
    assert.match(m.minutes, /^### Acme Q3 board prep/);
    assert.match(m.minutes, /- \[ \] Send deck/);
    const notes = await worker.evaluate(() => new Promise((r) => chrome.notifications.getAll(r)));
    assert.ok(notes[`earshot-saved:${m.id}`], `saved notification: ${Object.keys(notes).join(",")}`);
    await worker.evaluate(() => chrome.storage.local.set({ endedNoticeSeconds: 30 }));
  });

  const today = new Date();
  const p2 = (n) => String(n).padStart(2, "0");
  const isoDay = `${today.getFullYear()}-${p2(today.getMonth() + 1)}-${p2(today.getDate())}`;
  const dailyFile = path.join(vaultPath, "daily", "notes", `${p2(today.getMonth() + 1)}.${p2(today.getDate())}.${String(today.getFullYear()).slice(-2)}.md`);
  const noteFile = (title) => path.join(vaultPath, "departments", "Acme", "Meeting Minutes", `${isoDay} ${title}.md`);

  await check("Vault: the minutes are filed in the department's Meeting Minutes folder", async () => {
    const file = noteFile("Acme Q3 board prep");
    await waitFor(async () => existsSync(file), "meeting note in the vault", 10000);
    const note = readFileSync(file, "utf8");
    assert.match(note, /^---\ntype: meeting\ntitle: "Acme Q3 board prep"/);
    assert.match(note, /company: "Acme"/);
    assert.match(note, /tags: \["meeting", "Acme", "Globex"\]/);
    assert.match(note, /summary: "Reviewed Q3 numbers across \d+ speaker turns\."/);
    assert.match(note, /%% earshot:start %%\n## My notes\n/, "your notes come first");
    assert.ok(note.indexOf("## My notes") < note.indexOf("**Summary**"));
    assert.ok(!/One-line summary/.test(note), "the summary line is lifted out of the minutes");
    assert.match(note, /## My notes\n\n[\s\S]*- \[ \] Send deck/);
    assert.match(note, /!\[\[images\/earshot\/.+\.jpg\]\]/);
    assert.match(note, /> \[!quote\]- Transcript \(\d+ lines\)\n> \*\*Jordan Lee\*\*/);
    const shots = readdirSync(path.join(vaultPath, "images", "earshot"));
    assert.equal(shots.length, 1);
    const m = await meeting();
    assert.equal(m.vaultNote, `departments/Acme/Meeting Minutes/${isoDay} Acme Q3 board prep.md`);
  });

  await check("Vault: untagged meetings go straight into the untagged folder", async () => {
    const dir = path.join(vaultPath, "Inbox", "meetings", "earshot");
    if (!existsSync(dir)) return; // only when another suite ran first
    assert.ok(readdirSync(dir).some((f) => f.endsWith(".md")), readdirSync(dir).join(", "));
    assert.ok(!existsSync(path.join(dir, "Meeting Minutes")));
  });

  await check("Vault: the daily note gets a linked line under Meetings, next to another tool's entry", async () => {
    const daily = readFileSync(dailyFile, "utf8");
    const line = daily.split("\n").find((l) => l.includes("<!-- earshot:") && l.includes("Acme"));
    assert.ok(line, daily);
    assert.match(line, /^- \[\[departments\/Acme\/Meeting Minutes\/\d{4}-\d\d-\d\d Acme Q3 board prep\|Acme Q3 board prep\]\] · \d{1,2}:\d\d [AP]M: Reviewed Q3 numbers/);
    assert.ok(daily.indexOf("## Meetings") < daily.indexOf(line), "line sits under the Meetings heading");
    assert.match(daily, /<!-- other:start:abc -->[\s\S]*<!-- other:end:abc -->/, "the other entry is untouched");
    // Your tagged note lines sit under it, in the form the vault agent routes from.
    const after = daily.split("\n").slice(daily.split("\n").indexOf(line) + 1);
    assert.match(after[0], /^\t- Jordan Lee \[\d\d:\d\d\]: So the numbers look good\. \[\[Acme\]\] #todo$/);
    assert.equal(after[1], "\t- Send deck [[Acme]] #followup");
    assert.ok(!daily.includes("Follow up on margin bridge"), "untagged notes stay in the meeting note");
  });

  await check("MCP: Claude can list, read, search and file meetings", async () => {
    const mcp = spawn(process.execPath, [path.resolve(path.dirname(new URL(import.meta.url).pathname), "../helper/mcp.js")], { env: { ...process.env, EARSHOT_HOME: earshotHome } });
    let out = "";
    mcp.stdout.on("data", (d) => (out += d));
    const call = async (id, method, params) => {
      mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return waitFor(() => {
        const line = out.split("\n").find((l) => l.includes(`"id":${id},`) || l.includes(`"id":${id}}`));
        return line && JSON.parse(line);
      }, `MCP reply ${id}`, 8000);
    };
    const init = await call(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    assert.equal(init.result.serverInfo.name, "earshot");
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    const tools = (await call(2, "tools/list", {})).result.tools.map((t) => t.name);
    assert.deepEqual(tools, ["list_meetings", "list_series", "search_meetings", "expand_excerpt", "get_meeting", "get_transcript", "get_action_items", "file_meeting_to_vault", "vault_filing_settings"]);
    const text = async (id, name, args) => (await call(id, "tools/call", { name, arguments: args })).result.content[0].text;
    assert.match(await text(3, "list_meetings", { tag: "Acme" }), /Acme Q3 board prep · \[Acme, Globex\]/);
    const got = await text(4, "get_meeting", { meeting: "acme board", include: ["minutes", "notes"] });
    assert.match(got, /# Acme Q3 board prep/);
    assert.match(got, /Filed in vault: departments\/Acme\/Meeting Minutes/);
    assert.match(got, /## Minutes\n### Acme Q3 board prep/);
    const found = await text(5, "search_meetings", { query: "3.2 points" });
    assert.match(found, /#\d+ Priya Nair \[\d\d:\d\d\]: Margins are up 3\.2 points\./);
    const turn = Number(/#(\d+) Priya/.exec(found)[1]);
    const around = await text(20, "expand_excerpt", { meeting: "Acme", turn, before: 1, after: 1 });
    assert.match(around, new RegExp(`→ #${turn} Priya Nair`));
    assert.match(await text(21, "search_meetings", { query: "margins", speaker: "Jordan" }), /Nothing matches "margins" from Jordan/);
    assert.match(await text(22, "search_meetings", { query: "mar" }), /Nothing matches/); // words under 4 letters match whole
    assert.match(await text(23, "get_transcript", { meeting: "Acme", page: 1 }), /Page 1 of 1 · \d+ turns\nFolder: /);
    assert.equal((await call(24, "tools/call", { name: "get_transcript", arguments: { meeting: "Acme", page: 2 } })).result.isError, true);
    assert.match(await text(6, "get_action_items", {}), /- \[ \] Send deck/);
    assert.match(await text(7, "get_transcript", { meeting: "Acme" }), /Jordan Lee \[\d\d:\d\d\]:/);
    assert.match(await text(8, "file_meeting_to_vault", { meeting: "Acme", dry_run: true }), /Would file "Acme Q3 board prep" to departments\/Acme\/Meeting Minutes\//);
    const bad = await call(9, "tools/call", { name: "get_meeting", arguments: { meeting: "no such meeting" } });
    assert.equal(bad.result.isError, true);
    mcp.kill();
  });

  await check("Meet: rejoining the same meeting today continues the same transcript", async () => {
    await page.evaluate(() => window.__join());
    await panel(page).locator(".panel").waitFor({ timeout: 6000 });
    await waitFor(async () => (await overlayText(page)).includes("Margins are up 3.2 points."), "earlier transcript back");
    await waitFor(async () => (await page.evaluate(() => window.__opened.filter((c) => c.label === "captions_v2").length)) === 2, "captions reopened");
    await page.evaluate(() => window.__captionV2(9100, 1, "spaces/sp1/devices/dev-jordan", "Okay, we're back."));
    await waitFor(async () => (await meeting())?.segments.some((s) => s.text === "Okay, we're back."), "new line on the same record");
    assert.equal((await meetings("meet", REF)).length, 1);
    assert.equal((await meeting()).endedAt, null);
  });

  await check("Meetings page: by date, with tag filter, minutes, Ask AI and settings", async () => {
    const extId = new URL(worker.url()).host;
    const m = await meeting();
    const app = await context.newPage();
    await app.goto(`chrome-extension://${extId}/app/meetings.html#${encodeURIComponent(m.id)}`);
    await app.locator("h1", { hasText: "Acme Q3 board prep" }).waitFor();
    assert.ok((await app.locator("#list .day").first().innerText()).match(/today/i));
    assert.match(await app.locator(".minutes").innerText(), /Fake summary/);
    await app.locator("#tagFilter .chip", { hasText: "Acme" }).click();
    await waitFor(async () => (await app.locator("#list .item").count()) === 1, "tag filter");
    await app.locator('.tabs button[data-tab="ask"]').click();
    assert.ok((await app.locator(".chat").innerText()).includes("What was decided?"), "saved chat shown");
    await app.locator(".askbar textarea").fill("Who owns the deck?");
    await app.keyboard.press("Enter");
    await waitFor(async () => (await app.locator(".chat").innerText()).includes('Fake answer to "Who owns the deck?"'), "second answer", 10000);
    await waitFor(async () => (await meeting())?.chats.length === 2, "second chat saved");
    // Rename, then re-file: the note moves, your own additions stay, the daily line updates.
    writeFileSync(noteFile("Acme Q3 board prep"), `${readFileSync(noteFile("Acme Q3 board prep"), "utf8")}\nMy own follow-up thoughts.\n`);
    await app.locator("h1").click();
    await app.keyboard.press("ControlOrMeta+a");
    await app.keyboard.type("Acme Q3 review");
    await app.keyboard.press("Enter");
    await waitFor(async () => (await meeting())?.title === "Acme Q3 review", "renamed");
    await app.locator("button", { hasText: "Re-file to vault" }).click();
    await waitFor(async () => existsSync(noteFile("Acme Q3 review")), "note moved", 8000);
    assert.ok(!existsSync(noteFile("Acme Q3 board prep")), "old note should be gone, not duplicated");
    const moved = readFileSync(noteFile("Acme Q3 review"), "utf8");
    assert.match(moved, /My own follow-up thoughts\./);
    assert.match(moved, /title: "Acme Q3 review"/);
    const m2 = await meeting();
    const lines = readFileSync(dailyFile, "utf8").split("\n").filter((l) => l.includes(`<!-- earshot:${m2.id} -->`));
    assert.equal(lines.length, 1);
    assert.match(lines[0], /Acme Q3 review\|Acme Q3 review\]\]/);
    await app.locator("button", { hasText: "Open in Obsidian" }).waitFor();
    await app.locator("#settingsBtn").click();
    await app.locator("h3", { hasText: "Obsidian vault" }).waitFor();
    const values = await app.locator(".settings input[type=text]").evaluateAll((inputs) => inputs.map((i) => i.value));
    assert.ok(values.includes(vaultPath), "Settings shows the vault Earshot is filing into");
    assert.ok(values.includes("{department}/Meeting Minutes"));
    await app.locator("h3", { hasText: "Minutes template" }).waitFor();
    assert.ok((await app.locator(".settings").innerText()).includes("Saving to"));
    await app.close();
  });

  // Imported meetings (and ones from before a reinstall) exist only as files.
  // Opening one asks the helper for it by id, which once collided with the
  // request's own id, so the answer never came back.
  await check("Meetings page: a meeting kept only as files opens; answers are formatted and copy as rich text", async () => {
    const start = Date.now() - 2 * 86400000;
    const meeting = {
      id: "import-filesonly1", platform: "import", source: "import", title: "Files-only weekly", startedAt: new Date(start).toISOString(),
      endedAt: new Date(start + 600000).toISOString(), participants: {}, speakerNames: {}, notes: "", screenshots: [], tags: [],
      chats: [{ at: start + 5000, question: "Owners?", answer: "- **Soren Halvorsen**\n  - Send the specs *(inferred)*\n\n| Owner | Item |\n|---|---|\n| Ana | Specs |", model: "Fake AI" }],
      minutes: "## Overview\nImported summary.", segments: [{ id: "f1", speakerId: "ana", speaker: "Soren Halvorsen", speakerResolved: true, text: "Only on disk.", startedAt: start + 1000, lastAt: start + 1000 }],
    };
    const host = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../helper/host.js");
    const earlier = { ...meeting, id: "import-filesonly0", startedAt: new Date(start - 7 * 86400000).toISOString(), endedAt: new Date(start - 7 * 86400000 + 600000).toISOString(), chats: [] };
    for (const m of [meeting, earlier]) {
      await new Promise((resolve, reject) => {
        const p = spawn(process.execPath, ["-e", `require(${JSON.stringify(host)}).saveMeeting(${JSON.stringify(m)}).then(() => process.exit(0))`], { env: { ...process.env, EARSHOT_HOME: earshotHome } });
        p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`saveMeeting exited ${code}`))));
      });
    }
    const app = await context.newPage();
    await app.goto(`chrome-extension://${new URL(worker.url()).host}/app/meetings.html`);
    await app.locator(".item", { hasText: "Files-only weekly" }).first().click({ timeout: 8000 });
    await waitFor(async () => (await app.locator("body").innerText()).includes("Imported summary."), "files-only meeting opened");
    assert.ok((await app.locator(".item.on").innerText()).includes("Imported"), "imports say Imported");
    // The speakers count opens the list of who spoke.
    await app.locator(".sub .linkish").click();
    await app.locator(".menu.speakers .spk", { hasText: "Soren Halvorsen" }).waitFor();
    // The side column links the other meeting with the same title, and opens it.
    const rel = app.locator(".related .rel", { hasText: "Files-only weekly" });
    await rel.waitFor();
    await rel.click();
    await waitFor(async () => (await app.locator(".item.on").count()) === 1 && app.url().endsWith("import-filesonly0"), "related meeting opened");
    // The list folds away and comes back.
    await app.locator("#listToggle").click();
    assert.ok(await app.evaluate(() => document.body.classList.contains("listhidden")));
    await app.locator("#listToggle").click();
    await app.locator(".item", { hasText: "Files-only weekly" }).first().click();
    await waitFor(async () => app.url().endsWith("import-filesonly1"), "back to the first meeting");
    await app.locator('.tabs button[data-tab="ask"]').click();
    const answer = app.locator(".a.md").first();
    await answer.locator("li > strong", { hasText: "Soren Halvorsen" }).waitFor({ timeout: 4000 });
    assert.equal(await answer.locator("li ul li em").innerText(), "(inferred)");
    assert.equal(await answer.locator("table td").first().innerText(), "Ana");
    assert.ok(!(await answer.innerText()).includes("**"), "no Markdown symbols left");
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await answer.locator(".copyans").click();
    const copied = await waitFor(() =>
      app.evaluate(async () => {
        const [item] = await navigator.clipboard.read();
        return item.types.includes("text/html") && { html: await (await item.getType("text/html")).text(), text: await (await item.getType("text/plain")).text() };
      }), "rich text on the clipboard");
    assert.match(copied.html, /<li><strong>Soren Halvorsen<\/strong><ul><li>Send the specs <em>\(inferred\)<\/em><\/li><\/ul><\/li>/);
    assert.match(copied.html, /<td style="[^"]*border[^"]*">Ana<\/td>/);
    assert.match(copied.text, /^• Soren Halvorsen\n    • Send the specs \(inferred\)/);
    // Search reaches into what was said in meetings kept only as files; "/" jumps to it.
    await app.locator("main").click();
    await app.keyboard.press("/");
    assert.equal(await app.evaluate(() => document.activeElement?.id), "filter");
    await app.keyboard.type("only on disk");
    await waitFor(async () => {
      const items = await app.locator("#list .item").allInnerTexts();
      return items.length === 2 && items.every((t) => t.includes("Files-only weekly"));
    }, "search by what was said");
    await app.keyboard.press("Escape");
    // By company: one group per company, opened by a click.
    await app.locator('.viewswitch button[data-view="company"]').click();
    const group = app.locator(".group", { hasText: "Acme" });
    await group.waitFor();
    // With nothing filtered, a group opens and closes on click.
    if (await group.evaluate((g) => g.classList.contains("open"))) await group.click();
    await waitFor(async () => (await app.locator(".item", { hasText: "Acme Q3" }).count()) === 0, "group closed");
    await group.click();
    await app.locator(".item", { hasText: "Acme Q3" }).waitFor(); // renamed by an earlier check
    await app.locator('.viewswitch button[data-view="day"]').click();
    assert.ok(!(await app.locator(".item", { hasText: "Files-only weekly" }).first().innerText()).includes("live"), "a finished meeting isn't marked live");
    await app.close();
  });
  await page.close();

  // ---------------------------------------------------------------- the Mac app: caption state out, Mac lines in
  // The extension keeps run/browser.json current for the Mac app, and takes the
  // Mac app's lines (run/mac-segments-*.json, relayed by the helper) into the meeting.
  const MAC_REF = "mac-lines-test";
  const runDir = path.join(earshotHome, "run");
  const extId = new URL(worker.url()).host;
  const macMeeting = async () => (await meetings("meet", MAC_REF))[0];
  const browserEntry = (id) => {
    try {
      return JSON.parse(readFileSync(path.join(runDir, "browser.json"), "utf8")).meetings.find((m) => m.meetingId === id) || null;
    } catch {
      return null;
    }
  };
  const captionsState = (id, want, timeout = 8000) => waitFor(() => browserEntry(id)?.captions === want && browserEntry(id), `browser.json captions "${want}"`, timeout);
  // Written the way the Mac app writes them: a temp file, then a rename.
  const writeMac = (meetingId, captureId, segments, done) => {
    const name = `mac-segments-${meetingId}-${captureId}.json`;
    mkdirSync(runDir, { recursive: true });
    const tmp = path.join(runDir, `.${name}.tmp`);
    writeFileSync(tmp, JSON.stringify({ meetingId, captureId, segments, done }));
    renameSync(tmp, path.join(runDir, name));
    return name;
  };
  const macSeg = (captureId, n, at, text) => ({ id: `mac-${captureId}-mic-${n}`, speakerId: "mac-mic", speaker: "Speaker", speakerResolved: true, text, startedAt: at, lastAt: at + 1000 });
  let macId = null;

  await worker.evaluate(() => chrome.storage.local.set({ captionsOffSeconds: 3 }));
  const mp = await context.newPage();
  await mp.setViewportSize({ width: 1400, height: 800 });
  await mp.goto(`https://meet.google.com/${MAC_REF}`);
  await mp.evaluate(() => window.__join());

  await check("Browser state: waiting, then off, then arriving", async () => {
    macId = (await waitFor(macMeeting, "meeting record", 6000)).id;
    const waiting = await captionsState(macId, "waiting");
    assert.equal(waiting.platform, "meet");
    assert.equal(typeof waiting.tabId, "number");
    assert.equal(waiting.startedAt, (await macMeeting()).startedAt);
    await captionsState(macId, "off", 10000);
    // A worker restart forgets what's in memory; "off" comes back from session storage.
    await worker.evaluate(async () => {
      captionWatch.clear();
      await reportBrowserState();
    });
    assert.equal(browserEntry(macId)?.captions, "off", "off survives a worker restart");
    await worker.evaluate(() => chrome.storage.local.set({ captionsOffSeconds: 60 }));
    await mp.waitForFunction(() => window.__channels?.captions_v2, null, { timeout: 6000 });
    await mp.evaluate(() => window.__captionV2(7001, 1, "spaces/sp1/devices/dev-jordan", "The first caption."));
    await captionsState(macId, "arriving");
  });

  await check("Browser state: lost", async () => {
    await worker.evaluate(() => chrome.storage.local.set({ captionsLostSeconds: 3 }));
    try {
      await mp.evaluate(() => window.__captionV2(7002, 1, "spaces/sp1/devices/dev-jordan", "A later caption."));
      await waitFor(async () => (await macMeeting())?.segments.some((s) => s.text === "A later caption."), "caption captured");
      await captionsState(macId, "arriving");
      await sleep(4000);
      assert.ok(await worker.evaluate(async () => !!(await chrome.alarms.get("earshot-browser-state"))), "heartbeat alarm armed while a meeting is live");
      await worker.evaluate(() => reportBrowserState()); // what the heartbeat alarm runs
      await captionsState(macId, "lost", 3000);
      await worker.evaluate(async () => {
        captionWatch.clear();
        await reportBrowserState();
      });
      assert.equal(browserEntry(macId)?.captions, "lost", "lost survives a worker restart");
    } finally {
      await worker.evaluate(() => chrome.storage.local.set({ captionsLostSeconds: 120 }));
    }
  });

  await check("Mac lines merge in time order", async () => {
    const firstCaption = Math.min(...(await macMeeting()).segments.map((s) => s.startedAt));
    const one = macSeg("a", 1, firstCaption - 5000, "Said before captions began.");
    const name = writeMac(macId, "a", [one], false);
    await waitFor(async () => (await panel(mp).locator(".block").first().innerText().catch(() => "")).includes("Said before captions began."), "Mac line first in the panel");
    await waitFor(async () => (await panel(mp).locator(".status").innerText()) === "Capturing with Mac audio", "Mac audio status");
    const m = await waitFor(async () => {
      const x = await macMeeting();
      return x?.segments[0]?.id === "mac-a-mic-1" && x;
    }, "Mac line saved first");
    assert.equal(m.macCapture, "running");
    writeMac(macId, "a", [one, macSeg("a", 2, firstCaption - 2000, "A second Mac line.")], true);
    await waitFor(() => existsSync(path.join(runDir, "done", name)) && !existsSync(path.join(runDir, name)), "file moved to run/done");
    await waitFor(async () => !(await panel(mp).locator(".status").innerText()).includes("Mac audio"), "Mac audio status cleared");
    const after = await waitFor(async () => {
      const x = await macMeeting();
      return x?.macCapture === "done" && x;
    }, "capture done");
    assert.deepEqual(after.segments.slice(0, 2).map((s) => s.id), ["mac-a-mic-1", "mac-a-mic-2"]);
    assert.ok(after.segments.some((s) => s.text === "The first caption."), "captions kept");
  });

  await check("Mac lines leave a paused tab paused", async () => {
    const status = () => panel(mp).locator(".status").innerText();
    await panel(mp).locator("button[data-act=pause]").click();
    await waitFor(async () => (await status()).includes("Paused"), "paused status");
    await waitFor(() => browserEntry(macId)?.paused === true, "browser.json says paused");
    const line = macSeg("p", 1, Date.now() - 1000, "Said while paused.");
    const name = writeMac(macId, "p", [line], false);
    await waitFor(async () => (await macMeeting())?.macCapture === "running", "capture p running");
    await sleep(400);
    assert.match(await status(), /Paused/);
    writeMac(macId, "p", [line], true);
    await waitFor(() => existsSync(path.join(runDir, "done", name)), "capture p acked");
    await waitFor(async () => (await macMeeting())?.macCapture === "done", "capture p done");
    await sleep(400);
    assert.match(await status(), /Paused/);
    await panel(mp).locator("button[data-act=pause]").click();
    await waitFor(() => browserEntry(macId)?.paused === false, "browser.json says not paused");
  });

  // Your fixes to the Mac's lines in the browser panel stand when the Mac sends them again.
  const callLine = (captureId, n, at, text) => ({ id: `mac-${captureId}-call-${n}`, speakerId: "mac-call", speaker: "Call", speakerResolved: true, text, startedAt: at, lastAt: at + 1000 });
  const macLineShown = (text) => waitFor(async () => (await overlayText(mp)).includes(text), `"${text}" in the panel`);

  await check("A rename of a Mac speaker in the browser panel survives the next push and the done push", async () => {
    const t0 = Date.now() - 30000;
    const one = callLine("r", 1, t0, "Rename me, please.");
    const two = callLine("r", 2, t0 + 3000, "A second line from the call.");
    const name = writeMac(macId, "r", [one], false);
    await macLineShown("Rename me, please.");
    await panel(mp).locator('.name[data-speaker="mac-call"]').first().click();
    await mp.keyboard.press("ControlOrMeta+a");
    await mp.keyboard.type("Dana Okafor");
    await mp.keyboard.press("Enter");
    await waitFor(async () => (await macMeeting())?.speakerNames?.["mac-call"] === "Dana Okafor", "rename saved");
    const callNames = async () => (await macMeeting()).segments.filter((x) => x.speakerId === "mac-call").map((x) => x.speaker);
    writeMac(macId, "r", [one, two], false);
    await waitFor(async () => (await macMeeting())?.segments.some((x) => x.id === "mac-r-call-2"), "second push merged");
    await sleep(300);
    assert.deepEqual(await callNames(), ["Dana Okafor", "Dana Okafor"], "names after the next push");
    await waitFor(async () => !(await panel(mp).locator('.name[data-speaker="mac-call"]').allInnerTexts()).includes("Call"), "panel shows the new name");
    writeMac(macId, "r", [{ ...one, text: "Rename me, please (Whisper)." }, two], true);
    await waitFor(() => existsSync(path.join(runDir, "done", name)), "capture r acked");
    await waitFor(async () => (await macMeeting())?.segments.some((x) => x.text === "Rename me, please (Whisper)."), "done push merged");
    assert.deepEqual(await callNames(), ["Dana Okafor", "Dana Okafor"], "names after the done push");
  });

  await check("A line tag and a text fix on a Mac line survive the next push", async () => {
    const t0 = Date.now() - 20000;
    const tagged = callLine("t", 1, t0, "Tag this Mac line.");
    const fixed = callLine("t", 2, t0 + 3000, "Fix this Mac line.");
    const name = writeMac(macId, "t", [tagged, fixed], false);
    await macLineShown("Fix this Mac line.");
    const block = panel(mp).locator(".block", { hasText: "Tag this Mac line." });
    await block.hover();
    await block.locator(".tagopen").click();
    await block.locator('button[data-reaction="todo"]').click();
    await waitFor(async () => (await macMeeting())?.segments.find((x) => x.id === "mac-t-call-1")?.reaction === "todo", "tag saved");
    await panel(mp).locator(".block", { hasText: "Fix this Mac line." }).click();
    await mp.keyboard.press("ControlOrMeta+a");
    await mp.keyboard.type("Fixed by hand.");
    await mp.keyboard.press("Enter");
    await waitFor(async () => (await macMeeting())?.segments.find((x) => x.id === "mac-t-call-2")?.edited, "fix saved");
    const seg = async (id) => (await macMeeting()).segments.find((x) => x.id === id);
    // The live recognizer revises both lines.
    writeMac(macId, "t", [{ ...tagged, text: "Tag this Mac line, revised." }, { ...fixed, text: "Fix this Mac line, revised." }], false);
    await waitFor(async () => (await seg("mac-t-call-1"))?.text === "Tag this Mac line, revised.", "revision merged");
    await sleep(300);
    assert.equal((await seg("mac-t-call-1")).reaction, "todo", "tag kept");
    assert.equal((await seg("mac-t-call-2")).text, "Fixed by hand.", "fix kept while live");
    // The Whisper pass replaces the text, and keeps the tag on the line that's still there.
    writeMac(macId, "t", [{ ...tagged, text: "Tag this Mac line (Whisper)." }, { ...fixed, text: "Fix this Mac line (Whisper)." }], true);
    await waitFor(() => existsSync(path.join(runDir, "done", name)), "capture t acked");
    await waitFor(async () => (await seg("mac-t-call-1"))?.text === "Tag this Mac line (Whisper).", "done push merged");
    assert.equal((await seg("mac-t-call-1")).reaction, "todo", "tag kept on done");
  });

  await check("Minutes wait for a running Mac capture", async () => {
    const t0 = Date.now() - 60000;
    const lines = [1, 2, 3, 4, 5].map((n) => macSeg("b", n, t0 + n * 1000, `Mac line ${n}.`));
    const name = writeMac(macId, "b", lines, false);
    await waitFor(async () => (await macMeeting())?.macCapture === "running", "capture b running");
    await mp.evaluate(() => window.__leaveQuietly());
    await waitFor(async () => (await macMeeting())?.endedAt, "meeting ended", 8000);
    await sleep(1500);
    assert.ok(!(await macMeeting()).minutes, "no minutes while the Mac capture runs");
    assert.ok(await worker.evaluate(async (id) => !!(await chrome.alarms.get(minutesAlarm(id))), macId), "minutes alarm re-armed");
    writeMac(macId, "b", lines, true);
    await waitFor(() => existsSync(path.join(runDir, "done", name)), "capture b acked");
    await waitFor(async () => (await macMeeting())?.macCapture === "done", "capture b done");
    await worker.evaluate((id) => writeEndedMinutes(id), macId); // what the minutes alarm runs
    await waitFor(async () => (await macMeeting())?.minutes, "minutes written", 10000);
  });

  await check("Mac lines that arrive after the meeting ended still bring minutes", async () => {
    // Captions were off, so the meeting ended with nothing to write minutes from.
    const id = await worker.evaluate(async () => {
      const m = upgrade({ id: "meet-maclate-1", platform: "meet", meetingRef: "maclate", refs: [], title: "Captions were off", startedAt: new Date(Date.now() - 600000).toISOString(), endedAt: null, participants: {}, segments: [] });
      loaded.set(m.id, m);
      markDirty(m);
      await flush();
      await endMeeting(undefined, m);
      return m.id;
    });
    const stored = async () => (await storage())[`meeting:${id}`];
    await sleep(500);
    assert.ok(!(await stored()).minutes, "no minutes from nothing");
    // The Mac app's first (and last) write is the Whisper pass.
    const t0 = Date.now() - 500000;
    const name = writeMac(id, "w", [1, 2, 3, 4, 5, 6].map((n) => macSeg("w", n, t0 + n * 1000, `Late line ${n}.`)), true);
    await waitFor(() => existsSync(path.join(runDir, "done", name)), "late capture acked");
    await waitFor(async () => (await stored())?.minutes, "minutes written", 10000);
  });

  await check("Minutes stop waiting for a Mac capture after 3 hours", async () => {
    const res = await worker.evaluate(async () => {
      const seg = (i) => ({ id: `mac-z-mic-${i}`, speakerId: "mac-mic", speaker: "Speaker", text: `Stuck line ${i}.`, startedAt: Date.now() - 4 * 3600000 + i, lastAt: Date.now() - 4 * 3600000 + i });
      const m = upgrade({
        id: "meet-macstuck-1", platform: "meet", meetingRef: "macstuck", refs: [], title: "Mac app went away", startedAt: new Date(Date.now() - 4 * 3600000).toISOString(),
        endedAt: new Date(Date.now() - 3 * 3600000 - 60000).toISOString(), participants: {}, segments: [0, 1, 2, 3, 4, 5].map(seg), macCaptures: { z: "running" }, macCapture: "running",
      });
      loaded.set(m.id, m);
      markDirty(m);
      await flush();
      await writeEndedMinutes(m.id);
      return { minutes: !!m.minutes, waiting: !!(await chrome.alarms.get(minutesAlarm(m.id))) };
    });
    assert.deepEqual(res, { minutes: true, waiting: false });
  });

  await check("Older disk copy doesn't replace newer edits", async () => {
    const app = await context.newPage();
    await app.goto(`chrome-extension://${extId}/app/meetings.html`);
    const send = (msg) => app.evaluate((m) => chrome.runtime.sendMessage(m), msg);
    await send({ kind: "meeting-action", meetingId: macId, action: "notes", text: "Edited in Chrome." });
    const edited = await waitFor(async () => {
      const x = await macMeeting();
      return x?.notes === "Edited in Chrome." && x;
    }, "notes saved");
    const shifted = (ms) => new Date(Date.parse(edited.updatedAt) + ms).toISOString();
    await send({ kind: "import-meeting", meeting: { ...edited, notes: "Older copy on disk.", updatedAt: shifted(-60000) } });
    await sleep(300);
    assert.equal((await macMeeting()).notes, "Edited in Chrome.");
    await send({ kind: "import-meeting", meeting: { ...edited, notes: "Newer copy on disk.", updatedAt: shifted(60000) } });
    await waitFor(async () => (await macMeeting())?.notes === "Newer copy on disk.", "a newer copy replaces it");
    await app.close();
  });

  await check("Meetings page: a Mac meeting's later minutes show on focus, and edits there keep them", async () => {
    const host = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../helper/host.js");
    const node = (code) =>
      new Promise((resolve, reject) => {
        let out = "";
        const p = spawn(process.execPath, ["-e", `const h = require(${JSON.stringify(host)}); (async () => { ${code} })().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); })`], { env: { ...process.env, EARSHOT_HOME: earshotHome } });
        p.stdout.on("data", (d) => (out += d));
        p.on("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(`helper script exited ${code}`))));
      });
    const save = (m) => node(`await h.saveMeeting(${JSON.stringify(m)});`);
    const onDisk = async (id) =>
      JSON.parse(await node(`const fs = require("fs"), path = require("path"); const folder = (await h.loadIndex()).meetings[${JSON.stringify(id)}].folder; const file = path.join(folder, "meeting.json"); console.log(JSON.stringify({ meeting: JSON.parse(fs.readFileSync(file, "utf8")), mtime: fs.statSync(file).mtimeMs }));`));
    const start = Date.now() - 3600000;
    const base = {
      id: "mac-20261104-desk1", platform: "mac", title: "Mac desk call", startedAt: new Date(start).toISOString(), endedAt: new Date(start + 600000).toISOString(),
      participants: {}, speakerNames: {}, notes: "", screenshots: [], tags: [], chats: [], minutes: "## Overview\nFirst minutes.",
      segments: [{ id: "mac-d-mic-1", speakerId: "mac-mic", speaker: "Speaker", speakerResolved: true, text: "From the Mac.", startedAt: start + 1000, lastAt: start + 2000 }],
      updatedAt: new Date(Date.now() - 120000).toISOString(),
    };
    await save(base);
    const app = await context.newPage();
    const minutesShown = (text) => waitFor(async () => (await app.locator(".minutes").innerText().catch(() => "")).includes(text), `minutes "${text}" shown`);
    await app.goto(`chrome-extension://${extId}/app/meetings.html#${base.id}`);
    await minutesShown("First minutes.");
    // The Mac app writes the minutes later, on disk.
    await save({ ...base, minutes: "## Overview\nMinutes written later.", updatedAt: new Date().toISOString() });
    const before = await onDisk(base.id);
    await app.evaluate(() => window.dispatchEvent(new Event("focus")));
    await minutesShown("Minutes written later.");
    // A copy just read from disk isn't written back.
    await sleep(3600);
    assert.equal((await onDisk(base.id)).mtime, before.mtime, "the imported copy wasn't saved back");
    await app.locator('.tabs button[data-tab="notes"]').click();
    await app.locator("#detail textarea").first().fill("Notes from the page.");
    const saved = await waitFor(async () => {
      const d = (await onDisk(base.id)).meeting;
      return d.notes === "Notes from the page." && d;
    }, "notes saved to disk", 12000);
    assert.match(saved.minutes, /Minutes written later\./);
    // The Mac app writes again, unseen by the page: the next edit still lands on its copy.
    await save({ ...saved, minutes: "## Overview\nThird minutes.", updatedAt: new Date().toISOString() });
    await app.locator("#detail textarea").first().fill("Notes from the page, again.");
    const both = await waitFor(async () => {
      const d = (await onDisk(base.id)).meeting;
      return d.notes === "Notes from the page, again." && d;
    }, "second notes saved to disk", 12000);
    assert.match(both.minutes, /Third minutes\./);
    await app.close();
  });

  // The Mac panel is the other writer of Mac meetings. It saves the way the
  // helper's base protocol says: built on the disk copy it read.
  const hostJs = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../helper/host.js");
  const J = JSON.stringify;
  const helperScript = (code) =>
    new Promise((resolve, reject) => {
      let out = "";
      const p = spawn(process.execPath, ["-e", `const h = require(${J(hostJs)}); (async () => { ${code} })().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); })`], { env: { ...process.env, EARSHOT_HOME: earshotHome } });
      p.stdout.on("data", (d) => (out += d));
      p.on("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(`helper script exited ${code}`))));
    });
  const diskCopy = async (id) => JSON.parse(await helperScript(`console.log(JSON.stringify(await h.getMeeting({ id: ${J(id)} })));`));
  const macPanelWrite = (id, patch) =>
    helperScript(`for (let i = 0; i < 5; i++) {
      const d = await h.getMeeting({ id: ${J(id)} });
      const m = { ...d, ...${J(patch)}, updatedAt: new Date(Math.max(Date.now(), Date.parse(d.updatedAt) + 1)).toISOString() };
      if (!(await h.saveMeeting(m, d.updatedAt)).stale) return;
    }
    throw new Error("stale five times");`);
  const macMeetingRecord = (id, title, extra = {}) => {
    const start = Date.now() - 3600000;
    return {
      id, platform: "mac", title, titleEdited: true, startedAt: new Date(start).toISOString(), endedAt: new Date(start + 600000).toISOString(),
      participants: {}, speakerNames: {}, notes: "", screenshots: [], tags: [], tagsAuto: false, chats: [], minutes: null,
      segments: [1, 2, 3, 4, 5, 6].map((n) => ({ id: `mac-q-mic-${n}`, speakerId: "mac-mic", speaker: "Speaker", speakerResolved: true, text: `Mac line ${n}.`, startedAt: start + n * 1000, lastAt: start + n * 1000 + 500 })),
      updatedAt: new Date(Date.now() - 60000).toISOString(),
      ...extra,
    };
  };
  const openOnPage = async (m) => {
    await helperScript(`await h.saveMeeting(${J(m)});`);
    const app = await context.newPage();
    await app.goto(`chrome-extension://${extId}/app/meetings.html#${m.id}`);
    await app.locator("h1", { hasText: m.title }).waitFor({ timeout: 8000 });
    return app;
  };

  await check("Ask AI on the meetings page for a Mac meeting written meanwhile keeps the Mac's notes", async () => {
    const m = macMeetingRecord("mac-20261104-ask1", "Mac call with a question");
    const app = await openOnPage(m);
    await app.locator('.tabs button[data-tab="ask"]').click();
    await app.locator(".askbar textarea").fill("Slowpoke: who owns the deck?");
    await app.keyboard.press("Enter");
    await sleep(800); // the AI is still answering
    await macPanelWrite(m.id, { notes: "Written in the Mac panel." });
    await waitFor(async () => (await app.locator(".chat").innerText()).includes('Fake answer to "Slowpoke'), "answer shown", 10000);
    const d = await waitFor(async () => {
      const x = await diskCopy(m.id);
      return x.chats?.length === 1 && x;
    }, "chat saved to disk", 10000);
    await sleep(3500); // past any late write from Chrome
    const later = await diskCopy(m.id);
    assert.equal(later.notes, "Written in the Mac panel.");
    assert.equal(later.chats.length, 1);
    assert.equal(d.chats[0].question, "Slowpoke: who owns the deck?");
    await app.close();
  });

  await check("Minutes written on the meetings page for a Mac meeting written meanwhile keep the Mac's notes", async () => {
    const m = macMeetingRecord("mac-20261104-min1", "Slowpoke Mac call");
    const app = await openOnPage(m);
    await app.locator("button", { hasText: "Generate minutes" }).click();
    await sleep(800); // the AI is still writing
    await macPanelWrite(m.id, { notes: "Mac notes during the minutes." });
    await waitFor(async () => (await diskCopy(m.id)).minutes, "minutes saved to disk", 12000);
    await sleep(3500);
    const later = await diskCopy(m.id);
    assert.equal(later.notes, "Mac notes during the minutes.");
    assert.match(later.minutes || "", /Slowpoke Mac call/);
    await app.close();
  });

  await check("An edit on the meetings page survives a Mac write 1 s later", async () => {
    const m = macMeetingRecord("mac-20261104-edit1", "Mac call going on", { endedAt: null });
    const app = await openOnPage(m);
    await app.locator('.tabs button[data-tab="notes"]').click();
    await app.locator("#detail textarea").first().fill("Typed on the meetings page.");
    await sleep(1000);
    await macPanelWrite(m.id, { title: "Renamed in the Mac panel" });
    const d = await waitFor(async () => {
      const x = await diskCopy(m.id);
      return x.notes === "Typed on the meetings page." && x.title === "Renamed in the Mac panel" && x;
    }, "both changes on disk", 12000);
    await sleep(3500); // and they stay
    const later = await diskCopy(m.id);
    assert.equal(later.notes, "Typed on the meetings page.");
    assert.equal(later.title, "Renamed in the Mac panel");
    assert.ok(d);
    await app.close();
  });
  await mp.close();

  await check("Minutes wait after a meeting ends, and a meeting that comes back cancels them", async () => {
    const state = await worker.evaluate(async () => {
      await chrome.storage.local.set({ minutesDelayMinutes: 5 });
      const seg = (i) => ({ id: `g${i}`, speakerId: "a", speaker: "Ana", text: `Line ${i}.`, startedAt: Date.now() - 60000 + i, lastAt: Date.now() - 60000 + i });
      const m = upgrade({ id: "meet-grace-1", platform: "meet", meetingRef: "grace", refs: [], title: "Grace", startedAt: new Date(Date.now() - 600000).toISOString(), endedAt: null, participants: {}, segments: [0, 1, 2, 3, 4, 5].map(seg) });
      loaded.set(m.id, m);
      markDirty(m);
      await flush();
      await endMeeting(undefined, m);
      const pending = !!(await chrome.alarms.get(minutesAlarm(m.id)));
      revive(m);
      await new Promise((r) => setTimeout(r, 200));
      const afterRevive = !!(await chrome.alarms.get(minutesAlarm(m.id)));
      await chrome.storage.local.set({ minutesDelayMinutes: 0 });
      return { pending, afterRevive, live: m.endedAt === null, minutes: m.minutes };
    });
    assert.deepEqual(state, { pending: true, afterRevive: false, live: true, minutes: null });
  });

  await check("Automatic minutes that fail are tried again, and the last failure says so once", async () => {
    const state = await worker.evaluate(async () => {
      const seg = (i) => ({ id: `r${i}`, speakerId: "a", speaker: "Ana", text: `Line ${i}.`, startedAt: Date.now() - 60000 + i, lastAt: Date.now() - 60000 + i });
      const ended = (id, title) => {
        const m = upgrade({ id, platform: "meet", meetingRef: id, refs: [], title, startedAt: new Date(Date.now() - 600000).toISOString(), endedAt: new Date().toISOString(), participants: {}, segments: [0, 1, 2, 3, 4, 5].map(seg) });
        loaded.set(m.id, m);
        markDirty(m);
        return m;
      };
      const alarmIn = async (id) => {
        const a = await chrome.alarms.get(minutesAlarm(id));
        return a ? Math.round((a.scheduledTime - Date.now()) / 60000) : null;
      };
      const flaky = ended("meet-retry-1", "Flakyone sync");
      const broken = ended("meet-retry-2", "Brokenwire sync");
      await flush();

      await writeEndedMinutes(flaky.id);
      const firstTry = { error: !!(await loadMeeting(flaky.id)).minutesError, attempts: (await loadMeeting(flaky.id)).minutesAttempts, retryIn: await alarmIn(flaky.id) };
      await writeEndedMinutes(flaky.id); // the alarm firing
      const f = await loadMeeting(flaky.id);
      const secondTry = { minutes: !!f.minutes, error: f.minutesError ?? null, attempts: f.minutesAttempts ?? null, retryIn: await alarmIn(flaky.id) };

      const tries = [];
      for (let i = 0; i < 3; i++) {
        await writeEndedMinutes(broken.id);
        tries.push({ attempts: (await loadMeeting(broken.id)).minutesAttempts, retryIn: await alarmIn(broken.id) });
      }
      const notes = await new Promise((r) => chrome.notifications.getAll(r));
      return { firstTry, secondTry, tries, failedNotice: Object.keys(notes).filter((k) => k.startsWith("earshot-minutes-failed:")) };
    });
    assert.deepEqual(state.firstTry, { error: true, attempts: 1, retryIn: 5 });
    assert.deepEqual(state.secondTry, { minutes: true, error: null, attempts: null, retryIn: null });
    assert.deepEqual(state.tries, [
      { attempts: 1, retryIn: 5 },
      { attempts: 2, retryIn: 15 },
      { attempts: 3, retryIn: null },
    ]);
    assert.deepEqual(state.failedNotice, ["earshot-minutes-failed:meet-retry-2"]);
  });

  await check("A meeting left live with nothing captured for 10 minutes is ended", async () => {
    const ended = await worker.evaluate(async () => {
      const m = upgrade({ id: "meet-stale-1", platform: "meet", meetingRef: "stale", refs: [], title: "Stale one", startedAt: new Date(Date.now() - 20 * 60000).toISOString(), endedAt: null, participants: {}, segments: [] });
      loaded.set(m.id, m);
      markDirty(m);
      await flush();
      const rows = (await indexRows()).filter((r) => !r.endedAt).map((r) => r.id);
      try {
        await endStaleMeetings();
      } catch (err) {
        return { err: String(err), rows };
      }
      return { endedAt: (await loadMeeting("meet-stale-1")).endedAt, rows };
    });
    assert.ok(ended.endedAt, JSON.stringify(ended));
  });

  // ---------------------------------------------------------------- screenshot fallback and tab close
  await check("Screenshot: an unreadable presentation falls back to a crop of the visible tab", async () => {
    const p = await context.newPage();
    await p.setViewportSize({ width: 1400, height: 800 });
    await p.goto(`https://meet.google.com/zzz-yyyy-xxx?stage=webgl`);
    await p.bringToFront();
    await p.evaluate(() => window.__join());
    await panel(p).locator(".panel").waitFor({ timeout: 5000 });
    await panel(p).locator("button[data-act=screenshot]").click();
    const m = await waitFor(async () => {
      const x = (await meetings("meet", "zzz-yyyy-xxx"))[0];
      return x?.screenshots.length === 1 && x;
    }, "fallback screenshot", 8000);
    const shot = m.screenshots[0];
    assert.equal(shot.source, "tab-crop");
    const dpr = await p.evaluate(() => devicePixelRatio);
    assert.ok(Math.abs(shot.width - 800 * dpr) <= 2 && Math.abs(shot.height - 450 * dpr) <= 2, `${shot.width}x${shot.height}`);

    await p.close();
    await waitFor(async () => (await meetings("meet", "zzz-yyyy-xxx"))[0]?.endedAt, "closing the tab ends the meeting", 5000);
  });

  // ---------------------------------------------------------------- channels Meet opens itself
  // Today's Meet opens media-session (and, with CC on, captions_v2) from the
  // page, so no "datachannel" event announces them. They have to be caught
  // as they're made, or the language never reaches Meet.
  {
    const OWN_REF = "own-chan-test";
    // An earlier check picked Spanish; this block expects the default.
    await worker.evaluate(() => chrome.storage.local.set({ captionLanguage: "en" }));
    const op = await context.newPage();
    await op.goto(`https://meet.google.com/${OWN_REF}`);
    await op.evaluate(() => window.__joinLocal());
    const sentOn = (label) => op.evaluate((l) => window.__sent.filter((s) => s.label === l).map((s) => s.bytes), label);
    const diag = () =>
      op.evaluate(
        () =>
          new Promise((resolve) => {
            const on = (e) => {
              const m = JSON.parse(e.detail);
              if (m.type !== "diagnostics") return;
              document.documentElement.removeEventListener("earshot:page", on);
              resolve(m.data);
            };
            document.documentElement.addEventListener("earshot:page", on);
            document.documentElement.dispatchEvent(new CustomEvent("earshot:cmd", { detail: JSON.stringify({ type: "diagnostics" }) }));
          })
      );

    await check("Meet: sets the caption language on a media-session Meet opened itself", async () => {
      const packets = await waitFor(async () => {
        const sent = await sentOn("media-session");
        return sent.length >= 5 && sent.slice(2, 5);
      }, "language on Meet's own media-session", 6000);
      const update = read(Uint8Array.from(packets[0]));
      assert.equal(at(update, 1, 2, 1), 4, "command number should follow Meet's 3");
      assert.equal(text(at(update, 1, 2, 3, 1, 9), 1), "en-US");
      assert.equal(at(read(Uint8Array.from(packets[1])), 1, 1, 2), 5);
      assert.equal(at(read(Uint8Array.from(packets[2])), 1, 1, 2), 6);
      await op.evaluate(() => window.__configAnswer(1));
      await waitFor(async () => (await diag()).language.result === "accepted", "Meet's answer settles the request", 4000);
      assert.equal((await diag()).mediaSessionOrigin, "meet");
    });

    await check("Meet: listens on Meet's own captions_v2 instead of opening a rival", async () => {
      const opened = await waitFor(async () => {
        const o = await op.evaluate(() => window.__opened.map((c) => `${c.label}:${c.id ?? "meet"}`));
        return o.some((x) => /^captions:5\d{4}$/.test(x)) && o;
      }, "legacy channel opened", 6000);
      assert.deepEqual(opened.filter((x) => x.startsWith("captions_v2:")), ["captions_v2:meet"], opened.join(","));
      await op.evaluate(() => window.__captionV2On(window.__meetV2, 8101, 1, "spaces/sp1/devices/dev-me", "Heard on Meet's own channel."));
      await waitFor(async () => (await meetings("meet", OWN_REF))[0]?.segments.some((s) => s.text === "Heard on Meet's own channel."), "caption from Meet's channel", 5000);
      assert.equal((await sentOn("captions_v2")).length, 0, "Meet acks its own channel, not us");
    });

    await check("Meet: reads Meet's newer nested captions_v2 packets; state packets aren't failures", async () => {
      const before = (await diag()).packetsRejected;
      await op.evaluate(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        window.__controlV2(window.__meetV2);
        window.__captionV2Nested(window.__meetV2, 1, 1, "spaces/sp1/devices/dev-me", "Good.");
        await wait(50);
        window.__captionV2Nested(window.__meetV2, 1, 3, "spaces/sp1/devices/dev-me", "Good afternoon everyone.");
        window.__controlV2(window.__meetV2);
      });
      await waitFor(async () => (await meetings("meet", OWN_REF))[0]?.segments.some((s) => s.text === "Good afternoon everyone."), "nested caption captured", 5000);
      const segs = (await meetings("meet", OWN_REF))[0].segments.filter((s) => s.text.startsWith("Good"));
      assert.equal(segs.length, 1, "one line, revised in place: " + JSON.stringify(segs.map((s) => s.text)));
      assert.equal((await diag()).packetsRejected, before, "state packets count as control, not rejects");
    });

    await check("Meet: a caption channel that drops is opened again", async () => {
      const count = () => op.evaluate(() => window.__opened.filter((c) => c.label === "captions" && c.id).length);
      const before = await count();
      await op.evaluate(() => window.__drop(window.__channels.captions));
      await waitFor(async () => (await count()) === before + 1, "captions reopened", 5000);
      const d = await diag();
      assert.ok(d.log.some((l) => l.message === "caption channel dropped, reopening"), JSON.stringify(d.log.slice(-5)));
    });

    await op.close();
    await waitFor(async () => (await meetings("meet", OWN_REF))[0]?.endedAt, "closing the tab ends the meeting", 5000);
  }

  await check("Vault sync: a title changed in the vault comes back, a deleted note is shown, a partial copy is marked", async () => {
    const extId = new URL(worker.url()).host;
    const app = await context.newPage();
    await app.goto(`chrome-extension://${extId}/app/meetings.html`);
    const msg = (m) => app.evaluate((m) => chrome.runtime.sendMessage(m), m);
    const start = Date.now() - 50 * 60000;
    const at = (min) => new Date(start + min * 60000).toISOString();
    const line = (i, speaker = "Jordan Lee") => ({ id: `vs-${i}`, startedAt: start + 3 * 60000 + i * 1000, speaker, speakerId: speaker, text: `Sync line ${i}.` });
    const id = "meet-vaultsync-20240609-103217";
    const base = { id, platform: "meet", meetingRef: "vsy-ncxx-abc", title: "vsy-ncxx-abc", tags: ["Acme"], startedAt: at(0), endedAt: at(28), updatedAt: at(28), segments: [1, 2, 3].map((i) => line(i)) };
    assert.ok((await msg({ kind: "import-meeting", meeting: base }))?.ok);
    const filed = await msg({ kind: "file-to-vault", meetingId: id });
    assert.ok(filed?.filed, JSON.stringify(filed));
    const stored = async () => (await worker.evaluate((k) => chrome.storage.local.get(k), `meeting:${id}`))[`meeting:${id}`];
    assert.equal((await stored()).lastFiling.title, "vsy-ncxx-abc");
    // The vault agent (or you) renames it in the vault: Earshot takes the title.
    const note = path.join(vaultPath, filed.note);
    writeFileSync(note, readFileSync(note, "utf8").replace(/^title: .*$/m, 'title: "Acme pricing review"'));
    const res = await msg({ kind: "vault-sync", force: true });
    assert.ok(res?.ok && res.changed >= 1, JSON.stringify(res));
    await waitFor(async () => (await stored())?.title === "Acme pricing review", "vault title taken", 5000);
    assert.equal((await stored()).vaultNote, filed.note, "the note stays where it is");
    // Deleted in Obsidian (moved to the vault's .trash): the meeting says so and offers to file it again.
    mkdirSync(path.join(vaultPath, ".trash"), { recursive: true });
    renameSync(note, path.join(vaultPath, ".trash", path.basename(note)));
    await msg({ kind: "vault-sync", force: true });
    await waitFor(async () => (await stored())?.vaultMissing?.trashed === true, "missing note marked", 5000);
    // A Mac recording of the same call, in full: this one is the partial copy.
    const mac = { id: "mac-mac-20240609-103551", platform: "mac", title: "Acme pricing review (Mac)", tags: [], startedAt: at(3), endedAt: at(28), updatedAt: at(28), segments: Array.from({ length: 12 }, (_, i) => line(i + 10, "Me")) };
    assert.ok((await msg({ kind: "import-meeting", meeting: mac }))?.ok);
    await app.goto(`chrome-extension://${extId}/app/meetings.html#${encodeURIComponent(id)}`);
    await app.reload(); // a hash change alone doesn't open a meeting
    await app.locator("h1", { hasText: "Acme pricing review" }).waitFor();
    await app.locator(".notice", { hasText: "was deleted in Obsidian" }).waitFor({ timeout: 5000 });
    await app.locator(".notice", { hasText: "partial copy of \"Acme pricing review (Mac)\"" }).waitFor({ timeout: 5000 });
    assert.equal(await app.locator(".bar button", { hasText: "Open in Obsidian" }).count(), 0, "no link to a deleted note");
    assert.ok(await app.locator("#list .item", { hasText: "Partial copy" }).count() >= 1, "marked in the list");
    await app.locator(".notice button", { hasText: "File it again" }).click();
    await waitFor(async () => !(await stored())?.vaultMissing, "missing mark cleared", 5000);
    // Filed again under the title it has now.
    const again = (await stored()).vaultNote;
    assert.match(again, /Acme pricing review\.md$/);
    assert.ok(existsSync(path.join(vaultPath, again)), again);
    await app.locator(".notice", { hasText: "was deleted in Obsidian" }).waitFor({ state: "detached", timeout: 5000 });
    for (const m of [id, mac.id]) await msg({ kind: "delete-meeting", id: m });
    await app.close();
  });
}

// An expired Claude sign-in is caught when a meeting starts: red bar in the panel and a notification.
export async function aiHealthSuite({ context, worker, check, earshotHome }) {
  const configFile = path.join(earshotHome, "config.json");
  const original = readFileSync(configFile, "utf8");
  const expired = path.resolve(path.dirname(new URL(import.meta.url).pathname), "fixtures/expired-claude/claude");
  const config = JSON.parse(original);
  config.ai.ask = { label: "Claude Haiku", command: expired, args: ["-p", "--model", "haiku"] };
  config.ai.account = { configDir: "/Users/someone/.claude-enterprise", orgName: "Example Org, Inc.", subscriptionType: "enterprise" };
  writeFileSync(configFile, JSON.stringify(config));

  await check("AI health: an expired sign-in shows in the panel and as a notification", async () => {
    const p = await context.newPage();
    await p.goto("https://meet.google.com/aaa-bbbb-ccc");
    await p.evaluate(() => window.__join());
    const warn = p.locator("earshot-overlay .aiwarn");
    await waitFor(async () => !(await warn.evaluate((w) => w.classList.contains("hidden")).catch(() => true)), "warning bar", 10000);
    const text = await warn.innerText();
    assert.match(text, /sign-in has expired/);
    assert.match(text, /CLAUDE_CONFIG_DIR=\/Users\/someone\/\.claude-enterprise \S*claude auth login/);
    const notes = await worker.evaluate(() => new Promise((r) => chrome.notifications.getAll(r)));
    assert.ok(notes["earshot-ai"], "notification shown");
    await p.close();
  });

  writeFileSync(configFile, original);
}
