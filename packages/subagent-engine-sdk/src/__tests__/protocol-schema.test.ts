// src/__tests__/protocol-schema.test.ts
//
// JSON Schema（帧校验）自恰性：用 ajv 对正/负帧样本校验（W10 协议黑盒 fixture 的
// schema 源即本模块，先把 schema 本身的有效性锁住）+ 不变量 5「凭据不过协议」的
// schema 层断言（帧 schema 属性白名单零凭据键）。

import Ajv from "ajv";
import { describe, expect, it } from "vitest";

import { ENGINE_PROTOCOL_SCHEMAS, FORBIDDEN_CREDENTIAL_KEY_FRAGMENTS } from "../protocol/schema.ts";
import { REVERSE_CHANNELS } from "../protocol/reverse-channels.ts";
import { PROTOCOL_METHODS } from "../protocol/methods.ts";

const ajv = new Ajv({ strict: false });

describe("帧 schema 有效性（draft-07，ajv 编译 + 样本校验）", () => {
  it("① 请求帧：合法样本过、缺 params/未知 method/多余字段拒", () => {
    const validate = ajv.compile(ENGINE_PROTOCOL_SCHEMAS.request);
    expect(validate({ id: 1, method: "run", params: {} })).toBe(true);
    expect(validate({ id: 1, method: "ping", params: { _placeholder: undefined } })).toBe(true);
    // 缺 params
    expect(validate({ id: 1, method: "run" })).toBe(false);
    // method 不在 v1 词表
    expect(validate({ id: 1, method: "stealCredentials", params: {} })).toBe(false);
    // additionalProperties:false（凭据类多余字段被 schema 层禁止——不变量 5）
    expect(validate({ id: 1, method: "run", params: {}, apiKey: "sk-..." })).toBe(false);
  });

  it("② 应答帧：result/error 两形态各自成立", () => {
    const ok = ajv.compile(ENGINE_PROTOCOL_SCHEMAS.successResponse);
    const err = ajv.compile(ENGINE_PROTOCOL_SCHEMAS.errorResponse);
    expect(ok({ id: 1, result: { pong: true } })).toBe(true);
    expect(ok({ id: "rev-1", result: { ack: true } })).toBe(true);
    expect(ok({ id: 1 })).toBe(false);
    expect(err({
      id: 1,
      error: { code: "engine_crashed", message: "boom", recovery: "rerun" },
    })).toBe(true);
    // code 不符 engine_ 前缀契约
    expect(err({ id: 1, error: { code: "boom", message: "m", recovery: "r" } })).toBe(false);
  });

  it("③ 通知帧：method 恒 event + runId/seq/event 形状；event.type 限 9 种", () => {
    const validate = ajv.compile(ENGINE_PROTOCOL_SCHEMAS.notification);
    expect(validate({
      method: "event",
      params: { runId: "r1", seq: 1, event: { type: "text_delta", delta: "x" } },
    })).toBe(true);
    // activity 活性信号变体（无载荷字段，仅 type）
    expect(validate({
      method: "event",
      params: { runId: "r1", seq: 1, event: { type: "activity" } },
    })).toBe(true);
    // 未知 event.type
    expect(validate({
      method: "event",
      params: { runId: "r1", seq: 1, event: { type: "surprise" } },
    })).toBe(false);
    // 缺 seq
    expect(validate({
      method: "event",
      params: { runId: "r1", event: { type: "compaction" } },
    })).toBe(false);
  });

  it("④ 反向请求帧：字符串 id + method 限 9 通道词表", () => {
    const validate = ajv.compile(ENGINE_PROTOCOL_SCHEMAS.reverseRequest);
    expect(validate({ id: "rev-1", method: "host/askUser", params: {} })).toBe(true);
    for (const ch of REVERSE_CHANNELS) {
      expect(validate({ id: "rev-x", method: ch, params: {} })).toBe(true);
    }
    expect(validate({ id: "rev-1", method: "run", params: {} })).toBe(false);
    expect(validate({ id: 1, method: "host/log", params: {} })).toBe(false);
  });
});

describe("不变量 5：凭据不过协议（schema 层禁止）", () => {
  it("方法词表与通道词表零凭据键（帧字段面全量枚举检查）", () => {
    const surfaceNames = [...PROTOCOL_METHODS, ...REVERSE_CHANNELS].join("\n");
    for (const fragment of FORBIDDEN_CREDENTIAL_KEY_FRAGMENTS) {
      expect(surfaceNames.toLowerCase()).not.toContain(fragment);
    }
  });

  it("帧 schema 的属性白名单（properties 键集）零凭据键", () => {
    for (const [name, schema] of Object.entries(ENGINE_PROTOCOL_SCHEMAS)) {
      const json = JSON.stringify(schema).toLowerCase();
      for (const fragment of FORBIDDEN_CREDENTIAL_KEY_FRAGMENTS) {
        expect(json, `${name} schema contains credential-like key fragment "${fragment}"`).not.toContain(
          `"${fragment}"`,
        );
      }
    }
  });
});
