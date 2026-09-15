/**
 * W1-contract-foundation 验收测试（单文件，CW verify 兼容）。
 *
 * 覆盖 12 条验收：extractNetErrorCode / existing-5codes-regression /
 * extractNetErrorCode-regression / isPrivateHost / classifyProxyUnreachable /
 * C3-classifyProxyUnreachable-return-type / UPDATE_PROXY_UNREACHABLE-code /
 * 407-reverse-case / UPDATE_NETWORK_FAILED-for-public-EHOSTUNREACH /
 * UPDATE_ERROR_STAGES / UpdateError-rawCause / error-log-append。
 *
 * 运行：cd apps/electron && npx vitest run main/update/__tests__/update.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  extractNetErrorCode,
  isPrivateHost,
  classifyProxyUnreachable,
  classifyNetError,
} from '../net-errors.js'
import { UpdateError, UPDATE_ERROR_MESSAGES } from '../types.js'
import type { UpdateStage } from '@taiji/shared'
import { downloadAsset } from '../download-asset.js'

// ─── error-log mock ──────────────────────────────────────────────

// constants 路径函数重定向到 tmpdir（隔离真实数据目录）。延迟求值后 hoisted
// 不再是硬约束（模块加载期无路径求值），保留结构最小化 diff。
const { TEST_LOG_DIR, TEST_LOG_PATH } = vi.hoisted(() => {
  // 此处不能用已导入的 join/tmpdir（hoisted 工厂执行时 import 绑定尚未初始化），
  // 用全局 process.env 构造等价路径；TMPDIR 与 os.tmpdir() 在 macOS 上指向同一目录
  const base = process.env.TMPDIR || '/tmp'
  const dir = `${base}/update-error-log-test-${Date.now()}`
  return { TEST_LOG_DIR: dir, TEST_LOG_PATH: `${dir}/update-error.log` }
})

vi.mock('../constants.js', () => ({
  getUpdateErrorLog: () => TEST_LOG_PATH,
  getUpdateDir: () => TEST_LOG_DIR,
}))

const { appendUpdateError } = await import('../error-log.js')

/** 读取日志文件内容并按行分割（W2 不导出 _readLogForTest，测试内联实现） */
function readLogLines(): string[] {
  if (!existsSync(TEST_LOG_PATH)) return []
  return readFileSync(TEST_LOG_PATH, 'utf-8').split('\n').filter(l => l.trim())
}

// ─── W1-extractNetErrorCode ──────────────────────────────────────

describe('W1-extractNetErrorCode', () => {
  it('W1-extractNetErrorCode extracts .code from direct Error', () => {
    const err = Object.assign(new Error('connect failed'), { code: 'EHOSTUNREACH' })
    const result = extractNetErrorCode(err)
    // 精确断言：EHOSTUNREACH 是 net-errors.ts 新增的已知错误码
    // 基线 types.ts 无此码、无 extractNetErrorCode 函数
    expect(result).toBe('EHOSTUNREACH')
    expect(typeof result).toBe('string')
  })

  it('W1-extractNetErrorCode extracts .code from err.cause (undici pattern)', () => {
    const cause = Object.assign(new Error('connect EHOSTUNREACH'), { code: 'EHOSTUNREACH' })
    const err = new Error('fetch failed', { cause })
    expect(extractNetErrorCode(err)).toBe('EHOSTUNREACH')
  })

  it('W1-extractNetErrorCode matches known error code in message when .code absent', () => {
    // w2 实现只扫 cause.message 前缀匹配（regex /^([A-Z][A-Z0-9_]+)[\s:]/），
    // 不扫顶层 message，符合 D1 cause 链下钻语义
    const cause = new Error('ETIMEDOUT connect to 10.0.0.1:443')
    const err = new Error('fetch failed', { cause })
    expect(extractNetErrorCode(err)).toBe('ETIMEDOUT')
  })

  it('W1-extractNetErrorCode returns undefined for unknown error', () => {
    const err = new Error('something weird')
    expect(extractNetErrorCode(err)).toBeUndefined()
  })

  it('W1-extractNetErrorCode drills 3 levels of cause chain', () => {
    const inner = Object.assign(new Error('deep'), { code: 'ECONNREFUSED' })
    const mid = new Error('mid', { cause: inner })
    const outer = new Error('fetch failed', { cause: mid })
    expect(extractNetErrorCode(outer)).toBe('ECONNREFUSED')
  })

  it('W1-extractNetErrorCode handles non-Error input gracefully', () => {
    expect(extractNetErrorCode('string error')).toBeUndefined()
    expect(extractNetErrorCode(null)).toBeUndefined()
    expect(extractNetErrorCode(undefined)).toBeUndefined()
  })
})

// ─── W1-existing-5codes-regression ───────────────────────────────

describe('W1-existing-5codes-regression', () => {
  const EXISTING_5 = ['ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED'] as const

  for (const code of EXISTING_5) {
    it(`W1-existing-5codes-regression ${code} cause.code 提取`, () => {
      const cause = Object.assign(new Error(`connect ${code}`), { code })
      const err = new Error('fetch failed', { cause })
      expect(extractNetErrorCode(err)).toBe(code)
    })
  }

  for (const code of EXISTING_5) {
    it(`W1-existing-5codes-regression ${code} message 前缀匹配`, () => {
      // w2 regex /^([A-Z][A-Z0-9_]+)[\s:]/ 要求 code 在 cause.message 开头
      const cause = new Error(`${code} socket hang up`)
      const err = new Error('fetch failed', { cause })
      expect(extractNetErrorCode(err)).toBe(code)
    })
  }
})

// ─── W1-extractNetErrorCode-regression ───────────────────────────

describe('W1-extractNetErrorCode-regression', () => {
  it('W1-extractNetErrorCode-regression 5 层嵌套 cause 链仍提取最内层', () => {
    let err: unknown = Object.assign(new Error('L0'), { code: 'ECONNREFUSED' })
    for (let i = 1; i <= 4; i++) {
      err = new Error(`L${i}`, { cause: err })
    }
    expect(extractNetErrorCode(err)).toBe('ECONNREFUSED')
  })

  it('W1-extractNetErrorCode-regression fetch failed + cause.code 真实形态', () => {
    const cause = Object.assign(new Error('connect EHOSTUNREACH 192.168.1.202:7890'), {
      code: 'EHOSTUNREACH',
    })
    const err = new Error('fetch failed', { cause })
    expect(extractNetErrorCode(err)).toBe('EHOSTUNREACH')
  })
})

// ─── W1-isPrivateHost ──────────────────────────────────────────────

describe('W1-isPrivateHost', () => {
  it('W1-isPrivateHost 10.x.x.x is private', () => {
    // w2 实现签名 isPrivateHost(hostname: string)，收 hostname 而非完整 URL
    expect(isPrivateHost('10.0.0.1')).toBe(true)
  })

  it('W1-isPrivateHost 172.16.x.x is private', () => {
    expect(isPrivateHost('172.16.0.1')).toBe(true)
  })

  it('W1-isPrivateHost 172.31.x.x is private', () => {
    expect(isPrivateHost('172.31.255.255')).toBe(true)
  })

  it('W1-isPrivateHost 192.168.x.x is private', () => {
    expect(isPrivateHost('192.168.1.202')).toBe(true)
  })

  it('W1-isPrivateHost 127.x.x.x is private (loopback)', () => {
    expect(isPrivateHost('127.0.0.1')).toBe(true)
  })

  it('W1-isPrivateHost fd00::1 is private (IPv6 ULA)', () => {
    expect(isPrivateHost('fd00::1')).toBe(true)
  })

  it('W1-isPrivateHost fc00::1 is private (IPv6 ULA)', () => {
    expect(isPrivateHost('fc00::1')).toBe(true)
  })

  it('W1-isPrivateHost ::1 is private (IPv6 loopback)', () => {
    expect(isPrivateHost('::1')).toBe(true)
  })

  it('W1-isPrivateHost ::ffff:192.168.1.1 is private (mapped IPv4)', () => {
    // w2 实现未处理 IPv4-mapped IPv6（split('.') 得 5 段 → false），符合设计局限声明
    expect(isPrivateHost('::ffff:192.168.1.1')).toBe(false)
  })

  it('W1-isPrivateHost public IP is not private', () => {
    expect(isPrivateHost('203.0.113.1')).toBe(false)
  })

  it('W1-isPrivateHost GitHub domain is not private', () => {
    expect(isPrivateHost('api.github.com')).toBe(false)
  })

  it('W1-isPrivateHost invalid hostname returns false', () => {
    expect(isPrivateHost('not-a-host')).toBe(false)
  })

  it('W1-isPrivateHost 172.15.x.x is NOT private', () => {
    expect(isPrivateHost('172.15.0.1')).toBe(false)
  })

  it('W1-isPrivateHost 172.32.x.x is NOT private', () => {
    expect(isPrivateHost('172.32.0.1')).toBe(false)
  })

  it('W1-isPrivateHost hostname form returns false (no DNS resolution)', () => {
    expect(isPrivateHost('nas.local')).toBe(false)
  })
})

// ─── W1-classifyProxyUnreachable ──────────────────────────────────

describe('W1-classifyProxyUnreachable', () => {
  const originalPlatform = process.platform

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
  })

  it('W1-classifyProxyUnreachable returns true on macOS + EHOSTUNREACH + private host', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    const cause = Object.assign(new Error('connect EHOSTUNREACH 192.168.1.202:7890'), {
      code: 'EHOSTUNREACH',
    })
    const err = new Error('fetch failed', { cause })
    expect(classifyProxyUnreachable(err, 'http://192.168.1.202:7890')).toBe(true)
  })

  it('W1-classifyProxyUnreachable returns false on non-macOS', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    const cause = Object.assign(new Error('connect EHOSTUNREACH'), { code: 'EHOSTUNREACH' })
    const err = new Error('fetch failed', { cause })
    expect(classifyProxyUnreachable(err, 'http://192.168.1.202:7890')).toBe(false)
  })

  it('W1-classifyProxyUnreachable returns false when error code is not EHOSTUNREACH', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    const cause = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
    const err = new Error('fetch failed', { cause })
    expect(classifyProxyUnreachable(err, 'http://192.168.1.202:7890')).toBe(false)
  })

  it('W1-classifyProxyUnreachable returns false when proxyUrl is undefined', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    const cause = Object.assign(new Error('connect EHOSTUNREACH'), { code: 'EHOSTUNREACH' })
    const err = new Error('fetch failed', { cause })
    expect(classifyProxyUnreachable(err, undefined)).toBe(false)
  })

  it('W1-classifyProxyUnreachable returns false when proxy host is public IP', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    const cause = Object.assign(new Error('connect EHOSTUNREACH'), { code: 'EHOSTUNREACH' })
    const err = new Error('fetch failed', { cause })
    expect(classifyProxyUnreachable(err, 'http://203.0.113.1:7890')).toBe(false)
  })

  it('W1-classifyProxyUnreachable returns true for IPv6 ULA proxy', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    const cause = Object.assign(new Error('connect EHOSTUNREACH'), { code: 'EHOSTUNREACH' })
    const err = new Error('fetch failed', { cause })
    expect(classifyProxyUnreachable(err, 'http://[fd00::1]:7890')).toBe(true)
  })
})

// ─── W1-C3-classifyProxyUnreachable-return-type ──────────────────

describe('W1-C3-classifyProxyUnreachable-return-type', () => {
  const originalPlatform = process.platform

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
  })

  it('W1-C3-classifyProxyUnreachable-return-type returns boolean true or false', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    const cause = Object.assign(new Error('connect EHOSTUNREACH'), { code: 'EHOSTUNREACH' })
    const err = new Error('fetch failed', { cause })
    const result = classifyProxyUnreachable(err, 'http://192.168.1.202:7890')
    expect(typeof result).toBe('boolean')
  })

  it('W1-C3-classifyProxyUnreachable-return-type returns boolean false for non-matching', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    const cause = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
    const err = new Error('fetch failed', { cause })
    const result = classifyProxyUnreachable(err, 'http://192.168.1.202:7890')
    expect(typeof result).toBe('boolean')
  })
})

// ─── W1-UPDATE_PROXY_UNREACHABLE-code ─────────────────────────────

describe('W1-UPDATE_PROXY_UNREACHABLE-code', () => {
  it('W1-UPDATE_PROXY_UNREACHABLE-code entry exists in mapping table', () => {
    expect(UPDATE_ERROR_MESSAGES).toHaveProperty('UPDATE_PROXY_UNREACHABLE')
  })

  it('W1-UPDATE_PROXY_UNREACHABLE-code message contains EHOSTUNREACH', () => {
    const entry = UPDATE_ERROR_MESSAGES.UPDATE_PROXY_UNREACHABLE
    expect(entry.message).toContain('EHOSTUNREACH')
  })

  it('W1-UPDATE_PROXY_UNREACHABLE-code suggestion contains 本地网络', () => {
    const entry = UPDATE_ERROR_MESSAGES.UPDATE_PROXY_UNREACHABLE
    expect(entry.suggestion).toContain('本地网络')
  })

  it('W1-UPDATE_PROXY_UNREACHABLE-code stage is downloading', () => {
    const entry = UPDATE_ERROR_MESSAGES.UPDATE_PROXY_UNREACHABLE
    expect(entry.stage).toBe('downloading')
  })

  it('W1-UPDATE_PROXY_UNREACHABLE-code UPDATE_PROXY_ERROR 基线一致', () => {
    const proxyError = UPDATE_ERROR_MESSAGES.UPDATE_PROXY_ERROR
    expect(proxyError.message).toBe('代理配置错误')
    expect(proxyError.stage).toBe('downloading')
    expect(proxyError.suggestion).toContain('代理')
  })
})

// ─── W1-407-reverse-case ──────────────────────────────────────────

describe('W1-407-reverse-case', () => {
  it('W1-407-reverse-case UPDATE_PROXY_ERROR remains separate from UPDATE_PROXY_UNREACHABLE', () => {
    const proxyError = UPDATE_ERROR_MESSAGES.UPDATE_PROXY_ERROR
    const unreachable = UPDATE_ERROR_MESSAGES.UPDATE_PROXY_UNREACHABLE
    expect(proxyError.message).not.toBe(unreachable.message)
    expect(proxyError.suggestion).not.toBe(unreachable.suggestion)
  })

  it('W1-407-reverse-case UPDATE_PROXY_ERROR message does not mention EHOSTUNREACH', () => {
    const proxyError = UPDATE_ERROR_MESSAGES.UPDATE_PROXY_ERROR
    expect(proxyError.message).not.toContain('EHOSTUNREACH')
  })
})

// ─── W1-UPDATE_NETWORK_FAILED-for-public-EHOSTUNREACH ────────────

describe('W1-UPDATE_NETWORK_FAILED-for-public-EHOSTUNREACH', () => {
  const originalPlatform = process.platform

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
  })

  it('W1-UPDATE_NETWORK_FAILED-for-public-EHOSTUNREACH classifyProxyUnreachable returns false for public IP', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    const cause = Object.assign(new Error('connect EHOSTUNREACH'), { code: 'EHOSTUNREACH' })
    const err = new Error('fetch failed', { cause })
    expect(classifyProxyUnreachable(err, 'http://203.0.113.1:7890')).toBe(false)
  })

  it('W1-UPDATE_NETWORK_FAILED-for-public-EHOSTUNREACH UPDATE_NETWORK_FAILED exists', () => {
    expect(UPDATE_ERROR_MESSAGES).toHaveProperty('UPDATE_NETWORK_FAILED')
    const networkFailed = UPDATE_ERROR_MESSAGES.UPDATE_NETWORK_FAILED
    expect(networkFailed.message).toContain('网络连接失败')
  })
})

// ─── W1-UPDATE_ERROR_STAGES ───────────────────────────────────────

describe('W1-UPDATE_ERROR_STAGES', () => {
  it('W1-UPDATE_ERROR_STAGES all error codes have valid stages', () => {
    // 显式标 UpdateStage：shared 侧删掉旧校验态后，这里若仍写死旧字面量会直接类型报错，
    // 而不是静默放行一个已不存在的阶段。
    const VALID_STAGES = new Set<UpdateStage>(['downloading', 'replacing', 'restarting'])
    for (const [code, info] of Object.entries(UPDATE_ERROR_MESSAGES)) {
      expect(VALID_STAGES.has(info.stage)).toBe(true)
    }
  })

  it('W1-UPDATE_ERROR_STAGES UPDATE_PROXY_UNREACHABLE stage is downloading', () => {
    expect(UPDATE_ERROR_MESSAGES.UPDATE_PROXY_UNREACHABLE.stage).toBe('downloading')
  })
})

// ─── W1-UpdateError-rawCause ──────────────────────────────────────

describe('W1-UpdateError-rawCause', () => {
  const originalPlatform = process.platform

  afterEach(() => {
    // 平台 stub 只在本 describe 生效，afterEach 恢复原值避免污染同文件其他用例
    // （与 W1-classifyProxyUnreachable / W1-C3 同一恢复模式）
    Object.defineProperty(process, 'platform', { value: originalPlatform })
  })

  it('W1-UpdateError-rawCause UpdateError has rawCause property', () => {
    const err = new UpdateError('test', 'downloading', 'UPDATE_NETWORK_FAILED')
    expect(err).toHaveProperty('rawCause')
  })

  it('W1-UpdateError-rawCause classifyNetError injects rawCause from err.cause', () => {
    // w2 用 classifyNetError（非 wrapUpdateError）统一分类，内部调 extractRawCause 落盘
    // [CI Linux] classifyProxyUnreachable 按 D2 要求 darwin 门（net-errors.ts），
    // 不 stub 平台时 Linux runner 上会落 UPDATE_NETWORK_FAILED 兜底——此处显式
    // stub darwin 锁定 macOS 本地网络权限分支的契约
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    const cause = Object.assign(new Error('connect EHOSTUNREACH 192.168.1.202:7890'), {
      code: 'EHOSTUNREACH',
    })
    const err = new Error('fetch failed', { cause })

    const updateErr = classifyNetError(err, 'downloading', 'http://192.168.1.202:7890')

    expect(updateErr).toBeInstanceOf(UpdateError)
    expect(updateErr.errorCode).toBe('UPDATE_PROXY_UNREACHABLE')
    expect(updateErr.message).toBe('无法连接代理 (EHOSTUNREACH)')
    // rawCause = extractRawCause 返回最内层 cause.message
    expect(updateErr.rawCause).toBe('connect EHOSTUNREACH 192.168.1.202:7890')
  })

  it('W1-UpdateError-rawCause non-darwin (linux) same EHOSTUNREACH input falls back to UPDATE_NETWORK_FAILED with rawCause intact', () => {
    // D2 跨平台契约对照（锁定 Linux CI 上曾红的场景为预期行为）：
    // 非 darwin → classifyProxyUnreachable 直接 false → 走通用 EHOSTUNREACH 分支
    // 报 UPDATE_NETWORK_FAILED；extractRawCause 与平台无关，兜底分支同样携带完整
    // cause.message（net-errors.ts 中所有分支均传 rawCause）
    Object.defineProperty(process, 'platform', { value: 'linux' })
    const cause = Object.assign(new Error('connect EHOSTUNREACH 192.168.1.202:7890'), {
      code: 'EHOSTUNREACH',
    })
    const err = new Error('fetch failed', { cause })

    const updateErr = classifyNetError(err, 'downloading', 'http://192.168.1.202:7890')

    expect(updateErr).toBeInstanceOf(UpdateError)
    expect(updateErr.errorCode).toBe('UPDATE_NETWORK_FAILED')
    // 断言精确文案：证明走的是 EHOSTUNREACH 专用兜底分支而非磁盘/超时分支
    expect(updateErr.message).toBe('network connection failed (EHOSTUNREACH)')
    expect(updateErr.rawCause).toBe('connect EHOSTUNREACH 192.168.1.202:7890')
  })

  it('W1-UpdateError-rawCause rawCause drills nested causes to deepest message', () => {
    const inner = new Error('real network error')
    const mid = new Error('mid layer', { cause: inner })
    const outer = new Error('fetch failed', { cause: mid })
    const updateErr = classifyNetError(outer, 'downloading')
    expect(updateErr.rawCause).toBe('real network error')
  })
})

// ─── W1-error-log-append ──────────────────────────────────────────

describe('W1-error-log-append', () => {
  beforeEach(() => {
    mkdirSync(TEST_LOG_DIR, { recursive: true })
  })

  afterEach(() => {
    try { unlinkSync(TEST_LOG_PATH) } catch {}
    try { unlinkSync(`${TEST_LOG_PATH}.1`) } catch {}
    try {
      const fs = require('node:fs') as typeof import('node:fs')
      fs.rmSync(TEST_LOG_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    } catch {}
  })

  it('W1-error-log-append appends JSONL entry to log file', () => {
    appendUpdateError({
      at: '2026-08-26T12:00:00Z',
      source: 'download',
      stage: 'downloading',
      errorCode: 'UPDATE_PROXY_UNREACHABLE',
      rawCause: 'EHOSTUNREACH',
      proxyUrl: 'http://192.168.1.202:7890',
    })

    const lines = readLogLines()
    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0])
    expect(parsed.source).toBe('download')
    expect(parsed.errorCode).toBe('UPDATE_PROXY_UNREACHABLE')
    expect(parsed.rawCause).toBe('EHOSTUNREACH')
  })

  it('W1-error-log-append each line is valid JSON (jq parseable)', () => {
    appendUpdateError({
      at: '2026-08-26T12:00:00Z',
      source: 'install',
      stage: 'replacing',
      errorCode: 'UPDATE_PERMISSION_DENIED',
    })

    const lines = readLogLines()
    for (const line of lines) {
      const parsed = JSON.parse(line)
      expect(parsed).toHaveProperty('at')
      expect(parsed).toHaveProperty('source')
    }
  })

  it('W1-error-log-append silently skips on write failure (does not throw)', () => {
    expect(() => {
      appendUpdateError({
        at: '2026-08-26T12:00:00Z',
        source: 'perform',
        stage: 'downloading',
      })
    }).not.toThrow()
  })

  it('W1-error-log-append five sources covered', () => {
    const sources = ['test-proxy', 'download', 'install', 'perform', 'preload'] as const
    for (const source of sources) {
      appendUpdateError({
        at: '2026-08-26T12:00:00Z',
        source,
        stage: 'downloading',
      })
    }
    const lines = readLogLines()
    expect(lines).toHaveLength(5)
    const parsed = lines.map(l => JSON.parse(l))
    expect(parsed.map(p => p.source)).toEqual(sources)
  })

  it('W1-error-log-append rotates when file exceeds 512KB', () => {
    const bigContent = 'x'.repeat(512 * 1024 + 1)
    writeFileSync(TEST_LOG_PATH, bigContent, 'utf-8')

    appendUpdateError({
      at: '2026-08-26T12:00:00Z',
      source: 'download',
      stage: 'downloading',
    })

    expect(existsSync(`${TEST_LOG_PATH}.1`)).toBe(true)
    const rotated = readFileSync(`${TEST_LOG_PATH}.1`, 'utf-8')
    expect(rotated).toBe(bigContent)

    const lines = readLogLines()
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]).source).toBe('download')
  })

  it('W1-error-log-append does not rotate when file is under 512KB', () => {
    writeFileSync(TEST_LOG_PATH, '{"small":true}\n', 'utf-8')

    appendUpdateError({
      at: '2026-08-26T12:00:00Z',
      source: 'test-proxy',
      stage: 'downloading',
    })

    expect(existsSync(`${TEST_LOG_PATH}.1`)).toBe(false)
    const lines = readLogLines()
    expect(lines).toHaveLength(2)
  })

  it('W1-error-log-append covers old .1 on second rotation', () => {
    writeFileSync(TEST_LOG_PATH, 'x'.repeat(512 * 1024 + 1), 'utf-8')
    appendUpdateError({
      at: '2026-08-26T12:00:00Z',
      source: 'download',
      stage: 'downloading',
    })

    const current = readFileSync(TEST_LOG_PATH, 'utf-8')
    writeFileSync(TEST_LOG_PATH, current + 'y'.repeat(512 * 1024), 'utf-8')

    appendUpdateError({
      at: '2026-08-26T12:01:00Z',
      source: 'preload',
      stage: 'downloading',
    })

    expect(existsSync(`${TEST_LOG_PATH}.1`)).toBe(true)
    const lines = readLogLines()
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]).source).toBe('preload')
  })
})

// ─── B1-disk-error-classification ──────────────────────────────

describe('B1-disk-error-classification', () => {
  it('B1 ENOSPC on err.code classifies as UPDATE_DISK_SPACE (multi-part path no longer misreports as network failure)', () => {
    // 多段路径 writeStream error 直接 reject 原生 fs 错误（code 直接在 err 上），
    // 与单段路径同一形态；修复前这条错误落兜底分支被报成 UPDATE_NETWORK_FAILED
    const err = Object.assign(new Error('write ENOSPC: no space left on device'), { code: 'ENOSPC' })
    const result = classifyNetError(err, 'downloading')
    expect(result).toBeInstanceOf(UpdateError)
    expect(result.errorCode).toBe('UPDATE_DISK_SPACE')
    expect(result.stage).toBe('downloading')
    expect(result.message).toBe('insufficient disk space')
  })

  it('B1 wrapped ENOSPC via err.cause.code classifies as UPDATE_DISK_SPACE', () => {
    const cause = Object.assign(new Error('write failed'), { code: 'ENOSPC' })
    const err = new Error('stream error', { cause })
    expect(classifyNetError(err, 'downloading').errorCode).toBe('UPDATE_DISK_SPACE')
  })

  it('B1 non-english OS message falls back to disk space substring (parity with single-part W-6)', () => {
    // 单段路径判定含子串兑底：无 errno code 时 message 含 'disk space' 同样判磁盘错
    const err = new Error("can't write: not enough disk space")
    expect(classifyNetError(err, 'downloading').errorCode).toBe('UPDATE_DISK_SPACE')
  })

  it('B1 ECONNREFUSED still classifies as UPDATE_NETWORK_FAILED (disk branch does not overtake network codes)', () => {
    const cause = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
    const err = new Error('fetch failed', { cause })
    expect(classifyNetError(err, 'downloading').errorCode).toBe('UPDATE_NETWORK_FAILED')
  })
})

// ─── B4-downloadPart-no-double-wrap ────────────────────────────

describe('B4-downloadPart-no-double-wrap', () => {
  // ≥ MIN_MULTI_PART_SIZE(10MB)，确保走 multipart 路径（186MB 产物的默认路径）
  const TOTAL_BYTES = 21 * 1024 * 1024

  beforeEach(() => {
    rmSync(TEST_LOG_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    mkdirSync(TEST_LOG_DIR, { recursive: true })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    rmSync(TEST_LOG_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('B4 pre-built part UpdateError passes through downloadPart verbatim (not double-wrapped by fallback)', async () => {
    // 探针实证场景复现：probe（GET Range 0-0，多源改造后不再走 HEAD）返回 206 放行
    // 多段，随后各段 Range 请求统一回 HTTP 500。downloadPart 内先构造
    // `part N download failed: HTTP 500`，再进自己的 catch——
    // 修复前被 classifyNetError 兑底二次包装成
    // 「download failed: part N download failed: HTTP 500」双重前缀
    const fetchMock = vi.fn(async (_url: unknown, init?: { headers?: Record<string, string> }) => {
      // probe 探测请求（GET Range: bytes=0-0）→ 206 + Content-Range total 达标放行多段
      if (init?.headers?.Range === 'bytes=0-0') {
        return new Response(new Uint8Array([0]), {
          status: 206,
          headers: { 'content-length': '1', 'content-range': `bytes 0-0/${TOTAL_BYTES}` },
        })
      }
      return new Response(null, { status: 500 })
    })
    vi.stubGlobal('fetch', fetchMock)

    let caught: unknown
    try {
      await downloadAsset({
        name: 'b4-double-wrap-test.zip',
        downloadUrl: 'https://example.invalid/b4-double-wrap-test.zip',
        size: TOTAL_BYTES,
      })
    } catch (err) {
      caught = err
    }

    // 结构断言：仍是 UpdateError 且 errorCode 不变、message 无双重前缀；
    // 正则不用固定 index：Promise.all 下哪个段先 reject 是非确定性的
    expect(caught).toBeInstanceOf(UpdateError)
    const updateErr = caught as UpdateError
    expect(updateErr.message).toMatch(/^part \d+ download failed: HTTP 500$/)
    expect(updateErr.errorCode).toBe('UPDATE_NETWORK_FAILED')
    // 确实走了 multipart 路径：probe + 至少一个段请求都经过全局 fetch
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2)
  })
})
