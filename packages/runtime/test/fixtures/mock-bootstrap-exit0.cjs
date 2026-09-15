/**
 * Mock 子进程 bootstrap（受控退出版）— PluginHostProcess exit 分流回归测试用（L-5）。
 *
 * 与 plugin-bootstrap-process.mock.cjs 的差异：提供三种受控生命周期行为，覆盖
 * 「正常退出 exit(0) / 存活进程断开 IPC / 常规 IPC 往返」的分流验证：
 * - load           → 回 loaded（常规往返，宿主 loadPlugin 依赖）
 * - exit0          → process.exit(0)：插件生命周期自然结束（正常退出，宿主不应报 crash）
 * - ipc-disconnect → process.disconnect() 且进程保持存活（IPC 单方面断开的真异常，
 *   宿主 disconnect grace 兜底应报 crash；keepAlive 维持事件循环存活）
 * 不改共享 fixture（plugin-bootstrap-process.mock.cjs）以免影响依赖其行为的既有用例。
 */
'use strict'

// ipc-disconnect 后进程必须在无 IPC 的状态下继续存活（模拟「进程活着但通道没了」）
const keepAlive = setInterval(() => {}, 1 << 30)

process.on('message', (msg) => {
  const m = msg
  if (m.type === 'load') {
    process.send({ type: 'loaded', pluginId: m.pluginId })
  } else if (m.type === 'exit0') {
    clearInterval(keepAlive)
    process.exit(0)
  } else if (m.type === 'ipc-disconnect') {
    // 保留 keepAlive：断开 IPC 后进程仍存活，与「进程退出伴随的 disconnect」形成对照
    process.disconnect()
  }
})
