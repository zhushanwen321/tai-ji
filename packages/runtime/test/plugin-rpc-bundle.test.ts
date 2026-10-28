import type { IMessageBroker } from '../src/interfaces.js';
import { PluginActivator, type PluginHost as ActivatorHost } from '../src/services/plugin-service/plugin-activator.js';
import type { PluginCapabilityForkEnvInput } from '../src/services/plugin-service/plugin-fs-guard.js';
import { PluginHost } from '../src/services/plugin-service/plugin-host.js';
import { PermissionStorage } from '../src/services/plugin-service/plugin-permission-storage.js';
import { PluginPermissionChecker } from '../src/services/plugin-service/plugin-permission.js';
import { PluginRegistry } from '../src/services/plugin-service/plugin-registry.js';
import { PluginRpcClient, type ClientPort } from '../src/services/plugin-service/plugin-rpc-client.js';
import { PluginRpcServer, RpcMethodHandler, type WorkerPort } from '../src/services/plugin-service/plugin-rpc-server.js';
import { MAX_FIND_FILES_RESULTS, findFiles, isAllowedOpenUrl, registerOpenUrlRpcHandler } from '../src/services/plugin-service/plugin-rpc-setup.js';
import { PluginService } from '../src/services/plugin-service/plugin-service.js';
import { PluginRpcErrorCodes, type RpcResponse, WorkerToHostMessage, type PluginDescriptor, type RpcRequest } from '../src/services/plugin-service/plugin-types.js';
import type { PluginCatalogEntry } from '@taiji/shared';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs, { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os, { tmpdir } from 'node:os';
import path, { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← test/plugin-rpc.test.ts
// ======================================================================

/** 记录 postMessage 收到的消息 */
function createMockPort(): WorkerPort & { messages: unknown[] } {
  const messages: unknown[] = []
  return {
    messages,
    postMessage(msg: unknown) {
      messages.push(msg)
    },
  }
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('plugin-rpc', () => {
describe('PluginRpcServer', () => {
  let rpc: PluginRpcServer

  beforeEach(() => {
    rpc = new PluginRpcServer()
  })

  // ── TC-3-01: registerMethod + dispatch → success response ─────
  it('TC-3-01: registerMethod + dispatch → success response', async () => {
    const handler: RpcMethodHandler = async (params) => {
      return { echo: params.msg }
    }
    rpc.registerMethod('test.echo', handler)

    const port = createMockPort()
    rpc.registerWorker('w1', port)

    await rpc.dispatch('w1', {
      jsonrpc: '2.0',
      id: 1,
      method: 'test.echo',
      params: { msg: 'hello' },
    })

    expect(port.messages.length).toBe(1)
    const wrapper = port.messages[0] as { type: string; response: RpcResponse }
    expect(wrapper.type).toBe('rpc')
    const resp = wrapper.response
    expect(resp.jsonrpc).toBe('2.0')
    expect(resp.id).toBe(1)
    expect('result' in resp).toBeTruthy()
    expect((resp as { result: unknown }).result).toEqual({ echo: 'hello' })
  })

  // ── TC-3-02: unregistered method → METHOD_NOT_FOUND error ────
  it('TC-3-02: unregistered method → METHOD_NOT_FOUND error', async () => {
    const port = createMockPort()
    rpc.registerWorker('w1', port)

    await rpc.dispatch('w1', {
      jsonrpc: '2.0',
      id: 2,
      method: 'nonexistent.method',
      params: {},
    })

    expect(port.messages.length).toBe(1)
    const wrapper = port.messages[0] as { type: string; response: RpcResponse }
    expect(wrapper.type).toBe('rpc')
    const resp = wrapper.response
    expect('error' in resp).toBeTruthy()
    expect((resp as { error: { code: number; message: string } }).error.code).toBe(PluginRpcErrorCodes.METHOD_NOT_FOUND)
    expect((resp as { error: { code: number; message: string } }).error.message.includes('nonexistent.method')).toBeTruthy()
  })

  // ── TC-3-03: handler throws → INTERNAL_ERROR response ─────────
  it('TC-3-03: handler throws → INTERNAL_ERROR response', async () => {
    const handler: RpcMethodHandler = async () => {
      throw new Error('boom')
    }
    rpc.registerMethod('test.fail', handler)

    const port = createMockPort()
    rpc.registerWorker('w1', port)

    await rpc.dispatch('w1', {
      jsonrpc: '2.0',
      id: 3,
      method: 'test.fail',
      params: {},
    })

    const wrapper = port.messages[0] as { type: string; response: RpcResponse }
    expect(wrapper.type).toBe('rpc')
    const resp = wrapper.response
    expect('error' in resp).toBeTruthy()
    // 无自定义 code → 默认 INTERNAL_ERROR
    expect((resp as { error: { code: number; message: string } }).error.code).toBe(PluginRpcErrorCodes.INTERNAL_ERROR)
    expect((resp as { error: { code: number; message: string } }).error.message).toBe('boom')
  })

  // ── TC-3-04: notify → sends notification to worker ────────────
  it('TC-3-04: notify → sends notification to specific worker', async () => {
    const port1 = createMockPort()
    const port2 = createMockPort()
    rpc.registerWorker('w1', port1)
    rpc.registerWorker('w2', port2)

    rpc.notify('w1', 'test.event', { data: 42 })

    expect(port1.messages.length).toBe(1)
    expect(port2.messages.length).toBe(0)

    const msg = port1.messages[0] as { type: string; notification: { jsonrpc: string; method: string; params: Record<string, unknown> } }
    expect(msg.type).toBe('rpc')
    expect(msg.notification.jsonrpc).toBe('2.0')
    expect(msg.notification.method).toBe('test.event')
    expect(msg.notification.params).toEqual({ data: 42 })
  })

  // ── TC-3-05: broadcast → sends to all workers ─────────────────
  it('TC-3-05: broadcast → sends to all registered workers', async () => {
    const port1 = createMockPort()
    const port2 = createMockPort()
    const port3 = createMockPort()
    rpc.registerWorker('w1', port1)
    rpc.registerWorker('w2', port2)
    rpc.registerWorker('w3', port3)

    rpc.broadcast('system.update', { version: '2.0' })

    expect(port1.messages.length).toBe(1)
    expect(port2.messages.length).toBe(1)
    expect(port3.messages.length).toBe(1)

    for (const port of [port1, port2, port3]) {
      const msg = port.messages[0] as { type: string; notification: { method: string } }
      expect(msg.type).toBe('rpc')
      expect(msg.notification.method).toBe('system.update')
    }
  })

  // ── Fix-4: notification 被权限拒绝 → 不回包但必须落日志 ──────────
  it('Fix-4: permission-denied notification does not reply but logs a warning', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const handler: RpcMethodHandler = async () => ({ ok: true })
      rpc.registerMethod('plugin.secret.read', handler)
      rpc.setPermissionChecker(() => false) // 全拒

      const port = createMockPort()
      rpc.registerWorker('w1', port)

      // notification（无 id）：不回包。dispatch 签名是 RpcRequest（id 必填），但运行时
      // 按 id 判 notification——生产路径经 dispatchHostRpcMessage 的同构 cast 进入，
      // 此处 cast 模拟 Worker 扁平 notification 的真实线上输入形状
      const notification = {
        jsonrpc: '2.0',
        method: 'plugin.secret.read',
        params: { pluginId: 'p-denied' },
      }
      await rpc.dispatch('w1', notification as unknown as RpcRequest)

      expect(port.messages.length).toBe(0) // JSON-RPC 语义：notification 不回包
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(String(warnSpy.mock.calls[0][0])).toContain('plugin.secret.read')
      expect(String(warnSpy.mock.calls[0][0])).toContain('p-denied')

      // 对照：request（带 id）被拒 → 回 PERMISSION_DENIED 错误响应
      await rpc.dispatch('w1', {
        jsonrpc: '2.0',
        id: 9,
        method: 'plugin.secret.read',
        params: { pluginId: 'p-denied' },
      })
      const wrapper = port.messages[0] as { type: string; response: RpcResponse }
      expect(wrapper.type).toBe('rpc')
      expect((wrapper.response as { error: { code: number } }).error.code).toBe(PluginRpcErrorCodes.PERMISSION_DENIED)
    } finally {
      warnSpy.mockRestore()
    }
  })
})
});

// ======================================================================
// ← test/plugin-rpc-client.test.ts
// ======================================================================

function createMockPort_m2_m2_m2_z2(): ClientPort & { messages: unknown[] } {
  const messages: unknown[] = []
  return {
    messages,
    postMessage(msg: unknown) {
      messages.push(msg)
    },
  }
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('plugin-rpc-client', () => {
describe('PluginRpcClient', () => {
  let client: PluginRpcClient
  let port: ReturnType<typeof createMockPort_m2_m2_m2_z2>

  beforeEach(() => {
    client = new PluginRpcClient()
    port = createMockPort_m2_m2_m2_z2()
    client.attach(port)
  })

  // ── TC-3-02: request timeout → RPC_TIMEOUT error ──────────────
  it('TC-3-02: request() rejects with RPC_TIMEOUT when server never responds', async () => {
    const promise = client.request('test.slow', {}, 50)

    // Verify request was sent
    expect(port.messages.length).toBe(1)
    const sent = port.messages[0] as { type: string; method: string; id: number }
    expect(sent.type).toBe('rpc')
    expect(sent.method).toBe('test.slow')

    // No response arrives → timeout after 50ms
    const start = Date.now()
    let caught = false
    try {
      await promise
    } catch (e: unknown) {
      caught = true
      const elapsed = Date.now() - start
      expect(elapsed >= 45).toBeTruthy()
      expect((e as Error).message.includes('RPC timeout')).toBeTruthy()
      expect((e as { code?: number }).code).toBe(PluginRpcErrorCodes.RPC_TIMEOUT)
    }
    expect(caught).toBeTruthy()
  })

  // ── request succeeds when response arrives before timeout ──────
  it('request() resolves when response arrives before timeout', async () => {
    const promise = client.request('test.fast', { x: 1 }, 500)

    // Simulate server response
    const sent = port.messages[0] as { id: number }
    client.handleResponse({
      jsonrpc: '2.0',
      id: sent.id,
      result: { echoed: true },
    })

    const result = await promise
    expect(result).toEqual({ echoed: true })
  })

  // ── request rejects with error response ────────────────────────
  it('request() rejects with error when server returns error', async () => {
    const promise = client.request('test.fail', {}, 500)

    const sent = port.messages[0] as { id: number }
    client.handleResponse({
      jsonrpc: '2.0',
      id: sent.id,
      error: { code: -32600, message: 'bad request' },
    })

    let caught = false
    try {
      await promise
    } catch (e: unknown) {
      caught = true
      expect((e as Error).message.includes('bad request')).toBeTruthy()
      expect((e as { code?: number }).code).toBe(-32600)
    }
    expect(caught).toBeTruthy()
  })

  // ── dispose cancels pending requests ───────────────────────────
  it('dispose() cancels pending requests', async () => {
    const promise = client.request('test.pending', {}, 5000)

    // Dispose before response
    client.dispose()

    let caught = false
    try {
      await promise
    } catch (e: unknown) {
      caught = true
      expect((e as Error).message.includes('disposed')).toBeTruthy()
    }
    expect(caught).toBeTruthy()
  })

  // ── multiple concurrent requests get correct responses ─────────
  it('concurrent requests receive correct responses by id', async () => {
    const promises = [
      client.request('test.a', { val: 1 }, 500),
      client.request('test.b', { val: 2 }, 500),
      client.request('test.c', { val: 3 }, 500),
    ]

    // Respond out of order
    const ids = port.messages.map((m: unknown) => (m as { id: number }).id)
    client.handleResponse({ jsonrpc: '2.0', id: ids[2], result: 'C' })
    client.handleResponse({ jsonrpc: '2.0', id: ids[0], result: 'A' })
    client.handleResponse({ jsonrpc: '2.0', id: ids[1], result: 'B' })

    const results = await Promise.all(promises)
    expect(results).toEqual(['A', 'B', 'C'])
  })

  // ── notification sends without id ──────────────────────────────
  it('notify() sends notification without id', () => {
    client.notify('test.event', { data: 42 })

    expect(port.messages.length).toBe(1)
    const msg = port.messages[0] as { type: string; method: string; id?: number }
    expect(msg.type).toBe('rpc')
    expect(msg.method).toBe('test.event')
    expect(msg.id).toBe(undefined)
  })

  // ── onNotification receives notifications ──────────────────────
  it('onNotification() handler receives notifications', () => {
    const received: unknown[] = []
    client.onNotification('test.push', (params) => {
      received.push(params)
    })

    client.handleNotification({ jsonrpc: '2.0', method: 'test.push', params: { n: 1 } })
    client.handleNotification({ jsonrpc: '2.0', method: 'test.push', params: { n: 2 } })

    expect(received.length).toBe(2)
    expect(received[0]).toEqual({ n: 1 })
    expect(received[1]).toEqual({ n: 2 })
  })

  // ── onNotification unsubscribe stops receiving ─────────────────
  it('onNotification() unsubscribe stops receiving', () => {
    const received: unknown[] = []
    const unsub = client.onNotification('test.temp', (params) => {
      received.push(params)
    })

    client.handleNotification({ jsonrpc: '2.0', method: 'test.temp', params: { a: 1 } })
    unsub()
    client.handleNotification({ jsonrpc: '2.0', method: 'test.temp', params: { a: 2 } })

    expect(received.length).toBe(1)
  })
})
});

// ======================================================================
// ← test/plugin-rpc-setup.test.ts
// ======================================================================

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('plugin-rpc-setup', () => {
// ════════════════ 来源: plugin-findfiles.test.ts ════════════════
describe('plugin-findfiles', () => {
  /**
   * 直测 SUT 导出的 findFiles（plugin-rpc-setup.ts，T10 提取后可直测——真实临时目录，
   * 无 mock；此前测试在文件内本地复制实现自测，SUT 改 ignore/上限/错误吞噬均不红）。
   *
   * findFiles 核心语义：
   * 1. 用 fast-glob 按模式搜索 cwd
   * 2. 忽略 node_modules / .git
   * 3. 返回绝对路径，截断到 MAX_FIND_FILES_RESULTS
   * 4. 任何错误吞噬为空数组
   *
   * 运行：cd packages/runtime && npx vitest run test/plugin-findfiles.test.ts
   */
  describe('findFiles（plugin-rpc-setup SUT 直测，T10）', () => {
    let tmpDir: string

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'findfiles-test-'))
    })

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    })

    it('基本匹配：用 **/*.json 能返回匹配文件', async () => {
      fs.writeFileSync(path.join(tmpDir, 'a.json'), '{}')
      fs.writeFileSync(path.join(tmpDir, 'b.json'), '{}')
      fs.writeFileSync(path.join(tmpDir, 'c.txt'), 'hello')

      const results = await findFiles('**/*.json', tmpDir)
      expect(results).toHaveLength(2)
      expect(results.every(f => f.endsWith('.json'))).toBe(true)
    })

    it('ignore 排除：忽略 node_modules 和 .git 目录', async () => {
      // 正常文件
      fs.writeFileSync(path.join(tmpDir, 'src.ts'), 'code')

      // node_modules 内的文件
      const nmDir = path.join(tmpDir, 'node_modules', 'pkg')
      fs.mkdirSync(nmDir, { recursive: true })
      fs.writeFileSync(path.join(nmDir, 'index.ts'), 'pkg')

      // .git 内的文件
      const gitDir = path.join(tmpDir, '.git', 'objects')
      fs.mkdirSync(gitDir, { recursive: true })
      fs.writeFileSync(path.join(gitDir, 'data.ts'), 'git')

      const results = await findFiles('**/*.ts', tmpDir)
      const basenames = results.map(f => path.basename(f))
      expect(basenames).toContain('src.ts')
      expect(basenames).not.toContain('index.ts')
      expect(basenames).not.toContain('data.ts')
    })

    it('上限截断：超过 MAX_FIND_FILES_RESULTS 条时截断到上限', async () => {
      // 创建上限 +5 个文件
      for (let i = 0; i < MAX_FIND_FILES_RESULTS + 5; i++) {
        fs.writeFileSync(path.join(tmpDir, `file-${i}.txt`), `${i}`)
      }

      const results = await findFiles('**/*.txt', tmpDir)
      expect(MAX_FIND_FILES_RESULTS).toBe(1000) // 上限常量语义（SUT 改上限此断言同步红）
      expect(results).toHaveLength(MAX_FIND_FILES_RESULTS)
      expect(results.every(f => f.endsWith('.txt'))).toBe(true)
    })

    it('cwd 边界：只搜给定 cwd 子树，返回以 cwd 为前缀的绝对路径', async () => {
      fs.writeFileSync(path.join(tmpDir, 'root.json'), '{}')
      const subDir = path.join(tmpDir, 'sub')
      fs.mkdirSync(subDir)
      fs.writeFileSync(path.join(subDir, 'inner.json'), '{}')

      // cwd 指向子目录：只命中子目录内文件（父级 root.json 不越界搜入）
      const results = await findFiles('**/*.json', subDir)
      expect(results).toHaveLength(1)
      expect(path.basename(results[0])).toBe('inner.json')
      expect(path.isAbsolute(results[0])).toBe(true)
      expect(results[0].startsWith(subDir)).toBe(true)
    })

    it('错误吞噬：glob 抛错（非法 pattern）返回空数组而非向外抛', async () => {
      fs.writeFileSync(path.join(tmpDir, 'a.json'), '{}')

      // fast-glob 对非字符串 pattern 抛 TypeError → findFiles 契约吞噬为 []
      const results = await findFiles(null as unknown as string, tmpDir)
      expect(results).toEqual([])
    })
  })
});
// ════════════════ 来源: plugin-openurl-scheme.test.ts ════════════════
describe('plugin-openurl-scheme', () => {
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
});
});

// ======================================================================
// ← test/plugin-catalog-rpc.test.ts
// ======================================================================

// remote-config 层 mock（清单 fail-safe 链的网络/缓存细节不在本单测范围——service 层
// 语义由 plugin-catalog.test.ts 覆盖，本文件只验 RPC 通路装配与 reply 组装）。
const refreshRemoteConfigMock = vi.fn()

const loadRemoteConfigMock = vi.fn()


vi.mock('../src/services/remote-config/remote-config-fetch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/remote-config/remote-config-fetch.js')>()
  return { ...actual, refreshRemoteConfig: (...args: unknown[]) => refreshRemoteConfigMock(...args),
  loadRemoteConfig: (...args: unknown[]) => loadRemoteConfigMock(...args), }
})
function createMockBroker(): IMessageBroker {
  return {
    send: vi.fn(),
    broadcast: vi.fn(),
    sendError: vi.fn(),
  }
}


const CATALOG_ENTRY: PluginCatalogEntry = {
  packageName: '@acme/plugin-wool-workbuddy',
  pluginId: 'wool-workbuddy',
  displayName: 'WorkBuddy',
  pluginVersion: '1.1.0',
  family: {
    id: 'wool-workbuddy',
    displayName: 'WorkBuddy',
    vendor: '腾讯',
    credentialSource: 'oauth',
    modelCount: 17,
  },
}


/** 已装描述符（版本唯一事实 = descriptor.version，D11） */
const DESCRIPTORS: PluginDescriptor[] = [
  { pluginId: 'wool-workbuddy', pluginPath: '/tmp/plugins/wool-workbuddy', version: '1.0.0' } as PluginDescriptor,
]


function wiredService() {
  const registry = {
    getDescriptor: (pluginId: string) => DESCRIPTORS.find((d) => d.pluginId === pluginId),
    getAllDescriptors: () => DESCRIPTORS,
  }
  return new PluginService(registry as never, createMockBroker(), {})
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('plugin-catalog-rpc', () => {
describe('plugin.listAvailable RPC 通路（U5+F3）', () => {
  beforeEach(() => {
    refreshRemoteConfigMock.mockReset()
    loadRemoteConfigMock.mockReset()
  })

  it('清单条目 ⊕ 本地已装版本 → 可安装视图（installed / installedVersion / updateAvailable）', async () => {
    refreshRemoteConfigMock.mockResolvedValue({
      data: { version: 1, plugins: [CATALOG_ENTRY] },
      refreshed: true,
    })
    const service = wiredService()

    const reply = await service.listAvailablePlugins()

    expect(reply.plugins).toHaveLength(1)
    const entry = reply.plugins[0]
    expect(entry.installed).toBe(true)
    expect(entry.installedVersion).toBe('1.0.0')
    // 清单 1.1.0 > 已装 1.0.0 → 更新提示（S26 数据源）
    expect(entry.updateAvailable).toBe(true)
    expect(entry.displayName).toBe('WorkBuddy')
    expect(entry.family?.modelCount).toBe(17)
  })

  it('未安装条目 → installed=false（无 installedVersion / updateAvailable 字段）', async () => {
    refreshRemoteConfigMock.mockResolvedValue({
      data: {
        version: 1,
        plugins: [{ ...CATALOG_ENTRY, pluginId: 'wool-trae', packageName: '@acme/plugin-wool-trae', pluginVersion: '2.0.0' }],
      },
      refreshed: true,
    })
    const service = wiredService()

    const reply = await service.listAvailablePlugins()

    expect(reply.plugins[0]).toEqual({
      packageName: '@acme/plugin-wool-trae',
      pluginId: 'wool-trae',
      displayName: 'WorkBuddy',
      pluginVersion: '2.0.0',
      family: CATALOG_ENTRY.family,
      installed: false,
    })
  })

  it('fail-safe 链尾（无缓存且拉取失败）→ available=false + 本地已装条目回退（S15②，R-2：管理入口不随清单故障消失）', async () => {
    refreshRemoteConfigMock.mockResolvedValue({ data: undefined, refreshed: false, reason: 'network' })
    const service = wiredService()

    const reply = await service.listAvailablePlugins()

    // R-2 终态：available=false 不再是空清单——descriptor 装配的本地已装条目回退
    // （installed=true + installedVersion），renderer 按 namespace 前缀识别插件条目。
    // 本文件 DESCRIPTORS fixture 未带 displayName/packageName/namespace，回退条目按
    // 既有装配语义落 undefined / pluginId 兜底（生产 descriptor 三者恒有值）
    expect(reply.available).toBe(false)
    expect(reply.reason).toBe('network')
    expect(reply.plugins).toEqual([
      {
        packageName: 'wool-workbuddy',
        pluginId: 'wool-workbuddy',
        displayName: undefined,
        pluginVersion: '1.0.0',
        installed: true,
        installedVersion: '1.0.0',
      },
    ])
  })
})
describe('plugin.catalog RPC 通路（U5+F3）', () => {
  beforeEach(() => {
    refreshRemoteConfigMock.mockReset()
    loadRemoteConfigMock.mockReset()
  })

  it('返回清单原始目录条目（含家族元数据，无安装状态比对）', async () => {
    refreshRemoteConfigMock.mockResolvedValue({
      data: { version: 1, plugins: [CATALOG_ENTRY] },
      refreshed: true,
    })
    const service = wiredService()

    const reply = await service.getPluginCatalog()

    expect(reply.entries).toEqual([CATALOG_ENTRY])
  })
})
});

// ======================================================================
// ← test/plugin-capability-wiring.test.ts
// ======================================================================

const __dirname = dirname(fileURLToPath(import.meta.url))


// fork env 键 SSOT（plugin-fs-guard.cjs 的 ENV_* 常量，编码侧 buildPluginCapabilityForkEnv 同源）
const nodeRequire = createRequire(import.meta.url)

const fsGuard = nodeRequire(join(__dirname, '../src/services/plugin-service/plugin-fs-guard.cjs')) as {
  ENV_ALLOWED_MODULES_KEY: string
  ENV_READ_PATHS_KEY: string
}


/** network.http 的放行模块集（D3 表） */
const NETWORK_HTTP_MODULES = ['http', 'https', 'net', 'dns', 'tls']


// ── fork 桩：假子进程 + fork options.env 捕获（零真进程）─────────────
const forkSlot = vi.hoisted(() => ({
  child: null as unknown,
  env: null as Record<string, string | undefined> | null,
}))


vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    fork: (_path: unknown, _args: unknown, options: { env?: Record<string, string | undefined> }): ChildProcess => {
      forkSlot.env = options?.env ?? null
      if (forkSlot.child) return forkSlot.child as ChildProcess
      throw new Error('fork stub: 未装入假子进程（用例须先 installFakeChild）')
    },
  }
})


/**
 * 假 fork 子进程：PluginHostProcess 消费的成员面；load/activate 生命周期握手
 * 自动回复（真实子进程由 bootstrap 驱动，桩按消息类型镜像回复，端到端用例消费）。
 */
class FakeForkChild extends EventEmitter {
  readonly pid = 4321
  exitCode: number | null = null
  signalCode: string | null = null
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  readonly sent: unknown[] = []

  kill(): void {
    this.emitExit(null, 'SIGKILL')
  }

  send(message: unknown): boolean {
    this.sent.push(message)
    const m = message as { type?: string; pluginId?: string }
    if (m?.type === 'load' && m.pluginId) {
      queueMicrotask(() => this.emit('message', { type: 'loaded', pluginId: m.pluginId }))
    }
    if (m?.type === 'activate' && m.pluginId) {
      queueMicrotask(() => this.emit('message', { type: 'activated', pluginId: m.pluginId }))
    }
    return true
  }

  emitExit(code: number | null, signal: string | null): void {
    this.exitCode = code
    this.signalCode = signal
    this.emit('exit', code, signal)
  }
}


function installFakeChild(): FakeForkChild {
  const child = new FakeForkChild()
  forkSlot.child = child as unknown
  return child
}


// ── 激活链用例共享形态（同 plugin-activator.test.ts）─────────────────

function makeDescriptor(overrides: Partial<PluginDescriptor> = {}): PluginDescriptor {
  return {
    pluginId: 'cap-wired',
    version: '1.0.0',
    displayName: 'cap-wired',
    description: '',
    main: 'index.js',
    activationEvents: ['onStartupFinished'],
    trustLevel: 'sandbox',
    status: 'UNLOADED',
    contributes: {},
    permissions: [],
    engines: { 'taiji': '*' },
    pluginPath: '/tmp/cap-wired/index.js',
    source: 'built-in',
    extensionDependencies: [],
    ...overrides,
  }
}


interface WiringMockHost { // oe-exempt:20261024:test:本测试的 mock 宿主形态描述，单实现为测试天然形态（非 ports/SDK 契约抽象）
  host: ActivatorHost
  setCapabilityEnv: ReturnType<typeof vi.fn>
  assignWorker: ReturnType<typeof vi.fn>
}


/**
 * mock 激活宿主：postMessage 后 microtask 内模拟 Worker 回复（激活成功路径）。
 * withCapabilityMethod=false 构造「宿主未实现 setPluginCapabilityEnv」的降级形态
 * （旧 mock 宿主/Worker 版语义——契约方法为可选的原因）。
 */
function createWiringMockHost(
  activator: PluginActivator,
  replyType: 'activated' | 'deactivated' = 'activated',
  withCapabilityMethod = true,
): WiringMockHost {
  const setCapabilityEnv = vi.fn((_pluginId: string, _input: PluginCapabilityForkEnvInput) => {})
  const assignWorker = vi.fn((_pluginId: string, _trustLevel: 'trusted' | 'sandbox') => Promise.resolve('worker-1'))
  const host: ActivatorHost = {
    assignWorker,
    loadPlugin: vi.fn(() => Promise.resolve()),
    getWorkerHandle: vi.fn((pluginId: string) => ({
      workerId: 'worker-1',
      postMessage: vi.fn(() => {
        queueMicrotask(() => {
          activator.handleWorkerReply({ type: replyType, pluginId })
        })
      }),
    })),
    terminateWorker: vi.fn(() => Promise.resolve()),
    ...(withCapabilityMethod ? { setPluginCapabilityEnv: setCapabilityEnv } : {}),
  }
  return { host, setCapabilityEnv, assignWorker }
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('plugin-capability-wiring', () => {
// ── ① 激活链登记 ────────────────────────────────────────────────────

describe('激活链登记（descriptor → host.setPluginCapabilityEnv）', () => {
  it('sandbox descriptor：assignWorker 之前登记 manifest capabilities/readPaths', async () => {
    const activator = new PluginActivator()
    const desc = makeDescriptor({
      pluginId: 'cap-sandbox',
      capabilities: ['network.http', 'fs.read-user-data'],
      readPaths: ['Library/App/storage.json'],
    })
    activator.registerDescriptors([desc])
    const { host, setCapabilityEnv, assignWorker } = createWiringMockHost(activator)

    await activator.activatePlugin('cap-sandbox', { type: 'onStartupFinished' }, host)

    expect(activator.getState('cap-sandbox')).toBe('ACTIVE')
    expect(setCapabilityEnv).toHaveBeenCalledTimes(1)
    expect(setCapabilityEnv).toHaveBeenCalledWith('cap-sandbox', {
      capabilities: ['network.http', 'fs.read-user-data'],
      readPaths: ['Library/App/storage.json'],
    })
    // 登记必须先于 assignWorker（fork 只发生在 assignProcess 内，后登记不生效）
    expect(setCapabilityEnv.mock.invocationCallOrder[0]).toBeLessThan(assignWorker.mock.invocationCallOrder[0])
  })

  it('trusted descriptor：不登记（Worker 线程无 ESM loader，无 fork env 语义）', async () => {
    const activator = new PluginActivator()
    activator.registerDescriptors([makeDescriptor({ pluginId: 'cap-trusted', trustLevel: 'trusted' })])
    const { host, setCapabilityEnv } = createWiringMockHost(activator)

    await activator.activatePlugin('cap-trusted', { type: 'onStartupFinished' }, host)

    expect(activator.getState('cap-trusted')).toBe('ACTIVE')
    expect(setCapabilityEnv).not.toHaveBeenCalled()
  })

  it('宿主未实现该方法（mock/Worker 版语义）：激活不炸（fail-closed 降级）', async () => {
    const activator = new PluginActivator()
    activator.registerDescriptors([makeDescriptor({ pluginId: 'cap-degrade' })])
    const { host } = createWiringMockHost(activator, 'activated', false)

    await activator.activatePlugin('cap-degrade', { type: 'onStartupFinished' }, host)

    expect(activator.getState('cap-degrade')).toBe('ACTIVE')
  })

  it('每次激活重登记：deactivate 后再激活，登记再次发生（进程回收清除后由激活链恢复）', async () => {
    const activator = new PluginActivator()
    activator.registerDescriptors([
      makeDescriptor({ pluginId: 'cap-recycle', capabilities: ['crypto'] }),
    ])
    const first = createWiringMockHost(activator, 'activated')
    await activator.activatePlugin('cap-recycle', { type: 'onStartupFinished' }, first.host)
    expect(first.setCapabilityEnv).toHaveBeenCalledTimes(1)

    const deact = createWiringMockHost(activator, 'deactivated')
    await activator.deactivatePlugin('cap-recycle', deact.host)
    expect(activator.getState('cap-recycle')).toBe('UNLOADED')

    const second = createWiringMockHost(activator, 'activated')
    await activator.activatePlugin('cap-recycle', { type: 'onStartupFinished' }, second.host)
    expect(second.setCapabilityEnv).toHaveBeenCalledTimes(1)
    expect(second.setCapabilityEnv).toHaveBeenCalledWith('cap-recycle', { capabilities: ['crypto'] })
  })
})
// ── ② + ③ 真实宿主链：PluginHost 转发 → 子进程宿主 → fork env ────────

describe('真实宿主链 fork env 注入（PluginHost → PluginHostProcess）', () => {
  let dataDir = ''
  const createdDirs: string[] = []

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cap-wiring-'))
    createdDirs.push(dataDir)
  })

  afterEach(() => {
    forkSlot.child = null
    forkSlot.env = null
  })

  afterAll(() => {
    // maxRetries+retryDelay：teardown 递归删除 ENOTEMPTY 瞬态重试（pre-commit flake 卫生硬要求）
    for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  /** 真实 PluginHost（fork 已桩化；bootstrap 占位路径仅短路 resolveAndValidateFile 链） */
  function makeRealHost(): PluginHost {
    return new PluginHost(new PluginRpcServer(), {
      bootstrapPathOverride: join(dataDir, 'bootstrap-not-executed.cjs'),
      // sandbox fork 前断言 execArgv 含 --import（MF-1 fail-closed 守护）；fork 已桩化，
      // loader 路径不实际加载，占位即可
      execArgv: ['--import', 'cap-wiring-stub-loader.cjs'],
    })
  }

  it('③ 登记 → sandbox fork env 含放行清单与 readPaths（D3 注入点）', async () => {
    const host = makeRealHost()
    installFakeChild()
    const pluginPath = join(dataDir, 'cap-fork', 'index.js')

    host.setPluginCapabilityEnv('cap-fork', {
      capabilities: ['network.http'],
      readPaths: ['Library/App/storage.json'],
    })
    await host.assignWorker('cap-fork', 'sandbox', pluginPath)

    expect(forkSlot.env?.[fsGuard.ENV_ALLOWED_MODULES_KEY]).toBe(JSON.stringify(NETWORK_HTTP_MODULES))
    expect(forkSlot.env?.[fsGuard.ENV_READ_PATHS_KEY]).toBe(JSON.stringify(['Library/App/storage.json']))
    // sandbox 目录注入不受能力登记影响（fork env 双通道并存）
    expect(forkSlot.env?.TAIJI_PLUGIN_SANDBOX_DIR).toBe(dirname(pluginPath))
    await host.shutdown()
  })

  it('③ 未登记插件：fork env 无能力键（fail-closed 基线）', async () => {
    const host = makeRealHost()
    installFakeChild()

    await host.assignWorker('cap-none', 'sandbox', join(dataDir, 'cap-none', 'index.js'))

    expect(forkSlot.env?.[fsGuard.ENV_ALLOWED_MODULES_KEY]).toBeUndefined()
    expect(forkSlot.env?.[fsGuard.ENV_READ_PATHS_KEY]).toBeUndefined()
    await host.shutdown()
  })

  it('③ 进程回收清除登记 → 重登记后再 fork 重新生效（重建链前提）', async () => {
    const host = makeRealHost()
    installFakeChild()
    const pluginPath = join(dataDir, 'cap-cycle', 'index.js')

    host.setPluginCapabilityEnv('cap-cycle', { capabilities: ['network.http'] })
    const workerId = await host.assignWorker('cap-cycle', 'sandbox', pluginPath)

    // terminateWorker 回收进程并清除登记（capabilityEnvInputs 随 removeIndexEntries 删除）
    await host.terminateWorker(workerId)

    // 重激活链重登记后再 fork，放行清单重新注入
    host.setPluginCapabilityEnv('cap-cycle', { capabilities: ['network.http'] })
    installFakeChild()
    await host.assignWorker('cap-cycle', 'sandbox', pluginPath)
    expect(forkSlot.env?.[fsGuard.ENV_ALLOWED_MODULES_KEY]).toBe(JSON.stringify(NETWORK_HTTP_MODULES))
    await host.shutdown()
  })

  it('端到端：activatePlugin → 真 PluginHost → fork options.env 含放行清单（S9 接线段）', async () => {
    const host = makeRealHost()
    installFakeChild()
    const pluginPath = join(dataDir, 'cap-e2e', 'index.js')
    const activator = new PluginActivator()
    // reply 接线对齐生产装配（plugin-service.registerWorkerCallbacks）
    host.setReplyCallback((msg) => activator.handleWorkerReply(msg as WorkerToHostMessage))
    activator.registerDescriptors([
      makeDescriptor({
        pluginId: 'cap-e2e',
        pluginPath,
        capabilities: ['network.http'],
        readPaths: ['data/in.txt'],
      }),
    ])

    await activator.activatePlugin('cap-e2e', { type: 'onStartupFinished' }, host)

    expect(activator.getState('cap-e2e')).toBe('ACTIVE')
    expect(forkSlot.env?.[fsGuard.ENV_ALLOWED_MODULES_KEY]).toBe(JSON.stringify(NETWORK_HTTP_MODULES))
    expect(forkSlot.env?.[fsGuard.ENV_READ_PATHS_KEY]).toBe(JSON.stringify(['data/in.txt']))
    await host.shutdown()
  })
})
});

// ======================================================================
// ← test/plugin-identity-auth.test.ts
// ======================================================================

const __dirname_m2_m2_z2 = dirname(fileURLToPath(import.meta.url))

const WORKER_MOCK = resolve(__dirname_m2_m2_z2, 'fixtures/mock-bootstrap.cjs')

const PROCESS_MOCK_SOURCE = resolve(__dirname_m2_m2_z2, 'fixtures/plugin-bootstrap-process.mock.cjs')

const NOOP_ESM_LOADER = resolve(__dirname_m2_m2_z2, 'fixtures/noop-esm-loader.cjs')


let tmpDir: string


/** 记录 postMessage 收到的消息（mock worker 通道） */
function createMockPort_m2_m2_m2_z3(): WorkerPort & { messages: unknown[] } {
  const messages: unknown[] = []
  return {
    messages,
    postMessage(msg: unknown) {
      messages.push(msg)
    },
  }
}


/** 空 registry mock（check 路径不消费 registry，仅构造 checker 需要） */
function emptyRegistry(): PluginRegistry {
  return { getDescriptor: () => undefined } as unknown as PluginRegistry
}


/** 真实 server + 真实 checker 组合（与 plugin-lifecycle 3c 步同构接线） */
function createAuthedServer(): { rpc: PluginRpcServer; checker: PluginPermissionChecker } {
  const rpc = new PluginRpcServer()
  const checker = new PluginPermissionChecker(emptyRegistry(), new PermissionStorage(tmpDir))
  rpc.setPermissionChecker((identity, method) => checker.check(identity, method))
  return { rpc, checker }
}


/** 从 mock port 提取第一条 RPC 响应 */
function firstResponse(port: { messages: unknown[] }): RpcResponse {
  const wrapper = port.messages[0] as { type: string; response: RpcResponse }
  expect(wrapper?.type).toBe('rpc')
  return wrapper.response
}


/** 捕获 handler 收到的 params（对象属性跨闭包不被 TS 收窄，断言时无需 double-cast） */
function createParamsCapture(): { current: Record<string, unknown> | null } {
  return { current: null }
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('plugin-identity-auth', () => {
beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'plugin-identity-auth-'))
})
afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})
describe('dispatch 鉴权（通道身份，非消息体自报）', () => {
  it('sandbox 伪冒 trusted id 调未授权方法 → PERMISSION_DENIED 且文案含 identity mismatch', async () => {
    const { rpc } = createAuthedServer()
    // 恶意 sandbox 插件 'evil'：无任何授权
    const port = createMockPort_m2_m2_m2_z3()
    rpc.registerWorker('sandbox-evil', port, { trustLevel: 'sandbox', pluginId: 'evil' })

    const captured = createParamsCapture()
    rpc.registerMethod('plugin.agent.setModel', async (params) => {
      captured.current = params
      return { ok: true }
    })

    // 伪冒 built-in 插件 id 'scheduler-manager'（旧版：trusted/built-in 一律放行的漏洞）
    await rpc.dispatch('sandbox-evil', {
      jsonrpc: '2.0',
      id: 1,
      method: 'plugin.agent.setModel',
      params: { pluginId: 'scheduler-manager', model: 'evil-model' },
    })

    const resp = firstResponse(port)
    expect('error' in resp).toBeTruthy()
    const error = (resp as { error: { code: number; message: string } }).error
    expect(error.code).toBe(PluginRpcErrorCodes.PERMISSION_DENIED)
    // identity mismatch 语义：直接指出消息自报 id 与通道身份不符
    expect(error.message).toContain('identity mismatch')
    expect(error.message).toContain('scheduler-manager')
    expect(error.message).toContain('evil')
    // handler 未执行
    expect(captured.current).toBeNull()
  })

  it('sandbox 已授权方法 + 伪冒他人 pluginId → 放行且 params.pluginId 覆写为通道真实身份', async () => {
    const { rpc, checker } = createAuthedServer()
    // evil 声明并获批 storage 写权限（完整方法名口径 grant）
    checker.grant('evil', ['plugin.storage.global.set'])

    const port = createMockPort_m2_m2_m2_z3()
    rpc.registerWorker('sandbox-evil', port, { trustLevel: 'sandbox', pluginId: 'evil' })

    const captured = createParamsCapture()
    rpc.registerMethod('plugin.storage.global.set', async (params) => {
      captured.current = params
      return { ok: true }
    })

    // 方法在授权集内（鉴权按通道身份 evil 查 granted → 放行），
    // 但 params.pluginId 伪冒 'scheduler-manager' → 分区键必须被覆写为 evil
    await rpc.dispatch('sandbox-evil', {
      jsonrpc: '2.0',
      id: 2,
      method: 'plugin.storage.global.set',
      params: { pluginId: 'scheduler-manager', key: 'k', value: 'v' },
    })

    const resp = firstResponse(port)
    expect('result' in resp).toBeTruthy()
    expect(captured.current).not.toBeNull()
    expect(captured.current!.pluginId).toBe('evil')
    expect(captured.current!.key).toBe('k')
  })

  it('trusted worker → 放行且 params 不覆写（worker 级语义，trusted 间互不设防）', async () => {
    const { rpc } = createAuthedServer()
    const port = createMockPort_m2_m2_m2_z3()
    rpc.registerWorker('trusted-1', port, { trustLevel: 'trusted' })

    const captured = createParamsCapture()
    rpc.registerMethod('plugin.agent.setModel', async (params) => {
      captured.current = params
      return { ok: true }
    })

    // trusted 无需任何 grant；自报 pluginId 为任意值（含伪冒 sandbox id）均放行
    await rpc.dispatch('trusted-1', {
      jsonrpc: '2.0',
      id: 3,
      method: 'plugin.agent.setModel',
      params: { pluginId: 'some-sandbox-plugin', model: 'm' },
    })

    const resp = firstResponse(port)
    expect('result' in resp).toBeTruthy()
    // trusted 通道多插件共享，无唯一归属 → 不覆写（插件自身分区由它自报，
    // trusted 互不设防是设计语义而非漏洞）
    expect(captured.current!.pluginId).toBe('some-sandbox-plugin')
  })

  it('已注册端口但无身份（identity 缺失）→ fail-closed PERMISSION_DENIED', async () => {
    const { rpc } = createAuthedServer()
    const port = createMockPort_m2_m2_m2_z3()
    // registerWorker 未传 identity（身份缺失的 Worker：宿主接线异常或旧代码路径）
    rpc.registerWorker('w-legacy', port)

    rpc.registerMethod('plugin.notify', async () => ({ ok: true }))

    await rpc.dispatch('w-legacy', {
      jsonrpc: '2.0',
      id: 4,
      method: 'plugin.notify',
      params: { pluginId: 'x' },
    })

    const resp = firstResponse(port)
    expect('error' in resp).toBeTruthy()
    const error = (resp as { error: { code: number; message: string } }).error
    expect(error.code).toBe(PluginRpcErrorCodes.PERMISSION_DENIED)
    expect(error.message).toContain('cannot resolve worker identity')
    expect(error.message).toContain('w-legacy')
  })

  it('完全未注册的 workerId → 无回包（fail-closed，不执行 handler）', async () => {
    const { rpc } = createAuthedServer()
    const port = createMockPort_m2_m2_m2_z3()
    rpc.registerWorker('w-real', port, { trustLevel: 'sandbox', pluginId: 'real' })

    let called = false
    rpc.registerMethod('plugin.notify', async () => {
      called = true
      return { ok: true }
    })

    // 未知来源：dispatch 直接 no-op（无端口可回），handler 不执行
    await rpc.dispatch('w-forged', {
      jsonrpc: '2.0',
      id: 5,
      method: 'plugin.notify',
      params: { pluginId: 'real' },
    })

    expect(port.messages.length).toBe(0)
    expect(called).toBe(false)
  })

  it('unregisterWorker 后身份同步注销 → dispatch 无回包、resolveIdentity undefined', async () => {
    const { rpc } = createAuthedServer()
    const port = createMockPort_m2_m2_m2_z3()
    rpc.registerWorker('sandbox-gone', port, { trustLevel: 'sandbox', pluginId: 'gone' })
    expect(rpc.resolveIdentity('sandbox-gone')).toEqual({ trustLevel: 'sandbox', pluginId: 'gone' })

    rpc.unregisterWorker('sandbox-gone')
    expect(rpc.resolveIdentity('sandbox-gone')).toBeUndefined()

    await rpc.dispatch('sandbox-gone', {
      jsonrpc: '2.0',
      id: 6,
      method: 'plugin.notify',
      params: { pluginId: 'gone' },
    })
    expect(port.messages.length).toBe(0)
  })
})
describe('host 级身份接线（registerWorker 传身份元数据）', () => {
  // 本文件 fork 已被文件级 mock 桩化（installFakeChild 形态）；原独立文件走真实 fork，
  // 本节身份断言（注册/反查/terminate 注销）不依赖真实子进程，改用假子进程承载。
  afterEach(() => {
    forkSlot.child = null
    forkSlot.env = null
  })

  it('trusted Worker：assignWorker 注册 worker 级 trusted 身份（无 pluginId 归属）', async () => {
    const rpc = new PluginRpcServer()
    const host = new PluginHost(rpc, { workerBootstrapOverride: WORKER_MOCK })

    const workerId1 = await host.assignWorker('tp-1', 'trusted')
    const workerId2 = await host.assignWorker('tp-2', 'trusted')

    // 共享 Worker → 同一通道身份；多插件共享无唯一归属（pluginId undefined）
    expect(workerId1).toBe(workerId2)
    expect(rpc.resolveIdentity(workerId1)).toEqual({ trustLevel: 'trusted' })

    await host.shutdown()
  })

  it('sandbox fork 子进程：assignWorker 注册一对一 sandbox 身份（含 pluginId）', async () => {
    const rpc = new PluginRpcServer()
    const host = new PluginHost(rpc, {
      bootstrapPathOverride: PROCESS_MOCK_SOURCE,
      execArgv: ['--import', NOOP_ESM_LOADER],
    })
    installFakeChild()

    const processId = await host.assignWorker('external-plugin', 'sandbox', tmpDir)
    expect(processId).toBe('sandbox-external-plugin')
    expect(rpc.resolveIdentity(processId)).toEqual({
      trustLevel: 'sandbox',
      pluginId: 'external-plugin',
    })

    // terminate 清理：端口与身份同生共死
    await host.terminateWorker(processId)
    expect(rpc.resolveIdentity(processId)).toBeUndefined()

    await host.shutdown()
  })
})
});

// ======================================================================
// ← test/plugin-version-check.test.ts
// ======================================================================

const __dirname_m2_m2_z3 = dirname(fileURLToPath(import.meta.url))


// 从实际 package.json 读取版本（tsup bundle 后 fs.readFileSync 向上查找）
const PROJECT_ROOT = resolve(__dirname_m2_m2_z3, '..')

const PKG_VERSION = JSON.parse(readFileSync(resolve(PROJECT_ROOT, 'package.json'), 'utf-8')).version


const { checkPluginCompatibility } = await import('../src/services/plugin-service/plugin-version-checker.js')

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('plugin-version-check', () => {
describe('checkPluginCompatibility', () => {
  it('returns compatible for wildcard "*"', () => {
    const result = checkPluginCompatibility('*')
    expect(result.compatible).toBe(true)
    expect(result.reason).toBeUndefined()
  })

  it('returns compatible for empty string', () => {
    const result = checkPluginCompatibility('')
    expect(result.compatible).toBe(true)
  })

  it('returns compatible when current version satisfies range', () => {
    const result = checkPluginCompatibility(`^${PKG_VERSION.replace(/\d+$/, '0')}`)
    expect(result.compatible).toBe(true)
  })

  it('returns incompatible for unsatisfied range', () => {
    const result = checkPluginCompatibility('^99.0.0')
    expect(result.compatible).toBe(false)
    expect(result.reason).toContain('Requires taiji')
    expect(result.reason).toContain('^99.0.0')
  })

  it('returns incompatible for invalid version range', () => {
    const result = checkPluginCompatibility('not-valid-range')
    expect(result.compatible).toBe(false)
    expect(result.reason).toContain('Invalid version range')
    expect(result.reason).toContain('not-valid-range')
  })

  it('returns compatible for exact current version', () => {
    const result = checkPluginCompatibility(PKG_VERSION)
    expect(result.compatible).toBe(true)
  })
})
});

// ======================================================================
// ← test/plugin-registry-trust.test.ts
// ======================================================================

// 本文件另为 plugin-registry 合并载体（plugin-foundation 折叠为分节）。


/**
 * S1-W4（D3 信任级判定权回收）安全回归测试。
 *
 * 覆盖四条新语义：
 *   1. external 插件 manifest 自报 trusted → 强制 sandbox + warning
 *   2. built-in source 一律 trusted（manifest 声明也不参与判定）
 *   3. --builtin-plugins-dir 显式指定时不做 cwd 探测（防 repo 预置目录注入）
 *   4. 缺失该参数时回退 cwd 探测 + warning（dev 直跑/测试兼容，fail-visible）
 * 外加 electron 主进程 spawn 侧参数注入的源码级断言（vitest 到不了 electron 主进程）。
 */

const __dirname_m2 = dirname(fileURLToPath(import.meta.url))

/** worktree 根（test/ → packages/runtime → packages → root），scheduler-manager 真实 built-in 目录在 <root>/resources/plugins */
const REPO_ROOT = resolve(__dirname_m2, '..', '..', '..')

/** electron 主进程 spawn 源文件（代码审查级断言用） */
const PROCESS_CONTROL_SRC = resolve(REPO_ROOT, 'apps', 'electron', 'main', 'supervisor', 'process-control.ts')


let tmpDir_m2: string

let warnSpy: ReturnType<typeof vi.spyOn>


/** 在 <base>/<...segments>/ 下写入一个最小插件目录（package.json + manifest 合并字段） */
async function writePlugin(base: string, segments: string[], name: string, manifestExtra: Record<string, unknown> = {}): Promise<string> {
  const pluginDir = join(base, ...segments, name)
  await mkdir(pluginDir, { recursive: true })
  await writeFile(join(pluginDir, 'package.json'), JSON.stringify({
    name,
    version: '1.0.0',
    taijiPlugin: { manifestVersion: 1, main: 'index.js', activationEvents: ['onStartupFinished'], ...manifestExtra },
  }), 'utf-8')
  return pluginDir
}


/** 断言 warn spy 收到过一条含所有给定片段的消息 */
function warnMessages(): string[] {
  return warnSpy.mock.calls.map((c: unknown[]) => c.join(' '))
}


function expectWarnedContaining(...fragments: string[]): void {
  expect(warnMessages().some((msg: string) => fragments.every(f => msg.includes(f)))).toBe(true)
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('plugin-registry-trust', () => {
beforeEach(async () => {
  tmpDir_m2 = await mkdtemp(join(tmpdir(), 'plugin-registry-trust-'))
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(async () => {
  warnSpy.mockRestore()
  await rm(tmpDir_m2, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})
describe('PluginRegistry trust boundary (S1-W4 / D3)', () => {
  it('SEC-U1 external: manifest self-declared trustLevel "trusted" is forced to sandbox with warning', async () => {
    await writePlugin(tmpDir_m2, ['.taiji', 'plugins'], 'evil-trusted', { trustLevel: 'trusted' })

    const registry = new PluginRegistry(tmpDir_m2, tmpDir_m2)
    const descriptors = await registry.scan()

    const desc = descriptors.find(d => d.pluginId === 'evil-trusted')
    expect(desc).toBeTruthy()
    expect(desc!.source).toBe('external')
    // 核心：自报 trusted 被宿主强制覆盖为 sandbox
    expect(desc!.trustLevel).toBe('sandbox')
    // fail-visible：落 warning，含插件 id 与被忽略的声明值
    expectWarnedContaining('evil-trusted', 'trusted', 'sandbox')
  })

  it('SEC-U1 external: manifest declaring sandbox or omitting trustLevel stays sandbox without warning', async () => {
    await writePlugin(tmpDir_m2, ['.taiji', 'plugins'], 'honest-sandbox', { trustLevel: 'sandbox' })
    await writePlugin(tmpDir_m2, ['.taiji', 'plugins'], 'no-declaration', {})

    const registry = new PluginRegistry(tmpDir_m2, tmpDir_m2)
    const descriptors = await registry.scan()

    expect(descriptors.find(d => d.pluginId === 'honest-sandbox')!.trustLevel).toBe('sandbox')
    expect(descriptors.find(d => d.pluginId === 'no-declaration')!.trustLevel).toBe('sandbox')
    // 声明值与强制值一致（sandbox/缺省）时无「ignored and forced」warning
    expect(warnMessages().some((msg: string) => msg.includes('ignored and forced'))).toBe(false)
  })

  it('SEC-U1 builtin: built-in source plugins are always trusted even when manifest declares sandbox', async () => {
    const builtinDir = join(tmpDir_m2, 'explicit-builtin')
    // manifest 自降 sandbox 也无效：source=built-in 一律 trusted（宿主判定权）
    await writePlugin(builtinDir, [], 'builtin-sandbox-declared', { trustLevel: 'sandbox' })
    await writePlugin(builtinDir, [], 'builtin-no-declaration', {})

    const registry = new PluginRegistry(tmpDir_m2, join(tmpDir_m2, 'config'), builtinDir)
    const descriptors = await registry.scan()

    expect(descriptors.find(d => d.pluginId === 'builtin-sandbox-declared')!.trustLevel).toBe('trusted')
    expect(descriptors.find(d => d.pluginId === 'builtin-no-declaration')!.trustLevel).toBe('trusted')
  })

  it('SEC-U1 builtin dir: explicit --builtin-plugins-dir path is used exclusively, no cwd probing', async () => {
    // 模拟 pnpm dev 的 runtime cwd：<root>/apps/electron（仓库根在其上两层）
    const projectRoot = join(tmpDir_m2, 'apps', 'electron')
    await mkdir(projectRoot, { recursive: true })

    // cwd 探测链的两个候选位置各放一个「恶意预置」插件（供应链攻击面）
    await writePlugin(projectRoot, ['resources', 'plugins'], 'local-rogue-builtin')
    await writePlugin(tmpDir_m2, ['resources', 'plugins'], 'up-level-rogue-builtin')

    // 显式注入目录放合法 built-in
    const explicitDir = join(tmpDir_m2, 'explicit-builtin-dir')
    await writePlugin(explicitDir, [], 'legit-builtin')

    const registry = new PluginRegistry(projectRoot, join(tmpDir_m2, 'config'), explicitDir)
    const descriptors = await registry.scan()

    const ids = descriptors.map(d => d.pluginId)
    // 显式路径唯一优先：合法 built-in 可见
    expect(ids).toContain('legit-builtin')
    // cwd 两个候选位置的插件都不得被发现（不做探测）
    expect(ids).not.toContain('local-rogue-builtin')
    expect(ids).not.toContain('up-level-rogue-builtin')
    // 显式指定时不落回退 warning
    expect(warnMessages().some((msg: string) => msg.includes('falling back'))).toBe(false)
  })

  it('SEC-U1 builtin dir: explicit path wins even when it does not exist (no downgrade to cwd probing)', async () => {
    const projectRoot = join(tmpDir_m2, 'apps', 'electron')
    await mkdir(projectRoot, { recursive: true })
    // cwd 候选位置存在恶意预置插件，显式路径却不存在
    await writePlugin(tmpDir_m2, ['resources', 'plugins'], 'rogue-when-missing')

    const registry = new PluginRegistry(projectRoot, join(tmpDir_m2, 'config'), join(tmpDir_m2, 'missing-builtin-dir'))
    const descriptors = await registry.scan()

    // 显式路径缺失 → built-in 扫描为空（readdir 失败静默跳过），绝不降级捡 cwd 目录
    expect(descriptors.map(d => d.pluginId)).not.toContain('rogue-when-missing')
  })

  it('SEC-U1 fallback: missing --builtin-plugins-dir falls back to cwd probing with warning', async () => {
    // 不传第三参（模拟 dev 直跑 / vitest / e2e 脚本起 runtime 无主进程）
    const projectRoot = join(tmpDir_m2, 'apps', 'electron')
    await mkdir(projectRoot, { recursive: true })
    await writePlugin(tmpDir_m2, ['resources', 'plugins'], 'fallback-builtin')

    const registry = new PluginRegistry(projectRoot, join(tmpDir_m2, 'config'))
    const descriptors = await registry.scan()

    // 回退探测仍可用（测试环境 built-in 可见性）
    const desc = descriptors.find(d => d.pluginId === 'fallback-builtin')
    expect(desc).toBeTruthy()
    expect(desc!.source).toBe('built-in')
    expect(desc!.trustLevel).toBe('trusted')
    // fail-visible：使用回退时落 warning
    expectWarnedContaining('--builtin-plugins-dir', 'falling back')
  })

  it('SEC-U1 builtin regression: the built-in plugin stays trusted and discoverable under new rules', async () => {
    // 用真实 worktree 的 resources/plugins（scheduler-manager 所在）+ 显式注入目录形态验证：
    // 主进程总是显式传参的生产路径下，scheduler-manager source=built-in、trustLevel=trusted、入口可解析
    const builtinDir = join(REPO_ROOT, 'resources', 'plugins')
    expect(existsSync(join(builtinDir, 'scheduler-manager'))).toBe(true)

    const registry = new PluginRegistry(tmpDir_m2, tmpDir_m2, builtinDir)
    const descriptors = await registry.scan()

    const desc = descriptors.find(d => d.pluginId === 'scheduler-manager')
    expect(desc).toBeTruthy()
    expect(desc!.source).toBe('built-in')
    expect(desc!.trustLevel).toBe('trusted')
    expect(desc!.pluginPath).toBe(join(builtinDir, 'scheduler-manager', 'index.js'))
  })

  it('SEC-U1 electron: process-control.ts injects --builtin-plugins-dir in both packaged and dev spawn forms', async () => {
    // vitest 到不了 electron 主进程，做源码级断言（代码审查自动化）
    const src = await readFile(PROCESS_CONTROL_SRC, 'utf-8')

    // 两种 spawn 形态（打包 process.execPath / dev node+tsx）各注入一次
    const injections = src.match(/--builtin-plugins-dir=/g) ?? []
    expect(injections.length).toBeGreaterThanOrEqual(2)
    // 打包形态：process.resourcesPath + resources/plugins（extraResources 拷贝目标）
    expect(src).toContain("path.join(process.resourcesPath, 'resources', 'plugins')")
    // dev 形态：repo 根 resources/plugins
    expect(src).toContain("path.join(repoRoot, 'resources', 'plugins')")
  })
})
// ════════════════ 来源: plugin-foundation.test.ts ════════════════

describe('plugin-foundation', () => {
  let tmpDir_m2: string

  beforeAll(async () => {
    tmpDir_m2 = await mkdtemp(join(tmpdir(), 'plugin-foundation-test-'))
  })

  afterAll(async () => {
    await rm(tmpDir_m2, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  describe('PluginRegistry built-in scan', () => {
    it('scan() includes built-in path resources/plugins/', async () => {
      const registry = new PluginRegistry(tmpDir_m2, tmpDir_m2)
      // 获取 scan 的目录列表——通过创建 built-in 插件验证
      const builtInDir = join(tmpDir_m2, 'resources', 'plugins', 'core-tool')
      await mkdir(builtInDir, { recursive: true })
      await writeFile(
        join(builtInDir, 'package.json'),
        JSON.stringify({
          name: 'core-tool',
          version: '1.0.0',
          taijiPlugin: {
            manifestVersion: 1,
            main: 'index.js',
            activationEvents: ['onStartupFinished'],
          },
        }),
        'utf-8',
      )

      const descriptors = await registry.scan()
      const coreTool = descriptors.find(d => d.pluginId === 'core-tool')!
      expect(coreTool).toBeTruthy()
      expect(coreTool.source).toBe('built-in')
      expect(coreTool.extensionDependencies).toEqual([])
    })

    it('external plugins are marked as external', async () => {
      const pluginDir = join(tmpDir_m2, '.taiji', 'plugins', 'ext-plugin')
      await mkdir(pluginDir, { recursive: true })
      await writeFile(
        join(pluginDir, 'package.json'),
        JSON.stringify({
          name: 'ext-plugin',
          version: '1.0.0',
          taijiPlugin: {
            manifestVersion: 1,
            main: 'index.js',
            activationEvents: [],
            extensionDependencies: ['core-tool'],
          },
        }),
        'utf-8',
      )

      const registry = new PluginRegistry(tmpDir_m2, tmpDir_m2)
      const descriptors = await registry.scan()
      const ext = descriptors.find(d => d.pluginId === 'ext-plugin')!
      expect(ext).toBeTruthy()
      expect(ext.source).toBe('external')
      expect(ext.extensionDependencies).toEqual(['core-tool'])
    })
  })
})
});
