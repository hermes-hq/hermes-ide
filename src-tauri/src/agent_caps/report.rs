//! The model an agent reports it runs, from sources other than its hooks
//! (the catalog's `model_report`). Codex (`rollout`): every conversation is
//! written to `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<time>-<thread
//! id>.jsonl`, and its `turn_context` records carry the model of each turn.
//! Read only; only the model is kept.

use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// How much of the end of a rollout is read (the last turn is at the end).
const TAIL_BYTES: u64 = 512 * 1024;

/// The most recent `n` day folders under `sessions/` (newest first).
fn recent_day_dirs(sessions: &Path, n: usize) -> Vec<PathBuf> {
    fn sorted_children(dir: &Path) -> Vec<PathBuf> {
        let mut v: Vec<PathBuf> = std::fs::read_dir(dir)
            .map(|rd| {
                rd.filter_map(|e| e.ok())
                    .map(|e| e.path())
                    .filter(|p| p.is_dir())
                    .collect()
            })
            .unwrap_or_default();
        v.sort();
        v.reverse();
        v
    }
    let mut out = Vec::new();
    for year in sorted_children(sessions) {
        for month in sorted_children(&year) {
            for day in sorted_children(&month) {
                out.push(day);
                if out.len() >= n {
                    return out;
                }
            }
        }
    }
    out
}

/// The model of the last `turn_context` record in rollout text.
pub fn last_turn_model(text: &str) -> Option<String> {
    text.lines().rev().find_map(
        |line| match crate::context_usage::parse_transcript_line(line) {
            Some(crate::context_usage::TranscriptRecord::Model(m)) => Some(m),
            _ => None,
        },
    )
}

/// The model Codex ran the conversation `thread_id` with, from its rollout
/// under `codex_home` (None when the rollout is not found).
pub fn codex_rollout_model(codex_home: &Path, thread_id: &str) -> Option<String> {
    let thread_id = thread_id.trim();
    if thread_id.is_empty() || thread_id.contains(['/', '\\']) {
        return None;
    }
    let suffix = format!("-{thread_id}.jsonl");
    let file = recent_day_dirs(&codex_home.join("sessions"), 3)
        .into_iter()
        .find_map(|day| {
            std::fs::read_dir(day)
                .ok()?
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .find(|p| {
                    p.file_name()
                        .and_then(|n| n.to_str())
                        .is_some_and(|n| n.starts_with("rollout-") && n.ends_with(&suffix))
                })
        })?;
    let mut f = std::fs::File::open(&file).ok()?;
    let len = f.metadata().ok()?.len();
    if len > TAIL_BYTES {
        f.seek(SeekFrom::Start(len - TAIL_BYTES)).ok()?;
    }
    let mut buf = Vec::new();
    f.take(TAIL_BYTES).read_to_end(&mut buf).ok()?;
    last_turn_model(&String::from_utf8_lossy(&buf))
}

/// Where Codex keeps its data for a session: the account's CODEX_HOME, else
/// the environment's, else ~/.codex.
pub fn codex_home(profile: Option<&super::ProfileEnv>) -> Option<PathBuf> {
    if let Some(p) = profile.filter(|p| p.name == "CODEX_HOME") {
        return Some(PathBuf::from(&p.value));
    }
    if let Some(v) = std::env::var_os("CODEX_HOME").filter(|v| !v.is_empty()) {
        return Some(PathBuf::from(v));
    }
    dirs::home_dir().map(|h| h.join(".codex"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_model_of_the_last_turn_is_read_from_codexs_rollout() {
        let home = tempfile::tempdir().unwrap();
        let day = home.path().join("sessions/2026/09/29");
        std::fs::create_dir_all(&day).unwrap();
        let old_day = home.path().join("sessions/2026/09/28");
        std::fs::create_dir_all(&old_day).unwrap();
        let tid = "01a0ed30-0b44-7ca0-a710-a48e9c90e4de";
        std::fs::write(
            day.join(format!("rollout-2026-09-29T14-42-23-{tid}.jsonl")),
            concat!(
                r#"{"type":"session_meta","payload":{"id":"x"}}"#, "\n",
                r#"{"type":"turn_context","payload":{"turn_id":"a","cwd":"/w","model":"gpt-fake-luna","effort":"low"}}"#, "\n",
                r#"{"type":"event_msg","payload":{"type":"agent_message","message":"ok"}}"#, "\n",
                r#"{"type":"turn_context","payload":{"turn_id":"b","cwd":"/w","model":"gpt-fake-terra","effort":"high"}}"#, "\n",
            ),
        )
        .unwrap();
        std::fs::write(old_day.join("rollout-2026-09-28T10-00-00-other.jsonl"), "").unwrap();
        assert_eq!(
            codex_rollout_model(home.path(), tid).as_deref(),
            Some("gpt-fake-terra")
        );
        assert_eq!(codex_rollout_model(home.path(), "no-such-thread"), None);
        assert_eq!(codex_rollout_model(home.path(), "../escape"), None);
        assert_eq!(codex_rollout_model(&home.path().join("missing"), tid), None);
    }

    #[test]
    fn codex_home_prefers_the_accounts_profile() {
        let p = super::super::ProfileEnv {
            name: "CODEX_HOME".into(),
            value: "/profiles/.codex-two".into(),
        };
        assert_eq!(
            codex_home(Some(&p)),
            Some(PathBuf::from("/profiles/.codex-two"))
        );
        let other = super::super::ProfileEnv {
            name: "CLAUDE_CONFIG_DIR".into(),
            value: "/x".into(),
        };
        assert_ne!(codex_home(Some(&other)), Some(PathBuf::from("/x")));
    }
}
