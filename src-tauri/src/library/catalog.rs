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
    h.finalize().iter().map(|b| format!("{:02x}", b)).collect()
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
    /// The compiled everyday-word routing (`queries.json`), by hash.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub queries: Option<String>,
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
    /// Essentials (hodios `essentials.yml`): 2 = a front door (level1),
    /// 1 = another everyday essential (level2), 0 = neither; higher first.
    #[serde(default)]
    pub ess: i64,
    /// Intent ids (Write, Plan, ...); from the vocab's category map when absent.
    #[serde(default, rename = "int", deserialize_with = "one_or_many")]
    pub intents: Vec<String>,
    /// Topic id (travel, food, ...); from the vocab's category map when absent.
    #[serde(default)]
    pub top: Option<String>,
    /// Extra search words: the category label and synonyms, the everyday
    /// phrases routed here, aliases.
    #[serde(default, deserialize_with = "one_or_many")]
    pub syn: Vec<String>,
    /// Professional-advice risk (medical, mental-health, legal, financial).
    #[serde(default, alias = "advice_risk", deserialize_with = "one_or_many")]
    pub adv: Vec<String>,
    /// Depth level id (vocab `depth` order); the middle level when absent.
    #[serde(default)]
    pub dep: Option<String>,
}

/// A list field that a catalog may also write as one string (or null).
fn one_or_many<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<String>, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum OneOrMany {
        One(String),
        Many(Vec<String>),
        Nothing(()),
    }
    Ok(match OneOrMany::deserialize(d)? {
        OneOrMany::One(s) if s.is_empty() => Vec::new(),
        OneOrMany::One(s) => vec![s],
        OneOrMany::Many(v) => v,
        OneOrMany::Nothing(()) => Vec::new(),
    })
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

/// Front doors first, then the other essentials, then everything else.
pub fn ess_order(ess: i64) -> i64 {
    match ess {
        2 => 0,
        1 => 1,
        _ => 2,
    }
}

/// The static rank (hodios-core `compareStatic`): deprecated last, then
/// essentials, depth (the vocab's order, basic first), commonness, tier,
/// usage, and the id only as the final tiebreak.
pub fn compare_static(a: &Row, b: &Row, vocab: &Vocab) -> std::cmp::Ordering {
    (a.status == "deprecated")
        .cmp(&(b.status == "deprecated"))
        .then(ess_order(a.ess).cmp(&ess_order(b.ess)))
        .then(
            vocab
                .depth_rank(a.dep.as_deref())
                .cmp(&vocab.depth_rank(b.dep.as_deref())),
        )
        .then(b.q.cmp(&a.q))
        .then(tier_order(&a.tier).cmp(&tier_order(&b.tier)))
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

/// One value of an ordered list in the vocab (a depth level, an intent, a topic).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Level {
    #[serde(alias = "value")]
    pub id: String,
    #[serde(default)]
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
}

/// The depth levels, in order: a list, or `{ values: [...], default }`
/// (hodios `vocab/depth.yml`; `levels` is read too). `default` is the
/// level of an entry that has none (else the middle one).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum DepthVocab {
    List(Vec<Level>),
    Wrapped {
        #[serde(alias = "levels")]
        values: Vec<Level>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        default: Option<String>,
    },
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CategoryIntent {
    #[serde(default, deserialize_with = "one_or_many")]
    pub intents: Vec<String>,
    #[serde(default)]
    pub topic: Option<String>,
}

/// `vocab/intent.yml`: intents (verbs) and topics (nouns) in display
/// order, and each category's intents and topic.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct IntentVocab {
    #[serde(default)]
    pub intents: Vec<Level>,
    #[serde(default)]
    pub topics: Vec<Level>,
    #[serde(default)]
    pub categories: HashMap<String, CategoryIntent>,
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
    /// Depth levels in order (`vocab/depth.yml`). Absent in older catalogs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub depth: Option<DepthVocab>,
    /// `vocab/intent.yml`. Absent in older catalogs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub intent: Option<IntentVocab>,
    /// The same lists at the top level (another way a catalog may carry them).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub intents: Vec<Level>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub topics: Vec<Level>,
}

impl Vocab {
    /// The depth levels in the vocab's order (none in older catalogs).
    pub fn depth_levels(&self) -> &[Level] {
        match &self.depth {
            Some(DepthVocab::List(l)) | Some(DepthVocab::Wrapped { values: l, .. }) => l,
            None => &[],
        }
    }

    /// Position of the level an entry without one gets: the vocab's
    /// `default` when it names a level, else the middle one.
    fn default_depth(&self) -> usize {
        let levels = self.depth_levels();
        let named = match &self.depth {
            Some(DepthVocab::Wrapped {
                default: Some(d), ..
            }) => levels.iter().position(|l| &l.id == d),
            _ => None,
        };
        named.unwrap_or(levels.len() / 2)
    }

    /// A row's depth level id: its own when the vocab knows it, else the
    /// default level; None when the vocab has no levels.
    pub fn depth_of(&self, dep: Option<&str>) -> Option<String> {
        let levels = self.depth_levels();
        if levels.is_empty() {
            return None;
        }
        Some(
            dep.filter(|d| levels.iter().any(|l| l.id == *d))
                .map(str::to_string)
                .unwrap_or_else(|| levels[self.default_depth()].id.clone()),
        )
    }

    /// Position of a depth level in the vocab's order (0 without levels).
    pub fn depth_rank(&self, dep: Option<&str>) -> i64 {
        let levels = self.depth_levels();
        if levels.is_empty() {
            return 0;
        }
        dep.and_then(|d| levels.iter().position(|l| l.id == d))
            .unwrap_or_else(|| self.default_depth()) as i64
    }

    /// The first depth level ("Start here"), when there are levels.
    pub fn first_depth(&self) -> Option<&str> {
        self.depth_levels().first().map(|l| l.id.as_str())
    }

    pub fn intent_list(&self) -> &[Level] {
        match &self.intent {
            Some(i) if !i.intents.is_empty() => &i.intents,
            _ => &self.intents,
        }
    }

    pub fn topic_list(&self) -> &[Level] {
        match &self.intent {
            Some(i) if !i.topics.is_empty() => &i.topics,
            _ => &self.topics,
        }
    }

    /// A category's intents and topic from `vocab/intent.yml`.
    pub fn category_intent(&self, category: &str) -> Option<&CategoryIntent> {
        self.intent.as_ref()?.categories.get(category)
    }

    pub fn topic_label<'a>(&'a self, topic: &'a str) -> &'a str {
        self.topic_list()
            .iter()
            .find(|t| t.id == topic)
            .map(|t| t.label.as_str())
            .filter(|l| !l.is_empty())
            .unwrap_or(topic)
    }

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
    /// Everyday-word routes (`queries.json`); empty in older catalogs.
    pub routes: Vec<super::everyday::Route>,
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
    let mut routes = Vec::new();
    if let Some(reference) = &manifest.vocab {
        let (hex, bytes) = fetch_verified(source, reference, "vocab")?;
        vocab = Some(serde_json::from_slice::<Vocab>(&bytes).map_err(|e| format!("vocab: {e}"))?);
        // The routes may also travel inside the vocab object.
        if let Some(q) = serde_json::from_slice::<Value>(&bytes)
            .ok()
            .and_then(|v| v.get("queries").cloned())
        {
            routes = super::everyday::parse_routes(&q);
        }
        objects.push((hex, bytes));
    }
    // The manifest's own queries object wins over a copy in the vocab.
    if let Some(reference) = &manifest.queries {
        let (hex, bytes) = fetch_verified(source, reference, "queries")?;
        let value: Value = serde_json::from_slice(&bytes).map_err(|e| format!("queries: {e}"))?;
        routes = super::everyday::parse_routes(&value);
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
        routes,
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
        fixture_with(catalog, seq, entries, serde_json::json!({}), None)
    }

    /// `fixture` with more vocab (merged at the top level) and a
    /// `queries.json` object. An entry's `fm` extra goes into its body's
    /// front matter (not its row).
    pub fn fixture_with(
        catalog: &str,
        seq: i64,
        entries: &[(&str, serde_json::Value, &str)],
        vocab_extra: serde_json::Value,
        queries: Option<serde_json::Value>,
    ) -> Fixture {
        let mut objects = HashMap::new();
        // One shard list per tier, like hodios-dist (a row's tier comes
        // from its `tier` field, curated when the entry does not say).
        let mut lines: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for (id, extra, body) in entries {
            let mut body_obj = serde_json::json!({
                "schema": 1,
                "fm": { "id": id, "kind": extra.get("kind").cloned().unwrap_or("prompt".into()), "title": id, "version": "1.0.0",
                        "args": extra.get("args").cloned().unwrap_or(serde_json::json!([])) },
                "body": body, "steps": [],
            });
            if let Some(fm) = extra.get("fm").and_then(|f| f.as_object()) {
                for (k, v) in fm {
                    body_obj["fm"][k] = v.clone();
                }
            }
            let mut extra = extra.clone();
            if let Some(o) = extra.as_object_mut() {
                o.remove("fm");
                o.remove("args");
            }
            let body_ref = put(&mut objects, serde_json::to_vec(&body_obj).unwrap());
            let tier = extra
                .get("tier")
                .and_then(|t| t.as_str())
                .unwrap_or("curated");
            lines
                .entry(tier.to_string())
                .or_default()
                .push(row_json(id, extra, &body_ref).to_string());
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
        let mut vocab_json = serde_json::json!({
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
        });
        if let (Some(v), Some(extra)) = (vocab_json.as_object_mut(), vocab_extra.as_object()) {
            for (k, x) in extra {
                v.insert(k.clone(), x.clone());
            }
        }
        let vocab = put(&mut objects, serde_json::to_vec(&vocab_json).unwrap());
        let mut manifest = serde_json::json!({
            "schema": 1, "catalog": catalog, "seq": seq, "minClientVersion": "0.1.0",
            "objects": "o/{aa}/{sha256}",
            "tiers": tiers,
            "deltas": [], "packs": {}, "vocab": vocab
        });
        if let Some(q) = queries {
            manifest["queries"] = put(&mut objects, serde_json::to_vec(&q).unwrap()).into();
        }
        let manifest = serde_json::to_vec(&manifest).unwrap();
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
        let v = Vocab::default();
        let mut a = Row {
            id: "b".into(),
            tier: "curated".into(),
            q: 9,
            ..Default::default()
        };
        let b = Row {
            id: "a".into(),
            tier: "verified".into(),
            q: 9,
            ..Default::default()
        };
        assert_eq!(compare_static(&a, &b, &v), std::cmp::Ordering::Less);
        a.status = "deprecated".into();
        let c = Row {
            id: "z".into(),
            tier: "curated".into(),
            q: 9,
            ..Default::default()
        };
        assert_eq!(compare_static(&a, &c, &v), std::cmp::Ordering::Greater);
        // Commonness beats the tier, and the id is only the last tiebreak.
        let common = Row {
            id: "zz".into(),
            tier: "community".into(),
            q: 80,
            ..Default::default()
        };
        assert_eq!(compare_static(&common, &c, &v), std::cmp::Ordering::Less);
        // A front door leads, then the other essentials.
        let door = Row {
            id: "zzz".into(),
            ess: 2,
            ..Default::default()
        };
        let shelf = Row {
            id: "y".into(),
            ess: 1,
            q: 100,
            ..Default::default()
        };
        assert_eq!(compare_static(&door, &shelf, &v), std::cmp::Ordering::Less);
        assert_eq!(
            compare_static(&shelf, &common, &v),
            std::cmp::Ordering::Less
        );
    }

    fn depth_vocab(levels: &[&str]) -> Vocab {
        serde_json::from_value(serde_json::json!({
            "depth": levels.iter().map(|l| serde_json::json!({"id": l, "label": l.to_uppercase()})).collect::<Vec<_>>()
        }))
        .unwrap()
    }

    #[test]
    fn depth_order_comes_from_the_vocab_only() {
        let row = |id: &str, dep: Option<&str>, q: i64| Row {
            id: id.into(),
            dep: dep.map(str::to_string),
            q,
            ..Default::default()
        };
        let mut rows = vec![
            row("adv", Some("advanced"), 100),
            row("none", None, 90),
            row("spec", Some("specific"), 100),
            row("basic", Some("basic"), 10),
        ];
        let v = depth_vocab(&["basic", "specific", "advanced"]);
        rows.sort_by(|a, b| compare_static(a, b, &v));
        let ids: Vec<&str> = rows.iter().map(|r| r.id.as_str()).collect();
        // A row without a level counts as the middle one.
        assert_eq!(ids, vec!["basic", "spec", "none", "adv"]);
        assert_eq!(v.depth_of(None).as_deref(), Some("specific"));
        assert_eq!(v.first_depth(), Some("basic"));

        // A fourth level added to the vocab takes its place, no code change.
        let v4 = depth_vocab(&["basic", "specific", "expert", "advanced"]);
        rows.push(row("exp", Some("expert"), 100));
        rows.sort_by(|a, b| compare_static(a, b, &v4));
        let ids: Vec<&str> = rows.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, vec!["basic", "spec", "exp", "none", "adv"]);
        // ...and the middle moves with it.
        assert_eq!(v4.depth_of(Some("unknown")).as_deref(), Some("expert"));

        // No levels at all (an older catalog): depth plays no part.
        let plain = Vocab::default();
        assert_eq!(plain.depth_rank(Some("advanced")), 0);
        assert!(plain.depth_of(Some("basic")).is_none());
        // The wrapped form reads the same.
        let wrapped: Vocab = serde_json::from_value(serde_json::json!({
            "depth": { "levels": [{"id": "basic", "label": "Start here"}, {"value": "advanced", "label": "Advanced"}] }
        }))
        .unwrap();
        assert_eq!(wrapped.depth_levels()[1].id, "advanced");
        // hodios vocab/depth.yml: `values` and a `default` for entries without one.
        let hodios: Vocab = serde_json::from_value(serde_json::json!({
            "depth": { "values": [
                {"id": "basic", "label": "Start here", "description": "x"},
                {"id": "specific", "label": "Specific"},
                {"id": "advanced", "label": "Advanced"},
                {"id": "expert", "label": "Expert"}
            ], "default": "specific" }
        }))
        .unwrap();
        assert_eq!(hodios.depth_levels().len(), 4);
        assert_eq!(hodios.depth_of(None).as_deref(), Some("specific"));
        assert_eq!(hodios.depth_rank(None), 1);
        let back: Vocab = serde_json::from_str(&serde_json::to_string(&hodios).unwrap()).unwrap();
        assert_eq!(back.depth_of(Some("nope")).as_deref(), Some("specific"));
    }

    #[test]
    fn new_row_fields_are_optional_and_lenient() {
        let old: Row = serde_json::from_str(r#"{"id":"x","q":0}"#).unwrap();
        assert!(old.syn.is_empty() && old.adv.is_empty() && old.dep.is_none() && old.ess == 0);
        let new: Row = serde_json::from_str(
            r#"{"id":"x","q":80,"ess":2,"int":"plan","top":"travel","syn":["trip","vacation"],"advice_risk":["medical"],"dep":"basic"}"#,
        )
        .unwrap();
        assert_eq!(new.intents, vec!["plan"]);
        assert_eq!(new.adv, vec!["medical"]);
        assert_eq!(new.syn.len(), 2);
        let nulls: Row = serde_json::from_str(r#"{"id":"x","adv":null,"syn":"one"}"#).unwrap();
        assert!(nulls.adv.is_empty());
        assert_eq!(nulls.syn, vec!["one"]);
    }

    #[test]
    fn intent_vocab_reads_nested_or_top_level() {
        let nested: Vocab = serde_json::from_value(serde_json::json!({
            "intent": {
                "intents": [{"id": "plan", "label": "Plan", "hint": "trips, meals, money"}],
                "topics": [{"id": "travel", "label": "Travel"}],
                "categories": {"trip-planning": {"intents": ["plan"], "topic": "travel"}}
            }
        }))
        .unwrap();
        assert_eq!(
            nested.intent_list()[0].hint.as_deref(),
            Some("trips, meals, money")
        );
        assert_eq!(nested.topic_label("travel"), "Travel");
        assert_eq!(
            nested
                .category_intent("trip-planning")
                .unwrap()
                .topic
                .as_deref(),
            Some("travel")
        );
        let flat: Vocab = serde_json::from_value(serde_json::json!({
            "intents": [{"id": "write", "label": "Write"}], "topics": [{"id": "food", "label": "Food"}]
        }))
        .unwrap();
        assert_eq!(flat.intent_list()[0].id, "write");
        assert_eq!(flat.topic_list()[0].id, "food");
        // It survives the round trip through library.db's meta.
        let back: Vocab = serde_json::from_str(&serde_json::to_string(&nested).unwrap()).unwrap();
        assert_eq!(back.intent_list().len(), 1);
    }
}
