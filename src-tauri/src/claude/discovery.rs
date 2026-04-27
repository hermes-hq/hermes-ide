//! Self-maintaining discovery of Claude Code capabilities.
//!
//! All knowledge of effort levels, models, and built-in slash commands comes
//! from spawning the live `claude` CLI (or reading `~/.claude/settings.json`),
//! not from hardcoded lists.  When Claude releases a new version with new
//! options, this module picks the change up automatically with no h-ide
//! source change.
//!
//! Failure mode is "empty list" — the frontend treats an empty discovery as
//! "feature unavailable" and hides the UI gracefully.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::AppState;

const HELP_TIMEOUT_SECS: u64 = 10;
const PRINT_TIMEOUT_SECS: u64 = 30;
// 30s TTL — short enough that even if the settings.json watcher misses an
// edit (e.g. macOS atomic rename outside our watched parent dir), the chip
// state self-heals within half a minute.  The cache mainly amortises
// repeated rapid calls within a single user interaction; longer caching is
// not a goal because the underlying state is small and `--help` is cheap.
const CACHE_TTL_SECS: u64 = 30;

// ─── Types ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelInfo {
    pub id: String,
    pub label: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BuiltinCommand {
    pub command: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ClaudeCapabilities {
    pub effort_levels: Vec<String>,
    pub effort_current: Option<String>,
    pub models: Vec<ModelInfo>,
    pub slash_commands_builtin: Vec<BuiltinCommand>,
}

#[derive(Default)]
pub struct DiscoveryCache {
    capabilities: Option<(Instant, ClaudeCapabilities)>,
}

pub type DiscoveryCacheState = Arc<Mutex<DiscoveryCache>>;

pub fn new_discovery_cache() -> DiscoveryCacheState {
    Arc::new(Mutex::new(DiscoveryCache::default()))
}

// ─── Pure parsers (testable in isolation) ───────────────────────────

/// Parse `claude --help` output looking for the `--effort` flag's possible
/// values.  Matches by the literal string `--effort` and captures the rest of
/// the line (plus continuation lines until the next option starting with
/// `--`).  Inside that block, returns the comma-separated lowercase tokens
/// that look like option names.
///
/// Returns an empty vec if the flag is absent or no recognisable tokens are
/// found.  The caller decides what to do with an empty result.
pub fn parse_effort_levels_from_help_text(help: &str) -> Vec<String> {
    // Find the line that contains "--effort " (note the space — avoids matching
    // hypothetical future flags like "--effort-mode").
    let mut block: Vec<&str> = Vec::new();
    let mut found = false;

    for line in help.lines() {
        if !found {
            // Look for either "--effort " or "--effort\t" or end-of-line.
            let trimmed = line.trim_start();
            let starts = trimmed.starts_with("--effort ")
                || trimmed.starts_with("--effort\t")
                || trimmed == "--effort"
                || trimmed.starts_with("--effort=");
            if starts {
                block.push(line);
                found = true;
            }
            continue;
        }

        // Continuation: stop at the next option (line whose first non-space
        // token starts with "--" or "-x ").
        let trimmed = line.trim_start();
        let is_next_option = trimmed.starts_with("--")
            || (trimmed.starts_with('-')
                && trimmed.len() >= 2
                && trimmed.chars().nth(1).map(|c| c.is_ascii_alphabetic()) == Some(true)
                && trimmed.chars().nth(2).map(|c| c == ' ' || c == ',').unwrap_or(false));
        let is_section_header = !line.starts_with(' ')
            && !line.starts_with('\t')
            && !line.is_empty();
        if is_next_option || is_section_header {
            break;
        }
        if line.trim().is_empty() {
            // Allow blank lines inside a description? Be conservative — stop.
            break;
        }
        block.push(line);
    }

    if block.is_empty() {
        return Vec::new();
    }

    let combined = block.join(" ");
    extract_token_list(&combined)
}

/// Given a help-text fragment that contains a comma-separated list of
/// lowercase option tokens (possibly inside parens or `[possible values: ...]`),
/// return the tokens.
///
/// Strategy: find the first occurrence of either `[possible values:` or `(`
/// and read until the matching close.  If neither is present, fall back to
/// scanning the whole string for any run of `\b[a-z][a-z0-9_-]*\b` tokens
/// adjacent to commas — this is forgiving when Claude changes the wording.
fn extract_token_list(s: &str) -> Vec<String> {
    let lower = s;

    // Try [possible values: a, b, c]
    if let Some(start) = lower.find("[possible values:") {
        let after = &lower[start + "[possible values:".len()..];
        if let Some(end) = after.find(']') {
            return split_token_list(&after[..end]);
        }
    }

    // Try (low, medium, high) or (a | b | c) — the LAST set of parens that
    // contains commas or pipes and lowercase words is most likely the value
    // list.  Iterate all parenthesised groups and pick the last viable one.
    let mut best: Option<Vec<String>> = None;
    let mut depth: i32 = 0;
    let mut start: Option<usize> = None;
    for (i, ch) in lower.char_indices() {
        match ch {
            '(' => {
                if depth == 0 {
                    start = Some(i + 1);
                }
                depth += 1;
            }
            ')' => {
                depth -= 1;
                if depth == 0 {
                    if let Some(s_idx) = start.take() {
                        let inner = &lower[s_idx..i];
                        let tokens = split_token_list(inner);
                        if tokens.len() >= 2 {
                            best = Some(tokens);
                        }
                    }
                }
            }
            _ => {}
        }
    }
    if let Some(t) = best {
        return t;
    }

    // Fallback: scan for a stretch of comma- or pipe-separated lowercase
    // tokens.  We anchor on a colon that's followed by such a list ("low |
    // medium | high"), or on the first lowercase token that has a comma or
    // pipe within the next few words.  This keeps surrounding flag names
    // (`--effort`, `<level>`) out of the result.
    if let Some(idx) = lower.find(':') {
        let after = &lower[idx + 1..];
        let tokens = split_token_list(after);
        if tokens.len() >= 2 {
            return tokens;
        }
    }

    // Last resort: scan the whole string but only pick tokens that are
    // immediately surrounded by separators (comma, pipe, or whitespace
    // adjacent to one of those).  In practice this requires the section to
    // contain at least one comma or pipe.
    if lower.contains(',') || lower.contains('|') {
        return split_token_list(lower);
    }
    Vec::new()
}

/// Split a fragment on commas/pipes/whitespace and keep tokens that look
/// like option names (lowercase letter + lowercase/digits/underscore/hyphen).
fn split_token_list(s: &str) -> Vec<String> {
    let cleaned: String = s
        .replace('|', ",")
        .replace(" or ", ",")
        .replace(';', ",");

    let mut out: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    for chunk in cleaned.split(',') {
        // Each comma-separated chunk may still contain a label-prefix like
        // "Effort: low" or extra whitespace.  Split further on whitespace
        // and inspect every word — only the lowercase option-shaped ones
        // make the cut.  This keeps prose like "Effort:" out of the result.
        for raw in chunk.split_whitespace() {
            let token = raw.trim_matches(|c: char| {
                !c.is_ascii_alphanumeric() && c != '-' && c != '_'
            });
            if token.is_empty() || !is_option_token(token) {
                continue;
            }
            if seen.insert(token.to_string()) {
                out.push(token.to_string());
            }
        }
    }

    out
}

/// "Looks like a CLI option token": starts with a lowercase letter, then any
/// number of lowercase letters, digits, hyphens, or underscores.  Keeps to
/// at most 24 chars to filter prose.
fn is_option_token(s: &str) -> bool {
    if s.is_empty() || s.len() > 24 {
        return false;
    }
    let bytes = s.as_bytes();
    if !(bytes[0].is_ascii_lowercase()) {
        return false;
    }
    s.chars().all(|c| {
        c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_'
    })
}

// ─── Models JSON parser ─────────────────────────────────────────────

/// Forgiving deserialiser for one model entry returned by
/// `claude --print` (or any future inventory endpoint).  Accepts a wide range
/// of field name variants.
#[derive(Debug, Deserialize)]
struct ModelEntryRaw {
    #[serde(alias = "id", alias = "alias", alias = "aliases", alias = "model")]
    id: Option<serde_json::Value>,
    #[serde(alias = "label", alias = "name", alias = "title", alias = "displayName", alias = "display_name")]
    label: Option<String>,
    #[serde(alias = "description", alias = "desc", alias = "summary")]
    description: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ModelsRoot {
    #[serde(alias = "models", alias = "items", alias = "data")]
    models: Option<Vec<ModelEntryRaw>>,
}

/// Parse a JSON blob from `claude --print`.  The content may be wrapped in
/// markdown fences, a `{ "models": [...] }` envelope, or a bare array.  Be
/// lenient.
pub fn parse_models_from_print_json(s: &str) -> Vec<ModelInfo> {
    let cleaned = strip_code_fences(s);
    let trimmed = cleaned.trim();

    // Try locating the first JSON value (object or array) in the string.
    let json_str = match find_json_blob(trimmed) {
        Some(v) => v,
        None => return Vec::new(),
    };

    // First try as { "models": [...] } envelope.
    if let Ok(root) = serde_json::from_str::<ModelsRoot>(json_str) {
        if let Some(list) = root.models {
            return list.into_iter().filter_map(model_entry_to_info).collect();
        }
    }

    // Then try as a bare array.
    if let Ok(list) = serde_json::from_str::<Vec<ModelEntryRaw>>(json_str) {
        return list.into_iter().filter_map(model_entry_to_info).collect();
    }

    Vec::new()
}

fn model_entry_to_info(entry: ModelEntryRaw) -> Option<ModelInfo> {
    // `id` may be a single string or an array of aliases — pick the first
    // string we find.
    let id = match entry.id {
        Some(serde_json::Value::String(s)) => s,
        Some(serde_json::Value::Array(arr)) => arr
            .into_iter()
            .find_map(|v| v.as_str().map(|s| s.to_string()))?,
        _ => return None,
    };
    let id = id.trim().to_string();
    if id.is_empty() {
        return None;
    }

    let label = entry.label.unwrap_or_else(|| id.clone());
    let description = entry.description.unwrap_or_default();
    Some(ModelInfo {
        id,
        label,
        description,
    })
}

// ─── Commands JSON parser ────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct CommandEntryRaw {
    #[serde(alias = "command", alias = "name", alias = "slash", alias = "cmd")]
    command: Option<String>,
    #[serde(alias = "description", alias = "desc", alias = "summary", alias = "help")]
    description: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CommandsRoot {
    #[serde(alias = "commands", alias = "items", alias = "slash_commands", alias = "data")]
    commands: Option<Vec<CommandEntryRaw>>,
}

pub fn parse_builtin_commands_from_print_json(s: &str) -> Vec<BuiltinCommand> {
    let cleaned = strip_code_fences(s);
    let trimmed = cleaned.trim();
    let json_str = match find_json_blob(trimmed) {
        Some(v) => v,
        None => return Vec::new(),
    };

    if let Ok(root) = serde_json::from_str::<CommandsRoot>(json_str) {
        if let Some(list) = root.commands {
            return list
                .into_iter()
                .filter_map(command_entry_to_builtin)
                .collect();
        }
    }
    if let Ok(list) = serde_json::from_str::<Vec<CommandEntryRaw>>(json_str) {
        return list
            .into_iter()
            .filter_map(command_entry_to_builtin)
            .collect();
    }
    Vec::new()
}

fn command_entry_to_builtin(entry: CommandEntryRaw) -> Option<BuiltinCommand> {
    let raw = entry.command?.trim().to_string();
    if raw.is_empty() {
        return None;
    }
    let command = if raw.starts_with('/') {
        raw
    } else {
        format!("/{}", raw)
    };
    Some(BuiltinCommand {
        command,
        description: entry.description.unwrap_or_default(),
    })
}

// ─── Help-text fallback for built-in slash commands ─────────────────

/// Scrape `--help` output for any `/command` tokens mentioned in option
/// descriptions.  Last-resort fallback when `claude --print` won't return
/// JSON.  The descriptions we scrape are best-effort — empty strings are
/// fine, the frontend can fall back to the literal command name.
pub fn parse_builtin_commands_from_help_text(help: &str) -> Vec<BuiltinCommand> {
    use std::collections::BTreeMap;

    let mut by_cmd: BTreeMap<String, String> = BTreeMap::new();
    // Slash command pattern: a forward slash followed by 1-30 lowercase
    // letters, digits, or hyphens.  Anchored on a non-word boundary.
    for line in help.lines() {
        for piece in line.split_whitespace() {
            let trimmed = piece.trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '/' && c != '-' && c != '_');
            if !trimmed.starts_with('/') || trimmed.len() < 2 || trimmed.len() > 32 {
                continue;
            }
            let body = &trimmed[1..];
            if body.is_empty() {
                continue;
            }
            if !body.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_') {
                continue;
            }
            // Avoid matching path-like tokens such as "/some/path".
            if body.contains('/') {
                continue;
            }
            by_cmd.entry(trimmed.to_string()).or_insert_with(String::new);
        }
    }

    by_cmd
        .into_iter()
        .map(|(command, description)| BuiltinCommand { command, description })
        .collect()
}

// ─── Settings parser ────────────────────────────────────────────────

/// Read a Claude `settings.json` blob and return whichever effort-related
/// field is present.  Tries `effortLevel` first (current name), then any
/// top-level key whose name contains "effort" (case-insensitive) and has a
/// string value.
pub fn parse_effort_from_settings_json(json: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(json).ok()?;
    let obj = v.as_object()?;

    if let Some(s) = obj.get("effortLevel").and_then(|v| v.as_str()) {
        let s = s.trim();
        if !s.is_empty() {
            return Some(s.to_string());
        }
    }

    for (k, v) in obj {
        if k.to_lowercase().contains("effort") {
            if let Some(s) = v.as_str() {
                let s = s.trim();
                if !s.is_empty() {
                    return Some(s.to_string());
                }
            }
        }
    }
    None
}

// ─── Generic JSON helpers ────────────────────────────────────────────

fn strip_code_fences(s: &str) -> String {
    // Strip ```json ... ``` fences if present.
    let trimmed = s.trim();
    let stripped = trimmed
        .strip_prefix("```json")
        .or_else(|| trimmed.strip_prefix("```JSON"))
        .or_else(|| trimmed.strip_prefix("```"))
        .unwrap_or(trimmed);
    let stripped = stripped.trim_start_matches('\n');
    let stripped = stripped
        .strip_suffix("```")
        .map(|s| s.trim_end())
        .unwrap_or(stripped);
    stripped.to_string()
}

/// Find the first balanced `{...}` or `[...]` substring.  Used to recover
/// JSON when the model wraps it in narration like "Here is the JSON: { ... }".
fn find_json_blob(s: &str) -> Option<&str> {
    let bytes = s.as_bytes();
    let mut start: Option<usize> = None;
    let mut depth: i32 = 0;
    let mut opener: Option<u8> = None;
    let mut in_string = false;
    let mut escape = false;

    for (i, &b) in bytes.iter().enumerate() {
        if in_string {
            if escape {
                escape = false;
            } else if b == b'\\' {
                escape = true;
            } else if b == b'"' {
                in_string = false;
            }
            continue;
        }
        match b {
            b'"' => {
                if start.is_some() {
                    in_string = true;
                }
            }
            b'{' | b'[' => {
                if start.is_none() {
                    start = Some(i);
                    opener = Some(b);
                    depth = 1;
                } else if let Some(o) = opener {
                    if (o == b'{' && b == b'{') || (o == b'[' && b == b'[') {
                        depth += 1;
                    } else if (o == b'{' && b == b'[') || (o == b'[' && b == b'{') {
                        depth += 1;
                    }
                }
            }
            b'}' | b']' => {
                if let Some(o) = opener {
                    let close_match = (o == b'{' && b == b'}') || (o == b'[' && b == b']');
                    if close_match {
                        depth -= 1;
                        if depth == 0 {
                            let s_idx = start?;
                            return Some(&s[s_idx..=i]);
                        }
                    } else {
                        depth -= 1;
                        if depth == 0 {
                            // Mismatched close — give up.
                            return None;
                        }
                    }
                }
            }
            _ => {}
        }
    }
    None
}

// ─── Subprocess wrappers (live integration) ──────────────────────────

/// Run `claude --help` with a 10s timeout.  Returns stdout on success,
/// `Err` on failure / timeout.
pub async fn fetch_claude_help() -> Result<String, String> {
    let fut = async {
        let out = tokio::process::Command::new("claude")
            .arg("--help")
            .output()
            .await
            .map_err(|e| format!("spawn claude --help: {}", e))?;
        if !out.status.success() {
            // Still capture stdout — Claude's --help may exit non-zero on
            // some setups but still print useful text.
            let stderr = String::from_utf8_lossy(&out.stderr).to_string();
            let stdout = String::from_utf8_lossy(&out.stdout).to_string();
            if stdout.trim().is_empty() {
                return Err(format!(
                    "claude --help failed (status {:?}): {}",
                    out.status.code(),
                    stderr.lines().next().unwrap_or("")
                ));
            }
            return Ok(stdout);
        }
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    };

    match tokio::time::timeout(Duration::from_secs(HELP_TIMEOUT_SECS), fut).await {
        Ok(r) => r,
        Err(_) => Err(format!("claude --help timed out after {}s", HELP_TIMEOUT_SECS)),
    }
}

/// Run `claude --print <prompt>` with a 30s timeout.  Returns stdout.
pub async fn fetch_claude_print(prompt: &str) -> Result<String, String> {
    let prompt_owned = prompt.to_string();
    let fut = async move {
        let out = tokio::process::Command::new("claude")
            .arg("--print")
            .arg(&prompt_owned)
            .output()
            .await
            .map_err(|e| format!("spawn claude --print: {}", e))?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr).to_string();
            return Err(format!(
                "claude --print failed (status {:?}): {}",
                out.status.code(),
                stderr.lines().next().unwrap_or("")
            ));
        }
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    };

    match tokio::time::timeout(Duration::from_secs(PRINT_TIMEOUT_SECS), fut).await {
        Ok(r) => r,
        Err(_) => Err(format!("claude --print timed out after {}s", PRINT_TIMEOUT_SECS)),
    }
}

// ─── Public discovery functions ──────────────────────────────────────

pub async fn discover_effort_levels() -> Result<Vec<String>, String> {
    let help = fetch_claude_help().await?;
    let levels = parse_effort_levels_from_help_text(&help);
    if levels.is_empty() {
        return Err("no --effort options found in claude --help output".to_string());
    }
    Ok(levels)
}

pub async fn read_current_effort() -> Result<Option<String>, String> {
    let path = match dirs::home_dir() {
        Some(h) => h.join(".claude").join("settings.json"),
        None => return Ok(None),
    };

    let bytes = match tokio::fs::read(&path).await {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("read {}: {}", path.display(), e)),
    };
    let text = match String::from_utf8(bytes) {
        Ok(s) => s,
        Err(e) => return Err(format!("settings.json is not utf-8: {}", e)),
    };
    Ok(parse_effort_from_settings_json(&text))
}

pub async fn discover_models() -> Vec<ModelInfo> {
    // Step 1: try claude --print for a structured list.
    let prompt = r#"List available models as JSON. Format: {"models":[{"id":"...","label":"...","description":"..."}]}. Output ONLY the JSON, nothing else."#;
    if let Ok(stdout) = fetch_claude_print(prompt).await {
        let parsed = parse_models_from_print_json(&stdout);
        if !parsed.is_empty() {
            return parsed;
        }
        log::info!(
            "[claude-discovery] claude --print returned non-JSON for models; falling back to help"
        );
    }

    // Step 2: scrape --help.  The help line for --model lists exemplar
    // aliases like "'sonnet' or 'opus'".  We extract any single-quoted
    // tokens that look like option tokens.  This is best-effort — if Claude
    // ever stops listing exemplars, the result will be empty and the UI
    // will hide.
    if let Ok(help) = fetch_claude_help().await {
        let aliases = extract_model_aliases_from_help(&help);
        if !aliases.is_empty() {
            return aliases
                .into_iter()
                .map(|id| ModelInfo {
                    label: id.clone(),
                    description: String::new(),
                    id,
                })
                .collect();
        }
    }

    Vec::new()
}

/// Extract model alias tokens from the `--model` description in `--help`
/// output.  Looks for tokens inside single quotes immediately following
/// `--model`.
pub fn extract_model_aliases_from_help(help: &str) -> Vec<String> {
    let mut block: Vec<&str> = Vec::new();
    let mut found = false;
    for line in help.lines() {
        if !found {
            let trimmed = line.trim_start();
            if trimmed.starts_with("--model ")
                || trimmed == "--model"
                || trimmed.starts_with("--model\t")
                || trimmed.starts_with("--model=")
            {
                block.push(line);
                found = true;
            }
            continue;
        }
        let trimmed = line.trim_start();
        let is_next_option = trimmed.starts_with("--")
            || (trimmed.starts_with('-')
                && trimmed.len() >= 2
                && trimmed.chars().nth(1).map(|c| c.is_ascii_alphabetic()) == Some(true));
        let is_section_header = !line.starts_with(' ')
            && !line.starts_with('\t')
            && !line.is_empty();
        if is_next_option || is_section_header {
            break;
        }
        if line.trim().is_empty() {
            break;
        }
        block.push(line);
    }
    if block.is_empty() {
        return Vec::new();
    }

    let combined = block.join(" ");
    // Pull out tokens inside single-quote pairs.  Apostrophes inside English
    // contractions ("model's") would otherwise misalign the matching, so we
    // only "consume" a quote pair when its content actually looks like an
    // option token or a full model name.  Otherwise we skip just one char
    // and keep scanning.
    let bytes = combined.as_bytes();
    let mut out: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'\'' {
            let start = i + 1;
            if let Some(rel_end) = combined[start..].find('\'') {
                let token = &combined[start..start + rel_end];
                let trimmed = token.trim();
                if is_option_token(trimmed) || looks_like_model_full_name(trimmed) {
                    if seen.insert(trimmed.to_string()) {
                        out.push(trimmed.to_string());
                    }
                    i = start + rel_end + 1;
                    continue;
                }
            }
        }
        i += 1;
    }
    out
}

fn looks_like_model_full_name(s: &str) -> bool {
    // e.g. "claude-sonnet-4-6" — lowercase, hyphenated, mostly alphanumeric.
    if s.is_empty() || s.len() > 64 {
        return false;
    }
    let mut hyphen_count = 0;
    for c in s.chars() {
        if !(c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '.') {
            return false;
        }
        if c == '-' {
            hyphen_count += 1;
        }
    }
    hyphen_count >= 1
}

/// Bundled fallback list of well-known Claude Code built-in slash commands.
///
/// Loaded at compile time via `include_str!` from `resources/claude-builtins.json`.
/// This is the LAST-RESORT path when both `claude --print` (structured JSON) and
/// `claude --help` (text scrape) fail to produce a usable list.  Live discovery
/// always wins when it succeeds, so when Claude adds new commands the user
/// gets them automatically — they only see this static list when discovery
/// cannot reach Claude (offline, broken auth, claude not on PATH, etc.).
///
/// The JSON file is data, not code: updates to the bundled list ship with each
/// h-ide release without touching `discovery.rs`.
const BUNDLED_BUILTINS_JSON: &str = include_str!("../../resources/claude-builtins.json");

#[derive(Debug, Deserialize)]
struct BundledBuiltinsRoot {
    commands: Vec<BundledBuiltin>,
}

#[derive(Debug, Deserialize)]
struct BundledBuiltin {
    command: String,
    #[serde(default)]
    description: String,
}

/// Parse the shipped fallback JSON.  Returns an empty list if the file is
/// malformed (which would only happen if a developer broke it during edits —
/// the unit tests catch that case).
pub fn parse_bundled_builtins(json: &str) -> Vec<BuiltinCommand> {
    match serde_json::from_str::<BundledBuiltinsRoot>(json) {
        Ok(root) => root
            .commands
            .into_iter()
            .filter_map(|b| {
                let cmd = b.command.trim().to_string();
                if cmd.is_empty() {
                    return None;
                }
                let command = if cmd.starts_with('/') { cmd } else { format!("/{}", cmd) };
                Some(BuiltinCommand {
                    command,
                    description: b.description,
                })
            })
            .collect(),
        Err(e) => {
            log::warn!("[claude-discovery] bundled builtins JSON parse failed: {}", e);
            Vec::new()
        }
    }
}

/// Public accessor for the bundled list.
pub fn bundled_builtin_commands() -> Vec<BuiltinCommand> {
    parse_bundled_builtins(BUNDLED_BUILTINS_JSON)
}

/// Minimum size for a discovered command list to be considered "complete
/// enough" to ship as-is.  Below this we fall through to the next source.
/// Set conservatively low: it just has to beat the typical degenerate
/// outputs we see (1-3 commands when claude is being terse).
const MIN_USABLE_BUILTINS: usize = 5;

pub async fn discover_slash_commands_builtin() -> Vec<BuiltinCommand> {
    // Step 1: claude --print for a structured list.
    let prompt = r#"List all built-in slash commands as JSON. Format: {"commands":[{"command":"/...","description":"..."}]}. Output ONLY the JSON."#;
    if let Ok(stdout) = fetch_claude_print(prompt).await {
        let parsed = parse_builtin_commands_from_print_json(&stdout);
        if parsed.len() >= MIN_USABLE_BUILTINS {
            return parsed;
        }
        log::info!(
            "[claude-discovery] claude --print returned only {} slash command(s) (need ≥{}); falling back to help",
            parsed.len(),
            MIN_USABLE_BUILTINS
        );
    }

    // Step 2: scrape help text for /command tokens.
    if let Ok(help) = fetch_claude_help().await {
        let scraped = parse_builtin_commands_from_help_text(&help);
        // The help-text scrape is fragile (it just finds anything that looks
        // like a `/word` token).  Apply the same threshold so the user
        // doesn't end up with a near-empty dropdown.
        if scraped.len() >= MIN_USABLE_BUILTINS {
            return scraped;
        }
        log::info!(
            "[claude-discovery] --help yielded only {} slash command(s); using bundled fallback",
            scraped.len()
        );
    }

    // Step 3: ship-time bundled list — see `BUNDLED_BUILTINS_JSON`.  This is
    // the only "hardcoded" path; lives in a versioned data file rather than
    // in source, and is shadowed entirely whenever live discovery yields a
    // usable list.
    bundled_builtin_commands()
}

// ─── Combined discovery + cache ──────────────────────────────────────

pub async fn discover_all(cache: &DiscoveryCacheState) -> ClaudeCapabilities {
    {
        let guard = cache.lock().await;
        if let Some((stamped, caps)) = &guard.capabilities {
            if stamped.elapsed() < Duration::from_secs(CACHE_TTL_SECS) {
                return caps.clone();
            }
        }
    }

    let (effort_levels_res, effort_current_res, models, builtins) = tokio::join!(
        discover_effort_levels(),
        read_current_effort(),
        discover_models(),
        discover_slash_commands_builtin()
    );

    let effort_levels = effort_levels_res.unwrap_or_else(|e| {
        log::warn!("[claude-discovery] effort levels: {}", e);
        Vec::new()
    });
    let effort_current = effort_current_res.unwrap_or_else(|e| {
        log::warn!("[claude-discovery] effort current: {}", e);
        None
    });

    let caps = ClaudeCapabilities {
        effort_levels,
        effort_current,
        models,
        slash_commands_builtin: builtins,
    };

    let mut guard = cache.lock().await;
    guard.capabilities = Some((Instant::now(), caps.clone()));
    caps
}

/// Invalidate the cache so the next call re-runs all discoveries.
pub async fn invalidate_cache(cache: &DiscoveryCacheState) {
    let mut guard = cache.lock().await;
    guard.capabilities = None;
}

// ─── Tauri command entry point ───────────────────────────────────────

#[tauri::command]
pub async fn discover_claude_capabilities(
    _state: tauri::State<'_, AppState>,
    cache: tauri::State<'_, DiscoveryCacheState>,
    session_id: String,
) -> Result<ClaudeCapabilities, String> {
    let _ = session_id; // session_id is reserved for future per-session config
    let cache_clone = cache.inner().clone();
    Ok(discover_all(&cache_clone).await)
}

/// Manually invalidate the discovery cache.  Used by the frontend after it
/// sends a state-changing command (e.g. `/effort <level>`) so the next
/// `discover_claude_capabilities` call re-reads `settings.json` even if the
/// filesystem watcher hasn't fired yet (macOS atomic-save rename can elude
/// parent-directory watchers in rare cases).
#[tauri::command]
pub async fn invalidate_claude_capabilities_cache(
    cache: tauri::State<'_, DiscoveryCacheState>,
) -> Result<(), String> {
    let cache_clone = cache.inner().clone();
    invalidate_cache(&cache_clone).await;
    Ok(())
}

// Suppress unused warning when the command is referenced only via Tauri's
// generate_handler! macro.
#[allow(dead_code)]
fn _force_use(_: HashMap<String, String>) {}

// ─── Tests ──────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_HELP: &str = "
Usage: claude [options] [command] [prompt]

Options:
  -d, --debug [filter]                Enable debug mode
  --effort <level>                    Effort level for the current session (low, medium, high, xhigh, max)
  --model <model>                     Model for the current session. Provide an alias for the latest model (e.g. 'sonnet' or 'opus') or a model's full name (e.g. 'claude-sonnet-4-6').
  -h, --help                          Display help for command
";

    #[test]
    fn effort_levels_basic() {
        let v = parse_effort_levels_from_help_text(SAMPLE_HELP);
        assert_eq!(v, vec!["low", "medium", "high", "xhigh", "max"]);
    }

    #[test]
    fn effort_levels_possible_values_format() {
        let help = "
Options:
  --effort <level>   Effort [possible values: light, deep, ultra]
  --next             Next flag
";
        let v = parse_effort_levels_from_help_text(help);
        assert_eq!(v, vec!["light", "deep", "ultra"]);
    }

    #[test]
    fn effort_levels_pipe_separated() {
        let help = "
Options:
  --effort <level>   Effort: low | medium | high
  --next
";
        let v = parse_effort_levels_from_help_text(help);
        assert_eq!(v, vec!["low", "medium", "high"]);
    }

    #[test]
    fn effort_levels_missing_returns_empty() {
        let help = "
Options:
  --debug
  --help
";
        assert!(parse_effort_levels_from_help_text(help).is_empty());
    }

    #[test]
    fn effort_levels_empty_input() {
        assert!(parse_effort_levels_from_help_text("").is_empty());
    }

    #[test]
    fn effort_levels_handles_continuation_lines() {
        let help = "
Options:
  --effort <level>
                                      Effort level (low, medium, high)
  --next                              Next
";
        let v = parse_effort_levels_from_help_text(help);
        assert_eq!(v, vec!["low", "medium", "high"]);
    }

    #[test]
    fn effort_levels_skips_prose_words() {
        // Make sure "Effort", "level", "for", "the" don't end up in the list.
        let help = "
Options:
  --effort <level>   Effort level for the current session (low, medium, high)
  --next
";
        let v = parse_effort_levels_from_help_text(help);
        assert_eq!(v, vec!["low", "medium", "high"]);
    }

    #[test]
    fn models_envelope_json() {
        let s = r#"{
            "models": [
                {"id":"sonnet","label":"Sonnet","description":"Fast and balanced"},
                {"id":"opus","label":"Opus","description":"Most capable"}
            ]
        }"#;
        let v = parse_models_from_print_json(s);
        assert_eq!(v.len(), 2);
        assert_eq!(v[0].id, "sonnet");
        assert_eq!(v[1].label, "Opus");
    }

    #[test]
    fn models_bare_array() {
        let s = r#"[
            {"id":"a","label":"A","description":""},
            {"id":"b","label":"B","description":""}
        ]"#;
        let v = parse_models_from_print_json(s);
        assert_eq!(v.len(), 2);
    }

    #[test]
    fn models_with_field_aliases() {
        let s = r#"{"models":[{"alias":"sonnet","name":"Sonnet","desc":"x"}]}"#;
        let v = parse_models_from_print_json(s);
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].id, "sonnet");
        assert_eq!(v[0].label, "Sonnet");
        assert_eq!(v[0].description, "x");
    }

    #[test]
    fn models_with_aliases_array() {
        // `aliases` may be an array of strings — pick the first.
        let s = r#"{"models":[{"aliases":["sonnet","sonnet-latest"],"label":"Sonnet"}]}"#;
        let v = parse_models_from_print_json(s);
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].id, "sonnet");
    }

    #[test]
    fn models_inside_code_fence() {
        let s = "```json\n{\"models\":[{\"id\":\"o\",\"label\":\"O\",\"description\":\"\"}]}\n```";
        let v = parse_models_from_print_json(s);
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].id, "o");
    }

    #[test]
    fn models_with_narration_around_json() {
        let s = "Sure, here's the JSON: {\"models\":[{\"id\":\"x\",\"label\":\"X\"}]} hope that helps!";
        let v = parse_models_from_print_json(s);
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].id, "x");
    }

    #[test]
    fn models_malformed_returns_empty() {
        assert!(parse_models_from_print_json("not json").is_empty());
        assert!(parse_models_from_print_json("").is_empty());
        assert!(parse_models_from_print_json("{").is_empty());
    }

    #[test]
    fn models_empty_id_dropped() {
        let s = r#"{"models":[{"id":"","label":"X"},{"id":"ok","label":"Ok"}]}"#;
        let v = parse_models_from_print_json(s);
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].id, "ok");
    }

    #[test]
    fn builtins_envelope() {
        let s = r#"{"commands":[
            {"command":"/compact","description":"Compact transcript"},
            {"command":"/help","description":"Show help"}
        ]}"#;
        let v = parse_builtin_commands_from_print_json(s);
        assert_eq!(v.len(), 2);
        assert_eq!(v[0].command, "/compact");
    }

    #[test]
    fn builtins_adds_slash_prefix() {
        let s = r#"{"commands":[{"command":"compact","description":"Compact"}]}"#;
        let v = parse_builtin_commands_from_print_json(s);
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].command, "/compact");
    }

    #[test]
    fn builtins_with_field_aliases() {
        let s = r#"{"slash_commands":[{"name":"/foo","summary":"Bar"}]}"#;
        let v = parse_builtin_commands_from_print_json(s);
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].command, "/foo");
        assert_eq!(v[0].description, "Bar");
    }

    #[test]
    fn builtins_help_scrape() {
        let help = "Run /compact to compact the transcript or /help for help.\nOther line";
        let v = parse_builtin_commands_from_help_text(help);
        let cmds: Vec<&str> = v.iter().map(|c| c.command.as_str()).collect();
        assert!(cmds.contains(&"/compact"));
        assert!(cmds.contains(&"/help"));
    }

    #[test]
    fn builtins_help_scrape_ignores_paths() {
        let help = "See /Users/me/foo and /usr/bin/x but /clear is a command";
        let v = parse_builtin_commands_from_help_text(help);
        let cmds: Vec<&str> = v.iter().map(|c| c.command.as_str()).collect();
        assert_eq!(cmds, vec!["/clear"]);
    }

    #[test]
    fn settings_effort_level_field() {
        let s = r#"{"effortLevel":"high","theme":"dark"}"#;
        assert_eq!(parse_effort_from_settings_json(s).as_deref(), Some("high"));
    }

    #[test]
    fn settings_with_alternate_effort_field() {
        let s = r#"{"reasoningEffort":"medium"}"#;
        assert_eq!(parse_effort_from_settings_json(s).as_deref(), Some("medium"));
    }

    #[test]
    fn settings_no_effort_field() {
        let s = r#"{"theme":"dark"}"#;
        assert!(parse_effort_from_settings_json(s).is_none());
    }

    #[test]
    fn settings_malformed() {
        assert!(parse_effort_from_settings_json("not json").is_none());
        assert!(parse_effort_from_settings_json("").is_none());
    }

    #[test]
    fn settings_empty_string_value_ignored() {
        let s = r#"{"effortLevel":""}"#;
        assert!(parse_effort_from_settings_json(s).is_none());
    }

    #[test]
    fn model_aliases_from_help_quotes() {
        let v = extract_model_aliases_from_help(SAMPLE_HELP);
        assert!(v.iter().any(|s| s == "sonnet"));
        assert!(v.iter().any(|s| s == "opus"));
        assert!(v.iter().any(|s| s == "claude-sonnet-4-6"));
    }

    #[test]
    fn model_aliases_empty_when_no_model_flag() {
        let help = "Options:\n  --debug\n  --help\n";
        assert!(extract_model_aliases_from_help(help).is_empty());
    }

    #[test]
    fn find_json_blob_unwraps_narration() {
        let s = "narration { \"a\": 1 } trailing";
        assert_eq!(find_json_blob(s), Some("{ \"a\": 1 }"));
    }

    #[test]
    fn find_json_blob_handles_strings_with_braces() {
        let s = r#"{"k":"value with } in it"}"#;
        assert_eq!(find_json_blob(s), Some(s));
    }

    #[test]
    fn find_json_blob_array() {
        let s = "[1, 2, 3]";
        assert_eq!(find_json_blob(s), Some(s));
    }

    #[test]
    fn token_filter_drops_prose() {
        // "Effort level for the current session" should not produce tokens.
        // Only the parenthesised list does.
        let v = parse_effort_levels_from_help_text(
            "  --effort <level>  Effort level for the current session (low, medium, high)\n  --next\n",
        );
        assert_eq!(v, vec!["low", "medium", "high"]);
    }

    /// Optional live smoke test — only runs if the `claude` binary is on
    /// PATH at test time.  Verifies the effort-level parser against live
    /// help output.  Always passes when claude isn't installed.
    #[test]
    fn live_help_parses_some_effort_levels() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_io()
            .enable_time()
            .build()
            .unwrap();
        rt.block_on(async {
            match fetch_claude_help().await {
                Ok(help) => {
                    let levels = parse_effort_levels_from_help_text(&help);
                    // We don't assert specific values — just that the parser
                    // found *something* if the help mentions --effort.
                    if help.contains("--effort") {
                        assert!(
                            !levels.is_empty(),
                            "expected non-empty effort levels from live claude --help; \
                             help text contained --effort but parser returned []. \
                             Live help excerpt:\n{}",
                            help.lines()
                                .filter(|l| l.contains("--effort"))
                                .collect::<Vec<_>>()
                                .join("\n")
                        );
                    }
                }
                Err(_) => {
                    // claude not installed in this CI lane — skip.
                }
            }
        });
    }

    #[test]
    fn bundled_builtins_parses_shipped_file() {
        let v = bundled_builtin_commands();
        // The shipped file MUST contain a usable set — at least the 17 we
        // documented.  If a developer edits the JSON badly, this test catches
        // it before release.
        assert!(
            v.len() >= 15,
            "expected ≥15 bundled built-ins, got {}",
            v.len()
        );
        let cmds: std::collections::HashSet<&str> = v.iter().map(|c| c.command.as_str()).collect();
        for required in [
            "/help", "/clear", "/compact", "/cost", "/model", "/effort", "/config",
            "/init", "/permissions", "/login", "/logout", "/doctor", "/review",
        ] {
            assert!(
                cmds.contains(required),
                "bundled builtins missing {}",
                required
            );
        }
        // Every entry has a non-empty description.
        for entry in &v {
            assert!(
                !entry.description.is_empty(),
                "bundled entry {} has empty description",
                entry.command
            );
        }
    }

    #[test]
    fn bundled_builtins_parser_normalises_slash_prefix() {
        let raw = r#"{"commands":[
            {"command":"foo","description":"no slash"},
            {"command":"/bar","description":"has slash"},
            {"command":"  /baz  ","description":"trim"}
        ]}"#;
        let v = parse_bundled_builtins(raw);
        assert_eq!(v.len(), 3);
        assert_eq!(v[0].command, "/foo");
        assert_eq!(v[1].command, "/bar");
        assert_eq!(v[2].command, "/baz");
    }

    #[test]
    fn bundled_builtins_parser_drops_empty() {
        let raw = r#"{"commands":[
            {"command":"","description":"x"},
            {"command":"/ok","description":"y"}
        ]}"#;
        let v = parse_bundled_builtins(raw);
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].command, "/ok");
    }

    #[test]
    fn bundled_builtins_parser_handles_malformed_json() {
        let v = parse_bundled_builtins("not json");
        assert!(v.is_empty());
    }

    /// Live integration smoke test — spawns the real `claude` binary.  This
    /// runs `discover_all` end-to-end and prints the result so we can verify
    /// the IPC actually returns ≥5 effort levels and a non-empty model list.
    /// `#[ignore]` because it spawns Claude (slow + side effects) — invoke
    /// explicitly:
    /// `cargo test --lib -- --ignored claude::discovery::tests::live_full_capabilities --nocapture`
    #[test]
    #[ignore]
    fn live_full_capabilities() {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let cache = new_discovery_cache();
            let caps = discover_all(&cache).await;
            println!("─── live ClaudeCapabilities ───");
            println!("effort_levels  ({}): {:?}", caps.effort_levels.len(), caps.effort_levels);
            println!("effort_current : {:?}", caps.effort_current);
            println!("models         ({}):", caps.models.len());
            for m in &caps.models {
                println!("  - {} | {} | {}", m.id, m.label, m.description);
            }
            println!("slash_commands_builtin ({}):", caps.slash_commands_builtin.len());
            for c in &caps.slash_commands_builtin {
                println!("  - {} | {}", c.command, c.description);
            }
            assert!(
                caps.effort_levels.len() >= 5,
                "expected ≥5 effort levels from live claude, got {}: {:?}",
                caps.effort_levels.len(),
                caps.effort_levels
            );
        });
    }

    #[test]
    fn cache_returns_same_instance_within_ttl() {
        // Synchronous smoke-test of cache TTL semantics — we don't spawn the
        // CLI here, just verify that pushing into the cache and re-reading
        // returns the same data.
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();
        rt.block_on(async {
            let cache = new_discovery_cache();
            let caps = ClaudeCapabilities {
                effort_levels: vec!["low".into()],
                effort_current: Some("low".into()),
                models: vec![],
                slash_commands_builtin: vec![],
            };
            {
                let mut g = cache.lock().await;
                g.capabilities = Some((Instant::now(), caps.clone()));
            }
            let fresh = {
                let g = cache.lock().await;
                g.capabilities.as_ref().map(|(_, c)| c.clone())
            };
            assert_eq!(fresh.unwrap().effort_levels, vec!["low".to_string()]);
        });
    }
}
