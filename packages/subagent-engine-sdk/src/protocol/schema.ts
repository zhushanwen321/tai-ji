// src/protocol/schema.ts
//
// 帧校验 JSON Schema（draft-07）。设计权威源：impl-plan §2.1 W1 职责「JSON Schema
// （帧校验用）」+ 设计 §3.10 不变量 5「凭据不过协议：协议里不出现 apiKey / token
// 字段（schema 层禁止 + 测试断言）」。
//
// schema 层禁止凭据的实现口径：所有对象帧 additionalProperties:false + 属性白名单，
// 凭据类键名（apiKey/token/credential 等）不在任何白名单内；测试侧另断言白名单全集
// 无凭据键（src/__tests__/protocol-frames.test.ts）。params/result 的深载荷结构由
// TS 类型承载（protocol/methods.ts / reverse-channels.ts / contract-types.ts），
// 帧级 schema 只定形状骨架（id/method/params/result/error 的存在性与类型）——
// 帧校验的目的是行解析器快速拒格式坏帧，不做深校验（深校验成本高于收益，坏载荷
// 由消费方结构化报错）。

import type { ReverseChannel } from "./reverse-channels.ts";
import { REVERSE_CHANNELS } from "./reverse-channels.ts";
import { PROTOCOL_METHODS } from "./methods.ts";

/** 任意 JSON 值（draft-07 空约束）。 */
const ANY_JSON = {} as const;

/** 协议错误对象 schema。 */
export const protocolErrorSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "EngineProtocolError",
  type: "object",
  additionalProperties: false,
  required: ["code", "message", "recovery"],
  properties: {
    code: { type: "string", pattern: "^engine_" },
    message: { type: "string" },
    recovery: { type: "string" },
    data: { type: "object" },
  },
} as const;

/** ① 请求帧（core → 引擎）。 */
export const requestFrameSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "EngineProtocolRequestFrame",
  type: "object",
  additionalProperties: false,
  required: ["id", "method", "params"],
  properties: {
    id: { type: "number" },
    method: { type: "string", enum: [...PROTOCOL_METHODS] },
    params: ANY_JSON,
  },
} as const;

/** ② 应答帧（引擎 → core；result 与 error 互斥）。 */
export const successResponseFrameSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "EngineProtocolSuccessResponseFrame",
  type: "object",
  additionalProperties: false,
  required: ["id", "result"],
  properties: {
    id: { type: ["number", "string"] },
    result: ANY_JSON,
  },
} as const;

export const errorResponseFrameSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "EngineProtocolErrorResponseFrame",
  type: "object",
  additionalProperties: false,
  required: ["id", "error"],
  properties: {
    id: { type: ["number", "string"] },
    error: protocolErrorSchema,
  },
} as const;

/** ③ 通知帧（引擎 → core，无 id；method 恒 "event"）。 */
export const notificationFrameSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "EngineProtocolNotificationFrame",
  type: "object",
  additionalProperties: false,
  required: ["method", "params"],
  properties: {
    method: { type: "string", const: "event" },
    params: {
      type: "object",
      additionalProperties: false,
      required: ["runId", "seq", "event"],
      properties: {
        runId: { type: "string" },
        seq: { type: "number" },
        event: {
          type: "object",
          required: ["type"],
          properties: {
            type: {
              type: "string",
              enum: [
                "tool_start",
                "tool_end",
                "text_delta",
                "thinking_delta",
                "turn_end",
                "message_end",
                "compaction",
                "activity",
                "error",
              ],
            },
          },
        },
      },
    },
  },
} as const;

/** ④ 反向请求帧（引擎 → core，必须应答；method 恒 host/*）。 */
export const reverseRequestFrameSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "EngineProtocolReverseRequestFrame",
  type: "object",
  additionalProperties: false,
  required: ["id", "method", "params"],
  properties: {
    id: { type: "string" },
    method: { type: "string", enum: [...REVERSE_CHANNELS] },
    params: ANY_JSON,
  },
} as const;

/** 帧型 → schema 索引（校验入口按帧型取用）。 */
export const ENGINE_PROTOCOL_SCHEMAS = {
  request: requestFrameSchema,
  successResponse: successResponseFrameSchema,
  errorResponse: errorResponseFrameSchema,
  notification: notificationFrameSchema,
  reverseRequest: reverseRequestFrameSchema,
  protocolError: protocolErrorSchema,
} as const;

/**
 * 协议面凭据禁区键名（不变量 5 的测试断言依据）：帧 schema 与深载荷 TS 类型面
 * 不得出现。词表覆盖常见拼写（子串匹配，非精确枚举）。
 */
export const FORBIDDEN_CREDENTIAL_KEY_FRAGMENTS = [
  "apikey",
  "api_key",
  "token",
  "credential",
  "password",
  "secret",
] as const;

/** 反向通道名词表导出（schema enum 与 W2 路由同源）。 */
export const REVERSE_CHANNEL_NAMES: readonly ReverseChannel[] = REVERSE_CHANNELS;

// ============================================================
// [H1] run 会话形态参数载荷 schema（resume 单键校验权威）
// ============================================================

/**
 * run.params 的会话形态参数载荷 schema（draft-07 深载荷片段）。设计权威源：
 * docs/design/subagent-chat-run-unification.md §3.3 D3 + §5 U1/U6 行。
 *
 * [H1 U6 已切换] 键切换单批完成后本 schema 面向唯一键 `resume`（RunResumeParams：
 * recordId + 可选 ResumeAnchor），形状不变。帧级 schema（requestFrameSchema.params）
 * 刻意不做深校验（见本文件头注释），本片段供消费方（引擎读端结构化报错 / 测试正负
 * 样本）按需深校验。
 */
export const runSessionParamsSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "EngineRunSessionParams",
  type: "object",
  additionalProperties: false,
  required: ["recordId"],
  properties: {
    recordId: { type: "string" },
    resume: {
      type: "object",
      additionalProperties: false,
      required: ["sessionRef", "poolKey"],
      properties: {
        // ResumeAnchor.sessionRef = Record<string, string>（引擎定位键值对）
        sessionRef: { type: "object", additionalProperties: { type: "string" } },
        poolKey: { type: "string" },
        journalPath: { type: "string" },
      },
    },
  },
} as const;
