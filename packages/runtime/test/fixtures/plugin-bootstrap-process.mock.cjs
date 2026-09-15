/**
 * Mock 子进程 bootstrap for PluginHostProcess / PluginHost sandbox 分流 unit tests.
 *
 * fork 版 mock（合法 CJS，'use strict' + process.on/process.send）：响应固定消息，不加载真实插件。
 * 对齐 fixtures/mock-bootstrap.cjs（Worker 版）的消息协议，传输层换 process.send。
 * 经 PluginHostProcessOptions.bootstrapPathOverride 注入 fork 子进程（fork(this.bootstrapPathOverride)）。
 *
 * 特殊分支（测试专用）：
 * - crash → process.exit(1) 模拟子进程崩溃（exit 非 0）
 * - fatal → 回 fatal_error 消息模拟子进程主动报告致命错误
 * - fatalThenExit → 回 fatal_error 后延迟 300ms process.exit(1)（模拟崩溃→重建竞态：
 *   旧进程晚到 exit 落在重建后的新 handle 上）
 * - hang  → 不响应（模拟 loadPlugin 超时）
 */
'use strict'

// 收到 hang 后进入挂起态：后续所有消息都不响应（模拟 loadPlugin 超时）
let hanging = false

process.on('message', (msg) => {
  if (hanging) return
  const m = msg
  if (m.type === 'load') {
    process.send({ type: 'loaded', pluginId: m.pluginId })
  } else if (m.type === 'activate') {
    process.send({ type: 'activated', pluginId: m.pluginId })
  } else if (m.type === 'deactivate') {
    process.send({ type: 'deactivated', pluginId: m.pluginId })
  } else if (m.type === 'rpc') {
    // 两种入格式：
    // 1. 宿主 invoke 发的 { type: 'rpc', request: { id, ... } }
    // 2. 扁平 { type: 'rpc', id }（旧协议）
    if (m.request && typeof m.request.id !== 'undefined') {
      process.send({ type: 'rpc', response: { jsonrpc: '2.0', id: m.request.id, result: null } })
    } else if (typeof m.id !== 'undefined') {
      process.send({ type: 'rpc', response: { jsonrpc: '2.0', id: m.id, result: null } })
    }
  } else if (m.type === 'crash') {
    process.exit(1)
  } else if (m.type === 'fatal') {
    process.send({ type: 'fatal_error', error: 'mock fatal error' })
  } else if (m.type === 'fatalThenExit') {
    process.send({ type: 'fatal_error', error: 'mock fatal error then exit' })
    // 延迟退出：给宿主留出重激活窗口，晚到 exit 用于验证崩溃→重建竞态（M6a-03）
    setTimeout(() => process.exit(1), 300)
  } else if (m.type === 'hang') {
    hanging = true
  }
})
