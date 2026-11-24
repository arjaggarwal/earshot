// Shared setup for the end-to-end suites: one Chromium with the unpacked
// extension loaded, fixture serving, and small wait/check helpers.
//
// Needs playwright-core and a Chromium. Override with PLAYWRIGHT_CORE and CHROMIUM.
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, chmodSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const extensionDir = path.resolve(here, "../extension");
export const fixture = (name) => readFileSync(path.join(here, "fixtures", name), "utf8");

const require = createRequire(import.meta.url);
const playwrightPath = process.env.PLAYWRIGHT_CORE || "playwright-core"; // npm install, then npx playwright-core install chromium
const chromiumPath = process.env.CHROMIUM || undefined; // undefined: the Chromium Playwright installed

// The extension's ID follows from the public key in manifest.json: the first 128 bits of its
// SHA-256, written with the letters a-p. Loading it unpacked gives every install the same ID,
// which the helper's native-messaging registration names.
export function extensionId() {
  const { key } = JSON.parse(readFileSync(path.join(extensionDir, "manifest.json"), "utf8"));
  const hex = createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(fn, what, timeout = 8000) {
  const began = Date.now();
  let last;
  while (Date.now() - began < timeout) {
    last = await fn();
    if (last) return last;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(last)})`);
}

export const overlayText = (page) => page.locator("earshot-overlay .body").innerText().catch(() => "");

// Click an item in the panel's Export menu and return the download it starts.
export async function menuDownload(page, act) {
  await page.locator("earshot-overlay button[data-act=export-menu]").click();
  const [download] = await Promise.all([page.waitForEvent("download"), page.locator(`earshot-overlay button[data-act=${act}]`).click()]);
  return download;
}

// Registers the real helper with this test browser (Chrome looks in
// <user data dir>/NativeMessagingHosts), with ~/Earshot replaced by a temp
// folder and the AI CLI replaced by test/fixtures/fake-ai.js.
function installHelper(userDataDir) {
  const home = path.join(userDataDir, "Earshot");
  mkdirSync(home, { recursive: true });
  const node = process.execPath;
  const fakeAi = path.join(here, "fixtures", "fake-ai.js");
  // A small vault shaped like a typical one: daily notes as MM.DD.YY
  // with a "## Meetings" section (already holding another tool's entry), and a
  // Acme department folder.
  const vaultPath = path.join(userDataDir, "Test Vault");
  mkdirSync(path.join(vaultPath, ".obsidian"), { recursive: true });
  mkdirSync(path.join(vaultPath, "departments", "Acme"), { recursive: true });
  writeFileSync(path.join(vaultPath, "departments", "Acme", "Acme.md"), "# Acme\n");
  mkdirSync(path.join(vaultPath, "daily", "notes"), { recursive: true });
  writeFileSync(path.join(vaultPath, ".obsidian", "daily-notes.json"), JSON.stringify({ folder: "daily/notes", format: "MM.DD.YY" }));
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, "0");
  writeFileSync(
    path.join(vaultPath, "daily", "notes", `${p2(d.getMonth() + 1)}.${p2(d.getDate())}.${String(d.getFullYear()).slice(-2)}.md`),
    "# Today\n\n## Notes\n\n## Meetings\n\n<!-- other:start:abc -->\n### Weekly planning · 7:45 AM\nAnother tool's summary.\n<!-- other:end:abc -->\n"
  );
  writeFileSync(
    path.join(home, "config.json"),
    JSON.stringify({
      vault: { path: vaultPath },
      ai: {
        ask: { label: "Fake AI", command: node, args: [fakeAi] },
        minutes: { label: "Fake AI", command: node, args: [fakeAi, "--minutes"] },
      },
    })
  );
  const launcher = path.join(userDataDir, "earshot-host");
  writeFileSync(launcher, `#!/bin/sh\nexport EARSHOT_HOME="${home}"\nexec "${node}" "${path.resolve(here, "../helper/host.js")}"\n`);
  chmodSync(launcher, 0o755);
  const extId = extensionId();
  mkdirSync(path.join(userDataDir, "NativeMessagingHosts"), { recursive: true });
  writeFileSync(
    path.join(userDataDir, "NativeMessagingHosts", "com.earshot.helper.json"),
    JSON.stringify({ name: "com.earshot.helper", description: "Earshot helper (test)", path: launcher, type: "stdio", allowed_origins: [`chrome-extension://${extId}/`] })
  );
  return { home, vaultPath };
}

export async function startBrowser({ withHelper = true } = {}) {
  if (chromiumPath && !existsSync(chromiumPath)) throw new Error(`Chromium not found at ${chromiumPath}; unset CHROMIUM to use Playwright's`);
  const { chromium } = require(playwrightPath);
  const userDataDir = mkdtempSync(path.join(tmpdir(), "earshot-e2e-"));
  const { home: earshotHome = null, vaultPath = null } = withHelper ? installHelper(userDataDir) : {};
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: chromiumPath,
    headless: true,
    acceptDownloads: true,
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
  });
  const worker = context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker"));
  // Minutes right after a meeting ends, so checks needn't wait out the grace
  // period. Set after the install step has written its defaults, or it wins.
  await worker.evaluate(async () => {
    for (let i = 0; i < 50 && (await chrome.storage.local.get("minutesDelayMinutes")).minutesDelayMinutes === undefined; i++) await new Promise((r) => setTimeout(r, 100));
    // The checks drive the open panel, so meetings open it as they did before it became opt-in.
    await chrome.storage.local.set({ minutesDelayMinutes: 0, panelOpenOnJoin: true });
  });
  const storage = () => worker.evaluate(() => chrome.storage.local.get(null));

  const results = [];
  async function check(name, fn) {
    try {
      await fn();
      results.push({ name, ok: true });
      console.log(`  ok   ${name}`);
    } catch (err) {
      results.push({ name, ok: false, err });
      console.log(`  FAIL ${name}\n       ${err.message.split("\n").join("\n       ")}`);
    }
  }

  async function meetings(platform, ref) {
    const all = await storage();
    return Object.entries(all)
      .filter(([k, v]) => k.startsWith("meeting:") && v.platform === platform && (ref === undefined || v.meetingRef === ref))
      .map(([, v]) => v);
  }

  async function finish() {
    await context.close();
    rmSync(userDataDir, { recursive: true, force: true });
    // Chrome writes indexed rule files into an unpacked extension; Chrome then
    // refuses to load a copied folder that contains them.
    rmSync(path.join(extensionDir, "_metadata"), { recursive: true, force: true });
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} passed`);
    return failed.length === 0;
  }

  return { context, worker, storage, check, meetings, finish, earshotHome, vaultPath };
}
