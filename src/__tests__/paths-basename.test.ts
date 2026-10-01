import { describe, expect, it } from "vitest";
import { basename, tildePath } from "../utils/paths";

describe("basename: the last part of a path on every OS", () => {
	it.each([
		["/home-fixture/demo-app", "demo-app"],
		["/home-fixture/demo-app/", "demo-app"],
		["D:\\work\\demo-app", "demo-app"],
		["D:\\work\\demo-app\\", "demo-app"],
		["D:/work\\mixed/demo-app", "demo-app"],
		["\\\\server\\share\\repo", "repo"],
		["/bin/zsh", "zsh"],
		["C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "powershell.exe"],
		["demo-app", "demo-app"],
		["CLAUDE.md", "CLAUDE.md"],
	])("%s → %s", (path, name) => {
		expect(basename(path)).toBe(name);
	});

	it("keeps a root or an empty path as it is", () => {
		expect(basename("/")).toBe("/");
		expect(basename("")).toBe("");
	});
});

describe("tildePath: Copy Relative Path", () => {
	it("puts a project under the home folder as ~/…, with one separator", () => {
		expect(tildePath("/home-fixture/proj", "/home-fixture")).toBe("~/proj");
		expect(tildePath("/home-fixture/proj", "/home-fixture/")).toBe("~/proj");
		expect(tildePath("/home-fixture/a/b", "/home-fixture")).toBe("~/a/b");
		expect(tildePath("/home-fixture", "/home-fixture")).toBe("~");
	});

	it("uses / on Windows and ignores case there", () => {
		expect(tildePath("D:\\work\\test\\proj", "D:\\work\\test")).toBe("~/proj");
		expect(tildePath("D:\\work\\test\\proj", "D:\\work\\test\\")).toBe("~/proj");
		expect(tildePath("d:\\WORK\\test\\proj\\src", "D:\\work\\test")).toBe("~/proj/src");
	});

	it("leaves a path that only starts with the same letters alone", () => {
		expect(tildePath("/home-fixture2/proj", "/home-fixture")).toBe("/home-fixture2/proj");
		expect(tildePath("/opt/proj", "/home-fixture")).toBe("/opt/proj");
		expect(tildePath("/Home-fixture/proj", "/home-fixture")).toBe("/Home-fixture/proj");
	});

	it("leaves the path alone without a home folder", () => {
		expect(tildePath("/home-fixture/proj", null)).toBe("/home-fixture/proj");
		expect(tildePath("/home-fixture/proj", "")).toBe("/home-fixture/proj");
	});
});
