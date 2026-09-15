/**
 * notifyDone scriptResult 序列化 — boundedPrettySerialize 等价锚定（IF13/#19，TC5/ES5）。
 *
 * bounded 序列化必须与旧实现（全量 JSON.stringify(x, null, 2) + slice(0,8000)+标记）
 * 逐字节等价。断言面（design IF13/ES5 fixture）：
 * - 深嵌套大对象 >8000 → slice(0,8000) + "\n... (truncated)" 逐字节一致
 * - 循环引用 → String(value) 整串回退
 * - 含 BigInt → String(value) 整串回退且不抛出
 * - 含 Date（toJSON）→ 与原生逐字节一致（带引号序列化串）
 * - undefined/function 属性省略；数组元素 undefined → null
 * - 恰好 8000 不加标记 / 8001 → 截到 8000+标记 / 截断点落在转义序列中间
 * - ≤8000 全形态（原语/数组/嵌套/NaN/Unicode）与原生逐字节一致
 *
 * 观察口径：经 notifyDone 公共入口（boundedPrettySerialize 为 helpers 私有），
 * 从 sendMessage 的 content 中提取 "--- Script Result ---" 段。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { notifyDone } from "../interface/helpers.ts";

// ── 最小 mock（helpers-gui.test.ts 同款 duck typing）─────────────

type RunMock = {
  spec: { scriptName: string };
  state: {
    status: string;
    reason?: string;
    scriptResult?: unknown;
    trace: { toArray: () => [] };
  };
};

function makeRun(scriptResult: unknown): RunMock {
  return {
    spec: { scriptName: "build" },
    state: {
      status: "done",
      reason: "completed",
      scriptResult,
      trace: { toArray: () => [] },
    },
  };
}

function makePi(): { pi: ExtensionAPI; sendMessage: ReturnType<typeof vi.fn> } {
  const sendMessage = vi.fn();
  const pi = { sendMessage } as unknown as ExtensionAPI;
  return { pi, sendMessage };
}

/** 提取 content 中 "--- Script Result ---" 段（空 trace 时结尾固定为 Agent Trace 标头）。 */
function scriptResultSection(sendMessage: ReturnType<typeof vi.fn>): string {
  expect(sendMessage).toHaveBeenCalledTimes(1);
  const msg = sendMessage.mock.calls[0][0] as { content: string };
  const content = msg.content;
  const start = content.indexOf("--- Script Result ---\n");
  expect(start).toBeGreaterThan(-1);
  const end = content.lastIndexOf("\n\n--- Agent Trace ---");
  expect(end).toBeGreaterThan(start);
  return content.slice(start + "--- Script Result ---\n".length, end);
}

/** 旧实现参照（全量序列化 + 截断）。 */
function legacySerialize(x: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(x, null, 2);
  } catch {
    serialized = String(x);
  }
  return serialized.length > 8000
    ? serialized.slice(0, 8000) + "\n... (truncated)"
    : serialized;
}

function runAndGetSection(scriptResult: unknown): string {
  const { pi, sendMessage } = makePi();
  notifyDone(pi, "run-if13", makeRun(scriptResult) as never, new Set());
  return scriptResultSection(sendMessage);
}

// ── 深嵌套大对象 fixture ──────────────────────────────────────

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

describe("notifyDone scriptResult — bounded 序列化等价锚定（IF13）", () => {
  it("深嵌套大对象（>8000）：与全量 stringify 后 slice+标记 逐字节一致", () => {
    const x = deepNested();
    expect(JSON.stringify(x, null, 2).length).toBeGreaterThan(10_000); // 确认确实超预算
    expect(runAndGetSection(x)).toBe(legacySerialize(x));
  });

  it("循环引用 → String(value) 整串回退（不抛出）", () => {
    const x: Record<string, unknown> = { a: 1 };
    x.self = x;
    expect(runAndGetSection(x)).toBe(legacySerialize(x));
    expect(runAndGetSection(x)).toBe(String(x));
  });

  it("含 BigInt → String(value) 整串回退且不抛出（对齐旧整体 catch）", () => {
    const x = { count: 10n, label: "big" };
    expect(runAndGetSection(x)).toBe(String(x));
    expect(runAndGetSection(x)).toBe(legacySerialize(x));
  });

  it("含 Date（toJSON）→ 与原生逐字节一致（带引号序列化串）", () => {
    const x = { at: new Date(0), note: "ts" };
    expect(runAndGetSection(x)).toBe(legacySerialize(x));
    expect(runAndGetSection(x)).toContain('"1970-01-01T00:00:00.000Z"');
  });

  it("undefined/function 属性省略与原生一致；数组内 undefined/function → null", () => {
    const x = {
      keep: 1,
      dropU: undefined,
      dropF: () => 1,
      arr: [undefined, 2, () => 3, null],
    };
    expect(runAndGetSection(x)).toBe(legacySerialize(x));
    expect(runAndGetSection(x)).toBe(JSON.stringify(x, null, 2));
  });

  it("≤8000 全形态与原生逐字节一致（原语/数组/嵌套/NaN/Infinity/Unicode）", () => {
    // 注：null / undefined 顶层被 notifyDone 上游守卫（!== undefined && !== null）
    // 跳过整段，不进序列化路径，不在此用例面内。
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
      expect(runAndGetSection(x)).toBe(legacySerialize(x));
    }
  });
});

describe("notifyDone scriptResult — 截断边界（恰好 8000 / 8001 / 转义序列中间）", () => {
  /** 构造 pretty 全文恰好 len 字符的对象：{\n  "a": "<S>"\n} = 13 + S.length。 */
  function sizedStringObject(totalLen: number): { a: string } {
    return { a: "x".repeat(totalLen - 13) };
  }

  it("恰好 8000：不加标记，输出 === 原生全文", () => {
    const x = sizedStringObject(8000);
    expect(JSON.stringify(x, null, 2).length).toBe(8000); // 前置校验构造正确
    const section = runAndGetSection(x);
    expect(section).toBe(JSON.stringify(x, null, 2));
    expect(section).not.toContain("(truncated)");
    expect(section.length).toBe(8000);
  });

  it("8001：截到 8000 + 标记", () => {
    const x = sizedStringObject(8001);
    expect(JSON.stringify(x, null, 2).length).toBe(8001);
    const section = runAndGetSection(x);
    expect(section).toBe(JSON.stringify(x, null, 2).slice(0, 8000) + "\n... (truncated)");
    expect(section.length).toBe(8000 + "\n... (truncated)".length);
  });

  it("截断点落在转义序列中间（\\u0001 被切半）：与 slice 逐字节一致", () => {
    // 控制字符 U+0001 被 JSON.stringify 转义为 6 字符序列 \u0001（现代 Node 对
    // U+2028 不转义——ES2019 JSON superset，实测 JSON.stringify("\\u2028") 输出原字符，
    // 故用必转义的控制字符）。pad 逐字符平移使全文第 8000 字符扫过转义序列内部，
    // 命中起始反斜杠——截断点切在转义序列中间（不补任何转义闭合，末尾裸反斜杠）。
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
    expect(full.charCodeAt(7999)).toBe(92); // 第 8000 字符 = 反斜杠（转义序列开头被切）
    const section = runAndGetSection(x);
    expect(section).toBe(full.slice(0, 8000) + "\n... (truncated)");
    // 截断段（前 8000 字符）末尾是裸反斜杠——切在转义序列中间，未补转义/结构闭合
    expect(section.slice(0, 8000).endsWith("\\")).toBe(true);
  });
});
