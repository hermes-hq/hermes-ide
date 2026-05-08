/**
 * Phase 3 (v1.0.0 redesign) — tool family routing.
 *
 * Pure-function test for `getToolFamily()`. Pins the case-insensitive,
 * separator-stripping mapping so renderer switching is stable as upstream
 * tool names drift in casing.
 */
import { describe, expect, it } from "vitest";
import { getToolFamily } from "../agent/blocks/getToolFamily";

describe("getToolFamily", () => {
  it("maps file-family tool names regardless of casing", () => {
    expect(getToolFamily("Read")).toBe("file");
    expect(getToolFamily("READ")).toBe("file");
    expect(getToolFamily("read")).toBe("file");
    expect(getToolFamily("Write")).toBe("file");
    expect(getToolFamily("Edit")).toBe("file");
    expect(getToolFamily("NotebookEdit")).toBe("file");
  });

  it("maps NotebookEdit even with separators in the name", () => {
    expect(getToolFamily("notebook_edit")).toBe("file");
    expect(getToolFamily("notebook-edit")).toBe("file");
    expect(getToolFamily("notebook edit")).toBe("file");
    expect(getToolFamily("Notebook Edit")).toBe("file");
  });

  it("maps exec-family tool names regardless of casing", () => {
    expect(getToolFamily("Bash")).toBe("exec");
    expect(getToolFamily("BASH")).toBe("exec");
    expect(getToolFamily("bash")).toBe("exec");
    expect(getToolFamily("Run")).toBe("exec");
    expect(getToolFamily("run")).toBe("exec");
  });

  it("maps search-family tool names regardless of casing", () => {
    expect(getToolFamily("Grep")).toBe("search");
    expect(getToolFamily("grep")).toBe("search");
    expect(getToolFamily("GREP")).toBe("search");
    expect(getToolFamily("Glob")).toBe("search");
    expect(getToolFamily("glob")).toBe("search");
  });

  it("maps web-family tool names regardless of casing", () => {
    expect(getToolFamily("WebFetch")).toBe("web");
    expect(getToolFamily("webfetch")).toBe("web");
    expect(getToolFamily("WEBFETCH")).toBe("web");
    expect(getToolFamily("WebSearch")).toBe("web");
    expect(getToolFamily("websearch")).toBe("web");
    expect(getToolFamily("web_search")).toBe("web");
  });

  it("falls through to generic for unknown tools", () => {
    expect(getToolFamily("Task")).toBe("generic");
    expect(getToolFamily("TodoWrite")).toBe("generic");
    expect(getToolFamily("MyCustomTool")).toBe("generic");
    expect(getToolFamily("")).toBe("generic");
  });
});
