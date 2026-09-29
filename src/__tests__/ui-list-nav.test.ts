import { describe, expect, it } from "vitest";
import { createTypeahead, firstEnabled, lastEnabled, moveBy, PAGE_SIZE, TYPEAHEAD_MS, type NavItem } from "../components/ui/listNav";

const items = (labels: string[], disabled: number[] = []): NavItem[] =>
  labels.map((text, i) => ({ text, disabled: disabled.includes(i) }));

describe("list navigation shared by Select and Menu", () => {
  it("finds the first and last enabled items", () => {
    const list = items(["a", "b", "c", "d"], [0, 3]);
    expect(firstEnabled(list)).toBe(1);
    expect(lastEnabled(list)).toBe(2);
    expect(firstEnabled(items(["a"], [0]))).toBe(-1);
  });

  it("moves one step, skipping disabled items, and does not wrap", () => {
    const list = items(["a", "b", "c", "d"], [1]);
    expect(moveBy(list, 0, 1)).toBe(2);
    expect(moveBy(list, 2, -1)).toBe(0);
    expect(moveBy(list, 3, 1)).toBe(3); // at the end: stays
    expect(moveBy(list, 0, -1)).toBe(0); // at the start: stays
  });

  it("from nothing active, down lands on the first item and up on the last", () => {
    const list = items(["a", "b", "c"], [0]);
    expect(moveBy(list, -1, 1)).toBe(1);
    expect(moveBy(list, -1, -1)).toBe(2);
  });

  it("pages by ten enabled items and stops at the ends", () => {
    const list = items(Array.from({ length: 25 }, (_, i) => `item ${i}`), [5]);
    expect(moveBy(list, 0, PAGE_SIZE)).toBe(11); // 1..11 minus the disabled 5
    expect(moveBy(list, 20, PAGE_SIZE)).toBe(24);
    expect(moveBy(list, 3, -PAGE_SIZE)).toBe(0);
  });

  it("type-ahead matches a prefix, case-insensitively, after the current item", () => {
    const ta = createTypeahead();
    const list = items(["Codex", "Claude Code", "claude personal", "Goose"]);
    expect(ta.type("c", list, -1, 1000)).toBe(0);
    ta.reset();
    expect(ta.type("g", list, 0, 2000)).toBe(3);
  });

  it("type-ahead builds a longer prefix from keys typed within 500 ms", () => {
    const ta = createTypeahead();
    const list = items(["Codex", "Claude Code", "Claude Personal", "Cline"]);
    expect(ta.type("c", list, -1, 1000)).toBe(0);
    expect(ta.type("l", list, 0, 1100)).toBe(1);
    expect(ta.type("a", list, 1, 1200)).toBe(1);
    expect(ta.type("u", list, 1, 1300)).toBe(1);
    expect(ta.type("d", list, 1, 1400)).toBe(1);
    expect(ta.type("e", list, 1, 1450)).toBe(1);
    expect(ta.type(" ", list, 1, 1500)).toBe(1);
    expect(ta.type("p", list, 1, 1550)).toBe(2);
  });

  it("repeating one letter cycles through the items that start with it", () => {
    const ta = createTypeahead();
    const list = items(["Codex", "Claude", "Goose", "Cline"]);
    let at = -1;
    const seen: number[] = [];
    for (let k = 0; k < 4; k++) {
      at = ta.type("c", list, at, 1000 + k * 100);
      seen.push(at);
    }
    expect(seen).toEqual([0, 1, 3, 0]);
  });

  it("starts a new search once 500 ms have passed", () => {
    const ta = createTypeahead();
    const list = items(["Codex", "Goose", "Gemini"]);
    expect(ta.type("g", list, -1, 1000)).toBe(1);
    expect(ta.active(1000 + TYPEAHEAD_MS - 1)).toBe(true);
    expect(ta.active(1000 + TYPEAHEAD_MS)).toBe(false);
    // "ge" would match Gemini; after the pause "e" is a fresh search that matches nothing.
    expect(ta.type("e", list, 1, 1000 + TYPEAHEAD_MS)).toBe(-1);
  });

  it("type-ahead skips disabled items", () => {
    const ta = createTypeahead();
    const list = items(["Codex", "Claude"], [0]);
    expect(ta.type("c", list, -1, 1000)).toBe(1);
  });
});
