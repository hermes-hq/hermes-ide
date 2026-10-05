//! Search over `library.db`: the hodios-core query language and ranking
//! (`parseQuery`, `search`, `WEIGHTS` in `@hermes-hq/hodios-core/catalog`)
//! on top of FTS5.
//!
//! Plan (design §12.5): up to 300 FTS matches in rowid order — the static
//! rank — with facets as hidden FTS tokens inside the same MATCH, then a
//! rerank of only those candidates by text relevance plus personal boosts.
//! The cost is bounded by the candidate cap, not the catalog size. Paging is
//! keyset (`rowid > cursor`), never OFFSET.
//!
//! Personal signals arrive with the request and are used only here, on the
//! device; nothing about them is stored in this file or sent anywhere.

use super::catalog::{Row, Vocab};
use super::store::{self, facet_prefix, facet_token};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};

/// Candidates reranked per window (design §12.5).
pub const CANDIDATES: usize = 300;
/// Counts stop here; the UI shows "1,000+".
pub const COUNT_CAP: i64 = 1000;
pub const MAX_PAGE: usize = 50;

/// hodios-core `WEIGHTS`.
pub mod weights {
    pub const STACK: f64 = 3.0;
    pub const WORKS: f64 = 3.0;
    pub const WORKS_MISS: f64 = -3.0;
    pub const ROLE: f64 = 3.0;
    pub const SUBJECT: f64 = 2.0;
    pub const DOMAIN: f64 = 2.0;
    pub const CATEGORY: f64 = 2.0;
    /// Hermes additions (plan §6): the focused session's agent, the Track
    /// phase, decayed usage (capped), level.
    pub const ACTIVE_AGENT: f64 = 2.0;
    pub const STAGE: f64 = 2.0;
    pub const AFFINITY_CAP: f64 = 2.0;
    pub const LEVEL: f64 = 1.0;
}

/// Query key -> (row field, vocab facet).
fn key_spec(key: &str) -> Option<(&'static str, Option<&'static str>)> {
    Some(match key {
        "kind" => ("kind", None),
        "cat" | "category" => ("cat", Some("category")),
        "domain" => ("dom", Some("domain")),
        "sub" => ("sub", Some("subcategory")),
        "stage" => ("stage", Some("stage")),
        "role" => ("role", Some("role")),
        "stack" => ("stack", Some("stack")),
        "subject" => ("subject", Some("subject")),
        "works" => ("works", None),
        "in" => ("in", Some("inputs")),
        "out" => ("out", Some("output")),
        "risk" => ("risk", None),
        "tag" => ("tags", Some("tags")),
        "tier" => ("tier", None),
        "status" => ("status", None),
        "level" => ("level", None),
        "lang" => ("lang", None),
        _ => return None,
    })
}

fn works_alias(value: &str) -> String {
    match value {
        "claude" => "claude-code".into(),
        "gemini" => "gemini-cli".into(),
        "github-copilot" => "copilot".into(),
        other => other.into(),
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ParsedQuery {
    pub terms: Vec<String>,
    pub filters: BTreeMap<String, Vec<String>>,
}

/// hodios-core `parseQuery`: `flaky kind:prompt cat:testing stack:react,vue`.
/// Unknown `key:` tokens are text.
pub fn parse_query(q: &str) -> ParsedQuery {
    let mut out = ParsedQuery::default();
    for token in q.split_whitespace() {
        if let Some((key, values)) = token.split_once(':') {
            let key_ok = !key.is_empty() && key.bytes().all(|b| b.is_ascii_lowercase());
            if key_ok && !values.is_empty() && key_spec(key).is_some() {
                let key = if key == "category" { "cat" } else { key };
                out.filters.entry(key.to_string()).or_default().extend(
                    values
                        .split(',')
                        .filter(|v| !v.is_empty())
                        .map(str::to_lowercase),
                );
                continue;
            }
        }
        out.terms.push(token.to_lowercase());
    }
    out
}

fn words(s: &str) -> Vec<String> {
    s.to_lowercase()
        .split(|c: char| !(c.is_ascii_lowercase() || c.is_ascii_digit()))
        .filter(|w| !w.is_empty())
        .map(str::to_string)
        .collect()
}

/// hodios-core `textScore`: every term must hit one field (id/title 5,
/// aliases/tags 3, description 2); a term's words match word prefixes.
pub fn text_score(row: &Row, terms: &[String]) -> Option<f64> {
    if terms.is_empty() {
        return Some(0.0);
    }
    let mut id_title = words(&row.id);
    id_title.extend(words(&row.title));
    let mut tags: Vec<String> = row.aliases.iter().flat_map(|a| words(a)).collect();
    tags.extend(row.tags.iter().flat_map(|t| words(t)));
    let desc = words(&row.desc);
    let fields: [(&Vec<String>, f64); 3] = [(&id_title, 5.0), (&tags, 3.0), (&desc, 2.0)];
    let mut total = 0.0;
    for term in terms {
        let parts = words(term);
        if parts.is_empty() {
            continue;
        }
        let mut best = 0.0f64;
        for (list, weight) in fields {
            if parts
                .iter()
                .all(|p| list.iter().any(|w| w.starts_with(p.as_str())))
            {
                best = best.max(weight);
            }
        }
        if best == 0.0 {
            return None;
        }
        total += best;
    }
    Some(total)
}

/// Personal signals for ranking, computed on the device.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Signals {
    /// Detected stack of the project (canonical values).
    pub stack: Vec<String>,
    /// Target ids of the agents installed on this machine.
    pub works: Vec<String>,
    /// Target id of the focused session's agent.
    pub active_work: Option<String>,
    pub roles: Vec<String>,
    pub domains: Vec<String>,
    pub categories: Vec<String>,
    pub subjects: Vec<String>,
    pub stage: Option<String>,
    pub level: Option<String>,
    /// (facet, value) -> decayed use score.
    pub affinity: Vec<(String, String, f64)>,
    /// id -> recent uses.
    pub used: HashMap<String, i64>,
    pub pinned: HashSet<String>,
    pub hidden: HashSet<String>,
}

/// Why a row is where it is. `code` is translated by the UI.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Reason {
    pub code: &'static str,
    pub value: String,
    pub label: String,
}

fn reason(code: &'static str, value: &str, label: &str) -> Reason {
    Reason {
        code,
        value: value.to_string(),
        label: label.to_string(),
    }
}

/// (wanted values, the row's values, vocab facet, reason code, weight).
type SimpleFacet<'a> = (&'a Vec<String>, &'a Vec<String>, &'a str, &'static str, f64);

/// Personal boosts of a row and the reasons that can be shown for them.
pub fn boost(row: &Row, s: &Signals, vocab: &Vocab) -> (f64, Vec<Reason>) {
    let mut score = 0.0;
    let mut reasons = Vec::new();
    if s.pinned.contains(&row.id) {
        reasons.push(reason("pinned", &row.id, ""));
    }
    if let Some(n) = s.used.get(&row.id).filter(|n| **n >= 2) {
        reasons.push(reason("used", &row.id, &n.to_string()));
    }
    if !s.stack.is_empty() && !row.stack.is_empty() {
        let expanded: HashSet<String> = s
            .stack
            .iter()
            .flat_map(|v| vocab.implies_of("stack", v))
            .collect();
        if let Some(hit) = row.stack.iter().find(|v| expanded.contains(*v)) {
            score += weights::STACK;
            reasons.push(reason("stack", hit, vocab.label("stack", hit)));
        }
    }
    if !s.works.is_empty() {
        // Not a reason: nearly everything runs in a coding agent.
        score += if row.works.iter().any(|w| s.works.contains(w)) {
            weights::WORKS
        } else {
            weights::WORKS_MISS
        };
    }
    if let Some(active) = &s.active_work {
        if row.works.iter().any(|w| w == active) {
            score += weights::ACTIVE_AGENT;
        }
    }
    let simple: [SimpleFacet; 4] = [
        (&s.roles, &row.role, "role", "role", weights::ROLE),
        (
            &s.subjects,
            &row.subject,
            "subject",
            "subject",
            weights::SUBJECT,
        ),
        (
            &s.domains,
            &vec![row.dom.clone()],
            "domain",
            "domain",
            weights::DOMAIN,
        ),
        (
            &s.categories,
            &vec![row.cat.clone()],
            "category",
            "category",
            weights::CATEGORY,
        ),
    ];
    for (wanted, values, facet, code, weight) in simple {
        if wanted.is_empty() {
            continue;
        }
        if let Some(hit) = values.iter().find(|v| wanted.contains(v)) {
            score += weight;
            reasons.push(reason(code, hit, vocab.label(facet, hit)));
        }
    }
    if let Some(stage) = &s.stage {
        if row.stage.iter().any(|g| g == stage) {
            score += weights::STAGE;
            reasons.push(reason("stage", stage, vocab.label("stage", stage)));
        }
    }
    if let (Some(level), Some(row_level)) = (&s.level, &row.level) {
        if level == row_level {
            score += weights::LEVEL;
        }
    }
    if !s.affinity.is_empty() {
        let mut total = 0.0;
        let mut best: Option<(f64, &str, &str)> = None;
        for (facet, value, used) in &s.affinity {
            let hit = match facet.as_str() {
                "category" => &row.cat == value,
                "domain" => &row.dom == value,
                "kind" => &row.kind == value,
                "stack" => row.stack.contains(value),
                "subject" => row.subject.contains(value),
                _ => false,
            };
            if hit {
                total += (used / 2.0).min(1.0);
                if *used >= 2.0 && best.is_none_or(|b| *used > b.0) {
                    best = Some((*used, facet.as_str(), value.as_str()));
                }
            }
        }
        score += total.min(weights::AFFINITY_CAP);
        if let Some((_, facet, value)) = best {
            if facet == "category" || facet == "domain" {
                reasons.push(reason("affinity", value, vocab.label(facet, value)));
            }
        }
    }
    (score, reasons)
}

// ─── The search itself ────────────────────────────────────────────────

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SearchRequest {
    pub query: String,
    /// Extra filters from the facet chips (same keys as the query language).
    pub filters: BTreeMap<String, Vec<String>>,
    pub cursor: Option<String>,
    pub limit: Option<usize>,
    /// "you" (default), "best" or "new".
    pub sort: Option<String>,
    /// Off: plain quality and text order ("Show everything").
    pub personalise: Option<bool>,
    pub include_hidden: bool,
    pub counts: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    pub id: String,
    pub version: String,
    pub kind: String,
    pub title: String,
    pub description: String,
    pub domain: String,
    pub domain_label: String,
    pub category: String,
    pub category_label: String,
    pub status: String,
    pub tier: String,
    pub works: Vec<String>,
    pub stack: Vec<String>,
    pub stage: Vec<String>,
    pub score: f64,
    pub reasons: Vec<Reason>,
    pub is_new: bool,
    pub rank: i64,
}

impl Hit {
    /// Category and domain names in the vocab's words.
    pub fn labelled(mut self, vocab: &Vocab) -> Self {
        self.domain_label = vocab.label("domain", &self.domain).to_string();
        self.category_label = vocab.label("category", &self.category).to_string();
        self
    }

    pub fn from_row(rank: i64, row: &Row, score: f64, reasons: Vec<Reason>, is_new: bool) -> Self {
        Hit {
            id: row.id.clone(),
            version: row.v.clone(),
            kind: row.kind.clone(),
            title: row.title.clone(),
            description: row.desc.clone(),
            domain: row.dom.clone(),
            domain_label: row.dom.clone(),
            category: row.cat.clone(),
            category_label: row.cat.clone(),
            status: row.status.clone(),
            tier: row.tier.clone(),
            works: row.works.clone(),
            stack: row.stack.clone(),
            stage: row.stage.clone(),
            score,
            reasons,
            is_new,
            rank,
        }
    }
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SearchPage {
    pub hits: Vec<Hit>,
    /// Matches, counted up to COUNT_CAP.
    pub total: i64,
    pub total_capped: bool,
    pub next_cursor: Option<String>,
    pub kind_counts: BTreeMap<String, i64>,
    pub took_ms: f64,
}

/// The values each filter accepts (synonyms resolved, `stack`/`subject`
/// expanded by `implies`), by row field.
pub fn accepted_filters(
    q: &ParsedQuery,
    vocab: &Vocab,
) -> Vec<(String, &'static str, Vec<String>)> {
    let mut out = Vec::new();
    for (key, values) in &q.filters {
        let Some((field, facet)) = key_spec(key) else {
            continue;
        };
        let mut accepted: Vec<String> = Vec::new();
        for raw in values {
            let value = match facet {
                Some(f) => vocab.canonical(f, raw),
                None if key == "works" => works_alias(raw),
                None => raw.clone(),
            };
            if matches!(facet, Some("stack") | Some("subject")) {
                let mut all: Vec<String> = vocab
                    .implied_from(facet.unwrap_or_default(), &value)
                    .into_iter()
                    .collect();
                all.sort();
                accepted.extend(all);
            } else {
                accepted.push(value);
            }
        }
        accepted.sort();
        accepted.dedup();
        out.push((key.clone(), field, accepted));
    }
    out
}

fn row_values<'a>(row: &'a Row, field: &str) -> Vec<&'a str> {
    let one = |v: &'a str| vec![v];
    let opt = |v: &'a Option<String>| v.as_deref().into_iter().collect::<Vec<_>>();
    let many = |v: &'a [String]| v.iter().map(String::as_str).collect::<Vec<_>>();
    match field {
        "kind" => one(&row.kind),
        "cat" => one(&row.cat),
        "dom" => one(&row.dom),
        "sub" => opt(&row.sub),
        "stage" => many(&row.stage),
        "role" => many(&row.role),
        "stack" => many(&row.stack),
        "subject" => many(&row.subject),
        "works" => many(&row.works),
        "in" => many(&row.inputs),
        "out" => many(&row.out),
        "risk" => opt(&row.risk),
        "tags" => row
            .tags
            .iter()
            .chain(row.aliases.iter())
            .map(String::as_str)
            .collect(),
        "tier" => one(&row.tier),
        "status" => one(&row.status),
        "level" => opt(&row.level),
        "lang" => opt(&row.lang),
        _ => Vec::new(),
    }
}

/// Whether a row carries one accepted value of every filter (the FTS facet
/// tokens find candidates; this makes the match exact).
pub fn filters_match(row: &Row, filters: &[(String, &'static str, Vec<String>)]) -> bool {
    filters.iter().all(|(_, field, accepted)| {
        row_values(row, field)
            .iter()
            .any(|v| accepted.iter().any(|a| a == v))
    })
}

/// The FTS MATCH expression for terms and filters, or None for a plain browse.
///
/// Text words match as whole tokens except the last one typed, which matches
/// as a prefix (typeahead): a whole-token posting list is read lazily and a
/// query stops after 300 hits, while a long prefix must first be expanded
/// into every token it starts. `prefix_all` matches every word as a prefix
/// (hodios-core's semantics), the fallback when the fast form finds nothing.
/// No column filters: facet tokens carry a letter prefix no word has, and
/// `text_score` / `filters_match` check every candidate exactly.
pub fn match_expr_with(q: &ParsedQuery, vocab: &Vocab, prefix_all: bool) -> Option<String> {
    let mut clauses = Vec::new();
    let parts: Vec<String> = q.terms.iter().flat_map(|t| words(t)).collect();
    for (i, part) in parts.iter().enumerate() {
        let last = i + 1 == parts.len();
        if prefix_all || last {
            clauses.push(format!("\"{part}\"*"));
        } else {
            clauses.push(format!("\"{part}\""));
        }
    }
    for (key, _, accepted) in accepted_filters(q, vocab) {
        let Some(prefix) = facet_prefix(&key) else {
            continue;
        };
        let tokens: Vec<String> = accepted
            .iter()
            .map(|v| facet_token(prefix, v))
            .filter(|t| t.len() > 1)
            .map(|t| format!("\"{t}\""))
            .collect();
        if tokens.is_empty() {
            continue;
        }
        clauses.push(format!("({})", tokens.join(" OR ")));
    }
    if clauses.is_empty() {
        None
    } else {
        Some(clauses.join(" AND "))
    }
}

#[cfg(test)]
pub fn match_expr(q: &ParsedQuery, vocab: &Vocab) -> Option<String> {
    match_expr_with(q, vocab, false)
}

/// Up to `limit` rowids after `after`, in static order.
fn candidates(
    conn: &Connection,
    expr: Option<&str>,
    after: i64,
    limit: usize,
) -> Result<Vec<i64>, String> {
    let limit = limit as i64;
    match expr {
        Some(expr) => {
            let mut stmt = conn
                .prepare_cached(
                    "SELECT rowid FROM entry_fts WHERE entry_fts MATCH ?1 AND rowid > ?2 ORDER BY rowid LIMIT ?3",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(rusqlite::params![expr, after, limit], |r| {
                    r.get::<_, i64>(0)
                })
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
        }
        None => {
            let mut stmt = conn
                .prepare_cached("SELECT rowid FROM entry WHERE revoked = 0 AND rowid > ?1 ORDER BY rowid LIMIT ?2")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(rusqlite::params![after, limit], |r| r.get::<_, i64>(0))
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
        }
    }
}

fn count(conn: &Connection, expr: Option<&str>) -> i64 {
    let cap = COUNT_CAP + 1;
    let n: Result<i64, _> = match expr {
        Some(expr) => conn.query_row(
            "SELECT count(*) FROM (SELECT 1 FROM entry_fts WHERE entry_fts MATCH ?1 LIMIT ?2)",
            rusqlite::params![expr, cap],
            |r| r.get(0),
        ),
        None => conn.query_row(
            "SELECT count(*) FROM (SELECT 1 FROM entry WHERE revoked = 0 LIMIT ?1)",
            [cap],
            |r| r.get(0),
        ),
    };
    n.unwrap_or(0)
}

fn load_rows(conn: &Connection, rowids: &[i64]) -> Result<Vec<(i64, Row)>, String> {
    let mut stmt = conn
        .prepare_cached("SELECT row FROM entry WHERE rowid = ?1 AND revoked = 0")
        .map_err(|e| e.to_string())?;
    let mut out = Vec::with_capacity(rowids.len());
    for id in rowids {
        let raw: Option<String> = stmt.query_row([id], |r| r.get(0)).ok();
        if let Some(row) = raw.and_then(|r| serde_json::from_str::<Row>(&r).ok()) {
            out.push((*id, row));
        }
    }
    Ok(out)
}

fn parse_cursor(c: Option<&str>) -> (i64, usize) {
    // "<after rowid>:<offset in that window>"
    c.and_then(|c| c.split_once(':'))
        .and_then(|(a, o)| Some((a.parse().ok()?, o.parse().ok()?)))
        .unwrap_or((0, 0))
}

/// Reranks a window of candidates.
#[allow(clippy::too_many_arguments)]
pub fn rank(
    rows: Vec<(i64, Row)>,
    terms: &[String],
    filters: &[(String, &'static str, Vec<String>)],
    signals: Option<&Signals>,
    vocab: &Vocab,
    sort: &str,
    new_ids: &HashSet<String>,
    include_hidden: bool,
) -> Vec<Hit> {
    let mut hits: Vec<Hit> = rows
        .into_iter()
        .filter(|(_, row)| include_hidden || signals.is_none_or(|s| !s.hidden.contains(&row.id)))
        .filter(|(_, row)| filters_match(row, filters))
        .filter_map(|(rank, row)| {
            let text = text_score(&row, terms)?;
            let (b, reasons) = match signals {
                Some(s) if sort != "best" => boost(&row, s, vocab),
                _ => (0.0, Vec::new()),
            };
            let is_new = new_ids.contains(&row.id);
            Some(Hit::from_row(rank, &row, text + b, reasons, is_new).labelled(vocab))
        })
        .collect();
    match sort {
        "new" => hits.sort_by(|a, b| b.is_new.cmp(&a.is_new).then(a.rank.cmp(&b.rank))),
        _ => hits.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(a.rank.cmp(&b.rank))
        }),
    }
    hits
}

struct Pass {
    hits: Vec<Hit>,
    next_cursor: Option<String>,
    /// The first window of a first page: its candidates, and how many passed
    /// the exact checks. When it is not full it holds every match, so no
    /// second scan is needed to count them.
    first_window: Option<(usize, usize)>,
    /// With `count_first`: the matches of the first page's scan, up to
    /// `COUNT_CAP + 1` (the same scan that found the first window).
    matched: Option<i64>,
}

#[allow(clippy::too_many_arguments)]
fn pass(
    conn: &Connection,
    expr: Option<&str>,
    q: &ParsedQuery,
    filters: &[(String, &'static str, Vec<String>)],
    personal: Option<&Signals>,
    vocab: &Vocab,
    req: &SearchRequest,
    new_ids: &HashSet<String>,
    (mut after, mut offset): (i64, usize),
    mode: &str,
    count_first: bool,
) -> Result<Pass, String> {
    let limit = req.limit.unwrap_or(MAX_PAGE).clamp(1, MAX_PAGE);
    let sort = req.sort.as_deref().unwrap_or("you");
    let mut out = Pass {
        hits: Vec::new(),
        next_cursor: None,
        first_window: None,
        matched: None,
    };
    // A window whose candidates all fail the exact checks moves on to the next.
    for _ in 0..8 {
        // A first page that shows a count reads on to COUNT_CAP + 1 matches
        // in the one scan, instead of scanning the same lists again to count.
        let window = if count_first && after == 0 && out.matched.is_none() {
            let mut all = candidates(conn, expr, 0, COUNT_CAP as usize + 1)?;
            out.matched = Some(all.len() as i64);
            all.truncate(CANDIDATES);
            all
        } else {
            candidates(conn, expr, after, CANDIDATES)?
        };
        let full = window.len() == CANDIDATES;
        let last = window.last().copied();
        let ranked = rank(
            load_rows(conn, &window)?,
            &q.terms,
            filters,
            personal,
            vocab,
            sort,
            new_ids,
            req.include_hidden,
        );
        if out.first_window.is_none() && after == 0 {
            out.first_window = Some((window.len(), ranked.len()));
        }
        let end = (offset + limit).min(ranked.len());
        if offset < end {
            out.hits.extend(ranked[offset..end].iter().cloned());
        }
        if end < ranked.len() {
            out.next_cursor = Some(format!("{after}:{end}{mode}"));
            break;
        }
        match (full, last) {
            (true, Some(last)) if out.hits.is_empty() => {
                after = last;
                offset = 0;
                continue;
            }
            (true, Some(last)) => out.next_cursor = Some(format!("{last}:0{mode}")),
            _ => {}
        }
        break;
    }
    Ok(out)
}

pub fn search(
    conn: &Connection,
    req: &SearchRequest,
    signals: Option<&Signals>,
) -> Result<SearchPage, String> {
    let started = std::time::Instant::now();
    let vocab = store::vocab(conn);
    let mut q = parse_query(&req.query);
    for (k, values) in &req.filters {
        let key = if k == "category" { "cat" } else { k.as_str() };
        if key_spec(key).is_some() {
            q.filters
                .entry(key.to_string())
                .or_default()
                .extend(values.iter().map(|v| v.to_lowercase()));
        }
    }
    let filters = accepted_filters(&q, &vocab);
    let personal = if req.personalise == Some(false) {
        None
    } else {
        signals
    };
    let new_ids: HashSet<String> = store::new_ids(conn).into_iter().collect();
    let want_count = req.counts || req.cursor.is_none();
    // ":p" on a cursor: the page came from the every-word-a-prefix form.
    let cursor = req.cursor.as_deref();
    let prefix_cursor = cursor.is_some_and(|c| c.ends_with(":p"));
    let position = parse_cursor(cursor.map(|c| c.trim_end_matches(":p")));
    let mut prefix_all = prefix_cursor;
    let mut expr = match_expr_with(&q, &vocab, prefix_all);
    let mut run = pass(
        conn,
        expr.as_deref(),
        &q,
        &filters,
        personal,
        &vocab,
        req,
        &new_ids,
        position,
        if prefix_all { ":p" } else { "" },
        want_count && position.0 == 0,
    )?;
    // Nothing with whole words: try every word as a prefix ("flak test").
    if run.hits.is_empty() && cursor.is_none() && !prefix_all && !q.terms.is_empty() {
        let wide = match_expr_with(&q, &vocab, true);
        if wide != expr {
            prefix_all = true;
            expr = wide;
            run = pass(
                conn,
                expr.as_deref(),
                &q,
                &filters,
                personal,
                &vocab,
                req,
                &new_ids,
                (0, 0),
                ":p",
                want_count,
            )?;
        }
    }
    let mut page = SearchPage {
        hits: run.hits,
        next_cursor: run.next_cursor,
        ..Default::default()
    };
    if want_count {
        page.total = match (run.first_window, run.matched) {
            (Some((n, passed)), _) if n < CANDIDATES => passed as i64,
            (_, Some(matched)) => matched,
            _ => count(conn, expr.as_deref()),
        };
        page.total_capped = page.total > COUNT_CAP;
        page.total = page.total.min(COUNT_CAP);
    }
    if req.counts {
        for kind in ["prompt", "persona", "workflow", "rule", "style"] {
            let mut with_kind = q.clone();
            with_kind.filters.insert("kind".into(), vec![kind.into()]);
            let n = count(
                conn,
                match_expr_with(&with_kind, &vocab, prefix_all).as_deref(),
            )
            .min(COUNT_CAP + 1);
            page.kind_counts.insert(kind.into(), n);
        }
    }
    page.took_ms = started.elapsed().as_secs_f64() * 1000.0;
    Ok(page)
}

/// Rows for ids (in the given order), boosted for their reasons.
pub fn hits_for_ids(conn: &Connection, ids: &[String], signals: &Signals) -> Vec<Hit> {
    let vocab = store::vocab(conn);
    let new_ids: HashSet<String> = store::new_ids(conn).into_iter().collect();
    let mut seen = HashSet::new();
    store::rows_by_ids(conn, ids)
        .into_iter()
        .filter(|r| seen.insert(r.row.id.clone()) && !signals.hidden.contains(&r.row.id))
        .map(|r| {
            let (score, reasons) = boost(&r.row, signals, &vocab);
            Hit::from_row(r.rank, &r.row, score, reasons, new_ids.contains(&r.row.id))
                .labelled(&vocab)
        })
        .collect()
}

#[cfg(test)]
pub mod tests {
    use super::super::catalog::{self, tests::fixture};
    use super::super::store;
    use super::*;

    pub fn conn_with(entries: &[(&str, serde_json::Value, &str)]) -> Connection {
        let f = fixture("2026.0101.0", 1, entries);
        let mut src = f.objects.clone();
        let cat = catalog::collect(&f.manifest, &mut src, true, &HashSet::new()).unwrap();
        let mut conn = store::open_in_memory().unwrap();
        store::apply(&mut conn, &cat, "bundled").unwrap();
        conn
    }

    fn sample() -> Connection {
        conn_with(&[
            (
                "write-component-tests",
                serde_json::json!({"stack": ["react"], "role": ["frontend-engineer"], "tags": ["vitest", "jest"], "title": "Write tests for a React component"}),
                "x",
            ),
            (
                "fix-flaky-test",
                serde_json::json!({"tags": ["flaky", "retry"], "title": "Fix a flaky test", "stage": ["verify"]}),
                "x",
            ),
            (
                "find-root-cause",
                serde_json::json!({"cat": "debugging", "aliases": ["debug-root-cause"], "title": "Find the root cause of a bug"}),
                "x",
            ),
            (
                "next-page-audit",
                serde_json::json!({"stack": ["nextjs"], "title": "Audit a Next.js page"}),
                "x",
            ),
            (
                "python-lint",
                serde_json::json!({"stack": ["python"], "title": "Lint Python code", "works": ["chatgpt"]}),
                "x",
            ),
            (
                "persona-reviewer",
                serde_json::json!({"kind": "persona", "cat": "code-review", "title": "Code reviewer"}),
                "x",
            ),
            (
                "summarize-notes",
                serde_json::json!({"cat": "editing", "dom": "writing", "title": "Summarize notes"}),
                "x",
            ),
        ])
    }

    fn req(q: &str) -> SearchRequest {
        SearchRequest {
            query: q.into(),
            ..Default::default()
        }
    }

    #[test]
    fn parses_the_query_language() {
        let q = parse_query("Flaky kind:prompt cat:testing stack:react,vue nope:x");
        assert_eq!(q.terms, vec!["flaky", "nope:x"]);
        assert_eq!(q.filters["kind"], vec!["prompt"]);
        assert_eq!(q.filters["cat"], vec!["testing"]);
        assert_eq!(q.filters["stack"], vec!["react", "vue"]);
        assert_eq!(parse_query("category:git").filters["cat"], vec!["git"]);
    }

    #[test]
    fn text_score_matches_hodios_core() {
        let row = Row {
            id: "fix-flaky-test".into(),
            title: "Fix a flaky test".into(),
            tags: vec!["retry".into()],
            desc: "Makes timing deterministic".into(),
            ..Default::default()
        };
        assert_eq!(text_score(&row, &["flaky".into()]), Some(5.0));
        assert_eq!(text_score(&row, &["retr".into()]), Some(3.0));
        assert_eq!(text_score(&row, &["timing".into()]), Some(2.0));
        assert_eq!(
            text_score(&row, &["flaky".into(), "timing".into()]),
            Some(7.0)
        );
        assert_eq!(text_score(&row, &["banana".into()]), None);
    }

    #[test]
    fn searches_every_tier_and_stores_each_row_s_tier() {
        let conn = conn_with(&[
            (
                "lint-curated",
                serde_json::json!({"title": "Lint the code"}),
                "x",
            ),
            (
                "lint-verified",
                serde_json::json!({"tier": "verified", "title": "Lint the code too"}),
                "x",
            ),
            (
                "review-verified",
                serde_json::json!({"tier": "verified", "title": "Review a diff"}),
                "x",
            ),
        ]);
        let ids = |p: &SearchPage| p.hits.iter().map(|h| h.id.clone()).collect::<Vec<_>>();
        // Text search reaches both tiers; curated ranks first on equal text.
        assert_eq!(
            ids(&search(&conn, &req("lint"), None).unwrap()),
            vec!["lint-curated", "lint-verified"]
        );
        let mut verified = ids(&search(&conn, &req("tier:verified"), None).unwrap());
        verified.sort();
        assert_eq!(verified, vec!["lint-verified", "review-verified"]);
        assert_eq!(
            ids(&search(&conn, &req("tier:curated"), None).unwrap()),
            vec!["lint-curated"]
        );
        let tiers: Vec<(String, i64)> = conn
            .prepare("SELECT tier, rows FROM sync ORDER BY tier")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(tiers, vec![("curated".into(), 1), ("verified".into(), 2)]);
    }

    #[test]
    fn searches_text_aliases_and_facets() {
        let conn = sample();
        let ids = |p: &SearchPage| p.hits.iter().map(|h| h.id.clone()).collect::<Vec<_>>();
        assert_eq!(
            ids(&search(&conn, &req("flaky"), None).unwrap()),
            vec!["fix-flaky-test"]
        );
        // Prefix and alias (tags column).
        assert_eq!(
            ids(&search(&conn, &req("debug-root"), None).unwrap()),
            vec!["find-root-cause"]
        );
        // A facet alone.
        assert_eq!(
            ids(&search(&conn, &req("kind:persona"), None).unwrap()),
            vec!["persona-reviewer"]
        );
        // stack:react matches nextjs rows too (implies).
        let mut r = ids(&search(&conn, &req("stack:react"), None).unwrap());
        r.sort();
        assert_eq!(r, vec!["next-page-audit", "write-component-tests"]);
        // A synonym.
        assert_eq!(
            search(&conn, &req("stack:reactjs"), None)
                .unwrap()
                .hits
                .len(),
            2
        );
        // works:claude is an alias of claude-code.
        assert_eq!(
            search(&conn, &req("lint works:claude"), None)
                .unwrap()
                .hits
                .len(),
            0
        );
        // Facet chips work like query keys.
        let mut chips = req("");
        chips
            .filters
            .insert("domain".into(), vec!["writing".into()]);
        assert_eq!(
            ids(&search(&conn, &chips, None).unwrap()),
            vec!["summarize-notes"]
        );
        // An unfinished earlier word still finds it (every word as a prefix).
        assert_eq!(
            ids(&search(&conn, &req("flak test"), None).unwrap()),
            vec!["fix-flaky-test"]
        );
        // Nothing for nonsense; an empty query browses everything.
        assert!(search(&conn, &req("zzzqqq"), None).unwrap().hits.is_empty());
        assert_eq!(search(&conn, &req(""), None).unwrap().total, 7);
    }

    #[test]
    fn personal_boosts_reorder_and_explain() {
        let conn = sample();
        // A Next.js project also uses React (implies): both rows match.
        let signals = Signals {
            stack: vec!["nextjs".into()],
            works: vec!["claude-code".into()],
            ..Default::default()
        };
        let page = search(&conn, &req(""), Some(&signals)).unwrap();
        assert_eq!(page.hits[0].id, "next-page-audit");
        assert_eq!(page.hits[1].id, "write-component-tests");
        assert_eq!(page.hits[1].reasons[0].code, "stack");
        assert_eq!(page.hits[1].reasons[0].label, "React");
        // A row no installed agent runs sinks to the bottom, but stays.
        assert_eq!(page.hits.last().unwrap().id, "python-lint");
        // Show everything: plain static order, no reasons.
        let mut plain = req("");
        plain.personalise = Some(false);
        let page = search(&conn, &plain, Some(&signals)).unwrap();
        assert!(page.hits.iter().all(|h| h.reasons.is_empty()));
        assert_eq!(page.hits[0].id, "find-root-cause");
        // A React project does not pull in Next.js rows (implies goes one way).
        let react = Signals {
            stack: vec!["react".into()],
            ..Default::default()
        };
        let page = search(&conn, &req(""), Some(&react)).unwrap();
        assert_eq!(page.hits[0].id, "write-component-tests");
    }

    #[test]
    fn hidden_rows_stay_out_unless_asked() {
        let conn = sample();
        let signals = Signals {
            hidden: HashSet::from(["fix-flaky-test".to_string()]),
            ..Default::default()
        };
        assert!(search(&conn, &req("flaky"), Some(&signals))
            .unwrap()
            .hits
            .is_empty());
        let mut r = req("flaky");
        r.include_hidden = true;
        assert_eq!(search(&conn, &r, Some(&signals)).unwrap().hits.len(), 1);
    }

    #[test]
    fn counts_kinds_and_pages_with_a_keyset_cursor() {
        let entries: Vec<(String, serde_json::Value, &str)> = (0..130)
            .map(|i| {
                (
                    format!("entry-{i:03}"),
                    serde_json::json!({"title": format!("Common thing {i}")}),
                    "x",
                )
            })
            .collect();
        let refs: Vec<(&str, serde_json::Value, &str)> = entries
            .iter()
            .map(|(a, b, c)| (a.as_str(), b.clone(), *c))
            .collect();
        let conn = conn_with(&refs);
        let mut r = req("common");
        r.limit = Some(50);
        r.counts = true;
        let p1 = search(&conn, &r, None).unwrap();
        assert_eq!(p1.total, 130);
        assert_eq!(p1.kind_counts["prompt"], 130);
        assert_eq!(p1.hits.len(), 50);
        let mut seen: HashSet<String> = p1.hits.iter().map(|h| h.id.clone()).collect();
        let mut cursor = p1.next_cursor.clone();
        let mut pages = 1;
        while let Some(c) = cursor {
            let mut next = req("common");
            next.cursor = Some(c);
            let p = search(&conn, &next, None).unwrap();
            for h in &p.hits {
                assert!(seen.insert(h.id.clone()), "{} twice", h.id);
            }
            cursor = p.next_cursor;
            pages += 1;
        }
        assert_eq!((seen.len(), pages), (130, 3));
    }

    #[test]
    fn match_expression_quotes_and_scopes_tokens() {
        let vocab = Vocab::default();
        let expr = match_expr(&parse_query("can't stop kind:prompt"), &vocab).unwrap();
        assert_eq!(expr, "\"can\" AND \"t\" AND \"stop\"* AND (\"kprompt\")");
        let wide = match_expr_with(&parse_query("flak test"), &vocab, true).unwrap();
        assert_eq!(wide, "\"flak\"* AND \"test\"*");
        assert!(match_expr(&parse_query(""), &vocab).is_none());
    }
}
