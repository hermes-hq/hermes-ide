//! The front matter at the top of feature.md: the Rust twin of
//! `src/agent/contract/featureFrontMatter.ts`. Same grammar, same error
//! messages and line numbers, so "feature.md can't be read (line n)" says the
//! same thing whoever read the file.
//!
//! Grammar: `key: scalar`, `key: [a, b]`, or `key:` followed by `- item`
//! lines. `#` starts a comment outside quotes. Unknown keys are kept, so an
//! older Hermes keeps reading a newer file.

use std::collections::BTreeMap;

use crate::phases::{Gate, Phase, Track};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrontMatterError {
    pub message: String,
    /// 1-based line of the file; 0 when no line applies.
    pub line: usize,
}

impl std::fmt::Display for FrontMatterError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} (line {})", self.message, self.line)
    }
}

impl std::error::Error for FrontMatterError {}

fn err(message: impl Into<String>, line: usize) -> FrontMatterError {
    FrontMatterError {
        message: message.into(),
        line,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Meta {
    pub slug: String,
    pub track: Track,
    pub phase: Phase,
    pub gate: Gate,
    pub done_when: Vec<String>,
    /// Keys this version does not know, in file order.
    pub ignored: Vec<String>,
}

/// What `parse` returns: the metadata, the markdown body after the closing
/// fence, and where the fences are (0-based line indexes) so `set_keys` can
/// edit the block in place.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Parsed {
    pub meta: Meta,
    pub body: String,
    pub open_fence: usize,
    pub close_fence: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Value {
    Scalar(String),
    List(Vec<String>),
}

struct Entry {
    value: Value,
    line: usize,
}

pub fn is_slug(value: &str) -> bool {
    let mut chars = value.chars();
    match chars.next() {
        Some(c) if c.is_ascii_lowercase() || c.is_ascii_digit() => {}
        _ => return false,
    }
    value.len() <= 64 && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

fn unquote(raw: &str) -> String {
    let t = raw.trim();
    if t.len() >= 2 {
        let first = t.as_bytes()[0];
        let last = t.as_bytes()[t.len() - 1];
        if (first == b'"' && last == b'"') || (first == b'\'' && last == b'\'') {
            return t[1..t.len() - 1].to_string();
        }
    }
    t.to_string()
}

fn strip_comment(text: &str) -> &str {
    let mut in_string: Option<char> = None;
    let mut prev_space = true;
    for (i, c) in text.char_indices() {
        match in_string {
            Some(q) => {
                if c == q {
                    in_string = None;
                }
            }
            None => {
                if c == '"' || c == '\'' {
                    in_string = Some(c);
                } else if c == '#' && prev_space {
                    return &text[..i];
                }
            }
        }
        prev_space = c.is_whitespace();
    }
    text
}

fn parse_inline_list(raw: &str, line: usize) -> Result<Vec<String>, FrontMatterError> {
    let inner = raw.trim();
    let inner = inner[1..inner.len() - 1].trim();
    if inner.is_empty() {
        return Ok(Vec::new());
    }
    inner
        .split(',')
        .map(|p| {
            let v = unquote(p);
            if v.is_empty() {
                Err(err("empty list item", line))
            } else {
                Ok(v)
            }
        })
        .collect()
}

fn list_item(line: &str) -> Option<&str> {
    let t = line.trim_start();
    if t.starts_with('-') && (t.len() == 1 || t[1..].starts_with(char::is_whitespace)) {
        Some(t[1..].trim())
    } else {
        None
    }
}

fn parse_block(
    lines: &[&str],
    first_line_no: usize,
) -> Result<BTreeMap<String, Entry>, FrontMatterError> {
    let mut out: BTreeMap<String, Entry> = BTreeMap::new();
    let mut pending: Option<String> = None;
    for (i, raw) in lines.iter().enumerate() {
        let line_no = first_line_no + i;
        let line = strip_comment(raw).trim_end();
        if line.trim().is_empty() {
            continue;
        }
        if let Some(item) = list_item(line) {
            let Some(key) = &pending else {
                return Err(err("list item outside a list", line_no));
            };
            let v = unquote(item);
            if v.is_empty() {
                return Err(err("empty list item", line_no));
            }
            if let Some(Entry {
                value: Value::List(items),
                ..
            }) = out.get_mut(key)
            {
                items.push(v);
            }
            continue;
        }
        if line.starts_with(char::is_whitespace) {
            return Err(err("unexpected indentation", line_no));
        }
        pending = None;
        let Some((key, rest)) = line.split_once(':') else {
            return Err(err("expected key: value", line_no));
        };
        let key_ok = !key.is_empty()
            && key
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
        if !key_ok || !(rest.is_empty() || rest.starts_with(char::is_whitespace)) {
            return Err(err("expected key: value", line_no));
        }
        if out.contains_key(key) {
            return Err(err(format!("{key} given twice"), line_no));
        }
        let raw_value = rest.trim();
        let value = if raw_value.is_empty() {
            pending = Some(key.to_string());
            Value::List(Vec::new())
        } else if raw_value.starts_with('[') {
            if !raw_value.ends_with(']') {
                return Err(err("unterminated list", line_no));
            }
            Value::List(parse_inline_list(raw_value, line_no)?)
        } else {
            Value::Scalar(unquote(raw_value))
        };
        out.insert(
            key.to_string(),
            Entry {
                value,
                line: line_no,
            },
        );
    }
    Ok(out)
}

const KNOWN_KEYS: &[&str] = &["slug", "track", "phase", "gate", "done_when"];

fn one_of<T: Copy>(
    entry: Option<&Entry>,
    key: &str,
    allowed: &[(&str, T)],
    fallback: T,
) -> Result<T, FrontMatterError> {
    let Some(entry) = entry else {
        return Ok(fallback);
    };
    let Value::Scalar(s) = &entry.value else {
        return Err(err(format!("{key} must be one word"), entry.line));
    };
    allowed
        .iter()
        .find(|(name, _)| name == s)
        .map(|(_, v)| *v)
        .ok_or_else(|| {
            let names: Vec<&str> = allowed.iter().map(|(n, _)| *n).collect();
            err(
                format!("{key} must be one of {}", names.join(", ")),
                entry.line,
            )
        })
}

/// Read feature.md. Errors carry the 1-based line.
pub fn parse(text: &str) -> Result<Parsed, FrontMatterError> {
    let lines: Vec<&str> = text
        .split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l))
        .collect();
    if lines.is_empty() || lines[0].trim() != "---" {
        return Err(err("feature.md must start with ---", 1));
    }
    let close = lines
        .iter()
        .enumerate()
        .skip(1)
        .find(|(_, l)| l.trim() == "---")
        .map(|(i, _)| i);
    let Some(close) = close else {
        let mut last = lines.len();
        while last > 1 && lines[last - 1].trim().is_empty() {
            last -= 1;
        }
        return Err(err("front matter never closes (missing ---)", last));
    };
    // The block is preserved in file order for `ignored`.
    let fields = parse_block(&lines[1..close], 2)?;
    let mut by_line: Vec<(&String, &Entry)> = fields.iter().collect();
    by_line.sort_by_key(|(_, e)| e.line);
    let ignored: Vec<String> = by_line
        .iter()
        .filter(|(k, _)| !KNOWN_KEYS.contains(&k.as_str()))
        .map(|(k, _)| (*k).clone())
        .collect();

    let Some(slug_entry) = fields.get("slug") else {
        return Err(err("slug is required", 1));
    };
    let slug = match &slug_entry.value {
        Value::Scalar(s) if is_slug(s) => s.clone(),
        _ => {
            return Err(err(
                "slug must be lowercase letters, digits and dashes",
                slug_entry.line,
            ))
        }
    };
    if !fields.contains_key("track") {
        return Err(err("track is required (Quick, Light or Full)", 1));
    }
    let track = one_of(fields.get("track"), "track", Track::NAMES, Track::Light)?;
    let phase = one_of(fields.get("phase"), "phase", Phase::NAMES, Phase::Questions)?;
    let gate = one_of(fields.get("gate"), "gate", Gate::NAMES, Gate::None)?;
    let done_when = match fields.get("done_when") {
        None => Vec::new(),
        Some(Entry {
            value: Value::List(items),
            ..
        }) => items.clone(),
        Some(Entry { line, .. }) => return Err(err("done_when must be a list", *line)),
    };
    Ok(Parsed {
        meta: Meta {
            slug,
            track,
            phase,
            gate,
            done_when,
            ignored,
        },
        body: lines[close + 1..].join("\n"),
        open_fence: 0,
        close_fence: close,
    })
}

/// Set scalar keys inside the front matter block, in place: other lines,
/// comments and unknown keys stay exactly as they are. A key that is not
/// there yet is added before the closing fence. The result parses again.
pub fn set_keys(text: &str, keys: &[(&str, &str)]) -> Result<String, FrontMatterError> {
    let parsed = parse(text)?;
    let newline = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let mut lines: Vec<String> = text
        .split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l).to_string())
        .collect();
    let mut close = parsed.close_fence;
    for (key, value) in keys {
        let mut replaced = false;
        for line in lines.iter_mut().take(close).skip(1) {
            let code = strip_comment(line);
            let Some((k, _)) = code.split_once(':') else {
                continue;
            };
            if k.trim() != *key || code.starts_with(char::is_whitespace) {
                continue;
            }
            let comment = &line[code.len()..];
            let comment = if comment.trim().is_empty() {
                String::new()
            } else {
                format!("  {}", comment.trim())
            };
            *line = format!("{key}: {value}{comment}");
            replaced = true;
            break;
        }
        if !replaced {
            lines.insert(close, format!("{key}: {value}"));
            close += 1;
        }
    }
    let out = lines.join(newline);
    parse(&out)?;
    Ok(out)
}

/// A fresh feature.md.
pub fn render_new(slug: &str, track: Track, phase: Phase, title: &str, body: &str) -> String {
    let heading = if title.trim().is_empty() {
        slug.to_string()
    } else {
        title.trim().to_string()
    };
    let body = if body.trim().is_empty() {
        "(Describe the feature in a few lines: what a person gets, and what \"done\" looks like.)"
            .to_string()
    } else {
        body.trim().to_string()
    };
    format!(
        "---\nslug: {slug}\ntrack: {track}\nphase: {phase}\ngate: none\ndone_when: []\n---\n# {heading}\n\n{body}\n",
        track = track.as_str(),
        phase = phase.as_str(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const FULL: &str = "---\nslug: search-index\ntrack: Full\nphase: plan          # where we are\ngate: waiting\ndone_when:\n  - npm test\n  - \"npm run lint\"\n---\n# Search index\n\nBuild the index.\n";

    #[test]
    fn reads_every_field_and_the_body() {
        let p = parse(FULL).unwrap();
        assert_eq!(p.meta.slug, "search-index");
        assert_eq!(p.meta.track, Track::Full);
        assert_eq!(p.meta.phase, Phase::Plan);
        assert_eq!(p.meta.gate, Gate::Waiting);
        assert_eq!(p.meta.done_when, vec!["npm test", "npm run lint"]);
        assert!(p.meta.ignored.is_empty());
        assert_eq!(p.body, "# Search index\n\nBuild the index.\n");
        assert_eq!(p.close_fence, 8);
    }

    #[test]
    fn defaults_and_inline_lists_match_the_frontend_parser() {
        let p = parse("---\nslug: a\ntrack: Quick\ndone_when: [npm test, 'x y']\n---\n").unwrap();
        assert_eq!(p.meta.phase, Phase::Questions);
        assert_eq!(p.meta.gate, Gate::None);
        assert_eq!(p.meta.done_when, vec!["npm test", "x y"]);
        assert_eq!(p.body, "");
        let p = parse("---\nslug: a\ntrack: Light\nowner: someone\n---\nbody").unwrap();
        assert_eq!(p.meta.ignored, vec!["owner"]);
        assert_eq!(p.body, "body");
    }

    #[test]
    fn errors_carry_the_same_messages_and_lines_as_the_frontend() {
        let cases: &[(&str, &str, usize)] = &[
            ("# no front matter\n", "feature.md must start with ---", 1),
            ("---\nslug: a\ntrack: Full\n", "front matter never closes (missing ---)", 3),
            ("---\ntrack: Full\n---\n", "slug is required", 1),
            ("---\nslug: a\n---\n", "track is required (Quick, Light or Full)", 1),
            ("---\nslug: Bad Slug\ntrack: Full\n---\n", "slug must be lowercase letters, digits and dashes", 2),
            ("---\nslug: a\ntrack: Huge\n---\n", "track must be one of Quick, Light, Full", 3),
            ("---\nslug: a\ntrack: Full\nphase: later\n---\n", "phase must be one of questions, research, design, structure, plan, implement, done", 4),
            ("---\nslug: a\ntrack: Full\ngate: yes\n---\n", "gate must be one of none, waiting, approved", 4),
            ("---\nslug: a\ntrack: Full\ndone_when: npm test\n---\n", "done_when must be a list", 4),
            ("---\nslug: a\ntrack: Full\n  - stray\n---\n", "list item outside a list", 4),
            ("---\nslug: a\ntrack: Full\nphase:\n  - a\n---\n", "phase must be one word", 4),
            ("---\nslug: a\ntrack: Full\nslug: b\n---\n", "slug given twice", 4),
            ("---\nslug: a\ntrack: Full\nnot a key\n---\n", "expected key: value", 4),
            ("---\nslug: a\ntrack: Full\ndone_when: [a, b\n---\n", "unterminated list", 4),
            ("---\nslug: a\ntrack: Full\n  phase: plan\n---\n", "unexpected indentation", 4),
        ];
        for (text, message, line) in cases {
            let e = parse(text).unwrap_err();
            assert_eq!(
                (e.message.as_str(), e.line),
                (*message, *line),
                "for {text:?}"
            );
        }
    }

    #[test]
    fn set_keys_edits_in_place_and_keeps_comments_and_unknown_keys() {
        let text =
            "---\nslug: a\ntrack: Full\nowner: me\nphase: plan   # here\ngate: none\n---\nbody\n";
        let out = set_keys(text, &[("phase", "implement"), ("gate", "approved")]).unwrap();
        assert_eq!(
            out,
            "---\nslug: a\ntrack: Full\nowner: me\nphase: implement  # here\ngate: approved\n---\nbody\n"
        );
        let out = set_keys("---\nslug: a\ntrack: Light\n---\nx", &[("gate", "waiting")]).unwrap();
        assert_eq!(out, "---\nslug: a\ntrack: Light\ngate: waiting\n---\nx");
        assert_eq!(parse(&out).unwrap().meta.gate, Gate::Waiting);
        assert!(set_keys("nope", &[("gate", "waiting")]).is_err());
    }

    #[test]
    fn set_keys_keeps_windows_line_endings() {
        let out = set_keys(
            "---\r\nslug: a\r\ntrack: Light\r\ngate: none\r\n---\r\nx\r\n",
            &[("gate", "waiting")],
        )
        .unwrap();
        assert_eq!(
            out,
            "---\r\nslug: a\r\ntrack: Light\r\ngate: waiting\r\n---\r\nx\r\n"
        );
    }

    #[test]
    fn render_new_parses() {
        let text = render_new("demo", Track::Light, Phase::Questions, "Demo feature", "");
        let p = parse(&text).unwrap();
        assert_eq!(p.meta.slug, "demo");
        assert_eq!(p.meta.track, Track::Light);
        assert!(p.body.starts_with("# Demo feature"));
    }

    #[test]
    fn slugs_are_branch_components() {
        assert!(is_slug("search-index"));
        assert!(!is_slug("Search Index"));
        assert!(!is_slug("-x"));
        assert!(!is_slug(""));
    }
}
