// src/__tests__/retry-rules-classification-parity.test.ts
//
// [subagent-observability §3.3.2/§3.3.12] retry-rules 双消费方跨包行为对拍：
// 分类侧 = 本包 retry-rules-classification.ts（收尾边沿失败分类，findClassificationRule），
// 改写侧 = @taiji/shared evaluateRetryRules（retry-rules 域 SSOT，message_end 改写判定）。
// 两侧消费同一份 ext-config effectiveRules，但镜像实现跨包不可 import（引擎包只依赖
// SDK + pi-rpc），漂移无编译红——本测试用同一错误文本输入矩阵断言「分类侧 retryable
// 判定 ≡ 改写侧 action=rewrite 结论」（两层序同输入命中同规则）。漂移后果 = 分类通道
// 判 retryable 而改写通道不触发重试（或反向），静默分叉。
//
// @taiji/shared 仅测试面消费（devDependencies + workspace 源直引，bundle 自包含不受影响）。

import { describe, expect, it } from "vitest";

import {
  evaluateRetryRules,
  matchRetryRule,
  RETRY_RULES_BASELINE,
  type RetryableErrorRule,
} from "@taiji/shared";

import { findClassificationRule, verdictToRetryable } from "../retry-rules-classification.ts";

// 镜像 shared RETRY_RULES_DOMAIN.textMaxLen（判定输入截断上限）——恒等复算 helper 的
// 截断须与两侧实跑一致，超长矩阵用例的等价断言依赖它。
const SHARED_TEXT_MAX_LEN = 8192;

/** SOURCE 判定序（shared SOURCE_ORDER 同款字面：custom > remote > builtin）。 */
const SOURCE_ORDER = ["custom", "remote", "builtin"] as const;

/**
 * 改写侧期望命中规则复算（shared evaluateRetryRules 声明的两层序逐字编码）：
 * ① 全 source 的 non_retryable 排除序；② verdict 内按 source 序首个命中即断。
 * 只服务恒等断言（「命中同一条规则」）；结论级对拍以 evaluateRetryRules 实跑为准，
 * shared 序变更时本复算与实跑分叉 → 恒等断言红，强迫显式重审。
 */
function rewriteSideExpectedHit(
  message: string,
  rules: readonly RetryableErrorRule[],
): RetryableErrorRule | undefined {
  const truncated =
    message.length > SHARED_TEXT_MAX_LEN ? message.slice(0, SHARED_TEXT_MAX_LEN) : message;
  for (const rule of rules) {
    if (rule.verdict === "non_retryable" && matchRetryRule(truncated, rule)) return rule;
  }
  for (const source of SOURCE_ORDER) {
    for (const rule of rules) {
      if (rule.source !== source) continue;
      if (matchRetryRule(truncated, rule)) return rule;
    }
  }
  return undefined;
}

/**
 * 单输入双侧对拍：同一错误文本喂两侧，断言
 * ① 命中同一条规则（findClassificationRule 返回对象与复算期望恒等——同一数组实例）；
 * ② 结论映射：rewrite ⟺ verdictToRetryable=true；keep(non_retryable_hit) ⟺ false；
 *    keep(conditional_hit) ⟺ 'conditional'；keep(no_rule_match) ⟺ 分类侧 undefined。
 */
function expectClassificationRewriteParity(
  message: string,
  rules: readonly RetryableErrorRule[],
): void {
  const decision = evaluateRetryRules(message, rules);
  const hit = findClassificationRule([message], rules);
  const expected = rewriteSideExpectedHit(message, rules);

  if (expected === undefined) {
    expect(hit).toBeUndefined();
  } else {
    expect(hit).toBe(expected);
  }

  if (decision.action === "rewrite") {
    expect(hit).toBeDefined();
    expect(verdictToRetryable(hit!.verdict)).toBe(true);
    return;
  }
  switch (decision.reason) {
    case "non_retryable_hit":
      expect(hit).toBeDefined();
      expect(verdictToRetryable(hit!.verdict)).toBe(false);
      break;
    case "conditional_hit":
      expect(hit).toBeDefined();
      expect(verdictToRetryable(hit!.verdict)).toBe("conditional");
      break;
    case "no_rule_match":
      expect(hit).toBeUndefined();
      break;
    case "empty_message":
      // 改写侧独有防御（分类侧输入经 classificationMatchInputs 构造恒非空）——
      // 走到此分支说明矩阵混入了空文本，是用例构造错误而非行为漂移。
      throw new Error(
        "parity 矩阵不应包含空文本输入（empty_message 是改写侧独有防御，无分类侧对应语义）",
      );
  }
}

// ============================================================
// RETRY_RULES_BASELINE 内置基线矩阵（实测锚点错误文本，shared 基线注释同源）
// ============================================================

describe("RETRY_RULES_BASELINE 基线矩阵：同一错误文本两侧结论一致", () => {
  // 矩阵输入 = 基线各档实测锚点（shared RETRY_RULES_BASELINE 注释的码表事实），
  // 覆盖 rewrite / conditional / non_retryable / 无命中四类结论 × pattern / jsonPath 双通道。
  const BASELINE_INPUTS = [
    // 智谱业务码（jsonPath 通道）
    '{"error":{"code":"1302"}}',
    '{"error":{"code":"1305"}}',
    '{"code":"1308"}',
    '{"code":"1316"}',
    '{"code":"1309"}',
    '{"code":"1320"}',
    // 通用大类兜底（pattern 通道）
    "HTTP 429 too many requests",
    "503 service unavailable",
    "HTTP 402 payment required",
    "insufficient_quota: out of budget",
    // tier 限额窗口（场景 1）
    "400 tier_limit_exceeded, resets 2026-10-25T12:00:00Z",
    // Kimi（anthropic 信封）
    "engine_overloaded_error",
    "rate_limit_reached_error",
    "exceeded_current_quota_error",
    "504 gateway timeout",
    // opencode 订阅限额（显式排除档）
    "GoUsageLimitError: monthly usage limit reached",
    // RPM 并发限流文本（pi 词表 0 命中形态）
    "rpm limit exceeded",
    // 无命中
    "all systems operational",
    "connection reset by peer",
  ];

  it("每个基线锚点输入：改写侧 action 结论 ≡ 分类侧 verdictToRetryable 判定", () => {
    expect(RETRY_RULES_BASELINE.length).toBeGreaterThan(0);
    for (const message of BASELINE_INPUTS) {
      expectClassificationRewriteParity(message, RETRY_RULES_BASELINE);
    }
  });

  it("矩阵本身有结论覆盖面（rewrite / conditional / non_retryable / 无命中四类齐备——防矩阵退化为单结论空转）", () => {
    const conclusions = BASELINE_INPUTS.map((message) => evaluateRetryRules(message, RETRY_RULES_BASELINE));
    expect(conclusions.some((d) => d.action === "rewrite")).toBe(true);
    expect(conclusions.some((d) => d.action === "keep" && d.reason === "conditional_hit")).toBe(true);
    expect(conclusions.some((d) => d.action === "keep" && d.reason === "non_retryable_hit")).toBe(true);
    expect(conclusions.some((d) => d.action === "keep" && d.reason === "no_rule_match")).toBe(true);
  });
});

// ============================================================
// 两层序自定义矩阵：排除序 / source 序 / jsonPath 算子 / 无效 pattern
// ============================================================

/** 自定义两层序矩阵（source 三层交错 + 同文本多规则竞争命中）。 */
const TWO_LAYER_MATRIX: RetryableErrorRule[] = [
  // custom retryable 与 builtin non_retryable 同命中 → 第一层排除序优先（账户类永不误重试）
  {
    id: "custom-quota-retry",
    name: "custom 可重试（防击穿探针）",
    verdict: "retryable",
    match: [{ kind: "pattern", pattern: "quota block" }],
    class: "provider",
    source: "custom",
  },
  {
    id: "builtin-quota-hard",
    name: "builtin 账户类排除",
    verdict: "non_retryable",
    match: [{ kind: "pattern", pattern: "quota block" }],
    class: "provider",
    source: "builtin",
  },
  // custom conditional 与 builtin retryable 同命中 → 第二层 source 序 custom 优先
  {
    id: "custom-window",
    name: "custom 窗口 conditional",
    verdict: "conditional",
    match: [{ kind: "pattern", pattern: "window reset" }],
    class: "provider",
    source: "custom",
  },
  {
    id: "builtin-window-retry",
    name: "builtin 窗口可重试",
    verdict: "retryable",
    match: [{ kind: "pattern", pattern: "window reset" }],
    class: "provider",
    source: "builtin",
  },
  // custom 未命中时 remote 压过 builtin
  {
    id: "remote-throttle",
    name: "remote 限流 conditional",
    verdict: "conditional",
    match: [{ kind: "pattern", pattern: "remote throttle" }],
    class: "provider",
    source: "remote",
  },
  {
    id: "builtin-throttle",
    name: "builtin 限流可重试",
    verdict: "retryable",
    match: [{ kind: "pattern", pattern: "remote throttle" }],
    class: "provider",
    source: "builtin",
  },
  // jsonPath 通道三算子
  {
    id: "custom-jp-equals",
    name: "custom jsonPath equals",
    verdict: "retryable",
    match: [{ kind: "jsonPath", path: "error.code", operator: "equals", value: "X1" }],
    class: "provider",
    source: "custom",
  },
  {
    id: "custom-jp-contains",
    name: "custom jsonPath contains",
    verdict: "conditional",
    match: [{ kind: "jsonPath", path: "error.type", operator: "contains", value: "limit" }],
    class: "provider",
    source: "custom",
  },
  {
    id: "custom-jp-exists",
    name: "custom jsonPath exists",
    verdict: "non_retryable",
    match: [{ kind: "jsonPath", path: "error.hard_stop", operator: "exists" }],
    class: "provider",
    source: "custom",
  },
  // 无效 pattern（运行时恒不命中通道）
  {
    id: "custom-invalid-pattern",
    name: "custom 非法正则",
    verdict: "retryable",
    match: [{ kind: "pattern", pattern: "([unclosed" }],
    class: "provider",
    source: "custom",
  },
];

describe("两层序自定义矩阵：排除序与 source 序同输入命中同规则", () => {
  const TWO_LAYER_INPUTS = [
    // 第一层排除序：custom retryable 击穿不了一并命中的 builtin non_retryable
    "provider reports quota block",
    // 第二层 source 序：custom conditional 压过 builtin retryable
    "window reset at midnight",
    // remote 层生效（custom 无竞争命中）
    "remote throttle engaged",
    // jsonPath equals（结构化合成文本形态 = classificationMatchInputs 的 JSON.stringify({error})）
    '{"error":{"code":"X1"}}',
    // jsonPath equals 不命中值
    '{"error":{"code":"X2"}}',
    // jsonPath contains
    '{"error":{"type":"rate_limit_error"}}',
    // jsonPath exists（字段在场即命中，值无关）
    '{"error":{"hard_stop":false}}',
    '{"error":{}}',
    // 无效 pattern 恒不命中（两侧同落入无命中，不因非法源分叉）
    "([unclosed",
    // 无命中
    "unrelated failure text",
  ];

  it("每个矩阵输入：改写侧 action 结论 ≡ 分类侧 verdictToRetryable 判定", () => {
    for (const message of TWO_LAYER_INPUTS) {
      expectClassificationRewriteParity(message, TWO_LAYER_MATRIX);
    }
  });

  it("矩阵本身有结论覆盖面（rewrite / conditional / non_retryable / 无命中四类齐备）", () => {
    const conclusions = TWO_LAYER_INPUTS.map((message) => evaluateRetryRules(message, TWO_LAYER_MATRIX));
    expect(conclusions.some((d) => d.action === "rewrite")).toBe(true);
    expect(conclusions.some((d) => d.action === "keep" && d.reason === "conditional_hit")).toBe(true);
    expect(conclusions.some((d) => d.action === "keep" && d.reason === "non_retryable_hit")).toBe(true);
    expect(conclusions.some((d) => d.action === "keep" && d.reason === "no_rule_match")).toBe(true);
  });
});

// ============================================================
// 截断行为一致：超长输入两侧同结论（截断上限漂移 = marker 越界侧不命中）
// ============================================================

describe("超长输入截断行为一致（shared textMaxLen 边界）", () => {
  it("marker 恰在截断点内：两侧同命中；marker 完全越过截断点：两侧同无命中", () => {
    const marker = "rpm limit exceeded";
    const insideMessage = "x".repeat(SHARED_TEXT_MAX_LEN - marker.length) + marker;
    expectClassificationRewriteParity(insideMessage, RETRY_RULES_BASELINE);

    const beyondMessage = "x".repeat(SHARED_TEXT_MAX_LEN) + marker;
    expectClassificationRewriteParity(beyondMessage, RETRY_RULES_BASELINE);
    // 反向锚定：越界形态若不截断本可命中——两侧结论必须是「无命中」而非 rewrite
    const beyondDecision = evaluateRetryRules(beyondMessage, RETRY_RULES_BASELINE);
    expect(beyondDecision).toEqual({ action: "keep", reason: "no_rule_match" });
  });
});

// ============================================================
// verdict → retryable 三态映射行（对拍映射的判据函数本体）
// ============================================================

describe("verdictToRetryable 三态映射（对拍结论映射的判据）", () => {
  it("retryable→true / non_retryable→false / conditional→'conditional'（与 shared 执行语义同词表同义）", () => {
    expect(verdictToRetryable("retryable")).toBe(true);
    expect(verdictToRetryable("non_retryable")).toBe(false);
    expect(verdictToRetryable("conditional")).toBe("conditional");
  });
});
