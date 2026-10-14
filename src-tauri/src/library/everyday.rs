//! Everyday words: the words a search ignores, the routing of plain needs
//! ("trip", "lose weight") to a front door (`queries.json`, compiled from
//! hodios `queries.yml`), and the words of a query the front door did not
//! use ("lisbon", "5-day"), which the UI offers as its answers.

use super::catalog::Row;
use super::search::{text_match, words};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Words that carry no need on their own ("plan a trip to lisbon" is
/// "plan trip lisbon"): hodios-core `STOP_WORDS`, sorted.
pub const STOP_WORDS: &[&str] = &[
    "a", "about", "am", "an", "and", "any", "are", "as", "at", "be", "been", "but", "by", "can",
    "could", "did", "do", "does", "for", "from", "give", "help", "here", "how", "i", "i'd", "i'm",
    "i've", "id", "im", "in", "into", "is", "it", "its", "ive", "just", "let", "let's", "lets",
    "may", "me", "might", "mine", "must", "my", "need", "needs", "of", "on", "onto", "or", "our",
    "over", "please", "shall", "should", "show", "so", "some", "tell", "that", "the", "there",
    "these", "this", "those", "to", "under", "us", "very", "wanna", "want", "was", "we", "what",
    "when", "where", "which", "who", "whom", "whose", "why", "will", "with", "would", "you",
    "your", "yours",
];

pub fn is_stop(word: &str) -> bool {
    STOP_WORDS.binary_search(&word).is_ok()
}

/// The terms of a query that carry meaning: a term that is a single stop
/// word is dropped (hodios-core; "how to" keeps nothing, so it browses).
pub fn content_terms(terms: &[String]) -> Vec<String> {
    terms
        .iter()
        .filter(|t| {
            let w = words(t);
            !w.is_empty() && !(w.len() == 1 && is_stop(&w[0]))
        })
        .cloned()
        .collect()
}

/// hodios-core `stemWord`: one common suffix off, then a doubled last
/// letter ("planning" -> "plan", "trips" -> "trip", "stories" -> "story").
pub fn stem_word(word: &str) -> String {
    let mut w = word.to_lowercase();
    for s in ["ings", "ing", "ers", "er", "ies", "es", "s", "ed"] {
        if w.chars().count() > s.len() + 2 && w.ends_with(s) {
            w.truncate(w.len() - s.len());
            if s == "ies" {
                w.push('y');
            }
            break;
        }
    }
    let chars: Vec<char> = w.chars().collect();
    if chars.len() >= 2 && chars[chars.len() - 1] == chars[chars.len() - 2] {
        w.pop();
    }
    w
}

/// One everyday need: the phrases people type, the front door they lead
/// to and the specialists to narrow to.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Route {
    pub to: String,
    #[serde(default)]
    pub phrases: Vec<String>,
    #[serde(default)]
    pub refine: Vec<String>,
}

fn strings(v: Option<&Value>) -> Vec<String> {
    match v {
        Some(Value::Array(a)) => a
            .iter()
            .filter_map(|x| x.as_str().map(str::to_string))
            .collect(),
        Some(Value::String(s)) => vec![s.clone()],
        _ => Vec::new(),
    }
}

fn route_of(v: &Value) -> Option<Route> {
    let to = v.get("to").or_else(|| v.get("id"))?.as_str()?.to_string();
    Some(Route {
        to,
        phrases: strings(v.get("phrases").or_else(|| v.get("phrase"))),
        refine: strings(v.get("refine")),
    })
}

/// `queries.json` in any of the shapes a catalog may use: a list of
/// routes, `{ routes | queries | needs: [...] }`, or a map of
/// `phrase -> to` / `phrase -> { to, refine }`. Unreadable parts are skipped.
pub fn parse_routes(v: &Value) -> Vec<Route> {
    let list = match v {
        Value::Array(a) => Some(a),
        Value::Object(o) => ["routes", "queries", "needs"]
            .iter()
            .find_map(|k| o.get(*k).and_then(Value::as_array)),
        _ => None,
    };
    if let Some(list) = list {
        return list.iter().filter_map(route_of).collect();
    }
    let Some(map) = v
        .get("phrases")
        .and_then(Value::as_object)
        .or_else(|| v.as_object())
    else {
        return Vec::new();
    };
    let mut out: Vec<Route> = Vec::new();
    for (phrase, target) in map {
        let (to, refine) = match target {
            Value::String(s) => (s.clone(), Vec::new()),
            Value::Object(_) => match target.get("to").and_then(Value::as_str) {
                Some(to) => (to.to_string(), strings(target.get("refine"))),
                None => continue,
            },
            _ => continue,
        };
        match out.iter_mut().find(|r| r.to == to) {
            Some(r) => {
                r.phrases.push(phrase.clone());
                for x in refine {
                    if !r.refine.contains(&x) {
                        r.refine.push(x);
                    }
                }
            }
            None => out.push(Route {
                to,
                phrases: vec![phrase.clone()],
                refine,
            }),
        }
    }
    out
}

/// The routed need of a query.
#[derive(Debug, Clone, PartialEq)]
pub struct Routed<'a> {
    pub route: &'a Route,
    pub phrase: String,
    /// Positions (in the query's words) the phrase covered.
    pub covered: Vec<usize>,
}

/// The route whose phrase appears in the query (as whole words, in order);
/// the longest phrase wins, then the earlier route.
pub fn route<'a>(query: &str, routes: &'a [Route]) -> Option<Routed<'a>> {
    let q: Vec<String> = text_words(query).iter().map(|w| stem_word(w)).collect();
    if q.is_empty() {
        return None;
    }
    let mut best: Option<Routed<'a>> = None;
    for r in routes {
        for phrase in &r.phrases {
            let p: Vec<String> = words(phrase).iter().map(|w| stem_word(w)).collect();
            if p.is_empty() || p.len() > q.len() {
                continue;
            }
            let Some(at) = (0..=q.len() - p.len()).find(|&i| q[i..i + p.len()] == p[..]) else {
                continue;
            };
            if best.as_ref().is_none_or(|b| p.len() > b.covered.len()) {
                best = Some(Routed {
                    route: r,
                    phrase: phrase.clone(),
                    covered: (at..at + p.len()).collect(),
                });
            }
        }
    }
    best
}

/// The words of the free text of a query (`key:value` filters left out).
fn text_words(query: &str) -> Vec<String> {
    query
        .split_whitespace()
        .filter(|t| !is_filter(t))
        .flat_map(words)
        .collect()
}

fn is_filter(token: &str) -> bool {
    token.split_once(':').is_some_and(|(k, v)| {
        !k.is_empty() && !v.is_empty() && k.bytes().all(|b| b.is_ascii_lowercase())
    })
}

/// The terms of the query (as typed, outer punctuation trimmed, stop
/// words out) that `row` — the best match — does not match: what the
/// person said about their own case ("5-day", "Lisbon"). hodios-core
/// `leftover`.
pub fn leftover(query: &str, row: &Row, extra: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    for token in query.split_whitespace() {
        if is_filter(token) {
            continue;
        }
        let term = token.to_lowercase();
        if content_terms(std::slice::from_ref(&term)).is_empty() {
            continue;
        }
        if text_match(row, std::slice::from_ref(&term), extra).matched > 0 {
            continue;
        }
        let clean = token.trim_matches(|c: char| !c.is_alphanumeric());
        if !clean.is_empty() {
            out.push(clean.to_string());
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn trip() -> Vec<Route> {
        vec![
            Route {
                to: "plan-a-trip".into(),
                phrases: vec!["trip".into(), "vacation".into(), "city break".into()],
                refine: vec!["plan-itinerary".into()],
            },
            Route {
                to: "eat-healthier".into(),
                phrases: vec!["diet".into(), "lose weight".into(), "eat healthier".into()],
                refine: vec![],
            },
        ]
    }

    #[test]
    fn stop_words_are_sorted_for_binary_search() {
        let mut sorted = STOP_WORDS.to_vec();
        sorted.sort();
        assert_eq!(sorted, STOP_WORDS);
    }

    #[test]
    fn drops_stop_words_but_never_everything() {
        let t = |q: &str| q.split_whitespace().map(str::to_string).collect::<Vec<_>>();
        assert_eq!(
            content_terms(&t("plan a 5-day trip to lisbon")),
            t("plan 5-day trip lisbon")
        );
        assert!(content_terms(&t("how to")).is_empty());
        assert_eq!(content_terms(&t("i'm")), t("i'm"));
    }

    #[test]
    fn stems_like_hodios_core() {
        for (w, s) in [
            ("trips", "trip"),
            ("planning", "plan"),
            ("stories", "story"),
            ("travellers", "travel"),
            ("holidays", "holiday"),
            ("bus", "bus"),
            ("weight", "weight"),
        ] {
            assert_eq!(stem_word(w), s, "{w}");
        }
    }

    #[test]
    fn routes_plain_words_and_plurals_longest_phrase_first() {
        let routes = trip();
        assert_eq!(route("trip", &routes).unwrap().route.to, "plan-a-trip");
        assert_eq!(route("Trips", &routes).unwrap().route.to, "plan-a-trip");
        assert_eq!(
            route("plan a 5-day trip to lisbon", &routes)
                .unwrap()
                .route
                .to,
            "plan-a-trip"
        );
        let lw = route("how do I lose weight", &routes).unwrap();
        assert_eq!(
            (lw.route.to.as_str(), lw.covered.len()),
            ("eat-healthier", 2)
        );
        assert!(route("weight", &routes).is_none());
        assert!(route("code review", &routes).is_none());
        // A filter is not text.
        assert!(route("kind:trip", &routes).is_none());
    }

    #[test]
    fn reads_every_queries_json_shape() {
        let list = serde_json::json!([{ "to": "a", "phrases": ["x"], "refine": ["b"] }]);
        let wrapped = serde_json::json!({ "schema": 1, "routes": [{ "to": "a", "phrases": ["x"], "refine": ["b"] }] });
        let map = serde_json::json!({ "phrases": { "x": { "to": "a", "refine": ["b"] } } });
        let flat = serde_json::json!({ "x": "a" });
        let want = vec![Route {
            to: "a".into(),
            phrases: vec!["x".into()],
            refine: vec!["b".into()],
        }];
        assert_eq!(parse_routes(&list), want);
        assert_eq!(parse_routes(&wrapped), want);
        assert_eq!(parse_routes(&map), want);
        assert_eq!(parse_routes(&flat)[0].to, "a");
        assert!(parse_routes(&serde_json::json!(3)).is_empty());
    }

    #[test]
    fn leftover_words_are_the_person_s_own() {
        let row = Row {
            id: "plan-a-trip".into(),
            title: "Plan a trip".into(),
            syn: vec!["travel".into(), "vacation".into()],
            ..Default::default()
        };
        let q = "plan a 5-day trip to Lisbon";
        assert_eq!(leftover(q, &row, &[]), vec!["5-day", "Lisbon"]);
        assert!(leftover("trips", &row, &[]).is_empty());
        assert_eq!(
            leftover("vacation in Rome, please", &row, &[]),
            vec!["Rome"]
        );
    }
}
