// src/spawn-args.ts
//
// pi CLI argv 构造器（公共层）——主 agent 与 subagent 两模板 + 共享分段原语。
//
// 来源（行为逐字等价提取，非重写）：
//   - buildPiMainAgentArgs ← runtime rpc-client.ts buildPiArgs（B1 起无 --session-dir）
//   - buildPiSubagentSpawnArgs ← pi-subagent-cli spawn-args.ts buildSpawnArgs
//
// 为什么是两个模板入口而非单构造器：两侧 argv 的 flag 编排顺序不同（主 agent 的
// skill/extension 在 tools 段之前、基座 flag 前置；subagent 的 skill 在 tools 段之后、
// mirror flag 段末尾）。pi 的 commander 解析对顺序无语义，但本包的迁移契约是「行为
// 等价提取」（两侧典型参数集的 argv 与切换前逐字节一致，快照测试锚定），统一顺序
// 属重写而非提取。共享的是分段拼装原语（session 定位 / thinking 传递 / tools 互斥 /
// mirror 规则），顺序编排保留两模板各自的现状。
//
// 参数化差异点（设计 §3.3.2 spawn-args 行）：
//   - session 定位：主 agent = none（pi 默认派生 agentDir/sessions）；subagent =
//     dir（--session-dir 独立池）+ 可选 file（--session 续写原文件）
//   - thinking 传递：主 agent = flag（--thinking <level>）；subagent = model 后缀
//     （--model provider/id:level）
//   - extensions/skills 注入：两模板共用 appendSkillArgs / appendExtensionArgs 原语
//   - mirror 规则：subagent 镜像主进程 argv 的 flag 段（MirrorFlags；解析器在
//     pi-subagent-cli argv-mirror.ts，本包只消费解析结果）

import type { ThinkingLevel } from './types.ts'

// ─────────────────────────────────────────────────────────────────────────────
// 共享分段原语
// ─────────────────────────────────────────────────────────────────────────────

/** 每个路径独立 --skill token（pi 原生 loader 逐个加载）。 */
export function appendSkillArgs(args: string[], skillPaths: readonly string[] | undefined): void {
  if (skillPaths?.length) {
    for (const skillPath of skillPaths) {
      args.push('--skill', skillPath)
    }
  }
}

/** 每个路径独立 --extension token（显式注入，不受 --no-extensions 影响）。 */
export function appendExtensionArgs(args: string[], extensionPaths: readonly string[] | undefined): void {
  if (extensionPaths?.length) {
    for (const extPath of extensionPaths) {
      args.push('--extension', extPath)
    }
  }
}

/** tools/excludeTools/noTools 三者互斥判定（W-RT-6：任两组同时出现即冲突）。 */
export function toolOptionConflict(hasNoTools: boolean, hasTools: boolean, hasExcludeTools: boolean): boolean {
  return (hasNoTools && hasTools)
    || (hasNoTools && hasExcludeTools)
    || (hasTools && hasExcludeTools)
}

/**
 * tools/excludeTools/noTools args（互斥三选一）。
 *
 * tools/excludeTools 用逗号连接（pi 单参数多值语义）；开关类 push 单 flag；
 * W-RT-6：三者互斥，按优先级 noTools > tools > excludeTools 取一个，
 * 同时出现多个时 warn（不抛错，避免运行时炸），保持单写者语义清晰。
 */
export function appendToolArgs(
  args: string[],
  toolOptions: {
    tools?: readonly string[]
    excludeTools?: readonly string[]
    noTools?: boolean
  },
): void {
  const hasTools = !!toolOptions.tools?.length
  const hasExcludeTools = !!toolOptions.excludeTools?.length
  const hasNoTools = !!toolOptions.noTools
  if (toolOptionConflict(hasNoTools, hasTools, hasExcludeTools)) {
    console.warn('[rpc] conflicting tool options detected, using priority: noTools > tools > excludeTools')
  }
  if (hasNoTools) {
    args.push('--no-tools')
  } else if (hasTools) {
    args.push('--tools', toolOptions.tools!.join(','))
  } else if (hasExcludeTools) {
    args.push('--exclude-tools', toolOptions.excludeTools!.join(','))
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 主 agent 模板（runtime rpc-client 消费）
// ─────────────────────────────────────────────────────────────────────────────

/** 主 agent spawn 形状（runtime RpcClientOptions 的 argv 相关子集，结构兼容直传）。 */
export interface PiMainAgentSpawnOptions {
  /** 替换 pi 核心系统提示词（--system-prompt；空白时不传）。值经 toInlinePromptValue 加 \n 前缀。 */
  systemPrompt?: string
  /** 追加在 pi 基础系统提示词之后（--append-system-prompt；空白时不传）。值经 toInlinePromptValue 加 \n 前缀。 */
  appendSystemPrompt?: string
  /** skill 路径列表（每路径独立 --skill token）。 */
  skillPaths?: string[]
  /** pi 扩展路径列表（每路径独立 --extension token）。 */
  extensionPaths?: string[]
  /**
   * 工具白名单（替换语义，映射 pi --tools <comma-joined>）。非空时以逗号连接 push，
   * 只启用列出的工具。与 excludeTools/noTools 互斥；同时出现多个时按
   * noTools > tools > excludeTools 优先级取一个并 warn（W-RT-6）。
   */
  tools?: string[]
  /** 工具黑名单（叠加语义，--exclude-tools）。与 tools/noTools 互斥（见 tools 注释）。 */
  excludeTools?: string[]
  /** 禁用所有工具（built-in + extension + custom），映射 --no-tools。与 tools/excludeTools 互斥。 */
  noTools?: boolean
  /** 禁用所有 skill（--no-skills）。调用方同时需清空 skillPaths。 */
  noSkills?: boolean
  /** 禁用 context files（AGENTS.md/CLAUDE.md 自动发现，--no-context-files）。 */
  noContextFiles?: boolean
  /** 覆盖思考级别（--thinking <level>；注意：非 --thinking-level，附录 A.4）。 */
  thinkingLevel?: ThinkingLevel | string
}

/**
 * 内联提示词值 → argv 文本值：前置一个 `\n`（已以 `\n` 开头则不重复）。
 *
 * pi 对两个 prompt flag 的值走同一解析函数（`resolvePromptInput`）：先
 * `existsSync(值)`（相对 pi 进程 cwd = 会话 cwd = 用户项目目录），命中即把**该文件内容**
 * 当提示词注入，否则当字面文本。后果：模式文案若恰等于项目内存在的相对路径
 * （`AGENTS.md` / `.env` / `config.json` 等），pi 会静默把文件全文当提示词（UI 显示
 * 用户文案、实际生效文件内容，且可能把含密钥文件送进上下文）。
 *
 * 含换行的值不可能命中真实路径（除非磁盘真存在名为 `\nfoo` 的文件），故判定恒为文本；
 * `\n` 对提示词语义无影响。**前缀必须落在内联值上（本函数）**——文件降级路径（若启用）
 * 一律用**绝对路径**，不加前缀（加了反而会破坏 existsSync 判定、把降级路径堵死）。
 *
 * 两条通道（replace / append）与两条来路（模式值 / 全局值）共用本函数，前缀不会漏加。
 */
function toInlinePromptValue(value: string): string {
  return value.startsWith('\n') ? value : `\n${value}`
}

/**
 * 主 agent 侧 pi CLI args（runtime rpc-client buildPiArgs 逐字等价提取）。
 *
 * 基座 flag 语义（架构约定 #11）：
 * - --no-extensions：抑制 pi 自动发现/加载的全局扩展，不影响显式 --extension 注入；
 * - --approve：强制信任 cwd——RPC 模式无交互 UI，pi 原生信任流程在 hasUI=false 时
 *   默认拒绝会导致 <cwd>/.pi/ 下的 skill 被跳过；实际主要信任项目级 .pi/skills。
 *   TODO(follow-up): Project Trust UI 落地后移除全局 --approve。
 * - 不传 --session-dir：pi 走默认派生 <agentDir>/sessions/<encodeCwd>（B1 方案 B 布局）。
 */
export function buildPiMainAgentArgs(options: PiMainAgentSpawnOptions, model: string | undefined): string[] {
  const args = ['--mode', 'rpc', '--no-extensions', '--approve']
  if (model) args.push('--model', model)
  // --system-prompt: 替换 pi 核心系统提示词（身份/工具列表/指引/pi 文档路径 4 段）。
  // 动态段（project_context/skills/日期/cwd）仍由 pi 照常拼接。空白/未传不拼。
  // --append-system-prompt: 追加在 pi 基础提示词之后（模式 append 段）。两 flag 对称。
  // 内联值均经 toInlinePromptValue 加 \n 前缀（pi 二义陷阱构造性区分，见函数注释）。
  if (options.systemPrompt?.trim()) {
    args.push('--system-prompt', toInlinePromptValue(options.systemPrompt))
  }
  if (options.appendSystemPrompt?.trim()) {
    args.push('--append-system-prompt', toInlinePromptValue(options.appendSystemPrompt))
  }
  appendSkillArgs(args, options.skillPaths)
  appendExtensionArgs(args, options.extensionPaths)
  appendToolArgs(args, options)
  if (options.noSkills) {
    args.push('--no-skills')
  }
  if (options.noContextFiles) {
    args.push('--no-context-files')
  }
  if (options.thinkingLevel) {
    // thinkingLevel 走 --thinking（pi 参数名，非 --thinking-level，附录 A.4）。
    args.push('--thinking', options.thinkingLevel)
  }
  return args
}

// ─────────────────────────────────────────────────────────────────────────────
// subagent 模板（pi-subagent-cli 消费）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 镜像 flag 集合（subagent 侧从主进程 argv 解析出的可透传 flag）。
 * 解析器（mirrorMainProcessFlags）在 pi-subagent-cli argv-mirror.ts；本类型为
 * 两侧结构同形的消费面（TS 结构化类型下互不通 import 也可传入）。
 */
export interface PiMirrorFlags {
  noExtensions: boolean
  approve: boolean
  extensionPaths: string[]
  noContextFiles: boolean
}

/**
 * spawn 侧已裁决的模型身份：--model 值恒为 `${provider}/${id}`（+ 可选白名单
 * `:level` 后缀）。解析自协议 ctx.model 的 canonical "provider/id" 词形。
 */
export interface SpawnModelRef {
  provider: string
  id: string
}

/** "provider/id" canonical 词形 → SpawnModelRef（无斜杠/畸形 → undefined）。 */
export function parseSpawnModelRef(ref: string | undefined): SpawnModelRef | undefined {
  if (ref === undefined || ref.trim() === '') return undefined
  const slash = ref.indexOf('/')
  if (slash <= 0 || slash === ref.length - 1) return undefined
  return { provider: ref.slice(0, slash), id: ref.slice(slash + 1) }
}

/** subagent spawn 形状（pi-subagent-cli spawn-args.ts buildSpawnArgs 入参逐字等价）。 */
export interface PiSubagentSpawnParams {
  modelRef: SpawnModelRef
  thinkingLevel: ThinkingLevel | undefined
  agentTools: string[] | undefined
  appendSystemPromptPath: string | undefined
  sessionDir: string
  /** resume 目标 session 文件路径（--session 续写原文件而非新建）。 */
  sessionFile?: string
  forkSource: string | undefined
  skillPaths: string[] | undefined
  /** 镜像自主进程 argv 的 flag（--no-extensions/--approve/--extension/--no-context-files）。 */
  mirrorFlags?: PiMirrorFlags
}

/**
 * subagent 侧 pi CLI args（pi-subagent-cli buildSpawnArgs 逐字等价提取）。
 *
 * 不含 task 本身——task 由 spawn 后 prompt 命令写 stdin。
 * [单写者不变量] session JSONL 完整性依赖「每 session 单写进程」：子进程写独立
 * subagent sessionDir，任何改动不得让两个进程指向同一 session 文件写路径。
 */
export function buildPiSubagentSpawnArgs(params: PiSubagentSpawnParams): string[] {
  const args: string[] = ['--mode', 'rpc', '--session-dir', params.sessionDir]
  // resume：紧跟 --session-dir 追加 --session <file>，pi 续写原 session 文件。
  if (params.sessionFile) {
    args.push('--session', params.sessionFile)
  }
  args.push('--model', `${params.modelRef.provider}/${params.modelRef.id}`)
  if (params.thinkingLevel) {
    // thinking level 通过 model 后缀 :level 传递（pi CLI 约定）
    const lastIdx = args.length - 1
    args[lastIdx] = `${args[lastIdx]}:${params.thinkingLevel}`
  }
  if (params.agentTools && params.agentTools.length > 0) {
    args.push('--tools', params.agentTools.join(','))
  }
  if (params.appendSystemPromptPath) {
    args.push('--append-system-prompt', params.appendSystemPromptPath)
  }
  if (params.forkSource) {
    args.push('--fork', params.forkSource)
  }
  appendSkillArgs(args, params.skillPaths)
  const mf = params.mirrorFlags
  if (mf) {
    if (mf.noExtensions) args.push('--no-extensions')
    if (mf.approve) args.push('--approve')
    if (mf.noContextFiles) args.push('--no-context-files')
    appendExtensionArgs(args, mf.extensionPaths)
  }
  return args
}
