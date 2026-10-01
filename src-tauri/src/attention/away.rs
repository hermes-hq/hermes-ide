//! Away notifications (N16): one outgoing message when an agent is blocked
//! on you, to an address you configure. Outbound only, no remote approval.
//!
//! The message carries the agent, the task name, the state and where the
//! agent works (its repository folder and session number, "api-repo #2"),
//! nothing else: the payload type refuses any other field, and no prompt,
//! detail or file content ever reaches this module. With no address set
//! nothing is sent and no connection is opened.
//!
//! The address decides the format:
//!   - `https://api.telegram.org/bot<token>/sendMessage?chat_id=<id>`:
//!     Telegram's JSON body `{chat_id, text}` (the chat id moves from the
//!     query into the body; the token stays in the path).
//!   - a host with "ntfy" in its name (`https://ntfy.sh/<topic>` or a
//!     self-hosted ntfy): a plain-text body and a `Title` header.
//!   - anything else: a JSON webhook `{"agent","task","state","where"}`.

use serde::{Deserialize, Serialize};
use std::time::Duration;

/// Settings key of the address ("" = off).
pub const AWAY_NOTIFY_URL_KEY: &str = "away_notify_url";

const MAX_AGENT_CHARS: usize = 40;
const MAX_TASK_CHARS: usize = 80;
const MAX_WHERE_CHARS: usize = 80;
const MAX_STATE_CHARS: usize = 32;
const SEND_TIMEOUT: Duration = Duration::from_secs(10);

/// What the frontend may hand over. Any other field is refused.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AwayPayload {
    pub agent: String,
    pub task: String,
    pub state: String,
    /// Where the agent works ("api-repo #2"); "" when unknown. Optional on
    /// the wire, so an older frontend's three fields are still accepted.
    #[serde(rename = "where", default)]
    pub place: String,
}

impl AwayPayload {
    /// One line each, capped, and the state limited to a machine word
    /// ("needs_approval"), so nothing long or multi-line can ride along.
    pub fn sanitized(&self) -> Result<AwayPayload, String> {
        let state = self.state.trim();
        if state.is_empty()
            || state.chars().count() > MAX_STATE_CHARS
            || !state.chars().all(|c| c.is_ascii_lowercase() || c == '_')
        {
            return Err(format!("not a state: {:?}", self.state));
        }
        Ok(AwayPayload {
            agent: one_line(&self.agent, MAX_AGENT_CHARS),
            task: one_line(&self.task, MAX_TASK_CHARS),
            state: state.to_string(),
            place: one_line(&self.place, MAX_WHERE_CHARS),
        })
    }

    /// The human sentence for ntfy and Telegram:
    /// "Claude Code · fix-login · api-repo #2 · needs approval" (empty parts left out).
    pub fn text(&self) -> String {
        let state = self.state.replace('_', " ");
        [
            self.agent.as_str(),
            self.task.as_str(),
            self.place.as_str(),
            &state,
        ]
        .iter()
        .filter(|part| !part.is_empty())
        .copied()
        .collect::<Vec<_>>()
        .join(" · ")
    }
}

fn one_line(s: &str, max: usize) -> String {
    let joined = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if joined.chars().count() <= max {
        joined
    } else {
        let mut out: String = joined.chars().take(max - 1).collect();
        out.push('…');
        out
    }
}

/// Which service the address points at.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Target {
    Webhook,
    Ntfy,
    Telegram,
}

impl Target {
    pub fn name(self) -> &'static str {
        match self {
            Target::Webhook => "webhook",
            Target::Ntfy => "ntfy",
            Target::Telegram => "telegram",
        }
    }
}

/// A request ready to send (built without touching the network).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AwayRequest {
    pub target: Target,
    pub url: String,
    pub content_type: &'static str,
    pub headers: Vec<(&'static str, String)>,
    pub body: String,
}

/// Build the request for `raw_url`. `Ok(None)` when no address is set.
pub fn build_request(raw_url: &str, payload: &AwayPayload) -> Result<Option<AwayRequest>, String> {
    let raw = raw_url.trim();
    if raw.is_empty() {
        return Ok(None);
    }
    let payload = payload.sanitized()?;
    let mut url = reqwest::Url::parse(raw).map_err(|e| format!("not a web address: {e}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("only http:// and https:// addresses are supported".to_string());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "the address has no host".to_string())?
        .to_ascii_lowercase();

    if host == "api.telegram.org" {
        let chat_id = url
            .query_pairs()
            .find(|(k, _)| k == "chat_id")
            .map(|(_, v)| v.into_owned())
            .filter(|v| !v.is_empty())
            .ok_or_else(|| "a Telegram address needs ?chat_id=<id>".to_string())?;
        let rest: Vec<(String, String)> = url
            .query_pairs()
            .filter(|(k, _)| k != "chat_id")
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();
        if rest.is_empty() {
            url.set_query(None);
        } else {
            url.query_pairs_mut().clear().extend_pairs(rest);
        }
        let body = serde_json::json!({ "chat_id": chat_id, "text": payload.text() }).to_string();
        return Ok(Some(AwayRequest {
            target: Target::Telegram,
            url: url.to_string(),
            content_type: "application/json",
            headers: vec![],
            body,
        }));
    }

    if host.contains("ntfy") {
        return Ok(Some(AwayRequest {
            target: Target::Ntfy,
            url: url.to_string(),
            content_type: "text/plain; charset=utf-8",
            headers: vec![("Title", "Hermes".to_string())],
            body: payload.text(),
        }));
    }

    let body = serde_json::to_string(&payload).map_err(|e| e.to_string())?;
    Ok(Some(AwayRequest {
        target: Target::Webhook,
        url: url.to_string(),
        content_type: "application/json",
        headers: vec![],
        body,
    }))
}

/// What happened, for the frontend.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "outcome", rename_all = "lowercase")]
pub enum AwaySendResult {
    /// No address configured: nothing was sent, no connection was made.
    Unset,
    Sent {
        status: u16,
        target: String,
    },
    Failed {
        error: String,
        target: String,
    },
}

/// Send one message to `raw_url`. No address: returns `Unset` without any
/// network call.
pub async fn send(raw_url: &str, payload: &AwayPayload) -> AwaySendResult {
    let request = match build_request(raw_url, payload) {
        Ok(None) => return AwaySendResult::Unset,
        Ok(Some(r)) => r,
        Err(error) => {
            return AwaySendResult::Failed {
                error,
                target: "invalid".to_string(),
            }
        }
    };
    let target = request.target.name().to_string();
    let client = match reqwest::Client::builder()
        .timeout(SEND_TIMEOUT)
        .redirect(reqwest::redirect::Policy::limited(3))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return AwaySendResult::Failed {
                error: e.to_string(),
                target,
            }
        }
    };
    let mut builder = client
        .post(&request.url)
        .header(reqwest::header::CONTENT_TYPE, request.content_type)
        .header(reqwest::header::USER_AGENT, "Hermes");
    for (name, value) in &request.headers {
        builder = builder.header(*name, value);
    }
    match builder.body(request.body).send().await {
        Ok(response) if response.status().is_success() => AwaySendResult::Sent {
            status: response.status().as_u16(),
            target,
        },
        Ok(response) => AwaySendResult::Failed {
            error: format!("the address answered {}", response.status()),
            target,
        },
        Err(e) => AwaySendResult::Failed {
            // Never echo the address: a Telegram URL holds the bot token.
            error: e.without_url().to_string(),
            target,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn payload() -> AwayPayload {
        AwayPayload {
            agent: "Claude Code".into(),
            task: "fix-login".into(),
            state: "needs_approval".into(),
            place: String::new(),
        }
    }

    #[test]
    fn a_state_of_up_to_32_characters_is_kept() {
        let with_state = |state: String| AwayPayload { state, ..payload() };
        let at_cap = "a".repeat(MAX_STATE_CHARS);
        assert_eq!(
            with_state(at_cap.clone()).sanitized().unwrap().state,
            at_cap
        );
        assert!(with_state("a".repeat(MAX_STATE_CHARS + 1))
            .sanitized()
            .is_err());
        assert!(with_state("done".into()).sanitized().is_ok());
    }

    #[test]
    fn no_address_means_no_request() {
        assert_eq!(build_request("", &payload()).unwrap(), None);
        assert_eq!(build_request("   ", &payload()).unwrap(), None);
    }

    #[test]
    fn a_webhook_gets_exactly_agent_task_and_state() {
        let r = build_request("https://hooks.example.com/hermes", &payload())
            .unwrap()
            .unwrap();
        assert_eq!(r.target, Target::Webhook);
        assert_eq!(r.content_type, "application/json");
        let body: Value = serde_json::from_str(&r.body).unwrap();
        let obj = body.as_object().unwrap();
        let mut keys: Vec<_> = obj.keys().cloned().collect();
        keys.sort();
        assert_eq!(keys, vec!["agent", "state", "task", "where"]);
        assert_eq!(body["agent"], "Claude Code");
        assert_eq!(body["task"], "fix-login");
        assert_eq!(body["state"], "needs_approval");
        assert_eq!(body["where"], "");
    }

    #[test]
    fn ntfy_gets_one_plain_line_and_a_title() {
        let r = build_request("https://ntfy.sh/my-topic", &payload())
            .unwrap()
            .unwrap();
        assert_eq!(r.target, Target::Ntfy);
        assert_eq!(r.body, "Claude Code · fix-login · needs approval");
        assert_eq!(r.headers, vec![("Title", "Hermes".to_string())]);
    }

    #[test]
    fn telegram_moves_the_chat_id_into_the_body() {
        let r = build_request(
            "https://api.telegram.org/bot123:ABC/sendMessage?chat_id=-100200",
            &payload(),
        )
        .unwrap()
        .unwrap();
        assert_eq!(r.target, Target::Telegram);
        assert_eq!(r.url, "https://api.telegram.org/bot123:ABC/sendMessage");
        let body: Value = serde_json::from_str(&r.body).unwrap();
        assert_eq!(body["chat_id"], "-100200");
        assert_eq!(body["text"], "Claude Code · fix-login · needs approval");
        assert_eq!(body.as_object().unwrap().len(), 2);
    }

    #[test]
    fn telegram_without_a_chat_id_is_refused() {
        let err =
            build_request("https://api.telegram.org/bot1:A/sendMessage", &payload()).unwrap_err();
        assert!(err.contains("chat_id"), "{err}");
    }

    #[test]
    fn only_http_and_https() {
        assert!(build_request("ftp://example.com/x", &payload()).is_err());
        assert!(build_request("file:///etc/passwd", &payload()).is_err());
        assert!(build_request("not a url", &payload()).is_err());
    }

    #[test]
    fn extra_fields_are_refused_at_the_boundary() {
        let raw = serde_json::json!({
            "agent": "a", "task": "t", "state": "needs_approval",
            "detail": "rm -rf /", "prompt": "secret"
        });
        assert!(serde_json::from_value::<AwayPayload>(raw).is_err());
    }

    #[test]
    fn where_tells_agents_apart_in_every_format() {
        let p = AwayPayload {
            task: String::new(),
            place: "api-repo #2".into(),
            ..payload()
        };
        let hook = build_request("https://hooks.example.com/h", &p)
            .unwrap()
            .unwrap();
        let body: Value = serde_json::from_str(&hook.body).unwrap();
        assert_eq!(body["where"], "api-repo #2");
        let ntfy = build_request("https://ntfy.sh/t", &p).unwrap().unwrap();
        assert_eq!(ntfy.body, "Claude Code · api-repo #2 · needs approval");
        let named = AwayPayload {
            place: "api-repo #2".into(),
            ..payload()
        };
        assert_eq!(
            named.text(),
            "Claude Code · fix-login · api-repo #2 · needs approval"
        );
    }

    #[test]
    fn a_payload_without_where_is_still_accepted() {
        let raw = serde_json::json!({ "agent": "a", "task": "t", "state": "needs_approval" });
        let p: AwayPayload = serde_json::from_value(raw).unwrap();
        assert_eq!(p.place, "");
        let raw =
            serde_json::json!({ "agent": "a", "task": "t", "state": "test", "where": "web #1" });
        assert_eq!(
            serde_json::from_value::<AwayPayload>(raw).unwrap().place,
            "web #1"
        );
    }

    #[test]
    fn long_or_multi_line_values_are_cut_to_one_short_line() {
        let p = AwayPayload {
            agent: "A\nB".into(),
            task: "x".repeat(500),
            state: "needs_answer".into(),
            place: "y\n".repeat(500),
        };
        let s = p.sanitized().unwrap();
        assert_eq!(s.agent, "A B");
        assert_eq!(s.task.chars().count(), MAX_TASK_CHARS);
        assert!(s.task.ends_with('…'));
        assert_eq!(s.place.chars().count(), MAX_WHERE_CHARS);
        assert!(!s.place.contains('\n'));
    }

    #[test]
    fn a_state_must_be_a_machine_word() {
        for bad in ["", "Needs approval", "needs approval: rm -rf /", "x;y"] {
            let p = AwayPayload {
                state: bad.into(),
                ..payload()
            };
            assert!(p.sanitized().is_err(), "{bad:?} accepted");
        }
    }

    #[tokio::test]
    async fn unset_sends_nothing() {
        assert_eq!(send("", &payload()).await, AwaySendResult::Unset);
    }

    #[tokio::test]
    async fn an_invalid_address_fails_without_sending() {
        match send("ftp://example.com", &payload()).await {
            AwaySendResult::Failed { target, .. } => assert_eq!(target, "invalid"),
            other => panic!("unexpected {other:?}"),
        }
    }

    /// A real round trip to a local server: exactly one request, exactly
    /// the three fields.
    #[tokio::test]
    async fn a_webhook_round_trip_delivers_the_minimal_body() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut sock, _) = listener.accept().unwrap();
            let mut buf = Vec::new();
            let mut chunk = [0u8; 4096];
            loop {
                let n = sock.read(&mut chunk).unwrap();
                buf.extend_from_slice(&chunk[..n]);
                let text = String::from_utf8_lossy(&buf).to_string();
                if let Some(end) = text.find("\r\n\r\n") {
                    let len = text[..end]
                        .lines()
                        .find_map(|l| {
                            l.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|v| v.trim().parse::<usize>().unwrap())
                        })
                        .unwrap_or(0);
                    if buf.len() >= end + 4 + len {
                        break;
                    }
                }
                if n == 0 {
                    break;
                }
            }
            sock.write_all(b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n")
                .unwrap();
            String::from_utf8(buf).unwrap()
        });
        let result = send(&format!("http://{addr}/hook"), &payload()).await;
        assert_eq!(
            result,
            AwaySendResult::Sent {
                status: 204,
                target: "webhook".into()
            }
        );
        let request = server.join().unwrap();
        assert!(request.starts_with("POST /hook HTTP/1.1"), "{request}");
        let body = request.split("\r\n\r\n").nth(1).unwrap();
        assert_eq!(
            body,
            r#"{"agent":"Claude Code","task":"fix-login","state":"needs_approval","where":""}"#
        );
    }
}
