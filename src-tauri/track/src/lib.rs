//! Feature Tracks (F28): the files are the API.
//!
//! One feature is one `hermes/<slug>` branch, one worktree and one folder,
//! `.hermes/features/<slug>/`, holding `feature.md` (front matter: slug,
//! track, phase, gate, done_when — see docs/adr/004-2.0-contracts.md) and one
//! short markdown file per phase (questions, research, design, structure,
//! plan). A Quick track has no folder at all; Light runs questions, plan and
//! implement; Full runs every phase. Any phase can be skipped.
//!
//! This crate is shared by the `hi` helper (what agents and people run in a
//! terminal) and by the Hermes app (the watcher, the Track view, approvals),
//! so both mutate the files in exactly the same way. It has no dependencies
//! and shells out to `git` only for `land` and `status --all`.

pub mod feature;
pub mod front_matter;
pub mod land;
pub mod phases;
pub mod questions;
pub mod status;

pub use feature::{
    approve, check, create, current_branch, ensure_branch, find_slug, finish_phase, first_prompt,
    list_features, revert_gate, seed_repo_files, skip_phase, start_phase, CreateOutcome,
    FeatureDir, Loaded, Problem, StartOutcome, TrackError,
};
pub use front_matter::{parse, set_keys, FrontMatterError, Parsed};
pub use phases::{next_phase, track_phases, Gate, Phase, Track};
pub use questions::{parse_questions, Question};

/// The environment variable Hermes sets in every agent it launches. `hi
/// approve`, `hi land` and skipping a waiting gate refuse when it is set:
/// approvals come from people. (The app also checks the turn history, so an
/// agent that clears the variable or edits the file by hand is still caught
/// — see the Hermes side.)
pub const AGENT_ENV: &str = "HERMES_AGENT";

/// A `git` command whose messages are in English whatever the user's locale
/// (`LC_ALL` and `LANG` set to `C`, `LANGUAGE` removed): what this crate
/// reports from git reads the same for everyone, and so does what the app
/// matches in it. File names, commit messages and diffs are unaffected.
pub fn git_command() -> std::process::Command {
    let mut cmd = std::process::Command::new("git");
    cmd.env("LC_ALL", "C")
        .env("LANG", "C")
        .env_remove("LANGUAGE");
    cmd
}

/// Where the feature folders live, relative to the worktree root.
pub const FEATURES_DIR: &str = ".hermes/features";
/// Where the per-repository phase prompts live.
pub const PHASES_DIR: &str = ".hermes/phases";
/// The one generated Claude slash command (`/hermes-phase`).
pub const CLAUDE_COMMAND_FILE: &str = ".claude/commands/hermes-phase.md";
/// Where `hi land` keeps the track files of a landed feature.
pub const ARCHIVE_REF_PREFIX: &str = "refs/hermes/archive/";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn git_command_runs_git_in_the_c_locale() {
        let dir = tempfile::tempdir().unwrap();
        // A shell alias prints the environment git itself runs with.
        let out = git_command()
            .arg("-C")
            .arg(dir.path())
            .args(["-c", "alias.hermes-env=!env", "hermes-env"])
            .output()
            .expect("run git");
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        let env = String::from_utf8_lossy(&out.stdout);
        let has = |line: &str| env.lines().any(|l| l.trim_end_matches('\r') == line);
        assert!(has("LC_ALL=C"), "{env}");
        assert!(has("LANG=C"), "{env}");
        assert!(!env.lines().any(|l| l.starts_with("LANGUAGE=")), "{env}");
    }
}
