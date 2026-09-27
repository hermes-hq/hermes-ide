// Minisign signature verification, as produced by `tauri signer sign` and
// read by the Tauri updater. Zero dependencies (Node 20+).
//
// Tauri stores the public key and every `.sig` file as base64 of the whole
// minisign text:
//   untrusted comment: ...
//   <base64: 2-byte algorithm, 8-byte key id, 64-byte signature>
//   trusted comment: ...
//   <base64: 64-byte global signature over (signature || trusted comment)>
//
// Algorithm "Ed" signs the file bytes; "ED" (what Tauri uses) signs the
// BLAKE2b-512 hash of the file.

import { createHash, createPublicKey, createPrivateKey, sign as edSign, verify as edVerify } from "node:crypto";
import { readFileSync } from "node:fs";

const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/** Decode Tauri's base64 wrapper into the minisign text lines. */
function unwrap(b64) {
  const text = Buffer.from(String(b64).trim(), "base64").toString("utf8");
  return text.split(/\r?\n/).filter((l) => l.length > 0);
}

/** Parse a Tauri-encoded minisign public key. */
export function parsePublicKey(pubkeyB64) {
  const lines = unwrap(pubkeyB64);
  const dataLine = lines.find((l) => !l.startsWith("untrusted comment:"));
  if (!dataLine) throw new Error("public key: no key line");
  const raw = Buffer.from(dataLine, "base64");
  if (raw.length !== 42) throw new Error(`public key: expected 42 bytes, got ${raw.length}`);
  return {
    algorithm: raw.subarray(0, 2).toString("latin1"),
    keyId: raw.subarray(2, 10).toString("hex"),
    key: raw.subarray(10, 42),
  };
}

/** Parse a Tauri-encoded minisign signature (the content of a `.sig` file). */
export function parseSignature(sigB64) {
  const lines = unwrap(sigB64);
  if (lines.length < 4) throw new Error(`signature: expected 4 lines, got ${lines.length}`);
  const [untrusted, sigLine, trustedLine, globalLine] = lines;
  if (!untrusted.startsWith("untrusted comment:")) throw new Error("signature: line 1 is not the untrusted comment");
  if (!trustedLine.startsWith("trusted comment:")) throw new Error("signature: line 3 is not the trusted comment");
  const raw = Buffer.from(sigLine, "base64");
  if (raw.length !== 74) throw new Error(`signature: expected 74 bytes, got ${raw.length}`);
  const globalSig = Buffer.from(globalLine, "base64");
  if (globalSig.length !== 64) throw new Error(`signature: global signature must be 64 bytes, got ${globalSig.length}`);
  return {
    algorithm: raw.subarray(0, 2).toString("latin1"),
    keyId: raw.subarray(2, 10).toString("hex"),
    signature: raw.subarray(10, 74),
    trustedComment: trustedLine.slice("trusted comment:".length).trim(),
    globalSignature: globalSig,
  };
}

function publicKeyObject(raw) {
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: "der", type: "spki" });
}

/**
 * Verify that `sigB64` (Tauri `.sig` content) signs the bytes of `filePath`
 * with `pubkeyB64` (the `plugins.updater.pubkey` value).
 * Returns { ok, reason?, keyId, trustedComment }.
 */
export function verifyFile(pubkeyB64, sigB64, filePath) {
  return verifyBytes(pubkeyB64, sigB64, readFileSync(filePath));
}

export function verifyBytes(pubkeyB64, sigB64, data) {
  let pub;
  let sig;
  try {
    pub = parsePublicKey(pubkeyB64);
    sig = parseSignature(sigB64);
  } catch (e) {
    return { ok: false, reason: e.message };
  }
  if (sig.keyId !== pub.keyId) {
    return { ok: false, reason: `signed with key ${sig.keyId}, expected ${pub.keyId}`, keyId: sig.keyId };
  }
  let message;
  if (sig.algorithm === "ED") {
    message = createHash("blake2b512").update(data).digest();
  } else if (sig.algorithm === "Ed") {
    message = data;
  } else {
    return { ok: false, reason: `unknown signature algorithm ${JSON.stringify(sig.algorithm)}`, keyId: sig.keyId };
  }
  const key = publicKeyObject(pub.key);
  if (!edVerify(null, message, key, sig.signature)) {
    return { ok: false, reason: "signature does not match the file", keyId: sig.keyId, trustedComment: sig.trustedComment };
  }
  const globalMessage = Buffer.concat([sig.signature, Buffer.from(sig.trustedComment, "utf8")]);
  if (!edVerify(null, globalMessage, key, sig.globalSignature)) {
    return { ok: false, reason: "trusted comment was tampered with", keyId: sig.keyId, trustedComment: sig.trustedComment };
  }
  return { ok: true, keyId: sig.keyId, trustedComment: sig.trustedComment };
}

// ─── Signing (test rigs only; releases are signed by the Tauri CLI) ──

/** Make a Tauri-style key pair from a raw 32-byte Ed25519 seed. */
export function keyPairFromSeed(seed, keyIdHex = "0123456789abcdef") {
  if (seed.length !== 32) throw new Error("seed must be 32 bytes");
  const priv = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" });
  const pubRaw = createPublicKey(priv).export({ format: "der", type: "spki" }).subarray(SPKI_PREFIX.length);
  const keyId = Buffer.from(keyIdHex, "hex");
  const pubLine = Buffer.concat([Buffer.from("Ed", "latin1"), keyId, pubRaw]).toString("base64");
  const pubText = `untrusted comment: minisign public key: ${keyIdHex.toUpperCase()}\n${pubLine}\n`;
  return { privateKey: priv, keyId, pubkeyB64: Buffer.from(pubText, "utf8").toString("base64") };
}

/** Sign `data` the way `tauri signer sign` does (prehashed, "ED"). */
export function signBytes({ privateKey, keyId }, data, trustedComment = `timestamp:${Math.floor(Date.now() / 1000)}\tfile:unknown`) {
  const message = createHash("blake2b512").update(data).digest();
  const signature = edSign(null, message, privateKey);
  const globalSignature = edSign(null, Buffer.concat([signature, Buffer.from(trustedComment, "utf8")]), privateKey);
  const sigLine = Buffer.concat([Buffer.from("ED", "latin1"), keyId, signature]).toString("base64");
  const text =
    `untrusted comment: signature from tauri secret key\n${sigLine}\n` +
    `trusted comment: ${trustedComment}\n${globalSignature.toString("base64")}\n`;
  return Buffer.from(text, "utf8").toString("base64");
}
