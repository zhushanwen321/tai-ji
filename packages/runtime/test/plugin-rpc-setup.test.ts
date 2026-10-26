/**
 * plugin-rpc-setup：同被测对象多测试文件合并产物（round5-g 测试提速整合）。
 * 来源（各来源节以基名 describe 包裹，节内顶层 hook/helper 随节下沉）：
 *   - plugin-findfiles.test.ts
 *   - plugin-openurl-scheme.test.ts
 * 运行：cd packages/runtime && TAIJI_SKIP_REAL_PI=1 npx vitest run test/plugin-rpc-setup.test.ts
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PluginRpcServer } from '../src/services/plugin-service/plugin-rpc-server.js'
import type { WorkerPort } from '../src/services/plugin-service/plugin-rpc-server.js'
import { MAX_FIND_FILES_RESULTS, findFiles, isAllowedOpenUrl, registerOpenUrlRpcHandler } from '../src/services/plugin-service/plugin-rpc-setup.js'


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
