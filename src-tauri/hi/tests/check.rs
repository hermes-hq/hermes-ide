//! Runs the built `hi check` the way a person at a terminal, Hermes, and
//! Claude's Stop hook do.

use std::fs;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Output, Stdio};

const HI: &str = env!("CARGO_BIN_EXE_hi");

/// A fixture repository on `branch` with the given worktree.toml.
fn repo(branch: &str, worktree_toml: Option<&str>) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(dir.path().join(".git")).unwrap();
    fs::write(
        dir.path().join(".git/HEAD"),
        format!("ref: refs/heads/{branch}\n"),
    )
    .unwrap();
    if let Some(text) = worktree_toml {
        fs::create_dir_all(dir.path().join(".hermes")).unwrap();
        fs::write(dir.path().join(".hermes/worktree.toml"), text).unwrap();
    }
    dir
}

/// A done_when entry for the platform shell, as a TOML string.
fn toml_cmd(posix: &str, windows: &str) -> String {
    serde_json::to_string(if cfg!(windows) { windows } else { posix }).unwrap()
}

fn failing_toml() -> String {
    format!(
        "done_when = [{}, {}]\n",
        toml_cmd("echo fine", "echo fine"),
        toml_cmd(
            "echo 'expected 2 got 3' >&2; exit 1",
            "echo expected 2 got 3 1>&2& exit /b 1"
        )
    )
}

fn hi(cwd: &Path, args: &[&str], env: &[(&str, &Path)], stdin: Option<&str>) -> Output {
    let mut cmd = Command::new(HI);
    cmd.arg("check").args(args).current_dir(cwd);
    for name in [
        "HERMES_SIGNAL_FILE",
        "HERMES_SIGNAL_NONCE",
        "HERMES_SESSION_ID",
        "HERMES_AGENT",
    ] {
        cmd.env_remove(name);
    }
    for (k, v) in env {
        cmd.env(k, v);
    }
    cmd.env("HERMES_SIGNAL_NONCE", "n0nce")
        .env("HERMES_SESSION_ID", "hermes-1")
        .env("HERMES_AGENT", "claude");
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().unwrap();
    {
        let mut pipe = child.stdin.take().unwrap();
        if let Some(text) = stdin {
            pipe.write_all(text.as_bytes()).unwrap();
        }
    }
    child.wait_with_output().unwrap()
}

fn text(b: &[u8]) -> String {
    String::from_utf8_lossy(b).to_string()
}

fn spool_lines(file: &Path) -> Vec<serde_json::Value> {
    fs::read_to_string(file)
        .unwrap_or_default()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}

#[test]
fn at_a_terminal_it_lists_each_check_and_exits_1_when_one_fails() {
    let r = repo("main", Some(&failing_toml()));
    let out = hi(r.path(), &[], &[], None);
    let stdout = text(&out.stdout);
    assert_eq!(out.status.code(), Some(1), "{stdout}");
    assert!(
        stdout.contains("2 checks from .hermes/worktree.toml"),
        "{stdout}"
    );
    assert!(stdout.contains("  ok      echo fine"), "{stdout}");
    assert!(stdout.contains("  FAILED  "), "{stdout}");
    assert!(stdout.contains("expected 2 got 3"), "{stdout}");
    assert!(stdout.contains("1 of 2 checks failed."), "{stdout}");

    // From a subfolder too: the checks run from the checkout's root.
    let sub = r.path().join("src");
    fs::create_dir_all(&sub).unwrap();
    assert_eq!(hi(&sub, &[], &[], None).status.code(), Some(1));
}

#[test]
fn it_passes_with_nothing_to_check_and_names_an_unreadable_file() {
    let none = repo("main", None);
    let out = hi(none.path(), &[], &[], None);
    assert_eq!(out.status.code(), Some(0));
    assert!(text(&out.stdout).contains("no Done-When checks here"));

    let bad = repo("main", Some("done_when = [\"a\"\nsetup = 1\n"));
    let out = hi(bad.path(), &[], &[], None);
    assert_eq!(out.status.code(), Some(3));
    assert!(
        text(&out.stdout).contains("worktree.toml can't be read (line 1)"),
        "{}",
        text(&out.stdout)
    );
}

#[test]
fn json_output_is_what_hermes_reads() {
    let r = repo("main", Some(&failing_toml()));
    let out = hi(r.path(), &["--json", "--trigger", "turn_end"], &[], None);
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(v["v"], 1);
    assert_eq!(v["state"], "failed");
    assert_eq!(v["trigger"], "turn_end");
    assert_eq!(v["source"]["kind"], "worktree");
    assert_eq!(v["source"]["path"], ".hermes/worktree.toml");
    assert_eq!(v["commands"].as_array().unwrap().len(), 2);
    assert_eq!(v["commands"][0]["exit_code"], 0);
    assert_eq!(v["commands"][1]["exit_code"], 1);
    assert!(v["commands"][1]["output_tail"]
        .as_str()
        .unwrap()
        .contains("expected 2 got 3"));
    assert!(v["started_at"].as_u64().unwrap() > 0);
}

#[test]
fn inside_a_launched_agent_a_manual_check_is_reported_to_hermes() {
    let r = repo("main", Some(&failing_toml()));
    let spool_dir = tempfile::tempdir().unwrap();
    let spool = spool_dir.path().join("signals.ndjson");
    let out = hi(r.path(), &[], &[("HERMES_SIGNAL_FILE", &spool)], None);
    assert_eq!(out.status.code(), Some(1));
    let lines = spool_lines(&spool);
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0]["event"], "hermes.check");
    assert_eq!(lines[0]["nonce"], "n0nce");
    assert_eq!(lines[0]["session"], "hermes-1");
    assert_eq!(lines[0]["payload"]["state"], "failed");
    assert_eq!(lines[0]["payload"]["trigger"], "cli");
    assert!(serde_json::to_string(&lines[0]).unwrap().len() < 8 * 1024);
}

fn stop_payload(continuing: bool, cwd: &Path) -> String {
    serde_json::json!({
        "hook_event_name": "Stop",
        "session_id": "vendor-1",
        "stop_hook_active": continuing,
        "cwd": cwd.to_string_lossy(),
    })
    .to_string()
}

#[test]
fn as_a_stop_hook_it_sends_the_agent_back_three_times_then_lets_it_stop() {
    let r = repo("main", Some(&failing_toml()));
    let spool_dir = tempfile::tempdir().unwrap();
    let spool = spool_dir.path().join("signals.ndjson");
    let env = [("HERMES_SIGNAL_FILE", spool.as_path())];
    // The hook runs in the agent's folder; the payload names it too.
    let elsewhere = tempfile::tempdir().unwrap();
    let mut codes = Vec::new();
    for (i, continuing) in [false, true, true, true].into_iter().enumerate() {
        let out = hi(
            elsewhere.path(),
            &["--stop-hook"],
            &env,
            Some(&stop_payload(continuing, r.path())),
        );
        codes.push(out.status.code());
        if i < 3 {
            let stderr = text(&out.stderr);
            assert!(
                stderr.contains(&format!("attempt {} of 3", i + 1)),
                "{stderr}"
            );
            assert!(stderr.contains("expected 2 got 3"), "{stderr}");
            assert!(
                !stderr.contains("fine\n"),
                "passing checks are not fed back"
            );
        }
    }
    assert_eq!(codes, vec![Some(2), Some(2), Some(2), Some(0)]);
    let lines = spool_lines(&spool);
    assert_eq!(lines.len(), 4);
    for (i, l) in lines.iter().enumerate() {
        assert_eq!(l["event"], "hermes.check");
        assert_eq!(l["payload"]["trigger"], "stop_hook");
        assert_eq!(l["payload"]["attempt"], i as u64 + 1);
        assert_eq!(l["payload"]["max_attempts"], 3);
    }
    assert_eq!(lines[2]["payload"]["blocking"], true);
    assert_eq!(lines[3]["payload"]["blocking"], false);
    assert_eq!(lines[3]["payload"]["final"], true);
    assert_eq!(lines[3]["payload"]["gave_up"], true);

    // The next turn (not continuing) starts counting again.
    let out = hi(
        r.path(),
        &["--stop-hook"],
        &env,
        Some(&stop_payload(false, r.path())),
    );
    assert_eq!(out.status.code(), Some(2));
    assert!(text(&out.stderr).contains("attempt 1 of 3"));
}

#[test]
fn as_a_stop_hook_passing_or_absent_checks_never_block() {
    let spool_dir = tempfile::tempdir().unwrap();
    let spool = spool_dir.path().join("signals.ndjson");
    let env = [("HERMES_SIGNAL_FILE", spool.as_path())];
    let pass = repo(
        "main",
        Some(&format!(
            "done_when = [{}]\n",
            toml_cmd("exit 0", "exit /b 0")
        )),
    );
    let out = hi(
        pass.path(),
        &["--stop-hook"],
        &env,
        Some(&stop_payload(false, pass.path())),
    );
    assert_eq!(out.status.code(), Some(0));
    assert_eq!(spool_lines(&spool)[0]["payload"]["state"], "passed");

    let none = repo("main", None);
    let before = spool_lines(&spool).len();
    let out = hi(
        none.path(),
        &["--stop-hook"],
        &env,
        Some(&stop_payload(false, none.path())),
    );
    assert_eq!(out.status.code(), Some(0));
    assert_eq!(spool_lines(&spool).len(), before, "nothing to report");

    let unreadable = repo("main", Some("done_when = 1\n"));
    let out = hi(
        unreadable.path(),
        &["--stop-hook"],
        &env,
        Some(&stop_payload(false, unreadable.path())),
    );
    assert_eq!(out.status.code(), Some(0), "a broken file never blocks");
    assert_eq!(
        spool_lines(&spool).last().unwrap()["payload"]["state"],
        "error"
    );
}

#[test]
fn as_a_stop_hook_without_hermes_it_never_blocks() {
    let r = repo("main", Some(&failing_toml()));
    let out = hi(
        r.path(),
        &["--stop-hook"],
        &[],
        Some(&stop_payload(false, r.path())),
    );
    assert_eq!(out.status.code(), Some(0));
}

#[test]
fn bad_usage_exits_2() {
    let r = repo("main", None);
    assert_eq!(hi(r.path(), &["--nope"], &[], None).status.code(), Some(2));
}
