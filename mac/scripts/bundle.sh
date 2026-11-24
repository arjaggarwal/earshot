#!/bin/sh
# Builds Earshot.app (the menu-bar app) at <earshot>/dist/Earshot.app:
#   Contents/MacOS/Earshot         the release build of the EarshotMac product
#   Contents/Info.plist            mac/Info.plist, plus EarshotExtensionID from the manifest's key
#   Contents/Resources/Web         the panel (mac/scripts/stage-web.sh: mac/Web and the extension's code)
# then signs it with the "Earshot Local" code-signing identity (hardened runtime), so macOS keeps the
# microphone, audio capture and screen recording grants across rebuilds. Without that identity it signs
# ad hoc and says so: the grants are then asked for again after every rebuild.
#
#   mac/scripts/bundle.sh             build and sign dist/Earshot.app
#   mac/scripts/bundle.sh --install   ... and copy it to ~/Applications/Earshot.app
set -eu

install=0
for arg in "$@"; do
  case "$arg" in
    --install) install=1 ;;
    *) echo "usage: mac/scripts/bundle.sh [--install]" >&2; exit 64 ;;
  esac
done

mac=$(cd "$(dirname "$0")/.." && pwd)
root=$(cd "$mac/.." && pwd)
app="$root/dist/Earshot.app"
identity="Earshot Local"

cd "$mac"
swift build -c release
bin="$(swift build -c release --show-bin-path)/EarshotMac"

rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$bin" "$app/Contents/MacOS/Earshot"
cp "$mac/Info.plist" "$app/Contents/Info.plist"
printf 'APPL????' > "$app/Contents/PkgInfo"

# The meetings page lives in the Chrome extension; its id comes from the public key in
# extension/manifest.json (SHA-256 of the key, first 32 hex digits written as a-p).
ext_id=$(node -e 'const k=require(process.argv[1]).key;const h=require("crypto").createHash("sha256").update(Buffer.from(k,"base64")).digest("hex").slice(0,32);process.stdout.write([...h].map(c=>String.fromCharCode(97+parseInt(c,16))).join(""))' "$root/extension/manifest.json" 2>/dev/null || true)
if printf '%s' "$ext_id" | grep -Eq '^[a-p]{32}$'; then
  /usr/libexec/PlistBuddy -c "Add :EarshotExtensionID string $ext_id" "$app/Contents/Info.plist"
else
  echo "bundle.sh: warning: couldn't work out the extension id (is node installed?); Open meetings will be off" >&2
fi
plutil -lint -s "$app/Contents/Info.plist"

"$mac/scripts/stage-web.sh" "$app/Contents/Resources/Web"

# Not `find-identity -v`: that lists only identities macOS already trusts, and a fresh self-signed root
# is left out until it's marked Always Trust for Code Signing, though codesign can sign with it.
if security find-identity -p codesigning 2>/dev/null | grep -q "\"$identity\""; then
  sign="$identity"
else
  sign="-"
  echo "bundle.sh: warning: no \"$identity\" code-signing identity; signing ad hoc. macOS will ask for the" >&2
  echo "  microphone, audio capture and screen recording again after each rebuild. Create the identity in" >&2
  echo "  Keychain Access (see README, Mac app) and run this again." >&2
fi
codesign --force --sign "$sign" --options runtime --entitlements "$mac/Earshot.entitlements" --timestamp=none "$app"
codesign --verify --strict "$app"
echo "Built $app (signed: $sign)"

if [ "$install" = 1 ]; then
  dest="$HOME/Applications/Earshot.app"
  mkdir -p "$HOME/Applications"
  rm -rf "$dest"
  ditto "$app" "$dest"
  echo "Installed $dest"
fi
