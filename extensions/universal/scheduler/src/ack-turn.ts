// ack 确认轮编排（dev-flow u-ack-turn 单元）。
//
// 背景：scheduler 命令路径建任务后，任务条目只 append 到 pi 的内存 fileEntries，
// 而 pi 只有在会话「第一次落盘」后才把 fileEntries 写到磁盘（pi _persist 的
// hasAssistant 门控，语义登记 docs/pi-semantics.json PS-14，锚 pi
// dist/core/session-manager.js:726-756）—— 若用户建完任务就
// 不再说话，任务会随进程退出丢失。解法：注入一次零 token 本地合成轮，产出真
// assistant 消息，打开落盘开关（设计 scheduler-command-path-persistence §3.3）。
//
// 生命周期（覆写只活在极小时间片，故无需互斥）：
//   ① 建任务成功 ⇒ maybeStartAck：只读检查未落盘 + 空闲 + 可用，注入 custom 触发器
//      （triggerTurn）；写盘兜底判定收敛在 session 边界；
//   ② 触发器的 message_start 到达（本轮首次模型请求之前——pi-agent-core
//      agent-loop.js:51-53 初始 prompt 逐条 emit message_start/message_end 先于
//      :56 runLoop → :122 streamAssistantResponse 首次模型请求，按 0.84.4 实装核实；
//      直达链锚 PS-08）⇒ 同步 registerProvider 覆写当前 provider 的 streamSimple；
//   ③ 我们的 streamSimple 被调用 ⇒ 返回 stream 之前同步注销覆写（one-shot 自撤），
//      本轮内被 steer/followUp drain 出的后续请求与后续轮次全部走真实 provider；
//   ④ turn_end / session 边界 ⇒ 安全网注销（幂等）。
//
// 状态住进程级单例槽（development-guide §7.5）：pi 每次 session 替换都重跑 extension
// factory（index.ts 顶部 G1 注释），闭包级状态随重跑重置，上一代遗留的覆写窗口会失去
// 清理者；ackState 持在 globalThis[Symbol.for] 槽内，跨 factory 重跑与 jiti 模块重求值
// （reload/cwd 变化产生新模块环境）都取回同一对象，新实例才能注销上一代残留的覆写
// 窗口（本机制的结构性前提）。

import { existsSync } from 'node:fs'

import { createAckNotifyDedup, shouldNotifyUnpersisted } from './ack-notify.js'
import { buildAckStreamSimple, computeAckAvailability } from './ack-provider.js'
import type { SchedulerBackend } from './backend.js'
import { ACK_CONFIRM_KEY, ACK_NOT_PERSISTED_KEY } from './i18n.js'
import type { SchedulerEntryLike } from './replay.js'
import { ACK_CUSTOM_TYPE, ACK_CUSTOM_TYPE_PREFIX } from './types.js'
import type {
  AckAvailability,
  AckNotifyReason,
  AckState,
  SchedulerCurrentModel,
} from './types.js'

/**
 * ack 状态进程槽（development-guide §7.5：跨 session 存活的进程级单例必须用
 * globalThis[Symbol.for] 持有——jiti 按模块路径字符串做缓存 key，双路径加载会把
 * 模块级单例分裂成多份互不可见；Symbol.for 全局注册表 + 进程级唯一 globalThis
 * 保证槽内对象跨所有 module instance 唯一）。
 */
const ACK_STATE_SLOT_KEY = Symbol.for('@zhushanwen/pi-scheduler.ack-state')

/** 槽 get-or-create（整对象一槽；形态同 subagent-workflow getOrCreateWorkflowDomainState）。 */
function getOrCreateAckState(): AckState {
  let state = Reflect.get(globalThis, ACK_STATE_SLOT_KEY) as AckState | undefined
  if (!state) {
    state = {
      window: null,
      ackTurnStarted: false,
      ackStreamCalled: false,
      taskId: null,
      taskName: '',
      ackText: '',
      model: undefined,
      sessionFile: undefined,
      availability: undefined,
    }
    Reflect.set(globalThis, ACK_STATE_SLOT_KEY, state)
  }
  return state
}

/**
 * ack 进程级单例状态（槽内对象，见 getOrCreateAckState 与 development-guide §7.5）。
 * resetAckState() 之外禁止整体重新赋值（字段赋值重置），保证跨代共享同一引用。
 * availability 承载建任务期的可用性判定结果，供同会话重复创建复用
 * （省重复读 models.json 与动态 import）。
 */
export const ackState: AckState = getOrCreateAckState()

/** 通知去重（模块级；resetAckState 全清——跨会话隔离）。 */
const notifyDedup = createAckNotifyDedup()

/** 编排依赖（注入面；backend 为 per-session 实例，状态经模块级单例跨代共享）。 */
export interface AckTurnDeps {
  backend: SchedulerBackend
  log: {
    warn(msg: string, meta?: Record<string, unknown>): void
    debug(msg: string, meta?: Record<string, unknown>): void
  }
  /** 渲染 i18n 文案（key 来自词典常量，params 为该键的插值）。 */
  render: (key: string, params: Record<string, string>) => string
  /** 注入 ctx.ui.notify（级别恒 warning——info 会被后台 renderer 丢弃 = 静默撒谎）。 */
  notify: (message: string, level: 'warning') => void
  /**
   * 可用性判据 loader 注入（测试缝隙）：生产不传，走 ack-provider 默认实现。
   * 非生产依赖——加它是为了让单测不经真实 FS/pi 子路径 import 就能确定性地驱动
   * no-base 分支（默认 loader 会读真实 models.json）。
   */
  loadBuiltinProviderIds?: () => Promise<Set<string>>
  loadModelsJsonProviderIds?: () => Promise<Set<string>>
  /**
   * native 重载查询器（测试缝隙；生产不传则判据缺失——装配点必传，见
   * ack-provider AckAvailabilityDeps 注释）。
   */
  hasRegisteredNativeOverride?: (providerId: string) => boolean
}

/** ack 编排控制器（index.ts 在既有 pi.on handler 内委派，不新增事件类型）。 */
export interface AckTurnController {
  /**
   * 建任务成功后的触发入口（去重 + fail-closed 落盘判据 + 可用性预计算 + 注入触发器）。
   * 非空闲时 no-op（运行中的轮次必然产出 assistant ⇒ 自然落盘）。
   */
  maybeStartAck(input: {
    task: { id: string; name?: string; scheduleText?: string }
    model: SchedulerCurrentModel | undefined
    isIdle: boolean
    isToggleDisabled: boolean
  }): Promise<void>
  /** 触发器 message_start ⇒ 同步武装覆写（临界区内禁 await）。 */
  handleMessageStart(message: unknown): void
  /** turn_end 安全网注销（幂等）。 */
  handleTurnEnd(): void
  /** session_start / session_shutdown 共用：先做一次写盘判定，再自撤并全量清理。 */
  handleSessionBoundary(): void
}

/**
 * 全量清理槽内状态（session_start 与 session_shutdown 都调）：对槽内对象逐字段重置
 * window / ackTurnStarted / 记录上下文 / 可用性缓存，并清通知去重。幂等。
 */
export function resetAckState(): void {
  ackState.window = null
  ackState.ackTurnStarted = false
  ackState.ackStreamCalled = false
  ackState.taskId = null
  ackState.taskName = ''
  ackState.ackText = ''
  ackState.model = undefined
  ackState.sessionFile = undefined
  ackState.availability = undefined
  notifyDedup.clear()
}

/** 构造 ack 编排控制器（backend 装配点注入；状态为槽内进程级单例）。 */
export function createAckTurnController(deps: AckTurnDeps): AckTurnController {
  /** 通知去重键：同 session 同 task 只发一次（sessionFile 缺失时以字面量占位）。 */
  function dedupKey(): string {
    return `${ackState.sessionFile ?? 'no-file'}:${ackState.taskId ?? 'no-task'}`
  }

  /**
   * 如实通知（warning + dedup）。`reason` 只进 debug 日志（两种可通知形态共用同一条文案
   * 与同一级别）；调用点传入它是为了「为什么在此处发」可读——时机差异不在类型里。
   */
  function notifyHonest(reason: AckNotifyReason): void {
    if (!notifyDedup.shouldNotify(dedupKey())) return
    deps.log.debug('ack unpersisted notice', { reason })
    deps.notify(deps.render(ACK_NOT_PERSISTED_KEY, { name: ackState.taskName }), 'warning')
  }

  /**
   * one-shot 自撤（幂等）。成功 ⇒ 清空窗口；抛错（E6）⇒ 保留窗口，由下一个清理点
   * （turn_end / session 边界）重试一次。窗口自足（携带 providerId），不必回读会话模型。
   */
  function selfUnregister(): void {
    const window = ackState.window
    if (window === null) return
    // 先摘窗口再注销：即使注销抛错，也不会把同一窗口重复注销；失败时回填以允许重试。
    ackState.window = null
    try {
      deps.backend.unregisterProvider(window.providerId)
    } catch (err) {
      ackState.window = window
      deps.log.warn('ack unregister failed (E6); will retry at next cleanup point', {
        provider: window.providerId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /**
   * 可用性判定（建任务期算一次，同会话重复创建直接复用缓存）。
   * 收益 = 省重复读 models.json 与动态 import；武装点不读它（只取 ackState.model）。
   */
  async function getAvailability(
    providerId: string,
    isToggleDisabled: boolean,
  ): Promise<AckAvailability> {
    const cached = ackState.availability
    if (cached && cached.providerId === providerId && cached.isToggleDisabled === isToggleDisabled) {
      return cached.value
    }
    const value = await computeAckAvailability({
      providerId,
      isToggleDisabled: () => isToggleDisabled,
      loadBuiltinProviderIds: deps.loadBuiltinProviderIds,
      loadModelsJsonProviderIds: deps.loadModelsJsonProviderIds,
      hasRegisteredNativeOverride: deps.hasRegisteredNativeOverride,
    })
    ackState.availability = { providerId, isToggleDisabled, value }
    return value
  }

  return {
    async maybeStartAck(input) {
      // ① 去重：覆写窗口在场 ⇒ 本会话已有一个 ack 轮武装过，不再注入第二个。
      //    只判 window 不判「待命触发器」：若上一次注入的触发器静默未启动轮次（E3：
      //    sendMessage 返回 void 且 rejection 只到宿主），窗口不会置位，此时下一次创建
      //    应当能重试而不是被永久挡住。
      if (ackState.window !== null) return

      const { task, model, isIdle, isToggleDisabled } = input

      // ② 落盘判据（fail-closed，只读）：已有 assistant 消息（pi 已 flush）/ 无 session
      //    文件（--no-session）/ 文件已存在 ⇒ 落盘开关已开或无需打开，直接返回。
      //    绝不创建/触碰 session 文件（项目规则 #6），故只 existsSync。
      if (hasAssistantEntry(deps.backend.getEntries())) return
      const sessionFile = deps.backend.getSessionFile()
      if (sessionFile === undefined) return
      if (existsSync(sessionFile)) return

      // ③ 非空闲（F2 修正：判据必须在记录上下文与可用性判定之前）：在跑的轮次必然产出
      //    assistant 消息 ⇒ 自然打开落盘开关 ⇒ 任务照样落盘。此时若先判可用性并通知，
      //    会在「忙 + 覆写不可用」组合下对**已落盘**的会话发"未写入"= 反向撒谎（D2/D8）。
      //    故此处直接返回：不记录上下文、不通知。
      if (!isIdle) return

      // 记录本次触发上下文（message_start 与 session 边界写盘判定共享）。
      ackState.taskId = task.id
      ackState.taskName = task.name ?? task.id
      ackState.sessionFile = sessionFile
      ackState.model = model
      ackState.ackText = deps.render(ACK_CONFIRM_KEY, {
        name: ackState.taskName,
        schedule: task.scheduleText ?? '',
      })

      // ③ 无模型 = 不可用（无法确定覆写目标 provider）。
      if (model === undefined) {
        deps.log.warn('ack skipped: session has no current model', { taskId: task.id })
        notifyHonest('e8-no-base')
        return
      }

      // ④ 可用性预计算（不可用 ⇒ 同步如实通知，不开窗）。
      const availability = await getAvailability(model.provider, isToggleDisabled)
      if (!availability.available) {
        // reason 只进日志（文案复用同一如实键，避免「文案分叉」）。
        deps.log.warn('ack unavailable, skipping confirmation turn', {
          reason: availability.reason,
          provider: model.provider,
          taskId: task.id,
        })
        notifyHonest('e8-no-base')
        return
      }

      // ⑥ 注入触发器（triggerTurn 让 pi 为一个 custom 消息启动一轮）。
      //    成功信号 = 触发器的 message_start（本扩展可观测）；失败信号只到宿主
      //    （extension_error，扩展收不到），故落盘与否的兜底判定放在 session 边界。
      await deps.backend.sendMessage(
        { customType: ACK_CUSTOM_TYPE, content: ackState.ackText, display: false },
        { triggerTurn: true },
      )
    },

    handleMessageStart(message) {
      // 幂等：窗口在场说明本 ack 轮已武装过。
      if (ackState.window !== null) return
      // 判别：只认我们自己的触发器（role:'custom' + 前缀）。外来消息/assistant 消息
      // 一律忽略，不注册任何东西（触发器是我们自己注入的，不会与用户消息混淆）。
      if (!matchesAckCustomType(message)) return

      // 触发器已到达 ⇒ 本轮首次模型请求即将发起，此处同步注册覆写即可赶在真实请求
      // 之前。临界区内禁 await——model 与可用性都在建任务期缓存好。
      ackState.ackTurnStarted = true

      const model = ackState.model
      if (!model) {
        deps.log.warn('ack trigger matched but cached model missing; not registering override', {
          taskId: ackState.taskId,
        })
        return
      }
      try {
        deps.backend.registerProvider(model.provider, {
          api: model.api,
          streamSimple: buildAckStreamSimple({
            model,
            text: ackState.ackText,
            // 返回 stream 之前同步自撤（buildAckStreamSimple 契约）。
            // ackStreamCalled 置位是 E2 归因的唯一信号（窗口开着却从未被调用 ⇒ 真实轮应答）。
            onCalled: () => {
              ackState.ackStreamCalled = true
              selfUnregister()
            },
          }),
        })
        ackState.window = { providerId: model.provider }
      } catch (err) {
        // E1：注册失败等价「无覆写」（pi 回退基座）。不置 window。
        deps.log.warn(
          'ack override register failed (E1); confirmation turn falls back to real provider',
          { provider: model.provider, error: err instanceof Error ? err.message : String(err) },
        )
      }
    },

    handleTurnEnd() {
      // E2 归因（一致性审查 F3）：窗口仍注册但我们的 streamSimple 从未被调用 ⇒ 本轮由真实
      // provider 应答（覆写未生效）。语义 = 任务其实已落盘 ⇒ 不发失败通知（E2 不在
      // AckNotifyReason 里），只留 warn 归因。
      if (ackState.window !== null && !ackState.ackStreamCalled) {
        deps.log.warn('ack override not hit (E2); real provider answered this turn', {
          taskId: ackState.taskId,
        })
      }
      // 安全网（幂等）：正常路径已在 streamSimple 调用点自撤；这里覆盖「覆写未被调用」。
      selfUnregister()
    },

    handleSessionBoundary() {
      // ① 写盘判定：仅当本会话确实发起过 ack（taskId 记录在场）才有意义——从未建任务的
      //    会话不应发「未写入」告警（否则每个新 session 都会误报）。
      if (ackState.taskId !== null) {
        const sessionFileExists =
          ackState.sessionFile !== undefined && existsSync(ackState.sessionFile)
        if (
          shouldNotifyUnpersisted({
            sessionFileExists,
            ackTurnStarted: ackState.ackTurnStarted,
          })
        ) {
          notifyHonest('e3-no-turn')
        }
      }
      // ② 覆写自撤（含 E6 重试一次）。
      selfUnregister()
      // ③ 全量清理（覆写窗口引用、可用性缓存与通知去重），供下一代复用同一单例。
      resetAckState()
    },
  }
}

/**
 * 落盘判据①：会话内已有 assistant 消息 ⇒ pi 已 flush，任务必然已落盘。
 *
 * 反向推论承重锚（语义登记 docs/pi-semantics.json PS-14）：pi _appendEntry 先 push 进
 * fileEntries 再同步 _persist（dist/core/session-manager.js:757-762），assistant 在列时
 * hasAssistant 命中即走同步 wx 全量补写分支（:741-752，0.84.4 无异步 flush）——getEntries
 * 读到 assistant 的时刻磁盘必已含全部内存 entry，无异步窗口。
 *
 * entry 形状来自 replay 的 SchedulerEntryLike（无 role 字段声明），故用 `in` 收窄到
 * unknown 再比较——不引断言、不引 any。
 */
function hasAssistantEntry(entries: SchedulerEntryLike[]): boolean {
  for (const entry of entries) {
    if (entry.type !== 'message') continue
    if (!('role' in entry) || entry.role !== 'assistant') continue
    return true
  }
  return false
}

/** 触发器 message_start 判别（unknown 收窄，无断言；role 必须为 custom 即排除 assistant）。 */
function matchesAckCustomType(message: unknown): boolean {
  if (typeof message !== 'object' || message === null) return false
  if (!('role' in message) || !('customType' in message)) return false
  if (message.role !== 'custom') return false
  return (
    typeof message.customType === 'string' && message.customType.startsWith(ACK_CUSTOM_TYPE_PREFIX)
  )
}
