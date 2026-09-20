// ack 确认轮编排（dev-flow u-ack-turn 单元）。
//
// 背景：scheduler 命令路径建任务后，任务条目只 append 到 pi 的内存 fileEntries，
// 而 pi 只有在会话「第一次落盘」后才把 fileEntries 写到磁盘 —— 若用户建完任务就
// 不再说话，任务会随进程退出丢失。解法：注入一次零 token 本地合成轮，产出真
// assistant 消息，打开落盘开关（设计 scheduler-command-path-persistence §3.3）。
//
// 生命周期（覆写只活在极小时间片，故无需互斥）：
//   ① 建任务成功 ⇒ maybeStartAck：只读检查未落盘 + 空闲 + 可用，注入 custom 触发器
//      （triggerTurn）并武装 30s 写盘自检；
//   ② 触发器的 message_start 到达（本轮首次模型请求之前，已按 pi-agent-core
//      agent-loop 实装核实）⇒ 同步 registerProvider 覆写当前 provider 的 streamSimple；
//   ③ 我们的 streamSimple 被调用 ⇒ 返回 stream 之前同步注销覆写（one-shot 自撤），
//      本轮内被 steer/followUp drain 出的后续请求与后续轮次全部走真实 provider；
//   ④ turn_end / session 边界 ⇒ 安全网注销（幂等）。
//
// 状态住模块级单例 ackState：pi 每次 session 替换都重跑 extension factory（index.ts
// 顶部 G1 注释），闭包级状态随重跑重置，上一代遗留的定时器/覆写窗口会失去清理者；
// 模块级单例跨代共享，新实例才能取消上一代定时器（本机制的结构性前提）。

import { existsSync } from 'node:fs'

import { createAckNotifyDedup, planAckNotify, shouldNotifyUnpersisted } from './ack-notify.js'
import { buildAckStreamSimple, computeAckAvailability } from './ack-provider.js'
import type { SchedulerBackend } from './backend.js'
import { ACK_CONFIRM_KEY } from './i18n.js'
import type { SchedulerEntryLike } from './replay.js'
import { ACK_CUSTOM_TYPE, ACK_CUSTOM_TYPE_PREFIX } from './types.js'
import type { AckAvailability, AckFailureKind, AckState, SchedulerCurrentModel } from './types.js'

/** 30s 写盘自检窗口（设计 §3.3 D5）：ack 轮从未启动且文件仍不存在才补发如实告警。 */
export const ACK_WRITE_CHECK_MS = 30_000

/**
 * ack 模块级单例状态。resetAckState() 之外禁止整体重新赋值（`const` 对象 + 字段赋值），
 * 保证跨代共享同一引用。availability 承载「每会话一次」的可用性预计算——武装点的同步
 * registerProvider 不能再 await 判据，故必须在建任务期算好并缓存。
 */
export const ackState: AckState = {
  pending: null,
  window: null,
  ackTurnStarted: false,
  writeCheckTimer: null,
  taskId: null,
  taskName: '',
  ackText: '',
  model: undefined,
  sessionFile: undefined,
  needsRetry: false,
  availability: undefined,
}

/** 通知去重（模块级，跨 controller 代共享；resetAckState 全清——跨会话隔离）。 */
const notifyDedup = createAckNotifyDedup()

/** 编排依赖（注入面；backend 为 per-session 实例，状态经模块级单例跨代共享）。 */
export interface AckTurnDeps {
  backend: SchedulerBackend
  /** 时间源（测试可注入固定值）；缺省 Date.now()。 */
  now?: () => number
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
  /** turn_end 安全网注销（幂等；不取消 30s 定时器——它服务通知判定）。 */
  handleTurnEnd(): void
  /** session_start / session_shutdown 共用：先做一次写盘判定，再自撤并全量清理。 */
  handleSessionBoundary(): void
}

/**
 * 全量清理模块级状态（session_start 与 session_shutdown 都调）：取消定时器、清
 * pending/window/ackTurnStarted/记录上下文/可用性缓存与通知去重。幂等。
 */
export function resetAckState(): void {
  if (ackState.writeCheckTimer !== null) {
    clearTimeout(ackState.writeCheckTimer)
    ackState.writeCheckTimer = null
  }
  ackState.pending = null
  ackState.window = null
  ackState.ackTurnStarted = false
  ackState.taskId = null
  ackState.taskName = ''
  ackState.ackText = ''
  ackState.model = undefined
  ackState.sessionFile = undefined
  ackState.needsRetry = false
  ackState.availability = undefined
  notifyDedup.clear()
}

/** 构造 ack 编排控制器（backend 装配点注入；状态仍是模块级单例）。 */
export function createAckTurnController(deps: AckTurnDeps): AckTurnController {
  const now = deps.now ?? (() => Date.now())

  /** 通知去重键：同 session 同 task 只发一次（sessionFile 缺失时以字面量占位）。 */
  function dedupKey(): string {
    return `${ackState.sessionFile ?? 'no-file'}:${ackState.taskId ?? 'no-task'}`
  }

  /**
   * 如实通知（warning + dedup）。计划由 planAckNotify 分类决定；本函数只消费
   * honest-sync / honest-async 两类（none 直接跳过）。
   */
  function notifyHonest(failure: AckFailureKind): void {
    const plan = planAckNotify(failure)
    if (plan.kind === 'none') return
    if (!notifyDedup.shouldNotify(dedupKey())) return
    deps.notify(deps.render(plan.messageKey, { name: ackState.taskName }), plan.level)
  }

  function cancelWriteCheck(): void {
    if (ackState.writeCheckTimer === null) return
    clearTimeout(ackState.writeCheckTimer)
    ackState.writeCheckTimer = null
  }

  /**
   * 30s 写盘自检：只有「会话文件不存在 **且** ack 轮从未启动」才判确实未落盘
   * （防慢速真实轮跨过 30s 才落盘时误报，见 ack-notify.shouldNotifyUnpersisted）。
   * 不重置 ackState——会话可能继续使用。
   */
  function armWriteCheck(): void {
    cancelWriteCheck()
    const timer = setTimeout(() => {
      ackState.writeCheckTimer = null
      const sessionFileExists =
        ackState.sessionFile !== undefined && existsSync(ackState.sessionFile)
      if (shouldNotifyUnpersisted({ sessionFileExists, ackTurnStarted: ackState.ackTurnStarted })) {
        deps.log.debug('ack write check: session file still missing after ack trigger', {
          taskId: ackState.taskId,
        })
        // e3-no-turn = 合成轮未启动 ⇒ honest-async 文案（同一如实键）。
        notifyHonest('e3-no-turn')
      }
    }, ACK_WRITE_CHECK_MS)
    timer.unref?.()
    ackState.writeCheckTimer = timer
  }

  /**
   * one-shot 自撤（幂等）。成功 ⇒ window 清空、needsRetry 复位；抛错（E6）⇒ 保留
   * window + 置 needsRetry，由下一个清理点（turn_end / session 边界）重试一次。
   */
  function selfUnregister(): void {
    if (!ackState.window?.registered) return
    const providerId = ackState.model?.provider
    if (providerId === undefined) {
      // 防御性兜底：window 非空必然经过 registerProvider（model.provider 存在），
      // 但若状态被外部污染，清空比让 window 卡死阻止后续 ack 更符合 fail-safe 方向。
      ackState.window = null
      return
    }
    try {
      deps.backend.unregisterProvider(providerId)
      ackState.window = null
      ackState.needsRetry = false
    } catch (err) {
      ackState.needsRetry = true
      deps.log.warn('ack unregister failed (E6); will retry at next cleanup point', {
        provider: providerId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /**
   * 可用性预计算（每会话/每 provider 缓存一次）：武装点同步 registerProvider 不能再
   * await，故这里算好存 ackState.availability。
   */
  async function getAvailability(
    providerId: string,
    isToggleDisabled: boolean,
  ): Promise<AckAvailability> {
    const cached = ackState.availability
    if (cached && cached.providerId === providerId) return cached.value
    const value = await computeAckAvailability({
      providerId,
      isToggleDisabled: () => isToggleDisabled,
      loadBuiltinProviderIds: deps.loadBuiltinProviderIds,
      loadModelsJsonProviderIds: deps.loadModelsJsonProviderIds,
    })
    ackState.availability = { providerId, value }
    return value
  }

  return {
    async maybeStartAck(input) {
      // ① 去重：待命触发器或覆写窗口在场 ⇒ 本会话已有 ack 在途，不再注入。
      if (ackState.pending !== null || ackState.window !== null) return

      const { task, model, isIdle, isToggleDisabled } = input

      // ② 落盘判据（fail-closed，只读）：已有 assistant 消息（pi 已 flush）/ 无 session
      //    文件（--no-session）/ 文件已存在 ⇒ 落盘开关已开或无需打开，直接返回。
      //    绝不创建/触碰 session 文件（项目规则 #6），故只 existsSync。
      if (hasAssistantEntry(deps.backend.getEntries())) return
      const sessionFile = deps.backend.getSessionFile()
      if (sessionFile === undefined) return
      if (existsSync(sessionFile)) return

      // 记录本次触发上下文（message_start / 30s 自检 / 边界清理共享）。
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

      // ④ 可用性预计算（不可用 ⇒ 同步如实通知，不开窗、不武装定时器）。
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

      // ⑤ 非空闲：在跑的轮次必然产出 assistant 消息 ⇒ 自然打开落盘开关（设计 D4/G4）。
      //    此时注入合成轮反而可能吞掉用户消息，故什么都不做（含不武装定时器）。
      if (!isIdle) return

      // ⑥ 注入触发器（triggerTurn 让 pi 为一个 custom 消息启动一轮）并武装自检。
      await deps.backend.sendMessage(
        { customType: ACK_CUSTOM_TYPE, content: ackState.ackText, display: false },
        { triggerTurn: true },
      )
      ackState.pending = { taskId: task.id, sentAt: now() }
      armWriteCheck()
    },

    handleMessageStart(message) {
      // 幂等：窗口在场说明本 ack 轮已武装过。
      if (ackState.window !== null) return
      // 判别：只认我们自己的触发器（role:'custom' + 前缀）。外来消息/assistant 消息
      // 一律忽略，不注册任何东西（触发器是我们自己注入的，不会与用户消息混淆）。
      if (!matchesAckCustomType(message)) return

      // 触发器已到达 ⇒ 本轮首次模型请求即将发起，此处同步注册覆写即可赶在真实请求
      // 之前。临界区内禁 await——model 与可用性都在建任务期缓存好。
      ackState.pending = null
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
            onCalled: () => selfUnregister(),
          }),
        })
        ackState.window = { registered: true }
      } catch (err) {
        // E1：注册失败等价「无覆写」（pi 回退基座）。不置 window。
        deps.log.warn(
          'ack override register failed (E1); confirmation turn falls back to real provider',
          { provider: model.provider, error: err instanceof Error ? err.message : String(err) },
        )
      }
    },

    handleTurnEnd() {
      // 安全网（幂等）：正常路径已在 streamSimple 调用点自撤；这里覆盖「覆写未被调用」。
      // 不取消 30s 定时器——它服务通知判定。
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
      // ③ 全量清理（含 30s 定时器与可用性缓存），供下一代复用同一单例。
      resetAckState()
    },
  }
}

/**
 * 落盘判据①：会话内已有 assistant 消息 ⇒ pi 已 flush，任务必然已落盘。
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
