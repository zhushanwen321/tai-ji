/**
 * Command store（core 域迁移版）—— slash 命令（按 sessionId 分区）+ 全局应用命令（静态）。
 *
 * 来源：packages/renderer/src/stores/command.ts（pinia setup store）迁移为纯 factory。
 * 迁移约束（IF1）：不依赖 pinia；状态/操作函数语义逐条等价；消费方自行 .value（无 pinia unwrap）。
 * 壳旧 store 已随双轨收口（D7）删除，本 factory 是 command 状态的唯一实现。
 *
 * 与源 store 的差异（core 包约束 + PlatformPort）：
 *  - storage 经参数注入（KVStorage async 接口），不直连 localStorage。
 *  - shortcutOverrides 读写改 async：initShortcutOverrides() 由组合根 bootstrap 时序调用
 *    （首次渲染前回填）；setShortcutOverride 内存态立即更新 + storage.set 异步写，
 *    失败（配额满等）降级内存态（不抛出，对齐原 localStorage 语义）。
 *  - AppCommand 自 ./types 导入（同域）。
 *
 * 职责：
 *  - slash 命令：持有 runtime 推送的扩展命令（session.commands 通道），按 sessionId 隔离。
 *    解决的问题：CommandPopover 曾把 slashCommands 存在局部 ref，组件被 v-if 销毁重建
 *    （landing→panel 切换 / isGenerating 变化）时数据丢失，且 session.commands 只在
 *    切换/创建时推一次（runtime 不重广播 active session），重建后无补拉机制 → slash 浮层空。
 *    归位 store 后，组件重建读 store 即有数据（与 chat store 的 messages 分区同构，AGENTS.md 规则 7）。
 *  - 应用命令：全局内置命令（新建/搜索等），静态、与 session 无关。D-016 物理隔离——
 *    appCommands 独立 ref，session 切换只动 commandsBySession，不触发 appCommands 重算。
 *    两区物理分离：slash 命令带 / 前缀，与应用命令天然不撞（D-009）。
 *
 * 依赖方向：无（domain 间禁止互相 import；跨域协调由上层编排）。
 *
 * 数据流：
 *   runtime broadcast / RPC getCommands → CommandPopover 订阅 handler / useSidebar / useNewTaskFlow
 *     → commandStore.applyCommands(sid, cmds)
 *   CommandPopover.items / Turn.vue 用户气泡 chip → commandStore.getCommands(sid) 读取
 *   启动期 useCommandRegistry.registerApp → commandStore.registerApp(appCmds) 一次性写应用命令区
 */
import { computed, ref } from 'vue'
import type { CommandSourceInfo } from '@xyz-agent/shared'
import type { KVStorage } from '../../platform/port'
import type { AppCommand } from './types'

/** slash 命令项（runtime session.commands payload 归一化 + icon key 推断） */
export interface SessionCommand {
  id: string
  name: string
  /** source（extension/skill/builtin 等），用于 icon 推断与 kind 标签 */
  kind: string
  /** icon key（与 SLASH_ICON_COMPONENTS 同源：terminal/star/wrench/...） */
  icon: string
  description?: string
  /** 命令来源元信息（SKILL.md / extension 文件路径等），透传自 pi get_commands。
   *  CommandDocPanel 据此直接读文件渲染，不依赖 settingsStore.skills 扫描。 */
  sourceInfo?: CommandSourceInfo
}

/**
 * 一次性 slash 注入请求（SearchModal 写入 → Composer 消费 → clearPendingSlash 清除）。
 * 设计动机：SearchModal（Sidebar 中的全局浮层）无法直接拿到活跃 Panel 内 ComposerInput 的 DOM ref
 * （ref 链在 Composer 层终止，Composer 无 defineExpose 上抛 insertSlashChip）。
 * 用 store 作为一次性消息通道（写→消费→清），与现有 retryState/queueState 瞬时状态同构。
 * sessionId：注入目标 session（null = landing 态），消费侧 Composer 据此过滤，避免广播。
 * ts：时间戳，用于 watch 触发（同命令重复点击靠 ts 变化触发引用变化）。
 */
export interface PendingSlash {
  command: string
  icon?: string
  sessionId: string | null
  ts: number
  /**
   * skill 命令标记（由 SearchItem.isSkill 透传，来自 SessionCommand.kind === 'skill'）。
   * 消费侧（useCommandPopoverTrigger）据此分流：true → insertSkillChip（裸名 + location +
   * 多 chip 共存），否则维持 insertSlashChip 命令通路（单命令替换语义）。
   * 缺省/false 与既有语义完全一致（老写入方不传即维持命令 chip 行为）。
   */
  isSkill?: boolean
  /** skill 的 SKILL.md 绝对路径（SearchItem.location 透传，仅 isSkill 为真时有值） */
  location?: string
}

/** runtime 原始命令 payload（protocol.ts ServerMessageMap['session.commands']） */
export interface RawCommand {
  name: string
  description?: string
  source: string
  sourceInfo?: CommandSourceInfo
}

/**
 * builtin / 已知 extension 命令 → 专属 icon key SSOT。
 *
 * 对齐 demo v6 CommandPopover：每条命令独立 icon（非泛化 Star/Wrench）。
 * key 同时是 renderer `SLASH_ICON_COMPONENTS` 的查询键——core 只产出字符串 key，
 * renderer 把 key 绑定到 lucide 组件（core 不持有 view 资源）。
 *
 * 命令名均为去前缀裸名（`/compact`→`compact`、`/skill:commit`→`commit`），
 * 经 `bareCommandName` 归一化后命中此表。
 */
export const BUILTIN_COMMAND_ICON_KEYS = [
  'compact',
  'goal',
  'todos',
  'permission',
  'schedule',
  'auto-rename',
  'subagents',
  'workflows',
  'plan',
  'context-engineering',
  'context-stats',
  'setup-statusline',
  'commit', // skill 命令但 demo 赋予专属 Wand，单独列出
] as const

/** BUILTIN_COMMAND_ICON_KEYS 的 Set 视图（O(1) 命中判断） */
const BUILTIN_COMMAND_ICON_KEY_SET = new Set<string>(BUILTIN_COMMAND_ICON_KEYS)

/** 命令名归一化：剥离 `/` 与 `skill:` 路由前缀，返回裸命令名（icon key 查询用）。 */
export function bareCommandName(name: string): string {
  return name.replace(/^\//, '').replace(/^skill:/, '')
}

/**
 * 取命令专属 icon key（applyCommands / 视图层 icon 推断 SSOT）。
 * - builtin 命令命中（compact/goal/todos/...） → 返回命令名（key 直连 renderer 专属组件）
 * - 其他 skill 命令 → 'star'（泛化，视图层染 reasoning 紫）
 * - extension 命令 → 'terminal'
 * - 默认 → 'wrench'
 */
export function iconKeyForCommand(name: string, source: string): string {
  const bare = bareCommandName(name)
  if (BUILTIN_COMMAND_ICON_KEY_SET.has(bare)) return bare
  return iconKeyForSource(source)
}

/** source → icon key（extension→terminal, skill→star, 默认 wrench）。
 *  builtin 未命中时的 fallback（iconKeyForCommand 内部调用）。 */
function iconKeyForSource(source: string): string {
  if (source === 'extension') return 'terminal'
  if (source === 'skill') return 'star'
  return 'wrench'
}

/** storage key for shortcut overrides persistence */
const SHORTCUT_OVERRIDES_KEY = 'xyz-agent-shortcut-overrides'

/**
 * 创建 command store（纯 factory，无 pinia 依赖）。
 *
 * @param storage 平台 KVStorage 端口（组合根传 getPlatform().storage；单测传 mock）
 * @returns 返回形状与原 pinia setup store 一致（ref/computed 原样返回）：
 *  消费方迁移时 storeToRefs 语义由显式 .value 取代。
 */
export function createCommandStore(storage: KVStorage) {
  /** 按 sessionId 分区的命令表（UC-2 隔离，同 chat store messages 模式） */
  const commandsBySession = ref<Map<string, SessionCommand[]>>(new Map())

  /** 用户自定义快捷键覆盖（commandId → key，如 'new-session' → 'j'）。
   *  经注入的 storage 持久化（async），启动时 initShortcutOverrides 恢复。 */
  const shortcutOverrides = ref<Record<string, string>>({})

  /**
   * 全局应用命令区（D-016 物理隔离）：静态、与 session 无关。
   * 独立 ref —— session 切换只动 commandsBySession，不触发 appCommands 重算（AC-2.2）。
   * 启动时 registerApp 一次性写入，组件重建读 store 即有数据（同 slash 命令归位动机）。
   */
  const appCommands = ref<AppCommand[]>([])

  /**
   * 一次性 slash 注入请求槽位（store 驱动模式）。
   * 写入方：useSearchJump.confirmCommand（slash 分支）。
   * 消费方：Composer watch(pendingSlash) 按 sessionId 过滤后调 insertSlashChip + clearPendingSlash。
   * null 表示无待消费请求。
   */
  const pendingSlash = ref<PendingSlash | null>(null)

  /**
   * 写入 slash 注入请求（幂等覆盖：连续调用以最后一次为准，非累加——与 registerApp 同语义）。
   * ts 由调用方不传，内部用 Date.now() 标记（供 watch 触发 + 重复点击同命令时引用变化）。
   */
  function requestSlashInjection(payload: Omit<PendingSlash, 'ts'>): void {
    pendingSlash.value = { ...payload, ts: Date.now() }
  }

  /** 消费清除（Composer 消费后立即调用，防重复注入 + 防 watch 残留触发） */
  function clearPendingSlash(): void {
    pendingSlash.value = null
  }

  /** 取指定 session 的命令（无则空数组，不写入 Map） */
  function getCommands(sessionId: string): SessionCommand[] {
    return commandsBySession.value.get(sessionId) ?? []
  }

  /** 按命令名查找（用于用户气泡 chip 解析：content 匹配已知命令） */
  function findCommandByName(sessionId: string, name: string): SessionCommand | undefined {
    return getCommands(sessionId).find((c) => c.name === name)
  }

  /** 响应式视图：指定 session 的命令（供 CommandPopover computed 订阅） */
  function commandsOf(sessionId: string) {
    return computed(() => commandsBySession.value.get(sessionId) ?? [])
  }

  /**
   * slash 命令响应式视图（同 commandsOf 语义，显式命名供 useCommandRegistry 调用，
   * 明确读的是 per-session slash 区而非全局应用命令区）。
   */
  function slashCommandsOf(sessionId: string) {
    return commandsOf(sessionId)
  }

  /**
   * 注册应用命令（启动期一次性）。幂等覆盖：重复调用以最后一次为准，非累加（AC-2.4）。
   * 不写 commandsBySession —— 应用命令与 session 无关（D-016 物理隔离）。
   */
  function registerApp(cmds: AppCommand[]): void {
    appCommands.value = cmds
  }

  /** 写入命令（runtime 推送 / RPC 拉取后调用）。不可变更新确保 Map 响应性触发 */
  function applyCommands(sessionId: string, raw: RawCommand[]): void {
    const normalized = raw.map((c) => ({
      id: c.name,
      name: c.name,
      kind: c.source,
      icon: iconKeyForCommand(c.name, c.source),
      description: c.description,
      sourceInfo: c.sourceInfo,
    }))
    commandsBySession.value = new Map(commandsBySession.value).set(sessionId, normalized)
  }

  /**
   * 设置快捷键覆盖（commandId → key）。null 清除自定义，恢复默认。
   * 内存态立即更新（响应式不阻塞 UI），storage.set 异步写；失败（配额满）降级内存态。
   */
  async function setShortcutOverride(commandId: string, key: string | null): Promise<void> {
    const next = { ...shortcutOverrides.value }
    if (key === null) {
      delete next[commandId]
    } else {
      next[commandId] = key
    }
    shortcutOverrides.value = next
    try {
      await storage.set(SHORTCUT_OVERRIDES_KEY, JSON.stringify(next))
    } catch (e) {
      // storage 写失败（如配额满）——非关键，overrides 仍在内存态生效
      void e
    }
  }

  /**
   * 从 storage 恢复快捷键覆盖（组合根 bootstrap 时序调用，首次渲染前）。
   * 解析失败/异常降级 {}，不抛出。
   */
  async function initShortcutOverrides(): Promise<void> {
    try {
      const raw = await storage.get(SHORTCUT_OVERRIDES_KEY)
      shortcutOverrides.value = raw ? JSON.parse(raw) : {}
    } catch {
      shortcutOverrides.value = {}
    }
  }

  /** 清除指定 session 的命令（session 销毁编排调：SessionCleanupHooks.clearSlashCommands →
   *  壳层 useCommandStore().clearCommands，[G1 / 2026-09-14 内存审计 §3.4] 接线） */
  function clearCommands(sessionId: string): void {
    if (!commandsBySession.value.has(sessionId)) return
    commandsBySession.value = new Map(commandsBySession.value)
    commandsBySession.value.delete(sessionId)
  }

  return {
    commandsBySession,
    appCommands,
    shortcutOverrides,
    pendingSlash,
    getCommands,
    findCommandByName,
    commandsOf,
    slashCommandsOf,
    registerApp,
    applyCommands,
    clearCommands,
    setShortcutOverride,
    requestSlashInjection,
    clearPendingSlash,
    initShortcutOverrides,
  }
}
