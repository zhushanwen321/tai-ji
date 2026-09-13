/**
 * Pi 启动参数预设数据模型。
 *
 * 设计文档：docs/architecture/pi-launch-presets.md
 *
 * 预设是一组 pi 启动参数的命名集合，用户可创建/编辑/删除。
 * 内置预设 3 个（builtin:true，不可删除），自定义预设任意编辑。
 */

/** 工具模式：决定如何处理工具列表 */
export type ToolMode = 'all' | 'allowlist' | 'denylist' | 'none'

/**
 * Extension 模式：决定如何处理 extension 列表。
 *
 * 注意：pi 无原生 extension 黑名单。denylist 由 runtime 先列出全部已启用 extension，
 * 排除用户指定的 deniedExtensions 后，作为 allowlist 注入（见设计文档 §2.4）。
 *
 * builtin infrastructure 级扩展（mandatory-extensions.json SSOT，如
 * @zhushanwen/pi-system-prompt / pi-msg-id-mapper）不受 extensionMode 影响（任何
 * 模式下都注入，extension-filter.ts applyPresetMode 的 presetOverridable=false）；
 * feature 级 builtin 与用户扩展同受 preset 筛选，见设计文档 §2.3（builtin→npm
 * 迁移后形态）。
 */
export type ExtensionMode = 'all' | 'allowlist' | 'denylist' | 'none'

/**
 * pi thinking 值域全集 SSOT（W2 值域对齐，pi-assumption-remediation A-03）。
 *
 * 锚点：pi 0.84.1 实装版 `node_modules/@earendil-works/pi-coding-agent/dist/cli/args.js:6`
 * `VALID_THINKING_LEVELS = ["off","minimal","low","medium","high","xhigh","max"]`；
 * runtime 协议镜像 = `packages/runtime/src/infra/pi/pi-protocol.ts` 的 `PiThinkingLevel`。
 * shared 不能反向 import runtime（依赖方向），双向一致性由 session-lifecycle.ts
 * 的编译期类型断言锁定（该文件同时 import 两边）。
 * 维护注：升级 pi 时 diff 上面锚点行，同步本数组（漏同步会在编译期报错，不会静默）。
 */
export const PI_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/**
 * 思考级别。从 PI_THINKING_LEVELS 全集派生（W2 起不再手写联合——曾因手写值域缺
 * 'max' 被 runtime 白名单静默丢弃，composer 最高档实际永不生效，A-03）。
 * 注意：pi 参数名是 --thinking（不是 --thinking-level）。
 */
export type ThinkingLevel = (typeof PI_THINKING_LEVELS)[number]

/** pi 内置工具列表（pi 硬编码 7 个，0.84.1 实装锚点 dist/core/tools/index.js:81-89 createAllToolDefinitions） */
export const BUILTIN_TOOLS = ['read', 'write', 'bash', 'edit', 'grep', 'find', 'ls'] as const

/** Pi 启动参数预设 */
export interface PiLaunchPreset {
  /** 预设唯一 ID（内置用 'builtin:xxx'，自定义用 UUID） */
  id: string
  /** 预设名称（显示用） */
  name: string
  /** 预设描述 */
  description?: string
  /** 是否内置（不可删除/重命名） */
  builtin: boolean
  /** 排序权重（越小越靠前） */
  order: number

  // ── 工具配置 ──
  /** 工具模式 */
  toolMode: ToolMode
  /** allowlist 模式下允许的工具名列表 */
  allowedTools?: string[]
  /** denylist 模式下禁用的工具名列表 */
  deniedTools?: string[]

  // ── Extension 配置 ──
  /** Extension 模式 */
  extensionMode: ExtensionMode
  /** allowlist 模式下允许的 extension 名列表 */
  allowedExtensions?: string[]
  /** denylist 模式下禁用的 extension 名列表 */
  deniedExtensions?: string[]

  // ── 模型配置（可选覆盖） ──
  /**
   * 覆盖默认模型（如 'anthropic/claude-sonnet-4'）。不设则用全局默认。
   * 优先级：Landing Model Chip > preset.modelOverride > 全局默认（见设计文档 §5.2）。
   */
  modelOverride?: string
  /**
   * 覆盖思考级别。
   * 优先级：Landing Thinking Chip > preset.thinkingLevel > 全局默认。
   */
  thinkingLevel?: ThinkingLevel

  // ── 其他配置 ──
  /** 禁用所有 skill（映射 --no-skills） */
  noSkills?: boolean
  /** 禁用 context files（AGENTS.md/CLAUDE.md，映射 --no-context-files） */
  noContextFiles?: boolean
}

/** 内置预设 ID 常量 */
export const BUILTIN_PRESET_IDS = {
  FULL: 'builtin:full',                // 全工具模式
  ORCHESTRATOR: 'builtin:orchestrator', // orchestrator 模式
  READONLY: 'builtin:readonly',         // 只读模式
} as const

/** 默认内置预设列表 */
export const DEFAULT_PRESETS: PiLaunchPreset[] = [
  {
    id: BUILTIN_PRESET_IDS.FULL,
    name: '全工具模式',
    description: '所有工具和扩展可用，适合大部分任务',
    builtin: true,
    order: 0,
    toolMode: 'all',
    extensionMode: 'all',
  },
  {
    id: BUILTIN_PRESET_IDS.ORCHESTRATOR,
    name: 'Orchestrator',
    description: '主 Agent 只做协调，实际执行由 SubAgent 完成',
    builtin: true,
    order: 1,
    toolMode: 'denylist',
    deniedTools: ['read', 'write', 'bash', 'edit'],
    extensionMode: 'all',
  },
  {
    id: BUILTIN_PRESET_IDS.READONLY,
    name: '只读模式',
    description: '只能查看代码，适合 Code Review',
    builtin: true,
    order: 2,
    toolMode: 'allowlist',
    allowedTools: ['read', 'grep', 'find', 'ls'],
    extensionMode: 'all',
  },
]

/**
 * 预设使用统计条目（FR-14）。
 * 每个 preset id 对应一条，记录使用次数和最后使用时间。
 */
export interface PresetUsageEntry {
  /**
   * 使用次数（session 创建时 +1）。
   *
   * @remarks count >= 0
   */
  count: number
  /**
   * 最后使用时间。
   *
   * @remarks Unix timestamp (ms)
   */
  lastUsed: number
}

/**
 * pi-presets.json 的持久化形状（~/.xyz-agent/pi-presets.json）。
 *
 * 存：用户自定义预设 + 内置预设的用户编辑副本（builtin 字段仍 true）+ 默认预设 id。
 * 位置由 getDataDir() 推导（设计文档 §1.4）。前后端共享形状故放 shared。
 */
export interface PiPresetsFile {
  /** 用户自定义预设 + 内置预设的用户编辑副本（builtin 字段仍 true） */
  presets: PiLaunchPreset[]
  /** 用户设置的「设为默认」preset id，全局生效（设计文档 §5.3）。缺省 'builtin:full'。 */
  defaultPresetId?: string
  /** 预设使用统计（FR-14）：key=presetId, value=使用次数+最后使用时间 */
  usage?: Record<string, PresetUsageEntry>
  /** schema 版本，便于未来迁移 */
  version: 1
}

/**
 * 预设导出 payload（FR-13 导入/导出）。
 *
 * runtime exportPresets 只序列化 presets/defaultPresetId/version 三字段，
 * **故意排除 usage**（runtime 本地状态，不随预设分享）。
 * 与 PiPresetsFile 区别：PiPresetsFile 是磁盘全量持久化形状，PresetExportPayload 是
 * 分享用精简形状。
 *
 * protocol.ts 中 `preset.export` reply 与 `preset.import` payload 的 json 字段
 * 是 `JSON.stringify(PresetExportPayload)` 的结果。
 */
export interface PresetExportPayload {
  /** 导出的预设列表（内置 + 自定义） */
  presets: PiLaunchPreset[]
  /** 默认预设 id（可选，导出时若用户选择包含默认设置） */
  defaultPresetId?: string
  /** schema 版本（与 PiPresetsFile.version 对齐，当前为 1） */
  version: number
}

// ── 运行时类型守卫 ─────────────────────────────────────────────

/** ToolMode 合法值集合（isPiLaunchPreset 校验用）。 */
const TOOL_MODES: readonly ToolMode[] = ['all', 'allowlist', 'denylist', 'none']

/** ExtensionMode 合法值集合（isPiLaunchPreset 校验用）。 */
const EXTENSION_MODES: readonly ExtensionMode[] = ['all', 'allowlist', 'denylist', 'none']

/**
 * 运行时检查值是否为 PiLaunchPreset（含必需字段 id/name/builtin/order/toolMode/extensionMode）。
 *
 * 校验 6 个必填字段的类型 + toolMode/extensionMode 的字面量约束。
 * 可选字段（description/allowedTools/deniedTools/modelOverride/thinkingLevel 等）不强制校验——
 * 消费方按需在取用时再 narrow（与 isMessage/isSessionSummary 同策略，只保证必填字段契约）。
 *
 * 参考 protocol.ts 的 isMessage / isSessionSummary 写法。
 */
export function isPiLaunchPreset(value: unknown): value is PiLaunchPreset {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    typeof v.id === 'string' &&
    typeof v.name === 'string' &&
    typeof v.builtin === 'boolean' &&
    typeof v.order === 'number' &&
    typeof v.toolMode === 'string' &&
    (TOOL_MODES as readonly string[]).includes(v.toolMode) &&
    typeof v.extensionMode === 'string' &&
    (EXTENSION_MODES as readonly string[]).includes(v.extensionMode)
  )
}
