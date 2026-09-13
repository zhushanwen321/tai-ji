/**
 * SkillInjector —— composer 多 skill 注入的 runtime 预处理（composer-multi-skill-injection
 * P1，R4 D11 末尾块形态）。
 *
 * 职责（设计 §3.3）：
 * - D3/D11：解析文本中全部 `<xyz-skill/>` 私有标记（u1 parseSkillMarkers），正文标记
 *   **原样保留**（R4 起不再原位替换展开）；无标记文本零改动
 * - D4/D5/D11：name → SKILL.md 路径以 pi RPC get_commands 的 source:"skill" 项为权威映射
 *   （块内 `<skill>` 与降级清单的 location 恒取映射结果 r.path，不信标记自带 location——
 *   过时路径不得作为权威 read 路径），读 SKILL.md → stripFrontmatter → 构建与 pi
 *   `_expandSkillCommand` 逐字一致的 `<skill>` block；同 name 去重（按标记出现序首个
 *   归并，重复不发 notice）后经 buildSkillDataBlockExpansions 组装 `<xyz-skill-data>`
 *   包裹块，以空行接在正文后（正文 + '\n\n' + 块）
 * - D6/D11：发送前预检——估算「正文 + 末尾块全文的整条 message」token（CJK 感知，u1
 *   estimateTokens），超过 0.8 × contextWindow（get_session_stats 实时取）→ 整条降级为
 *   buildSkillDataBlockFallback（同一 `<xyz-skill-data>` 包裹，块内标记清单 + 指引行，
 *   模型自主 read；旧 `<xyz-skills>` tag 退役）；contextWindow 获取失败 fail-safe 降级
 *   （不 fail-open）
 * - D8：失效降级必须可见——name 无映射 / SKILL.md 读取失败 / 标记被 hook 改写残缺：
 *   该标记正文原样保留、不进块（对齐 pi 未知 skill 透传行为）+ 产出提示 notice，禁止静默；
 *   get_commands 整体失败（mapping_unavailable）→ 正文留标记、不追加块。notice 由调用方
 *   （message-dispatcher）经 messageBus 发布
 *
 * 挂载契约（D9）：dispatcher 三入口各恰好单次调用（结构化幂等，不做文本 grep 判重），
 * 在 BeforeSend hook 之后、client.prompt/steer/followUp 之前。
 */
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  buildSkillDataBlockExpansions,
  buildSkillDataBlockFallback,
  CONTEXT_WINDOW_RATIO,
  estimateTokens,
  parseSkillMarkers,
  SKILL_MARKER_TAG,
  unescapeSkillAttr,
  type ParsedSkillMarker,
  type ServerMessageMapBase,
} from '@xyz-agent/shared'
import type { IPiEngine } from '../ports/pi-engine.js'

/**
 * get_commands 返回的 skill 命令项（ports 翻译层类型的结构化挑选子集，本模块只消费
 * name / source / sourceInfo 三字段）。不直接引用 ports 原类型：check_pi_type_leak
 * （C-comm-02）对 services 层新文件做 Pi[A-Z]* 标识符文本拦截，alias import 的源文本
 * 仍含原标识符（实测命中）；此处的结构化子集与 ports 翻译层类型结构兼容（IPiEngine
 * .getCommands() 返回值可直接赋值），单一事实源仍在 ports/pi-engine.ts。
 */
interface SkillCommandInfo {
  name: string
  source: string
  sourceInfo?: {
    path: string
    source: string
    scope?: string
    origin?: string
    baseDir?: string
  }
}

/** session.skillNotice 的 reason 联合（从 protocol 契约提取，单一事实源；index.ts 未单独导出该联合，不越权补登记）。 */
type SkillNoticeReason = ServerMessageMapBase['session.skillNotice']['reason']

/** 单条提示：事件种类 + 受影响 skill 名（reason 从 protocol 契约提取，与广播 payload 单一事实源）。 */
export interface SkillNotice {
  reason: SkillNoticeReason
  skills: string[]
}

/** 注入结果：注入后待发送文本 + 待发布提示列表（广播编排归 dispatcher，本模块不发消息）。 */
export interface SkillInjectionResult {
  text: string
  notices: SkillNotice[]
}

// ── pi stripFrontmatter 镜像（锚点 @earendil-works/pi-coding-agent 0.84.4
//    dist/utils/frontmatter.js + dist/utils/text.js，逐字对齐）──
//
// 为什么不直接 import pi 包根导出（设计 D5 原意）：pi 包 exports 白名单仅 "." / "./rpc-entry" /
// "./client" 三口子，dist/utils/frontmatter.js 深路径被 exports 拦截；包根 import 的静态依赖图
// 经 index.js → main.js → TUI 组件 → @silvia-odwyer/photon-node（WASM 图像库）全量拖进 tsup
// bundle，违反 noExternal 既有判据（tsup.config.ts「纯 JS 包、无 native addon、体积合理」）。
// 漂移防线等价迁移：u6 探针（check-pi-semantics 场景 8）对「pi 展开输出 vs 本展开器输出」做
// golden diff——stripFrontmatter 行为漂移必然变红，与 import 实现的防漂移效果等价。
//
// yaml throw 分支不镜像：frontmatter 非法的 SKILL.md 在 pi loadSkills 阶段已被过滤
//（skills.js loadSkillFromFile 的 parseFrontmatter catch → skill:null，不进 get_commands 映射），
// 展开阶段不可达，故镜像无需 yaml 依赖（解析成功性由 pi 侧保证，本函数只做文本剥离）。

/** stripBom 镜像（dist/utils/text.js splitBom/stripBom）：剥前导 U+FEFF。 */
function stripBomPi(content: string): string {
  return content.startsWith('\uFEFF') ? content.slice(1) : content
}

/** frontmatter 开界符长度（`---`，起点偏移与开界判定共用）。 */
const FRONTMATTER_DELIM_LEN = 3
/** 行首闭界符长度（`\n---`，slice 越过闭界的偏移）。 */
const FRONTMATTER_CLOSED_DELIM_LEN = 4

/**
 * stripFrontmatter 镜像：BOM 剥除 → 换行归一 → frontmatter 边界剥离（extractFrontmatter）。
 * 无 frontmatter / 闭合缺失时原文返回；有 frontmatter 时 body 已 trim（对齐实装，pi 展开处
 * 再 trim 一次属幂等，保留同款双 trim 形态以求逐字）。
 */
function stripFrontmatterPi(content: string): string {
  const normalized = stripBomPi(content).replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  if (!normalized.startsWith('---')) return normalized
  const endIndex = normalized.indexOf('\n---', FRONTMATTER_DELIM_LEN)
  if (endIndex === -1) return normalized
  return normalized.slice(endIndex + FRONTMATTER_CLOSED_DELIM_LEN).trim()
}

// ── 标记完整性检测（D8 残缺分支）──

/**
 * pi get_commands 的 skill 命令 name 前缀（实装锚点 agent-session.js 0.84.4 :1996
 * `name: \`skill:${skill.name}\``）。映射 key 与展开 block 的 name 插值都必须剥前缀：
 * 私有标记的 name 是裸 skill 名（u1 语法，无前缀），block 的 name 须与 pi 原生展开
 * （`name="${skill.name}"`，无前缀）逐字一致。
 */
const PI_SKILL_COMMAND_PREFIX = 'skill:'

/** 剥 pi 命令 name 的 `skill:` 前缀得裸 skill 名（无前缀输入原样返回，防手滑）。 */
function stripPiSkillCommandPrefix(commandName: string): string {
  return commandName.startsWith(PI_SKILL_COMMAND_PREFIX)
    ? commandName.slice(PI_SKILL_COMMAND_PREFIX.length)
    : commandName
}

/**
 * 标记开头顶点统计：`<xyz-skill` 后紧跟空白 / `/` / `>` 视为标记开头（含完整标记与残缺标记；
 * `<xyz-skills>` 存量降级块的开标签后跟字母 s、`<xyz-skill-data>` 包裹块的开标签后跟 `-`，
 * 均不命中——手打包裹块不在本模块处理范围，包裹块内标记被逐个解析属设计 §3.5-⑥ 已登记边界）。
 */
const MARKER_OPEN_RE = new RegExp(`<${SKILL_MARKER_TAG}[\\s/>]`, 'g')

/** 残缺片段的 name 尽力提取（片段截断 / 属性缺失时跳过，skills 列表允许为空）。 */
const MALFORMED_NAME_RE = /name="((?:[^"\\]|\\.)*)"/

/** 残缺片段 name 提取的检查窗口：name（≤64 字符，pi MAX_NAME_LENGTH）+ 属性前缀的余量。 */
const MALFORMED_SNIPPET_LEN = 200

/**
 * 统计文本中标记开头顶点，归类哪些是残缺的（parse 未命中的开头顶点）。
 * 一次遍历同时产出存在性判定与 name 尽力提取——提取失败（片段截断/属性缺失）不影响
 * 存在性判定，提示仍须发（D8 禁止静默）。
 */
function scanMalformed(text: string, markers: ParsedSkillMarker[]): { hasMalformed: boolean; names: string[] } {
  const names: string[] = []
  let hasMalformed = false
  for (const m of text.matchAll(MARKER_OPEN_RE)) {
    // matchAll 的 m.index 指向 `<`（正则从 `<` 起匹配）；完整标记集合按位置排除
    if (markers.some((mk) => mk.index === m.index)) continue
    hasMalformed = true
    const snippet = text.slice(m.index, m.index + MALFORMED_SNIPPET_LEN)
    const nameMatch = snippet.match(MALFORMED_NAME_RE)
    if (nameMatch) names.push(unescapeSkillAttr(nameMatch[1]))
  }
  return { hasMalformed, names }
}

// ── 标记求值与末尾块组装（R4 D11）──

/** 求值后的单标记：block=null 表示失效（正文原样保留该标记、不进块）。 */
interface MarkerResolution {
  marker: ParsedSkillMarker
  block: string | null
  /** 展开成功时的 SKILL.md 路径（块内 location / 降级清单 location 的唯一数据源，D4）。 */
  path?: string
}

/**
 * 逐标记求值：映射 → 读 SKILL.md → 构建与 pi 逐字一致的 block（D5 模板）。
 * 失效（无映射 / 路径缺失 / 读取失败）→ block=null 并记入对应 failGroups（D8 禁止静默）。
 */
function resolveSingleMarker(
  marker: ParsedSkillMarker,
  skillsByName: Map<string, SkillCommandInfo>,
  failGroups: Map<SkillNoticeReason, string[]>,
): MarkerResolution {
  const cmd = skillsByName.get(marker.name)
  if (!cmd) {
    failGroups.get('skill_missing')!.push(marker.name)
    return { marker, block: null }
  }
  const path = cmd.sourceInfo?.path
  if (typeof path !== 'string' || path === '') {
    // 映射存在但 pi 未给路径（sourceInfo 缺失）：无法读文件，按读取失败处理
    failGroups.get('skill_read_failed')!.push(marker.name)
    return { marker, block: null }
  }
  try {
    const body = stripFrontmatterPi(readFileSync(path, 'utf-8')).trim()
    // References 行 baseDir 取 SKILL.md 所在目录（dirname(path)）——pi 展开用的 skill.baseDir
    // 恒为 skillDir = dirname(filePath)（skills.js :236/:260 实装锚点）。不用 sourceInfo.baseDir：
    // skills.js 的 createSkillSourceInfo 分支（:90-110）虽恒透传 skillDir，但装载链上游可变——
    // resource-loader.js :514-518 的 extension 覆盖链（findSourceInfoForPath 命中时 createSourceInfo
    // 直接采用 extension metadata.baseDir）与 :612 兜底（getDefaultSourceInfoForPath 的 `<...>`
    // 形态返回对象无 baseDir 字段），使 get_commands 的 sourceInfo.baseDir 不保证是 SKILL.md
    // 所在目录（PS-24 真实 pi 探针实证漂移），golden diff 抓到后弃用。
    const baseDir = dirname(path)
    // pi _expandSkillCommand 模板（agent-session.js 0.84.4 :997）逐字：
    // `<skill name="..." location="...">\nReferences are relative to <baseDir>.\n\n<body>\n</skill>`
    // name 用裸 skill 名（get_commands 的 name 带 `skill:` 前缀，pi 原生展开无前缀）；
    // name/baseDir 与 pi 同款直接插值不转义（对齐实装行为）
    const skillName = stripPiSkillCommandPrefix(cmd.name)
    const block = `<skill name="${skillName}" location="${path}">\nReferences are relative to ${baseDir}.\n\n${body}\n</skill>`
    return { marker, block, path }
  } catch (e) {
    console.warn(`[skill-injector] failed to read SKILL.md for "${marker.name}" (${path}):`, e instanceof Error ? e.message : String(e))
    failGroups.get('skill_read_failed')!.push(marker.name)
    return { marker, block: null }
  }
}

/**
 * get_commands → name（剥 `skill:` 前缀的裸 skill 名）→ 命令项 的权威映射（D4）。
 * 只收 source === 'skill' 项（slash 命令等其他 source 不参与私有标记展开）。
 */
function buildSkillsByName(commands: SkillCommandInfo[]): Map<string, SkillCommandInfo> {
  const skillsByName = new Map<string, SkillCommandInfo>()
  for (const cmd of commands) {
    if (cmd.source === 'skill') skillsByName.set(stripPiSkillCommandPrefix(cmd.name), cmd)
  }
  return skillsByName
}

/** skill 名去重（保持首次出现顺序），mapping_unavailable notice 的 skills 列表归一。 */
function dedupeNames(markers: ReadonlyArray<ParsedSkillMarker>): string[] {
  return [...new Set(markers.map((m) => m.name))]
}

/**
 * 同 name 去重收集（D11）：按标记出现序首个归并——首个成功展开的标记决定该 name 的
 * block 与 location（location 恒为映射结果，D4），后续同名成功标记丢弃（重复全文纯浪费
 * 上下文；UI 层 D2 已禁选同 skill，此处兜底手打/编辑重发路径），重复不发 notice。
 * 返回 validSkills（降级清单数据源）与 expansions（正常形态块内容），两者顺序一致。
 */
function collectDedupedExpansions(resolutions: readonly MarkerResolution[]): {
  validSkills: { name: string; location: string }[]
  expansions: string[]
} {
  const seen = new Set<string>()
  const validSkills: { name: string; location: string }[] = []
  const expansions: string[] = []
  for (const r of resolutions) {
    if (r.block === null || r.path === undefined) continue
    if (seen.has(r.marker.name)) continue
    seen.add(r.marker.name)
    validSkills.push({ name: r.marker.name, location: r.path })
    expansions.push(r.block)
  }
  return { validSkills, expansions }
}

/**
 * get_session_stats 实时取 contextWindow（D6 预检数据源）。fail-safe 降级（D6）：RPC 失败
 * 或窗口字段非正有限数 → null，调用方走标记模式降级，不放行全文注入——get_session_stats
 * 失败预示 RPC 异常，放行大消息若真超窗即落持续失败态。设计裁定不重抛（方向安全）。
 */
async function readContextWindow(client: IPiEngine): Promise<number | null> {
  try {
    const stats = await client.getSessionStats()
    const w = stats.contextUsage?.contextWindow
    if (typeof w === 'number' && Number.isFinite(w) && w > 0) return w
    return null
  } catch (e) {
    console.warn('[skill-injector] get_session_stats failed (fail-safe fallback):', e instanceof Error ? e.message : String(e))
    return null
  }
}

/**
 * 降级注入结果构建（D11 降级形态）：两个降级触发源（窗口不可得 / 预算超限）共用，仅
 * reason 不同。正文（含全部标记）逐字保留，降级包裹块（块内标记清单 + 块内指引行）以
 * 空行接在正文后——与正常形态同构（同一 `<xyz-skill-data>` 包裹，D11）。
 */
function buildFallbackInjection(
  text: string,
  validSkills: ReadonlyArray<{ name: string; location: string }>,
  reason: 'context_window_unavailable' | 'budget_exceeded',
  invalidAndMalformed: SkillNotice[],
): SkillInjectionResult {
  return {
    text: `${text}\n\n${buildSkillDataBlockFallback(validSkills)}`,
    notices: [{ reason, skills: validSkills.map((s) => s.name) }, ...invalidAndMalformed],
  }
}

/** 逐 reason 聚合失效 notice（skills 并集去重），供非降级路径产出。 */
function aggregateNotices(groups: Map<SkillNoticeReason, string[]>): SkillNotice[] {
  const notices: SkillNotice[] = []
  for (const [reason, names] of groups) {
    if (names.length === 0) continue
    notices.push({ reason, skills: [...new Set(names)] })
  }
  return notices
}

export class SkillInjector {
  /**
   * 对发送前文本做 skill 注入预处理（无标记文本零改动、零 RPC 开销——预检只在确有
   * 可展开标记时才发起 get_commands / get_session_stats 往返）。
   *
   * R4 D11 注入形态：正文中的 `<xyz-skill/>` 标记原样保留；全部展开内容集中追加在
   * 消息末尾的 `<xyz-skill-data>` 包裹块（正文 + '\n\n' + 块）——正常形态块内为去重后
   * 的 pi 对齐 `<skill>` 全文列表，降级形态块内为标记清单 + 指引行。
   *
   * 错误面：内部 RPC / fs 失败全部转为降级或透传 + notice（D8 禁止静默），本方法不向
   * 调用方抛业务错误；调用方（dispatcher）把 notices 在 client 发送成功后经 bus 发布。
   */
  async inject(client: IPiEngine, text: string): Promise<SkillInjectionResult> {
    const markers = parseSkillMarkers(text)
    if (markers.length === 0) {
      // 无完整标记：只剩残缺透传分支（hook 改写破坏 / 手打残缺），不发起任何 RPC
      const malformed = scanMalformed(text, markers)
      if (malformed.hasMalformed) {
        return { text, notices: [{ reason: 'marker_malformed', skills: malformed.names }] }
      }
      return { text, notices: [] }
    }

    // ── get_commands 权威映射（D4）。整体失败 → 全部透传（映射服务不可用；块内 location
    //    与降级清单 location 均需映射提供，无从构建，故不走 D6 降级路径、不追加块），
    //    发提示禁止静默。
    let commands: SkillCommandInfo[]
    try {
      commands = await client.getCommands()
    } catch (e) {
      console.warn('[skill-injector] get_commands failed, pass-through all markers:', e instanceof Error ? e.message : String(e))
      return { text, notices: [{ reason: 'mapping_unavailable', skills: dedupeNames(markers) }] }
    }
    // 映射 key 用剥 `skill:` 前缀后的裸 skill 名（与私有标记的 name 同一口径）
    const skillsByName = buildSkillsByName(commands)

    // ── 逐标记求值：映射 → 读 SKILL.md → 构建与 pi 逐字一致的 block（D5 模板）──
    const failGroups = new Map<SkillNoticeReason, string[]>([
      ['skill_missing', []],
      ['skill_read_failed', []],
    ])
    const resolutions = markers.map((marker) => resolveSingleMarker(marker, skillsByName, failGroups))

    const invalidNotices = aggregateNotices(failGroups)
    const malformed = scanMalformed(text, markers)
    const invalidAndMalformed = [
      ...invalidNotices,
      ...(malformed.hasMalformed ? [{ reason: 'marker_malformed' as const, skills: malformed.names }] : []),
    ]

    // ── 同 name 去重（D11）：按出现序首个归并 ──
    const { validSkills, expansions } = collectDedupedExpansions(resolutions)
    if (validSkills.length === 0) {
      // 无可展开标记（全部失效/残缺）：跳过预检，原文透传 + 失效提示
      return { text, notices: invalidAndMalformed }
    }

    // ── 预检（D6）：估算「正文 + 末尾块全文的整条 message」（R4 正常形态全文，与现状
    //    同口径：估算对象恒为若全文注入的最终消息），与 0.8 × contextWindow 比较。
    const hypothetical = `${text}\n\n${buildSkillDataBlockExpansions(expansions)}`
    const contextWindow = await readContextWindow(client)
    if (contextWindow === null) {
      // fail-safe（D6）：窗口信息不可得即降级为标记模式，不放行全文注入——
      // get_session_stats 失败预示 RPC 异常，放行大消息若真超窗即落持续失败态。
      return buildFallbackInjection(text, validSkills, 'context_window_unavailable', invalidAndMalformed)
    }
    if (estimateTokens(hypothetical) > CONTEXT_WINDOW_RATIO * contextWindow) {
      return buildFallbackInjection(text, validSkills, 'budget_exceeded', invalidAndMalformed)
    }
    // 正常形态（D11）：正文标记原样保留 + 空行 + 末尾包裹块
    return { text: hypothetical, notices: invalidAndMalformed }
  }
}
