//! Runtime updates of the library catalog.
//!
//! Every 12 hours (checked hourly by a background task, so an app left open
//! for days still updates), Hermes fetches `manifest.json` and its
//! `manifest.json.minisig` from jsDelivr, falling back to raw GitHub;
//! verifies the signature with the keys compiled into the build; refuses a
//! catalog older than the one it has (anti-rollback) or one the person
//! skipped; downloads only the objects it does not already have; checks
//! every one against its hash; and applies the whole catalog in one write
//! transaction. Nothing about the person is sent: the same files for
//! everyone, no app version, no interests. Library content only — files
//! installed into a project never change here.

use super::catalog::{
    self, object_rel, parse_ref, version_gt, Manifest, ShardList, VerifiedCatalog,
};
use super::store::{self, ApplySummary};
use super::verify::{self, VerifyError};
use rusqlite::Connection;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

/// Where catalogs come from: jsDelivr (CDN) first, raw GitHub when it fails
/// or still serves an older copy.
pub const MIRRORS: &[&str] = &[
    "https://cdn.jsdelivr.net/gh/hermes-hq/hodios-dist@latest/catalog/v1",
    "https://raw.githubusercontent.com/hermes-hq/hodios-dist/main/catalog/v1",
];
pub const INTERVAL_SECS: i64 = 12 * 3600;
/// After a failed check, wait this long before the next try.
pub const RETRY_SECS: i64 = 3600;
const PARALLEL: usize = 16;

pub fn mirrors() -> Vec<String> {
    #[cfg(feature = "e2e")]
    if let Ok(url) = std::env::var("HERMES_E2E_LIBRARY_URL") {
        if !url.trim().is_empty() {
            return url
                .split(',')
                .map(|u| u.trim().trim_end_matches('/').to_string())
                .collect();
        }
    }
    MIRRORS.iter().map(|s| s.to_string()).collect()
}

/// Whether the background task should check now.
pub fn due(now: i64, last_check: Option<i64>, last_success: Option<i64>) -> bool {
    let since_success = last_success.map(|t| now - t).unwrap_or(i64::MAX);
    let since_check = last_check.map(|t| now - t).unwrap_or(i64::MAX);
    since_success >= INTERVAL_SECS && since_check >= RETRY_SECS
}

pub type FetchFuture<'a> =
    Pin<Box<dyn Future<Output = Result<Option<Vec<u8>>, String>> + Send + 'a>>;

/// Fetches one file of `catalog/v1` (`Ok(None)` when no mirror has it).
pub trait Fetcher: Send + Sync {
    fn get<'a>(&'a self, rel: &'a str) -> FetchFuture<'a>;
}

/// HTTP over the mirrors, in order; a 404 or an error moves to the next.
pub struct HttpFetcher {
    client: reqwest::Client,
    mirrors: Vec<String>,
}

impl HttpFetcher {
    pub fn new(mirrors: Vec<String>) -> Result<Self, String> {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            // No app version, no identity: the same request from everyone.
            .user_agent("hodios-catalog-client/0.1")
            .build()
            .map_err(|e| e.to_string())?;
        Ok(HttpFetcher { client, mirrors })
    }
}

impl Fetcher for HttpFetcher {
    fn get<'a>(&'a self, rel: &'a str) -> FetchFuture<'a> {
        Box::pin(async move {
            let mut errors = Vec::new();
            for base in &self.mirrors {
                let url = format!("{base}/{rel}");
                match self.client.get(&url).send().await {
                    Ok(r) if r.status().is_success() => {
                        return r
                            .bytes()
                            .await
                            .map(|b| Some(b.to_vec()))
                            .map_err(|e| e.to_string())
                    }
                    Ok(r) => errors.push(format!("{url}: HTTP {}", r.status())),
                    Err(e) => errors.push(format!("{url}: {e}")),
                }
            }
            if errors.iter().all(|e| e.ends_with("404 Not Found")) {
                Ok(None)
            } else {
                Err(errors.join("; "))
            }
        })
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", tag = "outcome")]
pub enum Outcome {
    Off,
    UpToDate {
        catalog: String,
        seq: i64,
    },
    Available {
        catalog: String,
        seq: i64,
    },
    Applied {
        summary: Box<ApplySummary>,
        bytes: usize,
    },
    /// The download was refused: the reason (a signature, an older catalog, a hash).
    Refused {
        reason: String,
        code: String,
    },
    /// Could not reach a mirror (offline) or another failure.
    Failed {
        reason: String,
    },
}

impl Outcome {
    /// The mirror has no signed release yet. Nothing is applied, but nothing
    /// is wrong either: the check counts as done (next one in 12 hours), and
    /// it is neither logged as a warning nor shown as an error.
    pub fn awaiting_signed_release(&self) -> bool {
        matches!(self, Outcome::Refused { code, .. } if code == "unsigned")
    }
}

/// (catalog, seq) of `a` is newer than `b`.
pub fn newer(a: (&str, i64), b: (&str, i64)) -> bool {
    if a.0 == b.0 {
        a.1 > b.1
    } else {
        version_gt(a.0, b.0)
    }
}

/// A verified, newer manifest, or the reason it is not one.
pub struct Candidate {
    pub manifest: Manifest,
    pub bytes: Vec<u8>,
}

pub async fn fetch_manifest(fetcher: &dyn Fetcher, keys: &[String]) -> Result<Candidate, Outcome> {
    let bytes = match fetcher.get("manifest.json").await {
        Ok(Some(b)) => b,
        Ok(None) => {
            return Err(Outcome::Failed {
                reason: "no mirror serves the catalog".into(),
            })
        }
        Err(e) => return Err(Outcome::Failed { reason: e }),
    };
    let sig = match fetcher.get("manifest.json.minisig").await {
        // Not valid UTF-8: unreadable, not absent.
        Ok(Some(s)) => Some(String::from_utf8(s).unwrap_or_default()),
        // No mirror publishes one: the catalog has no signed release yet.
        Ok(None) => None,
        // Offline or a mirror error: not a verdict on the catalog.
        Err(e) => return Err(Outcome::Failed { reason: e }),
    };
    if let Err(e) = verify::verify_manifest(&bytes, sig.as_deref(), keys) {
        let code = match e {
            VerifyError::NoTrustedKey | VerifyError::NotPublished => "unsigned",
            VerifyError::UnknownKey(_) => "key",
            VerifyError::Malformed(_) | VerifyError::Invalid => "signature",
        };
        return Err(Outcome::Refused {
            reason: e.to_string(),
            code: code.into(),
        });
    }
    let manifest: Manifest = serde_json::from_slice(&bytes).map_err(|e| Outcome::Refused {
        reason: format!("manifest: {e}"),
        code: "format".into(),
    })?;
    catalog::check_manifest(&manifest).map_err(|e| Outcome::Refused {
        reason: e,
        code: "schema".into(),
    })?;
    Ok(Candidate { manifest, bytes })
}

/// Whether to take `candidate` over what is installed.
pub fn judge(
    candidate: &Manifest,
    current: Option<(&str, i64)>,
    ignored: &[String],
) -> Option<Outcome> {
    let c = (candidate.catalog.as_str(), candidate.seq);
    if let Some(cur) = current {
        if c == cur {
            return Some(Outcome::UpToDate {
                catalog: cur.0.into(),
                seq: cur.1,
            });
        }
        if !newer(c, cur) {
            return Some(Outcome::Refused {
                reason: format!("the mirror serves {} (seq {}), older than {} (seq {}) here; kept the newer one", c.0, c.1, cur.0, cur.1),
                code: "older".into(),
            });
        }
    }
    if ignored
        .iter()
        .any(|v| v == &format!("{}@{}", c.0, c.1) || v == c.0)
    {
        return Some(Outcome::UpToDate {
            catalog: current.map(|c| c.0).unwrap_or_default().into(),
            seq: current.map(|c| c.1).unwrap_or_default(),
        });
    }
    None
}

/// Downloads what `manifest` needs that `have` does not hold, then verifies
/// the whole chain. `local(hex)` returns an object kept from earlier.
pub async fn download(
    fetcher: Arc<dyn Fetcher>,
    candidate: &Candidate,
    local: &(dyn Fn(&str) -> Option<Vec<u8>> + Sync),
    known_bodies: &HashSet<String>,
) -> Result<(VerifiedCatalog, usize), Outcome> {
    let mut objects: HashMap<String, Vec<u8>> = HashMap::new();
    let mut downloaded = 0usize;
    let fail = |e: String| Outcome::Failed { reason: e };
    let hash_fail = |e: String| Outcome::Refused {
        reason: e,
        code: "hash".into(),
    };

    // Small objects one by one: vocab, packs, shard lists, shards.
    async fn one(
        fetcher: &dyn Fetcher,
        local: &(dyn Fn(&str) -> Option<Vec<u8>> + Sync),
        objects: &mut HashMap<String, Vec<u8>>,
        downloaded: &mut usize,
        reference: &str,
    ) -> Result<Vec<u8>, String> {
        let hex = parse_ref(reference)?;
        if let Some(b) = objects.get(&object_rel(&hex)) {
            return Ok(b.clone());
        }
        let bytes = match local(&hex) {
            Some(b) => b,
            None => {
                let b = fetcher
                    .get(&object_rel(&hex))
                    .await?
                    .ok_or_else(|| format!("object {hex} is missing on every mirror"))?;
                *downloaded += b.len();
                b
            }
        };
        if catalog::sha256_hex(&bytes) != hex {
            return Err(format!(
                "object {hex} does not match its hash; refusing the catalog"
            ));
        }
        objects.insert(object_rel(&hex), bytes.clone());
        Ok(bytes)
    }

    let m = &candidate.manifest;
    if let Some(v) = &m.vocab {
        one(fetcher.as_ref(), local, &mut objects, &mut downloaded, v)
            .await
            .map_err(hash_fail)?;
    }
    for pack in m.packs.values() {
        if let Some(r) = pack
            .as_str()
            .or_else(|| pack.get("object").and_then(|o| o.as_str()))
        {
            one(fetcher.as_ref(), local, &mut objects, &mut downloaded, r)
                .await
                .map_err(hash_fail)?;
        }
    }
    let mut bodies: Vec<String> = Vec::new();
    for tier in m.tiers.values() {
        let list = one(
            fetcher.as_ref(),
            local,
            &mut objects,
            &mut downloaded,
            &tier.list,
        )
        .await
        .map_err(hash_fail)?;
        let list: ShardList = serde_json::from_slice(&list).map_err(|e| fail(e.to_string()))?;
        for shard in list.shards.values() {
            let text = one(
                fetcher.as_ref(),
                local,
                &mut objects,
                &mut downloaded,
                &shard.object,
            )
            .await
            .map_err(hash_fail)?;
            for line in String::from_utf8_lossy(&text)
                .lines()
                .filter(|l| !l.trim().is_empty())
            {
                if let Ok(row) = serde_json::from_str::<catalog::Row>(line) {
                    if let Ok(hex) = parse_ref(&row.body) {
                        if !known_bodies.contains(&hex) {
                            bodies.push(hex);
                        }
                    }
                }
            }
        }
    }
    bodies.sort();
    bodies.dedup();
    // Bodies in parallel: every new or changed curated body, the same set
    // for everyone (keeps the library offline; reveals no interest).
    let sem = Arc::new(tokio::sync::Semaphore::new(PARALLEL));
    let mut set = tokio::task::JoinSet::new();
    for hex in bodies {
        let fetcher = Arc::clone(&fetcher);
        let sem = Arc::clone(&sem);
        set.spawn(async move {
            let _permit = sem.acquire_owned().await.map_err(|e| e.to_string())?;
            let bytes = fetcher
                .get(&object_rel(&hex))
                .await?
                .ok_or_else(|| format!("body {hex} is missing on every mirror"))?;
            Ok::<_, String>((hex, bytes))
        });
    }
    while let Some(joined) = set.join_next().await {
        let (hex, bytes) = joined.map_err(|e| fail(e.to_string()))?.map_err(fail)?;
        downloaded += bytes.len();
        objects.insert(object_rel(&hex), bytes);
    }
    let cat =
        catalog::collect(&candidate.bytes, &mut objects, true, known_bodies).map_err(hash_fail)?;
    Ok((cat, downloaded))
}

/// One update check against `fetcher`, applied to `conn` when `apply_now`.
#[allow(clippy::too_many_arguments)]
pub async fn check(
    fetcher: Arc<dyn Fetcher>,
    keys: &[String],
    current: Option<(String, i64)>,
    ignored: &[String],
    local: &(dyn Fn(&str) -> Option<Vec<u8>> + Sync),
    known_bodies: &HashSet<String>,
    apply_now: bool,
    apply: &mut (dyn FnMut(&VerifiedCatalog) -> Result<ApplySummary, String> + Send),
) -> Outcome {
    let candidate = match fetch_manifest(fetcher.as_ref(), keys).await {
        Ok(c) => c,
        Err(outcome) => return outcome,
    };
    if let Some(outcome) = judge(
        &candidate.manifest,
        current.as_ref().map(|(c, s)| (c.as_str(), *s)),
        ignored,
    ) {
        return outcome;
    }
    if !apply_now {
        return Outcome::Available {
            catalog: candidate.manifest.catalog.clone(),
            seq: candidate.manifest.seq,
        };
    }
    match download(fetcher, &candidate, local, known_bodies).await {
        Ok((cat, bytes)) => match apply(&cat) {
            Ok(summary) => Outcome::Applied {
                summary: Box::new(summary),
                bytes,
            },
            Err(e) => Outcome::Failed { reason: e },
        },
        Err(outcome) => outcome,
    }
}

/// Rollback: the previous manifest, rebuilt from objects kept locally.
pub fn rollback(conn: &mut Connection) -> Result<ApplySummary, String> {
    let (bytes, _) =
        store::previous_manifest(conn).ok_or("there is no earlier catalog to go back to")?;
    let mut local: HashMap<String, Vec<u8>> = HashMap::new();
    let manifest: Manifest = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    let mut refs: Vec<String> = manifest.vocab.iter().cloned().collect();
    refs.extend(manifest.tiers.values().map(|t| t.list.clone()));
    let mut queue = refs;
    while let Some(r) = queue.pop() {
        let hex = parse_ref(&r)?;
        let b = store::stored_object(conn, &hex)
            .ok_or("the earlier catalog's files are no longer here")?;
        if let Ok(list) = serde_json::from_slice::<ShardList>(&b) {
            queue.extend(list.shards.values().map(|s| s.object.clone()));
        }
        local.insert(object_rel(&hex), b);
    }
    let cat = catalog::collect(&bytes, &mut local, false, &HashSet::new())?;
    store::apply(conn, &cat, "rollback")
}

#[cfg(test)]
mod tests {
    use super::super::catalog::tests::{fixture, three, Fixture};
    use super::*;
    use std::sync::Mutex;

    struct Mem {
        files: HashMap<String, Vec<u8>>,
        hits: Mutex<Vec<String>>,
    }
    impl Fetcher for Mem {
        fn get<'a>(&'a self, rel: &'a str) -> FetchFuture<'a> {
            self.hits.lock().unwrap().push(rel.to_string());
            let r = self.files.get(rel).cloned();
            Box::pin(async move { Ok(r) })
        }
    }

    use crate::library::verify::tests::TestKey;

    fn served(f: &Fixture, manifest: &[u8], sig: Option<String>) -> Arc<Mem> {
        let mut files = f.objects.clone();
        files.insert("manifest.json".into(), manifest.to_vec());
        if let Some(s) = sig {
            files.insert("manifest.json.minisig".into(), s.into_bytes());
        }
        Arc::new(Mem {
            files,
            hits: Mutex::new(Vec::new()),
        })
    }

    #[test]
    fn checks_twice_a_day_and_retries_hourly() {
        assert!(due(100_000, None, None));
        assert!(!due(100_000, Some(99_000), Some(99_000)));
        assert!(due(100_000 + INTERVAL_SECS, Some(100_000), Some(100_000)));
        // A failed check an hour ago and no success for days: try again.
        assert!(due(200_000, Some(200_000 - RETRY_SECS), Some(0)));
        assert!(!due(200_000, Some(200_000 - 60), Some(0)));
    }

    #[test]
    fn newer_compares_calver_then_seq() {
        assert!(newer(("2026.1004.0", 1), ("2026.1003.0", 9)));
        assert!(newer(("2026.1003.0", 4), ("2026.1003.0", 3)));
        assert!(!newer(("2026.1003.0", 3), ("2026.1003.0", 3)));
        assert!(!newer(("2026.1002.9", 9), ("2026.1003.0", 1)));
    }

    fn refused_code(r: Result<Candidate, Outcome>) -> String {
        match r {
            Err(Outcome::Refused { code, .. }) => code,
            Err(o) => panic!("expected a refusal, got {o:?}"),
            Ok(_) => panic!("expected a refusal, got a verified manifest"),
        }
    }

    #[tokio::test]
    async fn accepts_a_manifest_signed_with_a_trusted_key() {
        let f = three();
        let key = TestKey::generate();
        let server = served(&f, &f.manifest, Some(key.sign(&f.manifest)));
        let c = fetch_manifest(server.as_ref(), std::slice::from_ref(&key.public))
            .await
            .expect("a good signature verifies");
        assert_eq!(c.manifest.catalog, "2026.0101.0");
        assert_eq!(c.bytes, f.manifest);
    }

    #[tokio::test]
    async fn refuses_unsigned_unknown_key_and_bad_signatures() {
        let f = three();
        let key = TestKey::generate();
        let keys = vec![key.public.clone()];
        // No signature published: waiting for a signed release, not an error.
        let unsigned = served(&f, &f.manifest, None);
        let r = fetch_manifest(unsigned.as_ref(), &keys).await;
        assert!(matches!(&r, Err(o) if o.awaiting_signed_release()));
        assert_eq!(refused_code(r), "unsigned");
        // Signed by a key this build does not know.
        let stranger = TestKey::generate();
        let other = served(&f, &f.manifest, Some(stranger.sign(&f.manifest)));
        match fetch_manifest(other.as_ref(), &keys).await {
            Err(o @ Outcome::Refused { .. }) => {
                assert!(!o.awaiting_signed_release());
                let Outcome::Refused { code, reason } = o else {
                    unreachable!()
                };
                assert_eq!(code, "key");
                assert!(reason.contains(&stranger.key_id()), "{reason}");
            }
            _ => panic!("a stranger's signature must be refused"),
        }
        // The trusted key, over other bytes (the manifest was altered).
        let mut altered = f.manifest.clone();
        altered.extend_from_slice(b" ");
        let bad = served(&f, &altered, Some(key.sign(&f.manifest)));
        assert_eq!(
            refused_code(fetch_manifest(bad.as_ref(), &keys).await),
            "signature"
        );
        // Garbage where the signature should be.
        let garbled = served(&f, &f.manifest, Some("not a signature".into()));
        assert_eq!(
            refused_code(fetch_manifest(garbled.as_ref(), &keys).await),
            "signature"
        );
        // No trusted key at all: refused, nothing fetched beyond the manifest.
        let signed = served(&f, &f.manifest, Some(key.sign(&f.manifest)));
        assert_eq!(
            refused_code(fetch_manifest(signed.as_ref(), &[]).await),
            "unsigned"
        );
        assert!(signed
            .hits
            .lock()
            .unwrap()
            .iter()
            .all(|h| h.starts_with("manifest.json")));
    }

    #[tokio::test]
    async fn a_mirror_error_on_the_signature_is_a_failure_not_a_verdict() {
        struct Flaky(Vec<u8>);
        impl Fetcher for Flaky {
            fn get<'a>(&'a self, rel: &'a str) -> FetchFuture<'a> {
                let r = if rel == "manifest.json" {
                    Ok(Some(self.0.clone()))
                } else {
                    Err("connection reset".to_string())
                };
                Box::pin(async move { r })
            }
        }
        let f = three();
        let key = TestKey::generate();
        match fetch_manifest(
            &Flaky(f.manifest.clone()),
            std::slice::from_ref(&key.public),
        )
        .await
        {
            Err(Outcome::Failed { reason }) => assert!(reason.contains("connection reset")),
            _ => panic!("an unreachable signature is a failed check"),
        }
    }

    #[tokio::test]
    async fn a_signed_newer_catalog_is_applied_and_a_tampered_one_is_not() {
        let old = three();
        let new = fixture(
            "2026.0102.0",
            2,
            &[("brand-new", serde_json::json!({}), "New.")],
        );
        let key = TestKey::generate();
        let keys = vec![key.public.clone()];
        let bundled = || {
            let mut conn = store::open_in_memory().unwrap();
            let mut src = old.objects.clone();
            let cat = catalog::collect(&old.manifest, &mut src, true, &HashSet::new()).unwrap();
            store::apply(&mut conn, &cat, "bundled").unwrap();
            conn
        };
        async fn run(server: Arc<Mem>, keys: &[String], conn: Connection) -> (Outcome, Connection) {
            let current = store::info(&conn).map(|i| (i.catalog, i.seq));
            let known = store::known_bodies(&conn);
            let shared = Arc::new(Mutex::new(conn));
            let s2 = Arc::clone(&shared);
            let local = move |hex: &str| store::stored_object(&s2.lock().unwrap(), hex);
            let s3 = Arc::clone(&shared);
            let mut apply =
                move |cat: &VerifiedCatalog| store::apply(&mut s3.lock().unwrap(), cat, "update");
            let o = check(server, keys, current, &[], &local, &known, true, &mut apply).await;
            drop(local);
            drop(apply);
            let conn = Arc::try_unwrap(shared).ok().unwrap().into_inner().unwrap();
            (o, conn)
        }
        // Tampered: the signature is good, a body is not.
        let mut files = new.objects.clone();
        for bytes in files.values_mut() {
            if String::from_utf8_lossy(bytes).contains("New.") {
                bytes.extend_from_slice(b" evil");
            }
        }
        files.insert("manifest.json".into(), new.manifest.clone());
        files.insert(
            "manifest.json.minisig".into(),
            key.sign(&new.manifest).into_bytes(),
        );
        let tampered = Arc::new(Mem {
            files,
            hits: Mutex::new(Vec::new()),
        });
        let (o, conn) = run(tampered, &keys, bundled()).await;
        assert!(
            matches!(&o, Outcome::Refused { code, .. } if code == "hash"),
            "{o:?}"
        );
        assert_eq!(store::info(&conn).unwrap().catalog, "2026.0101.0");
        // Intact: applied in one go.
        let good = served(&new, &new.manifest, Some(key.sign(&new.manifest)));
        let (o, conn) = run(good, &keys, conn).await;
        match o {
            Outcome::Applied { summary, .. } => {
                assert_eq!(summary.added, vec!["brand-new".to_string()])
            }
            o => panic!("expected the signed catalog to apply, got {o:?}"),
        }
        assert_eq!(store::info(&conn).unwrap().catalog, "2026.0102.0");
    }

    #[test]
    fn judges_older_equal_and_skipped_catalogs() {
        let m = |c: &str, s: i64| Manifest {
            schema: 1,
            catalog: c.into(),
            seq: s,
            min_client_version: None,
            objects: None,
            tiers: Default::default(),
            deltas: vec![],
            packs: Default::default(),
            vocab: None,
            revoked: vec![],
        };
        assert!(matches!(
            judge(&m("2026.1003.0", 3), Some(("2026.1003.0", 3)), &[]),
            Some(Outcome::UpToDate { .. })
        ));
        assert!(matches!(
            judge(&m("2026.1002.0", 9), Some(("2026.1003.0", 3)), &[]),
            Some(Outcome::Refused { .. })
        ));
        assert!(judge(&m("2026.1004.0", 1), Some(("2026.1003.0", 3)), &[]).is_none());
        assert!(matches!(
            judge(
                &m("2026.1004.0", 1),
                Some(("2026.1003.0", 3)),
                &["2026.1004.0@1".into()]
            ),
            Some(Outcome::UpToDate { .. })
        ));
    }

    #[tokio::test]
    async fn downloads_only_what_it_lacks_and_verifies_everything() {
        let old = three();
        let new = fixture(
            "2026.0102.0",
            2,
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
                ("brand-new", serde_json::json!({}), "New."),
            ],
        );
        let mut conn = store::open_in_memory().unwrap();
        let mut src = old.objects.clone();
        let cat = catalog::collect(&old.manifest, &mut src, true, &HashSet::new()).unwrap();
        store::apply(&mut conn, &cat, "bundled").unwrap();
        let server = served(&new, &new.manifest, None);
        let candidate = Candidate {
            manifest: serde_json::from_slice(&new.manifest).unwrap(),
            bytes: new.manifest.clone(),
        };
        let known = store::known_bodies(&conn);
        let shared = Mutex::new(conn);
        let local = |hex: &str| store::stored_object(&shared.lock().unwrap(), hex);
        let fetcher: Arc<dyn Fetcher> = server.clone();
        let (cat, _) = download(fetcher, &candidate, &local, &known)
            .await
            .ok()
            .unwrap();
        // Two bodies did not change: only the new one was downloaded.
        let body_hits = server
            .hits
            .lock()
            .unwrap()
            .iter()
            .filter(|h| h.starts_with("o/"))
            .count();
        assert_eq!(cat.bodies.len(), 1);
        assert!(
            body_hits <= 1 + 3,
            "list + shard + vocab + one body, got {body_hits}"
        );
        let mut conn = shared.into_inner().unwrap();
        let s = store::apply(&mut conn, &cat, "update").unwrap();
        assert_eq!(s.added, vec!["brand-new".to_string()]);
        // Rollback restores the bundled catalog from objects kept locally.
        let back = rollback(&mut conn).unwrap();
        assert_eq!(back.catalog, "2026.0101.0");
        assert!(store::row_by_id(&conn, "summarize-notes").is_some());
    }

    #[tokio::test]
    async fn a_tampered_object_on_the_mirror_is_refused() {
        let new = three();
        let mut files = new.objects.clone();
        for (rel, bytes) in files.iter_mut() {
            if String::from_utf8_lossy(bytes).contains("Summarize.") {
                bytes.extend_from_slice(b" evil");
                let _ = rel;
            }
        }
        let server = Arc::new(Mem {
            files,
            hits: Mutex::new(Vec::new()),
        });
        let candidate = Candidate {
            manifest: serde_json::from_slice(&new.manifest).unwrap(),
            bytes: new.manifest.clone(),
        };
        let none = |_: &str| None;
        let fetcher: Arc<dyn Fetcher> = server;
        match download(fetcher, &candidate, &none, &HashSet::new()).await {
            Err(Outcome::Refused { code, .. }) => assert_eq!(code, "hash"),
            _ => panic!("a tampered body must be refused"),
        }
    }
}
