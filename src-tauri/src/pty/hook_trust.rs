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
//! for the life of the app. When Codex cannot say (an old version, a
//! timeout) the launch goes ahead without it and Codex shows its review
//! screen, as it would for any new hook.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(8);

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
    let _ = child.kill();
    let _ = child.wait();
    answer
}

/// (agent program, hook flags) -> the trust value, or None when there was none.
type TrustCache = HashMap<(PathBuf, Vec<String>), Option<String>>;

fn cache() -> &'static Mutex<TrustCache> {
    static CACHE: OnceLock<Mutex<TrustCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The `-c hooks.state=...` value that trusts exactly Hermes's hooks in
/// `flags`, or None (see the module docs).
pub fn trusted_state(program: &Path, flags: &[String], cwd: &Path, hi: &str) -> Option<String> {
    let key = (program.to_path_buf(), flags.to_vec());
    if let Some(hit) = cache().lock().ok().and_then(|c| c.get(&key).cloned()) {
        return hit;
    }
    let started = std::time::Instant::now();
    let value = match ask(program, flags, cwd) {
        Ok(hooks) => trust_table(&hooks, hi),
        Err(e) => {
            log::warn!("[LAUNCH] could not read the hook hashes from {}: {e}; the agent will ask to review Hermes's hooks", program.display());
            // Not cached: the next launch tries again.
            return None;
        }
    };
    log::info!(
        "[LAUNCH] hook trust for {} read in {} ms ({} hooks)",
        program.display(),
        started.elapsed().as_millis(),
        value
            .as_ref()
            .map_or(0, |v| v.matches("trusted_hash").count())
    );
    if let Ok(mut c) = cache().lock() {
        c.insert(key, value.clone());
    }
    value
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
            {"key": "/Users/test/.codex/config.toml:stop:0:0", "eventName": "stop", "source": "user",
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
}
