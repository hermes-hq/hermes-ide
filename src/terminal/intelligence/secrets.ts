// ─── Secret-looking commands ─────────────────────────────────────────

/**
 * Whether a command line carries something that looks like a secret: an API
 * key or token, a password flag, an auth header, credentials in a URL, a
 * sensitive variable being set. Such lines never become suggestions or ghost
 * text, wherever they came from (the shell's history file or this session).
 *
 * Errs toward hiding: a missed suggestion costs a few keystrokes, a shown
 * secret can end up on a shared screen or recording.
 */
export function looksSecret(command: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(command));
}

const SENSITIVE_NAME = "(?:token|secret|passw(?:or)?d|passphrase|pwd|api_?key|apikey|access_?key|private_?key|client_?secret|credentials?|auth(?!or))";

const SECRET_PATTERNS: RegExp[] = [
  // Known key and token shapes
  /\bsk-[A-Za-z0-9_-]{16,}/, // OpenAI, Anthropic (sk-ant-…), and others
  /\bgh[pousr]_[A-Za-z0-9]{20,}/, // GitHub
  /\bgithub_(?:pat)_[A-Za-z0-9_]{20,}/, // GitHub fine-grained
  /\bglpat-[A-Za-z0-9_-]{20,}/, // GitLab
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/, // Slack
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{35}/, // Google
  /\bnpm_[A-Za-z0-9]{36}/, // npm
  /\bhf_[A-Za-z0-9]{30,}/, // Hugging Face
  /\bpypi-[A-Za-z0-9_-]{20,}/,
  /\b(?:sk|rk|pk)_live_[A-Za-z0-9]{10,}/, // Stripe
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/, // SendGrid
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,

  // A sensitive variable set to a value: export GITHUB_TOKEN=…, PASSWORD=… cmd,
  // $env:API_KEY = "…", password=… in a form body
  new RegExp(`${SENSITIVE_NAME}[A-Za-z0-9_]*\\s*=\\s*\\S`, "i"),
  // fish: set -gx OPENAI_API_KEY …
  new RegExp(`(?:^|[\\s;|&])set\\s+(?:-[A-Za-z]+\\s+)*[A-Za-z0-9_]*${SENSITIVE_NAME}[A-Za-z0-9_]*\\s+\\S`, "i"),

  // A password or token passed as a flag: --password x, --token=x, -pass pass:x
  /(?:^|\s)--?(?:password|passwd|pass|token|secret|api-?key|auth-?token|access-?token|client-?secret|private-?key)(?:=|\s+)\S/i,
  // mysql -pSECRET (the password glued to -p)
  /\b(?:mysql|mysqldump|mysqladmin|mariadb)\b.*\s-p[^\s-]/,
  // sshpass -p x, docker login -p x
  /\bsshpass\b.*\s-p\s*\S/,
  /\blogin\b.*\s-p\s+\S/,
  // curl -u user:pass
  /\b(?:curl|wget|http|https)\b.*\s(?:-u|--user)\s+[^\s:]+:\S/,

  // Auth headers
  /\b(?:authorization|proxy-authorization|x-api-key|api-key|x-auth-token|private-token|cookie)\s*:/i,
  /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/i,

  // Credentials in a URL: https://user:pass@host
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i,
];
