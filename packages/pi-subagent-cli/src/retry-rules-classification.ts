// src/retry-rules-classification.ts
//
// [subagent-observability §3.3.2/§3.3.12] 失败分类的分类码表消费侧：读 retry-rules
// ext-config（<piAgentDir>/config/retry-rules-ext-config.json）的 effectiveRules 段并对
// 收尾边沿错误事实做规则匹配——分类与 message_end 改写判定（retry-rules extension）是
// 同一份 remote-config 数据的两个消费方，runtime 是该文件唯一写方。
//
// 语义 SSOT = packages/shared/src/retry-rules.ts（匹配/两层序/词表）；本包不依赖
// shared 契约包，此处是行为镜像实现（extension 侧复制体同款惯例：结构类型本地声明，
// 漂移以 shared 为准，output-collector.test.ts 锁行为一致）。kind 值域权威 =
// @zhushanwen/subagent-engine-sdk FAILURE_CAUSE_KINDS_BY_CLASS。

import { readFileSync } from "node:fs";
import * as path from "node:path";

import { resolvePiAgentDir } from "./engine-query.ts";
import type { EngineRoundErrorFact } from "./spawn-event-translator.ts";

/**
 * 规则条目的分类消费面（ext-config effectiveRules 元素的本地结构声明）。
 */
export interface RetryRuleClassificationView { // oe-exempt:20261024:framework:ext-config effectiveRules 的分类消费面本地视图（与 shared RetryableErrorRule 镜像解耦，字段面更窄——只收分类所需；单实现常态）
  verdict: "retryable" | "non_retryable" | "conditional";
  class: "provider" | "harness" | "agent" | "engine" | "user";
  /** FailureCause kind 细分（可选；缺省按 class+verdict 推导表落，见 deriveKindForRule）。 */
  kind?: string;
  match: RetryRuleMatchCondition[];
  source: "custom" | "remote" | "builtin";
}

/** 单条匹配条件（pattern 对文本正则 / jsonPath 从 errorMessage JSON 片段取值比较——双通道语义镜像 shared RetryRuleMatch）。 */
export type RetryRuleMatchCondition =
  | { kind: "pattern"; pattern: string }
  | { kind: "jsonPath"; path: string; operator: "equals" | "contains" | "exists"; value?: string };

/** per-class kind 合法值域（值副本；权威 = sdk FAILURE_CAUSE_KINDS_BY_CLASS，镜像 shared RETRY_RULE_KINDS_BY_CLASS）。 */
const KINDS_BY_CLASS: Readonly<Record<string, readonly string[]>> = {
  provider: ["rate_limited", "protocol_unsupported"],
  harness: ["turn_budget_exhausted", "timeout"],
  agent: ["no_deliverable"],
  user: ["cancelled"],
};

/** verdict 三态字面（与 shared RETRY_RULE_VERDICTS 同源）。 */
const RULE_VERDICTS: readonly string[] = ["retryable", "non_retryable", "conditional"];
/** source 三态字面（判定第二层排序键：custom > remote > builtin）。 */
const RULE_SOURCES: readonly string[] = ["custom", "remote", "builtin"];

/** ext-config 文件相对路径（与 runtime 写侧 RETRY_RULES_CONFIG_REL / retry-rules extension 读侧 getConfigPath('retry-rules') 同一公式：<piAgentDir>/config/retry-rules-ext-config.json）。 */
const RETRY_RULES_CONFIG_REL = path.join("config", "retry-rules-ext-config.json");

/** 匹配输入截断上限（镜像 shared RETRY_RULES_DOMAIN.textMaxLen——封顶单次判定成本）。 */
const RETRY_RULES_TEXT_MAX_LEN = 8192;

/**
 * 读 ext-config 的 effectiveRules 段供失败分类消费。
 *
 * 读取时机 = 失败分类（低频路径，一次读盘直读不缓存——轮失败才走到，成本可忽略；
 * remote 刷新在下一失败轮即生效）。安全缺省：文件缺失/坏 JSON/形状非法 → undefined
 * （回落内置 HTTP 语义层 + 兜底文案，不产假分类）；条目级窄化不过 → 跳过该条
 * （绕过写入侧校验的直改文件形态不猜）。
 */
export function loadRetryRulesForClassification(
  env: NodeJS.ProcessEnv = process.env,
): readonly RetryRuleClassificationView[] | undefined {
  const filePath = path.join(resolvePiAgentDir(env), RETRY_RULES_CONFIG_REL);
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  if (record["version"] !== 1 || !Array.isArray(record["effectiveRules"])) return undefined;
  const rules: RetryRuleClassificationView[] = [];
  for (const entry of record["effectiveRules"]) {
    const narrowed = narrowClassificationRule(entry);
    if (narrowed !== undefined) rules.push(narrowed);
  }
  return rules;
}

/** class 五值字面（FailureCause class 词表，与 KINDS_BY_CLASS 键域同源）。 */
const RULE_CLASS_VALUES: readonly string[] = ["provider", "harness", "agent", "engine", "user"];

/** 单条规则窄化（字段级防御式读取：关键字段合法才收；kind 提供但词表外 = 整条跳过）。 */
function narrowClassificationRule(entry: unknown): RetryRuleClassificationView | undefined {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return undefined;
  const r = entry as Record<string, unknown>;
  const header = narrowRuleHeader(r);
  if (header === undefined) return undefined;
  const match = narrowMatchConditions(r["match"]);
  if (match === undefined) return undefined;
  const kind = narrowRuleKind(r);
  if (kind === undefined) return undefined;
  return { ...header, match, ...kind };
}

/** 头三字段（verdict/class/source）窄化；任一越词表 → undefined（整条跳过）。 */
function narrowRuleHeader(
  r: Record<string, unknown>,
): Pick<RetryRuleClassificationView, "verdict" | "class" | "source"> | undefined {
  if (
    typeof r["verdict"] !== "string" ||
    !RULE_VERDICTS.includes(r["verdict"]) ||
    typeof r["class"] !== "string" ||
    !RULE_CLASS_VALUES.includes(r["class"]) ||
    typeof r["source"] !== "string" ||
    !RULE_SOURCES.includes(r["source"])
  ) {
    return undefined;
  }
  return {
    verdict: r["verdict"] as RetryRuleClassificationView["verdict"],
    class: r["class"] as RetryRuleClassificationView["class"],
    source: r["source"] as RetryRuleClassificationView["source"],
  };
}

/** match[] 窄化：逐条条件合法才收；任一条非法 → undefined（整条跳过）。 */
function narrowMatchConditions(match: unknown): RetryRuleMatchCondition[] | undefined {
  if (!Array.isArray(match)) return undefined;
  const conditions: RetryRuleMatchCondition[] = [];
  for (const condition of match) {
    const narrowed = narrowMatchCondition(condition);
    if (narrowed === undefined) return undefined;
    conditions.push(narrowed);
  }
  return conditions;
}

/** 单条匹配条件窄化（pattern / jsonPath 双通道；通道不符 → undefined）。 */
function narrowMatchCondition(condition: unknown): RetryRuleMatchCondition | undefined {
  if (typeof condition !== "object" || condition === null) return undefined;
  const c = condition as Record<string, unknown>;
  if (c["kind"] === "pattern") {
    return typeof c["pattern"] === "string" ? { kind: "pattern", pattern: c["pattern"] } : undefined;
  }
  if (
    c["kind"] === "jsonPath" &&
    typeof c["path"] === "string" &&
    (c["operator"] === "equals" || c["operator"] === "contains" || c["operator"] === "exists")
  ) {
    return {
      kind: "jsonPath",
      path: c["path"],
      operator: c["operator"],
      ...(typeof c["value"] === "string" ? { value: c["value"] } : {}),
    };
  }
  return undefined;
}

/**
 * kind 字段窄化：未提供 → 空对象（结果不带 kind 字段）；提供且词表内 → { kind }；
 * 提供但词表外（engine 开放前缀面 / per-class 词表外 / 非字符串）→ undefined（整条跳过）。
 */
function narrowRuleKind(r: Record<string, unknown>): { kind?: string } | undefined {
  const kind = r["kind"];
  if (kind === undefined) return {};
  if (typeof kind !== "string") return undefined;
  if (r["class"] === "engine") {
    return kind.startsWith("engine_") ? { kind } : undefined;
  }
  return KINDS_BY_CLASS[r["class"] as string]?.includes(kind) ? { kind } : undefined;
}

/** JSON 片段提取：文本中首个 `{` 起的括号平衡段（字符串字面量感知——引号内的括号不计深度）；无平衡段返回 null（镜像 shared extractJsonSegment）。 */
function extractJsonSegment(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** 点路径取值（`error.code` / `errors.0.type`）；任一层缺失返回 undefined（镜像 shared readJsonPath）。 */
function readJsonPath(root: unknown, pathExpr: string): unknown {
  let current: unknown = root;
  for (const segment of pathExpr.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** 单条匹配条件判定（镜像 shared matchesCondition：pattern 无效源恒不命中；jsonPath 双通道）。 */
function matchesCondition(text: string, condition: RetryRuleMatchCondition): boolean {
  if (condition.kind === "pattern") {
    try {
      return new RegExp(condition.pattern, "i").test(text);
    } catch {
      return false;
    }
  }
  const segment = extractJsonSegment(text);
  if (segment === null) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(segment);
  } catch {
    return false;
  }
  const actual = readJsonPath(parsed, condition.path);
  if (condition.operator === "exists") return actual !== undefined;
  if (actual === undefined || actual === null) return false;
  const actualText = typeof actual === "string" ? actual : JSON.stringify(actual);
  if (condition.operator === "equals") return actualText === condition.value;
  return actualText.includes(condition.value ?? "");
}

/** 单条规则判定：match[] 全部命中才算命中（AND；输入文本已截断）。 */
function matchRuleOnText(text: string, rule: RetryRuleClassificationView): boolean {
  const truncated = text.length > RETRY_RULES_TEXT_MAX_LEN ? text.slice(0, RETRY_RULES_TEXT_MAX_LEN) : text;
  return rule.match.every((condition) => matchesCondition(truncated, condition));
}

/**
 * 分类匹配（两层序，镜像 shared evaluateRetryRules 的序——同一输入两侧命中同一规则，
 * 分类 retryable 值 ≡ 改写判定结论）：每个匹配输入按 ①non_retryable 排除序（先排除
 * 再放行，账户类错误永不误判可重试）→ ②source 序 custom > remote > builtin 遍历，
 * 首个命中规则即断。
 */
export function findClassificationRule(
  inputs: readonly string[],
  rules: readonly RetryRuleClassificationView[],
): RetryRuleClassificationView | undefined {
  for (const text of inputs) {
    for (const rule of rules) {
      if (rule.verdict === "non_retryable" && matchRuleOnText(text, rule)) return rule;
    }
    for (const source of RULE_SOURCES) {
      for (const rule of rules) {
        if (rule.source !== source) continue;
        if (matchRuleOnText(text, rule)) return rule;
      }
    }
  }
  return undefined;
}

/**
 * [§3.3.2 分类输入结构化优先] 匹配输入构造：结构化合成文本在前、errorMessage 文本
 * 在后（文本匹配降为兜底）。结构化源 = EngineRoundErrorFact.diagnostics（pi
 * AssistantMessage.diagnostics 原样，AssistantMessageDiagnostic[]：{type, error?:
 * {name?, message, code?}, details?}）——首个携带 error 的诊断合成 `{"error":{...}}`
 * JSON 文本，jsonPath 通道（error.code）可直接命中码表匹配键。
 */
export function classificationMatchInputs(fact: EngineRoundErrorFact): string[] {
  const inputs: string[] = [];
  const diagnostics: unknown = fact.diagnostics;
  if (Array.isArray(diagnostics)) {
    for (const diagnostic of diagnostics) {
      if (typeof diagnostic !== "object" || diagnostic === null) continue;
      const error = (diagnostic as Record<string, unknown>)["error"];
      if (typeof error !== "object" || error === null) continue;
      inputs.push(JSON.stringify({ error }));
      break;
    }
  }
  inputs.push(fact.errorMessage);
  return inputs;
}

/**
 * kind 缺省推导表（规则未登记 kind 时的显式缺省——只在 class+verdict 组合无歧义时
 * 推导；harness 双值（turn_budget_exhausted/timeout）与 engine 开放前缀面不推导，
 * 该类规则未登记 kind 时对分类侧不生效（不猜）。provider 语义界：可重试/条件恢复的
 * provider 错误 = 限流族（protocol_unsupported 的定义就是重发必败）。
 */
export function deriveKindForRule(rule: RetryRuleClassificationView): string | undefined {
  if (rule.kind !== undefined) return rule.kind;
  if (rule.class === "provider") {
    return rule.verdict === "non_retryable" ? "protocol_unsupported" : "rate_limited";
  }
  if (rule.class === "agent") return "no_deliverable";
  if (rule.class === "user") return "cancelled";
  return undefined;
}

/** verdict → retryable 三态映射（与 §3.3.2 FailureRetryability / §3.3.12 verdict 同词表同义）。 */
export function verdictToRetryable(verdict: RetryRuleClassificationView["verdict"]): true | false | "conditional" {
  if (verdict === "retryable") return true;
  if (verdict === "non_retryable") return false;
  return "conditional";
}
