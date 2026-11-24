# Earshot

Earshot is a local-first meeting recorder. A Chrome extension captures speaker-tagged
transcripts from **Google Meet**, **Zoom (web)** and **Teams (web)**. A small menu-bar app
covers the desktop Zoom and Teams apps. A local helper saves every meeting as plain Markdown
on your Mac, files it into your **Obsidian** vault, and uses whichever AI CLI you already have
(Claude Code, Codex or Gemini) for Ask AI and automatic minutes. Nothing goes to a server of
its own: your meetings stay as files on your disk.

I built it in November 2026 as the meeting recorder I actually use every day. It replaced a
paid SaaS note-taker. This repo is a cleaned public copy: the code is as I run it, with my
own tags, names and test data swapped for made-up ones.

```
 Meet / Zoom / Teams tab                      Mac menu-bar app (Swift)
 ┌─────────────────────────┐                  ┌──────────────────────────────┐
 │ page hook: reads the    │                  │ desktop calls: mic + call    │
 │ app's caption stream    │                  │ audio, live speech, Whisper  │
 │ (WebRTC / Redux / call  │                  │ pass after the call          │
 │ API), never the screen  │                  └──────────────┬───────────────┘
 └───────────┬─────────────┘                                 │ ~/Earshot/run/
             │ postMessage                                   │
 ┌───────────▼─────────────┐   native messaging   ┌──────────▼───────────────┐
 │ extension: panel, notes,├─────────────────────►│ helper (Node)            │
 │ background worker,      │                      │ - meetings as Markdown   │
 │ meetings page           │◄─────────────────────┤ - AI CLI for minutes/ask │
 └─────────────────────────┘                      │ - Obsidian filing        │
                                                  │ - MCP server (mcp.js)    │
                                                  └──────────┬───────────────┘
                                                             │
                                  ~/Earshot/meetings/…   +   your Obsidian vault
```

## Install (once, on the Mac you take meetings on)

1. Clone or download this repo somewhere permanent, for example your home folder.
2. **Extension:** open `chrome://extensions`, turn on **Developer mode**, click
   **Load unpacked**, and pick the `extension` folder. Pin it from the puzzle-piece
   menu.
3. **Helper:** in Terminal, from the repo folder, run:

   ```bash
   bash helper/install.sh
   ```

   It finds Node and your AI CLIs, picks a Claude account (see below), finds your
   Obsidian vault, adds the Earshot MCP server to Claude Code, registers with
   Chrome, and makes one tiny test call. If Node is missing, it tells you to run
   `brew install node`.
4. Back in `chrome://extensions`, click reload on Earshot.

**Updating:** pull the latest, run `install.sh` again (it keeps your settings and
meetings), then reload Earshot and any open meeting tabs.

## Using it

- **Join a meeting as usual.**
  - Zoom links open in the browser.
  - On Teams, choose **Continue on this browser**.
  - On Meet, nothing special is needed.
- **The panel opens on its own,** docked beside the meeting, and turns captions on
  behind the scenes. It closes itself when you leave, launcher included. Closing
  the tab saves everything too.
- **Collapse** (⤡) shrinks it to a small launcher you can drag anywhere:
  - **E** opens the panel. Its color shows status: green is capturing, amber
    waiting, grey paused, red a problem.
  - **📷** saves a screenshot of what's being presented.
  - **💬** opens Ask AI.
- **Live Transcript:**
  - Blocks are spaced per utterance, with each speaker's name once per turn.
  - Click a block to fix its text. Your fix sticks even if the caption is revised.
  - Click a name to rename that person everywhere.
  - Hover a block to tag it. It goes into your notes as a #todo, #followup, #ROI,
    #opportunity or #insight line.
- **Notes** (below the transcript):
  - Type `-` for bullets. Enter continues the list, and Enter on an empty bullet
    ends it.
  - `[] ` starts an action item. Tab and Shift+Tab indent and outdent.
  - The chips insert a bullet, action, decision, question or the current meeting
    time.
- **Title and tags:**
  - Click the title to rename the meeting.
  - Tags are picked from the title. For example, "Acme weekly" gets Acme. Click the
    tag chip to change them or add a new tag. The tag list and aliases are yours to
    set in Settings; the defaults are only examples.
- **Ask AI:** a question about the meeting so far, answered by a fast model from the
  transcript and your notes. Every question and answer is saved with the meeting.
- **Screenshot** saves only the presented screen, at its full resolution, never
  faces. With nobody presenting, it saves nothing and says so.
- **Rejoining the same meeting the same day** picks the earlier transcript back up.
  That means the same Zoom number or Meet code, or the same title on Teams.
- **When a meeting ends,** minutes are written automatically from your template,
  using a stronger model.

## Where things live

Meetings are saved in **`~/Earshot`**, as plain Markdown you can open in Finder or
Obsidian:

```
~/Earshot/
  meetings/2026/11 November/2026-11-02 1030 Acme weekly/
    transcript.md   frontmatter (title, date, tags, attendees) + transcript
    notes.md        your notes
    minutes.md      AI minutes
    chat.md         Ask AI questions and answers
    meeting.json    everything, for tools
    screenshots/    presentation captures
  templates/default.md   the minutes prompt (edit it in Settings)
  config.json            AI commands, Claude account, tags, vault filing
  helper/                the helper and the MCP server (mcp.js)
  .trash/                deleted meetings, kept just in case
```

The **meetings page** (the 🏠 icon in the panel, or the toolbar icon → All meetings)
shows your history:

- **Browsing:** grouped by day, with tag filters and search across titles, people,
  transcripts, notes and minutes.
- **Each meeting** has **Minutes** (regenerate, edit, copy), **Transcript** (with
  the same edits as the panel), **Notes** and **Ask AI**, plus exports and Open
  folder.
- **Settings** cover tags and their aliases, auto-captions, auto-minutes, the AI
  commands, the minutes template, and a **Check sign-in now** button.

## Mac app

A small menu-bar app (`mac/`) for calls the extension can't read: Teams and Zoom desktop, and
browser meetings with captions off. It records your mic and the call's audio, shows live lines in
the same panel, and after the call runs Whisper on the recordings for the full transcript. Minutes,
vault filing and the MCP tools then treat it like any other meeting.

**Three ways a capture starts:**
- **A call prompt.** When Teams or Zoom starts using the mic, a small "Capture this call?" prompt
  appears. Capture starts it; Not now leaves it.
- **⌥⇧R or the menu's Start recording.** Records your mic and all the Mac's audio. Stop ends it.
- **The captions-off prompt.** When a browser meeting has no captions (the extension's red "No
  captions" warning, or captions that stop partway), the same prompt offers to capture it with Mac
  audio, into that meeting's record.

Every capture shows as the launcher (E, 💬, 📷); click E to open the panel.

**Install:** the Whisper pass needs whisper.cpp: `brew install whisper-cpp` (check with
`which whisper-cli`). Run `bash helper/install.sh` (it prints the command to download the Whisper
model into `~/Earshot/models/`), then build the app:

```bash
mac/scripts/bundle.sh --install    # builds dist/Earshot.app, copies it to ~/Applications
```

Create a self-signed code-signing identity named `Earshot Local` first (Keychain Access →
Certificate Assistant → Create a Certificate, type Code Signing), or macOS asks for the permissions
again after every rebuild. Then open the app, grant microphone, speech recognition and audio
capture, and tick **Open at login** in its menu.

**Where files go:** the same meeting folders as the extension, in `~/Earshot/meetings/`, with the
recordings in `audio/` inside each (WAV, kept `mac.audioKeepDays` days, 30 by default). Settings
are under `mac` in `~/Earshot/config.json`: `myName` (how your mic lines are labelled),
`audioKeepDays` and `whisperModel`. The app and the extension talk through `~/Earshot/run/`.

**Command line:** the same binary runs checks and transcribes recordings:

```bash
dist/Earshot.app/Contents/MacOS/Earshot transcribe --started <ISO time> \
  --track mic=Alex:mic.wav --track call=Call:call.wav --out lines.json
```

Others: `probe-audio` (which apps are using the mic) and `record-test --seconds 15 [--app us.zoom]`.
Run `Earshot` with no arguments for the menu-bar app.

## Obsidian: minutes filed into your vault

When a meeting's minutes are written, Earshot files the meeting into your vault. The installer
uses the only vault it finds; with several, set `EARSHOT_VAULT` or pick one in Settings.

- **One note per meeting** in its tag's folder, by default:

  ```
  departments/Acme/Meeting Minutes/2026-11-02 Acme weekly.md
  ```

  The note has frontmatter (`type: meeting`, date, company, tags, `[[attendees]]`,
  a one-sentence summary), then the minutes, **My notes**, the presentation
  screenshots (copied to `images/earshot/`), and the transcript folded away at the
  bottom.
- **A line in that day's daily note** (`daily/notes/MM.DD.YY.md`) under
  `## Meetings`, alongside anything else already there:

  ```
  - [[departments/Acme/Meeting Minutes/2026-11-02 Acme weekly|Acme weekly]] · 10:30 AM: one sentence on what the meeting was
  ```

- **Which folder:** the meeting's first tag decides.
  - A client tag goes to `departments/<Client>` when that folder exists.
  - Internal goes to `internal`, Hiring to `internal/hiring`, and Vendor to `vendors`.
  - Personal isn't filed.
  - Untagged meetings go to `Inbox/meetings/earshot`.
- **Re-filing** (the meetings page's **Re-file to vault**, or after regenerating
  minutes) updates both in place. Only Earshot's section of the note
  (`%% earshot:start %%` … `%% earshot:end %%`) is replaced, so anything you add
  below it stays. A changed title or tag moves the note rather than copying it.
- **Working with a vault agent.** If you run an overnight AI job over the vault (a "vault
  agent"), Earshot leaves room for it. The agent can file what landed in
  `Inbox/meetings/earshot`, fix `company`, tags and attendee names from the vault, and stamp
  `agent_checked:`. Re-filing keeps the agent's place for the note and its `company`, `tags`,
  `attendees`, `Attendees:` and `Tags:` lines, and replaces only the minutes. Change the
  meeting's tags or title in Earshot and your choice wins: the note moves and the agent checks
  it again.
- **Names come from the vault:** `people/` pages (with `aliases:` for spelling variants, and
  `client: "[[Acme]]"` for who they work with) and each client's `Names` note. Attendees are
  filed as the vault spells them (`Alex` becomes Alex Kestrel), labels like `Call` are left out,
  and the AI minutes get the vault's known spellings for the meeting's clients.
- **All of this is adjustable** in Settings → Obsidian vault:
  - the vault, and whether filing is automatic
  - the folder and note-name patterns
  - the tag → folder mapping
  - the untagged folder
  - the daily-note folder, date format, heading and line
  - transcript style (folded, full or none)
  - whether screenshots are copied

**Open in Obsidian** on the meetings page jumps to the filed note.

## MCP: Claude can read and file your meetings

The installer adds an `earshot` MCP server to Claude Code, for the same Claude account
Earshot uses. You can then ask things like "what did Acme decide last week?",
"list my open action items from Internal meetings", or "file yesterday's Globex meeting
to the vault". Its tools:

| Tool | What it does |
|---|---|
| `list_meetings` | Meetings by date range, tag, source (captured or imported), recurring series, attendee or words in the title |
| `list_series` | Recurring meetings (the same title more than once), with counts and the last date |
| `search_meetings` | Search what was said, your notes and minutes. All words must appear close together; use a "quoted phrase" or a hyphenated word for exact wording. Words under 4 letters match whole. Filters: speaker, attendee, one meeting, date, tag, source. Hits are numbered turns (`#12`) |
| `expand_excerpt` | The conversation around one turn: the turns before and after `#12` |
| `get_meeting` | Details and links (folder, vault note, original if imported), then your notes, the minutes, the first transcript page and Ask AI chats. Your notes come first and outrank the AI minutes |
| `get_transcript` | The transcript as numbered turns, one page of about 20,000 characters at a time, or one stretch of time (`from_time`/`to_time`) or one speaker |
| `get_action_items` | Open action items across meetings: checkboxes in your notes (marked as yours) and the minutes |
| `file_meeting_to_vault` | File (or re-file) a meeting into the vault; `dry_run` shows where it would go |
| `vault_filing_settings` | How filing is set up |

It pages long transcripts and uses a find-then-expand flow, so an agent can search a year of
meetings without loading them all into context. It runs locally, with no rate limits.

**Adding it by hand:**

```bash
claude mcp add -s user earshot -- node ~/Earshot/helper/mcp.js
```

For Claude Desktop, add `"earshot": {"command": "<path to node>", "args": ["<home>/Earshot/helper/mcp.js"]}`
under `mcpServers`. The installer prints this with your paths filled in.

## Claude account and sign-in

**Several Claude accounts:** each Claude Code sign-in lives in its own folder:
`~/.claude` by default, and another (for example `~/.claude-work`) when you
run `CLAUDE_CONFIG_DIR=… claude`.

- The installer lists them and prefers an enterprise (work) sign-in if you have one.
- To choose another, run:

  ```bash
  EARSHOT_CLAUDE_CONFIG_DIR=~/.claude-other bash helper/install.sh
  ```

- Settings shows which account is in use.

**Staying signed in:** a Claude CLI sign-in can expire. "Signed in" can even be
reported while real calls fail. Earshot checks for this with a status check plus a
one-word test call (the smallest model, no default system prompt, so almost free):

- when every meeting starts
- every 4 hours
- whenever an AI call fails

If something's wrong, you get a **red bar in the panel** and a **macOS notification**
with the exact command to fix it, for example
`CLAUDE_CONFIG_DIR=~/.claude-work claude auth login`. It repeats at most every
3 hours for the same problem.

**Avoiding expiry entirely:** `claude setup-token` creates a long-lived token.
Put it in `~/Earshot/config.json` under `ai.ask.env` and `ai.minutes.env` as
`CLAUDE_CODE_OAUTH_TOKEN`. Note that it's then stored in plain text in that file.

**Without the helper,** capture and the panel still work. Meetings stay in Chrome
only, and Ask AI and minutes are off.

## How capture works

Earshot reads each app's caption data inside the page. It never reads captions off the
screen.

**Meet**

- It hooks the call's WebRTC connection and opens the `captions` and
  `captions_v2` data channels itself, which is what asks Meet's server to send
  captions. It decodes them (protobuf) and acknowledges each utterance.
- Names come from the `collections` channel and from Meet's participant sync.

**Zoom web**

- It reads `newLiveTranscription` from the web client's Redux store, where each
  caption carries the speaker's Zoom ID and display name.
- It turns captions on over Zoom's own socket.

**Teams**

- **Signed in:** it uses the active call from `window.msteamscalling`: start
  captions, read the participants, and wrap the caption handler.
- **Guest joins:** captions come from the call's `main-channel` data channel, and
  names from roster updates.

**Leaving** is detected on each platform:

- Zoom: the join status, plus whether the meeting is still mounted.
- Meet: the call connection closing.
- Teams: the active call ending, or the hang-up button disappearing for guests.
- All three: the tab leaving the meeting's address, as a backstop.

**If something breaks in a real meeting:** use Export → **Debug info**. The file shows
what Earshot found inside the app, and how it scored each video when looking for the
presented screen.

## Known limits

- **Captions must be allowed.** On Zoom, the host's account has to allow automated
  captions. On Teams, the organizer's tenant has to allow live captions. (The Mac app
  covers calls without captions.)
- **Overlapping speech** is credited to one speaker by the platform.
- **Screenshots.** Finding the shared screen is scored from how each app shows it:
  known share containers, "presentation" labels, and fitting the share whole versus
  cropping cameras to fill their tiles. Real layouts may need tuning; Debug info
  shows the scores.
- **Docking** follows each app's current layout. If it ever looks off, use the float
  icon.
- **Internals can change.** All of this relies on undocumented app internals, which
  can change without notice.
- **Recording consent.** Tell people when you're capturing a meeting, and follow your
  local laws and your organization's policies.

## Development

```bash
npm test                 # unit tests (node:test): helper, vault filing, MCP, core logic
npm install && npm run setup:e2e
npm run test:e2e         # end-to-end, in Chromium with the extension and real helper
cd mac && swift test     # Mac app core (Swift Testing)
```

The end-to-end run (99 checks) uses fake Meet, Zoom and Teams clients served at their
real URLs, a temporary `~/Earshot`, a small sample vault (daily notes that already hold
another tool's entry), and a stand-in AI CLI, including one whose sign-in has expired.
The MCP server is also driven directly over stdio. Pass `meet`, `zoom`, `teams` or `ai`
to `node test/e2e.mjs` to run a single suite.

The extension's ID is fixed by the public key in `extension/manifest.json`, so every
unpacked install gets the same ID and the helper's native-messaging registration finds it.

## License

MIT. See [LICENSE](LICENSE).
