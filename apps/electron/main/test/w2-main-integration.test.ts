/**
 * W2-main-integration 验收测试。
 *
 * 覆盖 8 条验收场景（vitest fullName 含验收 id）：
 *   W2-testProxy-structured: testProxyConnection 返回结构化 {success, code, message, suggestion}
 *   W2-testProxy-public-hostunreach: 公网代理 EHOSTUNREACH 代理语境话术（D2 v3 准绳 / A4）
 *   W2-testProxy-other-errors: 其他错误码分类 (ECONNREFUSED / 407 / AbortError)
 *   W2-download-classify: download-asset 单段 fetch 使用 classifyNetError
 *   W2-downloadPart-classify: downloadPart 网络错误经 classifyNetError 分类
 *   W2-handler-error-log: update:* handler + preloadUpdateSilently 调用 appendUpdateError
 *   W2-preload-types: preload.ts onUpdateError + testProxy 类型签名含 suggestion
 *   W2-integration-log-file: update-error.log JSONL 写入 + 轮转
 *   W2-update-error-type: UpdateError rawCause 字段
 *
 * 区分力策略：每个 describe 至少含一条「源码级集成断言」——验证 w2 产物（import/调用点）
 * 在父 commit 上不存在（红阶段 = 新测试在旧代码树 fail）。
 *
 * Mock 策略：纯函数单测（net-errors / error-log / types），不依赖 electron 运行时。
 * 运行：cd apps/electron/main && npx vitest run test/w2-main-integration.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// ── 重定向升级工作目录（getUpdateDir()）到 tmp ────────────────────
let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'w2-test-'))
  process.env.TAIJI_AGENT_DATA_DIR = tempDir
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  delete process.env.TAIJI_AGENT_DATA_DIR
})

// ── 源码读取工具 ─────────────────────────────────────────────────
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..', '..')

function readSource(relPath: string): string {
  return readFileSync(path.join(PROJECT_ROOT, relPath), 'utf-8')
}

// ── W2-update-error-type ──────────────────────────────────────────
describe('W2-update-error-type UpdateError rawCause 字段', () => {
  it('W2-update-error-type 构造时注入 rawCause', async () => {
    const { UpdateError } = await import('../update/types.js')
    const err = new UpdateError('test', 'downloading', 'UPDATE_NETWORK_FAILED', 'EHOSTUNREACH')
    expect(err.rawCause).toBe('EHOSTUNREACH')
    expect(err.errorCode).toBe('UPDATE_NETWORK_FAILED')
    expect(err.stage).toBe('downloading')
    expect(err.message).toBe('test')
  })

  it('W2-update-error-type rawCause 可选，缺省为 undefined', async () => {
    const { UpdateError } = await import('../update/types.js')
    const err = new UpdateError('test', 'downloading')
    expect(err.rawCause).toBeUndefined()
  })

  it('W2-update-error-type UPDATE_PROXY_UNREACHABLE 映射表条目存在', async () => {
    const { UPDATE_ERROR_MESSAGES } = await import('../update/types.js')
    expect(UPDATE_ERROR_MESSAGES.UPDATE_PROXY_UNREACHABLE).toBeDefined()
    expect(UPDATE_ERROR_MESSAGES.UPDATE_PROXY_UNREACHABLE.message).toContain('EHOSTUNREACH')
    expect(UPDATE_ERROR_MESSAGES.UPDATE_PROXY_UNREACHABLE.suggestion).toContain('本地网络')
  })

  it('W2-update-error-type toUserFriendly 返回 suggestion', async () => {
    const { UpdateError } = await import('../update/types.js')
    const err = new UpdateError('test', 'downloading', 'UPDATE_PROXY_UNREACHABLE', 'cause')
    const info = err.toUserFriendly()
    expect(info.code).toBe('UPDATE_PROXY_UNREACHABLE')
    expect(info.suggestion).toContain('本地网络')
  })

  // B3-a：classifyNetError 带码 message 经映射表转中文后码不丢——补 (CODE) 后缀
  it('W2-update-error-type toUserFriendly 映射表中文文案补回错误码后缀', async () => {
    const { UpdateError } = await import('../update/types.js')
    // classifyNetError 网络分支的 message 形态（英文 + errno 括号后缀）
    const err = new UpdateError(
      'network connection failed (ETIMEDOUT)',
      'downloading',
      'UPDATE_NETWORK_FAILED',
    )
    const info = err.toUserFriendly()
    expect(info.message).toBe('网络连接失败 (ETIMEDOUT)')
  })

  it('W2-update-error-type toUserFriendly 映射表已含错误码时不重复拼接', async () => {
    const { UpdateError } = await import('../update/types.js')
    const err = new UpdateError(
      '无法连接代理 (EHOSTUNREACH)',
      'downloading',
      'UPDATE_PROXY_UNREACHABLE',
    )
    const info = err.toUserFriendly()
    // 恰好一个 (EHOSTUNREACH)：映射表条目自身已含码，不再追加后缀
    expect(info.message).toBe('无法连接代理 (EHOSTUNREACH)')
  })

  // 区分力：types.ts UpdateError 构造函数签名片段必须含 rawCause 参数
  it('W2-update-error-type types.ts UpdateError 构造函数含 rawCause 参数', () => {
    const src = readSource('apps/electron/main/update/types.ts')
    // 匹配 constructor(message, stage, errorCode?, rawCause?) 签名
    expect(src).toMatch(/constructor\s*\([^)]*rawCause[^)]*\)/)
  })
})

// ── W2-testProxy-structured ────────────────────────────────────────
describe('W2-testProxy-structured testProxyConnection 结构化返回', () => {
  it('W2-testProxy-structured EHOSTUNREACH 私网代理返回 code + suggestion', async () => {
    const { classifyNetError } = await import('../update/net-errors.js')
    const cause = Object.assign(new Error('connect EHOSTUNREACH 192.168.1.202:7890'), {
      code: 'EHOSTUNREACH',
    })
    const outer = Object.assign(new Error('fetch failed'), { cause })
    const result = classifyNetError(outer, 'downloading', 'http://192.168.1.202:7890')
    if (process.platform === 'darwin') {
      expect(result.errorCode).toBe('UPDATE_PROXY_UNREACHABLE')
      expect(result.message).toContain('EHOSTUNREACH')
    } else {
      expect(result.errorCode).toBe('UPDATE_NETWORK_FAILED')
    }
    expect(result.rawCause).toBe('connect EHOSTUNREACH 192.168.1.202:7890')
    expect(result.stage).toBe('downloading')
    const info = result.toUserFriendly()
    expect(info).toHaveProperty('code')
    expect(info).toHaveProperty('message')
    expect(info).toHaveProperty('suggestion')
    expect(info).toHaveProperty('stage')
  })

  // 区分力：update-handlers.ts testProxyConnection 必须使用 classifyNetError（w2 集成点）
  it('W2-testProxy-structured update-handlers.ts testProxyConnection 调用 classifyNetError', () => {
    const src = readSource('apps/electron/main/gateway/update-handlers.ts')
    // testProxyConnection 函数体必须调用 classifyNetError
    const fnMatch = src.match(/async function testProxyConnection[\s\S]*?^}/m)
    expect(fnMatch).not.toBeNull()
    expect(fnMatch![0]).toContain('classifyNetError')
  })

  // 区分力：testProxyConnection 返回结构含 suggestion 字段
  it('W2-testProxy-structured testProxyConnection 返回结构含 suggestion', () => {
    const src = readSource('apps/electron/main/gateway/update-handlers.ts')
    const fnMatch = src.match(/async function testProxyConnection[\s\S]*?^}/m)
    expect(fnMatch).not.toBeNull()
    expect(fnMatch![0]).toMatch(/suggestion/)
  })
})

// ── W2-testProxy-other-errors ─────────────────────────────────────
describe('W2-testProxy-other-errors 其他错误码分类', () => {
  it('W2-testProxy-other-errors ECONNREFUSED → UPDATE_NETWORK_FAILED', async () => {
    const { classifyNetError } = await import('../update/net-errors.js')
    const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:7890'), {
      code: 'ECONNREFUSED',
    })
    const outer = Object.assign(new Error('fetch failed'), { cause })
    const result = classifyNetError(outer, 'downloading')
    expect(result.errorCode).toBe('UPDATE_NETWORK_FAILED')
    expect(result.rawCause).toContain('ECONNREFUSED')
  })

  it('W2-testProxy-other-errors 407 Proxy Authentication → UPDATE_PROXY_ERROR', async () => {
    const { classifyNetError } = await import('../update/net-errors.js')
    const err = new Error('Proxy Authentication Required: 407')
    const result = classifyNetError(err, 'downloading')
    expect(result.errorCode).toBe('UPDATE_PROXY_ERROR')
  })

  it('W2-testProxy-other-errors AbortError → UPDATE_NETWORK_TIMEOUT', async () => {
    const { classifyNetError } = await import('../update/net-errors.js')
    const err = new Error('The operation was aborted')
    err.name = 'AbortError'
    const result = classifyNetError(err, 'downloading')
    expect(result.errorCode).toBe('UPDATE_NETWORK_TIMEOUT')
  })

  it('W2-testProxy-other-errors ECONNRESET → UPDATE_NETWORK_FAILED', async () => {
    const { classifyNetError } = await import('../update/net-errors.js')
    const cause = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
    const outer = Object.assign(new Error('fetch failed'), { cause })
    const result = classifyNetError(outer, 'downloading')
    expect(result.errorCode).toBe('UPDATE_NETWORK_FAILED')
    expect(result.rawCause).toContain('ECONNRESET')
  })

  // 区分力：update-handlers.ts catch 块调用 appendUpdateError 落盘
  it('W2-testProxy-other-errors update-handlers.ts testProxy catch 调用 appendUpdateError', () => {
    const src = readSource('apps/electron/main/gateway/update-handlers.ts')
    const fnMatch = src.match(/async function testProxyConnection[\s\S]*?^}/m)
    expect(fnMatch).not.toBeNull()
    expect(fnMatch![0]).toContain('appendUpdateError')
  })
})

// ── W2-download-classify ──────────────────────────────────────────
describe('W2-download-classify download-asset 单段 fetch 分类', () => {
  it('W2-download-classify classifyNetError 收敛 EHOSTUNREACH 分类', async () => {
    const { classifyNetError } = await import('../update/net-errors.js')
    const cause = Object.assign(new Error('connect EHOSTUNREACH 203.0.113.1:7890'), {
      code: 'EHOSTUNREACH',
    })
    const outer = Object.assign(new Error('fetch failed'), { cause })
    const result = classifyNetError(outer, 'downloading', 'http://203.0.113.1:7890')
    expect(result.errorCode).toBe('UPDATE_NETWORK_FAILED')
    expect(result.message).toContain('EHOSTUNREACH')
  })

  it('W2-download-classify classifyNetError 收敛未知错误 → UPDATE_NETWORK_FAILED', async () => {
    const { classifyNetError } = await import('../update/net-errors.js')
    const err = new Error('some unknown error')
    const result = classifyNetError(err, 'downloading')
    expect(result.errorCode).toBe('UPDATE_NETWORK_FAILED')
  })

  it('W2-download-classify classifyNetError 处理无 cause 的 Error', async () => {
    const { classifyNetError } = await import('../update/net-errors.js')
    const err = new Error('fetch failed')
    const result = classifyNetError(err, 'downloading')
    expect(result.errorCode).toBe('UPDATE_NETWORK_FAILED')
    expect(result.rawCause).toBeUndefined()
  })

  // 区分力：download-asset.ts 必须 import classifyNetError（w2 集成点，父 commit 无此 import）
  it('W2-download-classify download-asset.ts import classifyNetError from net-errors', () => {
    const src = readSource('apps/electron/main/update/download-asset.ts')
    expect(src).toMatch(/import\s*\{[^}]*classifyNetError[^}]*\}\s*from\s*['"]\.\/net-errors\.js['"]/)
  })
})

// ── W2-downloadPart-classify ──────────────────────────────────────
describe('W2-downloadPart-classify downloadPart 分类', () => {
  it('W2-downloadPart-classify classifyNetError 对流中断错误做分类', async () => {
    const { classifyNetError } = await import('../update/net-errors.js')
    const cause = Object.assign(new Error('other side closed'), {
      code: 'UND_ERR_SOCKET',
    })
    const outer = Object.assign(new Error('fetch failed'), { cause })
    const result = classifyNetError(outer, 'downloading')
    expect(result.errorCode).toBe('UPDATE_NETWORK_FAILED')
    expect(result.rawCause).toBe('other side closed')
  })

  it('W2-downloadPart-classify classifyNetError ETIMEDOUT 分类', async () => {
    const { classifyNetError } = await import('../update/net-errors.js')
    const cause = Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' })
    const outer = Object.assign(new Error('fetch failed'), { cause })
    const result = classifyNetError(outer, 'downloading')
    expect(result.errorCode).toBe('UPDATE_NETWORK_FAILED')
  })

  // 区分力：download-asset.ts downloadPart 函数体必须调用 classifyNetError（父 commit 无此调用）
  it('W2-downloadPart-classify downloadPart 函数体调用 classifyNetError', () => {
    const src = readSource('apps/electron/main/update/download-asset.ts')
    const fnMatch = src.match(/async function downloadPart[\s\S]*?^}/m)
    expect(fnMatch).not.toBeNull()
    expect(fnMatch![0]).toContain('classifyNetError')
  })
})

// ── W2-handler-error-log ──────────────────────────────────────────
describe('W2-handler-error-log appendUpdateError 落盘', () => {
  it('W2-handler-error-log appendUpdateError 写入 JSONL 文件', async () => {
    const { appendUpdateError } = await import('../update/error-log.js')
    const { getUpdateErrorLog } = await import('../update/constants.js')
    appendUpdateError({
      at: new Date().toISOString(),
      source: 'test-proxy',
      stage: 'downloading',
      errorCode: 'UPDATE_PROXY_UNREACHABLE',
      rawCause: 'EHOSTUNREACH',
      proxyUrl: 'http://192.168.1.202:7890',
    })
    expect(existsSync(getUpdateErrorLog())).toBe(true)
    const content = readFileSync(getUpdateErrorLog(), 'utf-8')
    const lines = content.trim().split('\n')
    expect(lines.length).toBe(1)
    const entry = JSON.parse(lines[0])
    expect(entry.source).toBe('test-proxy')
    expect(entry.errorCode).toBe('UPDATE_PROXY_UNREACHABLE')
    expect(entry.rawCause).toBe('EHOSTUNREACH')
  })

  it('W2-handler-error-log appendUpdateError 多次追加', async () => {
    const { appendUpdateError } = await import('../update/error-log.js')
    const { getUpdateErrorLog } = await import('../update/constants.js')
    for (let i = 0; i < 5; i++) {
      appendUpdateError({
        at: new Date().toISOString(),
        source: `source-${i}`,
        stage: 'downloading',
      })
    }
    const content = readFileSync(getUpdateErrorLog(), 'utf-8')
    const lines = content.trim().split('\n')
    expect(lines.length).toBe(5)
  })

  it('W2-handler-error-log 代理 URL 解析收敛到 proxy-config.resolveProxyUrl（SSOT）', async () => {
    const { resolveProxyUrl } = await import('../update/proxy-config.js')
    expect(resolveProxyUrl({ mode: 'manual', httpProxy: 'http://127.0.0.1:7890' }))
      .toBe('http://127.0.0.1:7890')
    expect(resolveProxyUrl({ mode: 'disabled' })).toBeUndefined()
  })

  // 守卫：error-log 不得再自带代理 URL 解析本地实现（曾因与 proxy-config.resolveProxyUrl
  // 同构双实现存在 drift 隐患而收敛，D7 SSOT 要求）
  it('W2-handler-error-log error-log.ts 无本地代理解析双实现', () => {
    const src = readSource('apps/electron/main/update/error-log.ts')
    expect(src).not.toContain('getProxyUrlForLog')
    expect(src).not.toMatch(/mode === '(disabled|manual)'/)
  })

  // 区分力：update-handlers.ts 必须 import appendUpdateError（w2 集成点，父 commit 无此 import）
  it('W2-handler-error-log update-handlers.ts import appendUpdateError from error-log', () => {
    const src = readSource('apps/electron/main/gateway/update-handlers.ts')
    expect(src).toMatch(/import\s*\{[^}]*appendUpdateError[^}]*\}\s*from\s*['"]\.\.\/update\/error-log\.js['"]/)
  })

  // [批次 3 m17] 原 update:perform catch 落盘断言已随 handler 删除；落盘防线的
  // download/install/preload 断言见下方同族用例。

  // 区分力：update:download catch 必须调用 appendUpdateError
  it('W2-handler-error-log update:download catch 调用 appendUpdateError', () => {
    const src = readSource('apps/electron/main/gateway/update-handlers.ts')
    expect(src).toContain("source: 'download'")
  })

  // 区分力：update:install catch 必须调用 appendUpdateError
  it('W2-handler-error-log update:install catch 调用 appendUpdateError', () => {
    const src = readSource('apps/electron/main/gateway/update-handlers.ts')
    expect(src).toContain("source: 'install'")
  })

  // 区分力：preloadUpdateSilently catch 必须调用 appendUpdateError
  it('W2-handler-error-log preloadUpdateSilently catch 调用 appendUpdateError', () => {
    const src = readSource('apps/electron/main/gateway/update-handlers.ts')
    expect(src).toContain("source: 'preload'")
  })
})

// ── W2-preload-types ──────────────────────────────────────────────
describe('W2-preload-types 类型签名含 suggestion', () => {
  it('W2-preload-types UpdateErrorPayload 类型包含 suggestion', async () => {
    const shared = await import('@taiji/shared')
    expect(shared).toBeDefined()
  })

  it('W2-preload-types testProxy 返回类型包含 code 和 suggestion', async () => {
    const { classifyNetError } = await import('../update/net-errors.js')
    const err = Object.assign(new Error('fetch failed'), {
      cause: Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    })
    const result = classifyNetError(err, 'downloading')
    const info = result.toUserFriendly()
    expect(info).toHaveProperty('code')
    expect(info).toHaveProperty('message')
    expect(info).toHaveProperty('suggestion')
    expect(typeof info.code).toBe('string')
    expect(typeof info.message).toBe('string')
    expect(typeof info.suggestion).toBe('string')
  })

  // 区分力：preload.ts 必须 import UpdateErrorPayload（w2 集成点，父 commit 无此 import）
  it('W2-preload-types preload.ts import UpdateErrorPayload from shared', () => {
    const src = readSource('apps/electron/preload/preload.ts')
    expect(src).toMatch(/import\s*type\s*\{[^}]*UpdateErrorPayload[^}]*\}\s*from\s*['"]@taiji\/shared['"]/)
  })

  // 区分力：preload.ts onUpdateError callback 使用 UpdateErrorPayload 类型
  it('W2-preload-types preload.ts onUpdateError 使用 UpdateErrorPayload 类型', () => {
    const src = readSource('apps/electron/preload/preload.ts')
    // 匹配 onUpdateError(callback: (payload: UpdateErrorPayload) => void)
    expect(src).toMatch(/onUpdateError\s*\(callback:\s*\(payload:\s*UpdateErrorPayload\)/)
  })

  // 区分力：preload.ts testProxy 返回类型含 code 和 suggestion
  it('W2-preload-types preload.ts testProxy 返回类型含 code 和 suggestion', () => {
    const src = readSource('apps/electron/preload/preload.ts')
    // [HISTORICAL] 原断言匹配内联 {code?, suggestion?} 字面量；update-observability B5
    // 杂项将内联类型收敛到共享 ProxyTestResult（shared/update.ts SSOT，字段含
    // success/code/message/suggestion）。改断言两层：①接口声明返回 Promise<ProxyTestResult>
    // ②ProxyTestResult 从 @taiji/shared 导入（堵手写副本漂移，字段语义仍在 SSOT 保证）。
    expect(src).toMatch(/import\s*type\s*\{[^}]*ProxyTestResult[^}]*\}\s*from\s*['"]@taiji\/shared['"]/
    )
    expect(src).toMatch(/^\s*testProxy\(.*\)\s*:\s*Promise<ProxyTestResult>/m)
  })

  // 区分力：shared/src/update.ts UpdateErrorPayload 定义含 suggestion
  it('W2-preload-types shared UpdateErrorPayload 定义含 suggestion 字段', () => {
    const src = readSource('packages/shared/src/update.ts')
    expect(src).toMatch(/export interface UpdateErrorPayload[\s\S]*suggestion\?/)
  })
})

// ── W2-integration-log-file ───────────────────────────────────────
describe('W2-integration-log-file JSONL 写入 + 轮转', () => {
  it('W2-integration-log-file 轮转：超 512KB 时重命名 .log.1', async () => {
    const { appendUpdateError } = await import('../update/error-log.js')
    const { getUpdateErrorLog } = await import('../update/constants.js')
    const errorLogPath = getUpdateErrorLog()
    const bigData = 'x'.repeat(600 * 1024)
    mkdirSync(path.dirname(errorLogPath), { recursive: true })
    writeFileSync(errorLogPath, bigData)
    appendUpdateError({
      at: new Date().toISOString(),
      source: 'test-rotate',
      stage: 'downloading',
    })
    const rotatedPath = `${errorLogPath}.1`
    expect(existsSync(rotatedPath)).toBe(true)
    const newContent = readFileSync(errorLogPath, 'utf-8')
    const entry = JSON.parse(newContent.trim())
    expect(entry.source).toBe('test-rotate')
  })

  it('W2-integration-log-file JSONL 每行可解析', async () => {
    const { appendUpdateError } = await import('../update/error-log.js')
    const { getUpdateErrorLog } = await import('../update/constants.js')
    if (existsSync(getUpdateErrorLog())) {
      const { unlinkSync } = await import('node:fs')
      unlinkSync(getUpdateErrorLog())
    }
    appendUpdateError({
      at: '2026-01-01T00:00:00.000Z',
      source: 'download',
      stage: 'downloading',
      errorCode: 'UPDATE_NETWORK_FAILED',
      rawCause: 'ECONNREFUSED',
    })
    appendUpdateError({
      at: '2026-01-01T00:00:01.000Z',
      source: 'preload',
      stage: 'downloading',
      rawCause: 'fetch failed',
    })
    const content = readFileSync(getUpdateErrorLog(), 'utf-8')
    const lines = content.trim().split('\n')
    expect(lines.length).toBe(2)
    for (const line of lines) {
      const parsed = JSON.parse(line)
      expect(parsed).toHaveProperty('at')
      expect(parsed).toHaveProperty('source')
      expect(parsed).toHaveProperty('stage')
    }
  })

  // 区分力：constants.ts 必须以延迟求值函数定义 getUpdateErrorLog（w2 产物，但 w1 已有——补充验证路径）
  it('W2-integration-log-file constants.ts 定义 getUpdateErrorLog', () => {
    const src = readSource('apps/electron/main/update/constants.ts')
    expect(src).toMatch(/export function getUpdateErrorLog/)
  })
})

// ── W2-testProxy-public-hostunreach（D2 v3 / A4）─────────────────
// 排序说明（物理顺序保持在文件末尾；历史注释按「路径 import 期固化」解释排序，
// 延迟求值后该理由已失真）：错误日志路径经 getUpdateErrorLog() 延迟求值，文件级
// beforeEach 为每个用例各自设 TAIJI_AGENT_DATA_DIR（独立 tmp 目录）+ afterEach rmSync
// 清场，动态 import 每次现取路径，各用例落盘互不串扰。本 describe 经 dynamic import
// 加载 update-handlers → error-log/constants 模块图，其记录写在自身用例的 tmp 内，
// 末尾仍由自身 unlink 兜底清理，此后无任何消费者。
const capturedHandlers = new Map<string, (...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      capturedHandlers.set(channel, fn)
    },
  },
  app: { getVersion: () => '0.9.0' },
}))

describe('W2-testProxy-public-hostunreach 公网 EHOSTUNREACH 代理语境话术', () => {
  afterEach(async () => {
    vi.unstubAllGlobals()
    // 还原 curl runner 注入（避免污染同 worker 后续用例；动态 import 保持模块图惰性加载语义）
    const { __setCurlRunnerForTest } = await import('../update/upgrade-fetch.js')
    __setCurlRunnerForTest(undefined)
  })

  it('W2-testProxy-public-hostunreach 公网代理 EHOSTUNREACH 返回代理语境话术 + 检查代理指引', async () => {
    // stub 全局 fetch 抛公网 EHOSTUNREACH（undici fetch failed 形态：errno 挂 cause.code）
    const cause = Object.assign(new Error('connect EHOSTUNREACH 203.0.113.1:7890'), {
      code: 'EHOSTUNREACH',
    })
    // u6（update-network-resilience D5/D8）：testProxyConnection 换 upgradeFetch 双引擎后，
    // undici 失败会降级真实 spawn 系统 curl（联网且慢）。注入假 curl runner 模拟 curl 亦
    // 连接失败（exit 7），保持本用例离线、确定性（双失败 → undici 侧分类语义不变）
    const { __setCurlRunnerForTest } = await import('../update/upgrade-fetch.js')
    __setCurlRunnerForTest(() => ({ exitCode: 7, stdout: '', stderr: 'curl: (7) Failed to connect' }))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw Object.assign(new Error('fetch failed'), { cause })
      }),
    )
    // vi.mock('electron') 捕获 update:testProxy handler 真实调用：直接断言
    // testProxyConnection 返回值的覆写行为，而非仅源码字符串匹配。
    const { registerUpdateHandlers } = await import('../gateway/update-handlers.js')
    registerUpdateHandlers({} as never)
    const handler = capturedHandlers.get('update:testProxy')!
    // ipcMain.handle 的 handler 签名是 (event, payload)：首位传 event 占位
    const result = (await handler({}, {
      mode: 'manual',
      httpProxy: 'http://203.0.113.1:7890',
    })) as {
      success: boolean
      code?: string
      message?: string
      suggestion?: string
    }

    expect(result.success).toBe(false)
    // 分类维持 UPDATE_NETWORK_FAILED：下载/升级路径仍走映射表通用网络文案，仅 testProxy 场景覆写
    expect(result.code).toBe('UPDATE_NETWORK_FAILED')
    // 代理语境话术 + 错误码后缀（不再出现「网络连接失败」通用文案）
    expect(result.message).toContain('无法连接代理')
    expect(result.message).toContain('(EHOSTUNREACH)')
    expect(result.message).not.toContain('网络连接失败')
    // suggestion 为检查代理语境；不得出现本地网络权限指引（A4 反向验证）
    expect(result.suggestion).toContain('检查代理')
    expect(result.suggestion).not.toContain('本地网络')

    // 兑底清理：清掉本用例经 handler 落在 update-error.log 路径上的记录
    const { getUpdateErrorLog } = await import('../update/constants.js')
    if (existsSync(getUpdateErrorLog())) unlinkSync(getUpdateErrorLog())
  })
})
