#!/usr/bin/env bash
# Builds the rust-miniscript WASM module into web/pkg. The site in web/ is then fully static.
set -euo pipefail
cd "$(dirname "$0")"
wasm-pack build wasm --release --target web --out-dir ../web/pkg --no-pack
rm -f web/pkg/.gitignore
echo "Built web/pkg. Serve with: python3 -m http.server -d web 8000"
