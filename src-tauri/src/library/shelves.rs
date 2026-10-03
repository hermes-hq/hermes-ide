//! "For you": the Library's first screen. Never the whole catalog — a few
//! shelves of at most 12 cards, each with the reason it is there — built
//! on the device from the project's detected stack, the installed agents,
//! the focused session's agent, the person's chosen role and interests,
//! their recent use and the active Track phase (hodios TAXONOMY.md §8).
//! "Show everything" turns all of it off: plain quality order.

use super::catalog::Vocab;
use super::search::{self, Hit, Reason, Signals};
use super::store::{self, facet_token, CatalogInfo};
use super::user_state::{Profile, UseSignals};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

pub const SHELF_SIZE: usize = 12;

/// Until hermes-hq/hodios publishes the `hermes-default` pack (plan P3):
/// the entries a person with no profile and no project starts from.
pub const DEFAULT_PACK: &[&str] = &[
    "review-pull-request",
    "find-root-cause",
    "write-unit-tests",
    "write-commit-message",
    "write-pr-description",
    "explain-stack-trace",
    "fix-flaky-test",
    "write-implementation-plan",
    "resolve-merge-conflict",
    "self-review-before-pr",
    "simplify-function",
    "write-readme",
];

/// Stack values that make a folder a software project.
const CODE_STACK: &[&str] = &[
    "javascript",
    "typescript",
    "python",
    "go",
    "rust",
    "java",
    "kotlin",
    "csharp",
    "cpp",
    "c",
    "ruby",
    "php",
    "swift",
    "dart",
    "elixir",
    "scala",
    "bash",
    "powershell",
    "sql",
    "lua",
    "haskell",
    "zig",
    "solidity",
    "html-css",
    "nodejs",
    "deno",
    "bun",
    "dotnet",
];

/// What the UI knows about the moment (never stored, never sent).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Context {
    /// The focused session's project folder.
    pub project_path: Option<String>,
    /// Target ids of the agents installed here (claude-code, codex, ...).
    pub works: Vec<String>,
    /// Target id of the focused session's agent.
    pub active_work: Option<String>,
    /// The active Feature Track phase (a `stage` value), if any.
    pub stage: Option<String>,
    /// "Show everything": no personal signals at all.
    pub show_everything: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Labeled {
    pub value: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Shelf {
    /// project | role | continue | now | new | start
    pub id: String,
    pub hits: Vec<Hit>,
    /// What the shelf is built from, for its heading ("React, TypeScript").
    pub because: Vec<Labeled>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DomainCount {
    pub id: String,
    pub label: String,
    pub count: i64,
    pub mine: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Shelves {
    pub shelves: Vec<Shelf>,
    pub personalised: bool,
    pub stack: Vec<Labeled>,
    pub project_agents: Vec<String>,
    pub profile: Profile,
    pub domains: Vec<DomainCount>,
    pub catalog: Option<CatalogInfo>,
}

/// The ranking signals of this moment.
pub fn signals(
    profile: &Profile,
    uses: &UseSignals,
    affinity: Vec<(String, String, f64)>,
    stack: &[String],
    ctx: &Context,
) -> Signals {
    let mut stack: Vec<String> = stack.to_vec();
    stack.extend(profile.stack.iter().cloned());
    stack.sort();
    stack.dedup();
    Signals {
        stack,
        works: ctx.works.clone(),
        active_work: ctx.active_work.clone(),
        roles: profile.roles.clone(),
        domains: profile.domains.clone(),
        categories: profile.categories.clone(),
        subjects: profile.subjects.clone(),
        stage: ctx.stage.clone(),
        level: profile.level.clone(),
        affinity,
        used: uses.used.clone(),
        pinned: uses.pinned.clone(),
        hidden: uses.hidden.clone(),
    }
}

/// Rows carrying any of `tokens` (facet tokens, OR'd), boosted and reasoned.
/// Stable entries come before incubating ones (plan §15.6: shelves show
/// `experimental`+ first, then `incubating` with a badge).
fn shelf_from_tokens(
    conn: &Connection,
    tokens: &[String],
    s: &Signals,
    exclude: &HashSet<String>,
) -> Vec<Hit> {
    if tokens.is_empty() {
        return Vec::new();
    }
    let expr = format!(
        "f : ({})",
        tokens
            .iter()
            .map(|t| format!("\"{t}\""))
            .collect::<Vec<_>>()
            .join(" OR ")
    );
    let Ok(mut stmt) = conn.prepare_cached(
        "SELECT e.rowid, e.row FROM entry_fts JOIN entry e ON e.rowid = entry_fts.rowid
         WHERE entry_fts MATCH ?1 ORDER BY entry_fts.rowid LIMIT ?2",
    ) else {
        return Vec::new();
    };
    let rows: Vec<(i64, super::catalog::Row)> = stmt
        .query_map(rusqlite::params![expr, search::CANDIDATES as i64], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
        })
        .map(|it| {
            it.filter_map(Result::ok)
                .filter_map(|(id, raw)| Some((id, serde_json::from_str(&raw).ok()?)))
                .collect()
        })
        .unwrap_or_default();
    let vocab = store::vocab(conn);
    let new_ids: HashSet<String> = store::new_ids(conn).into_iter().collect();
    let mut hits = search::rank(rows, &[], &[], Some(s), &vocab, "you", &new_ids, false);
    hits.retain(|h| !exclude.contains(&h.id));
    for h in hits.iter_mut() {
        if h.status != "incubating" {
            h.score += 0.5;
        }
    }
    hits.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.rank.cmp(&b.rank))
    });
    hits.truncate(SHELF_SIZE);
    hits
}

fn labeled(vocab: &Vocab, facet: &str, values: &[String]) -> Vec<Labeled> {
    values
        .iter()
        .map(|v| Labeled {
            value: v.clone(),
            label: vocab.label(facet, v).to_string(),
        })
        .collect()
}

fn add_agent_reason(hits: &mut [Hit], active: Option<&str>) {
    let Some(active) = active else { return };
    for h in hits.iter_mut() {
        if h.works.iter().any(|w| w == active) && !h.reasons.iter().any(|r| r.code == "agent") {
            h.reasons.push(Reason {
                code: "agent",
                value: active.to_string(),
                label: active.to_string(),
            });
        }
    }
}

/// Builds the shelves. `stack` is the detected stack of `ctx.project_path`.
pub fn build(
    conn: &Connection,
    profile: Profile,
    uses: &UseSignals,
    affinity: Vec<(String, String, f64)>,
    stack: Vec<String>,
    project_agents: Vec<String>,
    ctx: &Context,
) -> Shelves {
    let vocab = store::vocab(conn);
    let personalised = !ctx.show_everything && profile.personalise_on();
    let s = if personalised {
        signals(&profile, uses, affinity, &stack, ctx)
    } else {
        Signals {
            hidden: uses.hidden.clone(),
            ..Default::default()
        }
    };
    let mut shelves = Vec::new();
    let mut shown: HashSet<String> = HashSet::new();
    let push = |shelves: &mut Vec<Shelf>, shown: &mut HashSet<String>, shelf: Shelf| {
        if !shelf.hits.is_empty() {
            shown.extend(shelf.hits.iter().map(|h| h.id.clone()));
            shelves.push(shelf);
        }
    };

    if personalised {
        // 1. For this project: its stack (and what it implies), then the
        //    software work any code project has, for the agents here.
        let is_code = stack.iter().any(|v| CODE_STACK.contains(&v.as_str()))
            || stack.iter().any(|v| {
                vocab
                    .implies_of("stack", v)
                    .iter()
                    .any(|i| CODE_STACK.contains(&i.as_str()))
            });
        if ctx.project_path.is_some() && !stack.is_empty() {
            let mut tokens: Vec<String> = stack
                .iter()
                .flat_map(|v| vocab.implies_of("stack", v))
                .map(|v| facet_token('s', &v))
                .collect();
            if is_code {
                tokens.push(facet_token('d', "software-engineering"));
            }
            tokens.sort();
            tokens.dedup();
            let mut hits = shelf_from_tokens(conn, &tokens, &s, &shown);
            // An entry for another stack (C# rules in a React project) does
            // not fit this project, however good it is: search still finds it.
            let here: HashSet<String> = stack
                .iter()
                .flat_map(|v| vocab.implies_of("stack", v))
                .chain(stack.iter().cloned())
                .collect();
            hits.retain(|h| h.stack.is_empty() || h.stack.iter().any(|v| here.contains(v)));
            add_agent_reason(&mut hits, ctx.active_work.as_deref());
            push(
                &mut shelves,
                &mut shown,
                Shelf {
                    id: "project".into(),
                    hits,
                    because: labeled(&vocab, "stack", &stack),
                },
            );
        }
        // 2. For your role and interests.
        let mut tokens: Vec<String> = Vec::new();
        tokens.extend(profile.roles.iter().map(|v| facet_token('r', v)));
        tokens.extend(profile.domains.iter().map(|v| facet_token('d', v)));
        tokens.extend(profile.categories.iter().map(|v| facet_token('c', v)));
        tokens.extend(profile.subjects.iter().map(|v| facet_token('j', v)));
        if !tokens.is_empty() {
            let hits = shelf_from_tokens(conn, &tokens, &s, &shown);
            let mut because = labeled(&vocab, "role", &profile.roles);
            because.extend(labeled(&vocab, "domain", &profile.domains));
            because.extend(labeled(&vocab, "category", &profile.categories));
            because.extend(labeled(&vocab, "subject", &profile.subjects));
            push(
                &mut shelves,
                &mut shown,
                Shelf {
                    id: "role".into(),
                    hits,
                    because,
                },
            );
        }
        // 3. Right now: the Track phase.
        if let Some(stage) = &ctx.stage {
            let mut tokens = vec![facet_token('g', stage)];
            tokens.retain(|t| t.len() > 1);
            let hits: Vec<Hit> = shelf_from_tokens(conn, &tokens, &s, &shown)
                .into_iter()
                .filter(|h| h.domain == "software-engineering")
                .take(6)
                .collect();
            push(
                &mut shelves,
                &mut shown,
                Shelf {
                    id: "now".into(),
                    hits,
                    because: labeled(&vocab, "stage", std::slice::from_ref(stage)),
                },
            );
        }
    }
    // 4. Continue: pinned and recently used (shown even with personalisation off).
    let mut cont = search::hits_for_ids(conn, &uses.continue_ids, &s);
    cont.truncate(SHELF_SIZE);
    push(
        &mut shelves,
        &mut Default::default(),
        Shelf {
            id: "continue".into(),
            hits: cont,
            because: Vec::new(),
        },
    );
    // 5. New and updated since the last catalog update.
    let mut fresh = search::hits_for_ids(conn, &store::new_ids(conn), &s);
    fresh.truncate(SHELF_SIZE);
    push(
        &mut shelves,
        &mut shown,
        Shelf {
            id: "new".into(),
            hits: fresh,
            because: Vec::new(),
        },
    );
    // 6. A place to start: nothing personal yet (or show everything).
    let has_personal = shelves
        .iter()
        .any(|sh| sh.id == "project" || sh.id == "role");
    if !has_personal {
        let ids: Vec<String> =
            match store::manifest(conn).and_then(|m| m.packs.get("hermes-default").cloned()) {
                // A published pack would be read here; until then the fallback list.
                Some(_) | None => DEFAULT_PACK.iter().map(|s| s.to_string()).collect(),
            };
        let mut start = search::hits_for_ids(conn, &ids, &s);
        if !personalised {
            for h in start.iter_mut() {
                h.reasons.clear();
            }
        }
        add_agent_reason(
            &mut start,
            if personalised {
                ctx.active_work.as_deref()
            } else {
                None
            },
        );
        push(
            &mut shelves,
            &mut shown,
            Shelf {
                id: "start".into(),
                hits: start,
                because: Vec::new(),
            },
        );
    }

    let mine: HashSet<&String> = profile.domains.iter().collect();
    let domains = store::domain_counts(conn)
        .into_iter()
        .map(|(id, count)| DomainCount {
            label: vocab.label("domain", &id).to_string(),
            mine: mine.contains(&id),
            id,
            count,
        })
        .collect();
    Shelves {
        shelves,
        personalised,
        stack: labeled(&vocab, "stack", &stack),
        project_agents,
        profile,
        domains,
        catalog: store::info(conn),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::search::tests::conn_with;
    use std::collections::HashMap;

    fn uses() -> UseSignals {
        UseSignals {
            pinned: HashSet::new(),
            hidden: HashSet::new(),
            used: HashMap::new(),
            continue_ids: Vec::new(),
        }
    }

    fn conn() -> Connection {
        conn_with(&[
            (
                "write-component-tests",
                serde_json::json!({"stack": ["react"], "role": ["frontend-engineer"], "title": "Write tests for a React component", "status": "experimental"}),
                "x",
            ),
            (
                "typescript-strict-rules",
                serde_json::json!({"kind": "rule", "stack": ["typescript"], "title": "TypeScript strict rules"}),
                "x",
            ),
            (
                "find-root-cause",
                serde_json::json!({"cat": "debugging", "title": "Find the root cause"}),
                "x",
            ),
            (
                "review-pull-request",
                serde_json::json!({"cat": "code-review", "title": "Review a pull request", "stage": ["review"]}),
                "x",
            ),
            (
                "python-lint",
                serde_json::json!({"stack": ["python"], "title": "Lint Python"}),
                "x",
            ),
            (
                "summarize-notes",
                serde_json::json!({"cat": "editing", "dom": "writing", "title": "Summarize notes"}),
                "x",
            ),
        ])
    }

    fn ctx() -> Context {
        Context {
            project_path: Some("/p".into()),
            works: vec!["claude-code".into(), "codex".into()],
            active_work: Some("claude-code".into()),
            ..Default::default()
        }
    }

    #[test]
    fn a_typescript_react_project_leads_with_its_stack() {
        let c = conn();
        let sh = build(
            &c,
            Profile::default(),
            &uses(),
            vec![],
            vec!["react".into(), "typescript".into()],
            vec![],
            &ctx(),
        );
        let project = &sh.shelves[0];
        assert_eq!(project.id, "project");
        let first_two: HashSet<&str> = project.hits[..2].iter().map(|h| h.id.as_str()).collect();
        assert_eq!(
            first_two,
            HashSet::from(["write-component-tests", "typescript-strict-rules"])
        );
        assert!(project.hits[0].reasons.iter().any(|r| r.code == "stack"));
        assert!(project
            .hits
            .iter()
            .all(|h| h.domain == "software-engineering"));
        assert!(!project.hits.iter().any(|h| h.id == "summarize-notes"));
        // Entries for another stack stay off this project's shelf.
        assert!(project.hits.iter().all(|h| h.stack.is_empty()
            || h.stack
                .iter()
                .any(|v| v == "react" || v == "typescript" || v == "javascript")));
        assert_eq!(
            project
                .because
                .iter()
                .map(|b| b.label.as_str())
                .collect::<Vec<_>>(),
            vec!["React", "TypeScript"]
        );
    }

    #[test]
    fn a_python_project_gets_a_different_shelf() {
        let c = conn();
        let sh = build(
            &c,
            Profile::default(),
            &uses(),
            vec![],
            vec!["python".into()],
            vec![],
            &ctx(),
        );
        assert_eq!(sh.shelves[0].hits[0].id, "python-lint");
    }

    #[test]
    fn role_shelf_continue_and_cold_start() {
        let c = conn();
        let profile = Profile {
            roles: vec!["frontend-engineer".into()],
            domains: vec!["writing".into()],
            ..Default::default()
        };
        let mut u = uses();
        u.pinned.insert("find-root-cause".into());
        u.continue_ids = vec!["find-root-cause".into()];
        let sh = build(&c, profile, &u, vec![], vec![], vec![], &Context::default());
        let ids: Vec<&str> = sh.shelves.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, vec!["role", "continue"]);
        assert!(sh.domains.iter().any(|d| d.id == "writing" && d.mine));
        // Nothing personal: a place to start.
        let cold = build(
            &c,
            Profile::default(),
            &uses(),
            vec![],
            vec![],
            vec![],
            &Context::default(),
        );
        assert_eq!(cold.shelves[0].id, "start");
        assert!(cold.shelves[0]
            .hits
            .iter()
            .any(|h| h.id == "review-pull-request"));
    }

    #[test]
    fn show_everything_drops_personal_shelves_and_reasons() {
        let c = conn();
        let mut x = ctx();
        x.show_everything = true;
        let sh = build(
            &c,
            Profile::default(),
            &uses(),
            vec![],
            vec!["react".into()],
            vec![],
            &x,
        );
        assert!(!sh.personalised);
        assert!(sh.shelves.iter().all(|s| s.id != "project"));
        assert!(sh
            .shelves
            .iter()
            .all(|s| s.hits.iter().all(|h| h.reasons.is_empty())));
    }

    #[test]
    fn track_phase_shelf() {
        let c = conn();
        let mut x = ctx();
        x.stage = Some("review".into());
        let sh = build(&c, Profile::default(), &uses(), vec![], vec![], vec![], &x);
        let now = sh.shelves.iter().find(|s| s.id == "now").unwrap();
        assert_eq!(now.hits[0].id, "review-pull-request");
        assert!(now.hits[0].reasons.iter().any(|r| r.code == "stage"));
    }
}
