/**
 * Typed event union for Claude Agent stream-json output.
 *
 * Phase 1 captured fixtures that show:
 * - `system` events with subtypes "init" and "status" (treat unknown subtypes generically)
 * - `stream_event` partial-message events that we DROP (we fold from full `assistant` events instead)
 * - `rate_limit_event` interleaving anywhere
 * - `assistant` content blocks: `thinking`, `tool_use`, `text`
 * - `user` messages with `tool_result` blocks (pair via `tool_use_id`)
 * - `result` is always last with `subtype: "success" | "error"`
 *
 * We use `unknown` fallbacks so unfamiliar subtypes don't crash the renderer.
 */

// === Content blocks (inside an assistant or user message) ===

export interface TextBlockData {
  type: "text";
  text: string;
}

export interface ThinkingBlockData {
  type: "thinking";
  thinking: string;
  signature?: string;
}

export interface ToolUseBlockData {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
  caller?: { type: string; [key: string]: unknown };
}

export interface ToolResultBlockData {
  type: "tool_result";
  tool_use_id: string;
  content: string | ContentBlock[];
  is_error?: boolean;
}

export interface ImageBlockData {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
}

export interface UnknownBlockData {
  type: string;
  [key: string]: unknown;
}

export type ContentBlock =
  | TextBlockData
  | ThinkingBlockData
  | ToolUseBlockData
  | ToolResultBlockData
  | ImageBlockData
  | UnknownBlockData;

// === Events ===

export interface InitEvent {
  type: "system";
  subtype: "init";
  cwd: string;
  session_id: string;
  uuid: string;
  tools: string[];
  slash_commands: string[] | { command: string; description: string }[];
  mcp_servers: { name: string; status: string }[];
  model: string;
  permissionMode: string;
  apiKeySource?: string;
  output_style?: string;
  agents?: unknown[];
  skills?: unknown[];
  plugins?: unknown[];
  /** Every CLAUDE.md the session loaded.  Surfaced in the Memory section
   *  of the Context Panel (M4). */
  memory_paths?: string[];
  [key: string]: unknown;
}

export interface SystemEvent {
  type: "system";
  subtype: string;
  [key: string]: unknown;
}

export interface AssistantMessage {
  id: string;
  role: "assistant";
  model: string;
  content: ContentBlock[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    [key: string]: unknown;
  };
  stop_reason?: string | null;
  [key: string]: unknown;
}

export interface AssistantEvent {
  type: "assistant";
  message: AssistantMessage;
  parent_tool_use_id?: string | null;
  session_id: string;
  uuid: string;
}

export interface UserMessage {
  role: "user";
  content: ContentBlock[];
  [key: string]: unknown;
}

export interface UserEvent {
  type: "user";
  message: UserMessage;
  session_id?: string;
  uuid?: string;
  parent_tool_use_id?: string | null;
  [key: string]: unknown;
}

export interface ResultEvent {
  type: "result";
  subtype: "success" | "error" | string;
  is_error: boolean;
  duration_ms?: number;
  duration_api_ms?: number;
  num_turns?: number;
  result?: string;
  stop_reason?: string;
  session_id?: string;
  total_cost_usd?: number;
  usage?: Record<string, unknown>;
  modelUsage?: Record<string, unknown>;
  permission_denials?: unknown[];
  uuid?: string;
  [key: string]: unknown;
}

export interface RateLimitInfo {
  status: string;
  resetsAt?: number | string;
  rateLimitType?: string;
  overageStatus?: string;
  overageResetsAt?: number | string;
  isUsingOverage?: boolean;
  [key: string]: unknown;
}

export interface RateLimitEvent {
  type: "rate_limit_event";
  rate_limit_info: RateLimitInfo;
  [key: string]: unknown;
}

export interface ParseErrorEvent {
  type: "parse_error";
  raw: string;
  error: string;
}

export interface UnknownAgentEvent {
  type: string;
  [key: string]: unknown;
}

/** Hermes-internal envelope: the bridge fires this when the live SDK
 *  runtime values it tracks (model, permissionMode) diverge from the
 *  last reported state — for example, after EnterPlanMode flips the
 *  session into plan mode without a respawn.  The composer's chip
 *  pickers and SessionContext both subscribe so the UI matches reality
 *  without waiting for a fresh init event (the SDK only emits init at
 *  spawn time). */
export interface StateChangedEvent {
  type: "_hermes_state_changed";
  session_id?: string;
  uuid?: string;
  model?: string;
  permissionMode?: string;
}

export type AgentEvent =
  | InitEvent
  | SystemEvent
  | AssistantEvent
  | UserEvent
  | ResultEvent
  | RateLimitEvent
  | ParseErrorEvent
  | StateChangedEvent
  | UnknownAgentEvent;

// === Helpers ===

export function isInitEvent(e: AgentEvent): e is InitEvent {
  return e.type === "system" && (e as { subtype?: string }).subtype === "init";
}

export function isStateChangedEvent(e: AgentEvent): e is StateChangedEvent {
  return e.type === "_hermes_state_changed";
}

export function isSystemEvent(e: AgentEvent): e is SystemEvent {
  return e.type === "system";
}

export function isAssistantEvent(e: AgentEvent): e is AssistantEvent {
  return e.type === "assistant";
}

export function isUserEvent(e: AgentEvent): e is UserEvent {
  return e.type === "user";
}

export function isResultEvent(e: AgentEvent): e is ResultEvent {
  return e.type === "result";
}

export function isRateLimitEvent(e: AgentEvent): e is RateLimitEvent {
  return e.type === "rate_limit_event";
}

export function isParseErrorEvent(e: AgentEvent): e is ParseErrorEvent {
  return e.type === "parse_error";
}

export function isStreamPartial(e: AgentEvent): boolean {
  return e.type === "stream_event";
}

export function isTextBlock(b: ContentBlock): b is TextBlockData {
  return b.type === "text";
}

export function isThinkingBlock(b: ContentBlock): b is ThinkingBlockData {
  return b.type === "thinking";
}

export function isToolUseBlock(b: ContentBlock): b is ToolUseBlockData {
  return b.type === "tool_use";
}

export function isToolResultBlock(b: ContentBlock): b is ToolResultBlockData {
  return b.type === "tool_result";
}
