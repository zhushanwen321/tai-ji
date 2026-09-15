// src/__tests__/subagent-schema-collect.test.ts
//
// subagent 工具 schema 的 collect 参数契约（subagent-sync-collect U1 foundation）。
//
// 断言对象是 schema 数据本身（JSON Schema 形态）而非运行期校验——本包测试环境把
// typebox alias 到 mocks/typebox.ts（丢 options），跨包真实 typebox 校验由
// structured-output 的 cross-package-contract.test.ts 承担（经真实 typebox 编译本
// schema）。枚举即「接受合法值/拒绝非法值」的契约载体：collect 仅接受
// "async" | "sync"，其余一律 schema 层拒绝。

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

describe("subagent start schema: collect param (U1 foundation)", () => {
  it("declares collect as a top-level string enum of exactly async|sync (合法值白名单)", () => {
    const collect = properties().collect;
    if (!isRecord(collect)) throw new Error("collect property missing from schema");
    expect(collect.enum).toEqual(["async", "sync"]);
    expect(collect.type).toBe("string");
  });

  it("rejects non-enum values by enum membership (非法值 schema 层拒绝)", () => {
    const collect = properties().collect;
    if (!isRecord(collect)) throw new Error("collect property missing from schema");
    const accepted = collect.enum;
    if (!Array.isArray(accepted)) throw new Error("collect.enum missing");
    for (const bad of ["immediate", "SYNC", "batch", 1, true, null]) {
      expect(accepted).not.toContain(bad);
    }
  });

  it("keeps collect optional (缺省 = config 默认，不在 required)", () => {
    expect(requiredFields()).not.toContain("collect");
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
