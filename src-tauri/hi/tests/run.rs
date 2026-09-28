//! Runs the built `hi` binary the way a Hermes terminal would.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

const HI: &str = env!("CARGO_BIN_EXE_hi");

/// A shell command line for the platform's shell, as a launch-file program
/// and args. `script` is POSIX sh on Unix and a cmd.exe line on Windows.
fn shell(posix: &str, windows: &str) -> (String, Vec<String>) {
    if cfg!(windows) {
        (
            "cmd.exe".to_string(),
            vec!["/d".into(), "/c".into(), windows.to_string()],
        )
    } else {
        ("sh".to_string(), vec!["-c".into(), posix.to_string()])
    }
}

fn spec_json(
    session: &str,
    program: &str,
    args: &[String],
    cwd: &Path,
    env: &[(&str, &str)],
    fallback: Option<(&str, &[String], &str)>,
) -> String {
    let env_obj: serde_json::Map<String, serde_json::Value> = env
        .iter()
        .map(|(k, v)| (k.to_string(), serde_json::Value::String(v.to_string())))
        .collect();
    let mut v = serde_json::json!({
        "v": 1,
        "session_id": session,
        "agent": "fake",
        "cwd": cwd.to_string_lossy(),
        "env": env_obj,
        "program": program,
        "args": args,
    });
    if let Some((program, args, vendor)) = fallback {
        // The catalog's Claude entry: exit 1, plus the "not found" text that
        // Hermes reports by writing the evidence file (see evidence()).
        v["fallback"] = serde_json::json!({
            "program": program,
            "args": args,
            "after_ms": 3000,
            "vendor_session_id": vendor,
            "not_found": {
                "exit_codes": [1],
                "evidence_file": cwd.join(EVIDENCE).to_string_lossy(),
                "evidence_wait_ms": 300,
            },
        });
    }
    serde_json::to_string(&v).unwrap()
}

const EVIDENCE: &str = "resume-not-found";

/// What Hermes writes when it saw the vendor's "not found" text in the
/// terminal: the launch's nonce, in the file the launch file names.
fn evidence(dir: &Path, nonce: &str) {
    fs::write(dir.join(EVIDENCE), format!("{nonce}\n")).unwrap();
}

fn spool(file: &Path) -> Vec<serde_json::Value> {
    fs::read_to_string(file)
        .unwrap_or_default()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}

fn write_launch(dir: &Path, session: &str, json: &str) -> PathBuf {
    let sess = dir.join(session);
    fs::create_dir_all(&sess).unwrap();
    let file = sess.join("launch.json");
    fs::write(&file, json).unwrap();
    file
}

fn hi_run(launch_dir: &Path, arg: &str) -> Output {
    Command::new(HI)
        .args(["run", arg])
        .env("HERMES_LAUNCH_DIR", launch_dir)
        .stdin(Stdio::null())
        .output()
        .unwrap()
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).to_string()
}

#[test]
fn runs_the_program_with_its_args_env_and_cwd_and_reports_its_exit_code() {
    let dir = tempfile::tempdir().unwrap();
    let work = dir.path().join("work dir");
    fs::create_dir_all(&work).unwrap();
    // `%1`/`%2` only exist inside a batch file, so on Windows the program
    // is a small .cmd (like an npm shim); on Unix `sh -c` sees $1/$2.
    let (program, mut args) = if cfg!(windows) {
        let bat = dir.path().join("echo-args.cmd");
        fs::write(
            &bat,
            "@echo args=%~1 %~2 env=%HERMES_AGENT_TEST%\r\n@cd\r\n@exit /b 7\r\n",
        )
        .unwrap();
        (bat.to_string_lossy().to_string(), Vec::<String>::new())
    } else {
        let (program, mut args) = shell(
            "echo \"args=$1 $2 env=$HERMES_AGENT_TEST\"; pwd; exit 7",
            "",
        );
        args.push("sh".into()); // $0
        (program, args)
    };
    args.push("one".into());
    args.push("two words".into());
    let json = spec_json(
        "s1",
        &program,
        &args,
        &work,
        &[("HERMES_AGENT_TEST", "yes")],
        None,
    );
    write_launch(dir.path(), "s1", &json);

    let out = hi_run(dir.path(), "s1");
    let stdout = text(&out.stdout);
    assert_eq!(
        out.status.code(),
        Some(7),
        "stdout: {stdout}\nstderr: {}",
        text(&out.stderr)
    );
    assert!(stdout.contains("args=one two words env=yes"), "{stdout}");
    let cwd_line = stdout
        .lines()
        .find(|l| l.contains("work dir"))
        .unwrap_or("");
    assert!(cwd_line.ends_with("work dir"), "cwd line: {cwd_line:?}");
}

#[test]
fn a_launch_file_path_works_too() {
    let dir = tempfile::tempdir().unwrap();
    let (program, args) = shell("echo direct", "echo direct");
    let json = spec_json("s2", &program, &args, dir.path(), &[], None);
    let file = write_launch(dir.path(), "s2", &json);
    let out = Command::new(HI)
        .args(["run", file.to_str().unwrap()])
        .env_remove("HERMES_LAUNCH_DIR")
        .output()
        .unwrap();
    assert!(out.status.success());
    assert!(text(&out.stdout).contains("direct"));
}

#[test]
fn a_resume_that_fails_at_once_prints_one_line_records_it_and_starts_fresh() {
    let dir = tempfile::tempdir().unwrap();
    let signals = dir.path().join("spool").join("signals.ndjson");
    let (program, resume_args) = shell(
        "echo 'No conversation found with session ID: old' >&2; exit 1",
        "echo No conversation found with session ID: old 1>&2 & exit 1",
    );
    let (_, fresh_args) = shell("echo fresh-started; exit 0", "echo fresh-started& exit 0");
    let sig = signals.to_string_lossy().to_string();
    let json = spec_json(
        "s3",
        &program,
        &resume_args,
        dir.path(),
        &[
            ("HERMES_SIGNAL_FILE", sig.as_str()),
            ("HERMES_SIGNAL_NONCE", "n-3"),
        ],
        Some((&program, &fresh_args, "new-vendor-id")),
    );
    write_launch(dir.path(), "s3", &json);
    evidence(dir.path(), "n-3");

    let out = hi_run(dir.path(), "s3");
    let stdout = text(&out.stdout);
    assert_eq!(
        out.status.code(),
        Some(0),
        "stdout: {stdout}\nstderr: {}",
        text(&out.stderr)
    );
    let notice = stdout
        .lines()
        .filter(|l| l.starts_with("hermes: "))
        .collect::<Vec<_>>();
    assert_eq!(notice.len(), 1, "exactly one visible line: {stdout:?}");
    assert!(notice[0]
        .contains("could not resume the previous conversation (exit 1); starting a new one"));
    assert!(stdout.contains("fresh-started"), "{stdout}");

    let spool = fs::read_to_string(&signals).unwrap();
    let lines: Vec<serde_json::Value> = spool
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    assert_eq!(lines.len(), 2, "fallback, then the fresh agent's exit");
    assert_eq!(lines[0]["event"], "hermes.resume_fallback");
    assert_eq!(lines[0]["session"], "s3");
    assert_eq!(lines[0]["nonce"], "n-3");
    assert_eq!(lines[0]["payload"]["vendor_session_id"], "new-vendor-id");
    assert_eq!(lines[0]["payload"]["exit_code"], 1);
    assert_eq!(lines[1]["event"], "hermes.exited");
    assert_eq!(lines[1]["nonce"], "n-3");
    assert_eq!(lines[1]["payload"]["exit_code"], 0);
}

/// Hermes learns that the agent is gone from hi itself, whatever the agent
/// did or did not do before it ended (no hook ran here).
#[test]
fn the_agents_exit_is_reported_to_hermes_with_its_status() {
    let dir = tempfile::tempdir().unwrap();
    let signals = dir.path().join("signals.ndjson");
    let sig = signals.to_string_lossy().to_string();
    let (program, args) = shell("exit 130", "exit 130");
    let json = spec_json(
        "s6",
        &program,
        &args,
        dir.path(),
        &[
            ("HERMES_SIGNAL_FILE", sig.as_str()),
            ("HERMES_SIGNAL_NONCE", "n-6"),
        ],
        None,
    );
    write_launch(dir.path(), "s6", &json);
    let out = hi_run(dir.path(), "s6");
    assert_eq!(out.status.code(), Some(130));
    let lines: Vec<serde_json::Value> = fs::read_to_string(&signals)
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0]["event"], "hermes.exited");
    assert_eq!(lines[0]["session"], "s6");
    assert_eq!(lines[0]["agent"], "fake");
    assert_eq!(lines[0]["nonce"], "n-6");
    assert_eq!(lines[0]["payload"]["exit_code"], 130);
    assert!(lines[0]["payload"].get("error").is_none());

    // A command that is not installed ends the same way, with the reason.
    let json = spec_json(
        "s7",
        "no-such-agent-binary-xyz",
        &[],
        dir.path(),
        &[
            ("HERMES_SIGNAL_FILE", sig.as_str()),
            ("HERMES_SIGNAL_NONCE", "n-7"),
        ],
        None,
    );
    write_launch(dir.path(), "s7", &json);
    let out = hi_run(dir.path(), "s7");
    assert_eq!(out.status.code(), Some(127));
    let last: serde_json::Value = serde_json::from_str(
        fs::read_to_string(&signals)
            .unwrap()
            .lines()
            .last()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(last["event"], "hermes.exited");
    assert_eq!(last["nonce"], "n-7");
    assert_eq!(last["payload"]["exit_code"], 127);
    assert_eq!(
        last["payload"]["error"],
        "no-such-agent-binary-xyz: command not found"
    );
}

/// No spool named in the launch file (a file run by hand): nothing is
/// written anywhere, the exit status still comes through.
#[test]
fn without_a_spool_the_exit_is_only_a_status() {
    let dir = tempfile::tempdir().unwrap();
    let (program, args) = shell("exit 4", "exit 4");
    let json = spec_json("s8", &program, &args, dir.path(), &[], None);
    write_launch(dir.path(), "s8", &json);
    let out = Command::new(HI)
        .args(["run", "s8"])
        .env("HERMES_LAUNCH_DIR", dir.path())
        .env_remove("HERMES_SIGNAL_FILE")
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(4));
    assert!(text(&out.stderr).is_empty(), "{}", text(&out.stderr));
    assert_eq!(
        fs::read_dir(dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| e.file_name() != "s8")
            .count(),
        0
    );
}

/// An npm-installed vendor CLI on Windows is a `.cmd` shim in front of a
/// Node program. Codex gets its notify program as one JSON argument with
/// quotes inside; the Node program must receive every argument exactly as
/// the launch file lists it, through hi, the standard library's batch-file
/// quoting and cmd.exe.
#[cfg(windows)]
#[test]
fn a_cmd_shim_hands_a_json_argument_with_quotes_to_the_program_intact() {
    let node_ok = Command::new("node")
        .arg("--version")
        .stdout(Stdio::null())
        .status()
        .is_ok_and(|s| s.success());
    if !node_ok {
        eprintln!("node is not on PATH; skipping");
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let bin = dir.path().join("bin");
    fs::create_dir_all(&bin).unwrap();
    let record = dir.path().join("argv.json");
    let script = dir.path().join("argv.mjs");
    fs::write(
        &script,
        format!(
            "import fs from 'node:fs'; fs.writeFileSync({}, JSON.stringify(process.argv.slice(2)));\n",
            serde_json::to_string(&record.to_string_lossy()).unwrap()
        ),
    )
    .unwrap();
    // The npm shim shape: forward every argument to the Node program.
    fs::write(
        bin.join("codex.cmd"),
        format!("@node \"{}\" %*\r\n", script.display()),
    )
    .unwrap();
    let path = std::env::join_paths(
        std::iter::once(bin.clone())
            .chain(std::env::split_paths(&std::env::var_os("PATH").unwrap())),
    )
    .unwrap();
    let args: Vec<String> = vec![
        "-c".into(),
        r#"notify=["C:/Program Files/Hermes/hi.exe","signal","--agent","codex","--argv-json"]"#
            .into(),
        "--sandbox".into(),
        "workspace-write".into(),
        "a prompt with spaces".into(),
    ];
    let json = spec_json("s9", "codex", &args, dir.path(), &[], None);
    write_launch(dir.path(), "s9", &json);
    let out = Command::new(HI)
        .args(["run", "s9"])
        .env("HERMES_LAUNCH_DIR", dir.path())
        .env("PATH", &path)
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert_eq!(
        out.status.code(),
        Some(0),
        "stdout: {}\nstderr: {}",
        text(&out.stdout),
        text(&out.stderr)
    );
    let got: Vec<String> = serde_json::from_str(&fs::read_to_string(&record).unwrap()).unwrap();
    assert_eq!(
        got, args,
        "the program behind the .cmd shim saw different arguments"
    );
}

/// Ctrl-C at a resumed agent's trust prompt ends it early too, but the
/// conversation is still there: no fallback, no new conversation, and Hermes
/// hears only that the agent exited. Even the "not found" evidence does not
/// turn an interrupt into a missing conversation.
#[test]
fn an_interrupted_resume_keeps_the_conversation() {
    let dir = tempfile::tempdir().unwrap();
    let signals = dir.path().join("signals.ndjson");
    let sig = signals.to_string_lossy().to_string();
    let (program, args) = shell("exit 130", "exit 130");
    let (_, fresh) = shell("echo must-not-run", "echo must-not-run");
    let json = spec_json(
        "s10",
        &program,
        &args,
        dir.path(),
        &[
            ("HERMES_SIGNAL_FILE", sig.as_str()),
            ("HERMES_SIGNAL_NONCE", "n-10"),
        ],
        Some((&program, &fresh, "fresh-id")),
    );
    write_launch(dir.path(), "s10", &json);
    evidence(dir.path(), "n-10");
    let out = hi_run(dir.path(), "s10");
    assert_eq!(out.status.code(), Some(130));
    assert!(!text(&out.stdout).contains("must-not-run"));
    assert!(!text(&out.stdout).contains("hermes:"));
    let lines = spool(&signals);
    assert_eq!(lines.len(), 1, "{lines:?}");
    assert_eq!(lines[0]["event"], "hermes.exited");
    assert_eq!(lines[0]["payload"]["exit_code"], 130);
}

/// A vendor whose Ctrl-C exits 1, the same code as its "not found": without
/// the "not found" text on screen the resume is kept.
#[test]
fn an_early_exit_without_the_not_found_text_keeps_the_conversation() {
    let dir = tempfile::tempdir().unwrap();
    let signals = dir.path().join("signals.ndjson");
    let sig = signals.to_string_lossy().to_string();
    let (program, args) = shell("exit 1", "exit 1");
    let (_, fresh) = shell("echo must-not-run", "echo must-not-run");
    let json = spec_json(
        "s11",
        &program,
        &args,
        dir.path(),
        &[
            ("HERMES_SIGNAL_FILE", sig.as_str()),
            ("HERMES_SIGNAL_NONCE", "n-11"),
        ],
        Some((&program, &fresh, "fresh-id")),
    );
    write_launch(dir.path(), "s11", &json);
    // Evidence from another launch does not count either.
    evidence(dir.path(), "n-earlier");
    let out = hi_run(dir.path(), "s11");
    assert_eq!(out.status.code(), Some(1));
    assert!(!text(&out.stdout).contains("must-not-run"));
    assert!(!text(&out.stdout).contains("hermes:"));
    let lines = spool(&signals);
    assert_eq!(lines.len(), 1, "{lines:?}");
    assert_eq!(lines[0]["event"], "hermes.exited");
    assert_eq!(lines[0]["payload"]["exit_code"], 1);
}

/// Killed by a signal (the terminal hung up, SIGINT to the agent's group).
#[cfg(unix)]
#[test]
fn a_resume_ended_by_a_signal_keeps_the_conversation() {
    let dir = tempfile::tempdir().unwrap();
    let signals = dir.path().join("signals.ndjson");
    let sig = signals.to_string_lossy().to_string();
    let (program, args) = shell("kill -TERM $$", "");
    let (_, fresh) = shell("echo must-not-run", "");
    let json = spec_json(
        "s12",
        &program,
        &args,
        dir.path(),
        &[
            ("HERMES_SIGNAL_FILE", sig.as_str()),
            ("HERMES_SIGNAL_NONCE", "n-12"),
        ],
        Some((&program, &fresh, "fresh-id")),
    );
    write_launch(dir.path(), "s12", &json);
    evidence(dir.path(), "n-12");
    let out = hi_run(dir.path(), "s12");
    assert_eq!(out.status.code(), Some(128 + 15));
    assert!(!text(&out.stdout).contains("must-not-run"));
    let lines = spool(&signals);
    assert_eq!(lines.len(), 1, "{lines:?}");
    assert_eq!(lines[0]["payload"]["exit_code"], 143);
}

/// A resume without a catalog "not found" entry is never replaced, whatever
/// its exit.
#[test]
fn without_a_not_found_entry_a_failed_resume_is_left_alone() {
    let dir = tempfile::tempdir().unwrap();
    let (program, args) = shell("exit 1", "exit 1");
    let (_, fresh) = shell("echo must-not-run", "echo must-not-run");
    let mut json: serde_json::Value = serde_json::from_str(&spec_json(
        "s13",
        &program,
        &args,
        dir.path(),
        &[],
        Some((&program, &fresh, "x")),
    ))
    .unwrap();
    json["fallback"]
        .as_object_mut()
        .unwrap()
        .remove("not_found");
    write_launch(dir.path(), "s13", &json.to_string());
    let out = hi_run(dir.path(), "s13");
    assert_eq!(out.status.code(), Some(1));
    assert!(!text(&out.stdout).contains("must-not-run"));
}

/// Once the fresh agent is past the quick-failure window, hi says so, so
/// Hermes can adopt the new conversation even from an agent that sends no
/// start signal of its own.
#[test]
fn a_fresh_agent_that_keeps_running_is_reported() {
    let dir = tempfile::tempdir().unwrap();
    let signals = dir.path().join("signals.ndjson");
    let sig = signals.to_string_lossy().to_string();
    let (program, resume) = shell("exit 1", "exit 1");
    let (_, fresh) = shell("sleep 1; exit 0", "ping -n 2 127.0.0.1 >nul & exit 0");
    let mut json: serde_json::Value = serde_json::from_str(&spec_json(
        "s14",
        &program,
        &resume,
        dir.path(),
        &[
            ("HERMES_SIGNAL_FILE", sig.as_str()),
            ("HERMES_SIGNAL_NONCE", "n-14"),
        ],
        Some((&program, &fresh, "fresh-id")),
    ))
    .unwrap();
    json["fallback"]["after_ms"] = serde_json::json!(300);
    write_launch(dir.path(), "s14", &json.to_string());
    evidence(dir.path(), "n-14");
    let out = hi_run(dir.path(), "s14");
    assert_eq!(out.status.code(), Some(0));
    let events: Vec<String> = spool(&signals)
        .iter()
        .map(|l| l["event"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(
        events,
        [
            "hermes.resume_fallback",
            "hermes.fallback_running",
            "hermes.exited"
        ]
    );
    let running = &spool(&signals)[1];
    assert_eq!(running["nonce"], "n-14");
    assert_eq!(running["payload"]["vendor_session_id"], "fresh-id");
}

#[test]
fn a_failure_after_the_window_is_not_a_failed_resume() {
    let dir = tempfile::tempdir().unwrap();
    let (program, args) = shell("sleep 1; exit 1", "ping -n 3 127.0.0.1 >nul & exit 1");
    let (_, fresh) = shell("echo must-not-run", "echo must-not-run");
    let mut json: serde_json::Value = serde_json::from_str(&spec_json(
        "s4",
        &program,
        &args,
        dir.path(),
        &[],
        Some((&program, &fresh, "x")),
    ))
    .unwrap();
    json["fallback"]["after_ms"] = serde_json::json!(300);
    write_launch(dir.path(), "s4", &json.to_string());
    evidence(dir.path(), "any");

    let out = hi_run(dir.path(), "s4");
    assert_eq!(out.status.code(), Some(1));
    assert!(!text(&out.stdout).contains("must-not-run"));
    assert!(!text(&out.stdout).contains("hermes:"));
}

#[test]
fn a_missing_program_is_reported_like_a_shell_would() {
    let dir = tempfile::tempdir().unwrap();
    let json = spec_json("s5", "no-such-agent-binary-xyz", &[], dir.path(), &[], None);
    write_launch(dir.path(), "s5", &json);
    let out = hi_run(dir.path(), "s5");
    assert_eq!(out.status.code(), Some(127));
    let err = text(&out.stderr);
    assert!(
        err.contains("no-such-agent-binary-xyz: command not found"),
        "{err}"
    );
}

#[test]
fn an_unknown_session_and_bad_usage_exit_2() {
    let dir = tempfile::tempdir().unwrap();
    let out = hi_run(dir.path(), "does-not-exist");
    assert_eq!(out.status.code(), Some(2));
    assert!(text(&out.stderr).contains("no launch file"));
    let out = Command::new(HI).output().unwrap();
    assert_eq!(out.status.code(), Some(2));
    assert!(text(&out.stderr).contains("usage"));
    let out = Command::new(HI).arg("--version").output().unwrap();
    assert!(out.status.success());
    assert!(text(&out.stdout).starts_with("hi "));
}

#[test]
fn signal_appends_one_spool_line_from_the_hook_json_on_stdin() {
    use std::io::Write;
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("nested").join("signals.ndjson");
    let mut child = Command::new(HI)
        .args(["signal", "--agent", "claude", "--event", "Fallback"])
        .env("HERMES_SIGNAL_FILE", &file)
        .env("HERMES_SESSION_ID", "hermes-42")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(br#"{"hook_event_name":"SessionStart","session_id":"vendor-1","cwd":"/repo","tool_input":{"x":1}}"#)
        .unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success());
    assert!(out.stdout.is_empty(), "hi signal must print nothing");

    let spool = fs::read_to_string(&file).unwrap();
    let line: serde_json::Value = serde_json::from_str(spool.trim()).unwrap();
    assert_eq!(line["event"], "SessionStart");
    assert_eq!(line["session"], "hermes-42");
    assert_eq!(line["agent"], "claude");
    assert_eq!(line["payload"]["session_id"], "vendor-1");
    assert!(line["payload"].get("tool_input").is_none());
}

#[test]
fn signal_without_a_spool_file_or_with_bad_input_still_exits_0() {
    let out = Command::new(HI)
        .args(["signal"])
        .env_remove("HERMES_SIGNAL_FILE")
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(out.status.success());

    use std::io::Write;
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("signals.ndjson");
    let mut child = Command::new(HI)
        .args(["signal", "--event", "Stop"])
        .env("HERMES_SIGNAL_FILE", &file)
        .stdin(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(b"not json at all")
        .unwrap();
    assert!(child.wait().unwrap().success());
    let line: serde_json::Value =
        serde_json::from_str(fs::read_to_string(&file).unwrap().trim()).unwrap();
    assert_eq!(line["event"], "Stop");
}

#[test]
fn signal_takes_the_payload_from_the_last_argument_with_argv_json() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("signals.ndjson");
    let payload = r#"{"type":"agent-turn-complete","thread-id":"t-77","last-assistant-message":"done","input-messages":["x"]}"#;
    let out = Command::new(HI)
        .args(["signal", "--agent", "codex", "--argv-json", payload])
        .env("HERMES_SIGNAL_FILE", &file)
        .env("HERMES_SESSION_ID", "hermes-7")
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(out.status.success());
    assert!(out.stdout.is_empty());
    let line: serde_json::Value =
        serde_json::from_str(fs::read_to_string(&file).unwrap().trim()).unwrap();
    assert_eq!(line["agent"], "codex");
    assert_eq!(line["session"], "hermes-7");
    assert_eq!(line["payload"]["thread-id"], "t-77");
    assert_eq!(line["payload"]["type"], "agent-turn-complete");
    assert!(line["payload"].get("last-assistant-message").is_none());
}
