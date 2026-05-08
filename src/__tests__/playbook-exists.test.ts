import { describe, it, expect } from "vitest";
import { existsSync, statSync } from "fs";
import { join } from "path";

describe("v1 redesign playbook", () => {
  const path = join(__dirname, "../../docs/internal/v1-redesign-playbook.md");

  it("exists", () => {
    expect(existsSync(path)).toBe(true);
  });

  it("is non-trivial in size (> 3000 bytes)", () => {
    expect(statSync(path).size).toBeGreaterThan(3000);
  });
});
