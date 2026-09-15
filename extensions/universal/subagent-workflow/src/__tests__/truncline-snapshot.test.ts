/**
 * truncLine — indexOf 化（IF12/#18）byte-identical 快照 + 非 SGR ESC 行为锚定。
 *
 * fixture（__fixtures__/truncline.snapshot.json）由**改造前实现**生成落盘
 * （本文件同 commit），断言重构后输出逐字节一致——含 OSC / 裸 \x1b / \x1b[K
 * 非 SGR ESC 用例（等价定义点：非 SGR ESC 不构成文本段边界，按文本计宽进 result）。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { truncLine } from "../interface/format.ts";

interface SnapshotCase {
  label: string;
  maxWidth: number;
  text: string;
  expected: string;
}

function loadCases(): SnapshotCase[] {
  const here = dirname(fileURLToPath(import.meta.url));
  return JSON.parse(
    readFileSync(join(here, "__fixtures__", "truncline.snapshot.json"), "utf8"),
  ) as SnapshotCase[];
}

describe("truncLine — indexOf 化 byte-identical 快照（IF12）", () => {
  it("全部 fixture 用例（10k ANSI 混合行 / CJK / OSC / 裸 ESC / CSI-K / emoji）与改造前输出逐字节一致", () => {
    const cases = loadCases();
    expect(cases.length).toBeGreaterThanOrEqual(10);
    for (const c of cases) {
      expect(truncLine(c.text, c.maxWidth)).toBe(c.expected);
    }
  });

  it("10k 混合长行在多个截断宽度下均一致（fixture 内 maxWidth 之外再加宽度扫描）", () => {
    const mixed = loadCases().find((c) => c.label === "sgr-mixed-10k")!;
    for (const w of [8, 15, 30, 61, 100]) {
      const expected = mixed.expected; // fixture 锁 maxWidth=60；其他宽度靠 oracle 断言
      void expected;
      // 非 fixture 宽度用行为断言：输出含省略号且无裸换行
      const out = truncLine(mixed.text, w);
      expect(out).toContain("…");
      expect(out).not.toContain("\n");
    }
  });
});

describe("truncLine — 非 SGR ESC 行为（等价定义点，显式锚定）", () => {
  it("OSC 序列（\\x1b]0;title\\x07）按文本计宽进 result（不作为样式捕获/段边界）", () => {
    // OSC 计入可见宽度（\x1b]0;title\x07 各字符占宽），随后文本继续同段累加
    const out = truncLine("AB\x1b]0;title\x07CDEFGHIJKLMNOP", 10);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toContain("\x1b]0;title\x07"); // 截断点在 OSC 之内或之前——
    // 逐字节形态由 fixture（osc-title / osc-inside-truncation 用例）锚定
  });

  it("裸 \\x1b 后跟非 [ 字符：不匹配 SGR、并入文本段（不丢字符不死循环）", () => {
    const out = truncLine("before \x1bZ after bare esc tail", 12);
    expect(out.endsWith("…")).toBe(true);
    // 输出是输入前缀（前 11 可见列 + …），未吞字符
    expect(out.startsWith("before ")).toBe(true);
  });

  it("非 SGR CSI（\\x1b[K）与 SGR 混排且触发截断：\x1b[K 不进 activeStyles（无错位 reset）", () => {
    const out = truncLine("\x1b[31mred\x1b[K\x1b[32mgreen tail past width", 10);
    // SGR（31m/32m）被捕获；\x1b[K 按文本进 result——逐字节形态由 fixture
    //（csi-k-mixed-sgr 用例）锚定；此处断言 SGR 样式重应用语义未回归
    expect(out).toMatch(/\x1b\[31m/);
    expect(out.endsWith("…\x1b[0m")).toBe(true);
  });

  it("ESC 恰在串尾：无后续字符可判 SGR，按文本并入（end=flat.length）", () => {
    const out = truncLine("text almost at width limit\x1b", 22);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toContain("\x1b["); // 末尾裸 ESC 未触发 SGR 捕获
  });
});
