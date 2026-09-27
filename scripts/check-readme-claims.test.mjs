// Behavioural tests for the README claims gate: tag discovery, the claims
// map's own shape, and the cross-checks against README.md and the ledger.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadLedger, listScenarioFiles, parseYaml } from "../e2e/app/acceptance.mjs";
import { REPO_ROOT, SCENARIOS_DIR } from "../e2e/app/harness.mjs";
import { checkClaims, findFeatureBullets, findTaggedLines, ledgerScenarioFiles, loadClaims, normaliseClaims } from "./check-readme-claims.mjs";

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

  it("accepts an explicit unproven entry with a reason and a planned scenario, and nothing vaguer", () => {
    expect(normaliseClaims({ claims: { a: { text: "x", unproven: "no scenario yet", planned: "p.mjs" } } })).toEqual([
      { id: "a", text: "x", scenarios: [], unproven: "no scenario yet", planned: "p.mjs" },
    ]);
    expect(() => normaliseClaims({ claims: { a: { text: "x", unproven: "", planned: "p.mjs" } } })).toThrow(/must say why/);
    expect(() => normaliseClaims({ claims: { a: { text: "x", unproven: "y", planned: "p.mjs", scenario: "s.mjs" } } })).toThrow(/both scenarios and "unproven"/);
    expect(() => normaliseClaims({ claims: { a: { text: "x", unproven: "y" } } })).toThrow(/planned: <file>\.mjs/);
    expect(() => normaliseClaims({ claims: { a: { text: "x", unproven: "y", planned: "not a file" } } })).toThrow(/planned: <file>\.mjs/);
    expect(() => normaliseClaims({ claims: { a: { text: "x", scenario: "s.mjs", planned: "p.mjs" } } })).toThrow(/only goes with "unproven"/);
  });
});

describe("findFeatureBullets", () => {
  it("returns every bullet between ## Features and the next level-2 heading, with its tag", () => {
    const readme = [
      "# Title",
      "- not a feature bullet",
      "## Features",
      "### Terminal",
      "- **Tagged** — yes <!-- claim:tagged -->",
      "* **Untagged** — no",
      "## Download",
      "- also not a feature bullet",
    ].join("\n");
    expect(findFeatureBullets(readme).map((b) => [b.lineNumber, b.id])).toEqual([
      [5, "tagged"],
      [6, null],
    ]);
  });

  it("returns null when there is no Features section", () => {
    expect(findFeatureBullets("# Title\n- a bullet\n")).toBeNull();
  });
});

describe("checkClaims", () => {
  const readme = "## Features\n- **Multi-session** — proves it <!-- claim:multi -->\n";

  it("fails a feature bullet with no claim tag, naming its line", () => {
    const errors = checkClaims({
      readme: readme + "- **Shiny new thing** — nobody proved it\n",
      claims: [{ id: "multi", text: "proves it", scenarios: ["s.mjs"] }],
      ledgerScenarios: new Set(["s.mjs"]),
      scenarioFiles: ["s.mjs"],
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^README\.md:3: feature bullet has no <!-- claim:<id> --> tag/);
  });

  it("fails when the Features section is gone", () => {
    const errors = checkClaims({ readme: "# Title\n", claims: [], ledgerScenarios: new Set(), scenarioFiles: [] });
    expect(errors).toEqual(['README.md has no "## Features" section; the gate checks every bullet in it, so it must exist']);
  });

  const unprovenMulti = { id: "multi", text: "proves it", scenarios: [], unproven: "no scenario yet", planned: "p.mjs" };

  it("passes a backlog claim listed as unproven with a planned scenario that has not landed", () => {
    const errors = checkClaims({ readme, claims: [unprovenMulti], ledgerScenarios: new Set(), scenarioFiles: [] });
    expect(errors).toEqual([]);
    // Still fine when the baseline already had it as unproven.
    expect(checkClaims({ readme, claims: [unprovenMulti], ledgerScenarios: new Set(), scenarioFiles: [], baseline: [unprovenMulti] })).toEqual([]);
  });

  it("fails an unproven claim once its planned scenario has landed", () => {
    const onDiskOnly = checkClaims({ readme, claims: [unprovenMulti], ledgerScenarios: new Set(), scenarioFiles: ["p.mjs"] });
    expect(onDiskOnly).toEqual([]);
    const errors = checkClaims({ readme, claims: [unprovenMulti], ledgerScenarios: new Set(["p.mjs"]), scenarioFiles: ["p.mjs"] });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/claim "multi" is still unproven, but its planned scenario p\.mjs has landed; replace .* with "scenario: p\.mjs"/);
  });

  it("with a baseline, fails a new claim with no scenario", () => {
    const errors = checkClaims({ readme, claims: [unprovenMulti], ledgerScenarios: new Set(), scenarioFiles: [], baseline: [] });
    expect(errors).toEqual(['docs/readme-claims.yml: claim "multi" is new and has no scenario; a new README claim needs a real-app scenario that proves it']);
  });

  it("with a baseline, fails a claim that lost its scenario", () => {
    const proven = { id: "multi", text: "proves it", scenarios: ["s.mjs"] };
    const errors = checkClaims({ readme, claims: [unprovenMulti], ledgerScenarios: new Set(), scenarioFiles: [], baseline: [proven] });
    expect(errors).toEqual(['docs/readme-claims.yml: claim "multi" was proven by s.mjs and is now unproven; keep its scenario']);
  });

  it("strict mode fails every unproven claim", () => {
    const errors = checkClaims({ readme, claims: [unprovenMulti], ledgerScenarios: new Set(), scenarioFiles: [], strict: true });
    expect(errors).toEqual(['docs/readme-claims.yml: claim "multi" has no scenario yet (planned: p.mjs)']);
  });

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
      readme: "## Features\n- untracked claim <!-- claim:untracked -->\n",
      claims: [],
      ledgerScenarios: new Set(),
      scenarioFiles: [],
    });
    expect(errors).toEqual([
      'README.md:2 tags claim "untracked" with <!-- claim:untracked --> but docs/readme-claims.yml has no entry for it',
    ]);
  });

  it("fails a map entry whose tag was removed from README.md (stale)", () => {
    const errors = checkClaims({
      readme: "## Features\nno tags here\n",
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
