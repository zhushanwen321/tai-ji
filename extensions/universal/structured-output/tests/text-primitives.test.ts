// tests/text-primitives.test.ts
//
// text-primitives 直测（审查项：新文件此前零直接单测，仅经 loop-gate / characterization
// 间接触达）。签名原料提取错误会直接导致 U2 有界失败门禁误杀/漏杀（round-4 audit
// 主题域），防御分支与截断边界在此逐例锁定。
//
// 纯函数测试：零依赖、无 pi 运行时、无 mock。
import { describe, expect, it } from "vitest";

import {
  SIGNATURE_MAX_CHARS,
  STEER_ERROR_MAX_CHARS,
  extractToolErrorText,
  truncateText,
} from "../src/text-primitives.js";

describe("extractToolErrorText", () => {
  it("合法形态：result.content[0].text → 返回该文本", () => {
    const result = { content: [{ type: "text", text: "Schema validation failed: /count must be number" }] };
    expect(extractToolErrorText(result)).toBe("Schema validation failed: /count must be number");
  });

  it("content 多 item：取首个非空 text（跳过非 text 形态 / 空 text item）", () => {
    const result = {
      content: [
        { type: "image", data: "base64..." },
        { type: "text", text: "" }, // 空串跳过
        { type: "text", text: "real error" },
      ],
    };
    expect(extractToolErrorText(result)).toBe("real error");
  });

  it("content 缺失时 {error} 字符串兜底", () => {
    expect(extractToolErrorText({ error: "tool exploded" })).toBe("tool exploded");
    // content 存在但取不到文本时同样落到 {error} 兜底
    expect(extractToolErrorText({ content: "not-an-array", error: "fallback error" })).toBe("fallback error");
  });

  it("全部取不到 → undefined（调用方降级为通用提示）", () => {
    expect(extractToolErrorText(undefined)).toBeUndefined();
    expect(extractToolErrorText("plain string")).toBeUndefined();
    expect(extractToolErrorText({})).toBeUndefined();
    expect(extractToolErrorText({ content: [{ type: "text", text: "" }] })).toBeUndefined();
    expect(extractToolErrorText({ content: [{ type: "text" }] })).toBeUndefined();
    expect(extractToolErrorText({ error: "" })).toBeUndefined();
  });
});

describe("truncateText", () => {
  it("未超限：原样返回（含恰好等于 max 的边界）", () => {
    expect(truncateText("abc", 3)).toBe("abc");
    expect(truncateText("", 5)).toBe("");
    expect(truncateText("abc", 10)).toBe("abc");
  });

  it("超限：截到 max 并追加 '...'（总长 max + 3）", () => {
    expect(truncateText("abcdef", 3)).toBe("abc...");
    expect(truncateText("abcdefg", 4)).toBe("abcd...");
  });

  it("两上限常量语义独立（F5 拆分：数值演化不共享）", () => {
    expect(typeof SIGNATURE_MAX_CHARS).toBe("number");
    expect(typeof STEER_ERROR_MAX_CHARS).toBe("number");
    expect(SIGNATURE_MAX_CHARS).toBeGreaterThan(0);
    expect(STEER_ERROR_MAX_CHARS).toBeGreaterThan(0);
  });
});
