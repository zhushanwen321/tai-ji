/**
 * scheduler-manager —— taiji builtin plugin（设计 plugin-header-action-modal-points 首消费者，
 * 规范验收样本；任务管理数据面零 scheduler 专属 API）。
 *
 * 点位使用（设计 §3.4）：
 * - AP-1 headerAction：本会话启用任务数徽标（空任务无数字、按钮常驻——常驻由
 *   core builtinContributions 静态声明承担，不依赖数据量）；刷新触发 = entry 失效
 *   订阅 + onDidActivateSession 补拉（非写入驱动，场景 9）。
 * - AP-2 modal：showModal(modalId, {sessionId}) 后立即 views.update（首帧空白 =
 *   一次 RPC 往返）；内容树严格按 §3.1.1 字段操作对账表组装，表外零元素（G6）。
 * - AP-3 action-bar：每任务三动作（暂停/恢复 toggle、立即执行 run、删除 rm）。
 * - AP-4 数据面：per-session 累计 entries（首拉全量 + sinceEntryId 增量 append），
 *   折叠始终对累计全量调共享 replayFoldEntries（前缀依赖语义不被破坏）；游标失效
 *   （Entry not found）→ 丢弃累计全量重拉自愈（E11）；无 client → SESSION_NOT_ACTIVE
 *   → 按会话 status 分「恢复中/不可用」两态（E4）。
 *
 * 写路径（设计 §3.3 D6）：四个动作只拼白名单子命令字面量 on|off|rm|run + 折叠快照中
 * 存在的 8 位 hex id（快照无该 id → TASK_NOT_FOUND 行内提示、不发命令，E5——防
 * /schedule 参数路由落空进创建分支，§2.4 坑 3），经 sendMessage({requireCommand:
 * 'schedule'}) 原子校验后发 /schedule 命令；回执 {accepted, reason?} 驱动行内 notice
 * （E7/E14；运行面分支只看 accepted，reason 仅文案面）。不乐观更新——快照与游标由
 * 失效订阅驱动刷新（C-pi-13 不撒谎）。
 *
 * 按钮灰置（E13，插件侧判定）：getCommands(sessionId) 查 'schedule' 命令名（纯查询）
 * → 未注册 = disabled + tooltip（宿主渲染端按 availability 三态合成 i18n tooltip，
 * SDK 无 i18n 能力、插件不推文案）；SESSION_NOT_ACTIVE = 无法判定 → 保持上次值
 * （首次缺省可点，失败由 E14 写路径兜底）；会话激活/从恢复窗口走出后重判。
 *
 * open 的 sessionId 来源：headerAction 点击链（HeaderActionsHost onClick →
 * CommandRegistry.execute(commandId)）不携带会话上下文，插件以 onDidActivateSession
 * 维护焦点会话（渲染端焦点会话 = 最后一次 session.switch 成功会话；首屏 landing→
 * selectSession 亦经 switch）+ activate 时 sessions.list() 取 lastActiveAt 最大者
 * 兜底冷启动竞态（显式 list API，不用 getActive()——其语义是"正在生成的会话"）。
 *
 * 生命周期：订阅挂点 = 会话首次需要徽标/列表时（ensureMirror 唯一入口）；会话销毁
 * 由 onDidDestroySession 拆订阅清镜像；Worker 侧资源（timer/订阅）全部入 Disposable
 * 由 runtime 清理族兜底。
 */
import type { PluginContext } from '../../../packages/runtime/src/services/plugin-service/plugin-types.js'
// 共享折叠器/格式化器导入形态：**相对路径直指包源码 barrel**，不用裸包名。
// 根因（P4 真机实测）：dev 形态 runtime 以 tsx 运行，Worker 的 import 对产物
// index.js 走 tsx 的 .js→.ts 映射、实际加载 index.ts 源码——resources/plugins 不在
// pnpm workspace、目录链上无 node_modules，裸包名 '@zhushanwen/extension-protocol'
// 在源码形态下解析不到（ERR_MODULE_NOT_FOUND，打包版走产物不受影响）。相对路径在
// 两种形态下都成立：esbuild --bundle 把包源码内联进产物（自包含），tsx 直接编译 .ts。
// prepare-builtin-plugins.sh 的 --alias 保留作裸包名兜底，不再被本插件消费。
import {
  TASK_ENTRY_TYPE,
  replayFoldEntries,
  formatSchedule,
  formatRelativeTime,
} from '../../../packages/extension-protocol/src/index.ts'
import type {
  ScheduledTask,
  SchedulerEntryLike,
  GuiComponent,
  StatItem,
  TreeItem,
} from '../../../packages/extension-protocol/src/index.ts'

/** 插件可用 API 面（Phase2AgentAPI 的本地别名，签名可读性） */
type Api = PluginContext['api']
/** SDK Disposable 结构别名（dispose(): void） */
interface DisposableLike {
  dispose(): void
}

// ── 常量 ─────────────────────────────────────────────────────────

const PLUGIN_ID = 'scheduler-manager'
const HEADER_ACTION_ID = 'scheduler-manager.open'
const MODAL_ID = 'scheduler-manager.panel'
/** 渲染端平铺命名（PluginModalHost.vue：viewId = modal-<pluginId>-<modalId>） */
const MODAL_VIEW_ID = `modal-${PLUGIN_ID}-${MODAL_ID}`
/** per-session 任务上限（scheduler runtime MAX_TASKS 同值；统计行分母，E8） */
const MAX_TASKS = 50
/** pi 侧 /schedule 扩展命令名（requireCommand 与 E13 判定同源） */
const SCHEDULE_COMMAND_NAME = 'schedule'

/** 失效信号防抖合并窗口（ms）：风暴合并成一次重拉（对齐 session-records 先例量级） */
const READ_DEBOUNCE_MS = 200
/**
 * E4 恢复窗口自动重试间隔/次数（2s × 5 = 10s 上界）。耗尽后停自动重试、提示升级为
 * 「恢复超时」（含恢复动作）；失效/激活信号（scheduleRefresh）重置预算后可获得新一轮重试。
 */
const READ_RETRY_MS = 2_000
const READ_RETRY_MAX = 5

const EMPTY_HINT =
  '本会话还没有定时任务 —— 在对话里说，或手敲 /schedule <排期> <内容> 创建。'

// ── 纯函数（无状态、可独立冒烟：id 校验 / 命令串白名单 / 排序 / 树组装）─────────

/** 写路径允许的四个子命令字面量（/schedule 参数路由落空会进创建分支，§2.4 坑 3） */
export type ScheduleWriteSubcommand = 'on' | 'off' | 'rm' | 'run'

const WRITE_SUBCOMMANDS: readonly ScheduleWriteSubcommand[] = ['on', 'off', 'rm', 'run']

/** 任务 id 形态守卫：8 位 hex（pi 侧 taskId 生成形态，u-probe P2 实测核对） */
export function isValidTaskId(id: unknown): id is string {
  return typeof id === 'string' && /^[0-9a-f]{8}$/.test(id)
}

/**
 * 构造 /schedule 写命令串。白名单子命令 + 8 位 hex id 双重校验，任一不过返回 null
 * （调用方必须不发命令——脏输入拼进 /schedule 会漏进模型或误建任务）。
 */
export function buildScheduleCommand(sub: ScheduleWriteSubcommand, taskId: string): string | null {
  if (!WRITE_SUBCOMMANDS.includes(sub)) return null
  if (!isValidTaskId(taskId)) return null
  return `/schedule ${sub} ${taskId}`
}

/**
 * 展示排序（设计 §3.1.1）：启用的按 nextRunAt 升序在前，停用的按创建序垫后
 * （与扩展文本视图 ●启用/○停用 语义对齐；service.list() 不排序，插件自己排）。
 */
export function sortTasksForDisplay(tasks: ScheduledTask[]): ScheduledTask[] {
  const enabled = tasks.filter((t) => t.enabled).sort((a, b) => a.nextRunAt - b.nextRunAt)
  const disabled = tasks.filter((t) => !t.enabled).sort((a, b) => a.createdAt - b.createdAt)
  return [...enabled, ...disabled]
}

/**
 * nextRunAt 两态文案（仅 enabled 时显示）：已过期 → 「即将触发」（插件侧文案——
 * formatRelativeTime 对过去时间返回 "4m ago"，拼成"下次 4m ago"是反话）；未来 →
 * 「下次 」+ 共享格式化器（±5s 窗口内返回 "now"，即设计的两态「下次 now / 即将触发」）。
 */
export function formatNextRunLabel(task: ScheduledTask, now: number = Date.now()): string {
  if (task.nextRunAt <= now) return '即将触发'
  return `下次 ${formatRelativeTime(task.nextRunAt, now)}`
}

/** 每任务 list-tree 行：name 标题 + 排期/下次（或已停用）+ 执行次数/上次成败 +（失败时）原因 */
export function buildTaskRows(task: ScheduledTask, now: number = Date.now()): TreeItem[] {
  const rows: TreeItem[] = [{ label: task.name, depth: 0 }]
  rows.push({
    label: task.enabled
      ? `${formatSchedule(task.schedule, task.kind)} · ${formatNextRunLabel(task, now)}`
      : `${formatSchedule(task.schedule, task.kind)} · 已停用`,
    depth: 1,
  })
  const runParts = [`已执行 ${task.runCount} 次`]
  if (task.lastRunAt !== undefined) {
    const mark =
      task.lastStatus === 'failed' ? ' · 失败' : task.lastStatus === 'success' ? ' · 成功' : ''
    runParts.push(`上次 ${formatRelativeTime(task.lastRunAt, now)}${mark}`)
  }
  rows.push({ label: runParts.join(' · '), depth: 1 })
  // lastError 仅失败时追加一行原因（任务级单值"最近一次"，不是逐条历史）
  if (task.lastStatus === 'failed' && task.lastError) {
    rows.push({ label: task.lastError, depth: 1 })
  }
  return rows
}

/** 每任务 action-bar：暂停/恢复 + 立即执行 + 删除（danger）。args 只含标量（AP-3 校验）。 */
export function buildTaskActions(task: ScheduledTask): GuiComponent {
  return {
    type: 'action-bar',
    props: {
      items: [
        {
          id: `t:${task.id}:toggle`,
          label: task.enabled ? '暂停' : '恢复',
          commandId: 'scheduler-manager.toggle',
          args: { id: task.id, enabled: !task.enabled },
        },
        { id: `t:${task.id}:run`, label: '立即执行', commandId: 'scheduler-manager.run', args: { id: task.id } },
        {
          id: `t:${task.id}:del`,
          label: '删除',
          kind: 'danger',
          commandId: 'scheduler-manager.delete',
          args: { id: task.id },
        },
      ],
    },
  }
}

/**
 * modal 内容树（§3.1.1 对账表逐项：stats-line 统计行 + 每任务「list-tree 行 +
 * action-bar 操作」一对 + 至多 1 行 ansi-text（空态提示或操作 notice），零表外元素）。
 */
export function buildModalTree(tasks: ScheduledTask[], opts?: { notice?: string }): GuiComponent[] {
  const enabledCount = tasks.filter((t) => t.enabled).length
  const stats: GuiComponent = {
    type: 'stats-line',
    props: {
      items: [
        { label: '启用', value: String(enabledCount) },
        { label: '停用', value: String(tasks.length - enabledCount) },
        { label: '共', value: `${tasks.length} / 上限 ${MAX_TASKS}` },
      ] satisfies StatItem[],
    },
  }
  if (tasks.length === 0) {
    return [stats, { type: 'ansi-text', props: { lines: [opts?.notice ?? EMPTY_HINT] } }]
  }
  const children: GuiComponent[] = [stats]
  for (const task of sortTasksForDisplay(tasks)) {
    children.push({ type: 'list-tree', props: { items: buildTaskRows(task) } })
    children.push(buildTaskActions(task))
  }
  if (opts?.notice) children.push({ type: 'ansi-text', props: { lines: [opts.notice] } })
  return children
}

// ── 错误判定（对齐 runtime 形态：错误码优先，message 兜底）────────────────────

function toMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** SESSION_NOT_ACTIVE（u2d 读 API 的 live-only 拒绝，错误码 + message 双匹配） */
function isSessionNotActive(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code
  if (code === 'SESSION_NOT_ACTIVE') return true
  return /SESSION_NOT_ACTIVE/.test(toMessage(e))
}

/** 游标失效（pi 抛 Entry not found；与 runtime trace-sync 同款判定） */
function isEntryNotFound(e: unknown): boolean {
  return /^entry not found/i.test(toMessage(e))
}

// ── per-session 镜像状态机（游标 / 防抖 / E4 两态 / E13 判定值）─────────────────

interface ReadFailure {
  kind: 'recovering' | 'unavailable'
  reason: string
}

interface SessionMirror {
  sessionId: string
  /** 累计 entries（首拉全量 + 增量 append；事件只做失效不直写——数据唯一入口是 readEntries） */
  entries: SchedulerEntryLike[]
  /** 游标（末条 entryId → sinceEntryId 增量） */
  cursor?: string
  /** 折叠过滤必需：replayFoldEntries 按 ownerSessionFile 剔非 owner 任务（fork 继承） */
  sessionFile?: string
  debounceTimer: ReturnType<typeof setTimeout> | null
  refreshInFlight: Promise<void> | null
  readFailure: ReadFailure | null
  retryTimer: ReturnType<typeof setTimeout> | null
  retryCount: number
  /** E13 上次判定值：null = 未判定（首次缺省可点）；true/false = 上次 disabled 值（unknown 态保持） */
  commandDisabled: boolean | null
  /** 徽标当前值（空任务 undefined；读失败态保持上次值——全量覆盖语义下插件每次重推完整状态） */
  badge?: string
  /** 最近一次操作结果（行内 notice，至多 1 行） */
  notice: string | null
  disposables: DisposableLike[]
}

const mirrors = new Map<string, SessionMirror>()
/** 渲染端焦点会话（open 链无会话上下文，见头注；didActivate 维护 + list() 兜底） */
let focusSessionId: string | null = null

function teardownMirror(sessionId: string): void {
  const mirror = mirrors.get(sessionId)
  if (!mirror) return
  if (mirror.debounceTimer) clearTimeout(mirror.debounceTimer)
  if (mirror.retryTimer) clearTimeout(mirror.retryTimer)
  mirror.debounceTimer = null
  mirror.retryTimer = null
  for (const d of mirror.disposables) {
    try {
      d.dispose()
    } catch (e) {
      // 释放失败不阻断其余清理（订阅表由 runtime clearForSession 兜底）；出声留诊断
      console.warn('[scheduler-manager] dispose failed during teardown:', toMessage(e))
    }
  }
  mirrors.delete(sessionId)
}

/**
 * 订阅挂点 = 会话首次需要徽标/列表时（didActivate / open / 冷启动兜底三入口汇聚于此）。
 * badge 更新依赖同一失效订阅，故 modal 开关不挂解（设计 AP-4）。
 */
function ensureMirror(api: Api, sessionId: string, sink: DisposableLike[]): SessionMirror {
  const existing = mirrors.get(sessionId)
  if (existing) return existing
  const mirror: SessionMirror = {
    sessionId,
    entries: [],
    debounceTimer: null,
    refreshInFlight: null,
    readFailure: null,
    retryTimer: null,
    retryCount: 0,
    commandDisabled: null,
    notice: null,
    disposables: [],
  }
  mirrors.set(sessionId, mirror)
  const sub = api.sessions.onEntriesInvalidated(sessionId, TASK_ENTRY_TYPE, (sid) => {
    scheduleRefresh(api, sid)
  })
  mirror.disposables.push(sub)
  sink.push(sub)
  scheduleRefresh(api, sessionId)
  void reevaluateCommandAvailability(api, mirror)
  return mirror
}

/** 失效信号 → 防抖合并 → 一次重拉。外部信号 = 会话侧新证据，重置恢复重试预算。 */
function scheduleRefresh(api: Api, sessionId: string): void {
  const mirror = mirrors.get(sessionId)
  if (!mirror) return
  mirror.retryCount = 0
  if (mirror.debounceTimer) clearTimeout(mirror.debounceTimer)
  mirror.debounceTimer = setTimeout(() => {
    mirror.debounceTimer = null
    void refresh(api, sessionId)
  }, READ_DEBOUNCE_MS)
}

/** 并发失效共享一次拉取（in-flight 复用） */
function refresh(api: Api, sessionId: string): Promise<void> {
  const mirror = mirrors.get(sessionId)
  if (!mirror) return Promise.resolve()
  if (mirror.refreshInFlight) return mirror.refreshInFlight
  mirror.refreshInFlight = doRefresh(api, mirror).finally(() => {
    mirror.refreshInFlight = null
  })
  return mirror.refreshInFlight
}

async function doRefresh(api: Api, mirror: SessionMirror): Promise<void> {
  try {
    const envelope = await api.sessions.readEntries(
      mirror.sessionId,
      mirror.cursor !== undefined ? { customType: TASK_ENTRY_TYPE, sinceEntryId: mirror.cursor } : { customType: TASK_ENTRY_TYPE },
    )
    if (envelope.sessionFile !== undefined) mirror.sessionFile = envelope.sessionFile
    if (envelope.entries.length > 0) mirror.entries.push(...envelope.entries)
    if (envelope.leafEntryId !== undefined) mirror.cursor = envelope.leafEntryId
    const hadFailure = mirror.readFailure !== null
    mirror.readFailure = null
    mirror.retryCount = 0
    if (mirror.retryTimer) {
      clearTimeout(mirror.retryTimer)
      mirror.retryTimer = null
    }
    await pushTreeAndBadge(api, mirror)
    // 从恢复窗口走出后重判 E13（restore 完成 → /schedule 已注册）
    if (hadFailure) await reevaluateCommandAvailability(api, mirror)
  } catch (e) {
    if (isEntryNotFound(e)) {
      // E11 游标失效 → 丢弃累计全量重拉（自愈，用户无感）。全量（无 cursor）理论上
      // 不会再触发该错误；若触发按恢复窗口处理防循环。
      if (mirror.cursor !== undefined || mirror.entries.length > 0) {
        // 自愈对用户无感，但必须对排查可见（pi 侧 entry 截断/会话重建的证据链入口）
        console.warn(
          `[scheduler-manager] cursor invalidated, full re-pull (session=${mirror.sessionId})`,
        )
        mirror.entries = []
        mirror.cursor = undefined
        void refresh(api, mirror.sessionId)
        return
      }
    }
    await handleReadFailure(api, mirror, e)
  }
}

/** E4 读两态：dead/error 终态 → 「会话不可用」；其余（active/idle/done/stopped）→ 恢复中 + 自动重试 */
async function handleReadFailure(api: Api, mirror: SessionMirror, e: unknown): Promise<void> {
  const reason = toMessage(e)
  let terminal = false
  try {
    const status = (await api.sessions.get(mirror.sessionId))?.status
    terminal = status === 'dead' || status === 'error'
  } catch (e) {
    // 状态查询失败：按可恢复处理（保守——不因元信息缺失宣判会话死亡；读错误本身
    // 已写入 readFailure 推给用户），出声仅补诊断
    console.warn(
      '[scheduler-manager] status query failed, treating as recovering:',
      toMessage(e),
    )
  }
  if (terminal) {
    mirror.readFailure = { kind: 'unavailable', reason }
    if (mirror.retryTimer) {
      clearTimeout(mirror.retryTimer)
      mirror.retryTimer = null
    }
    await pushTreeAndBadge(api, mirror)
    return
  }
  mirror.readFailure = { kind: 'recovering', reason }
  await pushTreeAndBadge(api, mirror)
  scheduleRetry(api, mirror)
}

/** 恢复窗口自动重试（有界：READ_RETRY_MAX 次后停自动重试，等失效/激活信号重置预算再试） */
function scheduleRetry(api: Api, mirror: SessionMirror): void {
  if (mirror.retryTimer) return
  if (mirror.retryCount >= READ_RETRY_MAX) return // 预算耗尽：不重置不清零（耗尽态必须稳定，提示才停在「恢复超时」）
  mirror.retryCount = 0
  const tick = (): void => {
    mirror.retryTimer = null
    mirror.retryCount += 1
    void refresh(api, mirror.sessionId)
    if (mirror.retryCount < READ_RETRY_MAX && mirror.readFailure?.kind === 'recovering') {
      mirror.retryTimer = setTimeout(tick, READ_RETRY_MS)
    }
  }
  mirror.retryTimer = setTimeout(tick, READ_RETRY_MS)
}

/** 折叠当前快照（始终对累计全量——前缀依赖语义，设计 §3.4 增量衔接） */
function foldTasks(mirror: SessionMirror): Map<string, ScheduledTask> {
  return replayFoldEntries(mirror.entries, mirror.sessionFile, {
    warn: (message) => console.warn(`[scheduler-manager] ${message}`),
  })
}

/**
 * 推 modal 树 + headerAction 徽标（每轮数据刷新统一出口）。
 * 读失败态 = 列表区提示（不渲染陈旧行、不显示假空态，E4）；徽标保持上次值。
 */
async function pushTreeAndBadge(api: Api, mirror: SessionMirror): Promise<void> {
  const failure = mirror.readFailure
  let tree: GuiComponent[]
  if (failure) {
    // F4：重试预算耗尽（retryCount 停在 MAX，scheduleRetry 不再武装）→ 提示升级为含
    // 恢复动作；重试进行中（预算内）保持原文案
    const line =
      failure.kind === 'unavailable'
        ? `会话不可用：${failure.reason} —— 请从侧栏重新打开该会话`
        : mirror.retryCount >= READ_RETRY_MAX
          ? '会话恢复超时，请从侧栏重新打开该会话'
          : '会话正在恢复，请稍候…'
    tree = [{ type: 'ansi-text', props: { lines: [line] } }]
  } else {
    const tasks = Array.from(foldTasks(mirror).values())
    tree = buildModalTree(tasks, { notice: mirror.notice ?? undefined })
    const enabledCount = tasks.filter((t) => t.enabled).length
    mirror.badge = enabledCount > 0 ? String(enabledCount) : undefined
  }
  try {
    await api.views.update(MODAL_VIEW_ID, tree, { sessionId: mirror.sessionId })
  } catch (e) {
    // best-effort：modal 可能刚被关闭（视图已不存在），不重抛——下一轮失效刷新/推送重试收敛
    console.warn('[scheduler-manager] views.update failed:', toMessage(e))
  }
  await pushHeaderAction(api, mirror)
}

/** headerAction 推送（字段级当前值全量重推——store set 为全量覆盖，保持语义由插件侧维护） */
async function pushHeaderAction(api: Api, mirror: SessionMirror): Promise<void> {
  try {
    await api.ui.updateHeaderAction(HEADER_ACTION_ID, {
      sessionId: mirror.sessionId,
      ...(mirror.badge !== undefined ? { badge: mirror.badge } : {}),
      ...(mirror.commandDisabled !== null ? { disabled: mirror.commandDisabled } : {}),
    })
  } catch (e) {
    // best-effort：徽标推送失败不重抛——下一轮失效刷新/推送重试收敛
    console.warn('[scheduler-manager] updateHeaderAction failed:', toMessage(e))
  }
}

/**
 * E13 按钮灰置（插件侧判定，残留风险 #6 主修）：getCommands('schedule') 纯查询。
 * 未注册 → disabled；SESSION_NOT_ACTIVE → 无法判定（保持上次值，首次缺省可点）；
 * tooltip 文案由宿主渲染端按 availability 三态合成 i18n（SDK 无 i18n，插件不推）。
 */
async function reevaluateCommandAvailability(api: Api, mirror: SessionMirror): Promise<void> {
  try {
    const commands = await api.sessions.getCommands(mirror.sessionId)
    mirror.commandDisabled = !commands.some((c) => c.name === SCHEDULE_COMMAND_NAME)
  } catch (e) {
    if (!isSessionNotActive(e)) {
      // 其他查询错误：不动判定（保持上次值），但出声留诊断——静默 return 是排查黑洞
      // （按钮灰置异常时无任何宿主侧痕迹可循）
      console.warn(
        `[scheduler-manager] getCommands failed (session=${mirror.sessionId}); keeping last availability:`,
        toMessage(e),
      )
      return
    }
    // SESSION_NOT_ACTIVE：commandDisabled 不变（null = 首次缺省可点；有值 = 保持）
  }
  await pushHeaderAction(api, mirror)
}

// ── 写路径（E5 白名单 + E7/E14 回执文案 + E4 恢复提示）────────────────────────

interface WriteArgs {
  id: string
  enabled?: boolean
}

/** action-bar args 收窄（runtime E6 已保证标量；这里只取域值，不信任多余字段） */
function parseWriteArgs(args: unknown): WriteArgs | null {
  if (!args || typeof args !== 'object') return null
  const record = args as Record<string, unknown>
  if (!isValidTaskId(record.id)) return null
  return {
    id: record.id,
    ...(typeof record.enabled === 'boolean' ? { enabled: record.enabled } : {}),
  }
}

function subcommandFor(action: 'toggle' | 'run' | 'delete', enabled: boolean): ScheduleWriteSubcommand {
  if (action === 'toggle') return enabled ? 'on' : 'off'
  if (action === 'run') return 'run'
  return 'rm'
}

/** 设置行内 notice（null = 清除陈旧提示）并推一次树（写路径回执统一出口） */
async function setNoticeAndPush(api: Api, sessionId: string, notice: string | null): Promise<void> {
  const mirror = mirrors.get(sessionId)
  if (!mirror) return
  mirror.notice = notice
  await pushTreeAndBadge(api, mirror)
}

async function handleWrite(
  api: Api,
  action: 'toggle' | 'run' | 'delete',
  args: unknown,
): Promise<void> {
  const sessionId = focusSessionId
  if (!sessionId) return
  const mirror = mirrors.get(sessionId)
  const parsed = parseWriteArgs(args)
  const fallbackSub = subcommandFor(action, parsed?.enabled === true)
  if (!parsed) {
    await setNoticeAndPush(api, sessionId, `操作未生效：无效的任务标识（/schedule ${fallbackSub} <8位id>）`)
    return
  }
  // E5：折叠快照无该 id → TASK_NOT_FOUND，不发命令 + 重拉
  if (!mirror || !foldTasks(mirror).has(parsed.id)) {
    await setNoticeAndPush(api, sessionId, '任务已不存在，列表已刷新')
    scheduleRefresh(api, sessionId)
    return
  }
  const sub = subcommandFor(action, parsed.enabled === true)
  const content = buildScheduleCommand(sub, parsed.id)
  if (!content) {
    // 理论不可达（args 与快照已双校验）——白名单防线兜底，绝不发脏命令
    await setNoticeAndPush(api, sessionId, `操作未生效：无效的任务标识（/schedule ${sub} ${parsed.id}）`)
    return
  }
  const wasRecovering = mirror.readFailure !== null
  try {
    const receipt = await api.sessions.sendMessage({
      sessionId,
      role: 'user',
      content,
      requireCommand: SCHEDULE_COMMAND_NAME,
    })
    if (receipt.accepted) {
      // 写成功：旧失败 notice 必须清掉再推——不清则下一次失效驱动刷新会把陈旧
      // 「操作未生效」与已变更行一起重推（操作已生效却仍挂失败提示）。主动 push 让
      // 清除立即可见、不依赖失效事件是否到来（重复推送幂等）；数据不乐观更新，快照
      // 与游标仍由失效订阅驱动刷新（C-pi-13）。恢复窗口写成功 → 显式提示 restore
      // 副作用（E4：到期的 enabled 任务将照常触发）。
      await setNoticeAndPush(
        api,
        sessionId,
        wasRecovering ? '会话已恢复，未完成的排期任务将照常触发' : null,
      )
      return
    }
    // 回执失败：reason 是诊断/文案面，行为分支只看 accepted（E7 词表纪律）
    const r = receipt.reason
    const line =
      r === 'busy' || r === 'compacting' || r === 'bash'
        ? `会话正在忙，操作未生效（可手敲 /schedule ${sub} ${parsed.id}）`
        : r === 'command-missing'
          ? '命令不可用，操作未生效 —— 若持续失败，请到 设置 → 扩展检查 该会话的 scheduler 扩展'
          : '操作未生效，请重试'
    await setNoticeAndPush(api, sessionId, line)
  } catch (e) {
    const msg = toMessage(e)
    await setNoticeAndPush(
      api,
      sessionId,
      wasRecovering
        ? `会话恢复失败：${msg} —— 请从侧栏手动打开该会话后再管理`
        // 与 busy 分支同形态：错误提示必须携带可执行的恢复动作（手敲子命令重试）
        : `操作未生效：${msg}（可手敲 /schedule ${sub} ${parsed.id} 重试）`,
    )
  }
}

// ── modal 开合（showModal 后立即 views.update）────────────────────────────────

async function handleOpen(api: Api, sink: DisposableLike[]): Promise<void> {
  const sessionId = focusSessionId
  if (!sessionId) {
    await api.notify.warning('定时任务：当前没有可打开的会话')
    return
  }
  const mirror = ensureMirror(api, sessionId, sink)
  mirror.notice = null
  try {
    await api.ui.showModal(MODAL_ID, { sessionId })
  } catch (e) {
    // E10：有 pending 插件对话框时被拒——提示稍后重试（用户先回应宿主弹窗）
    await api.notify.warning(`定时任务面板暂时无法打开：${toMessage(e)}（请先回应宿主弹窗后重试）`)
    return
  }
  await pushTreeAndBadge(api, mirror)
}

// ── 激活入口 ─────────────────────────────────────────────────────

export async function activate(context: PluginContext): Promise<void> {
  const { api } = context
  const sink = context.subscriptions

  // 焦点会话追踪（open 链 sessionId 唯一来源）+ 激活补拉（场景 9：重启后仍正确）
  sink.push(
    api.sessions.onDidActivateSession((session) => {
      focusSessionId = session.id
      ensureMirror(api, session.id, sink)
    }),
  )
  sink.push(api.sessions.onDidDestroySession((session) => teardownMirror(session.id)))

  // modal 关闭：清 notice（重开首帧干净；壳层同帧清 ViewHostStore 分区）
  sink.push(
    api.ui.onModalClosed((event) => {
      if (event.modalId !== MODAL_ID) return
      for (const mirror of mirrors.values()) mirror.notice = null
    }),
  )

  // 命令注册（id 与 builtinContributions 声明逐字一致；'.' 合法、':' 被
  // INVALID_COMMAND_ID 拒——复合键 = pluginId:commandId，声明/注册两端同串对上）
  await api.commands.register({ id: HEADER_ACTION_ID, title: '定时任务' }, () => handleOpen(api, sink))
  await api.commands.register(
    { id: 'scheduler-manager.toggle', title: '暂停/恢复定时任务' },
    (args) => handleWrite(api, 'toggle', args),
  )
  await api.commands.register(
    { id: 'scheduler-manager.run', title: '立即执行定时任务' },
    (args) => handleWrite(api, 'run', args),
  )
  await api.commands.register(
    { id: 'scheduler-manager.delete', title: '删除定时任务' },
    (args) => handleWrite(api, 'delete', args),
  )

  // 冷启动兜底：插件激活晚于首屏 selectSession 时补焦点会话与徽标
  // （显式 list API——设计 AP-4「主动 pull 用 list()/get(sessionId) 的显式会话」）
  try {
    const sessions = await api.sessions.list()
    if (sessions.length > 0) {
      const latest = sessions.reduce((a, b) => (b.lastActiveAt > a.lastActiveAt ? b : a))
      focusSessionId = latest.id
      ensureMirror(api, latest.id, sink)
    }
  } catch (e) {
    // best-effort 兜底失败：焦点会话由 onDidActivateSession 主通路补上，不中断插件激活
    console.warn('[scheduler-manager] cold-start list() failed:', toMessage(e))
  }

  console.log('[scheduler-manager] activated: headerAction + modal points consumer ready')
}
