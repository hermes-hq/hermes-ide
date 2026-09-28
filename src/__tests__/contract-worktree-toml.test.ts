/** C0 contracts: the .hermes/worktree.toml reader. */
import { describe, it, expect } from "vitest";
import { EMPTY_WORKTREE_CONFIG, parseWorktreeToml } from "../agent/contract/worktreeToml";

const FULL = `
# Worktree recipe for this repository
setup = ["npm ci", "cargo fetch"]   # in order
copy = [".env*", 'config/local.json']
done_when = [
  "npm test",
  "npm run lint", # trailing comma is fine
]

[ports]
web = 3000
api = 8_080
`;

describe("parseWorktreeToml", () => {
  it("reads setup, copy, done_when and ports", () => {
    expect(parseWorktreeToml(FULL)).toEqual({
      ok: true,
      config: {
        setup: ["npm ci", "cargo fetch"],
        copy: [".env*", "config/local.json"],
        doneWhen: ["npm test", "npm run lint"],
        ports: { web: 3000, api: 8080 },
        ignored: [],
      },
    });
  });

  it("treats a missing or empty file as no recipe (behaviour unchanged)", () => {
    expect(parseWorktreeToml("")).toEqual({ ok: true, config: EMPTY_WORKTREE_CONFIG });
    expect(parseWorktreeToml("# only a comment\n")).toEqual({ ok: true, config: EMPTY_WORKTREE_CONFIG });
  });

  it("keeps keys it does not know so an older Hermes still reads a newer file", () => {
    const r = parseWorktreeToml('setup = ["a"]\nshared_deps = true\n[cache]\ndir = "x"\n');
    expect(r).toMatchObject({ ok: true, config: { setup: ["a"], ignored: ["shared_deps", "cache"] } });
  });

  it("understands escapes in basic strings and none in literal strings", () => {
    const r = parseWorktreeToml('setup = ["echo \\"hi\\"\\n", \'C:\\\\path\']');
    expect(r).toMatchObject({ ok: true, config: { setup: ['echo "hi"\n', "C:\\\\path"] } });
    expect(parseWorktreeToml('setup = ["#not a comment"] # a comment')).toMatchObject({ ok: true, config: { setup: ["#not a comment"] } });
  });

  it.each<[string, string, number]>([
    ['setup = "npm ci"', "setup must be an array of strings", 0],
    ["setup = [1, 2]", "setup must be an array of strings", 0],
    ["copy = [\"a\"", "unterminated array", 1],
    ['\n\nsetup = [\n  "a",\n  oops\n]', "cannot read value oops", 3],
    ["ports = 3000", "ports must be a [ports] table", 0],
    ["[ports]\nweb = 70000", "ports.web must be a port number (1-65535)", 0],
    ['[ports]\nweb = "3000"', "ports.web must be a port number (1-65535)", 0],
    ["just words", "expected key = value", 1],
    ['setup = ["a"]\nsetup = ["b"]', "key setup defined twice", 2],
    ["[ports]\n[ports]", "table [ports] defined twice", 2],
    ["[a.b]\nx = 1", "only [name] tables are supported", 1],
    ['name = "unterminated', "unterminated string", 1],
  ])("refuses %j with a line number", (text, error, line) => {
    expect(parseWorktreeToml(text)).toEqual({ ok: false, error, line });
  });
});
