// src/schema-emulation.ts
//
// schema 仿真降级（引擎侧原语，自 core execution/engine/common/schema-emulation.ts
// 迁入 @zhushanwen/subagent-engine-sdk，实现体逐字等价）。迁移处置：无 core 内部
// 依赖 → 直接搬（impl-plan §2.1 原语迁移处置表）。设计权威源：
// docs/architecture/subagent-engine-abstraction.md D4（native/emulated 硬分流）+ §3.3.3
// schema_emulation_failed 行 + §5 P2 行。
//
// ─── D4 硬分流（违反 = 历史事故形态） ───────────────────────────────
// 本模块只服务 capabilities.schemaEnforcement === 'emulated' 的引擎
// （zcode / opencode / kimi-code）。capabilities.schemaEnforcement === 'native' 的引擎
// （pi 的 PI_WORKFLOW_SCHEMA env 注入链路、claude-code --json-schema、codex
// --output-schema）**禁止** import 本模块做二次校验或改写其结果——宿主侧再叠一层
// ajv 会制造第二校验权威，恰是 structured-output 方案 A [HISTORICAL]
// （2026-08-01「校验自报 schema 致修复静默丢失」事故）的形态。
// ajv 只允许出现在 emulated 路径（本模块），这是全仓唯一例外。
//
// 重试语义：本模块两个函数保持纯——校验失败/提取失败由调用方（宿主编排层）决定
// 重试，语义与 structured-output 的 workflow-hook 对齐（重试一次、强化 prompt；
// 仍失败报 schema_emulation_failed，错误含原始输出尾部）。
//
// 文案对齐：错误回显风格对齐 structured-output 的 execute.ts（"Schema validation
// failed: ..."），但不 import 其内部模块（公共层自实现；structured-output 是
// peer 依赖且可选，import 会造成公共层对 sibling extension 的硬依赖）。

import Ajv, { type ValidateFunction } from "ajv";

/** 原始输出尾部回显长度（结果对象的 tail 字段，供错误展示与重试 prompt 回灌）。 */
export const SCHEMA_EMULATION_TAIL_CHARS = 500;

// ============================================================
// prompt 注入段
// ============================================================

/**
 * 构造 prompt 注入段：schema 声明 + 输出格式约定（emulated 引擎的 launcher 把它拼进
 * 最终 prompt，替代引擎不存在的 schema 强制通道）。
 *
 * 文案风格对齐 structured-output 的 promptGuidelines（"Do not output JSON in text"：emulated 引擎没有工具可调，JSON 必须出现在文本里）。
 */
export function buildSchemaEmulationSegment(schema: object): string {
  const schemaJson = JSON.stringify(schema);
  return [
    "## Structured Output Requirement",
    "Your final answer MUST contain exactly one JSON value conforming to this JSON Schema (draft-07):",
    schemaJson,
    "Output rules:",
    "- Output ONLY the JSON value — no prose before or after it.",
    "- If you wrap it in a markdown code fence, use a single ```json fence.",
    "- Do not output multiple JSON values; the first complete JSON value is extracted.",
  ].join("\n");
}

// ============================================================
// 三级容错提取 + ajv 校验
// ============================================================

/** 提取结果联合：ok=true 携带通过校验的 parsed；ok=false 携带 error 简述 + 原始输出尾部。 */
export type StructuredOutputResult =
  | { ok: true; parsed: unknown }
  | { ok: false; error: string; tail: string };

/**
 * 从模型文本输出提取并校验结构化 JSON（三级容错 → ajv）。
 *
 * 三级容错（逐级降级，任一级提取成功即进 ajv）：
 *   1. 直接 JSON.parse（trim 后整体是合法 JSON）；
 *   2. 剥 markdown code fence（```json ... ``` / ``` ... ```）取围栏内内容；
 *   3. 首尾括号扫描（首个 '{'/'[' 到末个 '}'/']' 的子串——容纳前后杂文本）。
 *
 * ajv 校验失败/三级提取失败返回 ok:false（不 throw）——重试与否是宿主编排层的
 * 决策（见文件头重试语义），本函数每次调用独立无状态。
 */
export function extractAndValidateStructuredOutput(
  text: string,
  schema: object,
): { ok: true; parsed: unknown } | { ok: false; error: string; tail: string } {
  return extractImpl(text, schema);
}

/** 实现体（签名拆分只为让导出签名与契约声明逐字一致，见 StructuredOutputResult）。 */
function extractImpl(text: string, schema: object): StructuredOutputResult {
  const tail = text.length > SCHEMA_EMULATION_TAIL_CHARS
    ? text.slice(text.length - SCHEMA_EMULATION_TAIL_CHARS)
    : text;

  const extracted = extractJsonCandidate(text);
  if (extracted === undefined) {
    return {
      ok: false,
      error:
        "could not extract JSON from model output after 3-stage fallback " +
        "(direct parse -> code-fence strip -> bracket scan)",
      tail,
    };
  }

  const validate = getOrCompileValidator(schema);
  if (validate === undefined) {
    return {
      ok: false,
      error: "host-side JSON Schema compilation failed (invalid schema object)",
      tail,
    };
  }

  const valid = validate(extracted);
  if (!valid) {
    // 错误格式对齐 structured-output："instancePath message" 逐条 join
    const errors = validate.errors?.map((err) => `${err.instancePath} ${err.message}`).join("; ");
    return {
      ok: false,
      error: `Schema validation failed: ${errors ?? "(no detail)"}`,
      tail,
    };
  }
  return { ok: true, parsed: extracted };
}

// ── 内部：三级提取 ──────────────────────────────────────────────

/** 三级容错提取 JSON candidate；全部失败返回 undefined。 */
function extractJsonCandidate(text: string): unknown {
  // 第 1 级：整体直接 parse（最常见——严格遵守输出约定的模型）
  const direct = tryParse(text.trim());
  if (direct.ok) return direct.value;

  // 第 2 级：markdown code fence 剥离（模型爱用 ```json 包裹）
  const fenced = extractFirstFencedBlock(text);
  if (fenced !== undefined) {
    const parsed = tryParse(fenced.trim());
    if (parsed.ok) return parsed.value;
  }

  // 第 3 级：首尾括号扫描（前后杂文本："Here is the result: {...} Hope this helps"）
  const scanned = extractByBracketScan(text);
  if (scanned !== undefined) {
    const parsed = tryParse(scanned.trim());
    if (parsed.ok) return parsed.value;
  }

  return undefined;
}

/** JSON.parse 包装：失败返回 ok:false（malformed 不是异常态，是三级降级的输入）。 */
function tryParse(raw: string): { ok: true; value: unknown } | { ok: false } {
  if (raw === "") return { ok: false };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
}

/** 取第一个 markdown code fence 块内容（```json / ``` 均可）；无 fence 返回 undefined。 */
function extractFirstFencedBlock(text: string): string | undefined {
  const match = /```(?:json)?\s*([\s\S]*?)\s*```/.exec(text);
  return match?.[1];
}

/** 首尾括号扫描：首个 '{'/'[' 到末个 '}'/']' 的子串；边界不合法返回 undefined。 */
function extractByBracketScan(text: string): string | undefined {
  const objOpen = text.indexOf("{");
  const arrOpen = text.indexOf("[");
  const open = objOpen === -1 ? arrOpen : arrOpen === -1 ? objOpen : Math.min(objOpen, arrOpen);
  const objClose = text.lastIndexOf("}");
  const arrClose = text.lastIndexOf("]");
  const close = Math.max(objClose, arrClose);
  if (open === -1 || close === -1 || open >= close) return undefined;
  return text.slice(open, close + 1);
}

// ── 内部：ajv 编译缓存 ──────────────────────────────────────────

// WeakMap 缓存（schema 对象引用即 key，GC 友好）——模式对齐 structured-output 的
// ajv-validator.ts（自实现，不跨包 import；见文件头依赖边界说明）。
// CJS 多 entry 内联副本的实例分裂影响 = 缓存 miss 重新编译，无语义后果。
const ajvCache = new WeakMap<object, ValidateFunction>();

/** 编译（或取缓存）validator；schema 非法（ajv 抛错）返回 undefined 由调用方报错。 */
function getOrCompileValidator(schema: object): ValidateFunction | undefined {
  const cached = ajvCache.get(schema);
  if (cached) return cached;
  try {
    // strict:false 对齐 structured-output 的宽容度（非标 keyword 不炸编译）
    const validate = new Ajv({ strict: false }).compile(schema);
    ajvCache.set(schema, validate);
    return validate;
  } catch {
    return undefined;
  }
}
