#!/usr/bin/env bash
# Builds gutenberg-sync-engines.zip: a self-contained, ready-to-install
# WordPress plugin. The zip bundles the pinned Gutenberg plugin (built from
# the gutenberg/ subtree) so the collaborative-editing framework is present
# on any WordPress installation — the plugin entry loads the bundled copy
# when no other Gutenberg is active.
#
# Prerequisites (the release workflow runs these; locally, run them once):
#   npm ci
#   cd gutenberg && npm ci --ignore-scripts && npm run build && cd ..
#
# Usage: npm run plugin-zip

set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -d gutenberg/build ]; then
	echo "error: gutenberg/build is missing. Build the subtree first:" >&2
	echo "  cd gutenberg && npm ci --ignore-scripts && npm run build" >&2
	exit 1
fi

echo "Building the plugin bundle..."
npm run build

DIST=dist/gutenberg-sync-engines
rm -rf dist gutenberg-sync-engines.zip
mkdir -p "$DIST"

echo "Staging plugin files..."
cp gutenberg-sync-engines.php README.md CHANGELOG.md LICENSE "$DIST/"
rsync -a build/ "$DIST/build/"
# Server PHP, including the vendored y-php / automerge-php libraries.
# Their dev-only artifacts (composer vendor dirs from running their own
# test suites locally) are excluded.
rsync -a --exclude vendor/ --exclude node_modules/ includes/ "$DIST/includes/"

# The bundled Gutenberg plugin: the same file list Gutenberg's own release
# zip ships (see gutenberg/bin/build-plugin-zip.sh), minus its non-public
# icon pruning (harmless extras).
echo "Staging the bundled Gutenberg plugin..."
mkdir -p "$DIST/gutenberg"
cp gutenberg/gutenberg.php gutenberg/readme.txt gutenberg/changelog.txt gutenberg/README.md "$DIST/gutenberg/"
rsync -a gutenberg/lib/ "$DIST/gutenberg/lib/"
rsync -a gutenberg/build/ "$DIST/gutenberg/build/"
if [ -d gutenberg/build-module ]; then
	rsync -a gutenberg/build-module/ "$DIST/gutenberg/build-module/"
fi
mkdir -p "$DIST/gutenberg/packages/block-serialization-default-parser"
cp gutenberg/packages/block-serialization-default-parser/*.php \
	"$DIST/gutenberg/packages/block-serialization-default-parser/"
mkdir -p "$DIST/gutenberg/packages/icons/src/library"
cp gutenberg/packages/icons/src/manifest.php "$DIST/gutenberg/packages/icons/src/"
cp gutenberg/packages/icons/src/library/*.svg "$DIST/gutenberg/packages/icons/src/library/"

echo "Creating gutenberg-sync-engines.zip..."
( cd dist && zip -rq ../gutenberg-sync-engines.zip gutenberg-sync-engines )
rm -rf dist

du -h gutenberg-sync-engines.zip
