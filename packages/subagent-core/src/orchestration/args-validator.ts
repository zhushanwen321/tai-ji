// src/orchestration/args-validator.ts
//
// m3：参数校验单一 chokepoint（IF3 validateRunArgs + IF4 ArgsValidationError）。
// lifecycle.runWorkflow 首行调用——§5.3 fail-fast：参数错误在 worker 启动前返回，
// 带「read 脚本重看」指引。
//
// 设计决策（m3 design-review 探针实证）：
// - ajv 选项固定为 { coerceTypes:true, strictSchema:false, allErrors:true, useDefaults:false }：
//   coerceTypes 原地规范化弱 LLM 的字符串参数（'false'→false、'10'→10，m2 MAJOR-1 闭环）；
//   strictSchema:false 容忍用户 workflow 的自定义关键字/format（默认 strict:true 会误判畸形）；
//   useDefaults:false 不注入 schema default（脚本 fallback 语义不变）。
// - 无缓存：ajv.compile 实测 0.006ms/次（[P-compile]），v5 §6.5 的 Map 缓存被探针证据推翻。
// - null-scan + required 空串复查：coerceTypes 下 {target:null} 会被 coerce 成 "" 放行
//   required（required 只查属性存在性）——null 视为缺失、必填字符串空串视为失败，
//   与 review-fix-loop 脚本的 !target 语义对齐，保住「启动前 fail-fast」承诺。

import Ajv from "ajv";

import type { RunSpec } from "./models/run-spec.ts";

/** 参数校验失败（§5.3）。三调用方各自 catch 并映射到返回类型。 */
export class ArgsValidationError extends Error {
  readonly workflowName: string;
  /** ajv 校验错误数组（畸形 schema 时为 undefined）。 */
  readonly errors?: readonly unknown[];

  constructor(workflowName: string, message: string, errors?: readonly unknown[]) {
    super(message);
    this.name = "ArgsValidationError";
    this.workflowName = workflowName;
    this.errors = errors;
  }
}

const ajv = new Ajv({
  coerceTypes: true,
  strictSchema: false,
  allErrors: true,
  useDefaults: false,
});

/** §5.3 错误文案：workflow 名 + errors 摘要 + info 指引。 */
function formatMessage(name: string, errors: readonly unknown[]): string {
  const lines = errors.map((e) => {
    let path = "/";
    let msg = "invalid";
    if (e !== null && typeof e === "object") {
      const err = e as Record<string, unknown>;
      if (typeof err.instancePath === "string" && err.instancePath) path = err.instancePath;
      if (typeof err.message === "string") msg = err.message;
    }
    return `- ${path}: ${msg}`;
  });
  return (
    `Invalid args for workflow '${name}': ${errors.length} error(s)\n` +
    `${lines.join("\n")}\n` +
    `Read the workflow script file (location from <available_workflows>) for the parameter schema and usage.`
  );
}

// ── validateRunArgs 阶段 helper（按 预处理/编译 提取，主函数只留编排） ────

/** schema.properties 提取（畸形/缺失 → {}，null-scan 在空 properties 上安全退化）。 */
function extractSchemaProperties(schema: Record<string, unknown>): Record<string, unknown> {
  return schema.properties !== null && typeof schema.properties === "object"
    ? (schema.properties as Record<string, unknown>)
    : {};
}

/** 单个 property 声明是否 nullable（type 含 "null" 或 type === "null"）。 */
function isNullableProp(prop: unknown): boolean {
  if (prop === null || typeof prop !== "object") return false;
  const propType = (prop as Record<string, unknown>).type;
  return Array.isArray(propType)
    ? (propType as unknown[]).includes("null")
    : propType === "null";
}

/**
 * null-scan：null 值视为缺失（coerceTypes 会把 null→"" 放行 required，绕过 fail-fast）。
 * 只删 schema 未声明 nullable 的键——type 含 "null"（如 ["string","null"]）的合法 null
 * 输入保留（m3 exec-review M1 探针实证：全键删除会拒掉 nullable required 的合法值）。
 */
function deleteNonNullableNullArgs(
  args: Record<string, unknown>,
  schema: Record<string, unknown>,
): void {
  const properties = extractSchemaProperties(schema);
  for (const key of Object.keys(args)) {
    if (args[key] !== null) continue;
    if (!isNullableProp(properties[key])) delete args[key];
  }
}

/** ajv 编译（畸形 schema → 结构化 ArgsValidationError，不泄漏原始 throw）。 */
function compileSchema(
  parameters: Record<string, unknown>,
  scriptName: string,
): ReturnType<Ajv["compile"]> {
  try {
    return ajv.compile(parameters);
  } catch (err) {
    // 真畸形 schema（如 type:'not-a-type'）→ 结构化 ArgsValidationError，不泄漏原始 throw
    const detail = err instanceof Error ? err.message : String(err);
    throw new ArgsValidationError(
      scriptName,
      `Workflow '${scriptName}' has an invalid parameter schema: ${detail}. Read the workflow script file (location from <available_workflows>) to inspect it.`,
    );
  }
}

// ── 旧格式迁移指引（按包内自带模板名登记，当前仅 fan-out）────────────────
//
// fan-out 把成员参数对象化（tasks 元素 = 成员对象 {task, agent?, model?, thinkingLevel?}，
// 顶层 agents 参数删除）后，按旧格式形状（tasks 字符串数组 / 顶层 agents 键）新派的
// args 会被 ajv 拒，但 ajv 文案只有 schema 语义（"must be object" /
// "must NOT have additional properties"），模型无从识别「这是旧格式形状而非随手写错」
// ——补专属迁移文案，与 fan-out.js 内 scriptPath 旧格式文案同构：命名旧形状、给迁移
// 映射（agents 逗号串 → 逐成员 agent）与恢复动作（按旧 tasks 内容重派成员对象新 run）。
// 登记收敛在包内自带模板名上，不发明第三方 workflow 的文案；本表只附加迁移指引，
// 不改变拒绝判定（schema 仍是类型校验唯一权威——命中与否都以 ajv 已拒绝为前提）。
function legacyArgsAdvisory(scriptName: string, args: Record<string, unknown>): string | undefined {
  if (scriptName !== "fan-out") return undefined;
  const tasks: unknown = args.tasks;
  const stringTasks = Array.isArray(tasks) && tasks.some((t) => typeof t === "string");
  const agentsKey = args.agents !== undefined;
  if (!stringTasks && !agentsKey) return undefined;
  const shapes = [
    ...(stringTasks ? ['"tasks" elements are plain strings'] : []),
    ...(agentsKey ? ['top-level "agents" key present'] : []),
  ].join(" and ");
  return (
    `Legacy args shape detected (${shapes}) — this shape predates the member-object parameter ` +
    "format of this workflow. " +
    "Migration: one member object per task (task required; agent/model/thinkingLevel optional " +
    'per-member overrides; a legacy agents="/a.md,/b.md" maps to agent on each member in the same order). ' +
    "Recovery: re-dispatch a NEW run with member-object tasks. " +
    'Correct: {"tasks":[{"task":"task one","agent":"/a/one.md"},{"task":"task two"}]}'
  );
}

/**
 * 校验 spec.parameters（JSON Schema draft-07）对 spec.args 的约束。
 *
 * - spec.parameters === undefined → 跳过（安全退化：漏拷 parameters 退化是「不校验」非「校验错」）
 * - coerceTypes 原地规范化 spec.args（worker 启动 + 崩溃重建重跑共用同一对象，
 *   run.spec === spec，保证重跑路径参数一致）
 * - 失败 throw ArgsValidationError（非原始 ajv 错误）
 *
 * @throws ArgsValidationError 参数不合法或 schema 无效
 */
export function validateRunArgs(spec: RunSpec): void {
  const { parameters, args, scriptName } = spec;
  if (parameters === undefined) return;

  if (parameters === null || typeof parameters !== "object" || Array.isArray(parameters)) {
    throw new ArgsValidationError(
      scriptName,
      `Workflow '${scriptName}' has an invalid parameter schema (expected object). Read the workflow script file (location from <available_workflows>) to inspect it.`,
    );
  }

  deleteNonNullableNullArgs(args, parameters);

  const validate = compileSchema(parameters, scriptName);

  if (!validate(args)) {
    const base = formatMessage(scriptName, validate.errors ?? []);
    const legacy = legacyArgsAdvisory(scriptName, args);
    throw new ArgsValidationError(
      scriptName,
      legacy !== undefined ? `${base}\n${legacy}` : base,
      validate.errors ?? undefined,
    );
  }
  // 注：非空约束由 schema 声明（minLength/pattern），chokepoint 不发明约束——
  // m3 exec-review M2：硬编码 trim 空串复查与 schema 显式语义（enum 含 ''/minLength:0）
  // 矛盾。review-fix-loop 的 target 用 { minLength: 1, pattern: '\\S' } 表达。
  // 校验失败时 spec.args 可能已被 null-scan/coerce 部分 mutate（文档化行为：失败后
  // 调用方不应复用该 args 对象）。
}
