//! The hodios catalog v1 format (hermes-hq/hodios-dist `catalog/v1`) and
//! its hash chain.
//!
//! `manifest.json` is the only mutable object. It names, by sha256, the
//! shard list of each tier, the vocab and the packs; a shard list names its
//! NDJSON shards, and every row names its body object. Every object lives at
//! `o/<aa>/<sha256>` and is checked against its own name before it is used,
//! so a catalog is either verified end to end or refused. Readers ignore
//! fields they do not know (they survive in the stored row JSON).

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::Read;

/// The only manifest schema this client reads.
pub const MANIFEST_SCHEMA: u32 = 1;
/// The hodios client version this build implements (`minClientVersion`).
pub const CLIENT_VERSION: &str = "0.1.0";

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    format!("{:x}", h.finalize())
}

/// `sha256:<64 hex>` -> `<64 hex>`.
pub fn parse_ref(reference: &str) -> Result<String, String> {
    let hex = reference
        .strip_prefix("sha256:")
        .ok_or_else(|| format!("not a sha256 reference: {reference}"))?;
    if hex.len() != 64
        || !hex
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(format!("not a sha256 reference: {reference}"));
    }
    Ok(hex.to_string())
}

/// Path of an object under `catalog/v1`.
pub fn object_rel(hex: &str) -> String {
    format!("o/{}/{}", &hex[..2], hex)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TierRef {
    pub list: String,
    #[serde(default)]
    pub rows: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub schema: u32,
    pub catalog: String,
    pub seq: i64,
    #[serde(default)]
    pub min_client_version: Option<String>,
    #[serde(default)]
    pub objects: Option<String>,
    #[serde(default)]
    pub tiers: BTreeMap<String, TierRef>,
    #[serde(default)]
    pub deltas: Vec<Value>,
    #[serde(default)]
    pub packs: BTreeMap<String, Value>,
    #[serde(default)]
    pub vocab: Option<String>,
    /// `id@version` (or a bare id) of entries taken down; hidden on apply.
    #[serde(default)]
    pub revoked: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShardRef {
    pub object: String,
    #[serde(default)]
    pub rows: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShardList {
    pub schema: u32,
    #[serde(default)]
    pub shards: BTreeMap<String, ShardRef>,
}

/// One catalog row (the compact metadata of an entry). Unknown fields stay
/// in the raw JSON stored next to it.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct Row {
    pub id: String,
    #[serde(default)]
    pub v: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub cat: String,
    #[serde(default)]
    pub dom: String,
    #[serde(default)]
    pub sub: Option<String>,
    #[serde(default)]
    pub tier: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub desc: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub stage: Vec<String>,
    #[serde(default)]
    pub stack: Vec<String>,
    #[serde(default)]
    pub role: Vec<String>,
    #[serde(default)]
    pub subject: Vec<String>,
    #[serde(default, rename = "in")]
    pub inputs: Vec<String>,
    #[serde(default)]
    pub out: Vec<String>,
    #[serde(default)]
    pub works: Vec<String>,
    #[serde(default)]
    pub risk: Option<String>,
    #[serde(default)]
    pub level: Option<String>,
    #[serde(default)]
    pub lang: Option<String>,
    #[serde(default)]
    pub q: i64,
    #[serde(default)]
    pub u: i64,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub bytes: Option<i64>,
    #[serde(default)]
    pub updated: Option<String>,
}

/// Tier order of the static rank (lower first).
pub fn tier_order(tier: &str) -> i64 {
    match tier {
        "curated" => 0,
        "verified" => 1,
        "community" => 2,
        _ => 9,
    }
}

/// hodios-core `compareStatic`: tier, deprecated last, quality, usage, id.
pub fn compare_static(a: &Row, b: &Row) -> std::cmp::Ordering {
    tier_order(&a.tier)
        .cmp(&tier_order(&b.tier))
        .then((a.status == "deprecated").cmp(&(b.status == "deprecated")))
        .then(b.q.cmp(&a.q))
        .then(b.u.cmp(&a.u))
        .then(a.id.cmp(&b.id))
}

// ─── Vocab ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct FacetVocab {
    #[serde(default)]
    pub labels: HashMap<String, String>,
    #[serde(default)]
    pub synonyms: HashMap<String, String>,
    #[serde(default)]
    pub implies: HashMap<String, Vec<String>>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DetectRule {
    #[serde(default)]
    pub files: Vec<String>,
    #[serde(default)]
    pub deps: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Vocab {
    #[serde(default)]
    pub facets: HashMap<String, FacetVocab>,
    /// category -> domain
    #[serde(default)]
    pub domains: HashMap<String, String>,
    #[serde(default)]
    pub detect: BTreeMap<String, DetectRule>,
}

impl Vocab {
    pub fn label<'a>(&'a self, facet: &str, value: &'a str) -> &'a str {
        self.facets
            .get(facet)
            .and_then(|f| f.labels.get(value))
            .map(String::as_str)
            .unwrap_or(value)
    }

    /// A query value in its canonical spelling (synonyms resolved).
    pub fn canonical(&self, facet: &str, value: &str) -> String {
        self.facets
            .get(facet)
            .and_then(|f| f.synonyms.get(value))
            .cloned()
            .unwrap_or_else(|| value.to_string())
    }

    /// Values that imply `value`, transitively (rows on `nextjs` match `stack:react`).
    pub fn implied_from(&self, facet: &str, value: &str) -> HashSet<String> {
        let mut out: HashSet<String> = HashSet::from([value.to_string()]);
        let Some(implies) = self.facets.get(facet).map(|f| &f.implies) else {
            return out;
        };
        loop {
            let before = out.len();
            for (from, targets) in implies {
                if !out.contains(from) && targets.iter().any(|t| out.contains(t)) {
                    out.insert(from.clone());
                }
            }
            if out.len() == before {
                return out;
            }
        }
    }

    /// Values `value` implies, transitively (a `nextjs` project also uses `react`).
    pub fn implies_of(&self, facet: &str, value: &str) -> HashSet<String> {
        let mut out: HashSet<String> = HashSet::from([value.to_string()]);
        let Some(implies) = self.facets.get(facet).map(|f| &f.implies) else {
            return out;
        };
        let mut queue = vec![value.to_string()];
        while let Some(next) = queue.pop() {
            for v in implies.get(&next).into_iter().flatten() {
                if out.insert(v.clone()) {
                    queue.push(v.clone());
                }
            }
        }
        out
    }
}

// ─── Collecting a verified catalog ────────────────────────────────────

/// Where objects come from (the bundled archive, a mirror, the local store).
pub trait ObjectSource {
    /// The bytes of object `hex` (unverified; the caller checks the hash).
    fn get(&mut self, hex: &str) -> Result<Vec<u8>, String>;
}

impl ObjectSource for HashMap<String, Vec<u8>> {
    fn get(&mut self, hex: &str) -> Result<Vec<u8>, String> {
        HashMap::get(self, &object_rel(hex))
            .cloned()
            .ok_or_else(|| format!("object {hex} is missing"))
    }
}

/// A catalog whose every object was checked against its hash.
#[derive(Debug, Clone)]
pub struct VerifiedCatalog {
    pub manifest: Manifest,
    pub manifest_bytes: Vec<u8>,
    pub manifest_sha: String,
    /// Shard lists, shards, the vocab and packs: (hex, bytes).
    pub objects: Vec<(String, Vec<u8>)>,
    /// Every row with its raw JSON line.
    pub rows: Vec<(Row, String)>,
    pub vocab: Option<Vocab>,
    /// Body objects: (hex, bytes).
    pub bodies: Vec<(String, Vec<u8>)>,
}

fn fetch_verified(
    source: &mut dyn ObjectSource,
    reference: &str,
    what: &str,
) -> Result<(String, Vec<u8>), String> {
    let hex = parse_ref(reference).map_err(|e| format!("{what}: {e}"))?;
    let bytes = source.get(&hex).map_err(|e| format!("{what}: {e}"))?;
    let got = sha256_hex(&bytes);
    if got != hex {
        return Err(format!(
            "{what}: object {hex} has sha256 {got}; refusing the catalog"
        ));
    }
    Ok((hex, bytes))
}

/// Checks the manifest's own fields: schema, client version, object layout.
pub fn check_manifest(manifest: &Manifest) -> Result<(), String> {
    if manifest.schema != MANIFEST_SCHEMA {
        return Err(format!(
            "catalog schema {} is newer than this Hermes reads ({MANIFEST_SCHEMA}); update Hermes to get newer library content",
            manifest.schema
        ));
    }
    if let Some(min) = &manifest.min_client_version {
        if version_gt(min, CLIENT_VERSION) {
            return Err(format!(
                "the catalog needs library client {min} (this Hermes has {CLIENT_VERSION}); update Hermes to get newer library content"
            ));
        }
    }
    if let Some(layout) = &manifest.objects {
        if layout != "o/{aa}/{sha256}" {
            return Err(format!("unknown object layout {layout}"));
        }
    }
    Ok(())
}

/// Dotted numeric versions: a > b.
pub fn version_gt(a: &str, b: &str) -> bool {
    let parse = |s: &str| -> Vec<u64> {
        s.split(['.', '-'])
            .map(|p| p.parse::<u64>().unwrap_or(0))
            .collect()
    };
    let (x, y) = (parse(a), parse(b));
    for i in 0..x.len().max(y.len()) {
        let (p, q) = (
            x.get(i).copied().unwrap_or(0),
            y.get(i).copied().unwrap_or(0),
        );
        if p != q {
            return p > q;
        }
    }
    false
}

/// Walks the hash chain from `manifest_bytes`. Bodies are collected when
/// `with_bodies` (all of them: the same set for everyone, so a download
/// reveals no interest); `known_bodies` are skipped (already stored).
pub fn collect(
    manifest_bytes: &[u8],
    source: &mut dyn ObjectSource,
    with_bodies: bool,
    known_bodies: &HashSet<String>,
) -> Result<VerifiedCatalog, String> {
    let manifest: Manifest = serde_json::from_slice(manifest_bytes)
        .map_err(|e| format!("manifest is not valid JSON: {e}"))?;
    check_manifest(&manifest)?;
    let mut objects = Vec::new();
    let mut vocab = None;
    if let Some(reference) = &manifest.vocab {
        let (hex, bytes) = fetch_verified(source, reference, "vocab")?;
        vocab = Some(serde_json::from_slice::<Vocab>(&bytes).map_err(|e| format!("vocab: {e}"))?);
        objects.push((hex, bytes));
    }
    for (name, pack) in &manifest.packs {
        let reference = pack.as_str().map(str::to_string).or_else(|| {
            pack.get("object")
                .and_then(Value::as_str)
                .map(str::to_string)
        });
        if let Some(reference) = reference {
            objects.push(fetch_verified(source, &reference, &format!("pack {name}"))?);
        }
    }
    let mut rows = Vec::new();
    for (tier, tier_ref) in &manifest.tiers {
        let (hex, bytes) = fetch_verified(source, &tier_ref.list, &format!("{tier} shard list"))?;
        let list: ShardList =
            serde_json::from_slice(&bytes).map_err(|e| format!("{tier} shard list: {e}"))?;
        if list.schema != 1 {
            return Err(format!(
                "{tier} shard list schema {} is not supported",
                list.schema
            ));
        }
        objects.push((hex, bytes));
        let mut tier_rows = 0i64;
        for (prefix, shard) in &list.shards {
            let what = format!("{tier} shard \"{prefix}\"");
            let (hex, bytes) = fetch_verified(source, &shard.object, &what)?;
            let text = std::str::from_utf8(&bytes).map_err(|e| format!("{what}: {e}"))?;
            let mut n = 0i64;
            for line in text.lines().filter(|l| !l.trim().is_empty()) {
                let row: Row =
                    serde_json::from_str(line).map_err(|e| format!("{what}: bad row: {e}"))?;
                if row.id.is_empty() {
                    return Err(format!("{what}: a row has no id"));
                }
                // The stored tier is the row's own field: it must be the
                // tier of the list the row came from.
                if &row.tier != tier {
                    return Err(format!("{what}: {} says tier \"{}\"", row.id, row.tier));
                }
                rows.push((row, line.to_string()));
                n += 1;
            }
            if let Some(expected) = shard.rows {
                if expected != n {
                    return Err(format!("{what} has {n} rows, its list says {expected}"));
                }
            }
            tier_rows += n;
            objects.push((hex, bytes));
        }
        if let Some(expected) = tier_ref.rows {
            if expected != tier_rows {
                return Err(format!(
                    "{tier} tier has {tier_rows} rows, the manifest says {expected}"
                ));
            }
        }
    }
    let mut seen = HashSet::new();
    for (row, _) in &rows {
        if !seen.insert(row.id.clone()) {
            return Err(format!("the catalog lists {} twice", row.id));
        }
    }
    let mut bodies = Vec::new();
    if with_bodies {
        let mut wanted = HashSet::new();
        for (row, _) in &rows {
            if row.body.is_empty() {
                continue;
            }
            let hex = parse_ref(&row.body).map_err(|e| format!("{}: {e}", row.id))?;
            if known_bodies.contains(&hex) || !wanted.insert(hex) {
                continue;
            }
            bodies.push(fetch_verified(
                source,
                &row.body,
                &format!("body of {}", row.id),
            )?);
        }
    }
    Ok(VerifiedCatalog {
        manifest_sha: sha256_hex(manifest_bytes),
        manifest,
        manifest_bytes: manifest_bytes.to_vec(),
        objects,
        rows,
        vocab,
        bodies,
    })
}

// ─── The bundled archive (tar + zstd) ─────────────────────────────────

/// Reads `catalog-v1.tar.zst` into a map of `rel path -> bytes`.
pub fn read_archive(bytes: &[u8]) -> Result<HashMap<String, Vec<u8>>, String> {
    let decoder = ruzstd::decoding::StreamingDecoder::new(bytes)
        .map_err(|e| format!("the bundled library archive is not zstd: {e}"))?;
    let mut archive = tar::Archive::new(decoder);
    let mut out = HashMap::new();
    for entry in archive
        .entries()
        .map_err(|e| format!("the bundled library archive is not a tar: {e}"))?
    {
        let mut entry = entry.map_err(|e| format!("bundled library archive: {e}"))?;
        if !entry.header().entry_type().is_file() {
            continue;
        }
        let path = entry
            .path()
            .map_err(|e| format!("bundled library archive: {e}"))?
            .to_string_lossy()
            .replace('\\', "/");
        let mut data = Vec::with_capacity(entry.size() as usize);
        entry
            .read_to_end(&mut data)
            .map_err(|e| format!("bundled library archive: {e}"))?;
        out.insert(path, data);
    }
    Ok(out)
}

#[cfg(test)]
pub mod tests {
    use super::*;

    /// A small catalog in memory, laid out like hodios-dist.
    pub struct Fixture {
        pub objects: HashMap<String, Vec<u8>>,
        pub manifest: Vec<u8>,
    }

    pub fn put(objects: &mut HashMap<String, Vec<u8>>, bytes: Vec<u8>) -> String {
        let hex = sha256_hex(&bytes);
        objects.insert(object_rel(&hex), bytes);
        format!("sha256:{hex}")
    }

    pub fn row_json(id: &str, extra: serde_json::Value, body: &str) -> serde_json::Value {
        let mut row = serde_json::json!({
            "id": id, "v": "1.0.0", "kind": "prompt", "cat": "testing", "dom": "software-engineering",
            "tier": "curated", "status": "incubating", "title": id.replace('-', " "),
            "desc": format!("Description of {id}."), "tags": [], "stage": [], "stack": [], "role": [],
            "subject": [], "in": [], "out": [], "works": ["claude-code", "codex"], "q": 0, "u": 0,
            "aliases": [], "body": body,
        });
        if let (Some(obj), Some(extra)) = (row.as_object_mut(), extra.as_object()) {
            for (k, v) in extra {
                obj.insert(k.clone(), v.clone());
            }
        }
        row
    }

    /// Builds a catalog from `(id, extra fields, body text)`.
    pub fn fixture(
        catalog: &str,
        seq: i64,
        entries: &[(&str, serde_json::Value, &str)],
    ) -> Fixture {
        let mut objects = HashMap::new();
        // One shard list per tier, like hodios-dist (a row's tier comes
        // from its `tier` field, curated when the entry does not say).
        let mut lines: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for (id, extra, body) in entries {
            let body_obj = serde_json::json!({
                "schema": 1,
                "fm": { "id": id, "kind": extra.get("kind").cloned().unwrap_or("prompt".into()), "title": id, "version": "1.0.0",
                        "args": extra.get("args").cloned().unwrap_or(serde_json::json!([])) },
                "body": body, "steps": [],
            });
            let body_ref = put(&mut objects, serde_json::to_vec(&body_obj).unwrap());
            let tier = extra
                .get("tier")
                .and_then(|t| t.as_str())
                .unwrap_or("curated");
            lines
                .entry(tier.to_string())
                .or_default()
                .push(row_json(id, extra.clone(), &body_ref).to_string());
        }
        let mut tiers = serde_json::Map::new();
        for (tier, tier_lines) in &lines {
            let shard = put(
                &mut objects,
                format!("{}\n", tier_lines.join("\n")).into_bytes(),
            );
            let list = put(
                &mut objects,
                serde_json::to_vec(&serde_json::json!({
                    "schema": 1, "tier": tier, "prefixLen": 0,
                    "shards": { "": { "object": shard, "rows": tier_lines.len() } }
                }))
                .unwrap(),
            );
            tiers.insert(
                tier.clone(),
                serde_json::json!({ "list": list, "rows": tier_lines.len() }),
            );
        }
        let vocab = put(
            &mut objects,
            serde_json::to_vec(&serde_json::json!({
                "schema": 1,
                "facets": {
                    "stack": { "labels": { "react": "React", "typescript": "TypeScript", "nextjs": "Next.js", "python": "Python" },
                               "synonyms": { "reactjs": "react", "ts": "typescript" },
                               "implies": { "nextjs": ["react"] } },
                    "category": { "labels": { "testing": "Testing", "debugging": "Debugging", "code-review": "Code review" }, "synonyms": {}, "implies": {} },
                    "domain": { "labels": { "software-engineering": "Software engineering", "writing": "Writing" }, "synonyms": {}, "implies": {} },
                    "role": { "labels": { "frontend-engineer": "Frontend engineer" }, "synonyms": {}, "implies": {} }
                },
                "domains": { "testing": "software-engineering", "debugging": "software-engineering" },
                "detect": {
                    "typescript": { "files": ["tsconfig.json", "*.ts", "*.tsx"], "deps": ["npm:typescript"] },
                    "react": { "deps": ["npm:react"] },
                    "python": { "files": ["pyproject.toml", "*.py"] },
                    "rust": { "files": ["Cargo.toml"] }
                }
            }))
            .unwrap(),
        );
        let manifest = serde_json::to_vec(&serde_json::json!({
            "schema": 1, "catalog": catalog, "seq": seq, "minClientVersion": "0.1.0",
            "objects": "o/{aa}/{sha256}",
            "tiers": tiers,
            "deltas": [], "packs": {}, "vocab": vocab
        }))
        .unwrap();
        Fixture { objects, manifest }
    }

    pub fn three() -> Fixture {
        fixture(
            "2026.0101.0",
            1,
            &[
                (
                    "write-component-tests",
                    serde_json::json!({"stack": ["react"], "role": ["frontend-engineer"], "tags": ["vitest", "jest"]}),
                    "Write tests for {{component}}.",
                ),
                (
                    "find-root-cause",
                    serde_json::json!({"cat": "debugging", "aliases": ["debug-root-cause"], "tags": ["bug"]}),
                    "Find the root cause of {{symptom}}.",
                ),
                (
                    "summarize-notes",
                    serde_json::json!({"cat": "editing", "dom": "writing", "works": ["chatgpt"]}),
                    "Summarize.",
                ),
            ],
        )
    }

    #[test]
    fn collects_a_catalog_and_checks_every_hash() {
        let f = three();
        let mut src = f.objects.clone();
        let cat = collect(&f.manifest, &mut src, true, &HashSet::new()).unwrap();
        assert_eq!(cat.rows.len(), 3);
        assert_eq!(cat.bodies.len(), 3);
        assert!(cat.vocab.is_some());
        assert_eq!(cat.manifest.catalog, "2026.0101.0");
    }

    #[test]
    fn collects_every_tier_and_refuses_a_row_in_the_wrong_list() {
        let f = fixture(
            "2026.0101.0",
            1,
            &[
                ("a-curated", serde_json::json!({}), "A."),
                ("b-verified", serde_json::json!({"tier": "verified"}), "B."),
                ("c-verified", serde_json::json!({"tier": "verified"}), "C."),
            ],
        );
        let mut src = f.objects.clone();
        let cat = collect(&f.manifest, &mut src, true, &HashSet::new()).unwrap();
        let mut tiers: Vec<(String, String)> = cat
            .rows
            .iter()
            .map(|(r, _)| (r.id.clone(), r.tier.clone()))
            .collect();
        tiers.sort();
        assert_eq!(
            tiers,
            [
                ("a-curated".into(), "curated".into()),
                ("b-verified".into(), "verified".into()),
                ("c-verified".into(), "verified".into()),
            ]
        );
        assert_eq!(cat.bodies.len(), 3);

        // A verified row whose own field says curated is refused.
        let mut objects = HashMap::new();
        let mut m: serde_json::Value = serde_json::from_slice(&f.manifest).unwrap();
        let row = row_json("b-verified", serde_json::json!({}), "sha256:00");
        let shard = put(&mut objects, format!("{row}\n").into_bytes());
        let list = put(
            &mut objects,
            serde_json::to_vec(&serde_json::json!({
                "schema": 1, "tier": "verified", "prefixLen": 0,
                "shards": { "": { "object": shard, "rows": 1 } }
            }))
            .unwrap(),
        );
        m["tiers"]["verified"] = serde_json::json!({ "list": list, "rows": 1 });
        let mut src = f.objects.clone();
        src.extend(objects);
        let err = collect(
            &serde_json::to_vec(&m).unwrap(),
            &mut src,
            false,
            &HashSet::new(),
        )
        .unwrap_err();
        assert!(err.contains("b-verified says tier \"curated\""), "{err}");
    }

    #[test]
    fn refuses_a_tampered_object_at_every_level() {
        let f = three();
        for (rel, bytes) in f.objects.iter() {
            let mut src = f.objects.clone();
            let mut bad = bytes.clone();
            bad.push(b' ');
            src.insert(rel.clone(), bad);
            let err = collect(&f.manifest, &mut src, true, &HashSet::new()).unwrap_err();
            assert!(err.contains("refusing"), "{rel}: {err}");
        }
    }

    #[test]
    fn refuses_a_missing_object_and_wrong_counts() {
        let f = three();
        let mut src: HashMap<String, Vec<u8>> = HashMap::new();
        assert!(collect(&f.manifest, &mut src, true, &HashSet::new()).is_err());
        let mut m: serde_json::Value = serde_json::from_slice(&f.manifest).unwrap();
        m["tiers"]["curated"]["rows"] = 4.into();
        let mut src = f.objects.clone();
        let err = collect(
            &serde_json::to_vec(&m).unwrap(),
            &mut src,
            false,
            &HashSet::new(),
        )
        .unwrap_err();
        assert!(err.contains("rows"), "{err}");
    }

    #[test]
    fn refuses_a_newer_schema_or_client() {
        let f = three();
        let mut m: serde_json::Value = serde_json::from_slice(&f.manifest).unwrap();
        m["schema"] = 2.into();
        let mut src = f.objects.clone();
        let err = collect(
            &serde_json::to_vec(&m).unwrap(),
            &mut src,
            false,
            &HashSet::new(),
        )
        .unwrap_err();
        assert!(err.contains("update Hermes"), "{err}");
        m["schema"] = 1.into();
        m["minClientVersion"] = "9.0.0".into();
        let err = collect(
            &serde_json::to_vec(&m).unwrap(),
            &mut src,
            false,
            &HashSet::new(),
        )
        .unwrap_err();
        assert!(err.contains("update Hermes"), "{err}");
    }

    #[test]
    fn skips_bodies_it_already_has() {
        let f = three();
        let mut src = f.objects.clone();
        let first = collect(&f.manifest, &mut src, true, &HashSet::new()).unwrap();
        let known: HashSet<String> = first.bodies.iter().map(|(h, _)| h.clone()).collect();
        let again = collect(&f.manifest, &mut src, true, &known).unwrap();
        assert!(again.bodies.is_empty());
    }

    #[test]
    fn vocab_expands_synonyms_and_implies() {
        let f = three();
        let mut src = f.objects.clone();
        let vocab = collect(&f.manifest, &mut src, false, &HashSet::new())
            .unwrap()
            .vocab
            .unwrap();
        assert_eq!(vocab.canonical("stack", "reactjs"), "react");
        assert!(vocab.implied_from("stack", "react").contains("nextjs"));
        assert!(vocab.implies_of("stack", "nextjs").contains("react"));
        assert_eq!(vocab.label("stack", "react"), "React");
    }

    #[test]
    fn version_comparison() {
        assert!(version_gt("0.2.0", "0.1.9"));
        assert!(!version_gt("0.1.0", "0.1.0"));
        assert!(version_gt("1.0", "0.9.9"));
    }

    #[test]
    fn static_order_follows_hodios_core() {
        let mut a = Row {
            id: "b".into(),
            tier: "curated".into(),
            ..Default::default()
        };
        let b = Row {
            id: "a".into(),
            tier: "verified".into(),
            q: 9,
            ..Default::default()
        };
        assert_eq!(compare_static(&a, &b), std::cmp::Ordering::Less);
        a.status = "deprecated".into();
        let c = Row {
            id: "z".into(),
            tier: "curated".into(),
            ..Default::default()
        };
        assert_eq!(compare_static(&a, &c), std::cmp::Ordering::Greater);
    }
}
