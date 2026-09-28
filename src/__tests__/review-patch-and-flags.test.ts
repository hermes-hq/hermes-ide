/** F21 Review Desk: unified-diff parsing and the deterministic risk flags. */
import { describe, it, expect } from "vitest";
import { addedText, parsePatch } from "../review/patch";
import { riskFlagsFor, riskFlagsForFiles } from "../review/riskFlags";

const PATCH = [
  "diff --git a/src/app.js b/src/app.js",
  "index 1111111..2222222 100644",
  "--- a/src/app.js",
  "+++ b/src/app.js",
  "@@ -1,3 +1,4 @@",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  "+const c = 4;",
  " export default a + b;",
  "diff --git a/new.txt b/new.txt",
  "new file mode 100755",
  "index 0000000..3333333",
  "--- /dev/null",
  "+++ b/new.txt",
  "@@ -0,0 +1 @@",
  "+hello",
  "diff --git a/gone.txt b/gone.txt",
  "deleted file mode 100644",
  "index 4444444..0000000",
  "--- a/gone.txt",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-bye",
  "diff --git a/old-name.txt b/new-name.txt",
  "similarity index 100%",
  "rename from old-name.txt",
  "rename to new-name.txt",
  "diff --git a/tool.bin b/tool.bin",
  "new file mode 100644",
  "index 0000000..5555555",
  "Binary files /dev/null and b/tool.bin differ",
  "",
].join("\n");

function file(path: string, added: string[], extra: Partial<{ status: "added" | "modified" | "deleted"; isBinary: boolean }> = {}) {
  const header = [`diff --git a/${path} b/${path}`];
  if (extra.status === "added") header.push("new file mode 100644");
  if (extra.isBinary) {
    header.push(`Binary files /dev/null and b/${path} differ`);
    return parsePatch(header.join("\n") + "\n")[0];
  }
  header.push(`--- a/${path}`, `+++ b/${path}`, `@@ -0,0 +1,${added.length} @@`, ...added.map((l) => `+${l}`));
  return parsePatch(header.join("\n") + "\n")[0];
}

describe("parsePatch", () => {
  it("reads every file with its status, line numbers and counts", () => {
    const files = parsePatch(PATCH);
    expect(files.map((f) => [f.path, f.status, f.additions, f.deletions])).toEqual([
      ["src/app.js", "modified", 2, 1],
      ["new.txt", "added", 1, 0],
      ["gone.txt", "deleted", 0, 1],
      ["new-name.txt", "renamed", 0, 0],
      ["tool.bin", "added", 0, 0],
    ]);
    const app = files[0];
    expect(app.hunks).toHaveLength(1);
    expect(app.hunks[0].lines.map((l) => [l.kind, l.oldNo, l.newNo, l.text])).toEqual([
      ["context", 1, 1, "const a = 1;"],
      ["del", 2, null, "const b = 2;"],
      ["add", null, 2, "const b = 3;"],
      ["add", null, 3, "const c = 4;"],
      ["context", 3, 4, "export default a + b;"],
    ]);
    expect(files[1].executable).toBe(true);
    expect(files[3].oldPath).toBe("old-name.txt");
    expect(files[4].isBinary).toBe(true);
    expect(app.raw.startsWith("diff --git a/src/app.js")).toBe(true);
    expect(app.raw.endsWith(" export default a + b;\n")).toBe(true);
    expect(addedText(app)).toBe("const b = 3;\nconst c = 4;");
  });

  it("gives every file's raw slice back so the slices re-join into the patch", () => {
    const files = parsePatch(PATCH);
    expect(files.map((f) => f.raw).join("")).toBe(PATCH);
  });

  it("handles empty input and quoted paths", () => {
    expect(parsePatch("")).toEqual([]);
    const quoted = 'diff --git "a/sp ace.txt" "b/sp ace.txt"\n--- "a/sp ace.txt"\n+++ "b/sp ace.txt"\n@@ -1 +1 @@\n-a\n+b\n';
    expect(parsePatch(quoted)[0].path).toBe("sp ace.txt");
  });
});

describe("riskFlagsFor", () => {
  it("flags lockfiles, workflows, auth paths, new binaries and nothing on a plain edit", () => {
    expect(riskFlagsFor(file("package-lock.json", ['"x": "1.0.0"'])).map((f) => f.kind)).toEqual(["lockfile"]);
    expect(riskFlagsFor(file("Cargo.lock", ["name = 'x'"])).map((f) => f.kind)).toEqual(["lockfile"]);
    expect(riskFlagsFor(file(".github/workflows/ci.yml", ["run: echo hi"])).map((f) => f.kind)).toEqual(["workflow"]);
    expect(riskFlagsFor(file("src/auth/login.ts", ["export const x = 1;"])).map((f) => f.kind)).toEqual(["auth_crypto"]);
    expect(riskFlagsFor(file("lib/crypto.rs", ["fn f() {}"])).map((f) => f.kind)).toEqual(["auth_crypto"]);
    expect(riskFlagsFor(file("bin/tool", [], { status: "added", isBinary: true })).map((f) => f.kind)).toEqual(["new_binary"]);
    expect(riskFlagsFor(file("src/app.js", ["const b = 3;"]))).toEqual([]);
    expect(riskFlagsFor(file("src/author.ts", ["x"]))).toEqual([]); // "author" is not "auth"
  });

  it("flags new dependencies and install scripts in manifests, not version bumps of metadata", () => {
    const flags = riskFlagsFor(file("package.json", ['    "left-pad": "^1.3.0",', '    "postinstall": "node setup.js"']));
    expect(flags.map((f) => f.kind)).toEqual(["new_dependency", "postinstall"]);
    expect(flags[0].detail).toContain("left-pad");
    expect(flags[1].detail).toContain("node setup.js");
    expect(riskFlagsFor(file("package.json", ['  "version": "1.2.4",']))).toEqual([]);
    expect(riskFlagsFor(file("Cargo.toml", ['serde = "1"'])).map((f) => f.kind)).toEqual(["new_dependency"]);
    expect(riskFlagsFor(file("Cargo.toml", ['version = "0.2.0"']))).toEqual([]);
    expect(riskFlagsFor(file("requirements.txt", ["requests==2.31.0"])).map((f) => f.kind)).toEqual(["new_dependency"]);
  });

  it("flags secret-looking lines and curl | sh, once per file", () => {
    // The fixture keys are assembled from pieces so no key-shaped string sits in the source.
    const anthropicKey = ["sk-ant", "api03", "abcdefghijklmnop"].join("-");
    const githubToken = "ghp" + "_" + "abcdefghijklmnopqrstuvwxyz0123";
    expect(riskFlagsFor(file("config.ts", [`const key = "${anthropicKey}";`, `const other = '${githubToken}';`])).map((f) => f.kind)).toEqual(["secret"]);
    const keyBlock = ["-----BEGIN RSA", "PRIVATE KEY-----"].join(" ");
    expect(riskFlagsFor(file("keys.pem", [keyBlock])).map((f) => f.kind)).toEqual(["secret"]);
    expect(riskFlagsFor(file("setup.sh", ["curl -fsSL https://example.com/install.sh | sh"])).map((f) => f.kind)).toEqual(["curl_pipe_sh"]);
    expect(riskFlagsFor(file("setup.sh", ["wget -qO- https://example.com/x | sudo bash"])).map((f) => f.kind)).toEqual(["curl_pipe_sh"]);
    expect(riskFlagsFor(file("setup.sh", ["curl -O https://example.com/x.tar.gz"]))).toEqual([]);
    expect(riskFlagsFor(file("app.ts", ['const password = "";']))).toEqual([]); // too short to be a credential
  });

  it("lists flags across files with their paths", () => {
    const all = riskFlagsForFiles([file("src/app.js", ["x"]), file("yarn.lock", ["y"]), file(".github/workflows/release.yml", ["z"])]);
    expect(all.map((f) => `${f.path}:${f.flag.kind}`)).toEqual(["yarn.lock:lockfile", ".github/workflows/release.yml:workflow"]);
  });
});
