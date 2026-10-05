//! The search budget at scale (design §12.5, plan §13): a synthetic
//! one-million-row `library.db`, sized like real rows (title 3–6 words,
//! description 6–25, 2–6 tags, 24 categories, the most common word in 30%
//! of rows), and 300 mixed queries — very common single words, two-word
//! ANDs, 3-letter typeahead prefixes, rare words, text plus two facets.
//! Fails when the 95th percentile is above 50 ms.
//!
//!   cargo test --release --lib library::bench -- --ignored --nocapture
//!   HERMES_LIBRARY_BENCH_ROWS=100000 cargo test --lib library::bench -- --ignored --nocapture

use super::search::{self, SearchRequest, Signals};
use super::store::{self, facet_token};
use rusqlite::{params, Connection};
use std::time::Instant;

const P95_BUDGET_MS: f64 = 50.0;

/// A small deterministic generator (no rand dependency).
struct Lcg(u64);
impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        self.0 >> 33
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
    /// Zipf-like: small indexes far more often.
    fn skewed(&mut self, n: u64) -> u64 {
        let u = (self.below(1_000_000) as f64 + 1.0) / 1_000_001.0;
        ((n as f64).powf(u) - 1.0) as u64 % n
    }
}

fn word(i: u64) -> String {
    const SYL: &[&str] = &[
        "ka", "lo", "mi", "ra", "te", "su", "no", "vi", "pe", "do", "ga", "zu", "be", "fo", "xi",
        "ha",
    ];
    let mut s = String::new();
    let mut n = i + 17;
    for _ in 0..3 {
        s.push_str(SYL[(n % 16) as usize]);
        n /= 16;
    }
    s.push_str(&format!("{}", i % 7));
    s
}

const KINDS: &[&str] = &[
    "prompt", "prompt", "prompt", "persona", "workflow", "rule", "style",
];

fn generate(conn: &mut Connection, rows: u64) {
    let started = Instant::now();
    let mut rng = Lcg(42);
    let vocab_size = 20_000u64;
    let tx = conn.transaction().unwrap();
    {
        let mut insert = tx
            .prepare(
                "INSERT INTO entry (rowid, id, version, kind, domain, category, tier, status, quality, usage,
                                    title, description, tags, f, row, body, updated, revoked)
                 VALUES (?1, ?2, '1.0.0', ?3, ?4, ?5, 2, 'experimental', 0, 0, ?6, ?7, ?8, ?9, ?10, 'sha256:00', NULL, 0)",
            )
            .unwrap();
        for i in 1..=rows {
            // "kalomi0" is the most common word: in about 30% of rows.
            let common = rng.below(10) < 3;
            let mut title: Vec<String> = (0..3 + rng.below(4))
                .map(|_| word(1 + rng.skewed(vocab_size)))
                .collect();
            if common {
                title[0] = word(0);
            }
            let desc: Vec<String> = (0..6 + rng.below(20))
                .map(|_| word(1 + rng.skewed(vocab_size)))
                .collect();
            let tags: Vec<String> = (0..2 + rng.below(5))
                .map(|_| word(1 + rng.skewed(2_000)))
                .collect();
            let kind = KINDS[rng.below(KINDS.len() as u64) as usize];
            let cat = format!("cat{}", rng.skewed(24));
            let dom = format!("dom{}", rng.skewed(23));
            let stack = if rng.below(10) == 0 {
                vec![format!("stack{}", rng.skewed(80))]
            } else {
                vec![]
            };
            let works = vec!["claude-code", "codex", "gemini-cli"];
            let id = format!("entry-{i:07}");
            let title_s = title.join(" ");
            let desc_s = desc.join(" ");
            let mut f = vec![
                facet_token('k', kind),
                facet_token('c', &cat),
                facet_token('d', &dom),
                facet_token('t', "community"),
            ];
            f.extend(works.iter().map(|w| facet_token('w', w)));
            f.extend(stack.iter().map(|s| facet_token('s', s)));
            let row = serde_json::json!({
                "id": id, "v": "1.0.0", "kind": kind, "cat": cat, "dom": dom, "tier": "community",
                "status": "experimental", "title": title_s, "desc": desc_s, "tags": tags, "stack": stack,
                "works": works, "q": 0, "u": 0, "aliases": [], "body": "sha256:00"
            });
            insert
                .execute(params![
                    i as i64,
                    id,
                    kind,
                    dom,
                    cat,
                    title_s,
                    desc_s,
                    tags.join(" "),
                    f.join(" "),
                    row.to_string()
                ])
                .unwrap();
        }
    }
    tx.execute("INSERT INTO entry_fts(entry_fts) VALUES('rebuild')", [])
        .unwrap();
    tx.execute(
        "INSERT INTO meta (key, value) VALUES ('catalog', 'bench'), ('seq', '1')",
        [],
    )
    .unwrap();
    tx.commit().unwrap();
    eprintln!(
        "[bench] generated {rows} rows with FTS in {:.1} s",
        started.elapsed().as_secs_f64()
    );
}

fn queries() -> Vec<SearchRequest> {
    let mut rng = Lcg(7);
    let mut out = Vec::new();
    for i in 0..300u64 {
        let q = match i % 5 {
            0 => word(0),
            1 => format!("{} {}", word(0), word(1 + rng.skewed(50))),
            2 => word(1 + rng.skewed(500))[..3].to_string(),
            3 => word(5_000 + rng.below(15_000)),
            _ => format!(
                "{} kind:prompt cat:cat{}",
                word(1 + rng.skewed(200)),
                rng.skewed(24)
            ),
        };
        out.push(SearchRequest {
            query: q,
            limit: Some(50),
            ..Default::default()
        });
    }
    out
}

#[test]
#[ignore = "builds a 1M-row index (about a minute in release); run explicitly"]
fn search_p95_under_50ms_at_one_million_rows() {
    let rows: u64 = std::env::var("HERMES_LIBRARY_BENCH_ROWS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(1_000_000);
    let dir = std::env::temp_dir().join(format!("hermes-library-bench-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("library.db");
    let _ = std::fs::remove_file(&path);
    let mut conn = store::open(&path).unwrap();
    generate(&mut conn, rows);
    drop(conn);
    // A fresh reader, as the app opens one.
    let conn = store::open(&path).unwrap();
    let signals = Signals {
        works: vec!["claude-code".into()],
        stack: vec!["stack1".into()],
        ..Default::default()
    };
    let mut times = Vec::new();
    let mut by_kind: [Vec<f64>; 5] = Default::default();
    let mut first_page_hits = 0usize;
    for (i, q) in queries().iter().enumerate() {
        let t = Instant::now();
        let page = search::search(&conn, q, Some(&signals)).unwrap();
        let ms = t.elapsed().as_secs_f64() * 1000.0;
        times.push(ms);
        by_kind[i % 5].push(ms);
        if i % 5 == 0 {
            first_page_hits += page.hits.len();
        }
    }
    for (name, mut list) in ["common", "two words", "prefix", "rare", "text + 2 facets"]
        .iter()
        .zip(by_kind)
    {
        list.sort_by(|a, b| a.partial_cmp(b).unwrap());
        eprintln!(
            "[bench]   {name}: p50 {:.1} ms, p95 {:.1} ms",
            list[list.len() / 2],
            list[(list.len() * 95 / 100).min(list.len() - 1)]
        );
    }
    // Deep keyset page: follow the cursor of a common word 5 pages in.
    let mut req = SearchRequest {
        query: word(0),
        limit: Some(50),
        ..Default::default()
    };
    let mut deep_ms = 0.0;
    for _ in 0..5 {
        let t = Instant::now();
        let page = search::search(&conn, &req, None).unwrap();
        deep_ms = t.elapsed().as_secs_f64() * 1000.0;
        req.cursor = page.next_cursor;
    }
    times.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let pct = |p: f64| {
        times[((times.len() as f64 * p).ceil() as usize)
            .saturating_sub(1)
            .min(times.len() - 1)]
    };
    let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    eprintln!(
        "[bench] {rows} rows ({:.0} MB): p50 {:.1} ms, p95 {:.1} ms, p99 {:.1} ms, max {:.1} ms; deep page {:.1} ms",
        size as f64 / 1e6,
        pct(0.50),
        pct(0.95),
        pct(0.99),
        times[times.len() - 1],
        deep_ms
    );
    assert!(first_page_hits > 0, "the common word found nothing");
    let _ = std::fs::remove_dir_all(&dir);
    assert!(
        pct(0.95) <= P95_BUDGET_MS,
        "search p95 {:.1} ms is over the {P95_BUDGET_MS} ms budget",
        pct(0.95)
    );
}
