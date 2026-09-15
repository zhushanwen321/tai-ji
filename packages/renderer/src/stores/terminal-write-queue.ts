/**
 * terminal-write-queue store 兼容层 —— 联动 2（AI 命令→填终端）的跨组件写队列 + PTY 存活态。
 *
 * W2 迁移（drawer 域向 core 归位第二步）：写队列状态机（sessions Map + ptyAlive/pendingWrites +
 * enqueueWrite/markAlive/markExited/isPtyAlive/removeSession）整体迁入
 * @taiji/core/domain/drawer（createTerminalWriteQueue 工厂）。本文件为兼容层：
 *
 * 1. 保留 useTerminalWriteQueueStore() Pinia store 形状（useTerminal.ts / useRunInTerminal.ts /
 *    Block.vue 消费方零改动）。
 * 2. core 零 api 层依赖：write 副作用（terminalApi.write）在本层模块顶层注入
 *    （createTerminalWriteQueue((sid, cmd) => { void terminalApi.write(sid, cmd) })）。
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

export const useTerminalWriteQueueStore = defineStore('terminal-write-queue', () => {
  // core 工厂实例（pinia store setup 内创建，随 pinia 实例生命周期）：write 副作用注入
  // terminalApi.write（core 零 api 层依赖 C3——注入点在本兼容层）。
  const queue = createTerminalWriteQueue((sid, cmd) => {
    void terminalApi.write(sid, cmd)
  })

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
    removeSession: queue.removeSession,
  }
})
