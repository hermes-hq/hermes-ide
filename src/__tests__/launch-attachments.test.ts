/**
 * Files and images attached in the task launcher: how they become
 * attachments (a pasted file is saved first, a dropped or picked one is named
 * where it is), and how the launch hands them to the agent: their paths after
 * the task in the first prompt (every agent, the clipboard included), and the
 * images as images for an Agent view session.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import {
  addAttachments,
  attachmentFromPath,
  attachPastedFile,
  imageMediaType,
  isImageName,
  loadImageAttachments,
  pastedFileName,
  promptWithAttachments,
  type LaunchAttachment,
} from "../launcher/attachments";
import { launchTask, type LaunchTaskDeps } from "../launcher/launchTask";
import type { CreateSessionOpts, SessionData } from "../types/session";
import type { PlannedAgent, TaskLaunchRequest } from "../components/TaskLauncher";
import type { LaunchChoice } from "../agent/capabilities/types";

const shot: LaunchAttachment = { path: "/data/attachments/1-a/pasted-image-1.png", name: "pasted-image-1.png", image: true };
const notes: LaunchAttachment = { path: "/Users/me/My Notes/spec.md", name: "spec.md", image: false };

describe("attachments", () => {
  it("lists the attached paths after the task", () => {
    expect(promptWithAttachments("Fix the layout", [shot, notes])).toBe(
      "Fix the layout\n\nAttached files (read them):\n- /data/attachments/1-a/pasted-image-1.png\n- /Users/me/My Notes/spec.md",
    );
    expect(promptWithAttachments("Fix it\n\n", [notes])).toBe("Fix it\n\nAttached file (read it):\n- /Users/me/My Notes/spec.md");
  });

  it("leaves the prompt alone without attachments", () => {
    expect(promptWithAttachments("Fix it", [])).toBe("Fix it");
    expect(promptWithAttachments("Fix it", undefined)).toBe("Fix it");
  });

  it("names a file by the last part of its path, on any platform", () => {
    expect(attachmentFromPath("/a/b/shot.PNG")).toEqual({ path: "/a/b/shot.PNG", name: "shot.PNG", image: true });
    expect(attachmentFromPath("C:\\Users\\me\\report.pdf")).toEqual({ path: "C:\\Users\\me\\report.pdf", name: "report.pdf", image: false });
  });

  it("tells images by their extension", () => {
    for (const n of ["a.png", "a.JPG", "a.jpeg", "a.gif", "a.webp", "a.bmp"]) expect(isImageName(n)).toBe(true);
    for (const n of ["a.svg", "a.pdf", "png", "a.png.txt"]) expect(isImageName(n)).toBe(false);
    expect(imageMediaType("a.jpg")).toBe("image/jpeg");
    expect(imageMediaType("/x/a.PNG")).toBe("image/png");
  });

  it("never attaches the same path twice", () => {
    expect(addAttachments([shot], [notes, shot, notes]).map((a) => a.path)).toEqual([shot.path, notes.path]);
  });

  it("gives a clipboard image a name of its own", () => {
    expect(pastedFileName({ name: "image.png", type: "image/png" }, 2)).toBe("pasted-image-2.png");
    expect(pastedFileName({ name: "", type: "image/jpeg" }, 1)).toBe("pasted-image-1.jpg");
    expect(pastedFileName({ name: "", type: "image/svg+xml" }, 3)).toBe("pasted-image-3.svg");
    expect(pastedFileName({ name: "design.png", type: "image/png" }, 4)).toBe("design.png");
  });

  it("saves a pasted file and keeps the saved path", async () => {
    const save = vi.fn(async () => "/data/attachments/9-x/pasted-image-1.png");
    const file = new File([new Uint8Array([1, 2, 3])], "image.png", { type: "image/png" });
    const a = await attachPastedFile(file, 1, save);
    expect(save).toHaveBeenCalledWith("pasted-image-1.png", new Uint8Array([1, 2, 3]));
    expect(a).toEqual({ path: "/data/attachments/9-x/pasted-image-1.png", name: "pasted-image-1.png", image: true });
  });

  it("reads attached images for an Agent view message, leaving out one that cannot be read", async () => {
    const read = vi.fn(async (p: string) => {
      if (p.endsWith("gone.png")) throw new Error("not found");
      return [104, 105];
    });
    const images = await loadImageAttachments(["/a/one.png", "/a/gone.png", "/a/two.jpg"], read);
    expect(images).toEqual([
      { kind: "image", mediaType: "image/png", base64: "aGk=" },
      { kind: "image", mediaType: "image/jpeg", base64: "aGk=" },
    ]);
  });
});

const CHOICE: LaunchChoice = {
  agentId: "claude",
  accountId: "default",
  approvalModeId: "acceptEdits",
  modelId: "default",
  effort: null,
  extraArgs: "",
  prefix: "",
  channels: [],
  where: { kind: "new-worktree", baseBranch: "", branch: "" },
  trackAsFeature: false,
};

function agent(id: string, mode: "terminal" | "agent"): PlannedAgent {
  return {
    id,
    mode,
    branch: `hermes/${id}`,
    createBranch: true,
    baseBranch: "",
    worktree: true,
    launch: { permissionMode: "acceptEdits", customPrefix: "", customSuffix: "", channels: [] },
    choice: { ...CHOICE, agentId: id },
  };
}

function deps() {
  const created: CreateSessionOpts[] = [];
  const copied: string[] = [];
  let n = 0;
  const d: LaunchTaskDeps = {
    projectFor: async () => "proj-1",
    createSession: async (opts) => {
      created.push(opts);
      return { id: `s${++n}` } as SessionData;
    },
    place: () => {},
    worktreePath: async (id) => `/wt/${id}`,
    writeFeatureFile: async () => "",
    copyText: async (t) => {
      copied.push(t);
    },
    readRecords: async () => "",
    writeRecords: async () => {},
    now: () => 1,
    newLaunchId: () => "launch-1",
  };
  return { d, created, copied };
}

const req = (agents: PlannedAgent[], attachments?: LaunchAttachment[]): TaskLaunchRequest => ({
  task: "Fix the layout",
  repoRoot: "/repo",
  agents,
  track: "Quick",
  doneWhen: [],
  choice: CHOICE,
  ...(attachments ? { attachments } : {}),
});

describe("a launch with attachments", () => {
  it("gives every agent the paths after the task", async () => {
    const f = deps();
    await launchTask(req([agent("claude", "terminal"), agent("codex", "terminal")], [shot, notes]), f.d);
    const expected = promptWithAttachments("Fix the layout", [shot, notes]);
    expect(f.created.map((o) => o.initialPrompt)).toEqual([expected, expected]);
    expect(f.created.every((o) => o.initialImages === undefined)).toBe(true);
  });

  it("sends an Agent view session the images as images too", async () => {
    const f = deps();
    await launchTask(req([agent("claude", "agent")], [shot, notes]), f.d);
    expect(f.created[0].initialImages).toEqual([shot.path]);
    expect(f.created[0].initialPrompt).toContain(notes.path);
  });

  it("puts the paths on the clipboard for an agent that cannot take a first prompt", async () => {
    const f = deps();
    const r = await launchTask(req([agent("goose", "terminal")], [notes]), f.d);
    expect(r.copiedFor).toEqual(["goose"]);
    expect(f.copied[0]).toContain(notes.path);
  });

  it("is the bare task without attachments", async () => {
    const f = deps();
    await launchTask(req([agent("claude", "terminal")]), f.d);
    expect(f.created[0].initialPrompt).toBe("Fix the layout");
  });
});
