// src/shared/__tests__/model-ref.test.ts
//
// [U1 ModelRef 全等裁决] assertCanonicalModelRef / modelRefFromVerified 单测族。
// 设计权威：docs/architecture/pi-boundary-reliability.md 附录 D §3.3 D1（规则①~⑤含孪生守卫）、D2（继承路径豁免口径）。
//
// P-A2（实施期门）：孪生守卫行为验证——含孪生的 registry 快照实测拒单路径 +
// 无孪生快照实测放行路径。「有孪生仍放行」= 守卫失效，阻断合入。

import { describe, expect, it } from "vitest";

import {
  type ModelRefSource,
  assertCanonicalModelRef,
  assertThinkingLevel,
  modelRefFromVerified,
  stripThinkingSuffix,
  THINKING_ORDER,
} from "../model-ref.ts";

// ============================================================
// helpers
// ============================================================

/** registry 快照构造（getAvailable 顺序即判定顺序）。 */
function makeSource(entries: ReadonlyArray<{ provider: string; id: string }>): ModelRefSource {
  return { getAvailable: () => entries };
}

/** 基线快照：模拟真实 registry 形态（大小写混合 id + 无关条目）。 */
const BASELINE: ReadonlyArray<{ provider: string; id: string }> = [
  { provider: "zai-coding-cn", id: "GLM-5.3-Flash" },
  { provider: "zai-coding-cn", id: "GLM-5.3" },
  { provider: "xiaomi-token-plan-cn", id: "mimo-v2.5-pro" },
  { provider: "deepseek", id: "deepseek-v4-pro" },
];

// ============================================================
// 全等放行（规则③）+ 无孪生快照（P-A2 放行路径）
// ============================================================

describe("assertCanonicalModelRef — exact match passes (rule ③)", () => {
  it("全等命中 → 返回 {provider, id}，与 registry 条目逐字段全等", () => {
    const ref = assertCanonicalModelRef("zai-coding-cn/GLM-5.3-Flash", makeSource(BASELINE));
    expect(ref).toEqual({ provider: "zai-coding-cn", id: "GLM-5.3-Flash" });
  });

  it("P-A2 放行路径：无孪生快照下全等写法放行（含大小写差异的 id 原样保留）", () => {
    // 快照中该 id 仅一种大小写形态（GLM-5.3-Flash ≠ glm-5.3，后者是不同 id 而非孪生）
    const ref = assertCanonicalModelRef("zai-coding-cn/GLM-5.3-Flash", makeSource(BASELINE));
    expect(ref.id).toBe("GLM-5.3-Flash");
    expect(ref.provider).toBe("zai-coding-cn");
  });

  it("无关大小写的不同 id（GLM-5.3 vs GLM-5.3-Flash）不构成孪生，全等命中各自放行", () => {
    const source = makeSource(BASELINE);
    expect(assertCanonicalModelRef("zai-coding-cn/GLM-5.3", source)).toEqual({
      provider: "zai-coding-cn",
      id: "GLM-5.3",
    });
  });
});

// ============================================================
// 非全等同步拒单（规则②⑤）+ case variant 首位建议
// ============================================================

describe("assertCanonicalModelRef — non-exact rejected synchronously (rule ⑤)", () => {
  it("小写变体输入 → 同步抛错（不采纳、不改写），错误含原始输入", () => {
    expect(() =>
      assertCanonicalModelRef("zai-coding-cn/glm-5.3-flash", makeSource(BASELINE)),
    ).toThrow(/is not a registry entry/);
  });

  it("case variant 是首个建议且标注 ← case variant（S2 负面路径）", () => {
    let msg = "";
    try {
      assertCanonicalModelRef("zai-coding-cn/glm-5.3-flash", makeSource(BASELINE), { source: "paramOverride" });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/is not a registry entry/);
    expect(msg).toContain('Model "zai-coding-cn/glm-5.3-flash" (paramOverride)');
    expect(msg).toMatch(/Registry match is case-sensitive/);
    expect(msg).toMatch(/Did you mean one of these\?/);
    // case variant 排首位并标注
    const didYouMeanIdx = msg.indexOf("Did you mean one of these?");
    const variantLine = msg.indexOf("zai-coding-cn/GLM-5.3-Flash   ← case variant of \"glm-5.3-flash\"");
    expect(variantLine).toBeGreaterThan(didYouMeanIdx);
    // 其他模糊候选在 case variant 之后
    const otherIdx = msg.indexOf("Other models you may have meant");
    expect(otherIdx).toBeGreaterThan(variantLine);
    expect(msg).toContain("zai-coding-cn/GLM-5.3");
  });

  it("错误末尾附「省略 model 继承主 agent」指引", () => {
    let msg = "";
    try {
      assertCanonicalModelRef("zai-coding-cn/glm-5.3-flash", makeSource(BASELINE));
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/Or omit the `model` param to inherit the main agent model\./);
  });

  it("provider 大小写不同（Zai-Coding-CN）→ 不命中（provider 精确匹配，规则②）", () => {
    let msg = "";
    try {
      assertCanonicalModelRef("Zai-Coding-CN/GLM-5.3-Flash", makeSource(BASELINE));
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/is not a registry entry/);
    // provider 拼写相近 → general 候选命中
    expect(msg).toMatch(/Other models you may have meant/);
  });

  it("同 provider 但 id 不存在 → provider 相似度候选（同 provider 下其他条目）", () => {
    let msg = "";
    try {
      assertCanonicalModelRef("zai-coding-cn/nonexistent-probe", makeSource(BASELINE), { source: "agentConfig" });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/is not a registry entry/);
    expect(msg).not.toMatch(/Did you mean/);
    expect(msg).toMatch(/Other models you may have meant/);
    expect(msg).toContain("zai-coding-cn/GLM-5.3-Flash");
    expect(msg).toContain("(agentConfig)");
  });

  it("provider 与 id 均无相似物 → 列合法串全集 + 继承指引（S2 前者路径）", () => {
    let msg = "";
    try {
      assertCanonicalModelRef("ghost-provider/zzz-unknown", makeSource(BASELINE));
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/is not a registry entry/);
    expect(msg).not.toMatch(/Did you mean/);
    expect(msg).toMatch(/No similar models found\./);
    expect(msg).toMatch(/Available models:/);
    // 合法串全集（canonical 形态，可复制）
    expect(msg).toContain("zai-coding-cn/GLM-5.3-Flash");
    expect(msg).toContain("xiaomi-token-plan-cn/mimo-v2.5-pro");
    expect(msg).toMatch(/Or omit the `model` param to inherit the main agent model\./);
  });

  it("无 slash / 空 id → 同步拒单（结构非法）", () => {
    const source = makeSource(BASELINE);
    expect(() => assertCanonicalModelRef("no-slash", source)).toThrow(/is not a registry entry/);
    expect(() => assertCanonicalModelRef("only-provider/", source)).toThrow(/is not a registry entry/);
  });

  it("空 registry → 明确提示 + 继承指引", () => {
    let msg = "";
    try {
      assertCanonicalModelRef("p/m", makeSource([]));
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/Registry has no available models\./);
    expect(msg).toMatch(/Or omit the `model` param/);
  });
});

// ============================================================
// strip thinking 后缀（规则①）
// ============================================================

describe("assertCanonicalModelRef — strips legal thinking suffix (rule ①)", () => {
  it('":xhigh" 后缀剥离后全等命中', () => {
    const ref = assertCanonicalModelRef("deepseek/deepseek-v4-pro:xhigh", makeSource(BASELINE));
    expect(ref).toEqual({ provider: "deepseek", id: "deepseek-v4-pro" });
  });

  it('":max" 后缀剥离后全等命中（THINKING_ORDER 含 max）', () => {
    const ref = assertCanonicalModelRef("zai-coding-cn/GLM-5.3-Flash:max", makeSource(BASELINE));
    expect(ref.id).toBe("GLM-5.3-Flash");
  });

  it('非白名单后缀（":foo"）不剥离 → 未命中拒单', () => {
    expect(() =>
      assertCanonicalModelRef("zai-coding-cn/GLM-5.3-Flash:foo", makeSource(BASELINE)),
    ).toThrow(/is not a registry entry/);
  });
});

// ============================================================
// 孪生守卫（规则④）—— P-A2 拒单路径
// ============================================================

describe("assertCanonicalModelRef — twin guard (rule ④, P-A2)", () => {
  /** 含大小写孪生的 registry 快照（模拟 models-store 刷新后 GLM-5.3-Flash 与 glm-5.3-flash 并存）。 */
  const TWIN_SNAPSHOT: ReadonlyArray<{ provider: string; id: string }> = [
    { provider: "zai-coding-cn", id: "GLM-5.3-Flash" },
    { provider: "zai-coding-cn", id: "glm-5.3-flash" },
    { provider: "deepseek", id: "deepseek-v4-pro" },
  ];

  it("P-A2 拒单路径：有孪生仍放行 = 守卫失效——全等命中（大写形态）也必须拒绝", () => {
    let msg = "";
    try {
      // 输入与快照条目逐字符全等，但 registry 存在 case-insensitive 相等的另一条目
      assertCanonicalModelRef("zai-coding-cn/GLM-5.3-Flash", makeSource(TWIN_SNAPSHOT));
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('Model "zai-coding-cn/GLM-5.3-Flash" matches a registry entry exactly');
    expect(msg).toMatch(
      /registry contains ambiguous case variants for zai-coding-cn\/GLM-5\.3-Flash: \[zai-coding-cn\/GLM-5\.3-Flash, zai-coding-cn\/glm-5\.3-flash\]/,
    );
    // 恢复指引：清理重复条目后重试
    expect(msg).toMatch(/Recovery: remove the duplicate case variant from models\.json/);
    expect(msg).toMatch(/then retry with the exact registry string\./);
  });

  it("P-A2 拒单路径：孪生快照下小写全等形态同样拒绝（两个方向都不放行）", () => {
    expect(() =>
      assertCanonicalModelRef("zai-coding-cn/glm-5.3-flash", makeSource(TWIN_SNAPSHOT)),
    ).toThrow(/ambiguous case variants/);
  });

  it("无孪生快照下同串放行（守卫零误伤）", () => {
    const ref = assertCanonicalModelRef("zai-coding-cn/GLM-5.3-Flash", makeSource(BASELINE));
    expect(ref.id).toBe("GLM-5.3-Flash");
  });

  it("不同 provider 下的同形 id 不构成孪生（provider 精确作用域）", () => {
    const snapshot = [
      { provider: "zai-coding-cn", id: "GLM-5.3-Flash" },
      { provider: "other-cn", id: "glm-5.3-flash" },
    ];
    const ref = assertCanonicalModelRef("zai-coding-cn/GLM-5.3-Flash", makeSource(snapshot));
    expect(ref.id).toBe("GLM-5.3-Flash");
  });
});

// ============================================================
// 继承路径包装（D2 豁免口径）：modelRefFromVerified
// ============================================================

describe("modelRefFromVerified — ctxModel inheritance path (D2)", () => {
  it("无孪生 → 包装为 ModelRef（{provider, id} 形态，供 ${provider}/${id} 拼接）", () => {
    const ref = modelRefFromVerified(
      { provider: "zai-coding-cn", id: "GLM-5.3-Flash" },
      makeSource(BASELINE),
    );
    expect(ref).toEqual({ provider: "zai-coding-cn", id: "GLM-5.3-Flash" });
  });

  it("豁免存在性复查：ctxModel 不在 registry 快照中仍放行（运行时已验证）", () => {
    // registry 为空（快照过期等）不阻塞继承——缺省继承是输入缺省而非变体放行
    const ref = modelRefFromVerified(
      { provider: "runtime-only", id: "live-model" },
      makeSource([]),
    );
    expect(ref).toEqual({ provider: "runtime-only", id: "live-model" });
  });

  it("P-A2 双路径生效：含孪生快照下继承路径同样拒绝（豁免的只是存在性复查，不是孪生守卫）", () => {
    const TWIN_SNAPSHOT = [
      { provider: "zai-coding-cn", id: "GLM-5.3-Flash" },
      { provider: "zai-coding-cn", id: "glm-5.3-flash" },
    ];
    expect(() =>
      modelRefFromVerified({ provider: "zai-coding-cn", id: "GLM-5.3-Flash" }, makeSource(TWIN_SNAPSHOT)),
    ).toThrow(/ambiguous case variants/);
  });
});

// ============================================================
// stripThinkingSuffix / assertThinkingLevel
// ============================================================

describe("stripThinkingSuffix", () => {
  it("剥白名单后缀", () => {
    expect(stripThinkingSuffix("p/m:high")).toBe("p/m");
    expect(stripThinkingSuffix("p/m:off")).toBe("p/m");
    expect(stripThinkingSuffix("p/m")).toBe("p/m");
  });

  it("非白名单冒号后缀不剥", () => {
    expect(stripThinkingSuffix("p/m:foo")).toBe("p/m:foo");
  });
});

describe("assertThinkingLevel", () => {
  it("undefined 透传", () => {
    expect(assertThinkingLevel(undefined)).toBeUndefined();
  });

  it("白名单值放行并窄化为字面量联合", () => {
    expect(assertThinkingLevel("high")).toBe("high");
    expect(assertThinkingLevel("max")).toBe("max");
  });

  it("非白名单值同步抛错（可操作文案：列出合法值）", () => {
    expect(() => assertThinkingLevel("ultra")).toThrow(
      /Invalid thinkingLevel "ultra"\. Allowed values: off, minimal, low, medium, high, xhigh, max\./,
    );
  });

  it("THINKING_ORDER SSOT：白名单全集顺序稳定（低→高，含 max）", () => {
    expect(THINKING_ORDER).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  });
});
