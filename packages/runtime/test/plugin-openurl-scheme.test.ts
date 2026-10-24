/**
 * plugin.ui.openUrl scheme 白名单单测（provider-plugin-access D9 / S28 / A28-L0）：
 *
 * scheme 判定纯函数四态（isAllowedOpenUrl，解析归一化语义）：
 * - https:// 放行（大写 scheme 变体 HTTPS:// 经 URL 解析归一化后同为 https:，同放行）
 * - file:// 拒绝（浮层渲染本机文件是真实攻击面）
 * - javascript: 及大小写/空白变体（JAVASCRIPT: / java\tscript: / 前导空白）拒绝——
 *   WHATWG URL 解析剥前后空白与内部 tab/换行、scheme 归一小写，归一结果不在
 *   http(s) 白名单即拒绝（不做字符串前缀匹配）
 * - 不可解析输入（相对地址 / 纯文本 / 空串）拒绝
 *
 * RPC handler 面：拒绝路径回 INVALID_URL_SCHEME error response（宿主侧拒绝 = 无任何
 * 唤起出口被触达）；放行路径交 openExternal 出口（spy 断言）；出口未装配 →
 * { opened:false } + warn（装配缺陷可见，不假成功）。
 *
 * 运行：cd packages/runtime && npx vitest run test/plugin-openurl-scheme.test.ts
 */

import { describe, it, expect, vi } from 'vitest'

import { PluginRpcServer } from '../src/services/plugin-service/plugin-rpc-server.js'
import type { WorkerPort } from '../src/services/plugin-service/plugin-rpc-server.js'
import { isAllowedOpenUrl, registerOpenUrlRpcHandler } from '../src/services/plugin-service/plugin-rpc-setup.js'

describe('isAllowedOpenUrl scheme 判定四态（S28）', () => {
  it('https 放行（含大写 scheme 归一化变体）', () => {
    expect(isAllowedOpenUrl('https://auth.example.com/oauth/authorize')).toBe(true)
    expect(isAllowedOpenUrl('http://localhost:3000/callback')).toBe(true)
    // WHATWG URL 归一化：scheme 大小写无关，大写变体与 https: 同值
    expect(isAllowedOpenUrl('HTTPS://AUTH.EXAMPLE.COM')).toBe(true)
  })

  it('file:// 拒绝（浮层渲染本机文件是攻击面）', () => {
    expect(isAllowedOpenUrl('file:///Users/x/.taiji/models.json')).toBe(false)
    expect(isAllowedOpenUrl('FILE:///etc/passwd')).toBe(false)
  })

  it('javascript: 及大小写/空白变体拒绝（解析归一化后不在白名单）', () => {
    expect(isAllowedOpenUrl('javascript:alert(1)')).toBe(false)
    // 大写变体：归一小写后 = javascript:，不在白名单
    expect(isAllowedOpenUrl('JAVASCRIPT:alert(1)')).toBe(false)
    // 空白变体：URL 解析剥离内部 tab/换行后 = javascript:
    expect(isAllowedOpenUrl('java\tscript:alert(1)')).toBe(false)
    expect(isAllowedOpenUrl('\tjavascript:alert(1)')).toBe(false)
    expect(isAllowedOpenUrl(' javascript:alert(1)')).toBe(false)
  })

  it('不可解析输入拒绝（相对地址 / 纯文本 / 空串 / data: 自定义 scheme）', () => {
    expect(isAllowedOpenUrl('/local/path')).toBe(false)
    expect(isAllowedOpenUrl('not a url')).toBe(false)
    expect(isAllowedOpenUrl('')).toBe(false)
    expect(isAllowedOpenUrl('data:text/html,<script>')).toBe(false)
    expect(isAllowedOpenUrl('taiji://open-settings')).toBe(false)
  })
})

/** 真实 PluginRpcServer + mock port 的 handler 装配（plugin-ui-event-channel 同款形态） */
function wiredHandler(openExternal?: (url: string) => void) {
  const messages: unknown[] = []
  const port = { postMessage: (msg: unknown) => { messages.push(msg) } } as WorkerPort & { messages: unknown[] }
  const rpc = new PluginRpcServer()
  registerOpenUrlRpcHandler(rpc, { openExternal })
  rpc.registerWorker('w1', port, { trustLevel: 'sandbox', pluginId: 'wool-workbuddy' })
  return { rpc, messages }
}

interface RpcResponse { // oe-exempt:20261024:framework:测试内契约类型——scheme 判定探针单实现常态
  response?: { result?: { opened?: boolean }; error?: { code?: number; message?: string; data?: unknown } }
}

describe('plugin.ui.openUrl RPC handler（D9）', () => {
  it('https 放行 → openExternal 出口收到 URL，回执 { opened: true }', async () => {
    const opened: string[] = []
    const { rpc, messages } = wiredHandler((url) => { opened.push(url) })

    await rpc.dispatch('w1', {
      jsonrpc: '2.0',
      id: 1,
      method: 'plugin.ui.openUrl',
      params: { url: 'https://auth.example.com/oauth/authorize?client_id=x' },
    })

    expect(opened).toEqual(['https://auth.example.com/oauth/authorize?client_id=x'])
    const res = messages[0] as RpcResponse
    expect(res.response?.result).toEqual({ opened: true })
  })

  it.each([
    ['file:// 地址', 'file:///Users/x/secret'],
    ['javascript:', 'javascript:alert(1)'],
    ['javascript: 空白变体', 'java\tscript:alert(1)'],
  ])('%s → INVALID_URL_SCHEME 拒绝，无任何唤起出口被触达（S28 ②③）', async (_label, url) => {
    const opened: string[] = []
    const { rpc, messages } = wiredHandler((u) => { opened.push(u) })

    await rpc.dispatch('w1', {
      jsonrpc: '2.0',
      id: 2,
      method: 'plugin.ui.openUrl',
      params: { url },
    })

    // 宿主侧拒绝 = 唤起出口零触达（结构性成立：校验在出口调用之前）
    expect(opened).toEqual([])
    const res = messages[0] as RpcResponse
    expect(res.response?.error?.message).toContain('INVALID_URL_SCHEME')
  })

  it('出口未装配 → 校验仍生效；放行路径回执 { opened:false } + warn（装配缺陷可见）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { rpc, messages } = wiredHandler(undefined)

      await rpc.dispatch('w1', {
        jsonrpc: '2.0',
        id: 3,
        method: 'plugin.ui.openUrl',
        params: { url: 'file:///etc/passwd' },
      })
      const denied = messages[0] as RpcResponse
      expect(denied.response?.error?.message).toContain('INVALID_URL_SCHEME')

      await rpc.dispatch('w1', {
        jsonrpc: '2.0',
        id: 4,
        method: 'plugin.ui.openUrl',
        params: { url: 'https://example.com' },
      })
      const opened = messages[1] as RpcResponse
      expect(opened.response?.result).toEqual({ opened: false })
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('no openExternal exit wired'))
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('url 缺失/非字符串 → asString 结构化拒绝', async () => {
    const { rpc, messages } = wiredHandler(() => {})

    await rpc.dispatch('w1', {
      jsonrpc: '2.0',
      id: 5,
      method: 'plugin.ui.openUrl',
      params: {},
    })

    const res = messages[0] as RpcResponse
    expect(res.response?.error?.message).toContain('url')
  })
})
