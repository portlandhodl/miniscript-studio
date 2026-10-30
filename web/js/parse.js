// Policy text (concrete or lifted semantic) -> AST -> blocks.

function tokenize(src) {
  let i = 0;
  const s = src.replace(/\s+/g, '');
  const fail = (msg) => {
    throw new Error(`${msg} at position ${i}`);
  };
  const atom = () => {
    const start = i;
    let depth = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === '(' || c === '[' || c === '<') depth++;
      else if (c === ')' || c === ']' || c === '>') {
        if (depth === 0) break;
        depth--;
      } else if (c === ',' && depth === 0) break;
      i++;
    }
    return s.slice(start, i);
  };
  const expr = () => {
    let weight = null;
    const m = /^(\d+)@/.exec(s.slice(i));
    if (m) {
      weight = Number(m[1]);
      i += m[0].length;
    }
    const nm = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i));
    if (nm && s[i + nm[0].length] === '(') {
      i += nm[0].length + 1;
      const args = [];
      const raw = ['pk', 'pkh', 'older', 'after', 'sha256', 'hash256', 'ripemd160', 'hash160'].includes(nm[0]);
      while (s[i] !== ')') {
        args.push(raw ? atom() : expr());
        if (s[i] === ',') i++;
        else if (s[i] !== ')') fail('Expected "," or ")"');
      }
      i++;
      return { name: nm[0], args, weight };
    }
    const a = atom();
    if (!a) fail('Unexpected input');
    return { name: a, args: null, weight };
  };
  const tree = expr();
  if (i !== s.length) fail('Trailing characters');
  return tree;
}

const looksLikeKey = (x) => x.length > 40 || /^(\[|[xtyzuv]pub|0[23][0-9a-f]{64}$)/.test(x);

/** Parses policy text into a normalized block AST. */
export function parsePolicy(src) {
  const t = tokenize(src);
  const conv = (n) => {
    const { name, args, weight } = n;
    const w = (node) => ({ ...node, weight: weight ?? node.weight ?? null });
    if (!args) {
      if (name === 'UNSATISFIABLE' || name === '0') return { type: 'unsat' };
      if (name === 'TRIVIAL' || name === '1') return { type: 'trivial' };
      throw new Error(`Unexpected "${name}"`);
    }
    switch (name) {
      case 'pk':
      case 'pkh': {
        const ref = args[0];
        if (ref === 'UNSPENDABLE') return { type: 'unsat' };
        return w(looksLikeKey(ref) ? { type: 'key', literal: ref } : { type: 'key', ref });
      }
      case 'older':
      case 'after':
        return w({ type: name, value: Number(args[0]) });
      case 'sha256':
        return w({ type: 'hash', hash: args[0] });
      case 'hash256':
      case 'ripemd160':
      case 'hash160':
        throw new Error(`${name} hashlocks aren't supported as blocks yet (use sha256)`);
      case 'and':
      case 'or': {
        let kids = args.map(conv).filter((k) => k.type !== 'trivial' || name === 'or');
        if (name === 'or') kids = kids.filter((k) => k.type !== 'unsat');
        if (kids.some((k) => k.type === 'unsat')) return { type: 'unsat' };
        if (name === 'or' && kids.some((k) => k.type === 'trivial')) return { type: 'trivial' };
        // Flatten same-operator nesting, keeping or-weights proportional.
        const flat = [];
        for (const k of kids) {
          if (k.type === name && (name === 'and' || k.children.every((c) => c.weight == null))) {
            for (const c of k.children) flat.push(name === 'or' ? { ...c, weight: k.weight ?? null } : c);
          } else flat.push(k);
        }
        if (flat.length === 1) return w(flat[0]);
        return w({ type: name, children: flat });
      }
      case 'thresh': {
        const k = Number(args[0].name ?? args[0]);
        const kids = args.slice(1).map(conv).filter((c) => c.type !== 'unsat');
        if (k === 1) return conv({ name: 'or', args: args.slice(1), weight });
        if (k === kids.length) return conv({ name: 'and', args: args.slice(1), weight });
        return w({ type: 'thresh', k, children: kids });
      }
      default:
        throw new Error(`Unknown fragment "${name}"`);
    }
  };
  const ast = conv(t);
  if (ast.type === 'unsat' || ast.type === 'trivial') throw new Error('Policy is trivially (un)satisfiable');
  return ast;
}

/**
 * Replaces the model's blocks with the AST. `resolveKey(ref | {literal})` returns
 * `{ label, role, key, seed }` for every distinct signer reference.
 */
export function buildBlocks(model, ast, resolveKey, uses = {}) {
  const root = model.root;
  for (const id of Object.keys(model.nodes)) if (id !== root.id) delete model.nodes[id];
  root.inputs = [];
  const keyNodes = new Map();
  const pending = [];

  const make = (n, depth) => {
    if (n.type === 'key') {
      const ref = n.literal ?? uses[n.ref] ?? n.ref;
      if (!keyNodes.has(ref)) keyNodes.set(ref, model.addNode('key', 0, 0, resolveKey(n)));
      return keyNodes.get(ref);
    }
    if (n.type === 'older' || n.type === 'after') return model.addNode(n.type, 0, 0, { value: n.value });
    if (n.type === 'hash') {
      const node = model.addNode('hash', 0, 0, /^[0-9a-f]{64}$/i.test(n.hash) ? { hash: n.hash.toLowerCase() } : {});
      if (!node.hash) pending.push(node);
      return node;
    }
    const block = model.addNode(n.type, 0, 0, n.type === 'thresh' ? { k: n.k } : {});
    for (const c of n.children) {
      const child = make(c, depth + 1);
      model.connect(child.id, block.id);
      if (n.type === 'or') block.weights[block.inputs.length - 1] = c.weight ?? 1;
    }
    return block;
  };
  const top = make(ast, 1);
  model.connect(top.id, root.id);
  return { pendingSecrets: pending };
}
