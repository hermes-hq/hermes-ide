//! Search over `library.db`: the hodios-core query language and ranking
//! (`parseQuery`, `search`, `WEIGHTS` in `@hermes-hq/hodios-core/catalog`)
//! on top of FTS5.
//!
//! Plan (design §12.5): up to 300 FTS matches in rowid order — the static
//! rank: essentials, depth, commonness — with facets as hidden FTS tokens
//! inside the same MATCH, then a rerank of only those candidates by text
//! relevance plus personal boosts. The cost is bounded by the candidate
//! cap, not the catalog size. Paging is keyset (`rowid > cursor`), never
//! OFFSET.
//!
//! Everyday queries: stop words are dropped, a plain need ("trip") routes
//! to its front door first (`everyday.rs`), and when no entry has every
//! word the rows with the most of them answer instead, with the words
//! nothing used ("lisbon") handed back for the UI to fill in.
//!
//! Personal signals arrive with the request and are used only here, on the
//! device; nothing about them is stored in this file or sent anywhere.

use super::catalog::{Row, Vocab};
use super::everyday;
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
        "depth" => ("dep", None),
        "intent" => ("int", None),
        "topic" => ("top", None),
        "ess" => ("ess", None),
        "adv" => ("adv", Some("advice-risk")),
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

/// Lower-case words of letters and digits, any script (hodios-core `searchWords`).
pub fn words(s: &str) -> Vec<String> {
    s.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(str::to_string)
        .collect()
}

/// Search weights of a row's text fields: id and title, extra search words
/// (`syn` and the category label), aliases and tags, description.
pub const TEXT_WEIGHTS: [f64; 4] = [5.0, 4.0, 3.0, 2.0];

/// How a row's text answers the terms of a query.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct TextMatch {
    pub score: f64,
    /// Terms that hit a field.
    pub matched: usize,
    /// Terms with words in them.
    pub asked: usize,
}

/// hodios-core `textScore`: a term hits the best field where all its words
/// match word prefixes (id/title 5, syn and the category label 4,
/// aliases/tags 3, description 2). `extra` are words the row is also
/// found by (its category label).
pub fn text_match(row: &Row, terms: &[String], extra: &[String]) -> TextMatch {
    let mut out = TextMatch::default();
    if terms.is_empty() {
        return out;
    }
    // Each field lowercased once and read as words in place (no word allocations).
    let join = |parts: &mut dyn Iterator<Item = &String>| {
        let mut out = String::new();
        for p in parts {
            out.push_str(&p.to_lowercase());
            out.push(' ');
        }
        out
    };
    let id_title = format!("{} {}", row.id, row.title).to_lowercase();
    let syn = join(&mut row.syn.iter().chain(extra.iter()));
    let tags = join(&mut row.aliases.iter().chain(row.tags.iter()));
    let desc = row.desc.to_lowercase();
    let fields: [&str; 4] = [&id_title, &syn, &tags, &desc];
    for term in terms {
        // A word matches a word it starts, or one its stem starts ("trips" -> "trip").
        let parts: Vec<(String, String)> = words(term)
            .into_iter()
            .map(|p| {
                let stem = if p.chars().count() > 3 {
                    everyday::stem_word(&p)
                } else {
                    p.clone()
                };
                (p, stem)
            })
            .collect();
        if parts.is_empty() {
            continue;
        }
        out.asked += 1;
        let mut best = 0.0f64;
        for (list, weight) in fields.iter().zip(TEXT_WEIGHTS) {
            if best >= weight {
                continue;
            }
            if parts.iter().all(|(p, stem)| {
                list.split(|c: char| !c.is_alphanumeric()).any(|w| {
                    !w.is_empty() && (w.starts_with(p.as_str()) || w.starts_with(stem.as_str()))
                })
            }) {
                best = best.max(weight);
            }
        }
        if best > 0.0 {
            out.matched += 1;
            out.score += best;
        }
    }
    out
}

/// Every term must hit (hodios-core); None when one does not.
#[cfg(test)]
pub fn text_score(row: &Row, terms: &[String]) -> Option<f64> {
    let m = text_match(row, terms, &[]);
    (m.matched == m.asked).then_some(m.score)
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
    if let Some(n) = s.used.get(&row.id).filter(|n| **n >= 1) {
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
    /// A front door (Essentials level 1).
    pub door: bool,
    /// An everyday essential (level 1 or 2).
    pub essential: bool,
    /// Professional-advice risk values (medical, mental-health, legal, financial).
    pub adv: Vec<String>,
    pub intents: Vec<String>,
    pub topic: Option<String>,
    /// Depth level id (the vocab's), None when the catalog has no levels.
    pub depth: Option<String>,
    /// Terms of the query this row matched (not sent).
    #[serde(skip)]
    pub matched: usize,
    /// Position of the depth level (not sent; the UI has the vocab's order).
    #[serde(skip)]
    pub depth_rank: i64,
}

impl Hit {
    /// Category and domain names in the vocab's words; depth, intents and
    /// topic from the vocab when the row does not carry them.
    pub fn labelled(mut self, vocab: &Vocab) -> Self {
        self.domain_label = vocab.label("domain", &self.domain).to_string();
        self.category_label = vocab.label("category", &self.category).to_string();
        self.depth = vocab.depth_of(self.depth.as_deref());
        self.depth_rank = vocab.depth_rank(self.depth.as_deref());
        if let Some(ci) = vocab.category_intent(&self.category) {
            if self.intents.is_empty() {
                self.intents = ci.intents.clone();
            }
            if self.topic.is_none() {
                self.topic = ci.topic.clone();
            }
        }
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
            door: row.ess == 2,
            essential: row.ess == 1 || row.ess == 2,
            adv: row.adv.clone(),
            intents: row.intents.clone(),
            topic: row.top.clone(),
            depth: row.dep.clone(),
            matched: 0,
            depth_rank: 0,
        }
    }
}

/// The front door a plain need routes to, and the specialists to narrow to.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RoutePage {
    /// An entry whose id or title holds every word of the query, when the
    /// front door does not ("plan a road trip"): it comes first, the front
    /// door second (hodios-core).
    pub exact: Option<Hit>,
    pub to: Hit,
    pub refine: Vec<Hit>,
    /// The words of the query that routed it.
    pub phrase: String,
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
    /// Matches per depth level (with `counts`).
    pub depth_counts: BTreeMap<String, i64>,
    /// The routed need (first page only).
    pub route: Option<RoutePage>,
    /// Words of the query the best match did not use ("Lisbon", "5-day"):
    /// the UI offers them as that entry's answers.
    pub leftover: Vec<String>,
    /// No entry matched every word: these match some of them, most first.
    pub partial: bool,
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
        "dep" => opt(&row.dep),
        "int" => many(&row.intents),
        "top" => opt(&row.top),
        "adv" => many(&row.adv),
        "ess" => match row.ess {
            2 => vec!["door", "essential"],
            1 => vec!["essential"],
            _ => Vec::new(),
        },
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

/// How the text of a query is matched.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum TextMode {
    /// Every word a whole token except the last typed (a prefix).
    Exact,
    /// Every word a prefix (hodios-core's semantics).
    Prefix,
    /// Any word, as a prefix: the fallback when no entry has them all.
    Any,
}

impl TextMode {
    fn marker(self) -> &'static str {
        match self {
            TextMode::Exact => "",
            TextMode::Prefix => ":p",
            TextMode::Any => ":a",
        }
    }
}

fn filter_clauses(q: &ParsedQuery, vocab: &Vocab) -> Vec<String> {
    let mut clauses = Vec::new();
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
    clauses
}

/// The FTS MATCH expression for terms and filters, or None for a plain browse.
///
/// Text words match as whole tokens except the last one typed, which matches
/// as a prefix (typeahead): a whole-token posting list is read lazily and a
/// query stops after 300 hits, while a long prefix must first be expanded
/// into every token it starts. `Prefix` matches every word as a prefix
/// (hodios-core's semantics), the fallback when the fast form finds nothing;
/// `Any` ORs the words, the fallback when no entry has them all. Stop words
/// are left out (`everyday::content_terms`). No column filters: facet tokens
/// carry a letter prefix no word has, and `text_match` / `filters_match`
/// check every candidate exactly.
pub fn match_expr_mode(q: &ParsedQuery, vocab: &Vocab, mode: TextMode) -> Option<String> {
    let mut clauses = Vec::new();
    let terms = everyday::content_terms(&q.terms);
    let parts: Vec<String> = terms.iter().flat_map(|t| words(t)).collect();
    let mut text = Vec::new();
    for (i, part) in parts.iter().enumerate() {
        let last = i + 1 == parts.len();
        let whole = if mode != TextMode::Exact || last {
            format!("\"{part}\"*")
        } else {
            format!("\"{part}\"")
        };
        // Its stem too, as a prefix ("trips" finds "trip"), like text_match.
        let stem = if part.chars().count() > 3 {
            everyday::stem_word(part)
        } else {
            part.clone()
        };
        if stem != *part {
            text.push(format!("({whole} OR \"{stem}\"*)"));
        } else {
            text.push(whole);
        }
    }
    if mode == TextMode::Any && text.len() > 1 {
        clauses.push(format!("({})", text.join(" OR ")));
    } else {
        clauses.extend(text);
    }
    clauses.extend(filter_clauses(q, vocab));
    if clauses.is_empty() {
        None
    } else {
        Some(clauses.join(" AND "))
    }
}

#[cfg(test)]
pub fn match_expr_with(q: &ParsedQuery, vocab: &Vocab, prefix_all: bool) -> Option<String> {
    match_expr_mode(
        q,
        vocab,
        if prefix_all {
            TextMode::Prefix
        } else {
            TextMode::Exact
        },
    )
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

pub fn load_rows(conn: &Connection, rowids: &[i64]) -> Result<Vec<(i64, Row)>, String> {
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

/// How a window of candidates is reranked.
pub struct RankOpts<'a> {
    /// The query's terms, stop words already dropped.
    pub terms: &'a [String],
    /// Any term may hit (the partial-match fallback); else every term must.
    pub any_term: bool,
    pub filters: &'a [(String, &'static str, Vec<String>)],
    pub signals: Option<&'a Signals>,
    pub vocab: &'a Vocab,
    pub sort: &'a str,
    pub new_ids: &'a HashSet<String>,
    pub include_hidden: bool,
    /// Basic entries first (the depth order), then relevance: typed
    /// searches and category views, whose results the UI sections by depth.
    pub depth_major: bool,
    /// Ids shown elsewhere on the page (the routed front door and its refine list).
    pub exclude: &'a HashSet<String>,
}

/// Reranks a window of candidates.
pub fn rank(rows: Vec<(i64, Row)>, o: &RankOpts) -> Vec<Hit> {
    let mut hits: Vec<Hit> = rows
        .into_iter()
        .filter(|(_, row)| !o.exclude.contains(&row.id))
        .filter(|(_, row)| {
            o.include_hidden || o.signals.is_none_or(|s| !s.hidden.contains(&row.id))
        })
        .filter(|(_, row)| filters_match(row, o.filters))
        .filter_map(|(rank, row)| {
            let label = [o.vocab.label("category", &row.cat).to_string()];
            let text = text_match(&row, o.terms, &label);
            if text.asked > 0 && (text.matched == 0 || (!o.any_term && text.matched < text.asked)) {
                return None;
            }
            let (b, reasons) = match o.signals {
                Some(s) if o.sort != "best" => boost(&row, s, o.vocab),
                _ => (0.0, Vec::new()),
            };
            // A common entry wins a near tie over a niche one (q is 0-100).
            let common = if text.asked > 0 {
                row.q.clamp(0, 100) as f64 / 50.0
            } else {
                0.0
            };
            let is_new = o.new_ids.contains(&row.id);
            let mut hit = Hit::from_row(rank, &row, text.score + common + b, reasons, is_new)
                .labelled(o.vocab);
            hit.matched = text.matched;
            Some(hit)
        })
        .collect();
    let by_score = |a: &Hit, b: &Hit| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.rank.cmp(&b.rank))
    };
    match o.sort {
        "new" => hits.sort_by(|a, b| b.is_new.cmp(&a.is_new).then(a.rank.cmp(&b.rank))),
        _ => hits.sort_by(|a, b| {
            let matched = if o.any_term {
                b.matched.cmp(&a.matched)
            } else {
                std::cmp::Ordering::Equal
            };
            let depth = if o.depth_major {
                a.depth_rank.cmp(&b.depth_rank)
            } else {
                std::cmp::Ordering::Equal
            };
            matched.then(depth).then_with(|| by_score(a, b))
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

fn pass(
    conn: &Connection,
    expr: Option<&str>,
    o: &RankOpts,
    req: &SearchRequest,
    (mut after, mut offset): (i64, usize),
    mode: TextMode,
    count_first: bool,
) -> Result<Pass, String> {
    let limit = req.limit.unwrap_or(MAX_PAGE).clamp(1, MAX_PAGE);
    // A partial match reads a wider window: its best rows match the most
    // words, wherever they sit in the static order.
    let window_size = if mode == TextMode::Any {
        COUNT_CAP as usize
    } else {
        CANDIDATES
    };
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
            all.truncate(window_size);
            all
        } else {
            candidates(conn, expr, after, window_size)?
        };
        let full = window.len() == window_size;
        let last = window.last().copied();
        let ranked = rank(load_rows(conn, &window)?, o);
        if out.first_window.is_none() && after == 0 {
            out.first_window = Some((window.len(), ranked.len()));
        }
        let end = (offset + limit).min(ranked.len());
        if offset < end {
            out.hits.extend(ranked[offset..end].iter().cloned());
        }
        if end < ranked.len() {
            out.next_cursor = Some(format!("{after}:{end}{}", mode.marker()));
            break;
        }
        match (full, last) {
            (true, Some(last)) if out.hits.is_empty() => {
                after = last;
                offset = 0;
                continue;
            }
            (true, Some(last)) => out.next_cursor = Some(format!("{last}:0{}", mode.marker())),
            _ => {}
        }
        break;
    }
    Ok(out)
}

/// The FTS tokens of what this person works on (project stack, roles,
/// interests, the Track phase, what they use most): an empty-query "For
/// you" also reads the rows carrying them, wherever they sit in the
/// static order, instead of only its first window.
pub fn personal_tokens(s: &Signals, vocab: &Vocab) -> Vec<String> {
    let mut tokens: Vec<String> = s
        .stack
        .iter()
        .flat_map(|v| vocab.implies_of("stack", v))
        .map(|v| facet_token('s', &v))
        .collect();
    tokens.extend(s.roles.iter().map(|v| facet_token('r', v)));
    tokens.extend(s.domains.iter().map(|v| facet_token('d', v)));
    tokens.extend(s.categories.iter().map(|v| facet_token('c', v)));
    tokens.extend(s.subjects.iter().map(|v| facet_token('j', v)));
    tokens.extend(s.stage.iter().map(|v| facet_token('g', v)));
    for (facet, value, used) in &s.affinity {
        if *used >= 1.0 {
            match facet.as_str() {
                "category" => tokens.push(facet_token('c', value)),
                "domain" => tokens.push(facet_token('d', value)),
                _ => {}
            }
        }
    }
    tokens.retain(|t| t.len() > 1);
    tokens.sort();
    tokens.dedup();
    tokens
}

/// Rows for ids (in the given order), boosted for their reasons, minus hidden.
fn route_hits(conn: &Connection, ids: &[String], o: &RankOpts) -> Vec<Hit> {
    let mut seen = HashSet::new();
    store::rows_by_ids(conn, ids)
        .into_iter()
        .filter(|r| seen.insert(r.row.id.clone()))
        .filter(|r| o.include_hidden || o.signals.is_none_or(|s| !s.hidden.contains(&r.row.id)))
        .filter(|r| filters_match(&r.row, o.filters))
        .map(|r| {
            let (score, reasons) = match o.signals {
                Some(s) => boost(&r.row, s, o.vocab),
                None => (0.0, Vec::new()),
            };
            Hit::from_row(
                r.rank,
                &r.row,
                score,
                reasons,
                o.new_ids.contains(&r.row.id),
            )
            .labelled(o.vocab)
        })
        .collect()
}

/// hodios-core: with more than one word, an entry whose id or title holds
/// every word beats a front door that does not hold them all. The first
/// such entry in static order, from the first window of whole matches.
fn exact_title(
    conn: &Connection,
    q: &ParsedQuery,
    vocab: &Vocab,
    terms: &[String],
    door: &Hit,
    o: &RankOpts,
) -> Result<Option<Hit>, String> {
    if terms.len() < 2 {
        return Ok(None);
    }
    if let Some(row) = store::row_by_id(conn, &door.id) {
        let label = [vocab.label("category", &row.row.cat).to_string()];
        if text_match(&row.row, terms, &label).matched == terms.len() {
            return Ok(None);
        }
    }
    let Some(expr) = match_expr_mode(q, vocab, TextMode::Prefix) else {
        return Ok(None);
    };
    let all = TEXT_WEIGHTS[0] * terms.len() as f64;
    let found = load_rows(conn, &candidates(conn, Some(&expr), 0, CANDIDATES)?)?
        .into_iter()
        .find(|(_, row)| {
            row.id != door.id
                && filters_match(row, o.filters)
                && o.signals.is_none_or(|s| !s.hidden.contains(&row.id))
                && text_match(row, terms, &[]).score == all
        });
    Ok(found.and_then(|(_, row)| route_hits(conn, std::slice::from_ref(&row.id), o).pop()))
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
    let sort = req.sort.as_deref().unwrap_or("you");
    let new_ids: HashSet<String> = store::new_ids(conn).into_iter().collect();
    let terms = everyday::content_terms(&q.terms);
    let want_count = req.counts || req.cursor.is_none();

    // A plain need routes to its front door (queries.json); the front door
    // and its refine list lead the page and are left out of the list.
    let routes = store::routes(conn);
    let routed = if q.terms.is_empty() {
        None
    } else {
        everyday::route(&req.query, &routes)
    };
    let none: HashSet<String> = HashSet::new();
    let mut exclude: HashSet<String> = HashSet::new();
    let mut route_page: Option<RoutePage> = None;
    let mut leftover: Vec<String> = Vec::new();
    // Facet filters other than the kind and the agent make a category
    // view: sectioned by depth like a typed search.
    let depth_major = !terms.is_empty()
        || filters
            .iter()
            .any(|(k, _, _)| !matches!(k.as_str(), "kind" | "works"));
    let base = RankOpts {
        terms: &terms,
        any_term: false,
        filters: &filters,
        signals: personal,
        vocab: &vocab,
        sort,
        new_ids: &new_ids,
        include_hidden: req.include_hidden,
        depth_major,
        exclude: &none,
    };
    if let Some(r) = &routed {
        let mut found = route_hits(conn, std::slice::from_ref(&r.route.to), &base);
        if let Some(to) = found.pop() {
            let refine: Vec<Hit> = route_hits(conn, &r.route.refine, &base)
                .into_iter()
                .filter(|h| h.id != to.id)
                .collect();
            let exact = exact_title(conn, &q, &vocab, &terms, &to, &base)?;
            let top = exact.as_ref().unwrap_or(&to);
            if let Some(row) = store::row_by_id(conn, &top.id) {
                let label = [vocab.label("category", &row.row.cat).to_string()];
                leftover = everyday::leftover(&req.query, &row.row, &label);
            }
            route_page = Some(RoutePage {
                refine: refine
                    .into_iter()
                    .filter(|h| exact.as_ref().is_none_or(|e| e.id != h.id))
                    .collect(),
                exact,
                to,
                phrase: r.phrase.clone(),
            });
        }
    }
    if let Some(rp) = &route_page {
        exclude.insert(rp.to.id.clone());
        exclude.extend(rp.exact.iter().map(|h| h.id.clone()));
        exclude.extend(rp.refine.iter().map(|h| h.id.clone()));
    }
    let opts = |any_term: bool| RankOpts {
        any_term,
        exclude: &exclude,
        ..base
    };

    // ":p" on a cursor: the page came from the every-word-a-prefix form;
    // ":a" from the any-word fallback.
    let cursor = req.cursor.as_deref();
    let mut mode = match cursor {
        Some(c) if c.ends_with(":p") => TextMode::Prefix,
        Some(c) if c.ends_with(":a") => TextMode::Any,
        _ => TextMode::Exact,
    };
    let position = parse_cursor(cursor.map(|c| c.trim_end_matches(":p").trim_end_matches(":a")));
    let mut expr = match_expr_mode(&q, &vocab, mode);
    let mut run = pass(
        conn,
        expr.as_deref(),
        &opts(mode == TextMode::Any),
        req,
        position,
        mode,
        want_count && position.0 == 0,
    )?;
    // Nothing with whole words: try every word as a prefix ("flak test").
    if run.hits.is_empty() && cursor.is_none() && mode == TextMode::Exact && !terms.is_empty() {
        let wide = match_expr_mode(&q, &vocab, TextMode::Prefix);
        if wide != expr {
            mode = TextMode::Prefix;
            expr = wide;
            run = pass(
                conn,
                expr.as_deref(),
                &opts(false),
                req,
                (0, 0),
                mode,
                want_count,
            )?;
        }
    }
    // Still nothing with every word: the rows with the most of them
    // ("plan a 5-day trip to lisbon" has no "lisbon" entry).
    if run.hits.is_empty() && cursor.is_none() && terms.len() > 1 && mode != TextMode::Any {
        mode = TextMode::Any;
        expr = match_expr_mode(&q, &vocab, mode);
        run = pass(
            conn,
            expr.as_deref(),
            &opts(true),
            req,
            (0, 0),
            mode,
            want_count,
        )?;
    }

    // An empty-query "For you" also reads the rows that carry this
    // person's facets across the whole catalog, not only the first window.
    if terms.is_empty() && cursor.is_none() && sort == "you" {
        if let Some(s) = personal {
            let tokens = personal_tokens(s, &vocab);
            if !tokens.is_empty() {
                let mut clauses = filter_clauses(&q, &vocab);
                clauses.push(format!(
                    "({})",
                    tokens
                        .iter()
                        .map(|t| format!("\"{t}\""))
                        .collect::<Vec<_>>()
                        .join(" OR ")
                ));
                let mine = candidates(conn, Some(&clauses.join(" AND ")), 0, COUNT_CAP as usize)?;
                let shown: HashSet<String> = run.hits.iter().map(|h| h.id.clone()).collect();
                let limit = req.limit.unwrap_or(MAX_PAGE).clamp(1, MAX_PAGE);
                let room = (limit / 2).max(1);
                let extra: Vec<Hit> = rank(load_rows(conn, &mine)?, &opts(false))
                    .into_iter()
                    .filter(|h| !shown.contains(&h.id))
                    .take(room)
                    .collect();
                if !extra.is_empty() {
                    // Within the first window, the rows this displaces start the next page.
                    if let Some(at) = run
                        .next_cursor
                        .as_deref()
                        .and_then(|c| c.strip_prefix("0:"))
                        .and_then(|o| o.parse::<usize>().ok())
                    {
                        let keep = run.hits.len().saturating_sub(extra.len());
                        let moved = run.hits.len() - keep;
                        run.hits.truncate(keep);
                        run.next_cursor = Some(format!("0:{}", at - moved));
                    }
                    run.hits.extend(extra);
                    run.hits.sort_by(|a, b| {
                        b.score
                            .partial_cmp(&a.score)
                            .unwrap_or(std::cmp::Ordering::Equal)
                            .then(a.rank.cmp(&b.rank))
                    });
                }
            }
        }
    }

    if mode == TextMode::Any && route_page.is_none() {
        if let Some(best) = run.hits.first() {
            if let Some(row) = store::row_by_id(conn, &best.id) {
                let label = [vocab.label("category", &row.row.cat).to_string()];
                leftover = everyday::leftover(&req.query, &row.row, &label);
            }
        }
    }
    let mut page = SearchPage {
        hits: run.hits,
        next_cursor: run.next_cursor,
        partial: mode == TextMode::Any,
        leftover,
        route: if cursor.is_none() { route_page } else { None },
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
            let n = count(conn, match_expr_mode(&with_kind, &vocab, mode).as_deref())
                .min(COUNT_CAP + 1);
            page.kind_counts.insert(kind.into(), n);
        }
        for level in vocab.depth_levels() {
            let mut with_depth = q.clone();
            with_depth
                .filters
                .insert("depth".into(), vec![level.id.clone()]);
            let n = count(conn, match_expr_mode(&with_depth, &vocab, mode).as_deref())
                .min(COUNT_CAP + 1);
            page.depth_counts.insert(level.id.clone(), n);
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

    // ─── Everyday prompts ─────────────────────────────────────────────

    /// The depth levels and intents of hodios `vocab/depth.yml` and
    /// `vocab/intent.yml`, as the catalog's vocab object carries them.
    pub fn everyday_vocab() -> serde_json::Value {
        serde_json::json!({
            "depth": [
                {"id": "basic", "label": "Start here"},
                {"id": "specific", "label": "Specific"},
                {"id": "advanced", "label": "Advanced"}
            ],
            "intent": {
                "intents": [
                    {"id": "write", "label": "Write", "hint": "emails, posts, letters"},
                    {"id": "plan", "label": "Plan", "hint": "trips, meals, money"},
                    {"id": "code", "label": "Code", "hint": "review, build, test"}
                ],
                "topics": [
                    {"id": "travel", "label": "Travel"}, {"id": "food", "label": "Food"},
                    {"id": "health", "label": "Health"}, {"id": "software", "label": "Software"}
                ],
                "categories": {
                    "trip-planning": {"intents": ["plan"], "topic": "travel"},
                    "nutrition": {"intents": ["plan"], "topic": "health"},
                    "meal-planning": {"intents": ["plan"], "topic": "food"},
                    "code-review": {"intents": ["code"], "topic": "software"}
                }
            },
            "facets": {
                "category": { "labels": { "trip-planning": "Trip planning", "nutrition": "Nutrition and diet",
                                          "meal-planning": "Meal planning", "code-review": "Code review",
                                          "media": "Media literacy", "testing": "Testing" },
                              "synonyms": {}, "implies": {} },
                "domain": { "labels": { "travel": "Travel", "health-wellbeing": "Health and wellbeing",
                                        "software-engineering": "Software engineering" }, "synonyms": {}, "implies": {} },
                "stack": { "labels": {}, "synonyms": {}, "implies": {} },
                "role": { "labels": { "traveler": "Traveler" }, "synonyms": {}, "implies": {} }
            }
        })
    }

    pub fn everyday_routes() -> serde_json::Value {
        serde_json::json!({ "schema": 1, "routes": [
            { "to": "plan-a-trip", "phrases": ["trip", "travel", "vacation", "holiday", "city break"],
              "refine": ["plan-itinerary", "plan-road-trip"] },
            { "to": "eat-healthier", "phrases": ["diet", "lose weight", "eat healthier", "meal plan"],
              "refine": ["plan-weekly-meals", "plan-sustainable-weight-loss"] },
            { "to": "review-a-pull-request", "phrases": ["code review", "review my code", "pull request"],
              "refine": ["review-pull-request"] }
        ]})
    }

    /// A small catalog with the everyday fields (and two rows without them).
    pub fn everyday_entries() -> Vec<(&'static str, serde_json::Value, &'static str)> {
        let trip = |extra: serde_json::Value| {
            let mut base =
                serde_json::json!({"cat": "trip-planning", "dom": "travel", "role": ["traveler"]});
            for (k, v) in extra.as_object().unwrap() {
                base[k] = v.clone();
            }
            base
        };
        vec![
            (
                "accept-a-job-offer",
                serde_json::json!({"cat": "testing", "title": "Accept a job offer"}),
                "x",
            ),
            (
                "ad-campaign",
                serde_json::json!({"cat": "testing", "title": "Ad campaign brief"}),
                "x",
            ),
            (
                "plan-a-trip",
                trip(
                    serde_json::json!({"title": "Plan a trip", "desc": "Where, when, budget: a day-by-day plan.",
                "ess": 2, "q": 100, "dep": "basic", "syn": ["travel", "vacation", "holiday", "getaway"], "role": ["individual"],
                "fm": {"args": [{"name": "destination", "description": "Where to"}, {"name": "days", "description": "How many days"}]}}),
                ),
                "Plan {{destination}}",
            ),
            (
                "plan-itinerary",
                trip(
                    serde_json::json!({"title": "Plan a trip itinerary", "q": 60, "dep": "specific"}),
                ),
                "x",
            ),
            (
                "plan-road-trip",
                trip(serde_json::json!({"title": "Plan a road trip", "q": 55, "dep": "specific"})),
                "x",
            ),
            (
                "plan-school-field-trip",
                trip(
                    serde_json::json!({"title": "Plan a school field trip", "q": 10, "dep": "advanced"}),
                ),
                "x",
            ),
            (
                "check-car-before-road-trip",
                trip(
                    serde_json::json!({"title": "Check a car before a road trip", "q": 20, "dep": "advanced"}),
                ),
                "x",
            ),
            (
                "plan-weekend-trip",
                trip(
                    serde_json::json!({"title": "Plan a weekend away", "desc": "A short trip.", "q": 70, "dep": "basic", "ess": 1}),
                ),
                "x",
            ),
            (
                "eat-healthier",
                serde_json::json!({"cat": "nutrition", "dom": "health-wellbeing", "title": "Eat healthier",
                "desc": "A realistic meal plan around your goals.", "ess": 2, "q": 100, "dep": "basic", "adv": ["medical"],
                "syn": ["diet", "lose weight", "healthy eating"]}),
                "x",
            ),
            (
                "plan-weekly-meals",
                serde_json::json!({"cat": "meal-planning", "dom": "health-wellbeing", "title": "Plan a week of meals",
                "q": 80, "dep": "basic", "ess": 1}),
                "x",
            ),
            // advice_risk only in the body, as in catalogs before rows carried it.
            (
                "plan-sustainable-weight-loss",
                serde_json::json!({"cat": "nutrition", "dom": "health-wellbeing",
                "title": "Plan sustainable weight loss", "q": 50, "dep": "specific", "fm": {"advice_risk": ["medical"]}}),
                "x",
            ),
            (
                "audit-news-diet",
                serde_json::json!({"cat": "media", "dom": "writing", "title": "Audit my news diet", "q": 5, "dep": "advanced"}),
                "x",
            ),
            (
                "review-a-pull-request",
                serde_json::json!({"cat": "code-review", "dom": "software-engineering", "title": "Review a pull request",
                "desc": "Bugs, risks and clear comments.", "ess": 2, "q": 100, "dep": "basic", "syn": ["code review", "pr review"]}),
                "x",
            ),
            (
                "review-pull-request",
                serde_json::json!({"cat": "code-review", "dom": "software-engineering",
                "title": "Review a pull request in depth", "q": 70, "dep": "specific"}),
                "x",
            ),
            (
                "code-reviewer",
                serde_json::json!({"kind": "persona", "cat": "code-review", "dom": "software-engineering",
                "title": "Code reviewer", "q": 40, "dep": "specific"}),
                "x",
            ),
        ]
    }

    pub fn everyday() -> Connection {
        let f = super::super::catalog::tests::fixture_with(
            "2026.1101.0",
            1,
            &everyday_entries(),
            everyday_vocab(),
            Some(everyday_routes()),
        );
        let mut src = f.objects.clone();
        let cat = catalog::collect(&f.manifest, &mut src, true, &HashSet::new()).unwrap();
        let mut conn = store::open_in_memory().unwrap();
        store::apply(&mut conn, &cat, "bundled").unwrap();
        conn
    }

    fn top(p: &SearchPage, n: usize) -> Vec<String> {
        p.route
            .iter()
            .flat_map(|r| r.exact.iter().map(|h| h.id.clone()))
            .chain(p.route.iter().map(|r| r.to.id.clone()))
            .chain(
                p.route
                    .iter()
                    .flat_map(|r| r.refine.iter().map(|h| h.id.clone())),
            )
            .chain(p.hits.iter().map(|h| h.id.clone()))
            .take(n)
            .collect()
    }

    #[test]
    fn static_rank_is_essentials_depth_commonness_not_a_to_z() {
        let conn = everyday();
        let page = search(&conn, &req(""), None).unwrap();
        let ids: Vec<&str> = page.hits.iter().map(|h| h.id.as_str()).collect();
        assert_eq!(
            &ids[..3],
            &["eat-healthier", "plan-a-trip", "review-a-pull-request"]
        );
        assert_eq!(&ids[3..5], &["plan-weekly-meals", "plan-weekend-trip"]);
        // The rows with no everyday fields (old style) come after every basic one.
        let at = |id: &str| ids.iter().position(|x| *x == id).unwrap();
        assert!(at("accept-a-job-offer") > at("plan-itinerary") - 3);
        assert!(at("accept-a-job-offer") > at("plan-weekly-meals"));
        assert!(page.hits[0].door && page.hits[0].essential);
        assert!(!page.hits[3].door && page.hits[3].essential);
    }

    #[test]
    fn a_plain_need_routes_to_its_front_door_with_specialists_next() {
        let conn = everyday();
        let page = search(&conn, &req("trip"), None).unwrap();
        let route = page.route.as_ref().expect("trip routes");
        assert_eq!(route.to.id, "plan-a-trip");
        assert_eq!(
            route
                .refine
                .iter()
                .map(|h| h.id.as_str())
                .collect::<Vec<_>>(),
            vec!["plan-itinerary", "plan-road-trip"]
        );
        // Neither is listed twice; the rest is basic first.
        assert!(page
            .hits
            .iter()
            .all(|h| h.id != "plan-a-trip" && h.id != "plan-itinerary"));
        assert_eq!(page.hits[0].id, "plan-weekend-trip");
        assert_eq!(page.hits.last().unwrap().depth.as_deref(), Some("advanced"));
        assert!(page.leftover.is_empty());
        assert!(!page.partial);
    }

    #[test]
    fn a_long_sentence_still_answers_with_its_own_words_left_over() {
        let conn = everyday();
        let mut r = req("plan a 5-day trip to Lisbon");
        r.counts = true;
        let page = search(&conn, &r, None).unwrap();
        assert_eq!(page.route.as_ref().unwrap().to.id, "plan-a-trip");
        assert_eq!(page.leftover, vec!["5-day", "Lisbon"]);
        assert!(page.partial, "no entry has every word");
        assert!(!page.hits.is_empty());
        // Rows with more of the words come first.
        assert!(page.hits[0].matched >= page.hits.last().unwrap().matched);
    }

    #[test]
    fn diet_and_lose_weight_reach_the_health_front_door_with_its_advice_label() {
        let conn = everyday();
        for q in ["diet", "lose weight", "Diet"] {
            let page = search(&conn, &req(q), None).unwrap();
            let route = page.route.as_ref().unwrap_or_else(|| panic!("{q} routes"));
            assert_eq!(route.to.id, "eat-healthier", "{q}");
            assert_eq!(route.to.adv, vec!["medical"]);
            // advice_risk read from the body when the row lacks it.
            let loss = route
                .refine
                .iter()
                .find(|h| h.id == "plan-sustainable-weight-loss")
                .unwrap();
            assert_eq!(loss.adv, vec!["medical"]);
        }
        // The niche "news diet" is still found, after the everyday ones.
        let page = search(&conn, &req("diet"), None).unwrap();
        assert_eq!(
            page.hits.last().map(|h| h.id.as_str()),
            Some("audit-news-diet")
        );
        let filtered = search(&conn, &req("adv:medical"), None).unwrap();
        let mut ids: Vec<&str> = filtered.hits.iter().map(|h| h.id.as_str()).collect();
        ids.sort();
        assert_eq!(ids, vec!["eat-healthier", "plan-sustainable-weight-loss"]);
    }

    #[test]
    fn category_labels_and_syn_find_entries_whose_own_words_do_not() {
        let conn = everyday();
        // "nutrition" is only the category's label on eat-healthier.
        let page = search(&conn, &req("nutrition kind:prompt"), None).unwrap();
        let ids = top(&page, 5);
        assert!(ids.contains(&"eat-healthier".to_string()), "{ids:?}");
        let page = search(&conn, &req("getaway"), None).unwrap();
        assert_eq!(top(&page, 1), vec!["plan-a-trip"]);
        let page = search(&conn, &req("code review"), None).unwrap();
        assert_eq!(
            top(&page, 3),
            vec![
                "review-a-pull-request",
                "review-pull-request",
                "code-reviewer"
            ]
        );
    }

    #[test]
    fn an_entry_titled_with_every_word_comes_before_the_front_door() {
        let conn = everyday();
        let page = search(&conn, &req("plan a road trip"), None).unwrap();
        assert_eq!(
            top(&page, 3),
            vec!["plan-road-trip", "plan-a-trip", "plan-itinerary"]
        );
        // Plurals and -ing forms match like hodios-core.
        let page = search(&conn, &req("trips"), None).unwrap();
        assert_eq!(top(&page, 1), vec!["plan-a-trip"]);
        let page = search(&conn, &req("reviewing"), None).unwrap();
        assert!(top(&page, 3).contains(&"review-a-pull-request".to_string()));
        // A front door holding every word stays first.
        let page = search(&conn, &req("plan trip"), None).unwrap();
        assert_eq!(top(&page, 1), vec!["plan-a-trip"]);
        assert!(page.route.unwrap().exact.is_none());
    }

    #[test]
    fn depth_filters_and_counts_follow_the_vocab() {
        let conn = everyday();
        let mut r = req("trip");
        r.counts = true;
        let page = search(&conn, &r, None).unwrap();
        assert_eq!(page.depth_counts["basic"], 2);
        assert_eq!(page.depth_counts["specific"], 2);
        assert_eq!(page.depth_counts["advanced"], 2);
        let adv = search(&conn, &req("trip depth:advanced"), None).unwrap();
        assert!(adv
            .hits
            .iter()
            .all(|h| h.depth.as_deref() == Some("advanced")));
        assert_eq!(adv.hits.len(), 2);
        // A row with no level counts as the middle one.
        let mid = search(&conn, &req("depth:specific"), None).unwrap();
        assert!(mid.hits.iter().any(|h| h.id == "accept-a-job-offer"));
        let doors = search(&conn, &req("ess:door"), None).unwrap();
        assert_eq!(doors.hits.len(), 3);
        let intent = search(&conn, &req("intent:plan topic:travel"), None).unwrap();
        assert!(intent
            .hits
            .iter()
            .all(|h| h.topic.as_deref() == Some("travel")));
        assert!(intent.hits.iter().any(|h| h.id == "plan-road-trip"));
    }

    #[test]
    fn partial_match_without_a_route_hands_back_the_unused_words() {
        let conn = everyday();
        let page = search(&conn, &req("audit lisbon"), None).unwrap();
        assert!(page.route.is_none());
        assert!(page.partial);
        assert_eq!(page.hits[0].id, "audit-news-diet");
        assert_eq!(page.leftover, vec!["lisbon"]);
        // Stop words alone change nothing.
        let page = search(&conn, &req("the trip please"), None).unwrap();
        assert_eq!(page.route.as_ref().unwrap().to.id, "plan-a-trip");
        assert!(!page.partial);
    }

    #[test]
    fn personal_browse_reaches_past_the_first_window() {
        // 400 common rows fill the first window; the traveller's row is last.
        let mut entries: Vec<(String, serde_json::Value)> = (0..400)
            .map(|i| {
                (
                    format!("common-{i:03}"),
                    serde_json::json!({"title": format!("Common {i}"), "q": 90}),
                )
            })
            .collect();
        entries.push((
            "pack-for-a-trip".into(),
            serde_json::json!({"title": "Pack for a trip", "role": ["traveler"], "q": 1}),
        ));
        let refs: Vec<(&str, serde_json::Value, &str)> = entries
            .iter()
            .map(|(a, b)| (a.as_str(), b.clone(), "x"))
            .collect();
        let conn = conn_with(&refs);
        let signals = Signals {
            roles: vec!["traveler".into()],
            ..Default::default()
        };
        let mut r = req("");
        r.limit = Some(20);
        let page = search(&conn, &r, Some(&signals)).unwrap();
        assert_eq!(page.hits[0].id, "pack-for-a-trip");
        assert!(page.hits[0].reasons.iter().any(|x| x.code == "role"));
        assert!(page.hits.len() <= 20);
        // The next page starts where the displaced rows are: none is lost.
        let mut seen: HashSet<String> = page.hits.iter().map(|h| h.id.clone()).collect();
        let mut cursor = page.next_cursor.clone();
        while let Some(c) = cursor {
            let mut next = req("");
            next.limit = Some(50);
            next.cursor = Some(c);
            let p = search(&conn, &next, Some(&signals)).unwrap();
            seen.extend(p.hits.iter().map(|h| h.id.clone()));
            cursor = p.next_cursor;
        }
        assert_eq!(seen.len(), 401);
    }

    #[test]
    fn an_old_catalog_without_the_new_fields_still_searches() {
        let conn = sample();
        let page = search(&conn, &req("flaky"), None).unwrap();
        assert_eq!(page.hits[0].id, "fix-flaky-test");
        assert!(
            page.route.is_none() && page.hits[0].depth.is_none() && page.hits[0].adv.is_empty()
        );
        let mut r = req("test");
        r.counts = true;
        assert!(search(&conn, &r, None).unwrap().depth_counts.is_empty());
        // Every word still must match first; a partial answer only after.
        let page = search(&conn, &req("flaky banana"), None).unwrap();
        assert!(page.partial);
        assert_eq!(page.hits[0].id, "fix-flaky-test");
        assert_eq!(page.leftover, vec!["banana"]);
    }

    #[test]
    fn used_once_is_a_reason() {
        let conn = everyday();
        let signals = Signals {
            used: HashMap::from([("plan-a-trip".to_string(), 1)]),
            ..Default::default()
        };
        let page = search(&conn, &req("trip"), Some(&signals)).unwrap();
        assert!(page
            .route
            .unwrap()
            .to
            .reasons
            .iter()
            .any(|r| r.code == "used" && r.label == "1"));
    }
}
