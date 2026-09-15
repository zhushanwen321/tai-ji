/**
 * Agent options resolver — resolves skill / schema to append-system-prompt
 * content + env vars on every dispatch (BL-1).
 *
 * BL-1：解析 workflow 脚本里 `agent({skill,schema})` 的 inline override，
 * 否则 pi 子进程只收到原始 prompt，没有 --append-system-prompt /
 * --skill / PI_WORKFLOW_SCHEMA。
 *
 * 职责范围（M2 修正）：仅处理 schema SO 指令（内容直传 appendSystemPrompt）+ skill。
 * agent ref 处理（systemPrompt/model/thinkingLevel）已移交 resolveIdentity（execution 层，
 * 经 getAgentConfig + resolveModel 完整覆盖），消除双重注入与 model 层级混乱。
 *
 * 调用方：engine/worker-message-pump.ts dispatchAgentCall（每次 agent-call 消息）。
 * - skill → resolveSkillPath → skillPath（--skill）
 * - schema → 结构化输出指令内容直传 appendSystemPrompt（--append-system-prompt）+ schemaEnv（PI_WORKFLOW_SCHEMA）
 *
 * M2 bug 修正：旧实现把 schema 指令写成临时文件、push 文件路径（而非内容）给下游，
 * 下游 mapper/session-runner 把路径当文本拼进最终 append 文件，导致 schema 指令从未
 * 进入子进程。改为指令内容直传（不写盘、无临时文件）。
 */

import type { AgentCallOpts } from "./models/types.ts";
import { resolveSkillPath } from "./skill-discovery.ts";
import { stringifySchemaCached } from "../shared/schema-jsonify.ts";

export interface ResolveResult {
  opts: AgentCallOpts;
  error?: string;
}

// ── 根类型判定（与 structured-output 同源，本地副本） ──────────────

/** plain object 判定（isPlainObject，与 @zhushanwen/pi-structured-output schema-guards.ts 同语义）。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * [U3 本地副本·同源锚定] 判定权威 schema 的根数据形态是否为 object。
 *
 * 与 @zhushanwen/pi-structured-output `src/execute.ts` 的 `isObjectRootSchema`
 * 逐语义一致（该函数是 structured-output 工具 parameters {value} 包装/解包的唯一
 * 判定源）。两包是独立 npm 包不能直接 import——optional peer 依赖在独立安装场景
 * （pi 用户单独装本包）不保证存在，顶层值 import 会让整个 extension 加载崩溃；
 * 且 builtin esbuild bundle 会把 import 的包内联成双实例（先例：session-runner.ts
 * 的 PI_WORKFLOW_SCHEMA env 契约注释）。故本地复制，任一端改动判定逻辑必须同步
 * 另一端（两端 docstring 互相锚定）。
 *
 * draft-07 语义：无 type 时类型关键字按值形态适用——properties/required 等
 * object 特有关键字的存在意味着作者在描述 object 输出，算 object 根；组合根
 * （anyOf/oneOf/allOf/$ref/enum）可能接受非 object 值，保真起见一律按非 object
 * （{value} 包装可容纳任意成员类型）。
 */
function isObjectRootSchema(schema: unknown): schema is Record<string, unknown> {
  if (!isPlainObject(schema)) return false;
  if (schema.type === "object") return true;
  if (Array.isArray(schema.type) && schema.type.includes("object")) return true;
  const OBJECT_ONLY_KEYS = [
    "properties",
    "required",
    "patternProperties",
    "additionalProperties",
    "minProperties",
    "maxProperties",
    "dependencies",
    "dependentRequired",
    "propertyNames",
  ];
  return OBJECT_ONLY_KEYS.some((k) => k in schema);
}

/**
 * 构造 schema structured-output 指令——resolver 单点注入的唯一文案源。
 *
 * [审查项#2] 消费链：resolveAgentOpts → appendSystemPrompt（ASP 稳定前缀区）。
 * 此前 session-runner 有一份措辞相近的同名函数并把指令拼进 task 末尾，形成
 * ASP + task 双重静态注入；task 后缀已删（task 每 agent 变化不可缓存，工具
 * parameters 是 pi 必然注入的权威展示——注册工具 schema 随每次请求下发进
 * provider 请求体，机制登记 PS-21：pi-ai dist/api/anthropic-messages.js
 * convertTools :1000/:1008 → :1017 input_schema、openai-completions.js :1099
 * parameters——schema 全文不必在 task 重复，文本重复浪费 ~730 tokens/子进程）。
 *
 * [审查项#4] AP 告知：注入侧校验用 additionalProperties:false 收窄后的
 * parameters，模型自带 schema 外字段会被拒——不前置告知，拒绝显得凭空。
 *
 * JSON 序列化用 compact（stringifySchemaCached），与 schemaEnv 复用同串（IF7 #13）。
 */
export function formatSchemaInstruction(schema: Record<string, unknown>): string {
  const schemaJson = stringifySchemaCached(schema, "compact");
  // [U3] 根类型条件化：判定与 structured-output 的工具 parameters {value} 包装/解包
  // 同源（上方 isObjectRootSchema 本地副本）。object 根 arguments 即 data；非 object
  // 根参数层实为 {value} 包装——ASP 文案必须与工具 description 同语汇告知包装契约
  // （{value: <data>} + value. 错误路径前缀），否则模型直传裸值必首调失败。
  const isObjectRoot = isObjectRootSchema(schema);
  const argsContractLine = isObjectRoot
    ? "Your call arguments ARE the result data itself — the tool's parameter schema IS the required shape of your result."
    : "The tool's single argument must be an object `{value: <data>}` — put the result itself in `value`, and it must conform to the schema below. " +
      "Validation errors may reference paths starting with `value.` (e.g. `value.0`, `value.name`): " +
      "that prefix addresses the wrapper, not your data.";
  const rulesCallLine = isObjectRoot
    ? "- Call the structured-output tool with your result data as its arguments. The system validates them against the schema above automatically."
    : "- Call the structured-output tool with `{value: <your result data>}`. The system validates the `value` field against the schema above automatically.";
  // [AP 告知条件化] 根级 additionalProperties 未声明时 D4 注入 false（见
  // structured-output tool-definition）——额外字段恒拒绝，强承诺成立；作者显式声明
  // true / 子 schema 时 injection 侧尊重不动，额外字段按作者声明放行，无条件
  // 「一律拒绝」文案与参数层行为不符（保守方向误导：模型不敢传合法字段）。
  const apLine = schema.additionalProperties === undefined
    ? "- Fields not defined in this schema are rejected — do not add extra fields."
    : "- Extra fields follow this schema's own additionalProperties declaration.";
  return [
    "## MANDATORY: Structured Output Requirement",
    "",
    "This task requires structured output.",
    "Your FINAL action must be calling the `structured-output` tool.",
    "",
    argsContractLine,
    `Your result must conform to this schema:`,
    "```json",
    schemaJson,
    "```",
    "",
    "Rules:",
    rulesCallLine,
    "- Do NOT output JSON in your text response — use the structured-output tool.",
    "- Do NOT skip this step. The structured-output call IS your result.",
    "- Complete all other work FIRST, then call structured-output as the last action.",
    apLine,
  ].join("\n");
}

/**
 * Resolve skill and schema into appendSystemPrompt (content array) + skillPath + schemaEnv.
 *
 * - Skill name -> resolved SKILL.md dir path via --skill
 * - Schema JSON -> structured-output instruction string pushed into appendSystemPrompt
 *   (content, not file path) + PI_WORKFLOW_SCHEMA env
 *
 * Agent ref is intentionally NOT handled here — resolveIdentity (execution layer)
 * covers it via getAgentConfig + resolveModel. Handling agent here would cause
 * double-injection (agentConfig.systemPrompt at session-runner + appendSystemPrompt)
 * and model-tier confusion.
 *
 * Returns the enriched opts.
 */
export function resolveAgentOpts(opts: AgentCallOpts): ResolveResult {
  const appendSystemPrompt: string[] = [];

  // Resolve skill name to SKILL.md path
  if (opts.skill) {
    const skillPath = resolveSkillPath(opts.skill);
    if (!skillPath) {
      return { opts, error: `Skill not found: ${opts.skill}. Searched .agents/skills/ and ~/.pi/agent/skills/` };
    }
    opts = { ...opts, skillPath };
  }

  // Inject schema as structured-output instruction into appendSystemPrompt (content,
  // not temp file) and set environment variable for conditional tool + hook activation.
  // M2 fix: previously wrote the instruction to a temp file and pushed the FILE PATH,
  // which got concatenated into the final append file as path garbage — the SO instruction
  // never reached the subprocess. Now the instruction content is pushed directly.
  if (opts.schema) {
    // IF7(#13)：formatSchemaInstruction 与 schemaEnv 对同一 schema 对象引用共享
    // WeakMap 缓存条目（compact stringify 整个 dispatch 只发生一次）
    appendSystemPrompt.push(formatSchemaInstruction(opts.schema));

    // Set env var for structured-output extension to activate tool + hook
    opts = { ...opts, schemaEnv: stringifySchemaCached(opts.schema, "compact") };
  }

  return {
    opts: { ...opts, ...(appendSystemPrompt.length > 0 ? { appendSystemPrompt } : {}) },
  };
}
