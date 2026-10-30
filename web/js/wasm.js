// Thin JSON wrapper around the rust-miniscript WASM module.
import init, * as ms from '../pkg/miniscript_playground_wasm.js';

let ready;
export const loadWasm = () => (ready ??= init());

const call = (fn, ...args) => JSON.parse(fn(...args));

export const compile = (req) => call(ms.compile, JSON.stringify(req));
export const plan = (descriptor, keys, assets) =>
  call(ms.plan, descriptor, JSON.stringify(keys), JSON.stringify(assets));
export const importDescriptor = (d) => call(ms.import_descriptor, d);
export const liftMiniscript = (m, ctx) => call(ms.lift_miniscript, m, ctx);
export const parseKey = (k) => call(ms.parse_key, k);
export const generateKey = (entropyHex, network) => call(ms.generate_key, entropyHex, network);
export const lifehashRGBA = (input, moduleSize = 1) => ms.lifehash_rgba(input, moduleSize);
export const version = () => ms.version();
/** Strictly validates a Key Ownership Manifest; returns a WASM handle or throws a message. */
export const komLoad = (text) => ms.komLoad(text);
