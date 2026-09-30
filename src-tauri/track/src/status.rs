//! `hi status [--all]`: plain text, readable over SSH.

use std::fs;
use std::path::{Path, PathBuf};

use crate::feature::{check, current_branch, list_features, FeatureDir, TrackError};
use crate::phases::{Gate, Phase};
use crate::questions::blocking_open;

/// One feature's state, for people and for the tests.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FeatureStatus {
    pub worktree: PathBuf,
    pub slug: String,
    pub track: String,
    pub phase: String,
    pub gate: String,
    pub blocking_questions: Vec<String>,
    pub problems: Vec<String>,
    /// feature.md could not be read; the line says why.
    pub error: Option<String>,
}

impl FeatureStatus {
    /// Something a person has to do before the agent can go on.
    pub fn blocked(&self) -> bool {
        self.gate == "waiting" || !self.blocking_questions.is_empty() || self.error.is_some()
    }
}

pub fn feature_status(root: &Path, slug: &str) -> FeatureStatus {
    let feature = FeatureDir::new(root, slug);
    match feature.load() {
        Ok(loaded) => {
            let questions = feature
                .phase_file(Phase::Questions)
                .and_then(|p| fs::read_to_string(p).ok())
                .unwrap_or_default();
            FeatureStatus {
                worktree: root.to_path_buf(),
                slug: slug.to_string(),
                track: loaded.meta.track.as_str().to_string(),
                phase: loaded.meta.phase.as_str().to_string(),
                gate: loaded.meta.gate.as_str().to_string(),
                blocking_questions: if loaded.meta.gate == Gate::None
                    && loaded.meta.phase == Phase::Done
                {
                    Vec::new()
                } else {
                    blocking_open(&questions)
                        .into_iter()
                        .map(|q| q.text)
                        .collect()
                },
                problems: check(root, slug)
                    .into_iter()
                    .map(|p| format!("{}: {}", p.file, p.message))
                    .collect(),
                error: None,
            }
        }
        Err(e) => FeatureStatus {
            worktree: root.to_path_buf(),
            slug: slug.to_string(),
            track: String::new(),
            phase: String::new(),
            gate: String::new(),
            blocking_questions: Vec::new(),
            problems: Vec::new(),
            error: Some(match e {
                TrackError::FrontMatter { message, line, .. } => {
                    format!("feature.md can't be read (line {line}): {message}")
                }
                other => other.to_string(),
            }),
        },
    }
}

/// Every worktree of the repository `root` belongs to (itself included);
/// just `root` when it is not a git repository.
pub fn worktrees(root: &Path) -> Vec<PathBuf> {
    let out = crate::git_command()
        .arg("-C")
        .arg(root)
        .args(["worktree", "list", "--porcelain"])
        .output();
    let mut list: Vec<PathBuf> = match out {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout)
            .lines()
            .filter_map(|l| l.strip_prefix("worktree "))
            .map(PathBuf::from)
            .collect(),
        _ => Vec::new(),
    };
    if list.is_empty() {
        list.push(root.to_path_buf());
    }
    list
}

pub fn statuses(root: &Path, all: bool) -> Vec<FeatureStatus> {
    let roots = if all {
        worktrees(root)
    } else {
        vec![root.to_path_buf()]
    };
    let mut out = Vec::new();
    for wt in roots {
        for slug in list_features(&wt) {
            out.push(feature_status(&wt, &slug));
        }
    }
    out
}

/// The text `hi status` prints.
pub fn render(root: &Path, all: bool) -> String {
    let list = statuses(root, all);
    let mut text = String::new();
    if list.is_empty() {
        let branch = current_branch(root);
        text.push_str("no feature here");
        if let Some(b) = branch {
            text.push_str(&format!(" (branch {b})"));
        }
        text.push_str("; start one with `hi feature new <slug> --track Light|Full`\n");
        return text;
    }
    for s in &list {
        let where_ = if all {
            format!("  {}", s.worktree.display())
        } else {
            String::new()
        };
        match &s.error {
            Some(e) => text.push_str(&format!("{:<20} {e}{where_}\n", s.slug)),
            None => text.push_str(&format!(
                "{:<20} {:<6} {:<10} gate: {}{where_}\n",
                s.slug, s.track, s.phase, s.gate
            )),
        }
    }
    let blocked: Vec<&FeatureStatus> = list.iter().filter(|s| s.blocked()).collect();
    if !blocked.is_empty() {
        text.push_str("\nBlocked on you:\n");
        for s in blocked {
            if s.gate == "waiting" {
                text.push_str(&format!(
                    "  ◆ {}: {} is ready for review (hi approve)\n",
                    s.slug, s.phase
                ));
            }
            for q in &s.blocking_questions {
                text.push_str(&format!("  ◆ {}: question — {q}\n", s.slug));
            }
            if let Some(e) = &s.error {
                text.push_str(&format!("  ! {}: {e}\n", s.slug));
            }
        }
    }
    let problems: Vec<(&str, &String)> = list
        .iter()
        .flat_map(|s| s.problems.iter().map(move |p| (s.slug.as_str(), p)))
        .collect();
    if !problems.is_empty() {
        text.push_str("\nProblems:\n");
        for (slug, p) in problems {
            text.push_str(&format!("  {slug}: {p}\n"));
        }
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::feature::{create, finish_phase, start_phase};
    use crate::phases::Track;

    #[test]
    fn status_lists_features_and_what_blocks_a_person() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        assert!(render(root, false).starts_with("no feature here"));
        create(root, "alpha", Track::Light, "", "").unwrap();
        start_phase(root, "alpha", None).unwrap();
        fs::write(
            root.join(".hermes/features/alpha/questions.md"),
            "- [ ] ! Which engine?\n- [ ] Colour?\n",
        )
        .unwrap();
        finish_phase(root, "alpha").unwrap();
        create(root, "beta", Track::Full, "", "").unwrap();
        fs::write(
            root.join(".hermes/features/beta/feature.md"),
            "---\nslug: beta\n---\n",
        )
        .unwrap();

        let text = render(root, false);
        assert!(
            text.contains("alpha                Light  questions  gate: waiting"),
            "{text}"
        );
        assert!(
            text.contains("◆ alpha: questions is ready for review (hi approve)"),
            "{text}"
        );
        assert!(text.contains("◆ alpha: question — Which engine?"), "{text}");
        assert!(
            !text.contains("Colour?"),
            "only blocking questions are listed"
        );
        assert!(
            text.contains(
                "beta                 feature.md can't be read (line 1): track is required"
            ),
            "{text}"
        );
        let all = statuses(root, true);
        assert_eq!(all.len(), 2);
        assert!(all[0].blocked() && all[1].blocked());
    }
}
