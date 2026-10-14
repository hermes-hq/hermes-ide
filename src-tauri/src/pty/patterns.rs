use lazy_static::lazy_static;
use regex::Regex;

lazy_static! {
    // Fallback: detect cd commands
    pub static ref CD_CMD_RE: Regex = Regex::new(
        r"^\$?\s*cd\s+(.+)"
    ).unwrap();
    pub static ref CLAUDE_TOKEN_RE: Regex = Regex::new(
        r"(?i)(?:input|prompt)[:\s]*([0-9,.]+[kKmM]?)\s*tokens?\s*[|·/,]\s*(?:output|completion)[:\s]*([0-9,.]+[kKmM]?)\s*tokens?"
    ).unwrap();
    // "12.5K in, 3.2K out" or "12.5K↓ 3.2K↑"
    pub static ref CLAUDE_TOKEN_SHORT_RE: Regex = Regex::new(
        r"([0-9,.]+[kKmM]?)\s*(?:in|input|↓|sent)[,\s]+([0-9,.]+[kKmM]?)\s*(?:out|output|↑|received)"
    ).unwrap();
    // "Total tokens: 15,234" or "tokens: 15K"
    pub static ref CLAUDE_TOKEN_TOTAL_RE: Regex = Regex::new(
        r"(?i)(?:total\s+)?tokens?[:\s]+([0-9,.]+[kKmM]?)"
    ).unwrap();
    pub static ref CLAUDE_COST_RE: Regex = Regex::new(
        r"(?i)(?:total\s+)?cost[:\s]+\$([0-9]+\.?[0-9]*)"
    ).unwrap();
    // Broader cost pattern: "$0.0432" anywhere in a short line
    pub static ref DOLLAR_AMOUNT_RE: Regex = Regex::new(
        r"\$([0-9]+\.[0-9]{2,4})"
    ).unwrap();
    // Claude Code /cost output: "Session cost: $0.04" or "API cost: $0.12"
    pub static ref SESSION_COST_RE: Regex = Regex::new(
        r"(?i)(?:session|api|total|cumulative)\s+cost[:\s]*\$([0-9]+\.?[0-9]*)"
    ).unwrap();
    pub static ref TOOL_CALL_RE: Regex = Regex::new(
        r"^[●⏺◉•]\s*(\w+)\((.+?)\)"
    ).unwrap();
    // Claude Code tool use: "● Read(file.txt)" or "⏺ Read 3 files" or "● Write(file.txt)"
    // Also matches "● Update(file)" which Claude Code uses for Edit
    pub static ref CLAUDE_TOOL_RE: Regex = Regex::new(
        r"^[●⏺◉•✻\*]\s*(Read|Write|Edit|Update|Bash|Glob|Grep|Task|Search|WebFetch|WebSearch|NotebookEdit|TodoRead|TodoWrite)\b"
    ).unwrap();
    // Claude Code also shows "Edit file\n  path/to/file" as a standalone line
    pub static ref EDIT_FILE_RE: Regex = Regex::new(
        r"^Edit file$"
    ).unwrap();
    pub static ref FILE_PATH_RE: Regex = Regex::new(
        r"(?:^|\s)((?:/[\w.@-]+)+\.[\w]+)"
    ).unwrap();
    pub static ref AIDER_TOKEN_RE: Regex = Regex::new(
        r"(?i)tokens?[:\s]*([0-9.]+k?)\s*sent[,\s]*([0-9.]+k?)\s*(?:received|recv)"
    ).unwrap();

    // ─── Gemini CLI patterns ────────────────────────────────────────
    // Token line from /stats output: "gemini-2.5-pro  10  500  500  2,000"
    // We detect the model usage table rows
    pub static ref GEMINI_STATS_ROW_RE: Regex = Regex::new(
        r"(?i)(gemini[\w.-]+)\s+(\d+)\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)"
    ).unwrap();
    // Tool call patterns: "✓ ReadFile /path" or "? Shell git status" or "x Edit file.ts"
    pub static ref GEMINI_TOOL_RE: Regex = Regex::new(
        r"^[✓?xo⊷\-]\s+(ReadFile|WriteFile|Edit|Shell|FindFiles|SearchText|ReadFolder|ReadManyFiles|GoogleSearch|WebFetch|SaveMemory|WriteTodos|GetInternalDocs)\b"
    ).unwrap();

    // ─── Aider patterns ─────────────────────────────────────────────
    // Full token line: "Tokens: 22k sent, 21k cache write, 2.4k received."
    pub static ref AIDER_FULL_TOKEN_RE: Regex = Regex::new(
        r"(?i)^Tokens:\s*([\d.]+k?)\s*sent(?:,\s*([\d.]+k?)\s*cache\s*write)?(?:,\s*([\d.]+k?)\s*cache\s*hit)?,\s*([\d.]+k?)\s*received"
    ).unwrap();
    // Cost line: "Cost: $0.12 message, $0.67 session."
    pub static ref AIDER_COST_RE: Regex = Regex::new(
        r"(?i)Cost:\s*\$([\d.]+)\s*message,\s*\$([\d.]+)\s*session"
    ).unwrap();
    // Startup: "Aider v0.86.0"
    pub static ref AIDER_VERSION_RE: Regex = Regex::new(
        r"^Aider v(\d+\.\d+\.\d+)"
    ).unwrap();
    // Model line: "Main model: claude-3.5-sonnet with diff edit format" or "Model: gpt-4o with diff edit format"
    pub static ref AIDER_MODEL_RE: Regex = Regex::new(
        r"^(?:Main model|Model|Editor model|Weak model):\s*(.+?)(?:\s+with\s+\S+\s+edit\s+format)?$"
    ).unwrap();
    // Applied edit: "Applied edit to src/main.py"
    pub static ref AIDER_EDIT_RE: Regex = Regex::new(
        r"^Applied edit to (.+)$"
    ).unwrap();
    // Git commit: "Commit 414c394 feat: something"
    pub static ref AIDER_COMMIT_RE: Regex = Regex::new(
        r"^Commit ([a-f0-9]{7}) (.+)$"
    ).unwrap();
    // Aider prompt: ">" "ask>" "architect>" "diff>" "diff multi>" etc.
    pub static ref AIDER_PROMPT_RE: Regex = Regex::new(
        r"^(?:\w+\s?)*>\s*$"
    ).unwrap();

    // ─── Codex CLI patterns ─────────────────────────────────────────
    // Token usage line from /status: "Token usage:      1.9K total  (1K input + 900 output)"
    pub static ref CODEX_TOKEN_RE: Regex = Regex::new(
        r"(?i)Token usage:\s*([\d.]+[KMBT]?)\s*total\s*\(([\d.]+[KMBT]?)\s*input\s*\+\s*([\d.]+[KMBT]?)\s*output\)"
    ).unwrap();
    // Tool patterns: "• Running echo hello" or "• Ran echo hello"
    pub static ref CODEX_TOOL_RUN_RE: Regex = Regex::new(
        r"^[•◦]\s*(?:Running|Ran)\s+(.+)"
    ).unwrap();
    // File patterns: "• Edited example.txt (+1 -1)" or "• Added new.txt (+2 -0)" or "• Deleted tmp.txt (+0 -3)"
    pub static ref CODEX_FILE_OP_RE: Regex = Regex::new(
        r"^[•◦]\s*(Edited|Added|Deleted)\s+(.+?)(?:\s+\(\+\d+\s+-\d+\))?\s*$"
    ).unwrap();
    // Exploring: "• Exploring" or "• Explored"
    pub static ref CODEX_EXPLORE_RE: Regex = Regex::new(
        r"^[•◦]\s*(?:Exploring|Explored)"
    ).unwrap();
    // MCP: "• Calling server.tool(...)" or "• Called server.tool(...)"
    pub static ref CODEX_MCP_RE: Regex = Regex::new(
        r"^[•◦]\s*(?:Calling|Called)\s+(\S+)\((.+?)\)"
    ).unwrap();
    // Startup: "OpenAI Codex v0.98.0" or ">_ OpenAI Codex (v0.98.0)"
    pub static ref CODEX_VERSION_RE: Regex = Regex::new(
        r"(?:>_\s*)?OpenAI Codex\s*(?:\(v|v)([\d.]+)"
    ).unwrap();
    // Model line: "Model:  gpt-5.1-codex-max" or "model: gpt-5.3-codex"
    pub static ref CODEX_MODEL_RE: Regex = Regex::new(
        r"(?i)^(?:\s*model:\s*)(\S+)"
    ).unwrap();

    // ─── Kiro CLI patterns ────────────────────────────────────────────
    // Tool call patterns: "✓ read /path" or "? shell git status" or "✓ write file.ts"
    pub static ref KIRO_TOOL_RE: Regex = Regex::new(
        r"^[✓?xo⊷✗\-]\s+(read|glob|grep|write|shell|aws|web_search|web_fetch|introspect|code|delegate|report|knowledge|thinking|todo|session|subagent)\b"
    ).unwrap();

    // ─── Port detection ─────────────────────────────────────────────
    pub static ref PORT_RE: Regex = Regex::new(r"port\s*(\d{2,5})").unwrap();
}
