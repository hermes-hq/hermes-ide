// Behavioural tests for the README claims gate: tag discovery, the claims
// map's own shape, and the cross-checks against README.md and the ledger.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadLedger, listScenarioFiles, parseYaml } from "../e2e/app/acceptance.mjs";
import { REPO_ROOT, SCENARIOS_DIR } from "../e2e/app/harness.mjs";
import { checkClaims, findTaggedLines, ledgerScenarioFiles, loadClaims, normaliseClaims } from "./check-readme-claims.mjs";

describe("findTaggedLines", () => {
  it("finds every <!-- claim:id --> line, grouped by id", () => {
    const readme = [
      "# Title",
      "- **A thing** — does a thing <!-- claim:a-thing -->",
      "- plain bullet, no tag",
      "- **Another** — also proven here <!-- claim:another -->",
      "- repeated claim on a second line <!-- claim:a-thing -->",
    ].join("\n");
    const tagged = findTaggedLines(readme);
    expect([...tagged.keys()].sort()).toEqual(["a-thing", "another"]);
    expect(tagged.get("a-thing")).toHaveLength(2);
    expect(tagged.get("a-thing")[0].lineNumber).toBe(2);
  });
});

describe("normaliseClaims", () => {
  it("accepts scenario or scenarios and requires text", () => {
    const claims = normaliseClaims({ claims: { a: { text: "x", scenario: "s.mjs" }, b: { text: "y", scenarios: ["s.mjs", "t.mjs"] } } });
    expect(claims).toEqual([
      { id: "a", text: "x", scenarios: ["s.mjs"] },
      { id: "b", text: "y", scenarios: ["s.mjs", "t.mjs"] },
    ]);
  });

  it("tolerates an empty claims map", () => {
    expect(normaliseClaims({ claims: null })).toEqual([]);
    expect(normaliseClaims({})).toEqual([]);
  });

  it("rejects a claim with no text or no scenario", () => {
    expect(() => normaliseClaims({ claims: { a: { scenario: "s.mjs" } } })).toThrow(/"text"/);
    expect(() => normaliseClaims({ claims: { a: { text: "x" } } })).toThrow(/at least one scenario/);
  });
});

describe("checkClaims", () => {
  const readme = "- **Multi-session** — proves it <!-- claim:multi -->\n";

  it("passes a claim whose text is on its tagged line and whose scenario is in the ledger and on disk", () => {
    const errors = checkClaims({
      readme,
      claims: [{ id: "multi", text: "proves it", scenarios: ["s.mjs"] }],
      ledgerScenarios: new Set(["s.mjs"]),
      scenarioFiles: ["s.mjs"],
    });
    expect(errors).toEqual([]);
  });

  it("fails a claim with no scenario at all", () => {
    const errors = checkClaims({
      readme,
      claims: [{ id: "multi", text: "proves it", scenarios: [] }],
      ledgerScenarios: new Set(),
      scenarioFiles: [],
    });
    expect(errors).toContain('docs/readme-claims.yml: claim "multi" has no scenario proving it');
  });

  it("fails a claim whose scenario is not referenced by the acceptance ledger", () => {
    const errors = checkClaims({
      readme,
      claims: [{ id: "multi", text: "proves it", scenarios: ["ghost.mjs"] }],
      ledgerScenarios: new Set(["s.mjs"]),
      scenarioFiles: ["s.mjs", "ghost.mjs"],
    });
    expect(errors).toEqual(['docs/readme-claims.yml: claim "multi" names ghost.mjs, which e2e/acceptance.yml does not reference from any feature']);
  });

  it("fails a claim whose scenario file does not exist on disk", () => {
    const errors = checkClaims({
      readme,
      claims: [{ id: "multi", text: "proves it", scenarios: ["s.mjs"] }],
      ledgerScenarios: new Set(["s.mjs"]),
      scenarioFiles: [],
    });
    expect(errors).toEqual(['docs/readme-claims.yml: claim "multi" names s.mjs, which does not exist under e2e/app/scenarios/']);
  });

  it("fails a README-tagged claim with no entry in the map", () => {
    const errors = checkClaims({
      readme: "- untracked claim <!-- claim:untracked -->\n",
      claims: [],
      ledgerScenarios: new Set(),
      scenarioFiles: [],
    });
    expect(errors).toEqual([
      'README.md:1 tags claim "untracked" with <!-- claim:untracked --> but docs/readme-claims.yml has no entry for it',
    ]);
  });

  it("fails a map entry whose tag was removed from README.md (stale)", () => {
    const errors = checkClaims({
      readme: "no tags here\n",
      claims: [{ id: "multi", text: "proves it", scenarios: ["s.mjs"] }],
      ledgerScenarios: new Set(["s.mjs"]),
      scenarioFiles: ["s.mjs"],
    });
    expect(errors).toEqual(['docs/readme-claims.yml: claim "multi" has no <!-- claim:multi --> line in README.md (stale entry)']);
  });

  it("fails when the map's text no longer matches the tagged line (drift)", () => {
    const errors = checkClaims({
      readme,
      claims: [{ id: "multi", text: "a different claim entirely", scenarios: ["s.mjs"] }],
      ledgerScenarios: new Set(["s.mjs"]),
      scenarioFiles: ["s.mjs"],
    });
    expect(errors[0]).toMatch(/is not found on its tagged README\.md line/);
  });
});

describe("ledgerScenarioFiles", () => {
  it("collects every scenario referenced by any feature's criteria", () => {
    const ledger = { features: [{ criteria: [{ scenarios: [{ file: "a.mjs" }, { file: "b.mjs" }] }, { scenarios: [{ file: "a.mjs" }] }] }] };
    expect(ledgerScenarioFiles(ledger)).toEqual(new Set(["a.mjs", "b.mjs"]));
  });
});

describe("the repository's own README claims", () => {
  it("passes against the real README.md and e2e/acceptance.yml", () => {
    const readme = readFileSync(join(REPO_ROOT, "README.md"), "utf8");
    const claims = loadClaims(join(REPO_ROOT, "docs", "readme-claims.yml"));
    const ledger = loadLedger(join(REPO_ROOT, "e2e", "acceptance.yml"));
    const scenarioFiles = listScenarioFiles(SCENARIOS_DIR);
    const errors = checkClaims({ readme, claims, ledgerScenarios: ledgerScenarioFiles(ledger), scenarioFiles });
    expect(errors).toEqual([]);
  });

  it("readme-claims.yml parses with the same YAML subset as the acceptance ledger", () => {
    expect(() => parseYaml(readFileSync(join(REPO_ROOT, "docs", "readme-claims.yml"), "utf8"))).not.toThrow();
  });
});
