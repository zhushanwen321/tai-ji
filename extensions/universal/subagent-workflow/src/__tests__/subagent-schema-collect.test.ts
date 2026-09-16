// src/__tests__/subagent-schema-collect.test.ts
//
// subagent 工具 schema 的 collect 参数**退役契约**（subagents-batch-tool-fanout u4）。
//
// 断言对象是 schema 数据本身（JSON Schema 形态）而非运行期校验——本包测试环境把
// typebox alias 到 mocks/typebox.ts（丢 options），跨包真实 typebox 校验由
// structured-output 的 cross-package-contract.test.ts 承担（经真实 typebox 编译本
// schema）。collect 随批量入口收归 `subagents` tool 退役：schema 层不可再自报该字段
// （与 conversation 参数退役断言同风格——同一文件内的两个「字段已删」守卫）。

import { describe, expect, it } from "vitest";

import { SubagentParams } from "../interface/subagent-tool-schema.ts";

/** 运行时守卫（不用裸类型断言：extensions taste/no-unsafe-cast 规范）。 */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** schema 的可检视图：经 JSON 往返剥离 typebox 类型包装，只看数据形态。 */
function schemaData(): Record<string, unknown> {
  const raw: unknown = JSON.parse(JSON.stringify(SubagentParams));
  if (!isRecord(raw)) throw new Error("SubagentParams is not an object schema");
  return raw;
}

function properties(): Record<string, unknown> {
  const props = schemaData().properties;
  if (!isRecord(props)) throw new Error("SubagentParams has no properties");
  return props;
}

function requiredFields(): string[] {
  const req = schemaData().required;
  return Array.isArray(req) ? req.filter((x): x is string => typeof x === "string") : [];
}

describe("subagent start schema: collect param retired (批量入口 = subagents tool)", () => {
  it("collect 字段已删（schema 层不可再自报：批量编排唯一入口是 `subagents` tool）", () => {
    expect(Object.keys(properties())).not.toContain("collect");
    // 数据面全量断言（描述文本里的 collect 措辞随之删除）：序列化后零残留。
    expect(JSON.stringify(schemaData())).not.toContain("collect");
  });

  it("sits flattened at top level beside task/slug/engine (拍平契约不变)", () => {
    const props = Object.keys(properties());
    for (const sibling of ["task", "slug", "engine"]) {
      expect(props).toContain(sibling);
    }
  });

  it("conversation param is deleted (modeless 波5：模式消亡，schema 层不可再自报)", () => {
    expect(Object.keys(properties())).not.toContain("conversation");
  });

  it("keeps action as the sole required field (既有契约零回归；mock typebox 不产 required，真实 typebox 环境由 structured-output 侧承担)", () => {
    const req = schemaData().required;
    if (req === undefined) return; // mocks/typebox.ts 丢 options 不产 required：可断言面为空即跳过
    expect(req).toEqual(["action"]);
  });
});
