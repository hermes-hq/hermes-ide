//! The Feature Track subcommands of `hi` (F28). Thin: every rule lives in
//! the `hermes-track` crate, which the Hermes app uses too.
//!
//! ```text
//! hi feature new <slug> [--track Quick|Light|Full] [--title T] [--no-branch]
//! hi phase [name|done|skip] [--feature <slug>]
//! hi approve [--feature <slug>]          people only (refuses under HERMES_AGENT)
//! hi feature check [--feature <slug>]  (`hi check` runs the Done-When checks, F27)
//! hi land [--body-file <path>] [--feature <slug>]   people only
//! hi status [--all]
//! ```
//!
//! Output is plain text so it reads the same over SSH, in any agent's
//! terminal and in a log.

use std::path::{Path, PathBuf};
use std::process::Command;

use hermes_track::{
    current_branch, feature, land, phases::Phase, phases::Track, status, TrackError, AGENT_ENV,
};

pub const EXIT_USAGE: i32 = 2;
/// A person's action asked for by an agent.
pub const EXIT_PEOPLE_ONLY: i32 = 3;
/// The state machine refused (a gate is waiting, a cap is exceeded, ...).
pub const EXIT_REFUSED: i32 = 4;
pub const EXIT_ERROR: i32 = 1;

fn agent_env_set() -> bool {
    std::env::var_os(AGENT_ENV).is_some_and(|v| !v.is_empty())
}

/// The worktree root: the nearest ancestor of the current folder with a
/// `.git` entry, else the current folder.
pub fn find_root(from: &Path) -> PathBuf {
    let mut dir = from.to_path_buf();
    loop {
        if dir.join(".git").exists() {
            return dir;
        }
        match dir.parent() {
            Some(p) => dir = p.to_path_buf(),
            None => return from.to_path_buf(),
        }
    }
}

struct Args {
    positional: Vec<String>,
    feature: Option<String>,
    track: Option<String>,
    title: Option<String>,
    body_file: Option<String>,
    all: bool,
    no_branch: bool,
}

fn parse_args(args: &[String]) -> Result<Args, String> {
    let mut out = Args {
        positional: Vec::new(),
        feature: None,
        track: None,
        title: None,
        body_file: None,
        all: false,
        no_branch: false,
    };
    let mut i = 0;
    while i < args.len() {
        let a = args[i].as_str();
        let value = |i: &mut usize| -> Result<String, String> {
            *i += 1;
            args.get(*i)
                .cloned()
                .ok_or_else(|| format!("{a} needs a value"))
        };
        match a {
            "--feature" => out.feature = Some(value(&mut i)?),
            "--track" => out.track = Some(value(&mut i)?),
            "--title" => out.title = Some(value(&mut i)?),
            "--body-file" => out.body_file = Some(value(&mut i)?),
            "--all" => out.all = true,
            "--no-branch" => out.no_branch = true,
            _ if a.starts_with("--") => return Err(format!("unknown option {a}")),
            _ => out.positional.push(a.to_string()),
        }
        i += 1;
    }
    Ok(out)
}

fn slug_for(root: &Path, args: &Args) -> Result<String, String> {
    if let Some(s) = &args.feature {
        return Ok(s.clone());
    }
    let branch = current_branch(root);
    match feature::find_slug(root, branch.as_deref()) {
        Some(s) => Ok(s),
        None => {
            let all = feature::list_features(root);
            if all.is_empty() {
                Err(format!(
                    "no feature in {} (no .hermes/features/<slug>/feature.md); start one with `hi feature new <slug>`",
                    root.display()
                ))
            } else {
                Err(format!(
                    "several features here ({}); say which with --feature <slug>",
                    all.join(", ")
                ))
            }
        }
    }
}

fn exit_for(e: &TrackError) -> i32 {
    match e {
        TrackError::Refused(_) => EXIT_REFUSED,
        _ => EXIT_ERROR,
    }
}

fn fail(e: &TrackError) -> i32 {
    eprintln!("hi: {e}");
    exit_for(e)
}

fn usage_error(msg: &str) -> i32 {
    eprintln!("hi: {msg}");
    EXIT_USAGE
}

fn people_only(what: &str) -> i32 {
    eprintln!(
        "hi: {what} is for people, not agents: this process was started by Hermes for an agent ({AGENT_ENV} is set). Ask the person driving this feature; they approve from Hermes or from their own shell."
    );
    EXIT_PEOPLE_ONLY
}

pub fn cmd_feature(cwd: &Path, args: &[String]) -> i32 {
    let args = match parse_args(args) {
        Ok(a) => a,
        Err(e) => return usage_error(&e),
    };
    match args.positional.first().map(String::as_str) {
        Some("new") => {}
        // `hi check` is the Done-When checks (F27); the track files are
        // checked here.
        Some("check") => return check_parsed(cwd, &args),
        _ => return usage_error("usage: hi feature new <slug> [--track Quick|Light|Full] [--title <text>] [--no-branch] | hi feature check"),
    }
    let Some(slug) = args.positional.get(1) else {
        return usage_error("hi feature new needs a slug (lowercase letters, digits and dashes)");
    };
    let track = match args.track.as_deref() {
        None => Track::Light,
        Some(t) => match Track::parse(t) {
            Some(t) => t,
            None => {
                return usage_error(&format!("--track must be Quick, Light or Full (got {t:?})"))
            }
        },
    };
    let root = find_root(cwd);
    let outcome = match feature::create(&root, slug, track, args.title.as_deref().unwrap_or(""), "")
    {
        Ok(o) => o,
        Err(e) => return fail(&e),
    };
    let branch_line = if args.no_branch {
        None
    } else {
        ensure_branch(&root, slug)
    };
    if !outcome.created {
        println!("Quick track: no feature folder, no phases; just do the work.");
        if let Some(b) = branch_line {
            println!("{b}");
        }
        return 0;
    }
    let phases: Vec<&str> = hermes_track::track_phases(track)
        .iter()
        .map(|p| p.as_str())
        .collect();
    println!(
        "Created .hermes/features/{slug}/feature.md ({} track: {})",
        track.as_str(),
        phases.join(", ")
    );
    if !outcome.seeded.is_empty() {
        println!("Seeded .hermes/phases/*.md (edit them per repository) and .claude/commands/hermes-phase.md");
    }
    if let Some(b) = branch_line {
        println!("{b}");
    }
    println!("Next: hi phase");
    0
}

/// Put the worktree on `hermes/<slug>` when it is a repository and not there
/// yet. Never fatal: the folder is what matters.
fn ensure_branch(root: &Path, slug: &str) -> Option<String> {
    if !root.join(".git").exists() {
        return None;
    }
    let want = format!("hermes/{slug}");
    if current_branch(root).as_deref() == Some(want.as_str()) {
        return Some(format!("On branch {want}"));
    }
    let out = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["switch", "-c", &want])
        .output();
    match out {
        Ok(o) if o.status.success() => Some(format!("Switched to a new branch {want}")),
        Ok(o) => Some(format!(
            "Stayed on the current branch (git switch -c {want} said: {})",
            String::from_utf8_lossy(&o.stderr).trim()
        )),
        Err(e) => Some(format!(
            "Stayed on the current branch (git not available: {e})"
        )),
    }
}

pub fn cmd_phase(cwd: &Path, args: &[String]) -> i32 {
    let args = match parse_args(args) {
        Ok(a) => a,
        Err(e) => return usage_error(&e),
    };
    let root = find_root(cwd);
    let slug = match slug_for(&root, &args) {
        Ok(s) => s,
        Err(e) => return usage_error(&e),
    };
    match args.positional.first().map(String::as_str) {
        Some("done") => match feature::finish_phase(&root, &slug) {
            Ok(phase) => {
                println!(
                    "{}: {} is ready for review. Hermes shows it to the person; wait for `gate: approved` in feature.md, then run `hi phase`.",
                    slug,
                    phase.as_str()
                );
                0
            }
            Err(e) => fail(&e),
        },
        Some("skip") => match feature::skip_phase(&root, &slug, !agent_env_set()) {
            Ok((from, to)) => {
                println!(
                    "{slug}: skipped {}; now at {}. Next: hi phase",
                    from.as_str(),
                    to.as_str()
                );
                0
            }
            Err(e) => fail(&e),
        },
        other => {
            let requested = match other {
                None => None,
                Some(name) => match Phase::parse(name) {
                    Some(p) => Some(p),
                    None => {
                        return usage_error(&format!(
                            "unknown phase {name:?}; phases are questions, research, design, structure, plan, implement — or done, skip"
                        ))
                    }
                },
            };
            match feature::start_phase(&root, &slug, requested) {
                Ok(out) => {
                    print!("{}", out.prompt);
                    0
                }
                Err(e) => fail(&e),
            }
        }
    }
}

pub fn cmd_approve(cwd: &Path, args: &[String]) -> i32 {
    if agent_env_set() {
        return people_only("hi approve");
    }
    let args = match parse_args(args) {
        Ok(a) => a,
        Err(e) => return usage_error(&e),
    };
    let root = find_root(cwd);
    let slug = match slug_for(&root, &args) {
        Ok(s) => s,
        Err(e) => return usage_error(&e),
    };
    match feature::approve(&root, &slug) {
        Ok((from, to)) => {
            println!(
                "{slug}: approved {}; next phase {}",
                from.as_str(),
                to.as_str()
            );
            0
        }
        Err(e) => fail(&e),
    }
}

fn check_parsed(cwd: &Path, args: &Args) -> i32 {
    let root = find_root(cwd);
    let slug = match slug_for(&root, args) {
        Ok(s) => s,
        Err(e) => return usage_error(&e),
    };
    let problems = feature::check(&root, &slug);
    if problems.is_empty() {
        println!("{slug}: ok");
        0
    } else {
        for p in &problems {
            println!("{}: {}", p.file, p.message);
        }
        EXIT_REFUSED
    }
}

pub fn cmd_land(cwd: &Path, args: &[String]) -> i32 {
    if agent_env_set() {
        return people_only("hi land");
    }
    let args = match parse_args(args) {
        Ok(a) => a,
        Err(e) => return usage_error(&e),
    };
    let root = find_root(cwd);
    let slug = match slug_for(&root, &args) {
        Ok(s) => s,
        Err(e) => return usage_error(&e),
    };
    match land::land(&root, &slug) {
        Ok(out) => {
            println!(
                "{slug}: track files archived at {} ({})",
                out.archive_ref,
                &out.archived_commit[..12.min(out.archived_commit.len())]
            );
            match &out.removal_commit {
                Some(c) => println!("Removed them from the branch in {}", &c[..12.min(c.len())]),
                None => println!("They were not tracked, so the branch is unchanged"),
            }
            if let Some(file) = &args.body_file {
                let text = format!("{}\n\n{}", out.pr_title, out.pr_body);
                if let Err(e) = std::fs::write(file, text) {
                    eprintln!("hi: could not write {file}: {e}");
                    return EXIT_ERROR;
                }
                println!("Pull request title and body written to {file}");
            } else {
                println!("\n{}\n\n{}", out.pr_title, out.pr_body);
            }
            0
        }
        Err(e) => fail(&e),
    }
}

pub fn cmd_status(cwd: &Path, args: &[String]) -> i32 {
    let args = match parse_args(args) {
        Ok(a) => a,
        Err(e) => return usage_error(&e),
    };
    let root = find_root(cwd);
    print!("{}", status::render(&root, args.all));
    0
}
