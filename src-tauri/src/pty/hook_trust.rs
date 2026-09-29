//! Trusting only Hermes's own per-launch hooks, for an agent that asks the
//! person to review every new hook before it runs (Codex).
//!
//! Codex runs a hook set with `-c hooks.<Event>=[...]` only once that hook
//! is trusted, and asks "Hooks need review" at every start otherwise. Its
//! own `--dangerously-bypass-hook-trust` would also run the user's and the
//! repository's untrusted hooks, so Hermes never passes it. Instead it asks
//! Codex which hash it expects for each of Hermes's hooks (the app server's
//! `hooks/list`, with the same flags) and passes exactly those as
//! `-c hooks.state={...}` for this launch. Nothing is written to the user's
//! config, and a hook anyone else configured still needs the person's trust.
//!
//! The answer depends only on the Codex binary and the flags, so it is kept
//! for the life of the app. The question runs on a thread of its own, and a
//! launch waits for it at most [`LAUNCH_WAIT`] (Codex answers in about
//! 120 ms): a slow app server never holds the terminal for long. When Codex
//! cannot say (an old version, a timeout) the launch goes ahead without it
//! and Codex shows its review screen, as it would for any new hook; a failed
//! answer is not asked for again before [`RETRY_AFTER`].

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// How long the app server may take to answer.
const TIMEOUT: Duration = Duration::from_secs(8);
/// How long a launch waits for the answer.
pub const LAUNCH_WAIT: Duration = Duration::from_secs(2);
/// After a failed answer, how long launches go without asking again.
pub const RETRY_AFTER: Duration = Duration::from_secs(600);

/// One hook as Codex's `hooks/list` reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListedHook {
    pub key: String,
    pub current_hash: String,
    pub source: String,
    pub command: String,
}

/// The hooks in a `hooks/list` response (the first working folder's).
pub fn parse_hooks_list(result: &serde_json::Value) -> Vec<ListedHook> {
    let Some(data) = result.get("data").and_then(|d| d.as_array()) else {
        return Vec::new();
    };
    data.iter()
        .flat_map(|cwd| {
            cwd.get("hooks")
                .and_then(|h| h.as_array())
                .cloned()
                .unwrap_or_default()
        })
        .filter_map(|h| {
            let s = |k: &str| h.get(k).and_then(|v| v.as_str()).map(str::to_string);
            Some(ListedHook {
                key: s("key")?,
                current_hash: s("currentHash")?,
                source: s("source").unwrap_or_default(),
                command: s("command").unwrap_or_default(),
            })
        })
        .collect()
}

/// The `hooks.state` value (a TOML inline table) that trusts Hermes's own
/// hooks and nothing else: hooks from this launch's flags whose command is
/// the helper at `hi`. None when there are none.
pub fn trust_table(hooks: &[ListedHook], hi: &str) -> Option<String> {
    let ours: Vec<String> = hooks
        .iter()
        .filter(|h| h.source == "sessionFlags" && h.command.contains(hi))
        .map(|h| {
            // JSON string syntax is a valid TOML basic string.
            let key = serde_json::to_string(&h.key).unwrap_or_default();
            let hash = serde_json::to_string(&h.current_hash).unwrap_or_default();
            format!("{key}={{trusted_hash={hash}}}")
        })
        .collect();
    (!ours.is_empty()).then(|| format!("{{{}}}", ours.join(",")))
}

/// Ask `program app-server <flags>` for its hooks, in `cwd`.
fn ask(program: &Path, flags: &[String], cwd: &Path) -> Result<Vec<ListedHook>, String> {
    let mut child = Command::new(program)
        .arg("app-server")
        .args(flags)
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("could not start {}: {e}", program.display()))?;
    let mut stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let (tx, rx) = std::sync::mpsc::channel::<Result<Vec<ListedHook>, String>>();
    let cwd_str = cwd.to_string_lossy().to_string();
    std::thread::spawn(move || {
        let send = |stdin: &mut std::process::ChildStdin, v: serde_json::Value| {
            let _ = writeln!(stdin, "{v}");
            let _ = stdin.flush();
        };
        send(
            &mut stdin,
            serde_json::json!({"id": 1, "method": "initialize", "params": {"clientInfo": {"name": "hermes", "version": env!("CARGO_PKG_VERSION")}}}),
        );
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            let Ok(msg) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            match msg.get("id").and_then(|i| i.as_i64()) {
                Some(1) => {
                    send(&mut stdin, serde_json::json!({"method": "initialized"}));
                    send(
                        &mut stdin,
                        serde_json::json!({"id": 2, "method": "hooks/list", "params": {"cwds": [cwd_str]}}),
                    );
                }
                Some(2) => {
                    let _ = tx.send(match msg.get("result") {
                        Some(r) => Ok(parse_hooks_list(r)),
                        None => Err(format!(
                            "hooks/list failed: {}",
                            msg.get("error").cloned().unwrap_or_default()
                        )),
                    });
                    return;
                }
                _ => {}
            }
        }
        let _ = tx.send(Err("the app server closed without answering".to_string()));
    });
    let answer = rx
        .recv_timeout(TIMEOUT)
        .unwrap_or_else(|_| Err("no answer in time".to_string()));
    kill_tree(&mut child);
    answer
}

/// End the app server and whatever it started. On Windows the program may
/// be an npm `.cmd` shim, whose `node` child would outlive the shim.
fn kill_tree(child: &mut std::process::Child) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// What is known about one (program, flags) pair.
#[derive(Debug, Clone)]
enum Answer {
    /// Never asked.
    Untried,
    /// The app server is being asked.
    Asking,
    /// Its answer: the trust value, or None when there was none to give.
    Known(Option<String>),
    /// It could not say, at this moment.
    Failed(Instant),
}

type Slot = Arc<(Mutex<Answer>, Condvar)>;
/// (agent program, hook flags) -> what the app server said.
type TrustCache = HashMap<(PathBuf, Vec<String>), Slot>;

fn cache() -> &'static Mutex<TrustCache> {
    static CACHE: OnceLock<Mutex<TrustCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The `-c hooks.state=...` value that trusts exactly Hermes's hooks in
/// `flags`, or None (see the module docs). Waits at most `wait` for an
/// answer not known yet; the question goes on in the background, for the
/// next launch.
pub fn trusted_state(
    program: &Path,
    flags: &[String],
    cwd: &Path,
    hi: &str,
    wait: Duration,
) -> Option<String> {
    let key = (program.to_path_buf(), flags.to_vec());
    let slot: Slot = {
        let mut c = cache().lock().ok()?;
        Arc::clone(
            c.entry(key)
                .or_insert_with(|| Arc::new((Mutex::new(Answer::Untried), Condvar::new()))),
        )
    };
    let (lock, ready) = &*slot;
    let mut answer = lock.lock().ok()?;
    match &*answer {
        Answer::Known(value) => return value.clone(),
        Answer::Failed(at) if at.elapsed() < RETRY_AFTER => return None,
        Answer::Failed(_) | Answer::Untried => {
            *answer = Answer::Asking;
            let slot = Arc::clone(&slot);
            let (program, flags, cwd, hi) = (
                program.to_path_buf(),
                flags.to_vec(),
                cwd.to_path_buf(),
                hi.to_string(),
            );
            std::thread::spawn(move || {
                let started = Instant::now();
                let result = match ask(&program, &flags, &cwd) {
                    Ok(hooks) => {
                        let value = trust_table(&hooks, &hi);
                        log::info!(
                            "[LAUNCH] hook trust for {} read in {} ms ({} hooks)",
                            program.display(),
                            started.elapsed().as_millis(),
                            value
                                .as_ref()
                                .map_or(0, |v| v.matches("trusted_hash").count())
                        );
                        Answer::Known(value)
                    }
                    Err(e) => {
                        log::warn!("[LAUNCH] could not read the hook hashes from {}: {e}; the agent will ask to review Hermes's hooks (not asked again for {} s)", program.display(), RETRY_AFTER.as_secs());
                        Answer::Failed(Instant::now())
                    }
                };
                let (lock, ready) = &*slot;
                if let Ok(mut a) = lock.lock() {
                    *a = result;
                }
                ready.notify_all();
            });
        }
        Answer::Asking => {}
    }
    let (answer, _) = ready
        .wait_timeout_while(answer, wait, |a| matches!(a, Answer::Asking))
        .ok()?;
    match &*answer {
        Answer::Known(value) => value.clone(),
        _ => None,
    }
}

/// Find `name` in the folders a new terminal would search.
pub fn find_program(name: &str) -> Option<PathBuf> {
    static DIRS: OnceLock<Vec<PathBuf>> = OnceLock::new();
    let dirs = DIRS.get_or_init(crate::agent_doctor::search_dirs);
    let names: Vec<String> = if cfg!(windows) {
        vec![
            format!("{name}.exe"),
            format!("{name}.cmd"),
            name.to_string(),
        ]
    } else {
        vec![name.to_string()]
    };
    dirs.iter()
        .flat_map(|d| names.iter().map(move |n| d.join(n)))
        .find(|p| super::launch::is_executable_file(p))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn listed() -> Vec<ListedHook> {
        // The shape Codex 0.145 answers with (keys and hashes as it prints
        // them; the paths are synthetic).
        let response = serde_json::json!({"data": [{"cwd": "/repo", "hooks": [
            {"key": "/<session-flags>/config.toml:stop:0:0", "eventName": "stop", "source": "sessionFlags",
             "command": "\"/Applications/Hermes.app/Contents/MacOS/hi\" signal --agent codex",
             "currentHash": "sha256:689b", "trustStatus": "untrusted"},
            {"key": "/<session-flags>/config.toml:pre_tool_use:0:0", "eventName": "preToolUse", "source": "sessionFlags",
             "command": "/usr/local/bin/something-else", "currentHash": "sha256:aaaa", "trustStatus": "untrusted"},
            {"key": "/fixture-home/.codex/config.toml:stop:0:0", "eventName": "stop", "source": "user",
             "command": "\"/Applications/Hermes.app/Contents/MacOS/hi\" signal", "currentHash": "sha256:bbbb", "trustStatus": "untrusted"}
        ], "warnings": [], "errors": []}]});
        parse_hooks_list(&response)
    }

    #[test]
    fn only_hermes_own_session_hooks_are_trusted() {
        let hooks = listed();
        assert_eq!(hooks.len(), 3);
        let table = trust_table(&hooks, "/Applications/Hermes.app/Contents/MacOS/hi").unwrap();
        assert_eq!(
            table,
            r#"{"/<session-flags>/config.toml:stop:0:0"={trusted_hash="sha256:689b"}}"#
        );
        assert!(
            !table.contains("aaaa"),
            "a hook with another command is not ours"
        );
        assert!(
            !table.contains("bbbb"),
            "the user's own hook keeps its review"
        );
        assert_eq!(trust_table(&hooks, "/elsewhere/hi"), None);
        assert!(parse_hooks_list(&serde_json::json!({})).is_empty());
    }

    /// A stand-in app server: a shell script that counts its starts in
    /// `starts`, waits `delay` seconds, then answers `initialize` and
    /// `hooks/list` with one of Hermes's hooks (or exits at once, `broken`).
    #[cfg(unix)]
    fn fake_app_server(dir: &Path, delay: &str, broken: bool) -> (PathBuf, PathBuf) {
        use std::os::unix::fs::PermissionsExt;
        let starts = dir.join("starts");
        let program = dir.join("codex");
        let list = r#"{"id":2,"result":{"data":[{"cwd":"/repo","hooks":[{"key":"k:stop","source":"sessionFlags","command":"/app/hi signal","currentHash":"sha256:1"}]}]}}"#;
        let body = if broken {
            format!("#!/bin/sh\necho x >> '{}'\nexit 1\n", starts.display())
        } else {
            format!(
                "#!/bin/sh\necho x >> '{}'\nsleep {delay}\nread a\necho '{{\"id\":1,\"result\":{{}}}}'\nread b\nread c\necho '{list}'\n",
                starts.display()
            )
        };
        std::fs::write(&program, body).unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
        (program, starts)
    }

    #[cfg(unix)]
    fn starts(file: &Path) -> usize {
        std::fs::read_to_string(file).map_or(0, |s| s.lines().count())
    }

    #[cfg(unix)]
    #[test]
    fn the_answer_is_asked_once_and_kept() {
        let dir = tempfile::tempdir().unwrap();
        let (program, count) = fake_app_server(dir.path(), "0", false);
        let flags = vec!["-c".to_string(), "hooks.Stop=1".to_string()];
        let first = trusted_state(
            &program,
            &flags,
            dir.path(),
            "/app/hi",
            Duration::from_secs(5),
        );
        assert_eq!(
            first.as_deref(),
            Some(r#"{"k:stop"={trusted_hash="sha256:1"}}"#)
        );
        let again = trusted_state(
            &program,
            &flags,
            dir.path(),
            "/app/hi",
            Duration::from_secs(5),
        );
        assert_eq!(again, first);
        assert_eq!(starts(&count), 1, "the app server was started once");
    }

    #[cfg(unix)]
    #[test]
    fn a_slow_app_server_holds_a_launch_only_briefly_and_answers_the_next() {
        let dir = tempfile::tempdir().unwrap();
        let (program, count) = fake_app_server(dir.path(), "1", false);
        let flags = vec!["-c".to_string(), "hooks.Stop=2".to_string()];
        let t0 = Instant::now();
        let first = trusted_state(
            &program,
            &flags,
            dir.path(),
            "/app/hi",
            Duration::from_millis(200),
        );
        assert_eq!(first, None, "no answer within the launch's wait");
        assert!(
            t0.elapsed() < Duration::from_millis(900),
            "waited {:?}",
            t0.elapsed()
        );
        // The question went on in the background: a later launch has it.
        let deadline = Instant::now() + Duration::from_secs(6);
        let mut later = None;
        while later.is_none() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(100));
            later = trusted_state(
                &program,
                &flags,
                dir.path(),
                "/app/hi",
                Duration::from_millis(10),
            );
        }
        assert!(later.is_some(), "the background answer was kept");
        assert_eq!(
            starts(&count),
            1,
            "asked once, however many launches waited"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_failed_answer_is_not_asked_for_again_at_every_launch() {
        let dir = tempfile::tempdir().unwrap();
        let (program, count) = fake_app_server(dir.path(), "0", true);
        let flags = vec!["-c".to_string(), "hooks.Stop=3".to_string()];
        assert_eq!(
            trusted_state(
                &program,
                &flags,
                dir.path(),
                "/app/hi",
                Duration::from_secs(5)
            ),
            None
        );
        let t0 = Instant::now();
        for _ in 0..3 {
            assert_eq!(
                trusted_state(
                    &program,
                    &flags,
                    dir.path(),
                    "/app/hi",
                    Duration::from_secs(5)
                ),
                None
            );
        }
        assert!(
            t0.elapsed() < Duration::from_millis(100),
            "the failure is remembered"
        );
        assert_eq!(starts(&count), 1, "the broken app server was started once");
    }
}
