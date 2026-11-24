#!/bin/sh
# Lays out the Mac panel's web folder (Earshot.app/Contents/Resources/Web) at
# <dest>: mac/Web/* at the top, plus the extension's panel and shared code at
# the same relative paths the extension uses, so panel.html's script tags and
# chrome.runtime.getURL("fonts/...") resolve the same way in both places.
#
#   mac/scripts/stage-web.sh <dest>
#
# The one definition of that layout: test/mac-panel.mjs and the app bundle
# script both call it.
set -eu
dest=${1:?usage: stage-web.sh <dest>}
mac=$(cd "$(dirname "$0")/.." && pwd)
ext="$mac/../extension"

mkdir -p "$dest/content" "$dest/shared" "$dest/fonts"
cp "$mac"/Web/* "$dest/"
cp "$ext/content/sidebar.js" "$dest/content/"
cp "$ext"/shared/*.js "$dest/shared/"
cp "$ext"/fonts/*.woff2 "$ext/fonts/OFL.txt" "$dest/fonts/"
