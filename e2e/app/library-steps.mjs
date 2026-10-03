// Shared steps for the HOD-* scenarios: the prompt library (Hodios) inside
// Hermes 2.1, on the real app.
//
// - The Library opens from the activity bar; its first open imports the
//   catalog bundled with the build (staged next to the test binary as
//   bin/library/catalog-v1.tar.zst by build.mjs).
// - `readBundledCatalog` reads that same archive here, so a scenario can
//   pick real entries and build a newer catalog from it.
// - `catalogServer` serves a catalog the way hodios-dist lays it out
//   (manifest.json, manifest.json.minisig, o/<aa>/<sha256>) on 127.0.0.1;
//   `minisignKey` signs a manifest with a throwaway minisign key that the
//   test build trusts through HERMES_E2E_LIBRARY_PUBKEY (test builds only).
//
// Fixtures are synthetic; no real catalog mirror, account or user folder is
// ever touched.

import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import zlib from "node:zlib";
import { REPO_ROOT, appBinaryPath, sleep } from "./harness.mjs";

export const invoke = (bridge, cmd, args) =>
  bridge.eval(
    `return await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args ?? {})});`,
    { timeoutMs: 60_000 },
  );

/** Types into a React-controlled field the way typing does. */
export const typeValue = (bridge, selector, value) =>
  bridge.eval(`
    const el = e2e.must(e2e.first(${JSON.stringify(selector)}), ${JSON.stringify(selector)});
    const proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : el.tagName === "SELECT" ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
    el.focus();
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event(el.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
    return el.value;
  `);

// ─── The Library view ──────────────────────────────────────────────────

/** Opens the Library from the activity bar and waits until it is searchable. */
export async function openLibrary(bridge, { timeoutMs = 60_000 } = {}) {
  await bridge.clickWhenReady(`
    if (e2e.first('[data-testid="library-view"]')) return true;
    return e2e.click(e2e.must(e2e.first('.activity-bar [data-tab-id="library"]'), "the Library button"));
  `);
  await bridge.waitFor(
    "the Library, ready",
    `return e2e.first('[data-testid="library-view"]')?.getAttribute("data-ready") === "true";`,
    { timeoutMs },
  );
}

export async function closeLibrary(bridge) {
  await bridge.eval(`
    const v = e2e.first('[data-testid="library-view"]');
    if (!v) return true;
    e2e.click(e2e.must(v.querySelector(".lib-head > .h-close-btn"), "the Library's close button"));
    return true;
  `);
  await bridge.waitFor(
    "the Library to close",
    `return !e2e.first('[data-testid="library-view"]');`,
  );
}

/** What the Library shows now. */
export const libraryState = (bridge) =>
  bridge.eval(`
    const v = e2e.first('[data-testid="library-view"]');
    const rows = e2e.all('[data-testid="library-results"] .lib-row');
    return {
      open: !!v,
      ready: v?.getAttribute("data-ready") === "true",
      home: !!e2e.first('[data-testid="library-home"]'),
      personalised: e2e.first(".lib-context")?.getAttribute("data-personalised") ?? null,
      shelves: e2e.all(".lib-shelf").map((s) => ({
        id: s.getAttribute("data-shelf"),
        title: e2e.norm(s.querySelector(".lib-shelf-title")?.innerText ?? ""),
        why: e2e.norm(s.querySelector(".lib-shelf-why")?.innerText ?? ""),
        cards: [...s.querySelectorAll(".lib-card")].map((c) => ({
          id: c.getAttribute("data-entry"),
          reasons: (c.querySelector(".lib-card-why")?.getAttribute("data-reasons") ?? "").split(" ").filter(Boolean),
          why: e2e.norm(c.querySelector(".lib-card-why")?.innerText ?? ""),
        })),
      })),
      total: e2e.norm(e2e.first('[data-testid="library-total"]')?.innerText ?? ""),
      rows: rows.map((r) => r.getAttribute("data-entry")),
      renderedRows: rows.length,
      listCount: Number(e2e.first(".lib-rows")?.getAttribute("data-count") ?? 0),
      detail: e2e.first(".lib-detail")?.getAttribute("data-entry") ?? null,
      detailTitle: e2e.norm(e2e.first(".lib-detail-title")?.innerText ?? ""),
      preview: e2e.first('[data-testid="library-preview"]')?.textContent ?? null,
      blocked: e2e.norm(e2e.first(".lib-blocked")?.innerText ?? ""),
      useDisabled: e2e.first(".lib-use")?.disabled ?? null,
    };
  `);

/** Types a query and waits for the answer to it (results for this text). */
export async function search(bridge, query, { minRows = 1 } = {}) {
  await typeValue(bridge, ".lib-search-input", query);
  return bridge.waitFor(
    `results for "${query}"`,
    `
    const res = e2e.first('[data-testid="library-results"]');
    if (!res) return false;
    if (e2e.first('.lib-search-input')?.value !== ${JSON.stringify(query)}) return false;
    if (e2e.first('[data-testid="library-view"]')?.getAttribute("data-answered") !== ${JSON.stringify(query)}) return false;
    if (res.querySelector(".lib-results-head .lib-muted")?.innerText.match(/search/i)) return false;
    const rows = e2e.all('[data-testid="library-results"] .lib-row').map((r) => r.getAttribute("data-entry"));
    return rows.length >= ${minRows} ? rows : false;
  `,
    { timeoutMs: 20_000 },
  );
}

/** Opens an entry (a result row or a shelf card) and waits for its detail. */
export async function openEntry(bridge, id) {
  await bridge.clickWhenReady(`
    const el = e2e.first('.lib-row[data-entry=${JSON.stringify(id)}], .lib-card[data-entry=${JSON.stringify(id)}]');
    return el ? e2e.click(el) : false;
  `);
  await bridge.waitFor(
    `the detail of ${id}`,
    `
    const d = e2e.first(".lib-detail");
    return d?.getAttribute("data-entry") === ${JSON.stringify(id)} && !!e2e.first(".lib-detail-title");
  `,
    { timeoutMs: 20_000 },
  );
}

/** Fills one argument of the open entry's form. */
export async function fillArg(bridge, name, value) {
  return typeValue(
    bridge,
    `.lib-detail .lib-field[data-arg=${JSON.stringify(name)}] textarea, .lib-detail .lib-field[data-arg=${JSON.stringify(name)}] input`,
    value,
  );
}

/** Waits for the open entry's rendered preview to contain `text`. */
export async function waitPreview(bridge, text) {
  return bridge.waitFor(
    `the preview to show "${text.slice(0, 40)}"`,
    `
    const p = e2e.first('[data-testid="library-preview"]')?.textContent ?? "";
    return p.includes(${JSON.stringify(text)}) ? p : false;
  `,
    { timeoutMs: 20_000 },
  );
}

/** Picks the session "Use in session" sends to. */
export async function chooseTarget(bridge, sessionId) {
  await bridge.waitFor(
    `the session ${sessionId} in the target list`,
    `return !![...(e2e.first("#lib-use-target")?.options ?? [])].find((o) => o.value === ${JSON.stringify(sessionId)});`,
  );
  await typeValue(bridge, "#lib-use-target", sessionId);
}

// ─── The bundled catalog, read here ────────────────────────────────────

/** Where the staged test app keeps the bundled archive (else the checkout's). */
export function bundledArchivePath() {
  const staged = join(
    dirname(appBinaryPath()),
    "library",
    "catalog-v1.tar.zst",
  );
  return existsSync(staged)
    ? staged
    : join(REPO_ROOT, "src-tauri", "library", "catalog-v1.tar.zst");
}

export const sha256Hex = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
export const objectRel = (hex) => `o/${hex.slice(0, 2)}/${hex}`;
const refRel = (ref) => objectRel(ref.replace(/^sha256:/, ""));

function untar(buf) {
  const files = new Map();
  let off = 0;
  const str = (b) => b.toString("utf8").replace(/\0.*$/s, "");
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const name = str(h.subarray(0, 100));
    const prefix = str(h.subarray(345, 500));
    const size = parseInt(str(h.subarray(124, 136)).trim() || "0", 8);
    files.set(
      prefix ? `${prefix}/${name}` : name,
      Buffer.from(buf.subarray(off + 512, off + 512 + size)),
    );
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

/**
 * The bundled catalog: `{ manifest, manifestBytes, objects, rows, tiers,
 * body(row) }` where `objects` maps "o/aa/<sha>" to bytes, `rows` are the
 * rows of every tier and `tiers` maps each tier to its shard list and the
 * rows of each of its shards.
 */
export function readBundledCatalog(path = bundledArchivePath()) {
  const files = untar(zlib.zstdDecompressSync(readFileSync(path)));
  const manifestBytes = files.get("manifest.json");
  if (!manifestBytes) throw new Error(`${path} has no manifest.json`);
  files.delete("manifest.json");
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const tiers = {};
  const rows = [];
  for (const [tier, ref] of Object.entries(manifest.tiers)) {
    const list = JSON.parse(files.get(refRel(ref.list)).toString("utf8"));
    const shards = {};
    for (const [key, shard] of Object.entries(list.shards)) {
      shards[key] = files
        .get(refRel(shard.object))
        .toString("utf8")
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l));
      rows.push(...shards[key]);
    }
    tiers[tier] = { list, shards };
  }
  const body = (row) =>
    JSON.parse(files.get(refRel(row.body)).toString("utf8"));
  return { manifest, manifestBytes, objects: files, rows, tiers, body };
}

/**
 * A newer catalog built from `base`: the same rows plus `extra` rows (each
 * `{ row, body }`; the body object is created, the row goes to the first
 * shard of its tier, curated by default), as sequence `seq`. Returns
 * `{ manifestBytes, objects, rows }` (the base objects plus the new ones;
 * the rows of every tier).
 */
export function newerCatalog(base, { seq, extra = [], catalog } = {}) {
  const objects = new Map(base.objects);
  const put = (text) => {
    const bytes = Buffer.from(text, "utf8");
    const hex = sha256Hex(bytes);
    objects.set(objectRel(hex), bytes);
    return { ref: `sha256:${hex}`, bytes: bytes.length };
  };
  const tiers = structuredClone(base.tiers);
  for (const { row, body } of extra) {
    const b = put(JSON.stringify(body));
    const tier = tiers[row.tier ?? "curated"];
    if (!tier) throw new Error(`the base catalog has no ${row.tier} tier`);
    const first = Object.keys(tier.shards)[0];
    tier.shards[first].push({ tier: "curated", ...row, body: b.ref, bytes: b.bytes });
    tier.changed = true;
  }
  const manifestTiers = { ...base.manifest.tiers };
  const rows = [];
  for (const [name, tier] of Object.entries(tiers)) {
    const tierRows = Object.values(tier.shards).flat();
    rows.push(...tierRows);
    if (!tier.changed) continue;
    const shards = {};
    for (const [key, shardRows] of Object.entries(tier.shards)) {
      const shard = put(shardRows.map((r) => JSON.stringify(r)).join("\n") + "\n");
      shards[key] = { ...tier.list.shards[key], object: shard.ref, rows: shardRows.length };
    }
    const list = put(JSON.stringify({ ...tier.list, shards }));
    manifestTiers[name] = { ...manifestTiers[name], list: list.ref, rows: tierRows.length };
  }
  const manifest = {
    ...base.manifest,
    ...(catalog ? { catalog } : {}),
    seq,
    tiers: manifestTiers,
  };
  return {
    manifestBytes: Buffer.from(
      JSON.stringify(manifest, null, 2) + "\n",
      "utf8",
    ),
    objects,
    rows,
  };
}

// ─── minisign (prehashed Ed25519), a throwaway key ────────────────────

/** A minisign key pair: `publicKey` (the base64 line of minisign.pub) and `sign(bytes)` (a .minisig text). */
export function minisignKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pk = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
  const keynum = randomBytes(8);
  const pub = Buffer.concat([Buffer.from("Ed"), keynum, pk]).toString("base64");
  const signManifest = (data) => {
    const digest = createHash("blake2b512").update(data).digest();
    const sig = sign(null, digest, privateKey);
    const trusted = `timestamp:${Math.floor(Date.now() / 1000)}\tfile:manifest.json\thashed`;
    const global = sign(
      null,
      Buffer.concat([sig, Buffer.from(trusted, "utf8")]),
      privateKey,
    );
    return [
      "untrusted comment: signature from a throwaway e2e key",
      Buffer.concat([Buffer.from("ED"), keynum, sig]).toString("base64"),
      `trusted comment: ${trusted}`,
      global.toString("base64"),
      "",
    ].join("\n");
  };
  return { publicKey: pub, sign: signManifest };
}

// ─── A catalog mirror on 127.0.0.1 ─────────────────────────────────────

/**
 * Serves `files` (a Map of relative path -> bytes, replaceable with
 * `serve(files)`), recording every request. `url` is the catalog base.
 */
export async function catalogServer() {
  let files = new Map();
  const hits = [];
  const server = createServer((req, res) => {
    const rel = decodeURIComponent((req.url || "/").split("?")[0]).replace(
      /^\/+/,
      "",
    );
    hits.push(rel);
    const body = files.get(rel);
    if (!body) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("404 Not Found");
      return;
    }
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": body.length,
    });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    serve(next) {
      files = next;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** The files of a catalog as a mirror serves them. */
export function mirrorFiles({ manifestBytes, objects }, signature) {
  const files = new Map(objects);
  files.set("manifest.json", manifestBytes);
  if (signature)
    files.set("manifest.json.minisig", Buffer.from(signature, "utf8"));
  return files;
}

export { sleep };
