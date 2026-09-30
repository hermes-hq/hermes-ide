//! Agent capabilities (2.0 launch contract): what each installed agent lets
//! a person choose at launch, the stored launch choices, and the launch
//! rejections the CLIs print.
//!
//! - `types`: the wire format, mirrored in `src/agent/capabilities/types.ts`.
//! - `parse`: parsers for what the CLIs' read-only probes print (`claude
//!   auth status --json`, `codex login status`, `codex debug models`, `agy
//!   models`, Claude's model cache), tested on the verbatim outputs of the
//!   capability matrix.
//! - `discover`: runs those probes with the same PATH a terminal gets and
//!   the account's profile environment, and builds `AgentCapabilities`;
//!   cached per CLI version and account. Nothing here writes a vendor's
//!   config or sign-in, and nothing a probe prints (an e-mail, an org name,
//!   a token) is kept or logged: only the facts the types carry.
//! - `choice`: the rules for a stored choice (default model, nearest effort,
//!   active account), validation, the "Hermes will run" preview, the
//!   combination key and the usual-combination picker. Pure.
//! - `store`: accounts Hermes added, launch history, presets, remembered
//!   choices and models an account rejected (SQLite, migration 5).
//! - `signatures`: matching a CLI's output against the catalog's
//!   `error_signatures` during a launch's first seconds (`watch`).
//! - `report`: the model an agent reports outside its hooks (Codex's rollout).
//! - `commands`: the Tauri commands.

pub mod choice;
pub mod commands;
pub mod discover;
pub mod parse;
pub mod report;
pub mod signatures;
pub mod store;
pub mod types;
pub mod watch;

pub use types::*;
