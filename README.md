# Miniscript Studio

**Design Bitcoin self-custody visually.** Drag keys, timelocks and logic blocks onto a canvas, wire them together, and watch them compile live into Miniscript, output descriptors and addresses. Everything runs in your browser on [rust-miniscript](https://github.com/rust-bitcoin/rust-miniscript) compiled to WebAssembly.

> A multi-vendor threshold multisig isn't a silver bullet for self-custody on its own. Real resilience comes from trading *interactivity* (how many parties must cooperate) for *fault tolerance*: fallback paths that give you a way out under the worst circumstances. Miniscript Studio makes that trade-off visible.

## Features

- **Block canvas.** Keys, relative and absolute timelocks, hashlocks, *All of / Any of / Threshold*. Drag from the palette, wire output to input, pan and zoom, tidy auto-layout, undo/redo.
- **Live compilation (WASM).** The rust-miniscript policy compiler targets P2WSH or Taproot (with automatic key-path extraction and a NUMS internal key otherwise). You get the policy, miniscript, descriptor (multipath `<0;1>/*`), annotated script ASM, tapleaves, and sanity/malleability analysis.
- **Key reuse done right.** One key block equals one signing device. Wire it into several paths and each extra use gets its own derivation branch (`<2;3>/*`, `<4;5>/*`, …), so miniscript never sees a duplicate key.
- **Custody over time.** For every moment a new path unlocks: signers needed, keys you can lose, and keys a thief would need. There is also an unlock timeline and per-path input cost from rust-miniscript's spend planner.
- **Disaster simulator.** Mark devices as lost, reveal secrets and scrub time forward. Blocks light up as they are satisfied, and you learn whether funds are spendable now, recoverable later, or gone for good.
- **LifeHash everywhere.** Visual fingerprints of every key and of the final descriptor ([bc-lifehash](https://github.com/BlockchainCommons/bc-lifehash), compiled into the same WASM module).
- **Export.** Descriptors (combined, receive, change), a BIP-388 wallet policy for hardware signers, addresses, Bitcoin Core `importdescriptors`, and a backup file.
- **Import.** Paste a descriptor, a policy or a miniscript, and it gets lifted back into blocks.
- **Share links.** The whole design is compressed into the URL fragment. No server.

## Develop

Requirements: Rust with the `wasm32-unknown-unknown` target, [wasm-pack](https://drager.github.io/wasm-pack/), and clang (to build libsecp256k1 for WASM).

```sh
./build.sh                         # builds wasm/ into web/pkg
python3 -m http.server -d web 8000 # open http://localhost:8000
cargo test --release --manifest-path wasm/Cargo.toml
```

The frontend is plain ES modules in `web/js/`, with no bundler and no build step beyond the WASM.

| Path | Purpose |
|---|---|
| `wasm/src/lib.rs` | WASM bridge: compile, plan, import/lift, key parsing, demo keys, LifeHash |
| `web/js/model.js` | Block graph, connection rules, undo history |
| `web/js/policy.js` | Blocks → policy, spending-path enumeration, custody analysis, simulation |
| `web/js/canvas.js` | Rendering, pan/zoom, drag and wiring, tidy layout |
| `web/js/panels.js` | Inspector, Paths, Simulator, Wallet export, compiler drawer |
| `web/js/parse.js` | Policy/semantic text → blocks (templates and import) |

## Deploy to GitHub Pages

Push to `main` with **Settings → Pages → Source: GitHub Actions** enabled. `.github/workflows/pages.yml` runs the tests, builds the WASM and publishes `web/`.

## ⚠️ Safety

This is a design and learning tool. Demo keys are derived from public seeds, so **never send funds to them**. Before funding a real wallet, verify the descriptor and addresses on your signing devices.
