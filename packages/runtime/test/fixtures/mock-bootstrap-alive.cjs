/**
 * Mock Worker bootstrap（常驻版）— 用于「预期终止不误报崩溃」回归测试。
 *
 * 与 mock-bootstrap.cjs 的差异：load 后挂 refed interval 保持事件循环存活，
 * 模拟 statusline 等常驻插件 Worker——运行中被 terminate() 时 exit code=1
 * （事件循环已排空的 Worker 会自然退出 code=0，无法复现误报场景）。
 * 经 workerBootstrapOverride 注入，仅 terminateWorker/shutdown 回归测试使用，
 * 不改共享 fixture 以免影响依赖自然退出的既有用例。
 */
const { parentPort } = require('node:worker_threads')

if (parentPort) {
  // 常驻句柄：与真实插件 Worker 同构（有活跃 handle，terminate 前不会自然退出）
  const keepAlive = setInterval(() => {}, 1 << 30)

  parentPort.on('message', (msg) => {
    const m = msg
    if (m.type === 'load') {
      parentPort.postMessage({ type: 'loaded', pluginId: m.pluginId })
    } else if (m.type === 'activate') {
      parentPort.postMessage({ type: 'activated', pluginId: m.pluginId })
    } else if (m.type === 'deactivate') {
      parentPort.postMessage({ type: 'deactivated', pluginId: m.pluginId })
    } else if (m.type === 'crash') {
      clearInterval(keepAlive)
      process.exit(1)
    }
  })
}
