// ─── Prompt library types (mirrors src-tauri/src/library) ─────────────

export type EntryKind = "prompt" | "persona" | "workflow" | "rule" | "style";

/** Why an entry is where it is; `code` picks the sentence, `label` fills it. */
export interface Reason {
  code: "pinned" | "used" | "stack" | "role" | "subject" | "domain" | "category" | "stage" | "affinity" | "agent";
  value: string;
  label: string;
}

/** One row of a search page or a shelf (never the body). */
export interface LibraryHit {
  id: string;
  version: string;
  kind: EntryKind;
  title: string;
  description: string;
  domain: string;
  domainLabel: string;
  category: string;
  categoryLabel: string;
  status: string;
  tier: string;
  works: string[];
  stack: string[];
  stage: string[];
  score: number;
  reasons: Reason[];
  isNew: boolean;
  rank: number;
}

export interface SearchRequest {
  query: string;
  filters?: Record<string, string[]>;
  cursor?: string | null;
  limit?: number;
  sort?: "you" | "best" | "new";
  personalise?: boolean;
  includeHidden?: boolean;
  counts?: boolean;
}

export interface SearchPage {
  hits: LibraryHit[];
  total: number;
  totalCapped: boolean;
  nextCursor: string | null;
  kindCounts: Record<string, number>;
  tookMs: number;
}

/** What the UI knows about the moment; used on the device only. */
export interface LibraryContext {
  projectPath?: string | null;
  /** hodios target ids of the agents installed here. */
  works?: string[];
  /** hodios target id of the focused session's agent. */
  activeWork?: string | null;
  /** The active Feature Track phase (a hodios `stage`). */
  stage?: string | null;
  showEverything?: boolean;
}

export interface Labeled {
  value: string;
  label: string;
}

export interface Shelf {
  id: "project" | "role" | "continue" | "now" | "new" | "start";
  hits: LibraryHit[];
  because: Labeled[];
}

export interface LibraryProfile {
  roles: string[];
  domains: string[];
  categories: string[];
  subjects: string[];
  stack: string[];
  level?: string | null;
  /** "on" (default), "paused" (no learning) or "off" (show everything). */
  personalise?: "on" | "paused" | "off" | null;
}

export interface CatalogInfo {
  catalog: string;
  seq: number;
  manifestSha256: string;
  source: string;
  rows: number;
  appliedAt: number;
}

export interface DomainCount {
  id: string;
  label: string;
  count: number;
  mine: boolean;
}

export interface Shelves {
  shelves: Shelf[];
  personalised: boolean;
  stack: Labeled[];
  projectAgents: string[];
  profile: LibraryProfile;
  domains: DomainCount[];
  catalog: CatalogInfo | null;
}

export interface ItemState {
  itemId: string;
  pinned: boolean;
  favorite: boolean;
  hidden: boolean;
  useCount: number;
  lastUsedAt: number | null;
}

/** An argument of an entry (hodios schema `args`). */
export interface EntryArg {
  name: string;
  description: string;
  type?: "text" | "enum" | "boolean" | "number" | string;
  required?: boolean;
  enum?: string[];
  default?: string | number | boolean;
}

/** The body object `{schema, fm, body, steps}` (hodios-core ResolvedEntry). */
export interface EntryBody {
  schema: 1;
  fm: {
    id: string;
    kind: EntryKind;
    title: string;
    description?: string;
    version: string;
    args?: EntryArg[];
    levels?: { label: string; instruction: string }[];
    changelog?: { version: string; note: string }[];
    [key: string]: unknown;
  };
  body: string;
  steps: { id: string; stage?: string; gate?: string; artifact?: string; text: string }[];
}

export interface EntryDetail {
  id: string;
  resolvedFrom: string | null;
  row: Record<string, unknown> & { id: string; v: string; kind: EntryKind; title: string; desc: string; dom: string; cat: string; status: string; tier: string; works: string[] };
  body: EntryBody | null;
  state: ItemState;
  isNew: boolean;
}

export type UpdateOutcome =
  | { outcome: "off" }
  | { outcome: "upToDate"; catalog: string; seq: number }
  | { outcome: "available"; catalog: string; seq: number }
  | { outcome: "applied"; summary: ApplySummary; bytes: number }
  | { outcome: "refused"; reason: string; code: "unsigned" | "signature" | "key" | "older" | "hash" | "schema" | "format" | string }
  | { outcome: "failed"; reason: string };

export interface ApplySummary {
  catalog: string;
  seq: number;
  rows: number;
  added: string[];
  changed: [string, string, string][];
  removed: string[];
  revoked: string[];
}

export interface LibraryStatus {
  ready: boolean;
  catalog: CatalogInfo | null;
  bundled: [string, number] | null;
  hasBundledArchive: boolean;
  offlineBodies: number;
  updates: "auto" | "notify" | "off" | string;
  lastCheck: number | null;
  lastSuccess: number | null;
  lastError: string | null;
  trustedKeys: number;
  importMs: number | null;
  lastOutcome: UpdateOutcome | null;
  checking: boolean;
  error: string | null;
}

/** One file compiled by hodios-core for a target, plus what the lock records. */
export interface CompiledFileForInstall {
  id: string;
  version: string;
  kind: string;
  target: string;
  format: string;
  path: string;
  content: string;
  section: boolean;
  catalog: string;
}

export interface FilePlan {
  path: string;
  status: "add" | "update" | "unchanged" | "edited";
  section: boolean;
  current: string | null;
  next: string;
  bytes: number;
}

export interface InstallPlan {
  files: FilePlan[];
  lockBefore: string | null;
  lockAfter: string;
}

export interface InstallResult {
  written: string[];
  sideFiles: string[];
  unchanged: string[];
  entries: { id: string; version: string; target: string; path: string; hash: string }[];
}

export interface InstallRecord {
  projectPath: string;
  itemId: string;
  agentId: string;
  version: string;
  path: string;
  hash: string;
  installedAt: number;
}

export interface ProjectInstalls {
  lock: { schema: number; entries: { id: string; version: string; kind: string; target: string; format: string; path: string; section: boolean; hash: string; catalog: string }[] };
  records: InstallRecord[];
}
