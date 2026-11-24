// Zoom web client suite: fake Zoom pages served at real zoom.us URLs, with
// the same store slices and socket the real client uses.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fixture, sleep, waitFor, overlayText, menuDownload } from "./harness.mjs";

// Plays a short conversation into a frame's fake store, including a caption
// that Zoom revises in place and a burst of unrelated store updates.
async function playConversation(frame) {
  await frame.evaluate(async () => {
    const s = window.__store;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    s.dispatch({ type: "JOIN" });
    s.dispatch({ type: "TOPIC", topic: "Dashboard review" });
    s.dispatch({
      type: "ROSTER",
      people: [
        { userId: 16778240, zoomID: "zJordan", displayName: "Jordan Lee" },
        { userId: 16779264, zoomID: "zPriya", displayName: "Priya Nair" },
        { userId: 16780288, zoomID: "zSam", displayName: "Sam Ortiz" },
      ],
    });
    s.dispatch({ type: "LANG", lang: 0 });
    s.dispatch({ type: "LT", msg: { msgId: "m1", user: { zoomID: "zJordan", displayName: "Jordan Lee" }, text: "Sure", language: 0 } });
    await wait(300);
    s.dispatch({ type: "LT", msg: { msgId: "m1", user: { zoomID: "zJordan", displayName: "Jordan Lee" }, text: "Sure, go ahead.", language: 0 } });
    for (let i = 0; i < 50; i++) s.dispatch({ type: "NOISE" });
    s.dispatch({ type: "LT", msg: { msgId: "m2", user: { zoomID: "zPriya", displayName: "Priya Nair" }, text: "\fI pushed the new build this morning\u0000", language: 0 } });
    await wait(300);
    s.dispatch({ type: "LT", msg: { msgId: "m3", user: { zoomID: "zSam", displayName: "Sam Ortiz" }, text: "Right. Sounds good to me.", language: 0 } });
    s.dispatch({ type: "LT", msg: { msgId: "m4", user: { zoomID: "zSam", displayName: "Sam Ortiz" }, text: "Let's keep going.", language: 0 } });
  });
}

export async function zoomSuite({ context, worker, storage, check, meetings }) {
  const meetingsFor = (ref) => meetings("zoom", ref);

  // Serve the fake web client for every zoom.us URL.
  await context.route(/^https:\/\/([a-z0-9-]+\.)?zoom\.us\//, (route) => {
    const url = new URL(route.request().url());
    let body = "<!doctype html><title>zoom launcher</title><p>launcher</p>";
    if (url.pathname.startsWith("/wc/")) {
      body = url.searchParams.get("mode") === "pwa" ? fixture("fake-zoom-pwa-wrapper.html") : fixture("fake-zoom-meeting.html");
    }
    route.fulfill({ status: 200, contentType: "text/html", body });
  });

  // ---------------------------------------------------------------- main flow (store via global Redux)
  const page = await context.newPage();
  await page.goto("https://app.zoom.us/wc/81234567890/join?mode=trap");

  await check("overlay appears on a web-client meeting page", async () => {
    await page.locator("earshot-overlay .panel").waitFor({ timeout: 5000 });
  });

  await check("finds the store through the global Redux library", async () => {
    await waitFor(async () => (await page.locator("earshot-overlay .status").innerText()).includes("Connected"), "connected status");
  });

  await playConversation(page);

  await check("overlay shows captions under each speaker's name", async () => {
    const text = await waitFor(async () => {
      const t = await overlayText(page);
      return t.includes("Let's keep going.") && t;
    }, "last caption in overlay");
    for (const s of ["Jordan Lee", "Priya Nair", "Sam Ortiz", "Sure, go ahead.", "I pushed the new build this morning"]) {
      assert.ok(text.includes(s), `overlay missing "${s}"\n${text}`);
    }
    assert.ok(!/Sure\s+Sure/.test(text), "revised caption was duplicated instead of updated");
    // Each utterance is its own block, with the speaker's name once per turn.
    assert.ok(text.includes("Right. Sounds good to me.") && text.includes("Let's keep going."));
    assert.equal(text.split("Sam Ortiz").length - 1, 1, `speaker name repeated within one turn:\n${text}`);
  });

  await check("status turns live once captions flow", async () => {
    await waitFor(async () => (await page.locator("earshot-overlay header .dot").getAttribute("class")).includes("live"), "live dot");
  });

  await check("saves the meeting with speakers, title and roster", async () => {
    const [meeting] = await waitFor(async () => {
      const ms = await meetingsFor("81234567890");
      return ms.length && ms[0].segments.length === 4 && ms;
    }, "4 saved segments");
    assert.equal(meeting.title, "Dashboard review");
    assert.deepEqual(
      meeting.segments.map((s) => [s.speaker, s.text]),
      [
        ["Jordan Lee", "Sure, go ahead."],
        ["Priya Nair", "I pushed the new build this morning"],
        ["Sam Ortiz", "Right. Sounds good to me."],
        ["Sam Ortiz", "Let's keep going."],
      ]
    );
    assert.equal(meeting.segments[0].speakerId, "zJordan");
    // The roster is sent at most every 2s, so give it a moment to land.
    const people = await waitFor(async () => {
      const [m] = await meetingsFor("81234567890");
      return Object.keys(m.participants).length === 3 && Object.values(m.participants).sort();
    }, "3 participants", 5000);
    assert.deepEqual(people, ["Jordan Lee", "Priya Nair", "Sam Ortiz"]);
    const { meetingIndex } = await storage();
    assert.ok(meetingIndex.some((r) => r.id === meeting.id && r.segmentCount === 4), "meeting index not updated");
  });

  await check("asks Zoom to turn captions on after joining (4285, then 4305 in English)", async () => {
    const sent = await waitFor(async () => {
      const s = await page.evaluate(() => window.__sent);
      return s.length >= 2 && s;
    }, "two socket messages", 9000);
    assert.deepEqual(sent[0], { evt: 4285 });
    assert.deepEqual(sent[1], { evt: 4305, body: { type: 6, lang: 0, nodeid: 0 } });
  });

  if (process.env.SCREENSHOT) {
    await page.setViewportSize({ width: 1280, height: 760 });
    await page.screenshot({ path: process.env.SCREENSHOT });
  }

  await check("Export .md downloads a speaker-tagged transcript", async () => {
    const download = await menuDownload(page, "export-md");
    assert.match(download.suggestedFilename(), /Dashboard review\.md$/);
    const md = readFileSync(await download.path(), "utf8");
    assert.match(md, /^# Dashboard review/);
    assert.match(md, /\*\*Jordan Lee\*\* \[\d\d:\d\d\]\nSure, go ahead\./);
    assert.match(md, /\*\*Sam Ortiz\*\* \[\d\d:\d\d\]\nRight\. Sounds good to me\.\n\nLet's keep going\./);
  });

  await check("Debug info downloads a report of what the hook sees", async () => {
    const download = await menuDownload(page, "debug");
    const report = JSON.parse(readFileSync(await download.path(), "utf8"));
    const frame = report.frames.find((f) => f.storeFound);
    assert.ok(frame, "no frame reported a store");
    assert.equal(frame.foundVia, "redux-global.createStore");
    assert.ok(frame.stateKeys.includes("newLiveTranscription"));
    assert.ok(frame.sampleCaption && "user" in frame.sampleCaption, "sample caption shape missing");
  });

  await check("a page reload continues the same meeting record", async () => {
    await page.reload();
    await waitFor(async () => (await overlayText(page)).includes("Let's keep going."), "overlay restored after reload");
    await page.evaluate(() => {
      window.__store.dispatch({ type: "JOIN" });
      window.__store.dispatch({ type: "LT", msg: { msgId: "m9", user: { zoomID: "zJordan", displayName: "Jordan Lee" }, text: "We're back.", language: 0 } });
    });
    const ms = await waitFor(async () => {
      const list = await meetingsFor("81234567890");
      return list[0]?.segments.length === 5 && list;
    }, "5 segments after reload");
    assert.equal(ms.length, 1, "reload created a second meeting record");
  });

  await check("leaving the meeting (staying on the Zoom page) closes the panel and launcher", async () => {
    await page.evaluate(() => window.__store.dispatch({ type: "LEAVE" }));
    await waitFor(async () => (await page.locator("earshot-overlay").count()) === 0, "panel gone", 8000);
    await waitFor(async () => (await meetingsFor("81234567890"))[0]?.endedAt, "meeting ended");
  });

  await check("rejoining the same meeting the same day picks the transcript back up", async () => {
    await page.evaluate(() => {
      window.__store.dispatch({ type: "JOIN" });
      window.__store.dispatch({ type: "LT", msg: { msgId: "m20", user: { zoomID: "zJordan", displayName: "Jordan Lee" }, text: "Picking up where we left off.", language: 0 } });
    });
    await page.locator("earshot-overlay .panel").waitFor({ timeout: 5000 });
    const ms = await waitFor(async () => {
      const list = await meetingsFor("81234567890");
      return list[0]?.segments.some((s) => s.text === "Picking up where we left off.") && list;
    }, "rejoined record");
    assert.equal(ms.length, 1, "rejoin created a second record");
    assert.equal(ms[0].endedAt, null);
    assert.ok((await overlayText(page)).includes("Sure, go ahead."), "earlier transcript should be back in the panel");
  });

  await check("with 'Open the panel when a meeting starts' off, a meeting starts as just the launcher, which confirms the first lines", async () => {
    await worker.evaluate(() => chrome.storage.local.set({ panelOpenOnJoin: false }));
    const p = await context.newPage();
    await p.goto("https://app.zoom.us/wc/333444555/join?mode=trap");
    await p.waitForFunction(() => !!window.__store);
    await p.evaluate(() => window.__store.dispatch({ type: "JOIN" }));
    await p.locator("earshot-overlay .launcher").waitFor({ timeout: 5000 });
    assert.equal(await p.locator("earshot-overlay .panel").isVisible(), false, "panel should stay closed");
    assert.equal(await p.evaluate(() => document.documentElement.hasAttribute("data-earshot-docked")), false);
    await p.evaluate(() => window.__store.dispatch({ type: "LT", msg: { msgId: "c1", user: { zoomID: "zJordan", displayName: "Jordan Lee" }, text: "Can everyone hear me?", language: 0 } }));
    const note = p.locator("earshot-overlay .launcher .note.show");
    await note.waitFor({ timeout: 4000 });
    assert.match(await note.innerText(), /Capturing/);
    const [launcherBox, noteBox] = [await p.locator("earshot-overlay .launcher").boundingBox(), await note.boundingBox()];
    assert.ok(noteBox.x + noteBox.width <= launcherBox.x + 1, "bubble sits on the open side (left of a right-edge launcher)");
    await worker.evaluate(() => chrome.storage.local.set({ panelOpenOnJoin: true }));
    await p.close();
  });

  // ---------------------------------------------------------------- store only on the React tree
  await check("finds the store on the React tree when there is no global Redux", async () => {
    const p = await context.newPage();
    await p.goto("https://us02web.zoom.us/wc/222333444/join?mode=fiber");
    await playConversation(p);
    await waitFor(async () => (await overlayText(p)).includes("Let's keep going."), "captions in overlay");
    const [m] = await waitFor(async () => {
      const ms = await meetingsFor("222333444");
      return ms[0]?.segments.length === 4 && ms;
    }, "saved segments");
    assert.equal(m.title, "Dashboard review");
    await p.close();
  });

  // ---------------------------------------------------------------- meeting inside an iframe (PWA client)
  await check("works when the meeting runs in a same-origin iframe, overlay only on top", async () => {
    const p = await context.newPage();
    await p.goto("https://app.zoom.us/wc/555000111/join?mode=pwa");
    const frame = await waitFor(async () => p.frames().find((f) => f.url().includes("/meeting")), "meeting iframe");
    await frame.waitForFunction(() => !!window.__store);
    await sleep(300);
    await playConversation(frame);
    await waitFor(async () => (await overlayText(p)).includes("Let's keep going."), "captions in top-frame overlay");
    assert.equal(await frame.locator("earshot-overlay").count(), 0, "overlay should not render inside the iframe");
    await p.close();
  });

  // ---------------------------------------------------------------- setting: auto captions off
  await check("does not touch Zoom's socket when auto captions is off", async () => {
    await worker.evaluate(() => chrome.storage.local.set({ autoCaptions: false }));
    const p = await context.newPage();
    await p.goto("https://app.zoom.us/wc/777888999/join?mode=trap");
    await p.locator("earshot-overlay .panel").waitFor();
    await sleep(1200);
    await p.evaluate(() => window.__store.dispatch({ type: "JOIN" }));
    await sleep(6500);
    assert.deepEqual(await p.evaluate(() => window.__sent), []);
    await worker.evaluate(() => chrome.storage.local.set({ autoCaptions: true }));
    await p.close();
  });

  // ---------------------------------------------------------------- Zoom links open in the web client
  await check("redirects zoom.us/j links to the web client", async () => {
    const p = await context.newPage();
    await p.goto("https://zoom.us/j/81234567890?pwd=abc123");
    assert.equal(p.url(), "https://zoom.us/wc/81234567890/join?pwd=abc123");
    await p.goto("https://us02web.zoom.us/j/81234567890?pwd=abc123#success");
    assert.equal(p.url(), "https://us02web.zoom.us/wc/81234567890/join?pwd=abc123#success");
    await p.goto("https://zoom.us/s/81234567890?zak=x");
    assert.equal(p.url(), "https://zoom.us/wc/81234567890/start?zak=x");
    await p.close();
  });

}
