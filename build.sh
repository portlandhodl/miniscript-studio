#!/usr/bin/env bash
# Builds the rust-miniscript WASM module into web/pkg (for development from web/), then
# bundles everything into dist/index.html: one self-contained file with the WASM embedded.
set -euo pipefail
cd "$(dirname "$0")"
wasm-pack build wasm --release --target web --out-dir ../web/pkg --no-pack
rm -f web/pkg/.gitignore
[ -d tools/node_modules ] || npm ci --prefix tools --no-audit --no-fund
node tools/build-single.mjs
echo "Dev: python3 -m http.server -d web 8000   ·   Single file: dist/index.html (open directly or host anywhere)"
