//! Key Ownership Manifest (KOM) v1: strict loading and key matching.
//! Spec: docs/key-ownership-spec.md. Errors name the location and rule, never the value.

use std::collections::{BTreeMap, HashMap};
use std::str::FromStr;

use miniscript::bitcoin::base58;
use miniscript::bitcoin::bip32::Xpub;
use miniscript::bitcoin::hashes::{sha256, Hash};
use miniscript::bitcoin::NetworkKind;
use miniscript::descriptor::DescriptorPublicKey;
use serde::Deserialize;
use serde_json::{json, Value};
use wasm_bindgen::prelude::*;

const FORMAT: &str = "miniscript-studio/key-ownership";
const ROLES: [&str; 6] = ["hardware", "mobile", "cold", "vendor", "heir", "friend"];
const COLUMNS: [&str; 6] = ["signer", "path", "kid", "xpub", "account", "status"];
const MAX_TEXT: usize = 64;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct KomFile {
    format: String,
    version: u32,
    network: String,
    created: Option<String>,
    provenance: Option<Vec<KomProvenance>>,
    signers: BTreeMap<String, KomSigner>,
    keys: KomKeys,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct KomProvenance {
    file: String,
    sha256: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct KomSigner {
    label: String,
    group: Option<String>,
    fingerprint: Option<String>,
    role: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct KomKeys {
    columns: Vec<String>,
    rows: Vec<Vec<Value>>,
}

struct Signer {
    id: String,
    label: String,
    group: Option<String>,
    fingerprint: Option<[u8; 4]>,
    role: Option<String>,
    keys: usize,
}

struct Entry {
    signer: u32,
    kid: [u8; 16],
    xpub: Option<String>,
    path: Option<String>,
    account: Option<u64>,
    status: Option<String>,
}

/// A validated manifest held in WASM memory; JavaScript only sees summaries and match results.
#[wasm_bindgen]
pub struct Manifest {
    network: NetworkKind,
    signers: Vec<Signer>,
    entries: Vec<Entry>,
    by_kid: HashMap<[u8; 16], u32>,
    by_origin: HashMap<([u8; 4], Vec<u32>), u32>,
    by_fp: HashMap<[u8; 4], u32>,
}

/// Version-independent key id: first 16 bytes of sha256(chain code || compressed pubkey).
pub fn kid(x: &Xpub) -> [u8; 16] {
    let mut data = Vec::with_capacity(65);
    data.extend_from_slice(x.chain_code.as_bytes());
    data.extend_from_slice(&x.public_key.serialize());
    let h = sha256::Hash::hash(&data).to_byte_array();
    let mut out = [0u8; 16];
    out.copy_from_slice(&h[..16]);
    out
}

fn hex_fixed<const N: usize>(s: &str) -> Option<[u8; N]> {
    if s.len() != 2 * N || !s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
        return None;
    }
    let mut out = [0u8; N];
    for (i, o) in out.iter_mut().enumerate() {
        *o = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).ok()?;
    }
    Some(out)
}

fn to_hex(b: &[u8]) -> String { b.iter().map(|x| format!("{:02x}", x)).collect() }

/// Canonical path: `m` then `/index` or `/indexh`, no leading zeros, index < 2^31.
fn parse_path(s: &str) -> Option<Vec<u32>> {
    let rest = s.strip_prefix('m')?;
    if rest.is_empty() {
        return Some(vec![]);
    }
    let mut out = vec![];
    for c in rest.strip_prefix('/')?.split('/') {
        let (digits, hardened) = match c.strip_suffix('h') {
            Some(d) => (d, true),
            None => (c, false),
        };
        if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) || (digits.len() > 1 && digits.starts_with('0')) {
            return None;
        }
        let i: u32 = digits.parse().ok().filter(|i| *i < 0x8000_0000)?;
        out.push(if hardened { i | 0x8000_0000 } else { i });
    }
    Some(out)
}

/// Private key material hidden in free text: xprv-like, WIF, or a mnemonic-shaped phrase.
fn looks_private(s: &str) -> bool {
    let words: Vec<&str> = s.split_whitespace().collect();
    if (12..=24).contains(&words.len()) && words.iter().all(|w| (3..=8).contains(&w.len()) && w.bytes().all(|b| b.is_ascii_lowercase())) {
        return true;
    }
    let is_b58 = |c: char| c.is_ascii_alphanumeric() && !matches!(c, '0' | 'O' | 'I' | 'l');
    s.split(|c: char| !is_b58(c)).any(|t| {
        (t.len() >= 100 && t.len() > 4 && &t[1..4] == "prv")
            || ((51..=52).contains(&t.len())
                && base58::decode_check(t).map(|d| matches!(d.first(), Some(0x80 | 0xef)) && matches!(d.len(), 33 | 34)).unwrap_or(false))
    })
}

fn text(field: &str, s: &str) -> Result<(), String> {
    if s.trim().is_empty() || s.chars().count() > MAX_TEXT || s.chars().any(|c| c.is_control()) {
        return Err(format!("{field}: must be 1–{MAX_TEXT} printable characters"));
    }
    if looks_private(s) {
        return Err(format!("{field}: contains private key material"));
    }
    Ok(())
}

fn load(src: &str) -> Result<Manifest, String> {
    if looks_private_anywhere(src) {
        return Err("File contains private key material (xprv / WIF). Nothing was loaded".into());
    }
    let f: KomFile = serde_json::from_str(src).map_err(|e| {
        // serde messages can quote unknown field names but never values.
        format!("Not a valid manifest: {}", e.to_string().split(" at line").next().unwrap_or_default())
    })?;
    if f.format != FORMAT {
        return Err(format!("format: must be \"{FORMAT}\""));
    }
    if f.version != 1 {
        return Err("version: only version 1 is supported".into());
    }
    let network = match f.network.as_str() {
        "bitcoin" => NetworkKind::Main,
        "testnet" | "signet" | "regtest" => NetworkKind::Test,
        _ => return Err("network: must be bitcoin, testnet, signet or regtest".into()),
    };
    if let Some(c) = &f.created {
        text("created", c)?;
    }
    for (i, p) in f.provenance.iter().flatten().enumerate() {
        text(&format!("provenance[{i}].file"), &p.file)?;
        hex_fixed::<32>(&p.sha256).ok_or(format!("provenance[{i}].sha256: must be 64 lowercase hex"))?;
    }

    let mut signers = vec![];
    let mut sid = HashMap::new();
    let mut by_fp = HashMap::new();
    for (id, s) in &f.signers {
        if id.is_empty() || id.len() > MAX_TEXT || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b)) {
            return Err(format!("signers[#{}]: id must be 1–{MAX_TEXT} of A–Z a–z 0–9 . _ -", signers.len()));
        }
        text(&format!("signers.{id}.label"), &s.label)?;
        if let Some(g) = &s.group {
            text(&format!("signers.{id}.group"), g)?;
        }
        if let Some(r) = &s.role {
            if !ROLES.contains(&r.as_str()) {
                return Err(format!("signers.{id}.role: must be one of {}", ROLES.join(", ")));
            }
        }
        let fingerprint = match &s.fingerprint {
            None => None,
            Some(fp) => Some(hex_fixed::<4>(fp).ok_or(format!("signers.{id}.fingerprint: must be 8 lowercase hex or null"))?),
        };
        if let Some(fp) = fingerprint {
            if by_fp.insert(fp, signers.len() as u32).is_some() {
                return Err(format!("signers.{id}.fingerprint: already used by another signer"));
            }
        }
        sid.insert(id.clone(), signers.len() as u32);
        signers.push(Signer { id: id.clone(), label: s.label.clone(), group: s.group.clone(), fingerprint, role: s.role.clone(), keys: 0 });
    }

    let mut col = HashMap::new();
    for (i, c) in f.keys.columns.iter().enumerate() {
        if !COLUMNS.contains(&c.as_str()) {
            return Err(format!("keys.columns[{i}]: unknown column"));
        }
        if col.insert(c.as_str(), i).is_some() {
            return Err(format!("keys.columns[{i}]: duplicate column \"{c}\""));
        }
    }
    for req in ["signer", "path", "kid"] {
        if !col.contains_key(req) {
            return Err(format!("keys.columns: missing required column \"{req}\""));
        }
    }

    let mut entries = Vec::with_capacity(f.keys.rows.len());
    let mut by_kid = HashMap::with_capacity(f.keys.rows.len());
    let mut by_origin = HashMap::with_capacity(f.keys.rows.len());
    for (r, row) in f.keys.rows.iter().enumerate() {
        let at = |c: &str| format!("keys.rows[{r}].{c}");
        if row.len() != f.keys.columns.len() {
            return Err(format!("keys.rows[{r}]: has {} cells, expected {}", row.len(), f.keys.columns.len()));
        }
        let cell = |c: &str| col.get(c).map(|&i| &row[i]).filter(|v| !v.is_null());
        let signer = *cell("signer").and_then(Value::as_str).and_then(|s| sid.get(s)).ok_or(format!("{}: must name a signer", at("signer")))?;
        // A null path means the source did not record one: matched by key id only.
        let path_s = match cell("path") {
            None => None,
            Some(v) => Some(v.as_str().ok_or(format!("{}: must be a string or null", at("path")))?),
        };
        let path = match path_s {
            None => None,
            Some(p) => Some(parse_path(p).ok_or(format!("{}: not a canonical path (m/…, hardened as h)", at("path")))?),
        };
        let k = cell("kid").and_then(Value::as_str).and_then(hex_fixed::<16>).ok_or(format!("{}: must be 32 lowercase hex", at("kid")))?;
        let account = match cell("account") {
            None => None,
            Some(v) => Some(v.as_u64().ok_or(format!("{}: must be a non-negative integer or null", at("account")))?),
        };
        let status = match cell("status") {
            None => None,
            Some(v) => {
                let s = v.as_str().ok_or(format!("{}: must be a string or null", at("status")))?;
                text(&at("status"), s)?;
                Some(s.to_string())
            }
        };
        let sfp = signers[signer as usize].fingerprint;
        let mut xpub_s = None;
        if let Some(x) = cell("xpub") {
            let x = x.as_str().ok_or(format!("{}: must be a string or null", at("xpub")))?;
            let xpub = Xpub::from_str(x).map_err(|_| format!("{}: not a valid extended public key (checksum, version or length)", at("xpub")))?;
            if xpub.network != network {
                return Err(format!("{}: network does not match the manifest", at("xpub")));
            }
            if let Some(path) = &path {
                if xpub.depth as usize != path.len() {
                    return Err(format!("{}: depth {} does not match path length {}", at("xpub"), xpub.depth, path.len()));
                }
                match path.last() {
                    Some(&last) if u32::from(xpub.child_number) != last => {
                        return Err(format!("{}: child number does not match the last path index", at("xpub")))
                    }
                    None if xpub.parent_fingerprint.to_bytes() != [0; 4] || u32::from(xpub.child_number) != 0 => {
                        return Err(format!("{}: depth-0 key with a parent", at("xpub")))
                    }
                    _ => {}
                }
                if path.len() == 1 && sfp.is_some_and(|fp| fp != xpub.parent_fingerprint.to_bytes()) {
                    return Err(format!("{}: parent fingerprint does not match the signer", at("xpub")));
                }
            }
            if kid(&xpub) != k {
                return Err(format!("{}: does not match the xpub", at("kid")));
            }
            xpub_s = Some(x.to_string());
        }
        if by_kid.insert(k, r as u32).is_some() {
            return Err(format!("{}: duplicate key (each key belongs to exactly one signer)", at("kid")));
        }
        if let (Some(fp), Some(path)) = (sfp, path) {
            if by_origin.insert((fp, path), r as u32).is_some() {
                return Err(format!("{}: duplicate fingerprint and path", at("path")));
            }
        }
        signers[signer as usize].keys += 1;
        entries.push(Entry { signer, kid: k, xpub: xpub_s, path: path_s.map(str::to_string), account, status });
    }
    Ok(Manifest { network, signers, entries, by_kid, by_origin, by_fp })
}

/// Raw scan before parsing, so private keys are refused even inside unexpected fields.
fn looks_private_anywhere(src: &str) -> bool {
    let b = src.as_bytes();
    let b58 = |c: u8| c.is_ascii_alphanumeric() && !matches!(c, b'0' | b'O' | b'I' | b'l');
    let mut i = 0;
    while let Some(p) = src[i..].find("prv") {
        let at = i + p;
        let start = at.saturating_sub(1);
        let run = b[start..].iter().take_while(|&&c| b58(c)).count();
        if at >= 1 && b"xtyzuvYZUV".contains(&b[at - 1]) && run >= 100 {
            return true;
        }
        i = at + 3;
    }
    false
}

fn path_string(p: &[u32]) -> String {
    let mut s = String::from("m");
    for &c in p {
        s += &if c >= 0x8000_0000 { format!("/{}h", c & 0x7fff_ffff) } else { format!("/{c}") };
    }
    s
}

fn signer_json(s: &Signer, id: u32) -> Value {
    json!({
        "index": id, "id": s.id, "label": s.label, "group": s.group, "role": s.role,
        "fingerprint": s.fingerprint.map(|f| to_hex(&f)), "keys": s.keys,
    })
}

#[wasm_bindgen]
impl Manifest {
    /// Network, key count and signers (no key material).
    pub fn summary(&self) -> String {
        json!({
            "network": if self.network == NetworkKind::Main { "bitcoin" } else { "test" },
            "keys": self.entries.len(),
            "signers": self.signers.iter().enumerate().map(|(i, s)| signer_json(s, i as u32)).collect::<Vec<_>>(),
        })
        .to_string()
    }

    /// Matches one descriptor key: `conflict`, `match`, `known-device` or `unknown`.
    #[wasm_bindgen(js_name = matchKey)]
    pub fn match_key(&self, key: &str) -> String {
        let Ok(k) = DescriptorPublicKey::from_str(key.trim()) else {
            return json!({ "result": "unknown" }).to_string();
        };
        let (xkey, origin) = match &k {
            DescriptorPublicKey::XPub(x) => (Some(x.xkey), x.origin.clone()),
            DescriptorPublicKey::MultiXPub(x) => (Some(x.xkey), x.origin.clone()),
            DescriptorPublicKey::Single(s) => (None, s.origin.clone()),
        };
        let origin = origin.map(|(fp, p)| (fp.to_bytes(), p.into_iter().map(|c| u32::from(*c)).collect::<Vec<u32>>()));
        let by_kid = xkey.and_then(|x| self.by_kid.get(&kid(&x)).copied());
        let by_origin = origin.as_ref().and_then(|o| self.by_origin.get(o).copied());
        let entry = |r: u32| {
            let e = &self.entries[r as usize];
            json!({
                "signer": signer_json(&self.signers[e.signer as usize], e.signer), "path": e.path,
                "xpub": e.xpub, "kid": to_hex(&e.kid), "account": e.account, "status": e.status,
            })
        };
        // What the descriptor itself claims, for side-by-side display with the manifest.
        let claimed = json!({
            "fingerprint": origin.as_ref().map(|(fp, _)| to_hex(fp)),
            "path": origin.as_ref().map(|(_, p)| path_string(p)),
            "xpub": xkey.map(|x| x.to_string()),
            "kid": xkey.map(|x| to_hex(&kid(&x))),
        });
        if let Some(r) = by_origin {
            if by_kid != Some(r) {
                return json!({ "result": "conflict", "claimed": entry(r), "descriptor": claimed }).to_string();
            }
        }
        if let Some(r) = by_kid {
            let e = &self.entries[r as usize];
            let s = &self.signers[e.signer as usize];
            let mismatch = match (&origin, s.fingerprint) {
                (None, _) => Some("no-origin"),
                (Some((fp, _)), Some(sfp)) if *fp != sfp => Some("fingerprint"),
                (Some((_, p)), _) if e.path.as_deref().is_some_and(|ep| parse_path(ep).as_ref() != Some(p)) => Some("path"),
                _ => None,
            };
            let mut v = entry(r);
            v["result"] = "match".into();
            v["originMismatch"] = mismatch.into();
            v["descriptor"] = claimed;
            return v.to_string();
        }
        if let Some(&s) = origin.as_ref().and_then(|(fp, _)| self.by_fp.get(fp)) {
            return json!({ "result": "known-device", "signer": signer_json(&self.signers[s as usize], s), "descriptor": claimed }).to_string();
        }
        json!({ "result": "unknown", "descriptor": claimed }).to_string()
    }
}

/// Loads and strictly validates a manifest. Throws a message naming location and rule.
#[wasm_bindgen(js_name = komLoad)]
pub fn kom_load(src: &str) -> Result<Manifest, String> {
    load(src)
}

/// Key id of an extended public key, for converters and tests.
#[wasm_bindgen(js_name = komKid)]
pub fn kom_kid(xpub: &str) -> String {
    Xpub::from_str(xpub).map(|x| to_hex(&kid(&x))).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths() {
        assert_eq!(parse_path("m"), Some(vec![]));
        assert_eq!(parse_path("m/48h/0h/0h/2h").unwrap().len(), 4);
        for bad in ["48h/0h", "m/48'/0h", "m//1", "m/01", "m/2147483648", "m/1H", "m/"] {
            assert_eq!(parse_path(bad), None, "{bad}");
        }
    }

    #[test]
    fn private_text() {
        assert!(looks_private("abandon ability able about above absent absorb abstract absurd abuse access accident"));
        assert!(!looks_private("Signer 1"));
    }
}
