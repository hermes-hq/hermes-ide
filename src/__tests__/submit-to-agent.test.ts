/**
 * Tests for `submitToAgent`, the agent-mode replacement for the old
 * bracketed-paste `submitToPty` flow.
 *
 * Covers:
 *   - The pure `buildUserContent` helper produces the right block order
 *     (images first, then text) and skips empty sides.
 *   - `submitToAgent` calls `sendAgentInput` exactly once with a `user`
 *     envelope when there's content to send.
 *   - `submitToAgent` no-ops on empty draft + no attachments.
 *   - `submitToAgent` propagates IPC rejections to the caller.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../api/agent", () => ({
  sendAgentInput: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn().mockResolvedValue(undefined),
}));

import {
  submitToAgent,
  buildUserContent,
  buildUserEnvelope,
  echoUserEnvelope,
  sendUserEnvelope,
  type AgentAttachment,
} from "../utils/submitToAgent";
import { sendAgentInput } from "../api/agent";
import { emit } from "@tauri-apps/api/event";

const sentRows = () => (sendAgentInput as ReturnType<typeof vi.fn>).mock.calls;
const emittedRows = () => (emit as ReturnType<typeof vi.fn>).mock.calls;

describe("buildUserContent", () => {
  it("returns an empty array for empty draft and no attachments", () => {
    expect(buildUserContent("", [])).toEqual([]);
  });

  it("returns an empty array for whitespace-only draft and no attachments", () => {
    expect(buildUserContent("   \n  ", [])).toEqual([]);
  });

  it("emits a single text block for a non-empty draft", () => {
    expect(buildUserContent("hello", [])).toEqual([
      { type: "text", text: "hello" },
    ]);
  });

  it("places images BEFORE text so Claude renders them above the prompt", () => {
    const images: AgentAttachment[] = [
      { kind: "image", mediaType: "image/png", base64: "AAA=" },
      { kind: "image", mediaType: "image/jpeg", base64: "BBB=" },
    ];
    const blocks = buildUserContent("look at this", images);
    expect(blocks).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA=" } },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "BBB=" } },
      { type: "text", text: "look at this" },
    ]);
  });

  it("emits images alone when the draft is empty", () => {
    const images: AgentAttachment[] = [
      { kind: "image", mediaType: "image/png", base64: "AAA=" },
    ];
    expect(buildUserContent("", images)).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA=" } },
    ]);
  });
});

describe("submitToAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (sendAgentInput as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  });

  it("does nothing when draft is empty and there are no attachments", async () => {
    await submitToAgent("sess-a", "", []);
    expect(sendAgentInput).not.toHaveBeenCalled();
  });

  it("does nothing for a whitespace-only draft with no attachments", async () => {
    await submitToAgent("sess-a", "   \t\n  ", []);
    expect(sendAgentInput).not.toHaveBeenCalled();
  });

  it("sends a `user` envelope with role=user and a text block for plain text", async () => {
    await submitToAgent("sess-b", "hello world", []);
    expect(sendAgentInput).toHaveBeenCalledTimes(1);
    const [calledSessionId, payload] = sentRows()[0];
    expect(calledSessionId).toBe("sess-b");
    const env = payload as { type: string; uuid: string; message: { role: string; content: unknown[] } };
    expect(env.type).toBe("user");
    expect(env.message.role).toBe("user");
    expect(env.message.content).toEqual([{ type: "text", text: "hello world" }]);
    // A client-side uuid is present so the reducer has a stable React key
    // when the same envelope is echoed back into the message stream.
    expect(typeof env.uuid).toBe("string");
    expect(env.uuid.length).toBeGreaterThan(0);
  });

  it("echoes the user envelope onto agent-event-{sessionId} so the message stream renders both sides", async () => {
    await submitToAgent("sess-echo", "hello", []);
    expect(emit).toHaveBeenCalledTimes(1);
    const [eventName, payload] = emittedRows()[0];
    expect(eventName).toBe("agent-event-sess-echo");
    const env = payload as { type: string; uuid: string; message: { content: unknown[] } };
    expect(env.type).toBe("user");
    expect(env.message.content).toEqual([{ type: "text", text: "hello" }]);
    // The same envelope shape is then forwarded to the agent subprocess.
    const [, sentPayload] = sentRows()[0];
    expect(sentPayload).toEqual(env);
  });

  it("does not emit the echo event when there is no content to send", async () => {
    await submitToAgent("sess-empty", "", []);
    expect(emit).not.toHaveBeenCalled();
    expect(sendAgentInput).not.toHaveBeenCalled();
  });

  it("sends image source blocks with media_type + base64 data", async () => {
    const images: AgentAttachment[] = [
      { kind: "image", mediaType: "image/png", base64: "ZmFrZQ==" },
    ];
    await submitToAgent("sess-c", "describe", images);
    const [, payload] = sentRows()[0];
    expect((payload as { message: { content: unknown[] } }).message.content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "ZmFrZQ==" } },
      { type: "text", text: "describe" },
    ]);
  });

  it("includes attachments in the echo so user images render in the conversation", async () => {
    const images: AgentAttachment[] = [
      { kind: "image", mediaType: "image/png", base64: "ZmFrZQ==" },
    ];
    await submitToAgent("sess-img", "look", images);
    const [, payload] = emittedRows()[0];
    expect((payload as { message: { content: unknown[] } }).message.content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "ZmFrZQ==" } },
      { type: "text", text: "look" },
    ]);
  });

  it("sends image-only message when draft is empty but attachments are present", async () => {
    const images: AgentAttachment[] = [
      { kind: "image", mediaType: "image/jpeg", base64: "abcd" },
    ];
    await submitToAgent("sess-d", "", images);
    expect(sendAgentInput).toHaveBeenCalledTimes(1);
    const [, payload] = sentRows()[0];
    expect((payload as { message: { content: unknown[] } }).message.content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "abcd" } },
    ]);
  });

  it("propagates IPC rejections to the caller", async () => {
    (sendAgentInput as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("agent gone"));
    await expect(submitToAgent("sess-e", "ping", [])).rejects.toThrow("agent gone");
  });
});

describe("buildUserEnvelope / echoUserEnvelope / sendUserEnvelope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (sendAgentInput as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  });

  it("returns null for empty draft and no attachments — caller should skip both echo and send", () => {
    expect(buildUserEnvelope("", [])).toBeNull();
    expect(buildUserEnvelope("   \n  ", [])).toBeNull();
  });

  it("builds a full envelope with a stable client-side uuid", () => {
    const env = buildUserEnvelope("hi", []);
    expect(env).not.toBeNull();
    expect(env!.type).toBe("user");
    expect(typeof env!.uuid).toBe("string");
    expect(env!.uuid.length).toBeGreaterThan(0);
    expect(env!.message).toEqual({ role: "user", content: [{ type: "text", text: "hi" }] });
  });

  it("echoUserEnvelope routes to the agent-event-{sessionId} channel without touching the agent IPC", async () => {
    const env = buildUserEnvelope("hi", [])!;
    await echoUserEnvelope("sess-x", env);
    expect(emit).toHaveBeenCalledWith("agent-event-sess-x", env);
    expect(sendAgentInput).not.toHaveBeenCalled();
  });

  it("sendUserEnvelope routes to the agent IPC without echoing — used on retry to avoid double-echo", async () => {
    const env = buildUserEnvelope("hi", [])!;
    await sendUserEnvelope("sess-x", env);
    expect(sendAgentInput).toHaveBeenCalledWith("sess-x", env);
    expect(emit).not.toHaveBeenCalled();
  });

  it("sendUserEnvelope reuses the same uuid the caller passed in (so retries don't dedupe to a new id)", async () => {
    const env = buildUserEnvelope("hi", [])!;
    await sendUserEnvelope("sess-y", env);
    await sendUserEnvelope("sess-y", env);
    const calls = (sendAgentInput as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(2);
    const u1 = (calls[0][1] as { uuid: string }).uuid;
    const u2 = (calls[1][1] as { uuid: string }).uuid;
    expect(u1).toBe(u2);
  });
});
