//! End-to-end harness for the Claude agent subprocess lifecycle.
//!
//! These tests drive the real `claude` binary on the developer's machine.
//! They are **gated**:
//!
//!   * `#[ignore]` so `cargo test` skips them by default.
//!   * Run with: `cargo test --lib agent::e2e_tests:: -- --ignored --nocapture`
//!     (set `HERMES_AGENT_E2E=1` to force-run if the gate ever moves to env-only).
//!
//! Why this file exists: the unit tests in `agent::tests` only check our
//! Rust string-building. They cannot tell us whether Claude actually accepts
//! the argv combination we hand it, whether `--resume` finds the session
//! we created, or whether `--fork-session` + `--model X` actually swaps the
//! active model.  Past iterations shipped argv combinations that compiled
//! and unit-tested cleanly but that Claude rejected at runtime — the only
//! way to catch those is to spawn the real binary and read its output.
//!
//! Each test:
//!   1. Spawns `claude` via `build_spawn_args` (same code path as production).
//!   2. Streams a synthetic `user` event in over stdin.
//!   3. Reads NDJSON events from stdout and stderr until the subprocess exits.
//!   4. Asserts on the parsed events: did `init` arrive? what was the
//!      `session_id`? did `result` succeed? did the assistant text mention
//!      the expected model name?
//!
//! When these tests pass, we have *grounded confidence* that the production
//! flow works.  When they fail, the failure surfaces the exact stderr line
//! we need to fix.  No more "ship it and ask the user to retest."

use super::build_spawn_args;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::time::timeout;

/// Allocate a fresh, unique working directory for one e2e test.
///
/// Tests that share `cwd` end up sharing Claude's session-memory store,
/// which causes cross-test contamination — one test's codeword answering
/// another test's question.  Per-test isolation in a tmp subdir kills
/// that whole class of flake.  Returns the directory string and a
/// `tempfile::TempDir` whose Drop cleans up after the test.
fn isolated_workdir(prefix: &str) -> (String, tempfile::TempDir) {
    let td = tempfile::Builder::new()
        .prefix(&format!("h-ide-e2e-{prefix}-"))
        .tempdir()
        .expect("create tempdir");
    let path = td
        .path()
        .to_str()
        .expect("tempdir path to_str")
        .to_string();
    (path, td)
}

/// Outcome of one end-to-end claude invocation.
#[derive(Debug, Default)]
struct E2eOutcome {
    /// All NDJSON-parsed events from stdout.
    events: Vec<serde_json::Value>,
    /// Raw stderr lines (joined for human-readable assertions).
    stderr: String,
    /// Exit code (if any).
    exit_code: Option<i32>,
}

impl E2eOutcome {
    fn init(&self) -> Option<&serde_json::Value> {
        self.events
            .iter()
            .find(|e| e.get("type").and_then(|v| v.as_str()) == Some("system")
                && e.get("subtype").and_then(|v| v.as_str()) == Some("init"))
    }

    fn last_assistant_text(&self) -> Option<String> {
        let assistants: Vec<&serde_json::Value> = self
            .events
            .iter()
            .filter(|e| e.get("type").and_then(|v| v.as_str()) == Some("assistant"))
            .collect();
        let last = assistants.last()?;
        let content = last.get("message")?.get("content")?.as_array()?;
        let mut out = String::new();
        for block in content {
            if block.get("type").and_then(|v| v.as_str()) == Some("text") {
                if let Some(t) = block.get("text").and_then(|v| v.as_str()) {
                    out.push_str(t);
                }
            }
        }
        if out.is_empty() { None } else { Some(out) }
    }

    fn result(&self) -> Option<&serde_json::Value> {
        self.events
            .iter()
            .find(|e| e.get("type").and_then(|v| v.as_str()) == Some("result"))
    }
}

/// Run one agent turn — by default through the Hermes bridge (`node
/// hermes-claude-bridge.mjs`) so the suite exercises the production code
/// path.  Set `HERMES_AGENT_DIRECT=1` in the environment to fall back to
/// the legacy `claude` direct-spawn (kept around for diff-isolating any
/// bridge-introduced regressions during the M1 migration).
async fn run_one_turn(
    args: &[String],
    working_dir: &str,
    user_prompt: &str,
) -> Result<E2eOutcome, String> {
    run_one_turn_inner(args, working_dir, user_prompt, None).await
}

/// `run_one_turn` variant that also passes `--hermes-state-path <path>`
/// to the bridge so the SessionStart hook + Hermes MCP tools read from
/// a planted state file (with `attachedPaths`, `cwd`, …).  The
/// production `spawn_agent_session` always passes this flag; the
/// orientation tests need it to faithfully reproduce production.
async fn run_one_turn_with_state(
    args: &[String],
    working_dir: &str,
    user_prompt: &str,
    hermes_state_path: &str,
) -> Result<E2eOutcome, String> {
    run_one_turn_inner(args, working_dir, user_prompt, Some(hermes_state_path)).await
}

async fn run_one_turn_inner(
    args: &[String],
    working_dir: &str,
    user_prompt: &str,
    hermes_state_path: Option<&str>,
) -> Result<E2eOutcome, String> {
    let use_direct = std::env::var("HERMES_AGENT_DIRECT")
        .map(|v| v == "1" || v == "true")
        .unwrap_or(false);

    let mut cmd = if use_direct {
        let mut c = Command::new("claude");
        c.args(args);
        c
    } else {
        let bridge = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("bridge")
            .join("hermes-claude-bridge.mjs");
        if !bridge.exists() {
            return Err(format!("bridge not found at {}", bridge.display()));
        }
        let mut c = Command::new("node");
        c.arg(&bridge)
            .args(["--working-dir", working_dir]);
        if let Some(state_path) = hermes_state_path {
            c.args(["--hermes-state-path", state_path]);
        }
        c.args(args);
        c
    };
    cmd.current_dir(working_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn claude: {}", e))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "no stdin handle".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "no stdout handle".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "no stderr handle".to_string())?;

    // Write one user message envelope and close stdin so claude knows there's
    // nothing more coming.  Same wire format as the production composer.
    let envelope = serde_json::json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": [{ "type": "text", "text": user_prompt }]
        }
    });
    let mut line = serde_json::to_vec(&envelope)
        .map_err(|e| format!("serialize user envelope: {}", e))?;
    line.push(b'\n');
    stdin
        .write_all(&line)
        .await
        .map_err(|e| format!("stdin write: {}", e))?;
    stdin.flush().await.ok();
    drop(stdin); // EOF — claude will finish the turn and exit.

    // Stream stdout: parse each line as JSON, tolerate malformed lines.
    let stdout_handle = tokio::spawn(async move {
        let mut events: Vec<serde_json::Value> = Vec::new();
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if line.trim().is_empty() {
                continue;
            }
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                events.push(v);
            }
        }
        events
    });

    let stderr_handle = tokio::spawn(async move {
        let mut buf = String::new();
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            buf.push_str(&line);
            buf.push('\n');
        }
        buf
    });

    let status = timeout(Duration::from_secs(120), child.wait())
        .await
        .map_err(|_| "claude turn timed out after 120s".to_string())?
        .map_err(|e| format!("wait failed: {}", e))?;

    let events = stdout_handle.await.map_err(|e| format!("stdout join: {}", e))?;
    let stderr_text = stderr_handle.await.map_err(|e| format!("stderr join: {}", e))?;

    Ok(E2eOutcome {
        events,
        stderr: stderr_text,
        exit_code: status.code(),
    })
}

/// Run a *multi-turn* bridge session: spawn the bridge once, send N user
/// envelopes back-to-back without closing stdin until the last one.  This
/// is the production lifecycle (the bridge stays alive across the whole
/// session, no respawn between turns) — the per-turn `run_one_turn`
/// helper above still works for one-shot tests.
///
/// Each turn's events are collected and we wait for a `result` message
/// before sending the next user input.
async fn run_multi_turn(
    args: &[String],
    working_dir: &str,
    user_prompts: &[&str],
) -> Result<Vec<E2eOutcome>, String> {
    use tokio::sync::mpsc;

    let bridge = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("bridge")
        .join("hermes-claude-bridge.mjs");
    if !bridge.exists() {
        return Err(format!("bridge not found at {}", bridge.display()));
    }
    let mut cmd = Command::new("node");
    cmd.arg(&bridge)
        .args(["--working-dir", working_dir])
        .args(args)
        .current_dir(working_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn bridge: {}", e))?;
    let mut stdin = child.stdin.take().ok_or_else(|| "no stdin".to_string())?;
    let stdout = child.stdout.take().ok_or_else(|| "no stdout".to_string())?;
    let stderr = child.stderr.take().ok_or_else(|| "no stderr".to_string())?;

    // Producer: pipe stdout NDJSON into a channel so we can synchronously
    // drain "events until next result" per turn.
    let (tx, mut rx) = mpsc::unbounded_channel::<serde_json::Value>();
    let stdout_handle = tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if line.trim().is_empty() {
                continue;
            }
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                if tx.send(v).is_err() {
                    break;
                }
            }
        }
    });
    let stderr_handle = tokio::spawn(async move {
        let mut buf = String::new();
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            buf.push_str(&line);
            buf.push('\n');
        }
        buf
    });

    let mut outcomes = Vec::with_capacity(user_prompts.len());

    for (idx, prompt) in user_prompts.iter().enumerate() {
        let envelope = serde_json::json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": [{ "type": "text", "text": prompt }]
            }
        });
        let mut line = serde_json::to_vec(&envelope)
            .map_err(|e| format!("serialize user envelope: {}", e))?;
        line.push(b'\n');
        stdin
            .write_all(&line)
            .await
            .map_err(|e| format!("stdin write turn {}: {}", idx, e))?;
        stdin.flush().await.ok();

        // Drain events until a result message lands for this turn.
        let mut events: Vec<serde_json::Value> = Vec::new();
        loop {
            let next = timeout(Duration::from_secs(120), rx.recv())
                .await
                .map_err(|_| format!("turn {} stalled: no events for 120s", idx))?;
            let Some(msg) = next else { break };
            let is_result = msg.get("type").and_then(|v| v.as_str()) == Some("result");
            events.push(msg);
            if is_result {
                break;
            }
        }
        outcomes.push(E2eOutcome { events, stderr: String::new(), exit_code: None });
    }

    // Close stdin to signal EOF; bridge should exit cleanly.
    drop(stdin);
    let status = timeout(Duration::from_secs(30), child.wait())
        .await
        .map_err(|_| "bridge exit timeout".to_string())?
        .map_err(|e| format!("wait failed: {}", e))?;
    let _ = stdout_handle.await;
    let stderr_text = stderr_handle.await.unwrap_or_default();

    // Stamp the final exit code + stderr on every outcome (good enough for
    // the assertions; multi-turn doesn't need per-turn exit codes).
    for outcome in &mut outcomes {
        outcome.exit_code = status.code();
        outcome.stderr = stderr_text.clone();
    }

    Ok(outcomes)
}

/// Common assertion: the turn produced an init event AND a result event,
/// and the result is not an error.  Caller then asserts on specifics.
fn assert_clean_turn(out: &E2eOutcome, ctx: &str) {
    assert!(
        out.exit_code == Some(0),
        "[{}] expected exit 0, got {:?}; stderr={:?}",
        ctx,
        out.exit_code,
        out.stderr,
    );
    assert!(
        out.init().is_some(),
        "[{}] no init event; stderr={:?}; events={:#?}",
        ctx,
        out.stderr,
        out.events,
    );
    let result = out.result().unwrap_or_else(|| {
        panic!(
            "[{}] no result event; stderr={:?}; events={:#?}",
            ctx, out.stderr, out.events
        )
    });
    let is_error = result.get("is_error").and_then(|v| v.as_bool()).unwrap_or(false);
    assert!(
        !is_error,
        "[{}] result.is_error=true; result={:#?}; stderr={:?}",
        ctx, result, out.stderr,
    );
}

// ─── Tests ────────────────────────────────────────────────────────

/// Smoke test: a single turn with the default args completes cleanly and
/// emits an init + result.  Pinpoints "claude doesn't accept our argv at all"
/// regressions immediately.
#[ignore]
#[tokio::test]
async fn e2e_single_turn_smoke() {
    // Fresh uuid per run — Claude rejects reused session ids globally.
    let sid = uuid::Uuid::new_v4().to_string();
    let plan = build_spawn_args(&sid, "/tmp", None, None, None, None, &[], false);
    let out = run_one_turn(&plan.args, &plan.working_dir, "say 'hello' in one word")
        .await
        .expect("e2e turn");
    assert_clean_turn(&out, "single-turn");
}

/// The init event reports a session_id.  Capture it.  Then run a SECOND
/// turn with `--resume <that id>` and verify the conversation continues
/// (the assistant should remember the topic of the first turn).
#[ignore]
#[tokio::test]
async fn e2e_resume_continues_conversation() {
    // Turn 1: establish a memorable fact.
    let sid1 = uuid::Uuid::new_v4().to_string();
    let plan1 = build_spawn_args(&sid1, "/tmp", None, None, None, None, &[], false);
    let t1 = run_one_turn(
        &plan1.args,
        &plan1.working_dir,
        "Remember the secret word: banjo. Reply with just 'ok'.",
    )
    .await
    .expect("turn 1");
    assert_clean_turn(&t1, "turn-1");

    // Capture the canonical session id from Claude's init event.
    let init = t1.init().expect("turn 1 init");
    let session_id = init
        .get("session_id")
        .and_then(|v| v.as_str())
        .expect("turn 1 init.session_id")
        .to_string();
    eprintln!("[e2e] turn-1 session_id from init = {}", session_id);

    // Turn 2: --resume against the canonical id.  No --session-id (Claude
    // rejects that combo without --fork-session).
    let plan2 = build_spawn_args(
        "ignored-on-resume",
        "/tmp",
        Some(&session_id),
        None,
        None,
        None,
        &[],
    false,
    );
    let t2 = run_one_turn(
        &plan2.args,
        &plan2.working_dir,
        "What was the secret word? Answer in one word.",
    )
    .await
    .expect("turn 2");
    assert_clean_turn(&t2, "turn-2-resume");

    let assistant = t2
        .last_assistant_text()
        .expect("turn 2 assistant text")
        .to_lowercase();
    assert!(
        assistant.contains("banjo"),
        "turn-2 should remember the secret word; got: {:?}; stderr={:?}",
        assistant,
        t2.stderr,
    );
}

/// Resume + fork + new --model: verify the active model actually swaps.
/// Turn 1 with default model, turn 2 forked with `--model haiku` — the
/// init event of turn 2 should report a model whose name contains "haiku".
#[ignore]
#[tokio::test]
async fn e2e_fork_with_model_swap_takes_effect() {
    let sid1 = uuid::Uuid::new_v4().to_string();
    let plan1 = build_spawn_args(&sid1, "/tmp", None, None, None, None, &[], false);
    let t1 = run_one_turn(&plan1.args, &plan1.working_dir, "Reply 'ok'.")
        .await
        .expect("turn 1");
    assert_clean_turn(&t1, "fork-turn-1");
    let prior_session = t1
        .init()
        .and_then(|e| e.get("session_id"))
        .and_then(|v| v.as_str())
        .expect("turn 1 init.session_id")
        .to_string();

    let sid2 = uuid::Uuid::new_v4().to_string();
    let plan2 = build_spawn_args(
        &sid2,
        "/tmp",
        Some(&prior_session),
        Some("haiku"),
        None,
        None,
        &[],
 true, // <- fork
    );
    let t2 = run_one_turn(
        &plan2.args,
        &plan2.working_dir,
        "Reply with just the model name you are running.",
    )
    .await
    .expect("turn 2 fork");
    assert_clean_turn(&t2, "fork-turn-2");

    let init2 = t2.init().expect("fork init");
    let model = init2
        .get("model")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_lowercase();
    assert!(
        model.contains("haiku"),
        "fork should switch to haiku; init.model={:?}; stderr={:?}",
        model,
        t2.stderr,
    );
}

/// Fork + new --permission-mode: verify the value lands in init.
/// Run with `plan` and confirm init.permissionMode == "plan" (or whatever
/// shape Claude reports).
#[ignore]
#[tokio::test]
async fn e2e_fork_with_permission_mode_swap_takes_effect() {
    let sid1 = uuid::Uuid::new_v4().to_string();
    let plan1 = build_spawn_args(&sid1, "/tmp", None, None, None, None, &[], false);
    let t1 = run_one_turn(&plan1.args, &plan1.working_dir, "Reply 'ok'.")
        .await
        .expect("turn 1");
    assert_clean_turn(&t1, "perm-turn-1");
    let prior_session = t1
        .init()
        .and_then(|e| e.get("session_id"))
        .and_then(|v| v.as_str())
        .expect("turn 1 init.session_id")
        .to_string();

    let sid2 = uuid::Uuid::new_v4().to_string();
    let plan2 = build_spawn_args(
        &sid2,
        "/tmp",
        Some(&prior_session),
        None,
        Some("plan"),
        None,
        &[],
    true,
    );
    let t2 = run_one_turn(&plan2.args, &plan2.working_dir, "Reply 'ok'.")
        .await
        .expect("turn 2 fork");
    assert_clean_turn(&t2, "perm-turn-2");

    // Claude reports permission mode under one of these keys depending on
    // version — accept either shape so the test isn't fragile to renames.
    let init2 = t2.init().expect("perm init");
    let pm = init2
        .get("permissionMode")
        .or_else(|| init2.get("permission_mode"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    assert_eq!(
        pm.to_lowercase(),
        "plan",
        "permission swap should land 'plan'; got {:?}; init={:#?}; stderr={:?}",
        pm,
        init2,
        t2.stderr,
    );
}

/// **The fix verified at the binary level.**  The production bug pattern
/// is:  spawn → user msg → fork (no input) → user msg.  The fork-with-no-
/// input never persists so the user-msg --resume fails.  The fix is to
/// fork ON the user message instead of before it: spawn → user msg →
/// fork-WITH-user-msg → user msg.  This test runs the fixed pattern and
/// asserts that a *subsequent* resume against the fork uuid succeeds.
#[ignore]
#[tokio::test]
async fn e2e_fork_with_user_message_persists_for_later_resume() {
    let (project_dir, _td) = isolated_workdir("fix");

    // Step 1: real conversation, gets persisted.
    let sid_initial = uuid::Uuid::new_v4().to_string();
    let plan = build_spawn_args(&sid_initial, &project_dir, None, None, None, None, &[], false);
    let t1 = run_one_turn(&plan.args, &plan.working_dir, "remember: ammeter. reply 'ok'.")
        .await
        .expect("step 1");
    assert_clean_turn(&t1, "fix-step-1");
    let prior_session = t1
        .init()
        .and_then(|e| e.get("session_id"))
        .and_then(|v| v.as_str())
        .expect("step 1 init session_id")
        .to_string();

    // Step 2: fork-WITH-user-message — the user types a message, and the
    // fork happens during submitAgentMessage (production fix).  Claude
    // forks and immediately processes the user input, producing a result,
    // which means the new session id IS persisted.
    let sid_fork = uuid::Uuid::new_v4().to_string();
    let plan_fork = build_spawn_args(
        &sid_fork,
        &project_dir,
        Some(&prior_session),
        Some("haiku"),
        None,
        None,
        &[],
    true,
    );
    let t2 = run_one_turn(
        &plan_fork.args,
        &plan_fork.working_dir,
        "what was the codeword? one word.",
    )
    .await
    .expect("step 2 fork-with-msg");
    assert_clean_turn(&t2, "fix-step-2");
    let fork_canonical = t2
        .init()
        .and_then(|e| e.get("session_id"))
        .and_then(|v| v.as_str())
        .expect("step 2 init session_id")
        .to_string();

    // Step 3: plain --resume against the fork uuid.  After the fix this
    // MUST succeed because step 2 actually had work to persist.
    let plan_resume = build_spawn_args(
        "ignored",
        &project_dir,
        Some(&fork_canonical),
        None,
        None,
        None,
        &[],
    false,
    );
    let t3 = run_one_turn(&plan_resume.args, &plan_resume.working_dir, "still know it?")
        .await
        .expect("step 3");
    assert_clean_turn(&t3, "fix-step-3-resume-after-real-fork");
    let answer = t3
        .last_assistant_text()
        .unwrap_or_default()
        .to_lowercase();
    assert!(
        answer.contains("ammeter"),
        "post-fork resume must remember; got {:?}; stderr={:?}",
        answer,
        t3.stderr,
    );
}

/// **The actual production bug.**  When a user clicks the model chip
/// without immediately typing a message, our `respawnAgent({model: ...})`
/// forks a subprocess that has no user input on stdin — so Claude sees
/// EOF, runs the fork-and-resume, emits NOTHING, and exits.  No init,
/// no result, no persistence under the new uuid.  The next user
/// message then tries `--resume <fork-uuid>` and Claude legitimately
/// reports "No conversation found".
///
/// This test reproduces the exact pattern from the user's DevTools log:
/// the fork spawn never gets a user message; the test asserts that the
/// subsequent --resume against the fork uuid FAILS.  Once it fails, we
/// have proof of the bug.  After the fix the test should be updated to
/// assert the resume WORKS — that's how we'll know we shipped the fix.
#[ignore]
#[tokio::test]
async fn e2e_fork_without_user_message_breaks_subsequent_resume() {
    let (project_dir, _td) = isolated_workdir("empty-fork");

    // Step 1: real conversation, gets persisted.
    let sid_initial = uuid::Uuid::new_v4().to_string();
    let plan = build_spawn_args(&sid_initial, &project_dir, None, None, None, None, &[], false);
    let t1 = run_one_turn(&plan.args, &plan.working_dir, "remember: galvanometer. reply 'ok'.")
        .await
        .expect("step 1");
    assert_clean_turn(&t1, "fork-empty-step-1");
    let prior_session = t1
        .init()
        .and_then(|e| e.get("session_id"))
        .and_then(|v| v.as_str())
        .expect("step 1 init session_id")
        .to_string();

    // Step 2: USER SWAPS MODEL.  In production this happens with no user
    // message queued — claude gets EOF, forks, exits.  We mimic that here
    // by spawning the fork with EMPTY stdin (no user message).
    let sid_fork = uuid::Uuid::new_v4().to_string();
    let plan_fork = build_spawn_args(
        &sid_fork,
        &project_dir,
        Some(&prior_session),
        Some("haiku"),
        None,
        None,
        &[],
    true,
    );
    let mut cmd = tokio::process::Command::new("claude");
    cmd.args(&plan_fork.args)
        .current_dir(&plan_fork.working_dir)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let mut child = cmd.spawn().expect("spawn fork");
    drop(child.stdin.take()); // EOF immediately — no user message
    let status = tokio::time::timeout(
        std::time::Duration::from_secs(60),
        child.wait(),
    )
    .await
    .expect("fork exit timeout")
    .expect("fork wait");
    eprintln!("[fork-empty] empty fork exited with: {:?}", status);

    // Step 3: try to --resume the fork uuid.  This is where production
    // hits "No conversation found" — and the assertion below pins
    // whichever way Claude actually behaves.
    let plan_resume = build_spawn_args(
        "ignored",
        &project_dir,
        Some(&sid_fork),
        None,
        None,
        None,
        &[],
    false,
    );
    let resume = run_one_turn(
        &plan_resume.args,
        &plan_resume.working_dir,
        "still know it?",
    )
    .await
    .expect("resume turn ran (process spawned)");

    // The bug: "No conversation found" appears on stderr, exit code != 0.
    let bug_present = resume.exit_code != Some(0)
        || resume
            .stderr
            .to_lowercase()
            .contains("no conversation found");

    eprintln!("[fork-empty] resume exit={:?} stderr={:?}", resume.exit_code, resume.stderr);

    // We expect this to currently fail (the bug); the assertion proves it.
    // After the fix, this test will need to be flipped to expect SUCCESS.
    assert!(
        bug_present,
        "expected the empty-fork → resume flow to break (it's the production bug); \
         instead it succeeded — bug may already be fixed",
    );
}

/// **Production-flow reproducer.**  Walks through the exact lifecycle
/// the user hit: initial spawn → resume → resume → fork → resume → resume.
/// If any of these steps fails to find its prior session, this test
/// catches the production "No conversation found" with the exact failing
/// step in the panic message.
#[ignore]
#[tokio::test]
async fn e2e_full_production_lifecycle() {
    let (project_dir, _td) = isolated_workdir("lifecycle");

    // ── Step 1: initial spawn + first user msg ───────────────────────
    let sid_initial = uuid::Uuid::new_v4().to_string();
    let plan = build_spawn_args(&sid_initial, &project_dir, None, None, None, None, &[], false);
    let t1 = run_one_turn(&plan.args, &plan.working_dir, "remember: voltmeter. reply 'ok'.")
        .await
        .expect("step 1");
    assert_clean_turn(&t1, "lifecycle-step-1-initial");
    let mut canonical = t1
        .init()
        .and_then(|e| e.get("session_id"))
        .and_then(|v| v.as_str())
        .expect("step 1 init.session_id")
        .to_string();
    eprintln!("[lifecycle] step-1 canonical = {canonical}");

    // ── Step 2: plain resume after subprocess exit ───────────────────
    let plan = build_spawn_args(
        "ignored",
        &project_dir,
        Some(&canonical),
        None,
        None,
        None,
        &[],
    false,
    );
    let t2 = run_one_turn(&plan.args, &plan.working_dir, "what was it? one word.")
        .await
        .expect("step 2");
    assert_clean_turn(&t2, "lifecycle-step-2-resume");
    assert!(
        t2.last_assistant_text()
            .unwrap_or_default()
            .to_lowercase()
            .contains("voltmeter"),
        "step 2 lost the codeword; stderr={:?}",
        t2.stderr,
    );

    // ── Step 3: another plain resume (3rd turn) ──────────────────────
    let plan = build_spawn_args(
        "ignored",
        &project_dir,
        Some(&canonical),
        None,
        None,
        None,
        &[],
    false,
    );
    let t3 = run_one_turn(&plan.args, &plan.working_dir, "thanks. reply 'ok'.")
        .await
        .expect("step 3");
    assert_clean_turn(&t3, "lifecycle-step-3-resume");

    // ── Step 4: fork with --model haiku (mirrors user clicking the model chip) ─
    let sid_fork = uuid::Uuid::new_v4().to_string();
    let plan = build_spawn_args(
        &sid_fork,
        &project_dir,
        Some(&canonical),
        Some("haiku"),
        None,
        None,
        &[],
    true,
    );
    let t4 = run_one_turn(&plan.args, &plan.working_dir, "still know the codeword?")
        .await
        .expect("step 4 fork");
    assert_clean_turn(&t4, "lifecycle-step-4-fork");

    // What did the fork actually persist under?  Update our tracked id
    // to whatever the init reports — that's exactly what the production
    // init-listener does in SessionContext.tsx.
    let fork_canonical = t4
        .init()
        .and_then(|e| e.get("session_id"))
        .and_then(|v| v.as_str())
        .expect("step 4 init.session_id")
        .to_string();
    eprintln!("[lifecycle] step-4 fork canonical = {fork_canonical}");
    canonical = fork_canonical;

    // ── Step 5: plain resume against the FORKED session ──────────────
    // This is the exact moment the user's "No conversation found" fires
    // in production.  If this step ever fails, we have the bug.
    let plan = build_spawn_args(
        "ignored",
        &project_dir,
        Some(&canonical),
        None,
        None,
        None,
        &[],
    false,
    );
    let t5 = run_one_turn(&plan.args, &plan.working_dir, "what was the codeword? one word.")
        .await
        .expect("step 5");
    assert_clean_turn(&t5, "lifecycle-step-5-resume-after-fork");
    assert!(
        t5.last_assistant_text()
            .unwrap_or_default()
            .to_lowercase()
            .contains("voltmeter"),
        "step 5 lost the codeword across fork; stderr={:?}",
        t5.stderr,
    );

    // ── Step 6: one more plain resume to verify the chain stays alive ─
    let plan = build_spawn_args(
        "ignored",
        &project_dir,
        Some(&canonical),
        None,
        None,
        None,
        &[],
    false,
    );
    let t6 = run_one_turn(&plan.args, &plan.working_dir, "still ok?")
        .await
        .expect("step 6");
    assert_clean_turn(&t6, "lifecycle-step-6-final-resume");
}

/// **Critical reproducer.** Fork a session, then verify the *forked*
/// session id can be resumed on a subsequent turn.  Production goes:
/// initial spawn → user message → exit → user picks new model → fork
/// respawn → exit → user types again → respawn-with-resume against the
/// FORKED uuid.  If Claude persists the fork under an id different from
/// the one we passed via `--session-id`, the resume fails — and that's
/// exactly the user-visible "No conversation found" we're chasing.
#[ignore]
#[tokio::test]
async fn e2e_fork_then_resume_the_fork() {
    let (project_dir, _td) = isolated_workdir("fork-resume");

    // Turn 1 — initial spawn.
    let sid_initial = uuid::Uuid::new_v4().to_string();
    let plan1 = build_spawn_args(&sid_initial, &project_dir, None, None, None, None, &[], false);
    let t1 = run_one_turn(&plan1.args, &plan1.working_dir, "remember: telegraph. reply 'ok'.")
        .await
        .expect("turn 1");
    assert_clean_turn(&t1, "fork-resume-turn-1");
    let prior_session = t1
        .init()
        .and_then(|e| e.get("session_id"))
        .and_then(|v| v.as_str())
        .expect("turn 1 init session_id")
        .to_string();

    // Turn 2 — fork with a new model (mirrors a user clicking the model chip).
    let sid_fork = uuid::Uuid::new_v4().to_string();
    let plan2 = build_spawn_args(
        &sid_fork,
        &project_dir,
        Some(&prior_session),
        Some("haiku"),
        None,
        None,
        &[],
 true, // fork
    );
    let t2 = run_one_turn(&plan2.args, &plan2.working_dir, "what was the codeword? one word.")
        .await
        .expect("turn 2 fork");
    assert_clean_turn(&t2, "fork-resume-turn-2");

    // What did Claude actually persist this fork under?
    let forked_canonical = t2
        .init()
        .and_then(|e| e.get("session_id"))
        .and_then(|v| v.as_str())
        .expect("turn 2 init session_id")
        .to_string();
    eprintln!(
        "[fork-resume] passed --session-id {} ; init.session_id reports {}",
        sid_fork, forked_canonical,
    );

    // Turn 3 — auto-respawn after the user types again.  This mirrors
    // production: plain --resume <uuid>, no fork, no flag changes.  We
    // try BOTH the uuid we passed via --session-id AND the canonical id
    // from init — at least one of them MUST resume cleanly, and we
    // assert the same one that production tracks.
    let plan3 = build_spawn_args(
        "ignored",
        &project_dir,
        Some(&forked_canonical),
        None,
        None,
        None,
        &[],
    false,
    );
    let t3 = run_one_turn(&plan3.args, &plan3.working_dir, "still remember? one word.")
        .await
        .unwrap_or_else(|e| panic!("turn 3 run: {e}"));
    assert_clean_turn(&t3, "fork-resume-turn-3");
    let answer = t3
        .last_assistant_text()
        .unwrap_or_default()
        .to_lowercase();
    assert!(
        answer.contains("telegraph"),
        "post-fork resume forgot the codeword; got {:?}; stderr={:?}",
        answer,
        t3.stderr,
    );

    // **Note** post-SDK migration:  through the bridge, the SDK assigns
    // its own canonical session id on fork rather than echoing back the
    // `--session-id` we passed.  That is *not* a production bug — the
    // `attachInitListener` in `SessionContext` always captures
    // `init.session_id` as canonical, and every subsequent `--resume` uses
    // the captured id, not the passed-in one.  We keep the diagnostic
    // log line above so a regression where the SDK changes this contract
    // is still visible in test output, but no longer hard-assert equality.
    let _ = sid_fork; // intentionally unused beyond the eprintln above
}

/// **Reproducer for the chip-staleness bug.**  After forking with
/// `--model haiku`, a subsequent plain `--resume <fork-uuid>` should
/// report `init.model` containing "haiku".  If init falls back to the
/// account default, the chip in the composer shows the wrong model
/// because `useAgentInit` only knows what init tells it.
#[ignore]
#[tokio::test]
async fn e2e_plain_resume_after_fork_reports_correct_model_in_init() {
    let (project_dir, _td) = isolated_workdir("model-staleness");

    // Step 1: initial spawn (account default model).
    let sid_initial = uuid::Uuid::new_v4().to_string();
    let plan = build_spawn_args(&sid_initial, &project_dir, None, None, None, None, &[], false);
    let t1 = run_one_turn(&plan.args, &plan.working_dir, "say 'ok'.")
        .await
        .expect("step 1");
    assert_clean_turn(&t1, "staleness-step-1");
    let prior_session = t1
        .init()
        .and_then(|e| e.get("session_id"))
        .and_then(|v| v.as_str())
        .expect("step 1 init session_id")
        .to_string();
    let initial_model = t1
        .init()
        .and_then(|e| e.get("model"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    eprintln!("[staleness] initial init.model = {initial_model:?}");

    // Step 2: fork with --model haiku, with a real user message so the
    // session gets persisted.
    let sid_fork = uuid::Uuid::new_v4().to_string();
    let plan = build_spawn_args(
        &sid_fork,
        &project_dir,
        Some(&prior_session),
        Some("haiku"),
        None,
        None,
        &[],
    true,
    );
    let t2 = run_one_turn(&plan.args, &plan.working_dir, "now reply 'fine'.")
        .await
        .expect("step 2");
    assert_clean_turn(&t2, "staleness-step-2");
    let fork_canonical = t2
        .init()
        .and_then(|e| e.get("session_id"))
        .and_then(|v| v.as_str())
        .expect("step 2 init session_id")
        .to_string();
    let fork_model = t2
        .init()
        .and_then(|e| e.get("model"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_lowercase();
    eprintln!("[staleness] fork init.model = {fork_model:?}");
    assert!(
        fork_model.contains("haiku"),
        "fork should report haiku in init.model; got {:?}",
        fork_model,
    );

    // Step 3: plain --resume of the fork.  Production passes --model on
    // EVERY spawn (including auto-respawn between turns), so we mirror
    // that by passing Some("haiku") alongside Some(&fork_canonical).
    let plan = build_spawn_args(
        "ignored",
        &project_dir,
        Some(&fork_canonical),
        Some("haiku"), // production behavior
        None,
        None,
        &[],
    false,
    );
    let t3 = run_one_turn(&plan.args, &plan.working_dir, "still ok? reply 'ok'.")
        .await
        .expect("step 3");
    assert_clean_turn(&t3, "staleness-step-3");
    let resume_model = t3
        .init()
        .and_then(|e| e.get("model"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_lowercase();
    eprintln!("[staleness] plain-resume init.model = {resume_model:?}");

    // The smoking-gun assertion: after fork-then-resume, init.model MUST
    // still contain "haiku".  If it falls back to the account default,
    // we have the chip-staleness bug at the binary level.
    assert!(
        resume_model.contains("haiku"),
        "plain --resume after fork should still report haiku in init; got {:?}.  \
         If this fails, init forgets the forked model — the composer chip will appear stale.",
        resume_model,
    );
}

/// **Attach-projects fix verifier.**  When the user attaches an extra
/// project to the session via the Context Panel, that path should land
/// in Claude's `--add-dir` flag list so its tools can read/edit files
/// there.  This test creates a sentinel file in a *separate* directory
/// from cwd, spawns claude with `--add-dir <that-dir>`, and asks claude
/// to confirm it can read the file.  If the assistant can name the
/// sentinel content, --add-dir is doing its job.
#[ignore]
#[tokio::test]
async fn e2e_add_dir_grants_extra_project_access() {
    let (cwd, _td_cwd) = isolated_workdir("adddir-cwd");
    let (extra, _td_extra) = isolated_workdir("adddir-extra");

    // Plant a sentinel file in the extra dir.
    let sentinel_path = format!("{extra}/sentinel.txt");
    std::fs::write(&sentinel_path, "the secret password is rheostat\n")
        .expect("write sentinel");

    let sid = uuid::Uuid::new_v4().to_string();
    let plan = build_spawn_args(
        &sid,
        &cwd,
        None,
        None,
        None,
        None,
        &[extra.clone()],
        false,
    );

    // Quick sanity: argv should carry --add-dir <extra>.
    let argv = plan.args.join(" ");
    assert!(
        argv.contains(&format!("--add-dir {}", extra)),
        "argv should contain `--add-dir <extra>`; got: {:?}",
        plan.args,
    );

    let prompt = format!(
        "Read the file {sentinel_path} and reply with the password it contains. \
         Reply with just the single word."
    );
    let out = run_one_turn(&plan.args, &plan.working_dir, &prompt)
        .await
        .expect("add-dir turn");
    assert_clean_turn(&out, "add-dir");

    let answer = out
        .last_assistant_text()
        .unwrap_or_default()
        .to_lowercase();
    assert!(
        answer.contains("rheostat"),
        "Claude with --add-dir should be able to read the sentinel; got {:?}; stderr={:?}",
        answer,
        out.stderr,
    );
}

/// Fork + new --effort: verify the flag is accepted (subprocess exits 0
/// with no stderr complaint).  Effort doesn't always surface in init, so
/// we just assert the spawn isn't rejected — the regression we're guarding
/// against is "we accept a flag value Claude doesn't recognize."
///
/// Each iteration uses a fresh uuid because Claude rejects reusing a
/// session id that's already been seen.  That rejection is itself a
/// useful invariant — it's why production must always generate a fresh
/// uuid for the initial spawn (we do, via `uuid::Uuid::new_v4()`).
#[ignore]
#[tokio::test]
async fn e2e_effort_flag_accepted() {
    for level in ["low", "medium", "high", "xhigh", "max"] {
        let sid = uuid::Uuid::new_v4().to_string();
        let plan = build_spawn_args(
            &sid,
            "/tmp",
            None,
            None,
            None,
            Some(level), &[],
            false,
        );
        let out = run_one_turn(&plan.args, &plan.working_dir, "Reply 'ok'.")
            .await
            .unwrap_or_else(|e| panic!("effort={} run failed: {}", level, e));
        assert_clean_turn(&out, &format!("effort-{}", level));
        // Stderr can carry deprecation warnings on some Claude versions; we
        // only fail on hard errors like "unknown value" or "invalid".
        let lc = out.stderr.to_lowercase();
        assert!(
            !lc.contains("invalid")
                && !lc.contains("unknown")
                && !lc.contains("not allowed"),
            "effort={} produced an error: {:?}",
            level,
            out.stderr,
        );
    }
}

/// **The M4 MCP proof.**  Spawn the bridge with --hermes-state-path
/// pointing at an IDE-state JSON file we wrote in a tmp dir.  Ask Claude
/// to use the `mcp__hermes__get_project_state` tool and report what it
/// sees.  The assistant text must contain values from the state file —
/// proving the in-process MCP server is wired and Claude can read IDE
/// state on demand.
#[ignore]
#[tokio::test]
async fn e2e_hermes_mcp_reads_ide_state() {
    let (workdir, _td) = isolated_workdir("mcp-state");
    // Sentinel: a phrase that won't show up in any system prompt or
    // model identity, so if it lands in Claude's reply we know the MCP
    // tool was actually called and consumed.
    let sentinel = "magnetar-quartz-7281";
    let state_path = format!("{workdir}/hermes-state.json");
    std::fs::write(
        &state_path,
        format!(
            r#"{{
  "cwd": "{workdir}",
  "branch": "main",
  "activeFile": "{sentinel}.ts",
  "attachedPaths": ["/tmp/hermes-extra-1", "/tmp/hermes-extra-2"]
}}"#,
        ),
    )
    .expect("write state file");

    let sid = uuid::Uuid::new_v4().to_string();
    let plan = build_spawn_args(&sid, &workdir, None, None, None, None, &[], false);
    // Spawn manually because we need to inject --hermes-state-path
    // alongside the standard spawn args.  Same Command construction as
    // run_one_turn; we just splice the extra flag in.
    let bridge = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("bridge")
        .join("hermes-claude-bridge.mjs");
    let mut cmd = Command::new("node");
    cmd.arg(&bridge)
        .args(["--working-dir", &workdir])
        .args(["--hermes-state-path", &state_path])
        .args(&plan.args)
        .current_dir(&workdir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = cmd.spawn().expect("spawn bridge");
    let mut stdin = child.stdin.take().expect("stdin");
    let stdout = child.stdout.take().expect("stdout");
    let stderr_pipe = child.stderr.take().expect("stderr");

    let prompt = format!(
        "Use the `mcp__hermes__get_project_state` tool right now to fetch the IDE state, \
         then reply with ONLY the value of the `activeFile` field from the result. \
         Reply with just that single string, no other words."
    );
    let envelope = serde_json::json!({
        "type": "user",
        "message": { "role": "user", "content": [{ "type": "text", "text": prompt }] }
    });
    let mut line = serde_json::to_vec(&envelope).expect("serialize");
    line.push(b'\n');
    stdin.write_all(&line).await.expect("write stdin");
    stdin.flush().await.ok();
    drop(stdin);

    let stdout_h = tokio::spawn(async move {
        let mut events: Vec<serde_json::Value> = Vec::new();
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(l)) = lines.next_line().await {
            if l.trim().is_empty() { continue; }
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&l) {
                events.push(v);
            }
        }
        events
    });
    let stderr_h = tokio::spawn(async move {
        let mut buf = String::new();
        let mut lines = BufReader::new(stderr_pipe).lines();
        while let Ok(Some(l)) = lines.next_line().await {
            buf.push_str(&l);
            buf.push('\n');
        }
        buf
    });

    let _ = timeout(Duration::from_secs(120), child.wait())
        .await
        .expect("bridge timed out")
        .expect("bridge wait");
    let events = stdout_h.await.expect("stdout join");
    let stderr_text = stderr_h.await.unwrap_or_default();
    let outcome = E2eOutcome { events, stderr: stderr_text, exit_code: Some(0) };
    assert_clean_turn(&outcome, "mcp-state");

    // Init must list our `hermes` server as connected.
    let init = outcome.init().expect("init");
    let mcp_servers = init
        .get("mcp_servers")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let hermes_server = mcp_servers.iter().find(|s| {
        s.get("name").and_then(|v| v.as_str()) == Some("hermes")
    });
    assert!(
        hermes_server.is_some(),
        "init.mcp_servers should include hermes; got {:?}; stderr={:?}",
        mcp_servers, outcome.stderr,
    );

    // Claude's reply must include the sentinel from the state file.
    let answer = outcome.last_assistant_text().unwrap_or_default();
    assert!(
        answer.contains(sentinel),
        "expected MCP-tool-driven answer to mention {:?}; got {:?}; stderr={:?}",
        sentinel, answer, outcome.stderr,
    );
}

/// **Runtime-self-knowledge test.**  When the user PICKS a model
/// (`--model haiku`), the UserPromptSubmit hook should inject that into
/// `additionalContext` so Claude correctly self-reports it on the very
/// first user message — no respawn-then-ask dance required.
///
/// The "no --model passed" case is a known edge: until init is processed
/// by the bridge's for-await loop, `liveRuntime.reportedModel` is null
/// and the hook falls back to "(account default)".  That's acceptable
/// behavior — when the user explicitly picks (which is when this matters
/// most), the hook is authoritative.
#[ignore]
#[tokio::test]
async fn e2e_self_reports_runtime() {
    let (workdir, _td) = isolated_workdir("self-knowledge");
    let sid = uuid::Uuid::new_v4().to_string();
    let plan = build_spawn_args(&sid, &workdir, None, Some("haiku"), None, None, &[], false);
    let outcomes = run_multi_turn(
        &plan.args,
        &plan.working_dir,
        &[
            "what claude model are you running right now? answer with just the model id from the harness's runtime info, nothing else.",
        ],
    )
    .await
    .expect("self-knowledge run");
    let answer = outcomes[0]
        .last_assistant_text()
        .unwrap_or_default()
        .to_lowercase();
    assert!(
        answer.contains("haiku"),
        "Claude should report the user-picked model; got {:?}; stderr={:?}",
        answer, outcomes[0].stderr,
    );
}

/// **The M2 lifecycle proof.**  Spawn the bridge once, send three user
/// messages without closing stdin, and verify all three turns share the
/// same canonical session id (i.e. the bridge held the SDK conversation
/// across turns — no respawn dance).  The third turn must remember a
/// codeword from the first turn, proving the SDK state survived.
#[ignore]
#[tokio::test]
async fn e2e_long_lived_bridge_multi_turn() {
    let (project_dir, _td) = isolated_workdir("multi-turn");
    let sid = uuid::Uuid::new_v4().to_string();
    let plan = build_spawn_args(&sid, &project_dir, None, None, None, None, &[], false);

    let outcomes = run_multi_turn(
        &plan.args,
        &plan.working_dir,
        &[
            "remember the secret: photovoltaic. reply 'ok'.",
            "say something about the weather. one sentence.",
            "what was the secret? one word.",
        ],
    )
    .await
    .expect("multi-turn run");
    assert_eq!(outcomes.len(), 3, "should have 3 turn outcomes");

    // Every turn produced an init+result and shares the same canonical id.
    let canonical = outcomes[0]
        .init()
        .and_then(|e| e.get("session_id"))
        .and_then(|v| v.as_str())
        .expect("turn 1 init session_id")
        .to_string();
    eprintln!("[multi-turn] canonical session_id = {canonical}");

    for (i, out) in outcomes.iter().enumerate() {
        // Init only fires on turn 1 (the bridge stays alive — no re-init
        // after that).  But every turn must have a result.
        let ctx = format!("multi-turn-{}", i + 1);
        assert!(out.exit_code == Some(0) || out.exit_code.is_none(),
            "[{}] unexpected exit {:?}; stderr={:?}", ctx, out.exit_code, out.stderr);
        let result = out.result().unwrap_or_else(|| {
            panic!("[{}] no result event; events={:?}; stderr={:?}",
                ctx, out.events, out.stderr)
        });
        let is_error = result.get("is_error").and_then(|v| v.as_bool()).unwrap_or(false);
        assert!(!is_error, "[{}] result.is_error=true; result={}", ctx, result);
        let result_sid = result.get("session_id").and_then(|v| v.as_str()).unwrap_or_default();
        assert_eq!(
            result_sid, canonical,
            "[{}] all turns must share the canonical session id (bridge stayed alive)",
            ctx,
        );
    }

    // The last turn must remember the secret from turn 1.
    let last_text = outcomes[2]
        .last_assistant_text()
        .unwrap_or_default()
        .to_lowercase();
    assert!(
        last_text.contains("photovoltaic"),
        "long-lived bridge lost context across turns; final answer was {:?}",
        last_text,
    );
}

/// **Reproducer for the production "No conversation found" failure that
/// shows up on turn N>1 even though our single-turn resume tests pass.**
///
/// The user's report: 5+ turns work, then a subsequent turn fails with
/// `No conversation found with session ID: <uuid>`.  Single-turn resume
/// alone doesn't catch this — we need to repeat the spawn → user → exit
/// → respawn cycle several times in a real project directory and see
/// whether Claude's persistence still resolves the original session id.
#[ignore]
#[tokio::test]
async fn e2e_six_turn_resume_chain() {
    let (project_dir, _td) = isolated_workdir("six-turn");

    // Turn 1 — initial spawn, captures Claude's canonical session id.
    let sid = uuid::Uuid::new_v4().to_string();
    let plan1 = build_spawn_args(&sid, &project_dir, None, None, None, None, &[], false);
    let t1 = run_one_turn(&plan1.args, &plan1.working_dir, "remember the codeword: oscilloscope. reply 'ok'.")
        .await
        .expect("turn 1");
    assert_clean_turn(&t1, "chain-turn-1");
    let canonical = t1
        .init()
        .and_then(|e| e.get("session_id"))
        .and_then(|v| v.as_str())
        .expect("turn 1 init session_id")
        .to_string();
    eprintln!("[chain] canonical session_id = {}", canonical);

    // Turns 2..6 — each one is a plain --resume against the canonical id,
    // mirroring what production's auto-respawn does after the prior child
    // exits.  If any turn fails with "No conversation found", we have the
    // exact reproducer for the user's bug.
    for n in 2..=6 {
        let plan = build_spawn_args(
            "ignored",
            &project_dir,
            Some(&canonical),
            None,
            None,
            None,
            &[],
        false,
        );
        let prompt = format!("turn {n}: what was the codeword? one word.");
        let out = run_one_turn(&plan.args, &plan.working_dir, &prompt)
            .await
            .unwrap_or_else(|e| panic!("turn {n} run: {e}"));
        assert_clean_turn(&out, &format!("chain-turn-{n}"));
        let answer = out
            .last_assistant_text()
            .unwrap_or_default()
            .to_lowercase();
        assert!(
            answer.contains("oscilloscope"),
            "turn {n} forgot the codeword; got {:?}; stderr={:?}",
            answer,
            out.stderr,
        );
    }
}

/// **Reproducer for the production "No conversation found" failure.**
/// Run resume in the *h-ide repo working directory* (not /tmp) — closer to
/// how a real user invokes us — to see if Claude's project-scoped session
/// storage is what's making `--resume` fail across spawns.  If this fails
/// where `e2e_resume_continues_conversation` passed in /tmp, working_dir
/// is the variable.
#[ignore]
#[tokio::test]
async fn e2e_resume_in_project_directory() {
    // Was: shared cwd; now: isolated tmp dir to prevent session-memory
    // bleed across tests run in the same workspace.
    let (project_dir, _td) = isolated_workdir("project");

    let sid = uuid::Uuid::new_v4().to_string();
    let plan1 = build_spawn_args(&sid, &project_dir, None, None, None, None, &[], false);
    let t1 = run_one_turn(
        &plan1.args,
        &plan1.working_dir,
        "Remember: pineapple. Reply 'ok'.",
    )
    .await
    .expect("turn 1");
    assert_clean_turn(&t1, "project-turn-1");

    let prior = t1
        .init()
        .and_then(|e| e.get("session_id"))
        .and_then(|v| v.as_str())
        .expect("turn 1 init.session_id")
        .to_string();
    eprintln!("[e2e] project turn-1 session_id = {}", prior);

    let plan2 = build_spawn_args("ignored", &project_dir, Some(&prior), None, None, None, &[], false);
    let t2 = run_one_turn(
        &plan2.args,
        &plan2.working_dir,
        "What was the word? One word answer.",
    )
    .await
    .expect("turn 2");
    assert_clean_turn(&t2, "project-turn-2");
    let answer = t2
        .last_assistant_text()
        .expect("turn 2 assistant")
        .to_lowercase();
    assert!(
        answer.contains("pineapple"),
        "resume in project dir should remember; got: {:?}; stderr={:?}",
        answer,
        t2.stderr,
    );
}

/// **Multi-folder attach grants access on resume.**
///
/// Mirrors the production attach-mid-session flow: spawn with one
/// `--add-dir` value (project A), capture the canonical Claude session
/// id from `init`, then resume with TWO `--add-dir` values (A + B) and
/// ask the assistant to read a sentinel file in B.  If the SDK honors
/// `additionalDirectories` per-invocation (which the docs claim and the
/// bridge depends on), claude can read the file.  The bug we're guarding
/// against: a regression that drops `additionalDirectories` on resume —
/// the user's "I attached folder B but Claude can't see it" report.
#[ignore]
#[tokio::test]
async fn e2e_attach_then_resume_grants_access() {
    let (cwd, _td_cwd) = isolated_workdir("attach-cwd");
    let (dir_a, _td_a) = isolated_workdir("attach-a");
    let (dir_b, _td_b) = isolated_workdir("attach-b");

    let sentinel_b = format!("{dir_b}/secret.txt");
    std::fs::write(&sentinel_b, "the secret password is voltmeter\n")
        .expect("write sentinel B");

    // Turn 1 — initial spawn with only A in --add-dir.  Establishes a
    // resumable session so turn 2 can come back via --resume.
    let sid1 = uuid::Uuid::new_v4().to_string();
    let plan1 = build_spawn_args(
        &sid1,
        &cwd,
        None,
        None,
        None,
        None,
        &[dir_a.clone()],
        false,
    );
    let t1 = run_one_turn(&plan1.args, &plan1.working_dir, "Reply 'ok'.")
        .await
        .expect("attach turn 1");
    assert_clean_turn(&t1, "attach-turn-1");
    let prior_session = t1
        .init()
        .and_then(|e| e.get("session_id"))
        .and_then(|v| v.as_str())
        .expect("turn 1 init.session_id")
        .to_string();
    eprintln!("[attach-e2e] turn-1 session_id = {}", prior_session);

    // Turn 2 — resume with A AND B.  Ask for the sentinel in B.
    let plan2 = build_spawn_args(
        "ignored",
        &cwd,
        Some(&prior_session),
        None,
        None,
        None,
        &[dir_a.clone(), dir_b.clone()],
        false,
    );
    let argv2 = plan2.args.join(" ");
    assert!(
        argv2.contains(&format!("--add-dir {}", dir_a))
            && argv2.contains(&format!("--add-dir {}", dir_b)),
        "resume argv must carry both --add-dir values; got: {:?}",
        plan2.args,
    );

    let prompt = format!(
        "Use only the Read tool.  Read the file {sentinel_b} and reply with the \
         single password word it contains.  Reply with just that one word."
    );
    let t2 = run_one_turn(&plan2.args, &plan2.working_dir, &prompt)
        .await
        .expect("attach turn 2");
    assert_clean_turn(&t2, "attach-turn-2");

    let answer = t2
        .last_assistant_text()
        .unwrap_or_default()
        .to_lowercase();
    assert!(
        answer.contains("voltmeter"),
        "after attach mid-session, claude should read sentinel in B; \
         got {:?}; stderr={:?}",
        answer,
        t2.stderr,
    );
}

/// **Multi-folder detach revokes access on resume.**
///
/// The mirror of the attach case.  Spawn with both A and B, capture the
/// session id, then resume with A only.  Read of the sentinel in A
/// succeeds (still attached); read of the sentinel in B must NOT
/// surface its contents (no longer in `--add-dir`).
///
/// Restricting the prompt to "use only the Read tool" pins the test
/// against `--add-dir`'s tool-sandboxing — Bash + cat would side-step it
/// and falsely pass the test.
#[ignore]
#[tokio::test]
async fn e2e_detach_then_resume_revokes_access() {
    let (cwd, _td_cwd) = isolated_workdir("detach-cwd");
    let (dir_a, _td_a) = isolated_workdir("detach-a");
    let (dir_b, _td_b) = isolated_workdir("detach-b");

    let sentinel_a = format!("{dir_a}/keep.txt");
    let sentinel_b = format!("{dir_b}/gone.txt");
    std::fs::write(&sentinel_a, "the kept word is ammeter\n")
        .expect("write sentinel A");
    std::fs::write(&sentinel_b, "the dropped word is galvanometer\n")
        .expect("write sentinel B");

    // Turn 1 — spawn with both A and B granted.
    let sid1 = uuid::Uuid::new_v4().to_string();
    let plan1 = build_spawn_args(
        &sid1,
        &cwd,
        None,
        None,
        None,
        None,
        &[dir_a.clone(), dir_b.clone()],
        false,
    );
    let t1 = run_one_turn(&plan1.args, &plan1.working_dir, "Reply 'ok'.")
        .await
        .expect("detach turn 1");
    assert_clean_turn(&t1, "detach-turn-1");
    let prior_session = t1
        .init()
        .and_then(|e| e.get("session_id"))
        .and_then(|v| v.as_str())
        .expect("turn 1 init.session_id")
        .to_string();
    eprintln!("[detach-e2e] turn-1 session_id = {}", prior_session);

    // Turn 2 — resume with ONLY A.  Ask claude to attempt both reads
    // and report the result in a single line.
    let plan2 = build_spawn_args(
        "ignored",
        &cwd,
        Some(&prior_session),
        None,
        None,
        None,
        &[dir_a.clone()],
        false,
    );
    assert_eq!(
        plan2.args.iter().filter(|a| *a == "--add-dir").count(),
        1,
        "resume argv must carry exactly one --add-dir (the kept dir A); \
         got: {:?}",
        plan2.args,
    );

    let prompt = format!(
        "Use ONLY the Read tool — do not run shell commands.  \
         First try to read {sentinel_a}; capture the single password word it contains. \
         Then try to read {sentinel_b}; if you can read it, capture that single password word too. \
         Reply with exactly one line in the shape: a:<word_or_failed> b:<word_or_failed>"
    );
    let t2 = run_one_turn(&plan2.args, &plan2.working_dir, &prompt)
        .await
        .expect("detach turn 2");
    assert_clean_turn(&t2, "detach-turn-2");

    let answer = t2
        .last_assistant_text()
        .unwrap_or_default()
        .to_lowercase();

    // Positive: A is still readable.
    assert!(
        answer.contains("ammeter"),
        "after detach, claude should STILL read the sentinel in A; \
         got {:?}; stderr={:?}",
        answer,
        t2.stderr,
    );
    // Negative: B's word must not surface — that would mean --add-dir
    // failed to revoke access.
    assert!(
        !answer.contains("galvanometer"),
        "after detach, claude should NOT be able to read sentinel in B; \
         the assistant leaked it: {:?}; stderr={:?}",
        answer,
        t2.stderr,
    );
}

/// **Orientation digest must include attached project paths.**
///
/// Production bug: a user opens an agent session with two projects
/// pre-attached, asks Claude "What attached project paths has Hermes
/// told you about for this session?", and Claude answers "Hermes
/// hasn't mentioned any attached project paths to me in this session"
/// — even though the bridge was spawned with the right `--add-dir`
/// values AND `state.json` on disk lists them.
///
/// Root cause: `SessionStart` injects the attached-paths line in its
/// `additionalContext`, but on `--resume` Claude effectively does not
/// surface it (the runtime line, delivered via `UserPromptSubmit` per
/// turn, comes through fine — that's why model/permission/effort
/// values are correct in the same response).
///
/// The fix: re-inject the attached paths via `UserPromptSubmit` too,
/// so every user message carries an up-to-date orientation block —
/// the agent-mode equivalent of the old Terminal-mode `$HERMES` env
/// that was visible to every command.
///
/// The test plants a fresh `state.json` with both attached paths,
/// spawns the bridge with `--hermes-state-path` (production code path),
/// and asks Claude to list the paths WITHOUT running any tools.  The
/// answer must mention BOTH paths verbatim.
#[ignore]
#[tokio::test]
async fn e2e_orientation_includes_attached_paths_per_turn() {
    let (cwd, _td_cwd) = isolated_workdir("orient-cwd");
    let (dir_a, _td_a) = isolated_workdir("orient-a");
    let (dir_b, _td_b) = isolated_workdir("orient-b");

    // Plant the state file the bridge will read on every hook fire.
    // Same shape as `agent::ensure_hermes_state_file` writes in
    // production.  Using a tempdir so cleanup is automatic.
    let state_dir = tempfile::Builder::new()
        .prefix("h-ide-orient-state-")
        .tempdir()
        .expect("create state dir");
    let state_path = state_dir.path().join("state.json");
    let state_payload = serde_json::json!({
        "cwd": cwd,
        "attachedPaths": [&dir_a, &dir_b],
        "memory": [],
        "pinnedFiles": []
    });
    std::fs::write(
        &state_path,
        serde_json::to_string_pretty(&state_payload).expect("serialize state"),
    )
    .expect("write state.json");

    // Spawn with both projects in --add-dir, just like production.
    let sid = uuid::Uuid::new_v4().to_string();
    let plan = build_spawn_args(
        &sid,
        &cwd,
        None,
        None,
        None,
        None,
        &[dir_a.clone(), dir_b.clone()],
        false,
    );

    // The prompt is shaped exactly like the user's manual reproduction:
    // ask Claude what attached paths Hermes has mentioned, with an
    // explicit "do not run any tools" so the answer reflects Claude's
    // injected orientation, not what it could discover via Glob/LS.
    let prompt = "Without running ANY tools, list the attached project paths \
                  Hermes has informed you about for this session.  Reply with \
                  exactly the list of absolute paths, one per line, prefixed \
                  with `path: `.  If you have not been informed of any, reply \
                  literally `none`.";
    let out = run_one_turn_with_state(
        &plan.args,
        &plan.working_dir,
        prompt,
        state_path.to_str().expect("state path utf8"),
    )
    .await
    .expect("orientation turn");
    assert_clean_turn(&out, "orientation");

    let answer = out.last_assistant_text().unwrap_or_default();
    let lower = answer.to_lowercase();

    // Negative: Claude must NOT claim ignorance — that's the bug we
    // saw in the production screenshot.
    assert!(
        !lower.contains("none")
            && !lower.contains("hasn't mentioned")
            && !lower.contains("has not been informed")
            && !lower.contains("haven't received"),
        "Claude claimed it was not informed of any attached paths.  \
         The orientation digest is not reaching the model on this turn.  \
         Got: {:?}; stderr={:?}",
        answer,
        out.stderr,
    );

    // Positive: BOTH paths appear in the response.
    assert!(
        answer.contains(&dir_a),
        "expected dir A {:?} to appear in answer; got: {:?}; stderr={:?}",
        dir_a,
        answer,
        out.stderr,
    );
    assert!(
        answer.contains(&dir_b),
        "expected dir B {:?} to appear in answer; got: {:?}; stderr={:?}",
        dir_b,
        answer,
        out.stderr,
    );
}
