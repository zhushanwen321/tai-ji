/**
 * proxy-config 单元测试。
 *
 * 覆盖 proxy-config SSOT 模块的全部导出：
 *   A. encryptCredential / decryptCredential 往返（含 B-1 跨状态迁移回归防护）
 *   B. stripCredential / withCredential 凭证剥离/还原
 *   C. readProxyConfig / writeProxyConfig 文件读写往返
 *   D. resolveProxyUrl mode→url 解析
 *
 * 这些测试是 review D-1 指出的测试缺口补全，覆盖 B-1（凭证加解密降级不对称）和
 * 凭证往返的核心不变量。
 *
 * safeStorage mock 策略：proxy-config.ts 内部 `require('electron')` 读 safeStorage。
 * 「safeStorage 不可用」（明文 base64）路径显式注入 undefined 态——不依赖环境
 * require('electron') 的安装态（本地返回路径字符串桩、CI skip-binary-download 走
 * throw 分支，两形态不同），所有分支统一经 mock 自包含。
 * 「safeStorage 可用」与「B-1 跨状态迁移」路径需控制 decryptString 行为：
 * vi.mock('electron') 无法拦截 require（ESM/CJS 边界），改用 Module._load 拦截
 * `require('electron')` 注入可控的 safeStorage 桩（beforeEach 设、afterEach 还原，不污染其他文件）。
 *
 * 隔离：readProxyConfig/writeProxyConfig 走 getDataDir()/proxy-config.json，
 * 经 TAIJI_AGENT_DATA_DIR 重定向到临时目录（getProxyConfigPath 每次调用都延迟算 getDataDir）。
 *
 * 运行：cd apps/electron/main && npx vitest run test/proxy-config.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  encryptCredential,
  decryptCredential,
  stripCredential,
  withCredential,
  readProxyConfig,
  writeProxyConfig,
  resolveProxyUrl,
  getProxyConfigPath,
} from '../update/proxy-config.js'

// ── safeStorage mock 辅助（Module._load 拦截 require('electron')）──────────
// vi.mock('electron') 只能拦截 ESM import，无法拦截 proxy-config 内部的 require；
// 故用 Module._load 在 require 层注入可控 safeStorage。仅在需要「safeStorage 可用」
// 的 describe 块的 beforeEach 注入、afterEach 还原，不影响其他测试文件。
//
// Module._load 是 Node 内部 API（公开类型未声明），经 require('module') 拿到原生模块实例，
// 转成带 _load 字段的形状操作；保存原始引用用于还原。
// eslint-disable-next-line @typescript-eslint/no-require-imports -- 仅 Node 内部 API（_load）需经 require('module') 取实例；测试辅助代码，不影响实现
const nodeModule = require('module') as NodeModule & {
  _load: (request: string, parent?: NodeJS.Module, isMain?: boolean) => unknown
}
let originalLoad: typeof nodeModule._load | null = null

interface FakeSafeStorage {
  isEncryptionAvailable: () => boolean
  encryptString: (plain: string) => Buffer
  decryptString: (b: Buffer) => string
}

/**
 * 拦截 `require('electron')` 注入伪造 safeStorage。
 * getSafeStorage() 每次调用都重新 require，故拦截在 require 调用前设好即可对所有
 * 后续 encryptCredential/decryptCredential 生效。
 * 传 undefined 注入「无 safeStorage」显式不可用态：明文 base64 用例必须自包含，
 * 不依赖环境 require('electron') 的安装态（本地装了二进制返回路径字符串桩，
 * CI ELECTRON_SKIP_BINARY_DOWNLOAD 下 path.txt 缺失走 throw 分支，两形态不同）。
 * 可重复调用（同一测试内切换状态）：originalLoad 仅首次拦截时保存，避免还原成中间态。
 */
function interceptElectronSafeStorage(safeStorage: FakeSafeStorage | undefined): void {
  if (originalLoad === null) {
    originalLoad = nodeModule._load
  }
  const realLoad = originalLoad
  nodeModule._load = ((request: string, ...args: unknown[]) => {
    if (request === 'electron') {
      return { safeStorage }
    }
    // realLoad 在闭包外捕获，类型确定非空（control-flow narrowing 不跨闭包，故用局部常量）
    return realLoad(request, ...(args as [NodeJS.Module, boolean]))
  }) as typeof nodeModule._load
}

/** 还原 Module._load，必须在 afterEach 调用避免污染同文件其他 describe。 */
function restoreElectronSafeStorage(): void {
  if (originalLoad !== null) {
    nodeModule._load = originalLoad
    originalLoad = null
  }
}

// ── 数据目录隔离（延迟计算，每次设 env 即时生效）──────────────────────────────
let prevDataDir: string | undefined

beforeEach(() => {
  prevDataDir = process.env.TAIJI_AGENT_DATA_DIR
  process.env.TAIJI_AGENT_DATA_DIR = mkdtempSync(join(tmpdir(), 'taiji-proxy-cfg-'))
})

afterEach(() => {
  restoreElectronSafeStorage()
  if (prevDataDir === undefined) {
    delete process.env.TAIJI_AGENT_DATA_DIR
  } else {
    process.env.TAIJI_AGENT_DATA_DIR = prevDataDir
  }
})

// ── A. 凭证加解密往返 ──────────────────────────────────────────────────
describe('A: encryptCredential / decryptCredential roundtrip', () => {
  it('safeStorage 可用时的往返（encryptString → decryptString 还原）', () => {
    // 简单可逆变换模拟真实加解密；decryptString 仅识别本变换产生的密文，否则抛错
    const ENC_PREFIX = 'ENC:'
    interceptElectronSafeStorage({
      isEncryptionAvailable: () => true,
      encryptString: (plain) => Buffer.from(ENC_PREFIX + plain, 'utf-8'),
      decryptString: (buf) => {
        const s = buf.toString('utf-8')
        if (!s.startsWith(ENC_PREFIX)) throw new Error('Could not decrypt')
        return s.slice(ENC_PREFIX.length)
      },
    })

    const plain = 'user:s3cret-token'
    const enc = encryptCredential(plain)

    // 密文是 base64，且不是明文 base64（经过 ENC: 变换）
    expect(enc).not.toBe(Buffer.from(plain, 'utf-8').toString('base64'))
    expect(() => Buffer.from(enc, 'base64')).not.toThrow()

    const dec = decryptCredential(enc)
    expect(dec).toBe(plain)
  })

  it('safeStorage 不可用时的往返（明文 base64）', () => {
    // 显式注入无 safeStorage 态：getSafeStorage 返回 null → encrypt/decrypt 走明文 base64。
    // 不依赖环境 require('electron') 的安装态（本地路径桩 / CI skip-binary-download
    // 下 throw，两形态不同），保证测试自包含
    interceptElectronSafeStorage(undefined)
    const plain = 'user:s3cret-token'
    const enc = encryptCredential(plain)

    // 明文 base64：可直接反向解码出原文
    expect(enc).toBe(Buffer.from(plain, 'utf-8').toString('base64'))

    const dec = decryptCredential(enc)
    expect(dec).toBe(plain)
  })

  it('[B-1 回归防护] 写入时 safeStorage 不可用（明文 base64），读取时 safeStorage 变可用且 decryptString 抛错 → 降级明文 base64 仍还原', () => {
    // Phase 1：safeStorage 显式不可用（注入 undefined，不赌环境安装态）→ 写出明文 base64 凭证
    interceptElectronSafeStorage(undefined)
    const plain = 'user:migrated-secret'
    const enc = encryptCredential(plain)
    expect(enc).toBe(Buffer.from(plain, 'utf-8').toString('base64'))

    // Phase 2：状态迁移——safeStorage 现在可用，但 decryptString 对历史明文 base64 解不了。
    // 这是 B-1 bug 的核心场景：旧 orchestrator 侧无明文降级，这里验证 decryptCredential 兜底。
    interceptElectronSafeStorage({
      isEncryptionAvailable: () => true,
      encryptString: () => Buffer.from('opaque'),
      decryptString: () => {
        throw new Error('Could not decrypt string')
      },
    })

    // 关键：不抛错，降级为明文 base64 解码，正确还原原始凭证
    expect(() => decryptCredential(enc)).not.toThrow()
    expect(decryptCredential(enc)).toBe(plain)
  })

  it('safeStorage 可用但 isEncryptionAvailable 返回 false → 走明文 base64', () => {
    interceptElectronSafeStorage({
      isEncryptionAvailable: () => false,
      encryptString: () => Buffer.from('should-not-be-used'),
      decryptString: () => 'should-not-be-called',
    })

    const plain = 'token'
    const enc = encryptCredential(plain)
    expect(enc).toBe(Buffer.from(plain, 'utf-8').toString('base64'))
    expect(decryptCredential(enc)).toBe(plain)
  })
})

// ── B. stripCredential / withCredential ─────────────────────────────────
describe('B: stripCredential / withCredential', () => {
  // 本 describe 各用例经 encryptCredential 触达 getSafeStorage 的 require('electron')，
  // 默认显式注入无 safeStorage 态：不拦截时该 require 依赖环境安装态（本地路径桩 /
  // CI skip-binary-download 下 throw 分支），曾致 CI 间歇 5s 超时；afterEach 统一还原
  beforeEach(() => interceptElectronSafeStorage(undefined))
  it('有凭证的 URL：stripCredential 剥离凭证，withCredential 还原', () => {
    const url = 'http://user:pass@host:8080'
    const { safeUrl, credential } = stripCredential(url)

    // 凭证被剥离，safeUrl 不含 user:pass；URL 规范化会给 host 后补 /
    expect(safeUrl).not.toContain('user:pass')
    expect(new URL(safeUrl).host).toBe('host:8080')
    expect(credential).toBe('user:pass')

    // withCredential 还原（凭证经加解密往返，safeStorage 不可用 → 明文 base64）
    const enc = encryptCredential(credential!)
    const restored = withCredential(safeUrl, enc)
    const restoredUrl = new URL(restored)
    expect(restoredUrl.username).toBe('user')
    expect(restoredUrl.password).toBe('pass')
    expect(restoredUrl.host).toBe('host:8080')
  })

  it('无凭证的 URL：stripCredential 返回 credential 为 undefined', () => {
    const url = 'http://host:8080'
    const { safeUrl, credential } = stripCredential(url)

    expect(credential).toBeUndefined()
    expect(safeUrl).toBe(url)

    // withCredential 传 undefined → 返回原 url（凭证缺失不阻断）
    expect(withCredential(safeUrl, undefined)).toBe(safeUrl)
  })

  it('仅有用户名无密码的 URL：credential 只含 username', () => {
    const url = 'http://alice@host:8080'
    const { safeUrl, credential } = stripCredential(url)

    expect(credential).toBe('alice')
    expect(new URL(safeUrl).username).toBe('')

    const enc = encryptCredential(credential!)
    const restored = withCredential(safeUrl, enc)
    expect(new URL(restored).username).toBe('alice')
    expect(new URL(restored).password).toBe('')
  })

  it('特殊字符密码（含 @ :）的往返（URL 百分号编码保持一致）', () => {
    // 调用方需将特殊字符百分号编码后构造 URL；stripCredential 取出的凭证也是百分号编码形态。
    // 关键不变量：withCredential 还原后，URL 解析出的 password 解码回原特殊字符。
    const url = 'http://user:p%40ss%3Aword@host:8080'
    const { safeUrl, credential } = stripCredential(url)

    // credential 含百分号编码的密码（p%40ss%3Aword），split(':') 不被密码内的 %3A 干扰
    expect(credential).toBe('user:p%40ss%3Aword')
    expect(safeUrl).not.toContain('p%40ss')

    const enc = encryptCredential(credential!)
    const restored = withCredential(safeUrl, enc)
    const restoredUrl = new URL(restored)

    // 还原后 URL 解码出原始特殊字符密码
    expect(restoredUrl.username).toBe('user')
    expect(restoredUrl.password).toBe('p%40ss%3Aword')
    // 多次解码（模拟 ProxyAgent 行为）还原为明文特殊字符
    expect(decodeURIComponent(restoredUrl.password)).toBe('p@ss:word')
  })

  it('非法 URL：stripCredential 原样返回，credential 为 undefined', () => {
    const { safeUrl, credential } = stripCredential('not-a-url')
    expect(safeUrl).toBe('not-a-url')
    expect(credential).toBeUndefined()
  })
})

// ── C. readProxyConfig / writeProxyConfig 文件往返 ───────────────────────
describe('C: readProxyConfig / writeProxyConfig', () => {
  // 含凭证的写入/读取经 encrypt/decryptCredential 触达 require('electron')，
  // 同 B describe：默认显式注入无 safeStorage 态，不赌环境安装态
  beforeEach(() => interceptElectronSafeStorage(undefined))
  it('含凭证的配置写入后读取，凭证还原，功能等价', () => {
    writeProxyConfig({
      mode: 'manual',
      httpProxy: 'http://user:pass@host:8080',
      httpsProxy: 'http://user:pass@host:8080',
    })

    const cfg = readProxyConfig()
    expect(cfg.mode).toBe('manual')

    // 凭证已还原回 URL（明文 base64 往返，URL 规范化补 /）
    const http = new URL(cfg.httpProxy!)
    expect(http.username).toBe('user')
    expect(http.password).toBe('pass')
    expect(http.host).toBe('host:8080')
    const https = new URL(cfg.httpsProxy!)
    expect(https.username).toBe('user')
    expect(https.password).toBe('pass')
  })

  it('写入的文件不含明文密码（凭证经 base64 编码）', () => {
    writeProxyConfig({
      mode: 'manual',
      httpProxy: 'http://user:supersecret@host:8080',
    })

    const raw = readFileSync(getProxyConfigPath(), 'utf-8')
    // 文件内容不应包含明文密码片段
    expect(raw).not.toContain('supersecret')
    expect(raw).not.toContain('user:supersecret')
    // 凭证以 base64 形式存在
    expect(raw).toContain('"credentials"')
  })

  it('无凭证的配置写入后读取，无 credentials 字段', () => {
    writeProxyConfig({
      mode: 'manual',
      httpProxy: 'http://127.0.0.1:7890',
    })

    const raw = readFileSync(getProxyConfigPath(), 'utf-8')
    expect(raw).not.toContain('credentials')

    const cfg = readProxyConfig()
    expect(cfg).toEqual({
      mode: 'manual',
      httpProxy: expect.any(String),
    })
    expect(cfg.httpProxy).toBe('http://127.0.0.1:7890')
  })

  it('文件不存在时 readProxyConfig 返回默认 { mode: "system" }', () => {
    expect(existsSync(getProxyConfigPath())).toBe(false)
    expect(readProxyConfig()).toEqual({ mode: 'system' })
  })

  it('文件损坏（垃圾内容）时 readProxyConfig 返回 { mode: "system" }，不抛错', () => {
    writeFileSync(getProxyConfigPath(), 'not valid json {{{')

    expect(() => readProxyConfig()).not.toThrow()
    expect(readProxyConfig()).toEqual({ mode: 'system' })
  })

  it('disabled 模式写入后读取保持 disabled', () => {
    writeProxyConfig({ mode: 'disabled' })
    expect(readProxyConfig()).toEqual({ mode: 'disabled' })
  })
})

// ── D. resolveProxyUrl ──────────────────────────────────────────────────
describe('D: resolveProxyUrl', () => {
  it('manual 模式：有 httpsProxy 返回 httpsProxy（优先于 httpProxy）', () => {
    expect(
      resolveProxyUrl({ mode: 'manual', httpProxy: 'http://a:1', httpsProxy: 'http://b:2' }),
    ).toBe('http://b:2')
  })

  it('manual 模式：无 httpsProxy 有 httpProxy → 返回 httpProxy', () => {
    expect(resolveProxyUrl({ mode: 'manual', httpProxy: 'http://a:1' })).toBe('http://a:1')
  })

  it('manual 模式：httpProxy/httpsProxy 都没有 → 返回 undefined', () => {
    expect(resolveProxyUrl({ mode: 'manual' })).toBeUndefined()
  })

  it('disabled 模式：返回 undefined', () => {
    expect(resolveProxyUrl({ mode: 'disabled', httpProxy: 'http://a:1' })).toBeUndefined()
  })

  it('system 模式：按 HTTPS_PROXY > https_proxy > HTTP_PROXY > http_proxy 优先级读环境变量', () => {
    const keys = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'] as const
    const saved = keys.map((k) => process.env[k])
    keys.forEach((k) => delete process.env[k])
    try {
      // 全设 → 取最高优先 HTTPS_PROXY
      process.env.HTTPS_PROXY = 'https://hp'
      process.env.https_proxy = 'https://lhp'
      process.env.HTTP_PROXY = 'http://ph'
      process.env.http_proxy = 'http://lph'
      expect(resolveProxyUrl({ mode: 'system' })).toBe('https://hp')

      // 去掉最高优先级 → 降级到 https_proxy
      delete process.env.HTTPS_PROXY
      expect(resolveProxyUrl({ mode: 'system' })).toBe('https://lhp')

      // 仅剩 HTTP_PROXY
      delete process.env.https_proxy
      expect(resolveProxyUrl({ mode: 'system' })).toBe('http://ph')
    } finally {
      keys.forEach((k, i) => {
        if (saved[i] === undefined) delete process.env[k]
        else process.env[k] = saved[i]
      })
    }
  })

  it('system 模式：无任何代理环境变量 → 返回 undefined', () => {
    const keys = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'] as const
    const saved = keys.map((k) => process.env[k])
    keys.forEach((k) => delete process.env[k])
    try {
      expect(resolveProxyUrl({ mode: 'system' })).toBeUndefined()
    } finally {
      keys.forEach((k, i) => {
        if (saved[i] === undefined) delete process.env[k]
        else process.env[k] = saved[i]
      })
    }
  })
})
