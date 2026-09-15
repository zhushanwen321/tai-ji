// Behavioral tests for todo dual-form traps (text/texts, id/ids).
//
// Complements the source-text prompt-quality locks in tool-prompt.test.ts: those
// verify the Correct/error STRINGS exist; these exercise the actual throw logic of
// handleAdd/handleDelete, so a refactor cannot silently drop the dual-form detection.
//
// Note: since the schema was flattened to a single Type.Object (OpenAI compat), all
// fields are Optional at the schema layer — dual-form payloads now REACH the handler
// in production, and these handler-level checks are the actual enforcement point
// (schema.test.ts pins that Value.Check passes for dual-form payloads).
//
// handleAdd/handleDelete were exported specifically to enable these tests.

import { describe, expect, it } from "vitest";

import { createTodoSessionState } from "../state";
import { handleAdd, handleDelete, handleSingleUpdate } from "../tool";

describe("handleAdd — text/texts dual-form detection", () => {
  it("triggers dual-form error when singular 'text' used instead of 'texts'", () => {
    const state = createTodoSessionState();
    expect(() => handleAdd(state, { action: "add", text: "write spec" })).toThrow(
      /singular "text"|add needs texts/,
    );
  });

  it("throws 'requires texts' when neither text nor texts given", () => {
    const state = createTodoSessionState();
    expect(() => handleAdd(state, { action: "add" })).toThrow(/requires texts/);
  });

  it("throws 'requires texts' on empty array (missing, not dual-form)", () => {
    const state = createTodoSessionState();
    expect(() => handleAdd(state, { action: "add", texts: [] })).toThrow(/requires texts/);
  });

  it("TC7: 同时传 text 和 texts → throw（明确提示 add 只接受 texts）", () => {
    const state = createTodoSessionState();
    expect(() => handleAdd(state, { action: "add", text: "x", texts: ["y"] })).toThrow(
      /only accepts texts array/,
    );
  });

  it("does NOT throw when correct 'texts' array provided", () => {
    const state = createTodoSessionState();
    expect(() => handleAdd(state, { action: "add", texts: ["write spec"] })).not.toThrow();
  });
});

describe("handleDelete — id/ids dual-form detection", () => {
  it("triggers dual-form error when singular 'id' used instead of 'ids'", () => {
    const state = createTodoSessionState();
    expect(() => handleDelete(state, { action: "delete", id: 5 })).toThrow(
      /singular "id"|delete needs ids/,
    );
  });

  it("throws 'requires ids' when neither id nor ids given", () => {
    const state = createTodoSessionState();
    expect(() => handleDelete(state, { action: "delete" })).toThrow(/requires ids/);
  });

  it("does NOT throw when correct 'ids' array provided (after seeding a todo)", () => {
    const state = createTodoSessionState();
    handleAdd(state, { action: "add", texts: ["temp"] }); // seed todo #1
    expect(() => handleDelete(state, { action: "delete", ids: [1] })).not.toThrow();
  });
});

describe("handleSingleUpdate — id/status/text required guards", () => {
  it("throws 'requires id' when id missing", () => {
    const state = createTodoSessionState();
    expect(() => handleSingleUpdate(state, { action: "update" })).toThrow(/requires id/);
  });

  it("throws 'at least status or text' when id given but status+text missing", () => {
    const state = createTodoSessionState();
    expect(() => handleSingleUpdate(state, { action: "update", id: 1 })).toThrow(
      /at least status or text/,
    );
  });
});
