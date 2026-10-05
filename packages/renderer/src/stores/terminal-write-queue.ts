/**
 * terminal-write-queue store 兼容层 —— 联动 2（AI 命令→填终端）的跨组件写队列 + PTY 存活态。
 *
 * W2 迁移（drawer 域向 core 归位第二步）：写队列状态机（sessions Map + ptyAlive/pendingWrites +
 * enqueueWrite/markAlive/markExited/isPtyAlive/removeSession）整体迁入
 * @taiji/core/domain/drawer（createTerminalWriteQueue 工厂）。本文件为兼容层：
 *
 * 1. 保留 useTerminalWriteQueueStore() Pinia store 形状（消费方零改动）。
 * 2. core 零 api 层依赖：write 副作用（terminalApi.write）与用户显形（toast）在本层注入
 *    （RD-3#5：此前 `void terminalApi.write()` 无 catch——RPC 失败成 unhandledrejection
 *    且用户零反馈；队列满 drop-oldest 静默 shift——命令丢了不可观测）。
 * 3. 单例共享语义保留：queue 实例在 pinia store setup 内创建（pinia 按 store id 缓存——同一 pinia
 *    实例内多次 useTerminalWriteQueueStore() 返回同一实例）。scrollback 仍是视图状态，
 *    不进本队列。
 *
 * 多实例键迁移（terminal-multi-instance 设计 §2.2 第 4 表 / §3.3）：状态键从会话 id 迁移到
 * **实例编号** `term:<会话id>:<序号>`——pendingWrites / ptyAlive 镜像 / dropToastTimers 全部
 * 按 terminalId 分键；会话删除走 `removeSession(sid)`（core 精确前缀扇出），世代变更走
 * `clearAll()`。**入队守卫**（关闭沿竞态）：`isRegistered` 由本层注入实例注册表成员资格
 * 判据（与 ptyAlive 镜像解耦——已建档未 alive 仍入 pendingWrites）。
 *
 * 数据流（多实例）：
 * 写入方（预留接入点：消息流 tool 块「在终端运行」；**当前仓内无生产调用方**——用户键盘输入
 * 直接走 useTerminal.writeToTerminal → terminalApi.write，不经本队列）→ enqueueWrite(terminalId, cmd)
 * 状态更新方（useTerminal 模块级订阅 ack/alive/exit）→ markAlive(terminalId) / markExited(terminalId)
 * 清理方（实例关闭沿 / 会话删除 / 世代重置）→ removeInstance(terminalId) / removeSession(sid) / clearAll()
 */
import { defineStore } from 'pinia'
import { terminalApi } from '@taiji/core/transport/api/domains/terminal'
import { createTerminalWriteQueue } from '@taiji/core/domain/drawer'
import { useToast } from '@/composables/useToast'
import i18n from '@/i18n'
import {
  hasInstance,
  instanceLabel,
  isTerminalIdOfSession,
  sessionIdOfTerminalId,
} from '@/composables/features/terminal/terminal-instance-registry'

/** i18n.global.t 的类型窄化 cast（先例：useConnection.ts / useSkillNoticeStream.ts 同款）。 */
const t = i18n.global.t as (key: string, params?: Record<string, unknown>) => string

/**
 * drop toast 聚合窗口：队列满时入队方可能连发（AI 批量「在终端运行」），逐条 toast 会刷屏——
 * 同一实例窗口内的连续 drop 合并为一条，显示触发时的最新累计数（toast 时读队列实际计数）。
 */
const DROP_TOAST_AGGREGATE_MS = 1000

export const useTerminalWriteQueueStore = defineStore('terminal-write-queue', () => {
  const { error: toastError, warning: toastWarning } = useToast()
  // drop toast 聚合 timer（per-instance，removeInstance / removeSession / clearAll 时清理）
  const dropToastTimers = new Map<string, ReturnType<typeof setTimeout>>()

  // core 工厂实例（pinia store setup 内创建，随 pinia 实例生命周期）：write 副作用 +
  // drop/失败显形 + 关闭沿入队守卫判据的注入点均在本兼容层（core 零 api/UI 层依赖）。
  const queue = createTerminalWriteQueue(
    (terminalId, cmd) => {
      const sessionId = sessionIdOfTerminalId(terminalId)
      if (sessionId === null) {
        console.warn(`[terminal-write-queue] write 拒绝：非法实例编号 ${terminalId}`)
        return
      }
      // RD-3#5：void 无 catch → RPC 失败（断连/超时）成 unhandledrejection，用户零反馈。
      // 对齐 useForkActions 的 catch+toast 惯例（fire-and-forget 调用点自带反馈）。
      // 注意：PTY 管道级 write 失败由 runtime 侧 terminal.writeFailed 广播覆盖
      // （useTerminal 模块订阅显示），此处只管 RPC 通道故障，两层不重复报同一故障。
      terminalApi.write(sessionId, terminalId, cmd).catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e)
        console.warn(`[terminal-write-queue] write RPC 失败: terminalId=${terminalId}`, e)
        toastError(t('panel.terminal.writeRpcFailed', { error: msg }))
      })
    },
    {
      onDrop: (terminalId, totalDropped) => {
        console.warn(`[terminal-write-queue] 队列满 drop-oldest: terminalId=${terminalId} 累计丢弃 ${totalDropped} 条`)
        // 聚合：重置窗口，窗口静默后按当时累计数发一条（每次 onDrop 重建 timer，闭包捕获最新值）
        const pending = dropToastTimers.get(terminalId)
        if (pending) clearTimeout(pending)
        const timer = setTimeout(() => {
          dropToastTimers.delete(terminalId)
          toastWarning(t('panel.terminal.queueDropped', { count: totalDropped }))
        }, DROP_TOAST_AGGREGATE_MS)
        dropToastTimers.set(terminalId, timer)
      },
      // 关闭沿入队守卫（设计 §3.3）：注册成员资格否定 → 拒绝入队、不建档（防幽灵实例态）。
      isRegistered: (terminalId) => hasInstance(terminalId),
    },
  )

  /** drop 聚合 timer 清理（per-instance）。 */
  function clearDropTimer(terminalId: string): void {
    const timer = dropToastTimers.get(terminalId)
    if (timer) {
      clearTimeout(timer)
      dropToastTimers.delete(terminalId)
    }
  }

  /**
   * 「输入可能丢失」提示（设计 §5 u2 / §3.3）：对已关闭实例的入队被拒时复用与死亡沿滞留
   * 命令丢弃同一提示通道（i18n `panel.terminal.writeFailed`），命令丢弃必显形、不静默。
   * core 保持零 UI 依赖，显形（toast）在 renderer 兼容层注入。
   */
  function warnInputMayBeLost(terminalId: string): void {
    toastWarning(t('panel.terminal.writeFailed', { message: instanceLabel(terminalId) }))
  }

  /** 实例关闭沿：队列实例态 + 聚合 timer 一并释放，返回被丢弃的滞留命令数。 */
  function removeInstance(terminalId: string): number {
    clearDropTimer(terminalId)
    return queue.removeInstance(terminalId)
  }

  /** session 销毁清理：该会话全部实例键 + 聚合 timer 一并释放（精确前缀，含幽灵条目）。 */
  function removeSession(sessionId: string): number {
    for (const [terminalId, timer] of dropToastTimers) {
      if (!isTerminalIdOfSession(terminalId, sessionId)) continue
      clearTimeout(timer)
      dropToastTimers.delete(terminalId)
    }
    return queue.removeSession(sessionId)
  }

  /** 世代变更重置：清空全部实例态 + 聚合 timer，返回被丢弃的滞留命令总数。 */
  function clearAll(): number {
    for (const timer of dropToastTimers.values()) clearTimeout(timer)
    dropToastTimers.clear()
    return queue.clearAll()
  }

  /**
   * 入队写命令（预留接入点：Block「在终端运行」调；**当前仓内无生产调用方**）。PTY 已活立即 write / 未活入 pendingWrites
   * markAlive 时 flush。
   * **关闭沿入队守卫**（设计 §5 u2）：实例不在注册表（已关闭）→ 拒绝入队并经「输入可能
   * 丢失」提示告知（core 侧同名守卫保留为无 UI 依赖的兜底，防幽灵实例态建档）。判据 =
   * 注册成员资格，与 ptyAlive 镜像解耦（已建档未 alive 仍入 pendingWrites）。
   */
  function enqueueWrite(terminalId: string, cmd: string): void {
    if (!hasInstance(terminalId)) {
      warnInputMayBeLost(terminalId)
      return
    }
    queue.enqueueWrite(terminalId, cmd)
  }

  // 兼容形状：方法集合与旧版 pinia store 逐字段一致（消费方零改动）
  return {
    /** PTY 就绪标记（ack 建档 / alive handler 调）+ flush 写队列。 */
    markAlive: queue.markAlive,
    /** PTY 退出标记（exit handler 调）。 */
    markExited: queue.markExited,
    /** 入队写命令（预留接入点：Block「在终端运行」调；**当前仓内无生产调用方**）。PTY 已活立即 write / 未活入队 markAlive 时 flush */
    enqueueWrite,
    /** 查询 PTY 存活态（当前无生产消费者，保留为 API 面；TerminalView 工具栏 kill 按钮 disabled 判据 = 当前分区 state.ptyAlive）。 */
    isPtyAlive: queue.isPtyAlive,
    /** 查询该实例累计丢弃数 / 当前滞留数（世代重置提示判据）。 */
    droppedCountOf: queue.droppedCountOf,
    pendingCountOf: queue.pendingCountOf,
    /** 实例关闭沿 / 会话删除 / 世代重置清理。 */
    removeInstance,
    removeSession,
    clearAll,
  }
})
