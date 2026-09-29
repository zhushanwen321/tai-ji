/**
 * stringifySchemaCached — schema JSON 序列化单测。
 *
 * 断言面（收敛后：直调 JSON.stringify + fail-loud 护栏）：
 * - 输出与直接 JSON.stringify 逐字节一致
 * - schema 含 toJSON: () => undefined 时抛含恢复指引的错误（不静默产垃圾串）
 */
import { describe, expect, it } from "vitest";

import { stringifySchemaCached } from "../schema-jsonify.ts";

describe("stringifySchemaCached — schema JSON 序列化", () => {
  it("输出与直接 JSON.stringify 逐字节一致", () => {
    const schema = { type: "object", properties: { n: { type: "number" } } };
    expect(stringifySchemaCached(schema)).toBe(JSON.stringify(schema));
  });

  // [review 修复] TS lib 盲区回归：schema 含 toJSON: () => undefined 钩子时
  // JSON.stringify 运行时返回 undefined，违反声明的 string 返回类型——现 fail-loud
  // 抛含恢复指引的错误，不静默返回 undefined / 垃圾串。
  it("[review 修复] schema 含 toJSON: () => undefined → 抛含恢复指引的错误", () => {
    const bad = { type: "object", toJSON: () => undefined };
    expect(() => stringifySchemaCached(bad)).toThrowError(
      /stringifySchemaCached: JSON\.stringify returned undefined.*Recovery:/s,
    );
    // 正常 schema 不受影响（toJSON 返回合法值时按其返回值序列化）
    const good = { type: "object", toJSON: () => ({ type: "string" }) };
    expect(stringifySchemaCached(good)).toBe('{"type":"string"}');
  });
});
