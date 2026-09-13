// src/execution/assembly/agent-registry.ts
//
// agent .md 文件发现与解析。
//
// 发现逻辑统一走 shared/resource-discovery（ADR-031），与 workflow 共享同一套
// 扫描源前缀 + manifest 校验。hot-reload：每次调用重扫（mtime 缓存跳过未变文件）。
//
// builtin agent（包内 agents/*.md）走 pi.agents manifest（与 npm 包内发现规则一致）。


import * as path from "node:path";

import { getLogger } from "../../core/logger.ts";

import {
  getCachedFile,
} from "../../shared/resource-discovery.ts";
import { normalizeRef, AGENT_REF_EXT } from "../../shared/agent-ref.ts";
import { parseResourceMeta } from "../../shared/meta-parser.ts";
import { lintAgentMeta } from "../../orchestration/script-lint.ts";
import type { AgentMeta, RoutingExample } from "../../shared/resource-meta.ts";
import type { AgentConfig } from "./model-resolver.ts";
import { EngineNotFoundError, listEngines } from "../engine/registry.ts";
// [W8] 存在性校验经补扫通道（快照未命中触发一次三级补扫，W4 ensureEngineDiscovered
// 语义——宿主未接线补扫参数时与裸 hasEngine 等价）。
import { hasEngineWithRescan } from "../engine/routing.ts";

const logger = getLogger("subagents");

/** mtime 缓存条目（跨 loadByPath 保留，靠 mtime 判失效）。 */
interface FileCacheEntry {
  mtimeMs: number;
  config: AgentConfig;
  /** AgentMeta（W4 lint 用——cache-miss 时 lint 一次，warn 随 mtime 变化刷）。 */
  meta: AgentMeta | null;
}

// ============================================================
// frontmatter 解析
// ============================================================

/** frontmatter 分隔符。 */
const FM_DELIM = "---";

/**
 * 解析 .md frontmatter（name/tools/model/thinkingLevel/defaultBackground）+ body（systemPrompt）。
 * 兼容简单 YAML（key: value 单行格式）。body 作为 systemPrompt。
 */
export function parseAgentFrontmatter(filePath: string, content: string): AgentConfig {
  return parseAgentWithMeta(filePath, content).config;
}

/**
 * 解析 agent .md → { config, meta } 二元组（m5 T2：W4 lint 需要 AgentMeta——
 * AgentConfig 投影时 examples 被丢弃，meta 供 lintAgentMeta 使用）。
 */
export function parseAgentWithMeta(
  filePath: string,
  content: string,
): { config: AgentConfig; meta: AgentMeta | null } {
  const name = path.basename(filePath, ".md");
  // 结构切分三态（与 parseAgentProfile 共用 splitAgentFrontmatter，切分逻辑逐字节一致）
  const fm = splitAgentFrontmatter(content);

  // 无 frontmatter → 整个内容作为 systemPrompt
  if (fm.kind === "none") {
    return { config: { name, systemPrompt: content.trim() }, meta: null };
  }

  // 未闭合 frontmatter：提取 name，其余作为 systemPrompt
  if (fm.kind === "unclosed") {
    return {
      config: {
        name: extractYamlField(fm.yamlBlock, "name") ?? name,
        systemPrompt: content.trim(),
      },
      meta: null,
    };
  }

  return parseClosedFrontmatterAgent(filePath, name, content, fm.yamlBlock, fm.body);
}

/** closed frontmatter 的主路径：IF1 严格层 + legacy fallback 字段解析 + config 投影。
 *  字段解析/warn/throw 时序与提取前一致（parseResourceMeta → fallback+warn → engine+校验 → 投影）。 */
function parseClosedFrontmatterAgent(
  filePath: string,
  name: string,
  content: string,
  yamlBlock: string,
  body: string,
): { config: AgentConfig; meta: AgentMeta | null } {
  // m2：结构化路由字段（name/model/tools）经 IF1 parseResourceMeta（统一 parser），
  // 消灭本地 frontmatter parser 与 subagent-list-injector 的重复。thinkingLevel/defaultBackground
  // 是执行配置（非 AgentMeta 路由字段），仍用 extractYamlField 取。
  const meta = parseResourceMeta(content, "agent");
  const agentMeta = meta?.kind === "agent" ? meta : null;
  const legacyFallbacks = resolveLegacyRoutingFallbacks(agentMeta, yamlBlock, filePath);
  // engine 字段（D9）：结构化优先（IF1），legacy fallback 与 model/tools 同判——
  // agentMeta 未通过 IF1 时配置不丢
  const engine = resolveAgentEngine(agentMeta, yamlBlock, filePath);

  return {
    config: projectAgentConfig(name, body, agentMeta, legacyFallbacks, engine, yamlBlock),
    meta: agentMeta,
  };
}

/** legacy fallback 路由字段（model/tools）：IF1 未通过时不静默丢失（MF-3），并按需 warn。 */
function resolveLegacyRoutingFallbacks(
  agentMeta: AgentMeta | null,
  yamlBlock: string,
  filePath: string,
): { modelFallback: string | undefined; toolsFallback: string[] | undefined } {
  // MF-3 regression fix：agentMeta=null（IF1 要求 name/description 必填，缺则 parseResourceMeta
  // 返 null）时，model/tools 不能静默丢失——fallback 用 extractYamlField 取（保留重构前行为）。
  // 注入路由可见性由 discovery/injector 按 available 标志决定，与本处（direct-path loadByPath）无关。
  const modelFallback = extractYamlField(yamlBlock, "model");
  const toolsFallback = parseCommaListFallback(extractYamlField(yamlBlock, "tools"));
  if (!agentMeta && /^model:|^tools:/m.test(yamlBlock)) {
    // m2 exec-review MINOR-2 + MF-3：IF1 未通过（缺 name/description）→ model/tools 经 legacy
    // fallback 取（direct-path loadByPath 不丢配置，与重构前一致）；但结构化路由注入不可见，
    // 建议 agent 作者补 description 以满足 IF1。
    logger.warn(
      `[agent-registry] ${filePath}: agent frontmatter 缺 name/description（IF1 必填），` +
        "model/tools 经 legacy fallback 生效（直接路径不丢配置），但结构化路由不可见——请补充 description",
    );
  }
  return { modelFallback, toolsFallback };
}

/** engine 字段解析 + 解析期注册校验（D9：未注册 id 前置暴露，不留到运行时神秘失败）。
 *  为什么在解析期而非路由期：配置错误的根源在 .md 文件，越早报错定位越准（错误含文件路径 + 注册清单）。 */
function resolveAgentEngine(
  agentMeta: AgentMeta | null,
  yamlBlock: string,
  filePath: string,
): string | undefined {
  const engine = agentMeta?.engine ?? extractYamlField(yamlBlock, "engine");
  // [W8] 补扫通道：快照未命中先一次三级补扫再判（装了引擎包 → 下次解析即可用）。
  if (engine !== undefined && !hasEngineWithRescan(engine)) {
    throw new EngineNotFoundError(engine, listEngines(), filePath);
  }
  return engine;
}

/** closed frontmatter 的 AgentConfig 投影（IF1 严格层优先，逐字段 legacy fallback）。 */
function projectAgentConfig(
  name: string,
  body: string,
  agentMeta: AgentMeta | null,
  fallbacks: { modelFallback: string | undefined; toolsFallback: string[] | undefined },
  engine: string | undefined,
  yamlBlock: string,
): AgentConfig {
  return {
    name: agentMeta?.name ?? name,
    systemPrompt: body,
    model: agentMeta?.model ?? fallbacks.modelFallback ?? undefined,
    thinkingLevel: extractYamlField(yamlBlock, "thinkingLevel") ?? undefined,
    ...(engine !== undefined ? { engine } : {}),
    tools: resolveAgentTools(agentMeta, fallbacks.toolsFallback),
    defaultBackground: extractYamlField(yamlBlock, "defaultBackground") === "true" ? true : undefined,
  };
}

/** tools 投影：IF1 严格层非空清单优先，否则 legacy fallback 非空清单，均缺省 undefined。 */
function resolveAgentTools(
  agentMeta: AgentMeta | null,
  toolsFallback: string[] | undefined,
): string[] | undefined {
  return agentMeta?.tools && agentMeta.tools.length > 0
    ? agentMeta.tools
    : (toolsFallback && toolsFallback.length > 0 ? toolsFallback : undefined);
}

/** 提取简单 `key: value` 字段，剥离引号。 */
function extractYamlField(yaml: string, key: string): string | undefined {
  const regex = new RegExp(`^${key}:\\s*(.+)$`, "m");
  const match = yaml.match(regex);
  if (!match) return undefined;
  let value = match[1].trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return value || undefined;
}

// ============================================================
// 宽容解析（sink 设计 D3 / U2）
// ============================================================

/**
 * agent .md 的宽容解析结果（执行消费面全字段投影）。
 *
 * 双轨语义（D3 定稿）：本结构是**执行可用性**面（可用即跑），严格路由面仍是
 * AgentMeta（注入清单可见性：缺 name/description 不进清单，由 meta !== null 表达）。
 * 两轨分离是两宿主既有设计，本类型只是把执行侧第三份手写实现（zsw mini parser）
 * 收敛到 core 单点。
 */
export interface AgentProfile {
  /** 宽容 name：frontmatter name，缺省文件 stem（宽松语义不拒）。 */
  name: string;
  /** 宽容 description：frontmatter description，缺省空串（宽松语义不拒）。 */
  description: string;
  /** frontmatter 后正文（trim）——即 systemPrompt。 */
  body: string;
  /** 路由提示（严格层投影；IF1 未通过时经 legacy fallback 也不取——该资产不进清单）。 */
  when?: string;
  examples?: RoutingExample[];
  // ── 执行字段全量（与 AgentConfig / AgentMeta 同名同语义）──
  model?: string;
  tools?: string[];
  /** 执行引擎 id（D9 per-agent）。 */
  engine?: string;
  thinkingLevel?: string;
  defaultBackground?: boolean;
  /** turn 预算上限（D3 可选执行字段；消费优先级：显式参数 > 本字段 > 缺省）。 */
  maxTurns?: number;
  /** tool denylist（D3 可选执行字段，与 tools allowlist 正交）。 */
  disallowedTools?: string[];
  /** agent 声明依赖的 skill 名清单（D3 可选执行字段）。 */
  skills?: string[];
  /**
   * IF1 严格层 meta：null = 无 frontmatter / 未闭合 / 严格校验未通过。
   * 注入清单可见性判定归它（discoverAgents 只放行 meta 非 null 的条目——
   * 与 pi 现装配循环口径等值）。
   */
  meta: AgentMeta | null;
  /**
   * 宽容解析降级说明（legacy fallback 生效等）。宽容语义不抛——资产异常时
   * 返回尽力解析结果 + warnings，调用方决定呈现（错误规格表：`{ name: stem, body,
   * warnings[] }` 宽容降级）。
   */
  warnings: string[];
}

/**
 * agent .md 宽容解析（D3/U2 定稿）：无 frontmatter 不拒、name 缺省 stem、
 * description 缺省空串、返回 body 与执行字段全量，**永不抛**。
 *
 * 实现基础（D3 字段形态覆盖矩阵）：
 * - 主路径 = parseResourceMeta（eemeli/yaml 全量解析）：原生支持单行 key:value、
 *   行内数组、block-scalar、多行 `- item` 列表；
 * - meta=null 时（无 frontmatter / 未闭合 / yaml 整体解析失败 / IF1 严格校验未通过）
 *   经 extractYamlField legacy fallback（仅单行 key:value 形态）兜底取执行字段，
 *   保证「可用即跑」不因资产格式瑕疵丢失配置（先例：parseAgentWithMeta 的 MF-3
 *   fallback）。fallback 触达时写入 warnings（warn 可见，调用方决定呈现）。
 *
 * 与 parseAgentWithMeta 的关系：本函数是新增导出面（执行消费面），既有
 * parseAgentWithMeta/loadByPath 语义零改动（含 engine 未注册 throw 的解析期校验）。
 * 本函数宽容语义不抛，故不做 engine 注册校验（执行校验归执行路径）。
 */
export function parseAgentProfile(text: string, filePath: string): AgentProfile {
  const stem = path.basename(filePath, ".md");
  const warnings: string[] = [];

  // 阶段 1：结构切分（无 frontmatter / 未闭合 / 闭合三态）
  const fm = splitAgentFrontmatter(text);
  // 无 frontmatter → 整个内容作为 body（宽容：README 等普通 .md 也是合法 profile）
  if (fm.kind === "none") {
    return {
      name: stem,
      description: "",
      body: text.trim(),
      meta: null,
      warnings,
    };
  }
  if (fm.kind === "unclosed") {
    // 未闭合 frontmatter：name 经 legacy fallback，其余全文作 body（与 parseAgentWithMeta 同判）
    warnings.push(
      `[agent-registry] ${filePath}: frontmatter 未闭合——name 经 legacy fallback（仅单行 key:value），全文作 body`,
    );
    return {
      name: extractYamlField(fm.yamlBlock, "name") ?? stem,
      description: "",
      body: text.trim(),
      meta: null,
      warnings,
    };
  }

  // 阶段 2：主路径 = IF1 严格层（eemeli/yaml 全量解析）
  const meta = parseResourceMeta(text, "agent");
  const agentMeta = meta?.kind === "agent" ? meta : null;
  if (agentMeta !== null) {
    return profileFromStrictMeta(agentMeta, fm.yamlBlock, fm.body, warnings);
  }

  // 阶段 3：meta=null（yaml 解析失败或 IF1 未通过）→ legacy fallback 仅单行 key:value，
  // 执行字段不静默丢失（MF-3 先例收敛）。宽松语义：name 缺省 stem、description 缺省空串。
  warnings.push(
    `[agent-registry] ${filePath}: agent frontmatter 未通过严格校验（IF1：yaml 解析失败或缺 name/description）` +
      "——执行字段经 legacy fallback（仅单行 key:value 形态）生效，结构化路由不可见，建议补 name/description",
  );
  return profileFromLegacyFallback(fm.yamlBlock, fm.body, stem, filePath, warnings);
}

/** 宽容解析阶段 1 的切分产物（frontmatter 结构三态）。 */
type AgentFrontmatterSlice =
  | { kind: "none" }
  | { kind: "unclosed"; yamlBlock: string }
  | { kind: "closed"; yamlBlock: string; body: string };

/** frontmatter 结构切分（产出三态供分派；parseAgentWithMeta 与 parseAgentProfile 共用单点）。 */
function splitAgentFrontmatter(text: string): AgentFrontmatterSlice {
  if (!text.startsWith(FM_DELIM)) return { kind: "none" };
  const closeIdx = text.indexOf(FM_DELIM, FM_DELIM.length);
  if (closeIdx === -1) {
    return { kind: "unclosed", yamlBlock: text.slice(FM_DELIM.length) };
  }
  return {
    kind: "closed",
    yamlBlock: text.slice(FM_DELIM.length, closeIdx),
    body: text.slice(closeIdx + FM_DELIM.length).trim(),
  };
}

/** 严格层（IF1 通过）的 profile 投影：AgentMeta 路由/执行字段 + 单行提取的执行配置。 */
function profileFromStrictMeta(
  agentMeta: AgentMeta,
  yamlBlock: string,
  body: string,
  warnings: string[],
): AgentProfile {
  // thinkingLevel/defaultBackground 是执行配置（非 AgentMeta 字段），与
  // parseAgentWithMeta 同位经单行提取（严格层资产同样携带这两字段的现实先例）
  const thinkingLevelRaw = extractYamlField(yamlBlock, "thinkingLevel");
  const defaultBackgroundRaw = extractYamlField(yamlBlock, "defaultBackground");
  return {
    name: agentMeta.name,
    description: agentMeta.description,
    body,
    ...(agentMeta.when !== undefined ? { when: agentMeta.when } : {}),
    ...(agentMeta.examples !== undefined ? { examples: agentMeta.examples } : {}),
    ...(agentMeta.model !== undefined ? { model: agentMeta.model } : {}),
    ...nonEmptyArraySpread("tools", agentMeta.tools),
    ...(agentMeta.engine !== undefined ? { engine: agentMeta.engine } : {}),
    ...(thinkingLevelRaw !== undefined ? { thinkingLevel: thinkingLevelRaw } : {}),
    ...(defaultBackgroundRaw === "true" ? { defaultBackground: true } : {}),
    ...(agentMeta.maxTurns !== undefined ? { maxTurns: agentMeta.maxTurns } : {}),
    ...nonEmptyArraySpread("disallowedTools", agentMeta.disallowedTools),
    ...nonEmptyArraySpread("skills", agentMeta.skills),
    meta: agentMeta,
    warnings,
  };
}

/** legacy fallback 的 profile 投影（仅单行 key:value 提取；warnings 同引用收集）。 */
function profileFromLegacyFallback(
  yamlBlock: string,
  body: string,
  stem: string,
  filePath: string,
  warnings: string[],
): AgentProfile {
  const nameFallback = extractYamlField(yamlBlock, "name") ?? stem;
  const modelFallback = extractYamlField(yamlBlock, "model");
  const toolsFallback = parseCommaListFallback(extractYamlField(yamlBlock, "tools"));
  const maxTurnsFallback = parseNumberFallback(extractYamlField(yamlBlock, "maxTurns"), filePath, "maxTurns", warnings);
  const disallowedToolsFallback = parseCommaListFallback(extractYamlField(yamlBlock, "disallowedTools"));
  const skillsFallback = parseCommaListFallback(extractYamlField(yamlBlock, "skills"));
  const thinkingLevelFallback = extractYamlField(yamlBlock, "thinkingLevel");
  const defaultBackgroundRaw = extractYamlField(yamlBlock, "defaultBackground");
  const engineFallback = extractYamlField(yamlBlock, "engine");

  return {
    name: nameFallback,
    description: "",
    body,
    ...(modelFallback !== undefined ? { model: modelFallback } : {}),
    ...nonEmptyArraySpread("tools", toolsFallback),
    ...(engineFallback !== undefined ? { engine: engineFallback } : {}),
    ...(thinkingLevelFallback !== undefined ? { thinkingLevel: thinkingLevelFallback } : {}),
    ...(defaultBackgroundRaw === "true" ? { defaultBackground: true } : {}),
    ...(maxTurnsFallback !== undefined ? { maxTurns: maxTurnsFallback } : {}),
    ...nonEmptyArraySpread("disallowedTools", disallowedToolsFallback),
    ...nonEmptyArraySpread("skills", skillsFallback),
    meta: null,
    warnings,
  };
}

/** 可选数组字段非空才带键（tools/disallowedTools/skills 的条件展开收敛，键序随展开位不变）。 */
function nonEmptyArraySpread<T>(key: string, v: T[] | undefined): Record<string, T[]> {
  return v !== undefined && v.length > 0 ? { [key]: v } : {};
}

/** legacy fallback 的逗号分隔列表解析（`tools: read, bash` 约定，与 parseAgentWithMeta 同构）。 */
function parseCommaListFallback(raw: string | undefined): string[] | undefined {
  return raw
    ? raw.split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;
}

/** legacy fallback 的数字解析（extractYamlField 只出字符串，`maxTurns: 2` 需换算）。 */
function parseNumberFallback(
  raw: string | undefined,
  filePath: string,
  field: string,
  warnings: string[],
): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    warnings.push(`[agent-registry] ${filePath}: ${field} 值 "${raw}" 不是有限数字，忽略`);
    return undefined;
  }
  return n;
}

// ============================================================
// AgentRegistry
// ============================================================

export class AgentRegistry {
  /** 文件级 mtime 缓存（key=绝对路径，跨 loadByPath 保留）。 */
  private readonly fileCache = new Map<string, FileCacheEntry>();

  /**
   * 按绝对路径加载 agent（agentRef 统一解析入口——S2 路径统一）。
   *
   * - ~/ 前缀展开；相对路径/非 .md 引用返回 undefined（引用唯一形态 = 绝对路径）
   * - 文件不可读/不存在 → 驱逐缓存 + 返回 undefined（调用方给错误指引）
   * - mtime 未变复用 config 缓存；cache-miss 时 W4 lint 一次
   *
   * require 语义：require:true 时上述两类失败改为 throw（错误文案含
   * <available_subagents> 恢复指引），供「用户显式点名 agent」的调用点使用——
   * 显式 ref 失败是配置错误，必须显式报错而非静默降级（三通道对称审查）。
   */
  loadByPath(ref: string, require: true): AgentConfig;
  loadByPath(ref: string, require?: boolean): AgentConfig | undefined;
  loadByPath(ref: string, require?: boolean): AgentConfig | undefined {
    const filePath = normalizeRef(ref, AGENT_REF_EXT);
    if (filePath === null) {
      if (require) {
        throw new Error(
          `Invalid agent ref: ${ref}. Agent refs must be absolute paths to .md files (use <location> from <available_subagents>).`,
        );
      }
      return undefined;
    }

    const file = getCachedFile(filePath);
    if (file === null) {
      // ENOENT/不可读 → 驱逐（mtime 缓存下文件删除不自愈的修复）
      this.fileCache.delete(filePath);
      if (require) {
        throw new Error(
          `Agent file not found or unreadable: ${filePath}. Use an absolute path from <available_subagents> <location>.`,
        );
      }
      return undefined;
    }

    const cached = this.fileCache.get(filePath);
    if (cached && cached.mtimeMs === file.mtimeMs) {
      return cached.config;
    }

    const { config, meta } = parseAgentWithMeta(filePath, file.content);
    // W4 lint：cache-miss（parse 时一次）——warn 只随 mtime 变化刷
    const lintFindings = meta ? lintAgentMeta(meta) : [];
    for (const finding of lintFindings) {
      logger.warn(`[agent-registry] ${filePath}: ${finding.message}`);
    }
    this.fileCache.set(filePath, { mtimeMs: file.mtimeMs, config, meta });
    return config;
  }
}
