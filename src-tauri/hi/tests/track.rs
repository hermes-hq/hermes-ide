//! Runs the built `hi` binary's Feature Track commands (F28) in a throwaway
//! repository, the way an agent or a person would from a Hermes terminal.

use std::fs;
use std::path::Path;
use std::process::{Command, Output};

const HI: &str = env!("CARGO_BIN_EXE_hi");

fn git(root: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .expect("git runs");
    assert!(
        out.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn repo() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    git(root, &["init", "-q", "-b", "main"]);
    git(root, &["config", "user.email", "test@example.com"]);
    git(root, &["config", "user.name", "Test"]);
    fs::write(root.join("README.md"), "# demo\n").unwrap();
    git(root, &["add", "README.md"]);
    git(root, &["commit", "-q", "-m", "init"]);
    dir
}

/// `hi <args>` in `cwd`, as a person (no HERMES_AGENT) or as an agent.
fn hi(cwd: &Path, args: &[&str], as_agent: bool) -> Output {
    let mut cmd = Command::new(HI);
    cmd.args(args).current_dir(cwd).env_remove("HERMES_AGENT");
    if as_agent {
        cmd.env("HERMES_AGENT", "fake");
    }
    cmd.output().unwrap()
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).to_string()
}

fn feature_md(root: &Path, slug: &str) -> String {
    fs::read_to_string(root.join(".hermes/features").join(slug).join("feature.md")).unwrap()
}

fn line_of(text: &str, key: &str) -> String {
    text.lines()
        .find(|l| l.starts_with(&format!("{key}:")))
        .unwrap_or("")
        .to_string()
}

#[test]
fn a_quick_task_creates_no_feature_folder() {
    let dir = repo();
    let root = dir.path();
    let out = hi(
        root,
        &["feature", "new", "quick-fix", "--track", "Quick"],
        true,
    );
    assert_eq!(out.status.code(), Some(0), "{}", text(&out.stderr));
    assert!(text(&out.stdout).contains("Quick track: no feature folder"));
    assert!(
        !root.join(".hermes").exists(),
        "no .hermes/features folder for a Quick task"
    );
    assert_eq!(
        git(root, &["branch", "--show-current"]),
        "hermes/quick-fix",
        "the branch still exists"
    );
}

#[test]
fn hi_phase_plan_prints_the_prompt_and_creates_plan_md_from_its_template() {
    let dir = repo();
    let root = dir.path();
    let out = hi(
        root,
        &[
            "feature",
            "new",
            "demo",
            "--track",
            "Light",
            "--title",
            "Demo search",
        ],
        true,
    );
    assert_eq!(out.status.code(), Some(0), "{}", text(&out.stderr));
    let stdout = text(&out.stdout);
    assert!(
        stdout.contains(
            "Created .hermes/features/demo/feature.md (Light track: questions, plan, implement)"
        ),
        "{stdout}"
    );
    assert!(
        stdout.contains("Switched to a new branch hermes/demo"),
        "{stdout}"
    );
    assert!(
        root.join(".hermes/phases/plan.md").is_file(),
        "phase prompts are seeded per repository"
    );
    assert!(
        root.join(".claude/commands/hermes-phase.md").is_file(),
        "one generated Claude slash command"
    );
    assert_eq!(
        fs::read_dir(root.join(".claude/commands")).unwrap().count(),
        1,
        "only one"
    );

    // The Light track starts at questions; skip it to reach plan.
    let out = hi(root, &["phase", "skip"], true);
    assert_eq!(out.status.code(), Some(0), "{}", text(&out.stderr));
    let out = hi(root, &["phase", "plan"], true);
    assert_eq!(out.status.code(), Some(0), "{}", text(&out.stderr));
    let stdout = text(&out.stdout);
    assert!(stdout.starts_with("# Phase: plan"), "{stdout}");
    assert!(stdout.contains("Write .hermes/features/demo/plan.md (at most 120 lines). When it is ready: hi phase done"), "{stdout}");
    let plan = fs::read_to_string(root.join(".hermes/features/demo/plan.md")).unwrap();
    assert!(
        plan.starts_with("# Plan\n"),
        "plan.md comes from the template: {plan}"
    );
    let fm = feature_md(root, "demo");
    assert_eq!(line_of(&fm, "phase"), "phase: plan");
    assert_eq!(line_of(&fm, "gate"), "gate: none");

    // A repository can edit its prompts.
    fs::write(
        root.join(".hermes/phases/plan.md"),
        "# Phase: plan\n\nOur own rules.\n\n## Template\n# Plan (ours)\n",
    )
    .unwrap();
    let out = hi(root, &["phase", "plan"], true);
    assert!(text(&out.stdout).contains("Our own rules."));
}

#[test]
fn hi_approve_exits_non_zero_inside_an_agent_process_and_works_for_a_person() {
    let dir = repo();
    let root = dir.path();
    assert!(hi(root, &["feature", "new", "demo"], true).status.success());
    assert!(hi(root, &["phase"], true).status.success());
    fs::write(
        root.join(".hermes/features/demo/questions.md"),
        "- [ ] ! Which engine?\n",
    )
    .unwrap();
    let out = hi(root, &["phase", "done"], true);
    assert_eq!(out.status.code(), Some(0), "{}", text(&out.stderr));
    assert_eq!(line_of(&feature_md(root, "demo"), "gate"), "gate: waiting");

    // The agent tries to approve its own gate.
    let out = hi(root, &["approve"], true);
    assert_eq!(out.status.code(), Some(3), "stderr: {}", text(&out.stderr));
    assert!(
        text(&out.stderr).contains("is for people, not agents"),
        "{}",
        text(&out.stderr)
    );
    assert_eq!(
        line_of(&feature_md(root, "demo"), "gate"),
        "gate: waiting",
        "nothing changed"
    );
    // ...or to skip past it, or to start the next phase.
    let out = hi(root, &["phase", "skip"], true);
    assert_eq!(out.status.code(), Some(4));
    assert!(text(&out.stderr).contains("only a person can skip it"));
    let out = hi(root, &["phase", "plan"], true);
    assert_eq!(out.status.code(), Some(4));
    assert!(text(&out.stderr).contains("waiting for a person's approval"));
    // Landing is a person's action too.
    assert_eq!(hi(root, &["land"], true).status.code(), Some(3));

    // A person (no HERMES_AGENT) approves from their own shell.
    let out = hi(root, &["approve"], false);
    assert_eq!(out.status.code(), Some(0), "{}", text(&out.stderr));
    assert!(text(&out.stdout).contains("demo: approved questions; next phase plan"));
    let fm = feature_md(root, "demo");
    assert_eq!(line_of(&fm, "phase"), "phase: plan");
    assert_eq!(line_of(&fm, "gate"), "gate: approved");
    // Nothing waiting now.
    assert_eq!(hi(root, &["approve"], false).status.code(), Some(4));
    // The agent picks the approved phase up.
    let out = hi(root, &["phase"], true);
    assert!(out.status.success());
    assert!(text(&out.stdout).starts_with("# Phase: plan"));
    assert_eq!(line_of(&feature_md(root, "demo"), "gate"), "gate: none");
}

#[test]
fn check_and_done_enforce_the_line_caps() {
    let dir = repo();
    let root = dir.path();
    assert!(hi(root, &["feature", "new", "demo"], true).status.success());
    assert!(hi(root, &["phase"], true).status.success());
    fs::write(
        root.join(".hermes/features/demo/questions.md"),
        "- [ ] q\n".repeat(41),
    )
    .unwrap();
    let out = hi(root, &["feature", "check"], true);
    assert_eq!(out.status.code(), Some(4));
    assert!(
        text(&out.stdout).contains(
            ".hermes/features/demo/questions.md: has 41 lines; the cap for questions is 40"
        ),
        "{}",
        text(&out.stdout)
    );
    let out = hi(root, &["phase", "done"], true);
    assert_eq!(out.status.code(), Some(4));
    assert!(text(&out.stderr).contains("has 41 lines; the cap for questions is 40"));
    fs::write(
        root.join(".hermes/features/demo/questions.md"),
        "- [ ] q\n".repeat(40),
    )
    .unwrap();
    let out = hi(root, &["feature", "check"], true);
    assert_eq!(out.status.code(), Some(0));
    assert_eq!(text(&out.stdout).trim(), "demo: ok");
    assert!(hi(root, &["phase", "done"], true).status.success());
}

#[test]
fn status_lists_blocked_items_as_plain_text_across_worktrees() {
    let dir = repo();
    let root = dir.path();
    assert!(
        hi(root, &["feature", "new", "alpha", "--track", "Full"], true)
            .status
            .success()
    );
    assert!(hi(root, &["phase"], true).status.success());
    fs::write(
        root.join(".hermes/features/alpha/questions.md"),
        "- [ ] ! Which engine?\n- [ ] Colour?\n",
    )
    .unwrap();
    assert!(hi(root, &["phase", "done"], true).status.success());
    // A second worktree with its own feature.
    let other = dir.path().join("wt-beta");
    git(
        root,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "hermes/beta",
            other.to_str().unwrap(),
        ],
    );
    assert!(hi(&other, &["feature", "new", "beta"], true)
        .status
        .success());

    let out = hi(root, &["status"], true);
    assert_eq!(out.status.code(), Some(0));
    let stdout = text(&out.stdout);
    assert!(
        stdout.contains("alpha                Full   questions  gate: waiting"),
        "{stdout}"
    );
    assert!(stdout.contains("Blocked on you:"), "{stdout}");
    assert!(
        stdout.contains("◆ alpha: questions is ready for review (hi approve)"),
        "{stdout}"
    );
    assert!(
        stdout.contains("◆ alpha: question — Which engine?"),
        "{stdout}"
    );
    assert!(
        !stdout.contains("beta"),
        "without --all only this worktree is listed"
    );
    assert!(!stdout.contains('\x1b'), "plain text: no escape codes");

    let out = hi(&other, &["status", "--all"], true);
    let stdout = text(&out.stdout);
    assert!(
        stdout.contains("alpha") && stdout.contains("beta"),
        "--all lists every worktree: {stdout}"
    );
    assert!(
        stdout.contains("◆ alpha: question — Which engine?"),
        "{stdout}"
    );

    // A folder without a feature says so and how to start one.
    let empty = tempfile::tempdir().unwrap();
    let out = hi(empty.path(), &["status"], true);
    assert!(text(&out.stdout).starts_with("no feature here"));
}

#[test]
fn land_archives_the_track_files_and_prints_the_pull_request_body() {
    let dir = repo();
    let root = dir.path();
    assert!(hi(
        root,
        &["feature", "new", "demo", "--title", "Demo search"],
        true
    )
    .status
    .success());
    fs::write(
        root.join(".hermes/features/demo/plan.md"),
        "# Plan\n\n- [x] index\n",
    )
    .unwrap();
    git(root, &["add", "-A"]);
    git(root, &["commit", "-q", "-m", "wip"]);
    let body_file = root.join("pr.md");
    let out = hi(
        root,
        &["land", "--body-file", body_file.to_str().unwrap()],
        false,
    );
    assert_eq!(out.status.code(), Some(0), "{}", text(&out.stderr));
    let stdout = text(&out.stdout);
    assert!(
        stdout.contains("demo: track files archived at refs/hermes/archive/demo"),
        "{stdout}"
    );
    assert!(
        stdout.contains("Removed them from the branch in"),
        "{stdout}"
    );
    let body = fs::read_to_string(&body_file).unwrap();
    assert!(body.starts_with("Demo search\n\n"), "{body}");
    assert!(body.contains("## Plan\n\n- [x] index"), "{body}");
    assert!(!root.join(".hermes/features/demo").exists());
    let archived = git(
        root,
        &[
            "show",
            "refs/hermes/archive/demo:.hermes/features/demo/plan.md",
        ],
    );
    assert!(archived.contains("- [x] index"));
    let tracked = git(root, &["ls-files", ".hermes/features"]);
    assert_eq!(tracked, "", "the merge will not carry the track files");
    // Landing again: nothing there.
    assert_eq!(hi(root, &["land"], false).status.code(), Some(2));
}

#[test]
fn several_features_need_the_flag_and_bad_usage_exits_2() {
    let dir = repo();
    let root = dir.path();
    assert!(hi(root, &["feature", "new", "one", "--no-branch"], true)
        .status
        .success());
    assert!(hi(root, &["feature", "new", "two", "--no-branch"], true)
        .status
        .success());
    let out = hi(root, &["phase"], true);
    assert_eq!(out.status.code(), Some(2));
    assert!(text(&out.stderr).contains("several features here (one, two)"));
    assert!(hi(root, &["phase", "--feature", "two"], true)
        .status
        .success());
    assert_eq!(
        hi(root, &["phase", "nonsense"], true).status.code(),
        Some(2)
    );
    assert_eq!(hi(root, &["feature"], true).status.code(), Some(2));
    assert_eq!(
        hi(root, &["feature", "new", "Bad Slug"], true)
            .status
            .code(),
        Some(4)
    );
    assert_eq!(
        hi(root, &["feature", "new", "x", "--track", "Huge"], true)
            .status
            .code(),
        Some(2)
    );
    assert_eq!(
        git(root, &["branch", "--show-current"]),
        "main",
        "--no-branch left the branch alone"
    );
}
