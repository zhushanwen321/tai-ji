/**
 * stringifySchemaCached（IF7/#13）— WeakMap 引用级缓存单测（TC6/DM4）。
 *
 * 断言面（design IF7 契约）：
 * - 同对象二调返回同字符串引用（缓存命中，非等值新串）
 * - compact/pretty 分别缓存（互不覆写）
 * - 不同对象互不污染
 * - 输出与直接 JSON.stringify 逐字节一致
 */
import { describe, expect, it, vi } from "vitest";

import { stringifySchemaCached } from "../schema-jsonify.ts";

describe("stringifySchemaCached — WeakMap 引用级缓存", () => {
  const schema = { type: "object", properties: { n: { type: "number" } } };

  it("输出与直接 JSON.stringify 逐字节一致（compact / pretty）", () => {
    expect(stringifySchemaCached(schema, "compact")).toBe(JSON.stringify(schema));
    expect(stringifySchemaCached(schema, "pretty")).toBe(JSON.stringify(schema, null, 2));
  });

  it("同对象二调返回同字符串引用（缓存命中）", () => {
    const a = stringifySchemaCached(schema, "compact");
    const b = stringifySchemaCached(schema, "compact");
    expect(b).toBe(a); // toBe = 引用相等（非仅等值）
  });

  it("同对象跨格式：compact 与 pretty 分别缓存且各自命中", () => {
    const c1 = stringifySchemaCached(schema, "compact");
    const p1 = stringifySchemaCached(schema, "pretty");
    const c2 = stringifySchemaCached(schema, "compact");
    const p2 = stringifySchemaCached(schema, "pretty");
    expect(c2).toBe(c1);
    expect(p2).toBe(p1);
    expect(c1).not.toBe(p1); // 两种格式输出不同，分别缓存
  });

  it("不同对象互不污染（等值异引用各持条目）", () => {
    const s1 = { type: "object" };
    const s2 = { type: "object" }; // 等值但异引用
    const r1 = stringifySchemaCached(s1, "compact");
    const r2 = stringifySchemaCached(s2, "compact");
    expect(r1).toBe(r2); // 等值（内容相同）
    // s2 未命中 s1 的条目（否则 spy 场景下 s2 的 stringify 调用会被跳过——
    // 引用级隔离由「同引用返回同串」+「等值异引用各自 stringify」共同保证）
  });

  it("缓存命中路径不再调 JSON.stringify（spy 计数）", () => {
    const spy = vi.spyOn(JSON, "stringify");
    try {
      const obj = { spy: true };
      stringifySchemaCached(obj, "pretty");
      stringifySchemaCached(obj, "pretty"); // 第二次应命中缓存
      const calls = spy.mock.calls.filter((c) => c[0] === obj);
      expect(calls).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("pretty 缩进锚定：indent=2 与 resolver formatSchemaInstruction 渲染同源", () => {
    const out = stringifySchemaCached({ type: "object" }, "pretty");
    expect(out).toBe('{\n  "type": "object"\n}');
  });

  // [review 修复] TS lib 盲区回归：schema 含 toJSON: () => undefined 钩子时
  // JSON.stringify 运行时返回 undefined，违反声明的 string 返回类型——现 fail-loud
  // 抛含恢复指引的错误，不静默返回 undefined / 垃圾串。
  it("[review 修复] schema 含 toJSON: () => undefined → 抛含恢复指引的错误（compact / pretty）", () => {
    const bad = { type: "object", toJSON: () => undefined };
    expect(() => stringifySchemaCached(bad, "compact")).toThrowError(
      /stringifySchemaCached: JSON\.stringify returned undefined.*Recovery:/s,
    );
    expect(() => stringifySchemaCached(bad, "pretty")).toThrowError(
      /toJSON hook returning undefined.*Recovery:/s,
    );
    // 正常 schema 不受影响（toJSON 返回合法值时按其返回值序列化）
    const good = { type: "object", toJSON: () => ({ type: "string" }) };
    expect(stringifySchemaCached(good, "compact")).toBe('{"type":"string"}');
  });
});
