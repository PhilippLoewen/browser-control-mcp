#!/bin/sh
# Install the MCP server as a copied (non-symlinked) global package, so the
# installed command keeps working while this checkout is rebuilt or broken.
# Re-run to update. INSTALL_PREFIX overrides the default prefix ($HOME/.local).
set -eu

cd "$(dirname "$0")/.."
prefix="${INSTALL_PREFIX:-$HOME/.local}"

rm -rf dist
npm run build

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
tgz="$(npm pack --silent --pack-destination "$tmp")"
npm install -g --prefix "$prefix" "$tmp/$tgz"

echo "Installed $prefix/bin/browser-control-mcp"
