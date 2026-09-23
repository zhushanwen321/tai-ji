/**
 * terminal-write-queue store 兼容层 —— 联动 2（AI 命令→填终端）的跨组件写队列 + PTY 存活态。
 *
 * W2 迁移（drawer 域向 core 归位第二步）：写队列状态机（sessions Map + ptyAlive/pendingWrites +
 * enqueueWrite/markAlive/markExited/isPtyAlive/removeSession）整体迁入
 * @taiji/core/domain/drawer（createTerminalWriteQueue 工厂）。本文件为兼容层：
 *
 * 1. 保留 useTerminalWriteQueueStore() Pinia store 形状（useTerminal.ts / useRunInTerminal.ts /
 *    Block.vue 消费方零改动）。
 * 2. core 零 api 层依赖：write 副作用（terminalApi.write）与用户显形（toast）在本层模块顶层
 *    注入（RD-3#5：此前 `void terminalApi.write()` 无 catch——RPC 失败成 unhandledrejection
 *    且用户零反馈；队列满 drop-oldest 静默 shift——命令丢了不可观测）。
 * 3. 单例共享语义保留：queue 实例在 pinia store setup 内创建（pinia 按 store id 缓存——同一 pinia
 *    实例内多次 useTerminalWriteQueueStore() 返回同一实例，Block 写 / TerminalView flush 共享同一
 *    队列；测试换 createPinia() 即得新实例，用例间天然隔离）。scrollback 仍是 per-instance
 *    （TerminalView 独有的视图状态），不进本队列。
 *
 * 数据流（与原版一致）：
 * 写入方（Block.vue）→ enqueueWrite(sid, cmd)
 * 状态更新方（TerminalView useTerminal alive/exit handler）→ markAlive(sid) / markExited(sid)
 */
import { defineStore } from 'pinia'
import { terminalApi } from '@taiji/core/transport/api/domains/terminal'
import { createTerminalWriteQueue } from '@taiji/core/domain/drawer'
import { useToast } from '@/composables/useToast'
import i18n from '@/i18n'

/** i18n.global.t 的类型窄化 cast（先例：useConnection.ts / useSkillNoticeStream.ts 同款）。 */
const t = i18n.global.t as (key: string, params?: Record<string, unknown>) => string

/**
 * drop toast 聚合窗口：队列满时入队方可能连发（AI 批量「在终端运行」），逐条 toast 会刷屏——
 * 同一 session 窗口内的连续 drop 合并为一条，显示触发时的最新累计数（toast 时读队列实际计数）。
 */
const DROP_TOAST_AGGREGATE_MS = 1000

export const useTerminalWriteQueueStore = defineStore('terminal-write-queue', () => {
  const { error: toastError, warning: toastWarning } = useToast()
  // drop toast 聚合 timer（per-session，removeSession 时清理）
  const dropToastTimers = new Map<string, ReturnType<typeof setTimeout>>()

  // core 工厂实例（pinia store setup 内创建，随 pinia 实例生命周期）：write 副作用 +
  // drop/失败显形注入点在本兼容层（core 零 api/UI 层依赖 C3——注入点在本兼容层）。
  const queue = createTerminalWriteQueue(
    (sid, cmd) => {
      // RD-3#5：void 无 catch → RPC 失败（断连/超时）成 unhandledrejection，用户零反馈。
      // 对齐 useForkActions 的 catch+toast 惯例（fire-and-forget 调用点自带反馈）。
      // 注意：PTY 管道级 write 失败由 runtime 侧 terminal.writeFailed 广播覆盖
      // （useTerminal 模块订阅显示），此处只管 RPC 通道故障，两层不重复报同一故障。
      terminalApi.write(sid, cmd).catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e)
        console.warn(`[terminal-write-queue] write RPC 失败: sid=${sid}`, e)
        toastError(t('panel.terminal.writeRpcFailed', { error: msg }))
      })
    },
    {
      onDrop: (sid, totalDropped) => {
        console.warn(`[terminal-write-queue] 队列满 drop-oldest: sid=${sid} 累计丢弃 ${totalDropped} 条`)
        // 聚合：重置窗口，窗口静默后按当时累计数发一条（每次 onDrop 重建 timer，闭包捕获最新值）
        const pending = dropToastTimers.get(sid)
        if (pending) clearTimeout(pending)
        const timer = setTimeout(() => {
          dropToastTimers.delete(sid)
          toastWarning(t('panel.terminal.queueDropped', { count: totalDropped }))
        }, DROP_TOAST_AGGREGATE_MS)
        dropToastTimers.set(sid, timer)
      },
    },
  )

  /** session 销毁清理：队列分区 + 聚合 timer 一并释放。 */
  function removeSession(sid: string): void {
    const timer = dropToastTimers.get(sid)
    if (timer) {
      clearTimeout(timer)
      dropToastTimers.delete(sid)
    }
    queue.removeSession(sid)
  }

  // 兼容形状：方法集合与旧版 pinia store 逐字段一致（消费方零改动）
  return {
    /** PTY 就绪标记（TerminalView 的 alive handler 调）+ flush 写队列。 */
    markAlive: queue.markAlive,
    /** PTY 退出标记（TerminalView 的 exit handler 调）。 */
    markExited: queue.markExited,
    /** 入队写命令（联动 2：Block「在终端运行」调）。PTY 已活立即 write / 未活入队 markAlive 时 flush */
    enqueueWrite: queue.enqueueWrite,
    /** 查询 PTY 存活态（TerminalView 工具栏 kill 按钮 disabled 判断用）。 */
    isPtyAlive: queue.isPtyAlive,
    /** session 销毁时清理（useSessionScopedState cleanup 可选调）。 */
    removeSession,
  }
})
