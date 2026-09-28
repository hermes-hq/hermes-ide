//! questions.md: one checkbox per question. `- [ ]` is open, `- [x]` is
//! answered, and a question whose text starts with `!` blocks all further
//! work until a person answers it (Hermes shows those in the inbox).

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Question {
    /// 1-based line in questions.md.
    pub line: usize,
    /// The question without the checkbox and the `!` marker.
    pub text: String,
    pub open: bool,
    pub blocking: bool,
}

pub fn parse_questions(text: &str) -> Vec<Question> {
    let mut out = Vec::new();
    for (i, raw) in text.lines().enumerate() {
        let t = raw.trim_start();
        let Some(rest) = t.strip_prefix("- [") else {
            continue;
        };
        let mut chars = rest.chars();
        let mark = chars.next();
        let open = match mark {
            Some(' ') => true,
            Some('x') | Some('X') => false,
            _ => continue,
        };
        let rest = chars.as_str();
        let Some(rest) = rest.strip_prefix(']') else {
            continue;
        };
        let body = rest.trim();
        let (blocking, body) = match body.strip_prefix('!') {
            Some(b) => (true, b.trim()),
            None => (false, body),
        };
        if body.is_empty() || body.starts_with('(') {
            // A template placeholder, not a question.
            continue;
        }
        out.push(Question {
            line: i + 1,
            text: body.to_string(),
            open,
            blocking,
        });
    }
    out
}

/// Open questions that block the work.
pub fn blocking_open(text: &str) -> Vec<Question> {
    parse_questions(text)
        .into_iter()
        .filter(|q| q.open && q.blocking)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_open_answered_and_blocking_questions() {
        let text = "# Questions\n\n- [ ] ! Which engine?\n- [ ] Cache size?\n- [x] Where is the index? — src/index\n- [X] ! Answered blocker\n- [ ] (placeholder)\n- not a question\n";
        let qs = parse_questions(text);
        assert_eq!(qs.len(), 4);
        assert_eq!(
            qs[0],
            Question {
                line: 3,
                text: "Which engine?".into(),
                open: true,
                blocking: true
            }
        );
        assert_eq!(
            qs[1],
            Question {
                line: 4,
                text: "Cache size?".into(),
                open: true,
                blocking: false
            }
        );
        assert!(!qs[2].open && !qs[2].blocking);
        assert!(!qs[3].open && qs[3].blocking);
        let blocking = blocking_open(text);
        assert_eq!(blocking.len(), 1);
        assert_eq!(blocking[0].text, "Which engine?");
    }

    #[test]
    fn indented_items_and_windows_line_endings_work() {
        let qs = parse_questions("  - [ ] !  Indented?\r\n- [ ]\r\n");
        assert_eq!(qs.len(), 1);
        assert_eq!(qs[0].text, "Indented?");
        assert!(qs[0].blocking);
    }
}
