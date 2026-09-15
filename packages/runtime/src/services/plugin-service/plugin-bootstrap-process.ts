/**
 * 子进程侧 bootstrap（fork 版，PluginHostProcess 的子进程入口）
 *
 * 与 Worker 版（plugin-bootstrap.ts）职责同构，传输从 parentPort 换成 process.send/on：
 * - setPostMessage(process.send) 注入 post 通道，handleMessage/initSandbox/api 工厂全部复用（单一真相）
 * - workerRpcClient.attach({ postMessage: process.send }) 把共享 client 接到 fork 默认
 *   IPC channel——activate 分支（createAgentAPI → createHookApi(rpcClient)）用的是
 *   plugin-bootstrap.ts 模块级 client，本宿主必须 attach 同一实例，否则插件 hooks
 *   注册 RPC 因 client 未 attach 而 reject（传输缝：消息路由单一真相在 handleMessage）
 * - load 消息（trustLevel=sandbox）自动经 handleMessage 装 CJS require 拦截（initSandbox）
 * - ESM import 拦截由 ESM loader（plugin-esm-loader.cjs，execArgv --import 注入）负责
 *
 * 打包约束（AGENTS.md #12，与 plugin-bootstrap.cjs 同目录约定）：
 * - tsup entry 必须含本文件（输出 plugin-bootstrap-process.cjs），host-process.ts
 *   经 resolveAndValidateFile('plugin-bootstrap-process.cjs') 定位
 * - 由 process.execPath + ELECTRON_RUN_AS_NODE=1 fork 启动（打包后无独立 node）
 */

import { handleMessage, setPostMessage, workerRpcClient } from './plugin-bootstrap.js'

/** post 通道：process.send（IPC channel 关闭后 send 抛错属预期，best-effort 静默） */
setPostMessage((msg: unknown) => {
  try {
    process.send?.(msg)
  } catch (e: unknown) {
    // 子进程已退出/崩溃时 IPC channel 关闭，send 抛错不传播（对齐 host-process best-effort 模式）
    console.debug('[plugin-bootstrap-process] post after channel closed:', e)
  }
})

workerRpcClient.attach({
  postMessage: (msg: unknown) => {
    try {
      process.send?.(msg)
    } catch (e: unknown) {
      // 同上：channel 关闭后的 in-flight 消息不抛
      console.debug('[plugin-bootstrap-process] send after channel closed:', e)
    }
  },
})

process.on('message', (msg: unknown) => {
  handleMessage(msg as Parameters<typeof handleMessage>[0]).catch((e: unknown) => {
    process.send?.({
      type: 'fatal_error',
      error: String(e),
      stack: e instanceof Error ? e.stack : undefined,
    })
  })
})
