//! WASM bridge between the Miniscript Playground UI and rust-miniscript.
//!
//! Every exported function takes plain strings and returns a JSON string so
//! the JavaScript side stays free of generated glue types.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::str::FromStr;

use miniscript::bitcoin::bip32::{ChildNumber, DerivationPath, Xpriv, Xpub};
use miniscript::bitcoin::hashes::{hash160, ripemd160, sha256, Hash};
use miniscript::bitcoin::secp256k1::{Secp256k1, XOnlyPublicKey};
use miniscript::bitcoin::taproot::TapLeafHash;
use miniscript::bitcoin::{absolute, relative, Network, NetworkKind, ScriptBuf};
use miniscript::descriptor::{DescriptorPublicKey, Wildcard};
use miniscript::miniscript::hash256;
use miniscript::plan::AssetProvider;
use miniscript::policy::{Concrete, Liftable};
use miniscript::{
    DefiniteDescriptorKey, Descriptor, Miniscript, Segwitv0, Tap, ToPublicKey,
    Translator,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use wasm_bindgen::prelude::*;

/// BIP-341 "H" point: provably unspendable x-only internal key (hash of G, no known discrete log).
const NUMS: &str = "50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0";
const NUMS_ALIAS: &str = "UNSPENDABLE";

/// Weight of a segwit input excluding the witness: outpoint(36) + scriptSig len(1) + sequence(4), x4.
const INPUT_BASE_WEIGHT: usize = (36 + 1 + 4) * 4;

fn ok(v: Value) -> String {
    let mut v = v;
    v["ok"] = Value::Bool(true);
    v.to_string()
}

fn err(msg: impl ToString) -> String { json!({ "ok": false, "error": msg.to_string() }).to_string() }

fn parse_network(s: &str) -> Network {
    match s {
        "bitcoin" | "mainnet" => Network::Bitcoin,
        "testnet" => Network::Testnet,
        "regtest" => Network::Regtest,
        _ => Network::Signet,
    }
}

// ---------------------------------------------------------------------------
// Key translation (alias <-> real descriptor keys)
// ---------------------------------------------------------------------------

struct AliasToKey<'a> {
    keys: &'a HashMap<String, DescriptorPublicKey>,
}

impl Translator<String> for AliasToKey<'_> {
    type TargetPk = DescriptorPublicKey;
    type Error = String;

    fn pk(&mut self, pk: &String) -> Result<DescriptorPublicKey, String> {
        self.keys.get(pk).cloned().ok_or_else(|| format!("no key assigned to '{}'", pk))
    }
    fn sha256(&mut self, h: &String) -> Result<sha256::Hash, String> {
        sha256::Hash::from_str(h).map_err(|e| format!("invalid sha256 '{}': {}", h, e))
    }
    fn hash256(&mut self, h: &String) -> Result<hash256::Hash, String> {
        hash256::Hash::from_str(h).map_err(|e| format!("invalid hash256 '{}': {}", h, e))
    }
    fn ripemd160(&mut self, h: &String) -> Result<ripemd160::Hash, String> {
        ripemd160::Hash::from_str(h).map_err(|e| format!("invalid ripemd160 '{}': {}", h, e))
    }
    fn hash160(&mut self, h: &String) -> Result<hash160::Hash, String> {
        hash160::Hash::from_str(h).map_err(|e| format!("invalid hash160 '{}': {}", h, e))
    }
}

struct KeyToAlias<'a> {
    aliases: &'a HashMap<String, String>,
}

impl Translator<DescriptorPublicKey> for KeyToAlias<'_> {
    type TargetPk = String;
    type Error = String;

    fn pk(&mut self, pk: &DescriptorPublicKey) -> Result<String, String> {
        Ok(self.aliases.get(&pk.to_string()).cloned().unwrap_or_else(|| pk.to_string()))
    }
    fn sha256(&mut self, h: &sha256::Hash) -> Result<String, String> { Ok(h.to_string()) }
    fn hash256(&mut self, h: &hash256::Hash) -> Result<String, String> { Ok(h.to_string()) }
    fn ripemd160(&mut self, h: &ripemd160::Hash) -> Result<String, String> { Ok(h.to_string()) }
    fn hash160(&mut self, h: &hash160::Hash) -> Result<String, String> { Ok(h.to_string()) }
}

fn nums_key() -> DescriptorPublicKey { DescriptorPublicKey::from_str(NUMS).expect("valid NUMS") }

/// Normalises user key input: bare or origin-prefixed xpubs without a derivation
/// suffix get the standard receive/change multipath `/<0;1>/*` appended.
fn normalize_key(input: &str) -> Result<DescriptorPublicKey, String> {
    let s = input.trim();
    if s.is_empty() {
        return Err("empty key".into());
    }
    let key = DescriptorPublicKey::from_str(s).map_err(|e| e.to_string())?;
    if let DescriptorPublicKey::XPub(ref x) = key {
        if x.derivation_path.is_empty() && x.wildcard == Wildcard::None {
            return DescriptorPublicKey::from_str(&format!("{}/<0;1>/*", s))
                .map_err(|e| e.to_string());
        }
    }
    Ok(key)
}

fn parse_key_map(keys: &BTreeMap<String, String>) -> Result<HashMap<String, DescriptorPublicKey>, String> {
    let mut map = HashMap::new();
    for (alias, key) in keys {
        let k = normalize_key(key).map_err(|e| format!("key '{}': {}", alias, e))?;
        map.insert(alias.clone(), k);
    }
    map.insert(NUMS_ALIAS.to_string(), nums_key());
    Ok(map)
}

/// First receive-path derivation of a key (multipath index 0, child 0).
fn first_definite(key: &DescriptorPublicKey) -> Result<DefiniteDescriptorKey, String> {
    let single = key.clone().into_single_keys().into_iter().next().ok_or("empty multipath key")?;
    single.at_derivation_index(0).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Satisfaction planning for a hypothetical set of available assets
// ---------------------------------------------------------------------------

#[derive(Deserialize, Default, Clone)]
struct PathAssets {
    #[serde(default)]
    keys: Vec<String>,
    #[serde(default)]
    older: Option<u32>,
    #[serde(default)]
    after: Option<u32>,
    #[serde(default)]
    hashes: Vec<String>,
}

struct PlanProvider {
    pubkeys: HashSet<[u8; 32]>,
    sha256: HashSet<sha256::Hash>,
    older: Option<relative::LockTime>,
    after: Option<absolute::LockTime>,
}

impl PlanProvider {
    fn new(assets: &PathAssets, keys: &HashMap<String, DescriptorPublicKey>) -> Result<Self, String> {
        let mut pubkeys = HashSet::new();
        for alias in &assets.keys {
            if let Some(k) = keys.get(alias) {
                let pk = first_definite(k)?.to_public_key();
                pubkeys.insert(XOnlyPublicKey::from(pk.inner).serialize());
            }
        }
        let sha256 = assets.hashes.iter().filter_map(|h| sha256::Hash::from_str(h).ok()).collect();
        let older = match assets.older {
            Some(n) => Some(relative::LockTime::from_consensus(n).map_err(|e| e.to_string())?),
            None => None,
        };
        let after = assets.after.map(absolute::LockTime::from_consensus);
        Ok(PlanProvider { pubkeys, sha256, older, after })
    }

    fn has(&self, pk: &DefiniteDescriptorKey) -> bool {
        self.pubkeys.contains(&XOnlyPublicKey::from(pk.to_public_key().inner).serialize())
    }
}

impl AssetProvider<DefiniteDescriptorKey> for PlanProvider {
    fn provider_lookup_ecdsa_sig(&self, pk: &DefiniteDescriptorKey) -> bool { self.has(pk) }
    fn provider_lookup_tap_key_spend_sig(&self, pk: &DefiniteDescriptorKey) -> Option<usize> {
        self.has(pk).then_some(64)
    }
    fn provider_lookup_tap_leaf_script_sig(
        &self,
        pk: &DefiniteDescriptorKey,
        _: &TapLeafHash,
    ) -> Option<usize> {
        self.has(pk).then_some(64)
    }
    fn provider_lookup_sha256(&self, h: &sha256::Hash) -> bool { self.sha256.contains(h) }
    fn check_older(&self, s: relative::LockTime) -> bool {
        self.older.map(|ours| s.is_implied_by(ours)).unwrap_or(false)
    }
    fn check_after(&self, l: absolute::LockTime) -> bool {
        self.after.map(|ours| l.is_implied_by(ours)).unwrap_or(false)
    }
}

fn plan_json(
    desc: &Descriptor<DefiniteDescriptorKey>,
    assets: &PathAssets,
    keys: &HashMap<String, DescriptorPublicKey>,
) -> Value {
    let provider = match PlanProvider::new(assets, keys) {
        Ok(p) => p,
        Err(e) => return json!({ "spendable": false, "error": e }),
    };
    match desc.clone().plan(&provider) {
        Ok(plan) => {
            let sat_weight = plan.satisfaction_weight();
            let input_weight = INPUT_BASE_WEIGHT + sat_weight;
            json!({
                "spendable": true,
                "witness_weight": sat_weight,
                "witness_elements": plan.witness_template().len(),
                "input_vbytes": input_weight.div_ceil(4),
                "relative_timelock": plan.relative_timelock.map(|l| l.to_consensus_u32()),
                "absolute_timelock": plan.absolute_timelock.map(|l| l.to_consensus_u32()),
            })
        }
        Err(_) => json!({ "spendable": false }),
    }
}

// ---------------------------------------------------------------------------
// Script annotation: replace raw pubkey pushes with their aliases
// ---------------------------------------------------------------------------

fn alias_pubkey_table(keys: &HashMap<String, DescriptorPublicKey>) -> Vec<(String, String)> {
    let mut table = Vec::new();
    for (alias, key) in keys {
        if let Ok(d) = first_definite(key) {
            let pk = d.to_public_key();
            table.push((pk.to_string(), alias.clone()));
            table.push((XOnlyPublicKey::from(pk.inner).to_string(), alias.clone()));
            table.push((hash160::Hash::hash(&pk.to_bytes()).to_string(), format!("HASH160({})", alias)));
            let xonly = XOnlyPublicKey::from(pk.inner).serialize();
            table.push((hash160::Hash::hash(&xonly).to_string(), format!("HASH160({})", alias)));
        }
    }
    table
}

fn annotate_asm(script: &ScriptBuf, table: &[(String, String)]) -> String {
    let mut asm = script.to_asm_string();
    for (hex, alias) in table {
        asm = asm.replace(hex.as_str(), &format!("<{}>", alias));
    }
    asm.replace(" OP_", "\nOP_").replace("OP_PUSHBYTES_33 ", "").replace("OP_PUSHBYTES_32 ", "").replace("OP_PUSHBYTES_20 <", "<")
}

fn miniscript_type_json<Ctx: miniscript::ScriptContext>(ms: &Miniscript<DescriptorPublicKey, Ctx>) -> Value {
    let tl = ms.ext.timelock_info;
    json!({
        "safe": ms.ty.mall.safe,
        "non_malleable": ms.ty.mall.non_malleable,
        "sane": ms.sanity_check().is_ok(),
        "sanity_error": ms.sanity_check().err().map(|e| e.to_string()),
        "script_size": ms.script_size(),
        "tree_height": ms.ext.tree_height,
        "timelock_mixing": tl.contains_combination,
        "csv_height": tl.csv_with_height,
        "csv_time": tl.csv_with_time,
        "cltv_height": tl.cltv_with_height,
        "cltv_time": tl.cltv_with_time,
    })
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct CompileRequest {
    policy: String,
    keys: BTreeMap<String, String>,
    #[serde(default = "default_ctx")]
    context: String,
    #[serde(default)]
    network: String,
    #[serde(default)]
    paths: Vec<PathAssets>,
    #[serde(default = "default_addresses")]
    address_count: u32,
}

fn default_ctx() -> String { "wsh".into() }
fn default_addresses() -> u32 { 5 }

#[derive(Serialize)]
struct Leaf {
    depth: u8,
    miniscript: String,
    asm: String,
    script_size: usize,
}

/// Compiles an alias-keyed concrete policy into a full descriptor and analysis.
#[wasm_bindgen]
pub fn compile(request: &str) -> String {
    let req: CompileRequest = match serde_json::from_str(request) {
        Ok(r) => r,
        Err(e) => return err(format!("bad request: {}", e)),
    };
    match compile_inner(&req) {
        Ok(v) => ok(v),
        Err(e) => err(e),
    }
}

fn compile_inner(req: &CompileRequest) -> Result<Value, String> {
    let network = parse_network(&req.network);
    let policy = Concrete::<String>::from_str(&req.policy).map_err(|e| e.to_string())?;
    let keys = parse_key_map(&req.keys)?;

    // Compile in alias space so the miniscript stays human readable,
    // then translate into real keys for scripts and addresses.
    let alias_desc: Descriptor<String> = match req.context.as_str() {
        "tr" => policy.compile_tr(Some(NUMS_ALIAS.to_string())).map_err(|e| e.to_string())?,
        _ => {
            let ms = policy.compile::<Segwitv0>().map_err(|e| e.to_string())?;
            Descriptor::new_wsh(ms).map_err(|e| e.to_string())?
        }
    };
    let desc = alias_desc
        .translate_pk(&mut AliasToKey { keys: &keys })
        .map_err(|e| format!("{:?}", e))?;
    desc.sanity_check().map_err(|e| e.to_string())?;

    let table = alias_pubkey_table(&keys);
    let mut out = json!({
        "context": req.context,
        "descriptor": desc.to_string(),
        "descriptor_alias": alias_desc.to_string().split('#').next().unwrap_or_default(),
        "max_weight_to_satisfy": desc.max_weight_to_satisfy().ok().map(|w| w.to_wu()),
    });

    let singles = desc.clone().into_single_descriptors().map_err(|e| e.to_string())?;
    out["single_descriptors"] = json!(singles.iter().map(|d| d.to_string()).collect::<Vec<_>>());

    let receive = singles[0].clone();
    let change = singles.get(1).cloned();
    let derive = |d: &Descriptor<DescriptorPublicKey>, i: u32| -> Result<String, String> {
        let dd = d.at_derivation_index(i).map_err(|e| e.to_string())?;
        dd.address(network).map(|a| a.to_string()).map_err(|e| e.to_string())
    };
    let mut addresses = Vec::new();
    for i in 0..req.address_count {
        addresses.push(json!({
            "index": i,
            "receive": derive(&receive, i)?,
            "change": change.as_ref().map(|c| derive(c, i)).transpose()?,
        }));
    }
    out["addresses"] = json!(addresses);

    let definite = receive.at_derivation_index(0).map_err(|e| e.to_string())?;
    out["script_pubkey"] = json!(definite.script_pubkey().to_hex_string());

    match (&desc, &alias_desc) {
        (Descriptor::Wsh(wsh), Descriptor::Wsh(alias_wsh)) => {
            if let miniscript::descriptor::WshInner::Ms(ms) = wsh.as_inner() {
                out["analysis"] = miniscript_type_json::<Segwitv0>(ms);
            }
            if let miniscript::descriptor::WshInner::Ms(ms) = alias_wsh.as_inner() {
                out["miniscript"] = json!(ms.to_string());
            }
            let script = definite.explicit_script().map_err(|e| e.to_string())?;
            out["script_hex"] = json!(script.to_hex_string());
            out["script_asm"] = json!(annotate_asm(&script, &table));
            out["script_size"] = json!(script.len());
        }
        (Descriptor::Tr(tr), Descriptor::Tr(alias_tr)) => {
            let definite_tr = match &definite {
                Descriptor::Tr(t) => t,
                _ => unreachable!(),
            };
            let leaves: Vec<Leaf> = alias_tr
                .leaves()
                .zip(definite_tr.leaves())
                .map(|(alias_leaf, real_leaf)| {
                    let script = real_leaf.compute_script();
                    Leaf {
                        depth: alias_leaf.depth(),
                        miniscript: alias_leaf.miniscript().to_string(),
                        asm: annotate_asm(&script, &table),
                        script_size: script.len(),
                    }
                })
                .collect();
            let leaf_types: Vec<Value> =
                tr.leaves().map(|l| miniscript_type_json::<Tap>(l.miniscript())).collect();
            out["internal_key"] = json!(alias_tr.internal_key());
            out["key_path_spendable"] = json!(alias_tr.internal_key() != NUMS_ALIAS);
            out["miniscript"] = json!(alias_desc.to_string().split('#').next().unwrap_or_default());
            out["leaves"] = json!(leaves);
            out["leaf_analysis"] = json!(leaf_types);
            out["script_size"] = json!(leaves.iter().map(|l| l.script_size).sum::<usize>());
        }
        _ => {}
    }

    out["paths"] = json!(req.paths.iter().map(|p| plan_json(&definite, p, &keys)).collect::<Vec<_>>());
    Ok(out)
}

/// Plans the cheapest spend for one set of assets (used by the scenario simulator).
#[wasm_bindgen]
pub fn plan(descriptor: &str, keys: &str, assets: &str) -> String {
    let run = || -> Result<Value, String> {
        let key_strs: BTreeMap<String, String> = serde_json::from_str(keys).map_err(|e| e.to_string())?;
        let keys = parse_key_map(&key_strs)?;
        let assets: PathAssets = serde_json::from_str(assets).map_err(|e| e.to_string())?;
        let desc = Descriptor::<DescriptorPublicKey>::from_str(descriptor).map_err(|e| e.to_string())?;
        let receive = desc.into_single_descriptors().map_err(|e| e.to_string())?.remove(0);
        let definite = receive.at_derivation_index(0).map_err(|e| e.to_string())?;
        Ok(plan_json(&definite, &assets, &keys))
    };
    run().map(ok).unwrap_or_else(err)
}

/// Parses a descriptor, assigns aliases to its keys and lifts it to a semantic policy.
#[wasm_bindgen]
pub fn import_descriptor(descriptor: &str) -> String {
    let run = || -> Result<Value, String> {
        let desc = Descriptor::<DescriptorPublicKey>::from_str(descriptor.trim()).map_err(|e| e.to_string())?;
        let nums = nums_key().to_string();
        let mut aliases: HashMap<String, String> = HashMap::new();
        let mut keys = BTreeMap::new();
        let mut order = Vec::new();
        // The same xpub on different multipath branches (`<0;1>`, `<2;3>`, ...) is one signer.
        let mut uses: BTreeMap<String, String> = BTreeMap::new();
        let mut bases: HashMap<String, (String, usize)> = HashMap::new();
        for pk in desc.iter_pk() {
            let s = pk.to_string();
            if aliases.contains_key(&s) {
                continue;
            }
            if s == nums {
                aliases.insert(s, NUMS_ALIAS.to_string());
                continue;
            }
            let base = match (s.rfind("/<"), s.ends_with("/*")) {
                (Some(i), true) => s[..i].to_string(),
                _ => s.clone(),
            };
            let alias = match bases.get_mut(&base) {
                Some((block, n)) => {
                    *n += 1;
                    format!("{}_{}", block, n)
                }
                None => {
                    let block = format!("Key{}", keys.len() + 1);
                    let canonical = if base != s { format!("{}/<0;1>/*", base) } else { s.clone() };
                    keys.insert(block.clone(), canonical);
                    order.push(block.clone());
                    bases.insert(base, (block.clone(), 1));
                    block
                }
            };
            let block = bases.values().find(|(b, _)| alias == *b || alias.starts_with(&format!("{}_", b)));
            uses.insert(alias.clone(), block.map(|(b, _)| b.clone()).unwrap_or_else(|| alias.clone()));
            aliases.insert(s, alias);
        }
        let lifted = desc.lift().map_err(|e| e.to_string())?;
        let semantic = lifted.translate_pk(&mut KeyToAlias { aliases: &aliases }).map_err(|e| e.to_string())?;
        let context = match desc {
            Descriptor::Tr(_) => "tr",
            _ => "wsh",
        };
        Ok(json!({
            "context": context,
            "policy": semantic.to_string(),
            "keys": keys,
            "order": order,
            "uses": uses,
        }))
    };
    run().map(ok).unwrap_or_else(err)
}

/// Lifts an alias-keyed miniscript (segwit v0 or tapscript) to a semantic policy.
#[wasm_bindgen]
pub fn lift_miniscript(ms: &str, context: &str) -> String {
    let lifted = if context == "tr" {
        Miniscript::<String, Tap>::from_str(ms.trim()).and_then(|m| m.lift())
    } else {
        Miniscript::<String, Segwitv0>::from_str(ms.trim()).and_then(|m| m.lift())
    };
    match lifted {
        Ok(p) => ok(json!({ "policy": p.to_string() })),
        Err(e) => err(e),
    }
}

/// Validates a user supplied key and returns its canonical descriptor form.
#[wasm_bindgen]
pub fn parse_key(input: &str) -> String {
    match normalize_key(input) {
        Ok(key) => {
            let (kind, network) = match &key {
                DescriptorPublicKey::Single(_) => ("single", None),
                DescriptorPublicKey::XPub(x) => ("xpub", Some(x.xkey.network)),
                DescriptorPublicKey::MultiXPub(x) => ("xpub", Some(x.xkey.network)),
            };
            ok(json!({
                "key": key.to_string(),
                "fingerprint": key.master_fingerprint().to_string(),
                "kind": kind,
                "multipath": key.is_multipath(),
                "wildcard": key.has_wildcard(),
                "mainnet": network.map(|n| n == NetworkKind::Main),
            }))
        }
        Err(e) => err(e),
    }
}

/// Derives a BIP-48 style account xpub from caller-supplied entropy (demo keys only).
#[wasm_bindgen]
pub fn generate_key(entropy_hex: &str, network: &str) -> String {
    let run = || -> Result<Value, String> {
        let seed = hex_decode(entropy_hex)?;
        let net = parse_network(network);
        let kind = NetworkKind::from(net);
        let coin = if kind == NetworkKind::Main { 0 } else { 1 };
        let secp = Secp256k1::new();
        let master = Xpriv::new_master(kind, &seed).map_err(|e| e.to_string())?;
        let fp = master.fingerprint(&secp);
        let path: DerivationPath = vec![
            ChildNumber::from_hardened_idx(48).unwrap(),
            ChildNumber::from_hardened_idx(coin).unwrap(),
            ChildNumber::from_hardened_idx(0).unwrap(),
            ChildNumber::from_hardened_idx(2).unwrap(),
        ]
        .into();
        let account = master.derive_priv(&secp, &path).map_err(|e| e.to_string())?;
        let xpub = Xpub::from_priv(&secp, &account);
        let s = format!("[{}/48h/{}h/0h/2h]{}/<0;1>/*", fp, coin, xpub);
        let key = DescriptorPublicKey::from_str(&s).map_err(|e| e.to_string())?;
        Ok(json!({ "key": key.to_string(), "fingerprint": fp.to_string(), "xpub": xpub.to_string() }))
    };
    run().map(ok).unwrap_or_else(err)
}

/// LifeHash (version 2) of a UTF-8 string as raw RGBA pixels (32x32 per module).
#[wasm_bindgen]
pub fn lifehash_rgba(input: &str, module_size: usize) -> Vec<u8> {
    bc_lifehash::make_from_utf8(input, bc_lifehash::Version::Version2, module_size.max(1), true).colors
}

#[wasm_bindgen]
pub fn version() -> String {
    "rust-miniscript 13.2 · bc-lifehash 0.1".to_string()
}

fn hex_decode(s: &str) -> Result<Vec<u8>, String> {
    if s.len() % 2 != 0 {
        return Err("odd hex length".into());
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(|e| e.to_string()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(n: u8) -> String {
        let v: Value = serde_json::from_str(&generate_key(&format!("{:02x}", n).repeat(32), "signet")).unwrap();
        v["key"].as_str().unwrap().to_string()
    }

    #[test]
    fn compiles_wsh_and_tr_with_paths() {
        for ctx in ["wsh", "tr"] {
            let req = json!({
                "policy": "or(9@thresh(2,pk(A),pk(B),pk(C)),1@and(pk(C_2),older(52560)))",
                "keys": { "A": key(1), "B": key(2), "C": key(3), "C_2": key(3).replace("<0;1>", "<2;3>") },
                "context": ctx,
                "network": "signet",
                "paths": [ { "keys": ["A","B"] }, { "keys": ["C_2"], "older": 52560 }, { "keys": ["C_2"] } ],
            });
            let v: Value = serde_json::from_str(&compile(&req.to_string())).unwrap();
            assert_eq!(v["ok"], true, "{}: {}", ctx, v);
            assert_eq!(v["paths"][0]["spendable"], true);
            assert_eq!(v["paths"][1]["spendable"], true);
            assert_eq!(v["paths"][2]["spendable"], false);
            println!("{} {}\n", ctx, serde_json::to_string_pretty(&v).unwrap());

            let imported: Value =
                serde_json::from_str(&import_descriptor(v["descriptor"].as_str().unwrap())).unwrap();
            assert_eq!(imported["ok"], true, "{}", imported);
            println!("import {}", imported["policy"]);
        }
    }

    #[test]
    fn lifehash_is_32px() { assert_eq!(lifehash_rgba("hello", 1).len(), 32 * 32 * 4); }
}
