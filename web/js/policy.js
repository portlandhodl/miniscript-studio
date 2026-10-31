// Block tree -> concrete policy, key map, spending paths and custody analysis.
import { hasInputs } from './model.js';
import { combinations, olderIsTime, olderSeconds, afterIsTime, afterSecondsFromNow, afterSecondsFromRef, SEQUENCE_TYPE_FLAG } from './util.js';

const MAX_PATHS = 256;
const RESERVED = new Set(['UNSPENDABLE', 'pk', 'pkh', 'and', 'or', 'thresh', 'older', 'after', 'sha256', 'multi', 'multi_a']);
const MULTIPATH_RE = /\/<0;1>\/\*$/;

export const sanitizeAlias = (label) => {
  let a = String(label || 'Key').trim().replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'Key';
  if (/^[0-9]/.test(a)) a = `K_${a}`;
  if (RESERVED.has(a)) a = `${a}_key`;
  return a.slice(0, 24);
};

function emptyPath() {
  return { uses: [], devices: new Set(), hashes: new Set(), nodes: new Set(), olderBlocks: 0, olderTime: 0, afterHeight: 0, afterTime: 0 };
}

function mergePaths(a, b) {
  return {
    uses: [...a.uses, ...b.uses],
    devices: new Set([...a.devices, ...b.devices]),
    hashes: new Set([...a.hashes, ...b.hashes]),
    nodes: new Set([...a.nodes, ...b.nodes]),
    olderBlocks: Math.max(a.olderBlocks, b.olderBlocks),
    olderTime: Math.max(a.olderTime, b.olderTime),
    afterHeight: Math.max(a.afterHeight, b.afterHeight),
    afterTime: Math.max(a.afterTime, b.afterTime),
  };
}

const subset = (a, b) => [...a].every((x) => b.has(x));

/** `a` dominates `b` when it needs no more resources than `b` does. */
function dominates(a, b) {
  return (
    subset(a.devices, b.devices) && subset(a.hashes, b.hashes) &&
    a.olderBlocks <= b.olderBlocks && a.olderTime <= b.olderTime &&
    a.afterHeight <= b.afterHeight && a.afterTime <= b.afterTime
  );
}

function minimize(paths) {
  const out = [];
  paths.forEach((p, i) => {
    const beaten = paths.some((q, j) => j !== i && dominates(q, p) && (!dominates(p, q) || j < i));
    if (!beaten) out.push(p);
  });
  return out;
}

function product(lists, state) {
  let acc = [emptyPath()];
  for (const list of lists) {
    const next = [];
    for (const a of acc) for (const b of list) next.push(mergePaths(a, b));
    acc = next.length > MAX_PATHS ? ((state.truncated = true), minimize(next).slice(0, MAX_PATHS)) : next;
  }
  return acc;
}

/**
 * Builds everything the compiler needs from the model. Never throws: problems are
 * reported per block in `errors` and `policy` is null when the tree is incomplete.
 */
export function buildPolicy(model) {
  const errors = [];
  const err = (id, msg) => errors.push({ id, msg });
  const nodes = model.nodes;
  const root = model.root;

  // Stable, unique alias per key block (its "device" name in the script).
  const baseAlias = {};
  const taken = new Set();
  for (const k of model.keyNodes()) {
    let a = sanitizeAlias(k.label);
    let n = 2;
    while (taken.has(a)) a = `${sanitizeAlias(k.label)}${n++}`;
    taken.add(a);
    baseAlias[k.id] = a;
  }

  const useCount = {};
  const keys = {};
  const aliasToNode = {};
  const state = { truncated: false };
  const hashHex = {};

  const gen = (id, stack) => {
    const n = nodes[id];
    if (!n) return null;
    if (stack.has(id)) return err(id, 'Loop detected'), null;
    stack = new Set(stack).add(id);
    let expr = null;
    let paths = [];
    switch (n.type) {
      case 'key': {
        const k = useCount[id] = (useCount[id] ?? -1) + 1;
        const alias = k === 0 ? baseAlias[id] : `${baseAlias[id]}_${k + 1}`;
        const keyStr = (n.key || '').trim();
        if (!keyStr) return err(id, 'No public key set'), null;
        if (k > 0 && !MULTIPATH_RE.test(keyStr)) {
          return err(id, 'Reusing a key in several paths needs an xpub ending in /<0;1>/*'), null;
        }
        keys[alias] = k === 0 ? keyStr : keyStr.replace(MULTIPATH_RE, `/<${2 * k};${2 * k + 1}>/*`);
        aliasToNode[alias] = id;
        expr = `pk(${alias})`;
        const p = emptyPath();
        p.uses.push(alias);
        p.devices.add(id);
        p.nodes.add(id);
        paths = [p];
        break;
      }
      case 'older': {
        const v = Number(n.value);
        const units = v & 0xffff;
        if (!Number.isInteger(v) || units < 1 || (v & ~(0xffff | SEQUENCE_TYPE_FLAG))) {
          return err(id, 'Relative timelock must be 1–65535 blocks or 512-second units'), null;
        }
        expr = `older(${v})`;
        const p = emptyPath();
        p.nodes.add(id);
        if (olderIsTime(v)) p.olderTime = v;
        else p.olderBlocks = v;
        paths = [p];
        break;
      }
      case 'after': {
        const v = Number(n.value);
        if (!Number.isInteger(v) || v < 1 || v >= 2 ** 31) return err(id, 'Set a block height or a date'), null;
        expr = `after(${v})`;
        const p = emptyPath();
        p.nodes.add(id);
        if (afterIsTime(v)) p.afterTime = v;
        else p.afterHeight = v;
        paths = [p];
        break;
      }
      case 'hash': {
        const hsh = (n.hash || '').trim().toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(hsh)) return err(id, 'Needs a 32-byte SHA256 hash (64 hex chars)'), null;
        expr = `sha256(${hsh})`;
        hashHex[id] = hsh;
        const p = emptyPath();
        p.hashes.add(id);
        p.nodes.add(id);
        paths = [p];
        break;
      }
      case 'and':
      case 'or':
      case 'thresh': {
        const kids = n.inputs.map((c) => gen(c, stack));
        if (n.inputs.length < 2) return err(id, 'Connect at least two inputs'), null;
        if (kids.some((k) => !k)) return null;
        const exprs = kids.map((k) => k.expr);
        if (n.type === 'and') {
          expr = exprs.reduceRight((acc, e) => (acc ? `and(${e},${acc})` : e), null);
          paths = product(kids.map((k) => k.paths), state);
        } else if (n.type === 'or') {
          const w = n.inputs.map((_, i) => Math.max(1, Math.round(n.weights[i] ?? 1)));
          const uniform = w.every((x) => x === w[0]);
          // Policy `or` is binary: nest right-to-left, carrying the summed weight.
          let acc = exprs[exprs.length - 1];
          let accW = w[w.length - 1];
          for (let i = exprs.length - 2; i >= 0; i--) {
            acc = uniform && i === exprs.length - 2 && exprs.length === 2
              ? `or(${exprs[i]},${acc})`
              : `or(${w[i]}@${exprs[i]},${accW}@${acc})`;
            accW += w[i];
          }
          expr = acc;
          paths = kids.flatMap((k) => k.paths);
        } else {
          const k = Math.round(n.k);
          if (k < 1 || k > n.inputs.length) return err(id, `Threshold must be between 1 and ${n.inputs.length}`), null;
          expr = `thresh(${k},${exprs.join(',')})`;
          let combos = combinations(kids.map((c) => c.paths), k);
          if (combos.length > 64) (state.truncated = true), (combos = combos.slice(0, 64));
          paths = combos.flatMap((lists) => product(lists, state));
        }
        paths = minimize(paths);
        for (const p of paths) p.nodes.add(id);
        break;
      }
      default:
        return err(id, `Blocks of type ${n.type} can't be used here`), null;
    }
    return { expr, paths };
  };

  let result = null;
  if (!root.inputs.length) err(root.id, 'Connect a spending condition to the wallet');
  else result = gen(root.inputs[0], new Set([root.id]));

  const reach = model.reachable();
  for (const n of Object.values(nodes)) if (!reach.has(n.id)) err(n.id, 'Not connected to the wallet');

  const blocking = errors.filter((e) => reach.has(e.id));
  const paths = result && !blocking.length ? decoratePaths(result.paths, root, hashHex) : [];
  return {
    policy: blocking.length || !result ? null : result.expr,
    keys,
    aliasToNode,
    errors,
    paths,
    truncated: state.truncated,
    devices: model.keyNodes().filter((k) => reach.has(k.id)).map((k) => k.id),
  };
}

function decoratePaths(paths, root, hashHex) {
  return paths.map((p, i) => {
    const conflict = (p.olderBlocks && p.olderTime) || (p.afterHeight && p.afterTime);
    const wait = Math.max(
      p.olderBlocks ? olderSeconds(p.olderBlocks) : 0,
      p.olderTime ? olderSeconds(p.olderTime) : 0,
      p.afterHeight ? afterSecondsFromRef(p.afterHeight) : 0,
      p.afterTime ? afterSecondsFromRef(p.afterTime) : 0,
    );
    p.nodes.add(root.id);
    return {
      ...p,
      index: i,
      conflict: !!conflict,
      wait: Math.max(0, wait),
      relative: !!(p.olderBlocks || p.olderTime),
      assets: {
        keys: p.uses,
        older: p.olderBlocks || p.olderTime || null,
        after: p.afterHeight || p.afterTime || null,
        hashes: [...p.hashes].map((id) => hashHex[id]),
      },
    };
  }).sort((a, b) => a.wait - b.wait || a.devices.size - b.devices.size)
    .map((p, i) => ({ ...p, index: i }));
}

/** Smallest number of devices whose loss blocks every path in `paths`. */
function minHittingSet(paths, devices) {
  const sets = paths.map((p) => p.devices);
  if (sets.some((s) => s.size === 0)) return Infinity;
  if (devices.length > 16) return null;
  for (let k = 1; k <= devices.length; k++) {
    for (const combo of combinations(devices, k)) {
      const lost = new Set(combo);
      if (sets.every((s) => [...s].some((d) => lost.has(d)))) return k;
    }
  }
  return Infinity;
}

/**
 * Custody trade-off over time: at each moment a new path unlocks, how many
 * signers are needed, how many keys may be lost, how many an attacker needs.
 */
export function custodyPhases(paths, devices) {
  const valid = paths.filter((p) => !p.conflict);
  const times = [...new Set([0, ...valid.map((p) => p.wait)])].sort((a, b) => a - b);
  return times.map((t) => {
    const active = valid.filter((p) => p.wait <= t);
    if (!active.length) return { t, active, minSigners: null, tolerance: null, attacker: null };
    const minSigners = Math.min(...active.map((p) => p.devices.size));
    const hit = minHittingSet(active, devices);
    return {
      t,
      active,
      minSigners,
      tolerance: hit == null ? null : hit === Infinity ? devices.length : hit - 1,
      attacker: minSigners,
      secrets: Math.min(...active.map((p) => p.hashes.size)),
    };
  }).filter((ph, i, arr) => i === 0 || ph.active.length !== arr[i - 1].active.length);
}

/** Scenario evaluation for the simulator: which blocks are satisfied. */
export function evaluate(model, env) {
  const memo = new Map();
  const ev = (id) => {
    if (memo.has(id)) return memo.get(id);
    const n = model.node(id);
    let ok = false;
    if (!n) ok = false;
    else if (n.type === 'key') ok = env.available.has(id);
    else if (n.type === 'hash') ok = env.known.has(id);
    else if (n.type === 'older') ok = env.elapsed >= olderSeconds(Number(n.value));
    else if (n.type === 'after') ok = env.elapsed >= afterSecondsFromNow(Number(n.value), env.now);
    else if (hasInputs(n)) {
      const kids = n.inputs.map(ev);
      const count = kids.filter(Boolean).length;
      if (n.type === 'and') ok = kids.length > 0 && count === kids.length;
      else if (n.type === 'or') ok = count > 0;
      else if (n.type === 'thresh') ok = count >= n.k;
      else if (n.type === 'wallet') ok = count > 0;
    }
    memo.set(id, ok);
    return ok;
  };
  ev(model.state.rootId);
  return memo;
}
