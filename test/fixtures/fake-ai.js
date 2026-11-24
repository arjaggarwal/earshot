#!/usr/bin/env node
// Stand-in for an AI CLI in tests: reads the prompt on stdin and answers
// predictably. `--minutes` writes minutes-shaped Markdown.
let input = "";
process.stdin.on("data", (d) => (input += d));
// A prompt that mentions "Slowpoke" is answered 2.5 s late, so a check can
// write to the meeting while the AI works.
process.stdin.on("end", () => setTimeout(answer, /slowpoke/i.test(input) ? 2500 : 0));
function answer() {
  // "Flakyone" in the prompt: the first try fails (as a busy or timed-out AI
  // would), later ones work. "Brokenwire": every try fails.
  if (/brokenwire/i.test(input)) return fail();
  if (/flakyone/i.test(input)) {
    const marker = require("path").join(process.cwd(), ".fake-ai-flaky-once");
    if (!require("fs").existsSync(marker)) {
      require("fs").writeFileSync(marker, "");
      return fail();
    }
  }
  if (process.argv.includes("--minutes")) {
    const heading = /^### (.+)$/m.exec(input)?.[1] || "Meeting";
    const transcript = input.split("Transcript (Speaker [mm:ss]: text):")[1] || "";
    const lines = transcript.split("\n").filter((l) => /\[\d\d:\d\d\]/.test(l)).length;
    const actions = (input.split("Note-taker's notes:")[1] || "").split("\n").filter((l) => l.includes("- [ ]"));
    process.stdout.write(`### ${heading}\n\n**Summary**\n- Fake summary of ${lines} speaker turns.\n\n**Action Items**\n${actions.join("\n") || "- [ ] none"}\n\nOne-line summary: Reviewed Q3 numbers across ${lines} speaker turns.\n`);
    return;
  }
  const question = /Question: (.*)\s*$/.exec(input)?.[1] || "?";
  const turns = (input.split("Transcript so far (Speaker [mm:ss]: text):")[1] || "").split("\n").filter((l) => /\[\d\d:\d\d\]/.test(l)).length;
  const shape = /^Answer shape: (.*)$/m.exec(input)?.[1];
  process.stdout.write(`Fake answer to "${question}" from ${turns} speaker turns.${shape ? ` Shape: ${shape}` : ""}`);
}

function fail() {
  process.stderr.write("API Error: Overloaded\n");
  process.exitCode = 1;
}
