//! Every `git` process Hermes starts is made here.
//!
//! Hermes reads what git prints: it matches messages such as "not a git
//! repository" or "is already checked out at", and the frontend does the
//! same with the errors it is handed. git translates those messages into the
//! user's language (a German locale turns "not a git repository" into "Kein
//! Git-Repository"), so every git Hermes runs gets the C locale: `LC_ALL`
//! and `LANG` set to `C`, and `LANGUAGE` removed (GNU gettext would honour it
//! over the others).
//!
//! Only the messages change. File names, commit messages and diffs are bytes
//! to git and come out the same in any locale.

use std::process::Command;

/// A `git` command whose messages are in English whatever the user's locale.
pub fn git_command() -> Command {
    let mut cmd = Command::new("git");
    force_c_locale(&mut cmd);
    cmd
}

/// Give `cmd` the C locale (see the module docs).
pub fn force_c_locale(cmd: &mut Command) -> &mut Command {
    if keep_user_locale_for_tests() {
        return cmd;
    }
    cmd.env("LC_ALL", "C")
        .env("LANG", "C")
        .env_remove("LANGUAGE")
}

/// Test builds only: `HERMES_E2E_GIT_USER_LOCALE=1` (with `HERMES_E2E=1`)
/// leaves git in the user's locale, so the real-app scenario can show what
/// the C locale prevents (its negative control).
fn keep_user_locale_for_tests() -> bool {
    #[cfg(feature = "e2e")]
    {
        parse_user_locale_override(
            std::env::var("HERMES_E2E").ok().as_deref(),
            std::env::var("HERMES_E2E_GIT_USER_LOCALE").ok().as_deref(),
        )
    }
    #[cfg(not(feature = "e2e"))]
    {
        false
    }
}

#[cfg(any(test, feature = "e2e"))]
fn parse_user_locale_override(e2e: Option<&str>, value: Option<&str>) -> bool {
    crate::e2e_protocol::is_enabled(e2e) && value.map(str::trim) == Some("1")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    /// What a git process started from `cmd` sees in its environment: a
    /// shell alias prints it, so this is git's own view, not the Command's.
    fn env_seen_by_git(mut cmd: Command, dir: &Path) -> String {
        let out = cmd
            .arg("-C")
            .arg(dir)
            .args(["-c", "alias.hermes-env=!env", "hermes-env"])
            .output()
            .expect("run git");
        assert!(
            out.status.success(),
            "git alias failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    /// A git command set up the way a German user's environment would pass it on.
    fn german(mut cmd: Command) -> Command {
        cmd.env("LANG", "de_DE.UTF-8")
            .env("LC_ALL", "de_DE.UTF-8")
            .env("LC_MESSAGES", "de_DE.UTF-8")
            .env("LANGUAGE", "de");
        cmd
    }

    fn has_line(env: &str, line: &str) -> bool {
        env.lines().any(|l| l.trim_end_matches('\r') == line)
    }

    #[test]
    fn git_runs_in_the_c_locale_even_when_the_user_s_locale_is_german() {
        let dir = tempfile::tempdir().unwrap();
        let mut cmd = german(Command::new("git"));
        force_c_locale(&mut cmd);
        let env = env_seen_by_git(cmd, dir.path());
        assert!(has_line(&env, "LC_ALL=C"), "LC_ALL is not C:\n{env}");
        assert!(has_line(&env, "LANG=C"), "LANG is not C:\n{env}");
        assert!(
            !env.lines().any(|l| l.starts_with("LANGUAGE=")),
            "LANGUAGE survived:\n{env}"
        );
    }

    #[test]
    fn without_the_c_locale_git_would_see_the_german_locale() {
        // The control for the test above: the alias really reports what the
        // caller passed on, so a missing force_c_locale would be caught.
        let dir = tempfile::tempdir().unwrap();
        let env = env_seen_by_git(german(Command::new("git")), dir.path());
        assert!(has_line(&env, "LC_ALL=de_DE.UTF-8"), "{env}");
        assert!(has_line(&env, "LANGUAGE=de"), "{env}");
    }

    #[test]
    fn only_an_e2e_run_may_keep_the_user_s_locale() {
        assert!(parse_user_locale_override(Some("1"), Some("1")));
        assert!(parse_user_locale_override(Some("1"), Some(" 1 ")));
        assert!(!parse_user_locale_override(None, Some("1")));
        assert!(!parse_user_locale_override(Some("0"), Some("1")));
        assert!(!parse_user_locale_override(Some("1"), None));
        assert!(!parse_user_locale_override(Some("1"), Some("yes")));
    }

    #[test]
    fn git_command_starts_git_in_the_c_locale() {
        let dir = tempfile::tempdir().unwrap();
        let env = env_seen_by_git(git_command(), dir.path());
        assert!(has_line(&env, "LC_ALL=C"), "{env}");
        assert!(has_line(&env, "LANG=C"), "{env}");
        assert!(!env.lines().any(|l| l.starts_with("LANGUAGE=")), "{env}");
    }

    #[test]
    fn not_a_git_repository_is_reported_in_english_under_a_german_locale() {
        // Where this machine's git has German messages (most Homebrew and
        // Linux builds with the locale installed), the uncorrected command
        // says "Kein Git-Repository"; with the C locale it must say "not a
        // git repository" either way, which is what the Review Desk matches.
        let dir = tempfile::tempdir().unwrap();
        let run = |mut cmd: Command| {
            let out = cmd
                .arg("-C")
                .arg(dir.path())
                .args(["rev-parse", "--show-toplevel"])
                .env("GIT_CEILING_DIRECTORIES", dir.path().parent().unwrap())
                .output()
                .expect("run git");
            assert!(!out.status.success(), "a temp folder is not a repository");
            String::from_utf8_lossy(&out.stderr).into_owned()
        };
        let mut fixed = german(Command::new("git"));
        force_c_locale(&mut fixed);
        let fixed = run(fixed);
        assert!(
            fixed.to_lowercase().contains("not a git repository"),
            "got: {fixed}"
        );
        let native = run(german(Command::new("git")));
        eprintln!("git under a German locale, uncorrected: {native}");
    }
}
