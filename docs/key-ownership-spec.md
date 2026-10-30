# Key Ownership Manifest (KOM) v1

Status: draft, implemented by Miniscript Studio · File extension: `.kom.json`

## Purpose

Organisations keep their public keys in many different inventories. KOM is one common,
strictly validated format those inventories are converted into, so that any descriptor,
whether designed in the studio or imported, can be checked against it:

> Which keys in this descriptor do **we** control, which belong to a signer we know but don't
> control, and which are unknown or suspicious?

A manifest contains **public data only**. Readers and converters reject any file that holds
private key material (see [Rejection](#rejection)).

## How it fits together

```
your key inventories ──converter──▶ .kom.json ──▶ Studio: "Ownership" ──▶ every key in the design
   (any layout)                     (signers +       user ticks the          marked ours / known /
                                     public keys)    signers they control    unknown / conflict
```

- **Converter**: turns an organisation's own inventory files into a manifest. Converters
  are specific to each organisation's file layouts and are not part of this spec; they MUST
  apply the validation and rejection rules below to their inputs.
- **Manifest**: describes signers and keys. It does **not** say who controls them.
- **Control is chosen on import.** The person loading the manifest ticks the signers they
  control. The same manifest can be "ours" for one team and "theirs" for another.

## File format

JSON, UTF-8. Unknown fields anywhere are an error.

```jsonc
{
  "format": "miniscript-studio/key-ownership",
  "version": 1,
  "network": "bitcoin",                        // bitcoin | testnet | signet | regtest
  "created": "2026-01-01T00:00:00Z",           // optional
  "provenance": [                               // optional: which inputs were converted
    { "file": "inventory-export.json", "sha256": "<64 hex>" }
  ],
  "signers": {                                  // one per master seed / signing device
    "signer-a": { "label": "Signer A", "group": "Treasury", "fingerprint": "d34db33f", "role": "cold" },
    "signer-b": { "label": "Signer B", "fingerprint": null }
  },
  "keys": {                                     // columnar, for inventories of any size
    "columns": ["signer", "path", "kid", "xpub", "account", "status"],
    "rows": [
      ["signer-a", "m/48h/0h/0h/2h", "<32 hex>", "xpub6…", 0, null],
      ["signer-b", null,             "<32 hex>", "xpub6…", null, "assigned 2026-01-01"]
    ]
  }
}
```

### Signers

| Field | Required | Rule |
|---|---|---|
| id (object key) | yes | 1–64 characters from `A–Z a–z 0–9 . _ -` |
| `label` | yes | 1–64 printable characters |
| `group` | no | 1–64 printable characters, e.g. a team or service name |
| `fingerprint` | no | BIP-32 master fingerprint, 8 lowercase hex, or `null` when unknown. Unique across signers |
| `role` | no | One of `hardware`, `mobile`, `cold`, `vendor`, `heir`, `friend` (used as the key block's role) |

### Keys

`rows[i][j]` is the value of `columns[j]`. Readers look columns up by name; unknown or
duplicate columns are an error.

| Column | Required | Rule |
|---|---|---|
| `signer` | yes | A signer id |
| `path` | yes (value may be `null`) | Full path from the master in canonical form, or `null` if the source never recorded it |
| `kid` | yes | Key id, 32 lowercase hex (below). Unique across the manifest |
| `xpub` | no | Extended public key, `xpub…` (mainnet) or `tpub…` (test networks), or `null` |
| `account` | no | Non-negative integer or `null`, for display |
| `status` | no | 1–64 printable characters or `null`, e.g. a lifecycle note from the source |

**Key id.** `kid = hex(sha256(chain_code ‖ compressed_public_key))[0:32]`, i.e. the first 16
bytes. It depends only on the key material, not on version bytes, so it stays the same however
the key was serialised. An xpub cannot be recovered from its `kid`.

**Key-id-only manifests.** Omitting the `xpub` column (or leaving it `null`) gives a
smaller manifest that loads much faster, and one that does not reveal any addresses: matching
still works because descriptor keys are reduced to their `kid`. Recommended for large
inventories (hundreds of thousands of keys).

## Validation

Validation never repairs input. A value that does not meet its rule rejects the whole file.

| Item | Canonical (required in a manifest) | Malformed |
|---|---|---|
| Fingerprint | 8 lowercase hex | anything else |
| Path | `m`, then `/index` or `/indexh`; no leading zeros; index < 2³¹ | `'` or `H` markers, missing `m`, empty components, out-of-range indexes |
| xpub | Base58Check, `xpub`/`tpub` version, valid curve point | bad checksum or length; private or other versions; wrong network |
| xpub vs path | depth = number of path components; child number = last component; a depth-0 key has no parent; a depth-1 key's parent fingerprint = the signer's fingerprint | any mismatch |
| xpub vs kid | `kid` computed from the xpub equals the `kid` column | mismatch |
| Uniqueness | each `kid` once; each (signer fingerprint, path) once; each fingerprint on one signer | duplicates |

Converters may accept the spellings BIP-32 and BIP-380 themselves allow (`'` or `h` for
hardened, upper-case fingerprints, SLIP-132 `ypub`/`zpub`/… versions) and rewrite them in
canonical form. Anything the standards do not allow (for example a key origin written as
`[d34db33f/m/48'/…]`) is malformed, and the converter rejects the whole input file.

## Matching

Each descriptor key is reduced to its `kid` and its origin `[fingerprint/path]`, then gets
exactly one result, checked in this order:

| Result | Condition | Shown as |
|---|---|---|
| **conflict** | The origin equals a manifest entry's signer fingerprint and path, but the `kid` differs | Red: the key claims to be a known signer but is not. Possible key substitution |
| **ours** | The `kid` matches a key whose signer the user ticked | Green |
| **known** | The `kid` matches a key whose signer the user did not tick | Blue |
| **known device** | Only the origin fingerprint matches a signer | Amber: same device, account not in the manifest |
| **unknown** | Nothing matches | Grey |

When the `kid` matches but the descriptor's origin is missing or differs from the manifest
(a **blinded** origin, e.g. a `00000000` or decoy fingerprint, or a different path), the result
is still *ours*/*known*: the key id depends only on the key material, so blinding the origin
does not hide ownership. The reader shows the signer's **true** fingerprint, path and (if the
manifest has it) xpub next to what the descriptor claims, and warns that hardware signers may
not recognise the key until the true origin is restored.

## Rejection

A reader or converter rejects the whole input, and loads or writes nothing, when:

- any value is malformed (see [Validation](#validation));
- the file has unknown fields, or (for converters) matches no known input layout exactly;
- private key material appears anywhere: an extended private key (`xprv`, `tprv`, …),
  a WIF private key, a BIP-39 mnemonic-shaped phrase, or a non-empty field named `secrets`,
  `xpriv`, `xprv`, `private`, `privkey`, `seed`, `mnemonic`, `passphrase` or `wif`;
- (converters) an input is encrypted.

Error messages name the file, row, field and broken rule, **never the value**. There are no
partial imports: one bad record makes the whole inventory suspect and it must be fixed at
the source.

## In Miniscript Studio

- **Ownership** (top bar) loads a manifest. It is validated in WebAssembly and kept only in
  that tab's memory. It is never saved, uploaded or included in share links.
- The dialog lists every signer (label, group, fingerprint, key count) with a checkbox: tick
  the ones you control. The selection, not the keys, is remembered per file (by its sha256).
- Key blocks get a badge named after the signer: green when it's a signer you ticked
  (*ours*), blue when known but not yours, "*Signer* · other account" for a known device with an
  unlisted account, "conflict: *Signer*" for a mismatch, otherwise "unknown". *· blinded* is
  appended when the origin is hidden or differs. Clicking the badge, or *Show manifest
  entry* in the key inspector, opens the manifest entry side by side with the descriptor:
  master fingerprint, path, xpub and key id, with differences highlighted.
- For a blinded origin, **Restore true origin** rewrites only the key's origin to the
  manifest's fingerprint and path. The script and addresses do not change.
- **Paths** marks each spending path *we can sign alone* or *needs N other signers*;
  **Wallet** summarises "N of M keys ours".
- **Import**: when a descriptor's keys are in the manifest, the signer-naming step pre-fills
  their names and roles.
