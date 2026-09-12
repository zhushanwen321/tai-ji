// src/__tests__/resume-schema.test.ts
//
// [H1 U1→U6] run.params.resume 会话形态契约断言（设计
// docs/design/subagent-chat-run-unification.md §3.3 D3 + impl-plan §2 U1/U6 行）。
// 全部从 protocol barrel import（消费方视角）：
//   1. resume 键 schema 校验通过（载荷级 runSessionParamsSchema + 帧级 request
//      schema 对含 resume 键的 run 帧放行）；
//   2. 非法 resume 载荷拒绝（形状负向全集）。
// [H1 U6] 双键并存期的同形断言族（RunChatParams ≡ RunResumeParams / RunParams
// 双键并存可构造）已随 `chat` 键整体退役一并删除（impl-plan §5 U1 偏差登记的
// U6 处置范围）——resume 为唯一会话形态键。

import Ajv from "ajv";
import { describe, expect, it } from "vitest";

import {
  runSessionParamsSchema,
  requestFrameSchema,
  type RunParams,
} from "../protocol/index.ts";

const ajv = new Ajv({ strict: false });
const validateSessionParams = ajv.compile(runSessionParamsSchema);
const validateRequestFrame = ajv.compile(requestFrameSchema);

/** 合法会话形态参数样本（首轮无锚点 / 冷续带锚点 / 含 journalPath）。 */
const sessionParamsSamples = [
  { recordId: "rec-1" },
  {
    recordId: "rec-1",
    resume: {
      sessionRef: { recordId: "rec-1", sessionFile: "/data/sessions/a.jsonl" },
      poolKey: "shared",
    },
  },
  {
    recordId: "rec-9",
    resume: {
      sessionRef: { sessionFile: "/data/sessions/b.jsonl" },
      poolKey: "shared",
      journalPath: "/data/journals/b.ndjson",
    },
  },
] as const;

// ============================================================
// 1. resume 键 schema 校验通过
// ============================================================

describe("run.params.resume：schema 校验通过（H1 U6 唯一会话形态键）", () => {
  it("resume 载荷全形态过 runSessionParamsSchema（首轮无锚点 / 冷续带锚点 / 含 journalPath）", () => {
    for (const sample of sessionParamsSamples) {
      expect(validateSessionParams(structuredClone(sample)), JSON.stringify(sample)).toBe(true);
    }
  });

  it("RunParams.resume 可构造（唯一会话形态可选键）", () => {
    const run: RunParams = {
      runId: "run-1",
      task: { prompt: "do" },
      ctx: { poolKey: "shared", cwd: "/tmp" },
      resume: {
        recordId: "rec-1",
        resume: { sessionRef: { sessionFile: "/s/a.jsonl" }, poolKey: "shared" },
      },
    };
    expect(run.resume?.recordId).toBe("rec-1");
    expect(run.resume?.resume?.sessionRef.sessionFile).toBe("/s/a.jsonl");
  });

  it("帧级 request schema 对含 resume 键的 run 帧放行（params 不做深校验，键不被帧层拒绝）", () => {
    expect(
      validateRequestFrame({
        id: 1,
        method: "run",
        params: {
          runId: "run-1",
          task: { prompt: "do" },
          ctx: { poolKey: "shared", cwd: "/tmp" },
          resume: sessionParamsSamples[1],
        },
      }),
    ).toBe(true);
  });

  it("v1/v1.x 形态零破坏：无 resume 的 run 帧照常通过（additive-only）", () => {
    expect(
      validateRequestFrame({
        id: 2,
        method: "run",
        params: { runId: "r", task: { prompt: "p" }, ctx: { poolKey: "shared", cwd: "/" } },
      }),
    ).toBe(true);
  });
});

// ============================================================
// 2. 非法 resume 载荷拒绝
// ============================================================

describe("非法 resume 载荷拒绝（runSessionParamsSchema 负向全集）", () => {
  it("缺 recordId / recordId 非字符串", () => {
    expect(validateSessionParams({})).toBe(false);
    expect(validateSessionParams({ recordId: 42 })).toBe(false);
  });

  it("resume 非 object / 缺 sessionRef / 缺 poolKey", () => {
    expect(validateSessionParams({ recordId: "r", resume: "not-an-object" })).toBe(false);
    expect(validateSessionParams({ recordId: "r", resume: { poolKey: "shared" } })).toBe(false);
    expect(
      validateSessionParams({ recordId: "r", resume: { sessionRef: {} } }),
    ).toBe(false);
  });

  it("sessionRef 值非字符串 / journalPath 非字符串", () => {
    expect(
      validateSessionParams({
        recordId: "r",
        resume: { sessionRef: { sessionFile: 123 }, poolKey: "shared" },
      }),
    ).toBe(false);
    expect(
      validateSessionParams({
        recordId: "r",
        resume: {
          sessionRef: { sessionFile: "/s/a.jsonl" },
          poolKey: "shared",
          journalPath: 42,
        },
      }),
    ).toBe(false);
  });

  it("未知键拒（additionalProperties:false，含凭据类字段与废弃键混入）", () => {
    expect(validateSessionParams({ recordId: "r", priority: "high" })).toBe(false);
    expect(
      validateSessionParams({ recordId: "r", resume: { sessionRef: {}, poolKey: "p", extra: 1 } }),
    ).toBe(false);
  });

  it("非对象输入拒（null / 原始值）", () => {
    expect(validateSessionParams(null)).toBe(false);
    expect(validateSessionParams("rec-1")).toBe(false);
    expect(validateSessionParams(42)).toBe(false);
    expect(validateSessionParams(undefined)).toBe(false);
  });
});
