// End-to-end checks: loads the extension into Chromium, serves fake Zoom,
// Teams and Meet web clients at their real URLs, drives them the way the platforms
// would, and checks the overlay, storage, exports, caption requests and the
// Zoom link redirect.
//
//   node test/e2e.mjs            # everything
//   node test/e2e.mjs teams      # one suite
//
// Set SCREENSHOT=/path.png to save an image of the Zoom overlay.
import { startBrowser } from "./harness.mjs";
import { zoomSuite } from "./zoom.suite.mjs";
import { teamsSuite } from "./teams.suite.mjs";
import { meetSuite, aiHealthSuite } from "./meet.suite.mjs";

const suites = { zoom: zoomSuite, teams: teamsSuite, meet: meetSuite, ai: aiHealthSuite };
const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(suites);

const h = await startBrowser();
for (const name of wanted) {
  console.log(`\n${name}`);
  await suites[name](h);
}
process.exit((await h.finish()) ? 0 : 1);
