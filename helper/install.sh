#!/bin/bash
# Installs the Earshot helper for the current user:
#   - copies the helper to ~/Earshot/helper
#   - finds Node and your AI CLIs (claude, codex, gemini)
#   - picks your Claude account: the enterprise sign-in if you have several
#     config folders (~/.claude, ~/.claude-*), or set EARSHOT_CLAUDE_CONFIG_DIR
#   - writes ~/Earshot/config.json (kept if it already exists)
#   - registers the helper with Chrome (and Arc, Brave, Edge if present)
#   - finds your Obsidian vault (if you have several, set EARSHOT_VAULT or pick it in Settings)
#   - adds the Earshot MCP server to Claude Code for that Claude account
#   - fills in the Mac app's settings (config.json "mac") where they're missing
#   - copies the Whisper model into ~/Earshot/models (or prints how to get it)
#   - makes one small test AI call
# Test switches: EARSHOT_HOME (use another folder), EARSHOT_SKIP_REGISTER=1 (no MCP, no
# browser registration), EARSHOT_SKIP_MCP=1 (no MCP only), EARSHOT_SKIP_SELFTEST=1,
# EARSHOT_MODEL_SRC (where to copy the Whisper model from).
# Run it again any time; it won't overwrite your settings or meetings.
set -euo pipefail

EXT_ID="pencjmbpnojhdemhnpcpcpnggjpdlooa"
HOST_NAME="com.earshot.helper"
ROOT="${EARSHOT_HOME:-$HOME/Earshot}"
HELPER="$ROOT/helper"
SRC="$(cd "$(dirname "$0")" && pwd)"

say() { printf '%s\n' "$*"; }

# Earshot uses your Claude sign-in, never an API key. A key exported by your
# shell would override the sign-in, so the account check and the test call
# would pass here and then fail when Chrome starts the helper without it.
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN

# Look a command up the way your terminal would (aliases and shell PATH included),
# then in the usual install locations.
find_cmd() {
  local name="$1" found=""
  found="$(/bin/zsh -ic "whence -p $name" 2>/dev/null | tail -1 || true)"
  if [ -z "$found" ]; then
    found="$(/bin/zsh -ic "alias $name" 2>/dev/null | sed -E "s/^$name=//; s/^'//; s/'$//" | tail -1 || true)"
  fi
  if [ -z "$found" ] || [ ! -x "$found" ]; then
    for c in "$HOME/.local/bin/$name" "$HOME/.claude/local/$name" /opt/homebrew/bin/$name /usr/local/bin/$name \
             "$HOME/.npm-global/bin/$name" "$HOME/.volta/bin/$name" $(ls -d "$HOME"/.nvm/versions/node/*/bin/$name 2>/dev/null | sort -V | tail -1) \
             $(ls -d "$HOME"/.vscode/extensions/anthropic.claude-code-*/resources/native-binary/$name 2>/dev/null | sort -V | tail -1); do
      if [ -x "$c" ]; then found="$c"; break; fi
    done
  fi
  [ -n "$found" ] && [ -x "$found" ] && printf '%s' "$found"
}

NODE="$(find_cmd node || true)"
if [ -z "$NODE" ]; then
  say "Earshot needs Node.js. Install it with:  brew install node   (or from nodejs.org), then run this again."
  exit 1
fi
say "Node:   $NODE"

CLAUDE="$(find_cmd claude || true)"
CODEX="$(find_cmd codex || true)"
GEMINI="$(find_cmd gemini || true)"
[ -n "$CLAUDE" ] && say "claude: $CLAUDE"
[ -n "$CODEX" ] && say "codex:  $CODEX"
[ -n "$GEMINI" ] && say "gemini: $GEMINI"

mkdir -p "$HELPER" "$ROOT/meetings" "$ROOT/templates"
cp "$SRC/host.js" "$SRC/vault.js" "$SRC/mcp.js" "$HELPER/"
cat > "$HELPER/earshot-host" <<EOF
#!/bin/sh
exec "$NODE" "$HELPER/host.js" "\$@"
EOF
chmod +x "$HELPER/earshot-host"

# Claude accounts: the default (~/.claude) plus any other config folder
# (~/.claude-*), each its own sign-in. Earshot uses the enterprise one unless
# EARSHOT_CLAUDE_CONFIG_DIR names another.
ACCOUNTS="$(mktemp)"
if [ -n "$CLAUDE" ]; then
  for d in "$HOME/.claude" "$HOME"/.claude-*; do
    [ -d "$d" ] || continue
    if [ "$d" = "$HOME/.claude" ]; then
      st="$(cd "$ROOT" && env -u CLAUDE_CONFIG_DIR "$CLAUDE" auth status --json 2>/dev/null || true)"
    else
      st="$(cd "$ROOT" && CLAUDE_CONFIG_DIR="$d" "$CLAUDE" auth status --json 2>/dev/null || true)"
    fi
    [ -n "$st" ] && printf '%s\t%s\n' "$d" "$(printf '%s' "$st" | tr -d '\n')" >> "$ACCOUNTS"
  done
fi

# Obsidian vault: EARSHOT_VAULT if given, else the only one found (several: pick it in Settings).
VAULT="${EARSHOT_VAULT:-}"
if [ -z "$VAULT" ]; then
  VAULTS="$(/usr/bin/find "$HOME" -maxdepth 6 -type d -name .obsidian -not -path '*/Library/Caches/*' -not -path '*/node_modules/*' -not -path '*/.Trash/*' 2>/dev/null | sed 's#/.obsidian$##')"
  [ "$(printf '%s\n' "$VAULTS" | grep -c .)" = "1" ] && VAULT="$VAULTS"
fi
[ -n "$VAULT" ] && say "Vault:  $VAULT" || say "Vault:  not found (choose it later in Earshot's settings)"

# The PATH your terminal uses, so the CLIs find their own tools when Chrome starts them.
USER_PATH="$(/bin/zsh -ic 'printf %s "$PATH"' 2>/dev/null | tail -1 || printf %s "$PATH")"

"$NODE" - "$ROOT/config.json" "$CLAUDE" "$CODEX" "$GEMINI" "$USER_PATH" "$ACCOUNTS" "${EARSHOT_CLAUDE_CONFIG_DIR:-}" "$HOME" "$VAULT" <<'EOF'
const fs = require("fs");
const [file, claude, codex, gemini, userPath, accountsFile, wantedDir, home, vaultPath] = process.argv.slice(2);
let config = {};
try { config = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
config.vault = config.vault || {};
if (vaultPath && !config.vault.path) config.vault.path = vaultPath;
config.ai = config.ai || {};
// The Mac app's settings: fill in what's missing, keep what you set.
config.mac = { myName: "Alex", audioKeepDays: 30, whisperModel: "~/Earshot/models/ggml-large-v3-turbo-q5_0.bin", ...(config.mac || {}) };
const env = { PATH: userPath };

// Pick the Claude account: the folder you named, else an enterprise sign-in, else any signed-in one.
const accounts = fs.readFileSync(accountsFile, "utf8").split("\n").filter(Boolean).map((line) => {
  const [dir, json] = line.split("\t");
  try { return { dir, ...JSON.parse(json) }; } catch { return { dir, loggedIn: false }; }
});
if (accounts.length) {
  console.log("Claude accounts found:");
  for (const a of accounts) console.log(`  ${a.dir.replace(home, "~")}: ${a.loggedIn ? `${a.orgName || "personal"} (${a.subscriptionType || a.authMethod})` : "signed out"}`);
}
// A folder you name wins; otherwise keep the account Earshot already uses, so
// running this again while signed out never quietly switches accounts.
const current = config.ai.account?.configDir;
const chosen = (wantedDir && accounts.find((a) => a.dir === wantedDir.replace(/^~/, home)))
  || (current && accounts.find((a) => a.dir === current))
  || accounts.find((a) => a.loggedIn && a.subscriptionType === "enterprise")
  || accounts.find((a) => a.loggedIn)
  || accounts.find((a) => /enterprise|work|business/i.test(a.dir))
  || accounts[0];
if (claude && chosen) {
  const isDefault = chosen.dir === `${home}/.claude`;
  const claudeEnv = isDefault ? env : { ...env, CLAUDE_CONFIG_DIR: chosen.dir };
  // Keep the organisation we expect even if this run finds it signed out.
  const known = current === chosen.dir ? config.ai.account : {};
  config.ai.account = { configDir: chosen.dir, orgName: chosen.orgName || known.orgName || null, subscriptionType: chosen.subscriptionType || known.subscriptionType || null };
  if (!chosen.loggedIn) console.log(`Note:   ${chosen.dir.replace(home, "~")} is signed out. Sign in with: ${chosen.dir === home + "/.claude" ? "" : `CLAUDE_CONFIG_DIR=${chosen.dir.replace(home, "~")} `}${claude} auth login`);
  console.log(`Using:  ${chosen.dir.replace(home, "~")}${chosen.orgName ? ` (${chosen.orgName})` : ""}`);
  // Point existing Claude commands at this account too.
  for (const key of ["ask", "minutes"]) if (config.ai[key] && /\/claude$/.test(config.ai[key].command)) config.ai[key].env = claudeEnv;
  env.__claude = claudeEnv;
}
// Cheap, fast model for Ask AI; a stronger one for the minutes.
const presets = [];
const claudeEnv = env.__claude || env;
delete env.__claude;
if (claude) presets.push({
  ask: { label: "Claude Haiku", command: claude, args: ["-p", "--model", "haiku", "--tools", "", "--strict-mcp-config", "--no-session-persistence"], env: claudeEnv, timeoutSec: 120 },
  minutes: { label: "Claude Sonnet", command: claude, args: ["-p", "--model", "sonnet", "--tools", "", "--strict-mcp-config", "--no-session-persistence"], env: claudeEnv, timeoutSec: 300 },
});
if (codex) presets.push({
  ask: { label: "Codex", command: codex, args: ["exec", "--skip-git-repo-check", "-"], env, timeoutSec: 180 },
  minutes: { label: "Codex", command: codex, args: ["exec", "--skip-git-repo-check", "-"], env, timeoutSec: 300 },
});
if (gemini) presets.push({
  ask: { label: "Gemini Flash", command: gemini, args: ["-m", "gemini-2.5-flash", "-p", ""], env, timeoutSec: 120 },
  minutes: { label: "Gemini Pro", command: gemini, args: ["-m", "gemini-2.5-pro", "-p", ""], env, timeoutSec: 300 },
});
if (!config.ai.ask && presets[0]) Object.assign(config.ai, presets[0]);
config.ai.available = presets.map((p) => p.ask.label);
fs.writeFileSync(file, JSON.stringify(config, null, 2));
console.log(config.ai.ask ? `AI:     ${config.ai.ask.label} for Ask AI, ${config.ai.minutes?.label || config.ai.ask.label} for minutes` : "AI:     no CLI found (install claude, codex or gemini and run this again)");
EOF

# The Whisper model the Mac app uses for the full transcript after a call.
MODEL_NAME="ggml-large-v3-turbo-q5_0.bin"
MODEL_SRC="${EARSHOT_MODEL_SRC:-}" # an already-downloaded copy to reuse, if you have one
mkdir -p "$ROOT/models"
if [ -f "$ROOT/models/$MODEL_NAME" ]; then
  say "Model:  $ROOT/models/$MODEL_NAME (already there)"
elif [ -n "$MODEL_SRC" ] && [ -f "$MODEL_SRC" ]; then
  if cp "$MODEL_SRC" "$ROOT/models/$MODEL_NAME.part" && mv "$ROOT/models/$MODEL_NAME.part" "$ROOT/models/$MODEL_NAME"; then
    say "Model:  copied $MODEL_NAME to $ROOT/models"
  else
    rm -f "$ROOT/models/$MODEL_NAME.part"
    say "Model:  copy failed from $MODEL_SRC (disk full?). Copy it to $ROOT/models/$MODEL_NAME by hand."
  fi
else
  say "Model:  not found. The Mac app needs it for full transcripts. Download it (about 570 MB) with:"
  say "  curl -L -o \"$ROOT/models/$MODEL_NAME\" https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$MODEL_NAME"
fi

# Earshot's MCP server, so Claude Code can read your meetings and file them to the vault.
if [ -z "${EARSHOT_SKIP_REGISTER:-}" ] && [ -z "${EARSHOT_SKIP_MCP:-}" ] && [ -n "$CLAUDE" ]; then
  MCP_DIR="$("$NODE" -e 'const c=require(process.argv[1]);const d=c.ai?.ask?.env?.CLAUDE_CONFIG_DIR;process.stdout.write(d||"")' "$ROOT/config.json" 2>/dev/null || true)"
  run_claude() { if [ -n "$MCP_DIR" ]; then CLAUDE_CONFIG_DIR="$MCP_DIR" "$CLAUDE" "$@"; else "$CLAUDE" "$@"; fi; }
  (cd "$ROOT" && run_claude mcp remove -s user earshot >/dev/null 2>&1 || true)
  if (cd "$ROOT" && run_claude mcp add -s user earshot -- "$NODE" "$HELPER/mcp.js" >/dev/null 2>&1); then
    say "MCP:    added \"earshot\" to Claude Code${MCP_DIR:+ (${MCP_DIR/#$HOME/~})}"
  else
    say "MCP:    couldn't add it automatically. Run: claude mcp add -s user earshot -- \"$NODE\" \"$HELPER/mcp.js\""
  fi
fi
say "Claude Desktop: add to its config under mcpServers:  \"earshot\": {\"command\": \"$NODE\", \"args\": [\"$HELPER/mcp.js\"]}"

# Register with every Chromium browser that's installed (EARSHOT_SKIP_REGISTER=1 skips this, for testing).
[ -n "${EARSHOT_SKIP_REGISTER:-}" ] && say "Skipping browser registration." ||
{
MANIFEST="{\"name\":\"$HOST_NAME\",\"description\":\"Earshot helper\",\"path\":\"$HELPER/earshot-host\",\"type\":\"stdio\",\"allowed_origins\":[\"chrome-extension://$EXT_ID/\"]}"
for dir in \
  "$HOME/Library/Application Support/Google/Chrome" \
  "$HOME/Library/Application Support/Google/Chrome Beta" \
  "$HOME/Library/Application Support/Arc/User Data" \
  "$HOME/Library/Application Support/BraveSoftware/Brave-Browser" \
  "$HOME/Library/Application Support/Microsoft Edge"; do
  if [ -d "$dir" ] || [ "$dir" = "$HOME/Library/Application Support/Google/Chrome" ]; then
    mkdir -p "$dir/NativeMessagingHosts"
    printf '%s\n' "$MANIFEST" > "$dir/NativeMessagingHosts/$HOST_NAME.json"
    say "Registered with: ${dir#$HOME/Library/Application Support/}"
  fi
done
}

rm -f "$ACCOUNTS"

say ""
if [ -n "${EARSHOT_SKIP_SELFTEST:-}" ]; then say "Skipping the test AI call."; else
"$HELPER/earshot-host" --self-test || say "The AI isn't working yet. Run the Fix command above (it opens your browser to sign in), then run this installer again."
fi
say ""
say "Done. Meetings will be saved in $ROOT. Reload Earshot in chrome://extensions to connect. The Mac app is built separately: mac/scripts/bundle.sh --install"
