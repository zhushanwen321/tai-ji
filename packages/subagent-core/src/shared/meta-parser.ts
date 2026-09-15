/**
 * Meta Parser — 资源元数据统一解析器（v5 §4.2 / IF1 + IF2）
 *
 * 两个变体，职责分离（R8-F1：discovery 的 fail-safe null 与 generate 的 linePos 需求互斥，
 * 单一函数无法兼顾）：
 * - parseResourceMeta（IF1，discovery 用）：fail-safe，任何失败返 null，不抛。
 *   供 config-loader / registry / 两 injector / agent-registry 调用（4 parser 收敛为 1）。
 * - parseResourceMetaDetailed（IF2，generate 闭环用）：失败返 {ok:false, error, linePos}，
 *   linePos 取自 eemeli/yaml YAMLParseError.linePos[0]（[P-yaml] 探针实测：
 *   e.linePos 是 [start,end] 数组，取 [0] 作起止点），供 actionGenerate 报行列给 LLM 自纠正。
 *
 * 格式（v5 §7 / DM4）：
 * - workflow (.js)：块注释 `/* @pi-meta <YAML> * /`（单星，非 JSDoc），WORKFLOW_META_RE 提取。
 * - agent (.md)：frontmatter `--- <YAML> ---`，FRONTMATTER_RE 提取。
 * - 无 legacy fallback（D1）：const meta 旧格式 → extractBlock 取不到块 → null。
 *
 * [P-yaml] 探针已验证：eemeli/yaml 2.9.0 的 YAMLParseError.linePos = [{line,col},{line,col}]。
 *
 * exec-review 修复（major-1 + minor-2..8）：
 * - 正则闭合符（星斜杠）必须独占行首，防止 YAML 正文里中途出现的星斜杠（如 usage 块标量
 *   或 patternProperties 正则）截断块致 parameters 等字段静默丢失（§2.3 failure-A 同形态）。
 * - typecheckMeta 严格化：kind 专属字段不可串类（workflow 不许 examples、agent 不许 phases），
 *   description 必填，phase detail 非字符串/parameters 非对象均 reject（消除「静默丢弃非法字段」）。
 * - 区分「未找到块」(undefined) 与「块为空」("")，IF2 给可操作错误。
 * - FRONTMATTER_RE 兼容 CRLF。
 *
 * 层归属：shared（L2 统一解析器）。
 */

import { parse as parseYaml } from "yaml";

import type {
  AgentMeta,
  ResourceKind,
  ResourceMeta,
  RoutingExample,
  WorkflowMeta,
} from "./resource-meta.ts";

// ── 格式提取正则 ──────────────────────────────────────────────

/**
 * workflow @pi-meta 块注释：单星块注释（非 JSDoc `/**`），内容为 YAML。
 * 闭合符（星斜杠）必须独占行首、列 0——防止 YAML 正文里中途出现的星斜杠（如 usage 块标量
 * 内的 see-星斜杠-for、或 patternProperties 正则含星后接斜杠）截断块致后续字段静默丢失（major-1）。
 * 格式规范要求闭合符在列 0（v5 §7），故列 0 闭合不损失合法用例。
 */
const WORKFLOW_META_RE = /\/\*\s*@pi-meta\s*\n([\s\S]*?)\n\*\//;

/** agent frontmatter：标准 YAML frontmatter，兼容 CRLF（minor-7）。 */
const FRONTMATTER_RE = /---\r?\n([\s\S]*?)\r?\n---/;

/**
 * 按资源种类取 meta 块文本（YAML 体）。
 * @returns 未匹配返 undefined；匹配返字符串（可能为空 ""）——调用方据 undefined 区分「未找到」。
 */
function extractBlock(content: string, kind: ResourceKind): string | undefined {
  const re = kind === "workflow" ? WORKFLOW_META_RE : FRONTMATTER_RE;
  return re.exec(content)?.[1];
}

// ── 类型校验（手写，非 ajv；meta 结构简单）──────────────────

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}
function isString(v: unknown): v is string {
  return typeof v === "string";
}
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * 把 parseYaml 结果（unknown）校验为类型化 ResourceMeta，失败返 null（语义非法，非语法错）。
 * 严格化（exec-review minor-2..5）：kind 专属字段不可串类、description 必填、
 * phase detail 非字符串/parameters 非对象均 reject（消除「静默丢弃非法字段」）。
 *
 * 结构（行为保持提取，主函数只留公共校验 + kind 分派；各分支校验顺序不可调换）：
 * workflow → typecheckWorkflowMeta（串类 → phases → parameters）；
 * agent → typecheckAgentMeta（串类 → examples → tools → model/engine → maxTurns → disallowedTools → skills）。
 */
function typecheckMeta(raw: unknown, kind: ResourceKind): ResourceMeta | null {
  if (!isPlainObject(raw)) return null;
  const o = raw;

  // 公共必填：name 非空字符串、description 必须是字符串（minor-3：缺 description reject）
  if (!isNonEmptyString(o.name)) return null;
  if (!isString(o.description)) return null;
  const when = isString(o.when) ? o.when : undefined;
  const notFor = isString(o.notFor) ? o.notFor : undefined;

  if (kind === "workflow") {
    return typecheckWorkflowMeta(o, o.name, o.description, when, notFor);
  }
  return typecheckAgentMeta(o, o.name, o.description, when, notFor);
}

/** minor-2 串类守卫（workflow 分支）：agent 专属字段任一出现 → reject。 */
function hasAgentOnlyFields(o: Record<string, unknown>): boolean {
  return (
    o.examples !== undefined || o.tools !== undefined || o.model !== undefined
    || o.engine !== undefined || o.maxTurns !== undefined
    || o.disallowedTools !== undefined || o.skills !== undefined
  );
}

/** minor-2 串类守卫（agent 分支）：workflow 专属字段任一出现 → reject。 */
function hasWorkflowOnlyFields(o: Record<string, unknown>): boolean {
  return o.phases !== undefined || o.parameters !== undefined || o.usage !== undefined;
}

/**
 * phases 元素校验（string | {title:string, detail?:string}）：合法元素逐个投影，
 * 任一非法 → null。
 * minor-4：detail 存在但非字符串 → reject（不再静默丢弃）。
 */
function typecheckPhases(rawPhases: unknown[]): WorkflowMeta["phases"] | null {
  const phases: WorkflowMeta["phases"] = [];
  for (const p of rawPhases) {
    if (isString(p)) {
      phases.push(p);
    } else if (isPlainObject(p) && isNonEmptyString(p.title)) {
      if (p.detail !== undefined && !isString(p.detail)) return null;
      phases.push(isString(p.detail) ? { title: p.title, detail: p.detail } : { title: p.title });
    } else {
      return null;
    }
  }
  return phases;
}

/** workflow meta 组装（校验全过后的纯投影——可选字段缺席不进键）。 */
function buildWorkflowMeta(
  name: string,
  description: string,
  phases: WorkflowMeta["phases"],
  parameters: Record<string, unknown> | undefined,
  usage: string | undefined,
  when: string | undefined,
  notFor: string | undefined,
): WorkflowMeta {
  return {
    kind: "workflow",
    name,
    description,
    phases,
    ...(parameters !== undefined ? { parameters } : {}),
    ...(usage !== undefined ? { usage } : {}),
    ...(when !== undefined ? { when } : {}),
    ...(notFor !== undefined ? { notFor } : {}),
  };
}

/** workflow 分支校验（顺序 = 串类 → phases → parameters；usage 宽容投影）。 */
function typecheckWorkflowMeta(
  o: Record<string, unknown>,
  name: string,
  description: string,
  when: string | undefined,
  notFor: string | undefined,
): WorkflowMeta | null {
  // minor-2：agent 专属字段不可出现在 workflow（串类 reject）
  if (hasAgentOnlyFields(o)) return null;
  // phases 必填数组，元素为 string | {title:string, detail?:string}
  const rawPhases = o.phases;
  if (!Array.isArray(rawPhases)) return null;
  const phases = typecheckPhases(rawPhases);
  if (phases === null) return null;
  // minor-5：parameters 存在但非 plain object → reject（不再静默当 undefined）
  const parameters = o.parameters;
  if (parameters !== undefined && !isPlainObject(parameters)) return null;
  const usage = isString(o.usage) ? o.usage : undefined;
  return buildWorkflowMeta(name, description, phases, parameters, usage, when, notFor);
}

/**
 * examples 校验三态：undefined → 缺席（不进 meta）；非数组 → null；
 * 元素须为 {match: string, action: string, positive: boolean}，任一非法 → null。
 */
function typecheckExamples(raw: unknown): RoutingExample[] | null | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return null;
  const exs: RoutingExample[] = [];
  for (const e of raw) {
    if (
      isPlainObject(e) &&
      isString(e.match) &&
      isString(e.action) &&
      typeof e.positive === "boolean"
    ) {
      exs.push({ match: e.match, action: e.action, positive: e.positive });
    } else {
      return null;
    }
  }
  return exs;
}

/**
 * maxTurns 校验三态：undefined → 缺席；非 number 或非有限值（NaN/Infinity）→ null；
 * 合法 number 原样投影。
 */
function typecheckMaxTurns(raw: unknown): number | null | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  return raw;
}

/** agent meta 组装（校验全过后的纯投影——可选字段缺席不进键）。 */
function buildAgentMeta(
  name: string,
  description: string,
  examples: RoutingExample[] | undefined,
  tools: string[] | undefined,
  model: string | undefined,
  engine: string | undefined,
  maxTurns: number | undefined,
  disallowedTools: string[] | undefined,
  skills: string[] | undefined,
  when: string | undefined,
  notFor: string | undefined,
): AgentMeta {
  return {
    kind: "agent",
    name,
    description,
    ...(examples !== undefined ? { examples } : {}),
    ...(tools !== undefined ? { tools } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(engine !== undefined ? { engine } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    ...(disallowedTools !== undefined ? { disallowedTools } : {}),
    ...(skills !== undefined ? { skills } : {}),
    ...(when !== undefined ? { when } : {}),
    ...(notFor !== undefined ? { notFor } : {}),
  };
}

/** agent 分支校验（顺序 = 串类 → examples → tools → model/engine → maxTurns → disallowedTools → skills）。 */
function typecheckAgentMeta(
  o: Record<string, unknown>,
  name: string,
  description: string,
  when: string | undefined,
  notFor: string | undefined,
): AgentMeta | null {
  // minor-2：workflow 专属字段不可出现在 agent（串类 reject）
  if (hasWorkflowOnlyFields(o)) return null;
  const examples = typecheckExamples(o.examples);
  if (examples === null) return null;
  // tools 三态经 parseStringListField（数组逐元素 string / 逗号分隔字符串 / 非法形态 → null）
  const tools = parseStringListField(o.tools);
  if (tools === null) return null;
  const model = isString(o.model) ? o.model : undefined;
  const engine = isString(o.engine) ? o.engine : undefined;
  // D3 可选执行字段（maxTurns/disallowedTools/skills）：与 tools 同风格投影
  // （空数组 [] 同 tools 保留键——列表字段族空列表语义一致）。严格层对非法类型
  // reject（minor-2..5 既有精神：不静默丢弃非法字段）——宽容降级是
  // parseAgentProfile（agent-registry）的职责，不在本严格层。
  const maxTurns = typecheckMaxTurns(o.maxTurns);
  if (maxTurns === null) return null;
  const disallowedTools = parseStringListField(o.disallowedTools);
  if (disallowedTools === null) return null;
  const skills = parseStringListField(o.skills);
  if (skills === null) return null;
  return buildAgentMeta(name, description, examples, tools, model, engine, maxTurns, disallowedTools, skills, when, notFor);
}

/**
 * 字符串列表字段解析（tools 先例的泛化）：数组形态逐元素校验 string，空数组保留
 * 为 []（键进 meta——与 tools 数组形态 `tools: []` 语义一致，列表字段族同语义）；
 * 逗号分隔字符串按 `tools: read, bash` 约定拆分 trim，全空串（`skills: ,`）视同
 * 缺席；字段缺席 → undefined（不进 meta）；非法形态（数字/对象/数组含非字符串）
 * → null（调用方 reject——minor-2..5 既有精神：非法字段显式拒绝，不静默丢弃）。
 * 三态返回是为区分「缺席」与「非法」。
 */
function parseStringListField(raw: unknown): string[] | null | undefined {
  if (raw === undefined) return undefined;
  if (Array.isArray(raw)) {
    if (!raw.every(isString)) return null;
    return raw as string[];
  }
  if (isString(raw)) {
    const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
    return parts.length > 0 ? parts : undefined;
  }
  return null;
}

// ── IF1: parseResourceMeta（discovery，fail-safe null）─────────────────

/**
 * 统一 meta 解析入口（discovery 用）。仅认新格式，无 legacy fallback。
 * 任何失败（缺块 / YAML 语法错 / 类型校验失败）→ return null（不抛）。
 * discovery fail-safe：单文件解析失败仅让该资源 available=false，不阻塞其他资源。
 */
export function parseResourceMeta(
  content: string,
  kind: ResourceKind,
): ResourceMeta | null {
  const block = extractBlock(content, kind);
  if (block === undefined) return null;
  try {
    const raw = parseYaml(block);
    return typecheckMeta(raw, kind);
  } catch {
    return null;
  }
}

/** 从 eemeli/yaml 拋错提取 linePos 起点（类型守卫，避免 unsafe cast）。[P-yaml] 实测 e.linePos = [{line,col},{line,col}]。*/
function getYamlLinePos(e: unknown): { line: number; col: number } | undefined {
  if (e !== null && typeof e === "object" && "linePos" in e) {
    const lp = (e as Record<string, unknown>).linePos;
    if (Array.isArray(lp) && lp.length > 0) {
      const first = lp[0];
      if (first !== null && first !== undefined && typeof first === "object"
          && "line" in first && "col" in first) {
        const f = first as Record<string, unknown>;
        if (typeof f["line"] === "number" && typeof f["col"] === "number") {
          return { line: f["line"], col: f["col"] };
        }
      }
    }
  }
  return undefined;
}

// ── IF2: parseResourceMetaDetailed（generate 闭环，返 linePos）─────────

export type DetailedResult =
  | { ok: true; meta: ResourceMeta }
  | { ok: false; error: string; linePos?: { line: number; col: number } };

/**
 * generate 闭环专用。失败时返回 error + linePos（取自 eemeli/yaml YAMLParseError.linePos[0]），
 * 供 actionGenerate 报「生成 YAML 错在 line X col Y」给 LLM 自纠正（ERR4）。
 * discovery 不用此（保持 fail-safe null）。
 *
 * [P-yaml] 探针实测：e.linePos 是 [{line,col},{line,col}]（start+end），取 [0] 作起点。
 *
 * minor-6：区分「未找到块」(undefined) 与「块为空/非法」("")，给可操作错误。
 * minor-8：typecheckMeta 包进 try（与 IF1 对称，防御 typecheck 未来抛错）。
 */
export function parseResourceMetaDetailed(
  content: string,
  kind: ResourceKind,
): DetailedResult {
  const block = extractBlock(content, kind);
  if (block === undefined) {
    return { ok: false, error: "未找到 meta 块（缺少 /* @pi-meta */ 或 frontmatter，或闭合 */ 不在行首）" };
  }
  let raw: unknown;
  try {
    raw = parseYaml(block);
  } catch (e) {
    // eemeli/yaml YAMLParseError：e.linePos = [{line,col},{line,col}]（[P-yaml] 实测）
    const linePos = getYamlLinePos(e);
    return {
      ok: false,
      error: e instanceof Error ? e.message.split("\n")[0] : String(e),
      ...(linePos !== undefined ? { linePos } : {}),
    };
  }
  try {
    const meta = typecheckMeta(raw, kind);
    if (!meta) {
      return { ok: false, error: "meta 类型校验失败（缺 name/description、phases 非法、kind 字段串类或可选字段类型错）" };
    }
    return { ok: true, meta };
  } catch (e) {
    return { ok: false, error: `meta 类型校验异常: ${e instanceof Error ? e.message : String(e)}` };
  }
}
