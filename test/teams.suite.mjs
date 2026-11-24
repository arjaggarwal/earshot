// Teams suite: fake signed-in Teams (calling engine) and fake guest meeting
// (data channel + roster socket), served at real teams.microsoft.com URLs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fixture, sleep, waitFor, overlayText, menuDownload } from "./harness.mjs";

const CALL_ID = "19:meeting_NjQ5ZTk2YjQ@thread.v2";

export async function teamsSuite({ context, worker, check, meetings }) {
  await context.route(/^https:\/\/teams\.(microsoft\.com|cloud\.microsoft)\//, (route) => {
    const url = new URL(route.request().url());
    const body = url.pathname.startsWith("/light-meetings/") ? fixture("fake-teams-guest.html") : fixture("fake-teams-v2.html");
    route.fulfill({ status: 200, contentType: "text/html", body });
  });

  // ---------------------------------------------------------------- signed-in Teams
  const page = await context.newPage();
  await page.goto("https://teams.microsoft.com/v2/");

  await check("Teams: no panel while you're just in chat", async () => {
    await sleep(1500);
    assert.equal(await page.locator("earshot-overlay").count(), 0);
  });

  await page.evaluate((callId) => {
    window.__join({
      callId,
      subject: "Weekly client sync",
      selfMri: "8:orgid:alex",
      selfName: "Alex Kestrel",
      participants: [
        { mri: "8:orgid:jordan", displayName: "Jordan Lee" },
        { mri: "8:orgid:priya", displayName: "Priya Nair" },
      ],
    });
  }, CALL_ID);

  await check("Teams: panel appears when a call connects", async () => {
    await page.locator("earshot-overlay .panel").waitFor({ timeout: 5000 });
    await waitFor(async () => (await page.locator("earshot-overlay .meta").innerText()).includes("Weekly client sync"), "meeting title");
  });

  await check("Teams: turns on captions through the call", async () => {
    await waitFor(() => page.evaluate(() => window.__activeCall._cc === 2), "captions started", 6000);
    await waitFor(async () => (await page.locator("earshot-overlay .status").innerText()).includes("Asked Teams"), "status after request");
  });

  await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__caption([{ id: "a1/1", userId: "8:orgid:jordan", text: "So the", timestampAudioSent: 1000, spokenLanguage: "en-us" }]);
    await wait(150);
    window.__caption([{ id: "a1/2", userId: "8:orgid:jordan", text: "So the release notes are ready.", timestampAudioSent: 1000, spokenLanguage: "en-us" }]);
    // A late, older revision must not overwrite the newer text.
    window.__caption([{ id: "a1/1", userId: "8:orgid:jordan", text: "So the", timestampAudioSent: 1000 }]);
    window.__caption([{ id: "b1/1", userId: "8:orgid:alex", text: "Great, send it over.", timestampAudioSent: 2000 }]);
    window.__caption([{ id: "c1/1", userId: "8:orgid:dana", text: "Hi, joining late.", timestampAudioSent: 3000 }]);
  });

  await check("Teams: captions show under each speaker's name, you included", async () => {
    const text = await waitFor(async () => {
      const t = await overlayText(page);
      return t.includes("Hi, joining late.") && t;
    }, "captions in overlay");
    assert.ok(text.includes("Jordan Lee") && text.includes("So the release notes are ready."), text);
    assert.ok(!/So the\s+So the/.test(text), `revision duplicated:\n${text}`);
    assert.ok(text.includes("Alex Kestrel") && text.includes("Great, send it over."), text);
  });

  await check("Teams: Teams still receives every caption event", async () => {
    assert.deepEqual(await page.evaluate(() => window.__delivered), ["3", "3", "3", "3", "3"]);
  });

  await check("Teams: a speaker who joins late gets their name once they're on the roster", async () => {
    assert.ok((await overlayText(page)).includes("Participant dana"), "expected a placeholder before the roster updates");
    await page.evaluate(() => window.__activeCall.participants.push({ mri: "8:orgid:dana", displayName: "Dana Lee" }));
    await waitFor(async () => (await overlayText(page)).includes("Dana Lee"), "Dana's name in overlay", 6000);
    const [m] = await waitFor(async () => {
      const ms = await meetings("teams", CALL_ID);
      return ms[0]?.segments.find((s) => s.speaker === "Dana Lee") && ms;
    }, "Dana's name saved", 4000);
    assert.equal(m.title, "Weekly client sync");
    assert.deepEqual(
      m.segments.map((s) => [s.speaker, s.text]),
      [
        ["Jordan Lee", "So the release notes are ready."],
        ["Alex Kestrel", "Great, send it over."],
        ["Dana Lee", "Hi, joining late."],
      ]
    );
  });

  await check("Teams: Export .md labels the platform and speakers", async () => {
    const download = await menuDownload(page, "export-md");
    const md = readFileSync(await download.path(), "utf8");
    assert.match(md, /^# Weekly client sync/);
    assert.match(md, /- Platform: Teams/);
    assert.match(md, /\*\*Dana Lee\*\* \[\d\d:\d\d\]\nHi, joining late\./);
  });

  await check("Teams: Debug info reports the call and caption hook", async () => {
    const download = await menuDownload(page, "debug");
    const report = JSON.parse(readFileSync(await download.path(), "utf8"));
    const frame = report.frames.find((f) => f.hasCallingEngine);
    assert.ok(frame, "no frame reported the calling engine");
    assert.equal(frame.captionsHooked, true);
    assert.ok(frame.ticks > 0, "the call check never ran");
    assert.equal(frame.tickErrors, 0, frame.lastTickError || "");
    assert.deepEqual(frame.dataChannelSubscriptions, ["participantsChanged", "remoteUserEventsReceived"]);
  });

  await check("Teams: leaving ends the meeting and restores Teams' handler", async () => {
    await page.evaluate(() => window.__leave());
    await waitFor(async () => {
      const [m] = await meetings("teams", CALL_ID);
      return m?.endedAt;
    }, "endedAt saved", 5000);
    const restored = await page.evaluate(() => !window.__lastCall.dataChannel.subscriptions[1].eventHandler.on.handler.__earshot);
    assert.ok(restored, "caption handler still wrapped after the call ended");
  });

  await check("Teams: a second call in the same tab is a new meeting", async () => {
    await page.evaluate(() => {
      window.__join({ callId: "19:meeting_second@thread.v2", subject: "Second call", selfMri: "8:orgid:alex", selfName: "Alex Kestrel", participants: [] });
    });
    await waitFor(() => page.evaluate(() => window.__activeCall._cc === 2), "captions on second call", 6000);
    await page.evaluate(() => window.__caption([{ id: "z/1", userId: "8:orgid:alex", text: "New call.", timestampAudioSent: 1 }]));
    await waitFor(async () => (await meetings("teams", "19:meeting_second@thread.v2"))[0]?.segments.length === 1, "second meeting saved");
    assert.equal((await meetings("teams", CALL_ID))[0].segments.length, 3, "first meeting changed");
    const text = await waitFor(async () => {
      const t = await overlayText(page);
      return t.includes("New call.") && t;
    }, "second call in overlay");
    assert.ok(!text.includes("Hi, joining late."), `panel still shows the first call:\n${text}`);
    assert.ok((await page.locator("earshot-overlay .meta").innerText()).includes("Second call"));
  });
  await check("Teams: rejoining a meeting with the same title the same day continues it", async () => {
    await page.evaluate(() => window.__leave());
    await waitFor(async () => (await meetings("teams", "19:meeting_second@thread.v2"))[0]?.endedAt, "second call ended");
    await page.evaluate(() => {
      window.__join({ callId: "19:meeting_rejoin@thread.v2", subject: "Weekly client sync", selfMri: "8:orgid:alex", selfName: "Alex Kestrel", participants: [{ mri: "8:orgid:jordan", displayName: "Jordan Lee" }] });
    });
    await waitFor(() => page.evaluate(() => window.__activeCall._cc === 2), "captions on rejoin", 6000);
    await page.evaluate(() => window.__caption([{ id: "r/1", userId: "8:orgid:jordan", text: "Back again.", timestampAudioSent: 50 }]));
    const all = await waitFor(async () => {
      const list = (await meetings("teams")).filter((m) => m.title === "Weekly client sync");
      return list.length === 1 && list[0].segments.some((s) => s.text === "Back again.") && list;
    }, "rejoined into the first record", 8000);
    assert.ok(all[0].segments.some((s) => s.text === "So the release notes are ready."), "earlier lines kept");
    assert.ok((await overlayText(page)).includes("So the release notes are ready."), "panel shows the earlier transcript again");
  });
  await page.close();

  // ---------------------------------------------------------------- the new Teams host, and calls that wobble
  const CLOUD_CALL = "19:meeting_cloud@thread.v2";
  const cloud = await context.newPage();
  await cloud.goto("https://teams.cloud.microsoft/");
  const cloudLines = async () => (await meetings("teams", CLOUD_CALL))[0]?.segments.map((s) => s.text) || [];
  const say = (id, text, at) => cloud.evaluate(([id, text, at]) => window.__caption([{ id, userId: "8:orgid:jordan", text, timestampAudioSent: at }]), [id, text, at]);

  await check("Teams at teams.cloud.microsoft: a call is captured", async () => {
    await cloud.evaluate((callId) => {
      window.__join({ callId, subject: "Cloud host call", selfMri: "8:orgid:alex", selfName: "Alex Kestrel", participants: [{ mri: "8:orgid:jordan", displayName: "Jordan Lee" }] });
    }, CLOUD_CALL);
    await cloud.locator("earshot-overlay .panel").waitFor({ timeout: 5000 });
    await waitFor(() => cloud.evaluate(() => window.__activeCall._cc === 2), "captions started", 6000);
    await say("k/1", "Hello from the new host.", 10);
    await waitFor(async () => (await cloudLines()).includes("Hello from the new host."), "line saved");
  });

  await check("Teams: a hold, or Teams handing back a new object for the same call, doesn't end the meeting", async () => {
    const left = await cloud.evaluate(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const left = [];
      const on = (e) => {
        const m = JSON.parse(e.detail);
        if (m.type === "join-status" && m.status === "left") left.push(m.ref);
      };
      document.documentElement.addEventListener("earshot:page", on);
      window.__activeCall.state = 4; // on hold: not "connected" for a moment
      await wait(1500);
      window.__activeCall.state = 3;
      const copy = Object.assign({}, window.__activeCall); // same call id, new object
      window.__activeCall = copy;
      window.__engine.callingService.callRegistry.calls = [copy];
      await wait(1500);
      document.documentElement.removeEventListener("earshot:page", on);
      return left;
    });
    assert.deepEqual(left, [], "the hold or the new call object counted as leaving");
    await say("k2/1", "Still here after the hold.", 20);
    await waitFor(async () => (await cloudLines()).includes("Still here after the hold."), "line after the hold");
    const list = await meetings("teams", CLOUD_CALL);
    assert.equal(list.length, 1, "the hold started a second record");
    assert.equal(list[0].endedAt, null, "the hold ended the meeting");
  });

  await check("Teams: when Teams rebuilds its caption feed mid-call, captions keep coming", async () => {
    await cloud.evaluate(() => {
      window.__activeCall.dataChannel.subscriptions[1] = { eventHandler: { on: { name: "remoteUserEventsReceived", handler: (channel) => window.__delivered.push(channel) } } };
    });
    await sleep(1500);
    await say("k3/1", "After the rebuild.", 30);
    await waitFor(async () => (await cloudLines()).includes("After the rebuild."), "line after the rebuild");
  });

  await check("Teams: a bridge that arrives late gets the meeting replayed", async () => {
    const types = await cloud.evaluate(async () => {
      const got = [];
      const on = (e) => got.push(JSON.parse(e.detail).type);
      document.documentElement.addEventListener("earshot:page", on);
      document.documentElement.dispatchEvent(new CustomEvent("earshot:cmd", { detail: JSON.stringify({ type: "resync" }) }));
      await new Promise((r) => setTimeout(r, 300));
      document.documentElement.removeEventListener("earshot:page", on);
      return got;
    });
    assert.ok(types.includes("store-found") && types.includes("join-status"), types.join(","));
  });
  await cloud.close();

  await check("Teams like the real one (2026-11): getActiveCall() says nothing, the registry has the connected call", async () => {
    const p = await context.newPage();
    await p.goto("https://teams.cloud.microsoft/");
    await p.evaluate(() => {
      window.__engine.callingService.getActiveCall = () => null;
      window.__join({ callId: "19:meeting_registry@thread.v2", subject: "Registry only call", selfMri: "8:orgid:alex", selfName: "Alex Kestrel", participants: [{ mri: "8:orgid:jordan", displayName: "Jordan Lee" }] });
    });
    await p.locator("earshot-overlay .panel").waitFor({ timeout: 5000 });
    await waitFor(() => p.evaluate(() => window.__activeCall._cc === 2), "captions started", 6000);
    await p.evaluate(() => window.__caption([{ id: "g/1", userId: "8:orgid:jordan", text: "Found through the registry.", timestampAudioSent: 5 }]));
    await waitFor(async () => (await meetings("teams", "19:meeting_registry@thread.v2"))[0]?.segments.some((s) => s.text === "Found through the registry."), "line saved");
    await p.evaluate(() => window.__leave());
    await waitFor(async () => (await meetings("teams", "19:meeting_registry@thread.v2"))[0]?.endedAt, "ended once it left the registry", 8000);
    await p.close();
  });

  await check("Teams like the real one (2026-11): your ID comes without the 8: prefix, captions with it; names still match", async () => {
    const p = await context.newPage();
    await p.goto("https://teams.cloud.microsoft/");
    await p.evaluate(() => {
      window.__join({ callId: "19:meeting_prefix@thread.v2", subject: "Prefix call", selfMri: "orgid:alex-guid", selfName: "Alex Kestrel", participants: [{ mri: "orgid:jordan-guid", displayName: "Jordan Lee" }] });
    });
    await waitFor(() => p.evaluate(() => window.__activeCall._cc === 2), "captions started", 6000);
    await p.evaluate(() => {
      window.__caption([{ id: "p1/1", userId: "8:orgid:alex-guid", text: "This is me talking.", timestampAudioSent: 10 }]);
      window.__caption([{ id: "p2/1", userId: "8:orgid:jordan-guid", text: "And this is Jordan.", timestampAudioSent: 20 }]);
    });
    const [m] = await waitFor(async () => {
      const ms = await meetings("teams", "19:meeting_prefix@thread.v2");
      return ms[0]?.segments.length >= 2 && ms;
    }, "both lines saved");
    const by = Object.fromEntries(m.segments.map((s) => [s.text, s.speaker]));
    assert.equal(by["This is me talking."], "Alex Kestrel", JSON.stringify(by));
    assert.equal(by["And this is Jordan."], "Jordan Lee", JSON.stringify(by));
    await p.evaluate(() => window.__leave());
    await p.close();
  });

  await check("Don't record this meeting: deletes it, closes the panel, ignores the rest of the call; the next call records", async () => {
    const p = await context.newPage();
    await p.goto("https://teams.cloud.microsoft/");
    const ref = "19:meeting_discard@thread.v2";
    await p.evaluate((callId) => {
      window.__join({ callId, subject: "Private chat", selfMri: "8:orgid:alex", selfName: "Alex Kestrel", participants: [{ mri: "8:orgid:jordan", displayName: "Jordan Lee" }] });
    }, ref);
    await waitFor(() => p.evaluate(() => window.__activeCall._cc === 2), "captions started", 6000);
    await p.evaluate(() => window.__caption([{ id: "d/1", userId: "8:orgid:jordan", text: "Off the record please.", timestampAudioSent: 5 }]));
    await waitFor(async () => (await meetings("teams", ref)).length === 1, "meeting saved first");
    // Open the panel if it started as the launcher.
    if (!(await p.locator("earshot-overlay .panel").count())) await p.locator("earshot-overlay .launcher").click();
    assert.equal(await p.locator('earshot-overlay header [data-act="stop"]').isVisible(), false, "Mac-only Stop shows in the browser");
    await p.locator('earshot-overlay header [data-act="discard"]').click();
    await p.locator('earshot-overlay [data-act="discard-yes"]').click();
    await waitFor(async () => (await meetings("teams", ref)).length === 0, "meeting deleted");
    await waitFor(async () => (await p.locator("earshot-overlay").count()) === 0, "panel gone");
    await p.evaluate(() => window.__caption([{ id: "d/2", userId: "8:orgid:jordan", text: "Still talking.", timestampAudioSent: 9 }]));
    await sleep(2500);
    assert.equal((await meetings("teams", ref)).length, 0, "recorded again after Don't record");
    assert.equal(await p.locator("earshot-overlay").count(), 0, "panel came back");
    // Hang up; the next call is recorded as usual.
    await p.evaluate(() => window.__leave());
    await sleep(4500);
    const next = "19:meeting_after_discard@thread.v2";
    await p.evaluate((callId) => window.__join({ callId, subject: "Next call", selfMri: "8:orgid:alex", selfName: "Alex Kestrel", participants: [] }), next);
    await waitFor(async () => (await meetings("teams", next)).length === 1, "next call recorded", 8000);
    await p.close();
  });

  await check("Teams like the real one (2026-11): page timers are cleared after load, the call is still picked up", async () => {
    const p = await context.newPage();
    await p.goto("https://teams.cloud.microsoft/");
    await sleep(1500); // let the hook's timers start, then kill every one, as real Teams seems to
    await p.evaluate(() => {
      for (let i = 1; i < 100000; i++) {
        clearInterval(i);
        clearTimeout(i);
      }
      window.__engine.callingService.getActiveCall = () => null;
      window.__join({ callId: "19:meeting_cleared@thread.v2", subject: "Timers cleared call", selfMri: "8:orgid:alex", selfName: "Alex Kestrel", participants: [{ mri: "8:orgid:jordan", displayName: "Jordan Lee" }] });
    });
    // A real call's screen keeps changing; that alone has to be enough to notice the call.
    const churn = setInterval(() => p.evaluate(() => (document.getElementById("app").textContent = `in call ${Date.now()}`)).catch(() => {}), 300);
    try {
      await waitFor(() => p.evaluate(() => window.__activeCall._cc === 2), "captions started", 8000);
      await p.evaluate(() => window.__caption([{ id: "t/1", userId: "8:orgid:jordan", text: "Timers or not, I'm here.", timestampAudioSent: 5 }]));
      await waitFor(async () => (await meetings("teams", "19:meeting_cleared@thread.v2"))[0]?.segments.some((s) => s.text === "Timers or not, I'm here."), "line saved");
      await p.locator("earshot-overlay .panel, earshot-overlay .launcher").first().waitFor({ timeout: 6000 });
    } finally {
      clearInterval(churn);
    }
    await p.close();
  });

  await check("After Earshot reloads, an open Teams tab without the hook gets it, and Teams' captions-failed banner shows", async () => {
    const p = await context.newPage();
    await p.goto("https://teams.cloud.microsoft/");
    await p.evaluate(() => {
      delete window.__earshotTeamsHook;
      document.documentElement.removeAttribute("data-earshot-teams-hook");
    });
    await worker.evaluate(() => reattachOpenTabs());
    assert.equal(await p.evaluate(() => document.documentElement.getAttribute("data-earshot-teams-hook")), "4", "hook not re-injected");
    await p.evaluate(() => {
      window.__join({ callId: "19:meeting_nocc@thread.v2", subject: "No captions call", selfMri: "8:orgid:alex", selfName: "Alex Kestrel", participants: [] });
      window.__activeCall.startClosedCaption = () => document.body.append(Object.assign(document.createElement("div"), { id: "ufd_title_ClosedCaptionsStartFailed", textContent: "Captions failed" }));
    });
    await waitFor(async () => (await p.locator("earshot-overlay .status").innerText().catch(() => "")).includes("couldn't start captions"), "captions-failed hint", 8000);
    await p.close();
  });

  // ---------------------------------------------------------------- guest join (light meetings)
  await check("Teams guest: captions from the data channel, names from roster updates", async () => {
    const p = await context.newPage();
    await p.goto("https://teams.microsoft.com/light-meetings/launch?coords=eyJmYWtlIjoxfQ");
    await p.evaluate(() => window.__showCallControls());
    await p.locator("earshot-overlay .panel").waitFor({ timeout: 5000 });
    await waitFor(() => p.evaluate(() => window.__ccClicked === true), "captions turned on from the menu", 5000);

    await p.evaluate(() => {
      window.__frame({ recognitionResults: [{ id: "g1/1", userId: "8:guest:jon", text: "Can everyone hear me?", timestampAudioSent: 10 }] });
      window.__frame({ somethingElse: true });
      window.__frame({ recognitionResults: [{ id: "g1/2", userId: "8:guest:jon", text: "Can everyone hear me okay?", timestampAudioSent: 10 }] });
    });
    await waitFor(async () => (await overlayText(p)).includes("Can everyone hear me okay?"), "guest caption in overlay");
    assert.ok((await overlayText(p)).includes("Participant :jon"), "expected placeholder before roster");

    await p.evaluate(() => window.__roster({ a: { details: { id: "8:guest:jon", displayName: "Jordan Lee" } } }));
    await waitFor(async () => (await overlayText(p)).includes("Jordan Lee"), "name from roster", 5000);
    const [m] = await waitFor(async () => {
      const ms = (await meetings("teams")).filter((x) => x.meetingRef?.startsWith("guest-"));
      return ms[0]?.segments[0]?.speaker === "Jordan Lee" && ms;
    }, "guest meeting saved", 4000);
    assert.equal(m.segments.length, 1);
    assert.equal(m.segments[0].text, "Can everyone hear me okay?");
    // Leaving: the hang-up button goes away, and the panel closes.
    await p.evaluate(() => document.getElementById("hangup-button").remove());
    await waitFor(async () => (await p.locator("earshot-overlay").count()) === 0, "guest panel closed", 12000);
    await p.close();
  });
}
