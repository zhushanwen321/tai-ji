/**
 * boundedPrettySerialize 测试（自 pi-sw helpers-bounded-serialize.test.ts 平移
 * + 字节快照，sink 设计 U6a / B7 验收②：与 pi-sw 现实现输出字节一致）。
 *
 * 平移说明（对照方式选型，二选一之「硬编码快照样例」）：pi-sw 侧实现为
 * helpers.ts 私有函数（唯一公共出口 notifyDone 固定 budget=8000，且其 import
 * 链依赖 pi SDK / extension-protocol，不宜从 core 测试直连）。字节一致的锚定
 * 由三层构成：
 * 1. **等价参照平移**——pi-sw 既有测试的全部用例（含 legacySerialize 参照实现）
 *    平移至此，在 budget=8000 与小 budget 矩阵上断言 core 实现 ≡ 参照；
 * 2. **硬编码字节快照**——期望串以 JSON.stringify 规范行为基准手工固化为字面量
 *    （不回读被测实现），锚死具体字节形态；
 * 3. 实施期实跑 pi-sw 侧 helpers-bounded-serialize.test.ts（其断言即
 *    pi-sw 实现 ≡ 同一参照），三方经公共参照闭环为字节一致。
 */
import { describe, expect, it } from "vitest";

import { boundedPrettySerialize } from "../bounded-serialize.ts";

/** pi-sw 旧实现参照（全量序列化 + 截断；同 helpers-bounded-serialize.test.ts）。 */
function legacySerialize(x: unknown, budget = 8000): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(x, null, 2);
  } catch {
    serialized = String(x);
  }
  return serialized.length > budget
    ? serialized.slice(0, budget) + "\n... (truncated)"
    : serialized;
}

// ── 深嵌套大对象 fixture（平移）───────────────────────────────

function deepNested(): unknown {
  const root: Record<string, unknown> = {};
  let cur = root;
  for (let i = 0; i < 60; i++) {
    cur.header = `level-${i}-数据`;
    cur.items = Array.from({ length: 12 }, (__, j) => ({
      id: j,
      name: `item-${i}-${j}`,
      tags: ["alpha", "βeta", "γλυφ"],
      nested: { deep: { deeper: { value: i * 1000 + j } } },
    }));
    cur.next = {};
    cur = cur.next as Record<string, unknown>;
  }
  cur.end = "leaf";
  return root;
}

describe("bounded 序列化等价锚定（平移自 pi-sw，budget=8000）", () => {
  it("深嵌套大对象（>8000）：与全量 stringify 后 slice+标记 逐字节一致", () => {
    const x = deepNested();
    expect(JSON.stringify(x, null, 2).length).toBeGreaterThan(10_000);
    expect(boundedPrettySerialize(x, 8000)).toBe(legacySerialize(x));
  });

  it("循环引用 → String(value) 整串回退（不抛出）", () => {
    const x: Record<string, unknown> = { a: 1 };
    x.self = x;
    expect(boundedPrettySerialize(x, 8000)).toBe(legacySerialize(x));
    expect(boundedPrettySerialize(x, 8000)).toBe(String(x));
  });

  it("含 BigInt → String(value) 整串回退且不抛出（对齐旧整体 catch）", () => {
    const x = { count: 10n, label: "big" };
    expect(boundedPrettySerialize(x, 8000)).toBe(String(x));
    expect(boundedPrettySerialize(x, 8000)).toBe(legacySerialize(x));
  });

  it("含 Date（toJSON）→ 与原生逐字节一致（带引号序列化串）", () => {
    const x = { at: new Date(0), note: "ts" };
    expect(boundedPrettySerialize(x, 8000)).toBe(legacySerialize(x));
    expect(boundedPrettySerialize(x, 8000)).toContain('"1970-01-01T00:00:00.000Z"');
  });

  it("undefined/function 属性省略与原生一致；数组内 undefined/function → null", () => {
    const x = {
      keep: 1,
      dropU: undefined,
      dropF: () => 1,
      arr: [undefined, 2, () => 3, null],
    };
    expect(boundedPrettySerialize(x, 8000)).toBe(legacySerialize(x));
    expect(boundedPrettySerialize(x, 8000)).toBe(JSON.stringify(x, null, 2));
  });

  it("≤8000 全形态与原生逐字节一致（原语/数组/嵌套/NaN/Infinity/Unicode）", () => {
    const cases: unknown[] = [
      "plain string",
      42,
      true,
      NaN,
      Infinity,
      [1, [2, [3, "x"]]],
      { a: { b: { c: [1, "汉", { d: null }] } } },
      { emptyObj: {}, emptyArr: [] },
      { unicode: "line sep  pic ⌘" },
    ];
    for (const x of cases) {
      expect(boundedPrettySerialize(x, 8000)).toBe(legacySerialize(x));
    }
  });
});

describe("截断边界（平移自 pi-sw，恰好 8000 / 8001 / 转义序列中间）", () => {
  /** 构造 pretty 全文恰好 len 字符的对象：{\n  "a": "<S>"\n} = 13 + S.length。 */
  function sizedStringObject(totalLen: number): { a: string } {
    return { a: "x".repeat(totalLen - 13) };
  }

  it("恰好 8000：不加标记，输出 === 原生全文", () => {
    const x = sizedStringObject(8000);
    expect(JSON.stringify(x, null, 2).length).toBe(8000);
    const out = boundedPrettySerialize(x, 8000);
    expect(out).toBe(JSON.stringify(x, null, 2));
    expect(out).not.toContain("(truncated)");
    expect(out.length).toBe(8000);
  });

  it("8001：截到 8000 + 标记", () => {
    const x = sizedStringObject(8001);
    expect(JSON.stringify(x, null, 2).length).toBe(8001);
    const out = boundedPrettySerialize(x, 8000);
    expect(out).toBe(JSON.stringify(x, null, 2).slice(0, 8000) + "\n... (truncated)");
    expect(out.length).toBe(8000 + "\n... (truncated)".length);
  });

  it("截断点落在转义序列中间（\\u0001 被切半）：与 slice 逐字节一致", () => {
    const esc = "\u0001";
    let x: unknown = null;
    let full = "";
    for (let pad = 0; pad < 40; pad++) {
      const candidate = { pad: "p".repeat(pad), payload: Array.from({ length: 1200 }, () => esc + "汉") };
      const s = JSON.stringify(candidate, null, 2);
      if (s.length > 8000 && s.charCodeAt(7999) === 92) {
        x = candidate;
        full = s;
        break;
      }
    }
    expect(x).not.toBeNull();
    expect(full.charCodeAt(7999)).toBe(92);
    const out = boundedPrettySerialize(x, 8000);
    expect(out).toBe(full.slice(0, 8000) + "\n... (truncated)");
    expect(out.slice(0, 8000).endsWith("\\")).toBe(true);
  });
});

describe("小 budget 矩阵（截断路径全覆盖：特殊值形态 × 边界刻度）", () => {
  const budgets = [0, 1, 5, 13, 21, 50];
  // 仅含确定性前缀形态。(b) 整串回退路径（BigInt/循环引用）不入矩阵：其回退只在
  // 抛出/检环节点被实际生成时触发，截断先于该节点完成时输出结构前缀——与 pi-sw
  // 逐字平移的既有行为一致，临界行为单独钉在下方用例。
  const cases: unknown[] = [
    { a: 1, b: [1, "汉", { d: null }] },
    { at: new Date(0) },
    { keep: 1, dropU: undefined, arr: [undefined, 2, null] },
    [NaN, Infinity],
    {},
    [],
  ];

  it("确定性前缀形态在每个 budget 上与参照逐字节一致", () => {
    for (const x of cases) {
      for (const budget of budgets) {
        expect(boundedPrettySerialize(x, budget)).toBe(legacySerialize(x, budget));
      }
    }
  });

  it("(b) 整串回退的触达边界：抛出节点被生成前截断则不回退（逐字平移的既有行为）", () => {
    const big = { count: 10n, label: "big" };
    // budget 13 = "{\n  \"count\": " 恰好收完 → 抛出节点被触达 → fallback 截断（≡ 参照）
    expect(boundedPrettySerialize(big, 13)).toBe(legacySerialize(big, 13));
    expect(boundedPrettySerialize(big, 13)).toBe("[object Objec\n... (truncated)");
    // budget 12：截断在抛出节点前完成 → 结构前缀（非 fallback，≠ 参照的 "[..." 回退）
    expect(boundedPrettySerialize(big, 12)).toBe('{\n  "count":\n... (truncated)');
    // 循环引用同款：budget 1 时截断先于环检测 → 结构前缀 "{"
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    expect(boundedPrettySerialize(circular, 1)).toBe("{\n... (truncated)");
    expect(legacySerialize(circular, 1)).toBe("[\n... (truncated)"); // 参照为 fallback 形态
  });
});

describe("硬编码字节快照（期望串固化为字面量，不回读实现）", () => {
  it("小型对象全文", () => {
    expect(boundedPrettySerialize({ a: 1, b: [1, "汉", { d: null }] }, 8000)).toBe(
      '{\n  "a": 1,\n  "b": [\n    1,\n    "汉",\n    {\n      "d": null\n    }\n  ]\n}',
    );
  });

  it("Date（toJSON）序列化串", () => {
    expect(boundedPrettySerialize({ at: new Date(0) }, 8000)).toBe(
      '{\n  "at": "1970-01-01T00:00:00.000Z"\n}',
    );
  });

  it("undefined/function 省略 + 数组元素 null 化", () => {
    expect(boundedPrettySerialize({ arr: [undefined, 2, () => 3, null] }, 8000)).toBe(
      '{\n  "arr": [\n    null,\n    2,\n    null,\n    null\n  ]\n}',
    );
  });

  it("NaN/Infinity → null；空容器 compact 形态", () => {
    expect(boundedPrettySerialize([NaN, Infinity], 8000)).toBe('[\n  null,\n  null\n]');
    expect(boundedPrettySerialize({}, 8000)).toBe("{}");
    expect(boundedPrettySerialize([], 8000)).toBe("[]");
  });

  it("循环引用 / BigInt 整串回退字面量", () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    expect(boundedPrettySerialize(circular, 8000)).toBe("[object Object]");
    expect(boundedPrettySerialize({ count: 10n }, 8000)).toBe("[object Object]");
  });

  it("转义序列形态与三档截断的字节字面量（全文 21 字符）", () => {
    // {\n  "key": "\u0001"\n} = 21 字符；第 12 字符为转义起始反斜杠
    const full = '{\n  "key": "\\u0001"\n}';
    expect(boundedPrettySerialize({ key: "\u0001" }, 8000)).toBe(full);
    // 恰好 21：不加标记
    expect(boundedPrettySerialize({ key: "\u0001" }, 21)).toBe(full);
    // budget 20：切掉收尾 }，标记另起一行（两个连续 \n）
    expect(boundedPrettySerialize({ key: "\u0001" }, 20)).toBe(
      '{\n  "key": "\\u0001"\n' + "\n... (truncated)",
    );
    // budget 13：切在转义序列中间——末尾裸反斜杠，不补闭合
    expect(boundedPrettySerialize({ key: "\u0001" }, 13)).toBe(
      '{\n  "key": "\\' + "\n... (truncated)",
    );
  });
});
