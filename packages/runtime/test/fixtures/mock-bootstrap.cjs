/**
 * Mock Worker bootstrap for PluginHost unit tests.
 *
 * Handles load / activate / deactivate / rpc / crash messages without loading real plugins.
 * 合法 CJS 模块（.cjs 文件）：用 require 而非 import。经 PluginHostProcessOptions.workerBootstrapOverride
 * 注入 trusted Worker 线程（new Worker(this.workerBootstrapOverride)），由 Node Worker 直接加载——
 * 不再经「写 src/plugin-bootstrap.js 文本中转」，消除并行测试互相覆盖的竞态。
 *
 * 注：被 require()/new Worker() 顶层加载时 parentPort 为 undefined（非 Worker 上下文），
 * if(parentPort) 守卫使其安全返回，不抛错。
 */
const { parentPort } = require('node:worker_threads')

if (parentPort) {
  parentPort.on('message', (msg) => {
    const m = msg
    if (m.type === 'load') {
      parentPort.postMessage({ type: 'loaded', pluginId: m.pluginId })
    } else if (m.type === 'activate') {
      parentPort.postMessage({ type: 'activated', pluginId: m.pluginId })
    } else if (m.type === 'deactivate') {
      parentPort.postMessage({ type: 'deactivated', pluginId: m.pluginId })
    } else if (m.type === 'rpc' && m.id !== undefined) {
      parentPort.postMessage({ jsonrpc: '2.0', id: m.id, result: null })
    } else if (m.type === 'crash') {
      process.exit(1)
    }
  })
}
