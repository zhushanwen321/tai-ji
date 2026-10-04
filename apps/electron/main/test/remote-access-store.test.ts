/**
 * remote-access store 单测（remote-access D2/E10 main 写侧契约）。
 *
 * 覆盖：
 * - 缺文件 → 默认关态配置（不报错、不落盘）
 * - 非 ENOENT 读失败（EACCES 形态）→ 响亮日志含恢复指引 + 关态空 token 降级（缺失
 *   形态，不落盘；重新开启时 setEnabled 自愈补发新 token）
 * - generateToken：64 位小写 hex
 * - write：原子写语义（同目录 .tmp 临时文件 + rename，写后无 .tmp 残留、无半截 JSON）+
 *   0600 权限（含覆写已存在文件后仍 0600——writeFileSync mode 仅创建时生效的兜底）；
 *   rename 前 fsync 段的专项断言见 remote-access-store-fsync.test.ts
 * - rotate：重写后读取一致（新 token + enabled/createdAt 保留）
 * - setEnabled：仅 enabled 变化，token/createdAt 保留；关态文件留存
 * - 损坏 JSON / 字段不合法 → E10 重建默认关态 + 响亮日志（console.error 含恢复指引）；
 *   重建写回失败（只读 dataDir）→ 降级内存关态空 token 继续启动（不拒启）
 *
 * 数据目录经 dataDir 参数注入 mkdtemp tmp 自建自删（测试红线：禁触真实数据目录）。
 *
 * 运行：cd apps/electron/main && npx vitest run test/remote-access-store.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, mkdirSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REMOTE_ACCESS_FILENAME } from '@taiji/shared'
import {
  readRemoteAccessConfig,
  writeRemoteAccessConfig,
  generateRemoteAccessToken,
  rotateRemoteAccessToken,
  setRemoteAccessEnabled,
  isValidRemoteAccessConfig,
} from '../remote-access/store.js'

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), 'remote-access-store-'))
const FILE_PATH = join(TMP_DATA_DIR, REMOTE_ACCESS_FILENAME)

/** 写一份指定内容的配置文件（测试夹具）。 */
function seedFile(raw: string): void {
  mkdirSync(TMP_DATA_DIR, { recursive: true })
  writeFileSync(FILE_PATH, raw, 'utf-8')
}

/** 读当前配置文件内容（断言落盘形态用）。 */
function readFileRaw(): string {
  return readFileSync(FILE_PATH, 'utf-8')
}

afterAll(() => {
  rmSync(TMP_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

describe('generateRemoteAccessToken', () => {
  it('返回 64 位小写 hex（32 字节随机值的 hex 编码）', () => {
    const token = generateRemoteAccessToken()
    expect(token).toMatch(/^[0-9a-f]{64}$/)
  })

  it('两次生成不重复（随机性冒烟）', () => {
    expect(generateRemoteAccessToken()).not.toBe(generateRemoteAccessToken())
  })
})

describe('readRemoteAccessConfig', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    rmSync(FILE_PATH, { force: true })
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    errorSpy.mockRestore()
  })

  it('缺文件 → 默认关态配置（enabled=false + 64hex token + createdAt），不落盘', () => {
    const config = readRemoteAccessConfig(TMP_DATA_DIR)
    expect(config.enabled).toBe(false)
    expect(config.token).toMatch(/^[0-9a-f]{64}$/)
    expect(config.createdAt).toBeTruthy()
    // 缺文件读取不产生文件（首次开启/轮换时才落盘）
    expect(existsSync(FILE_PATH)).toBe(false)
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('合法文件 → 原样读出（不重写）', () => {
    seedFile('{"enabled":true,"token":"' + 'a'.repeat(64) + '","createdAt":"2026-01-01T00:00:00.000Z"}')
    const config = readRemoteAccessConfig(TMP_DATA_DIR)
    expect(config).toEqual({
      enabled: true,
      token: 'a'.repeat(64),
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('非 ENOENT 读失败（路径被目录占位，EISDIR 形态）→ 响亮日志含恢复指引 + 关态空 token 降级（不写回）', () => {
    // 真实 fs 形态制造读失败（vi.spyOn 对 node:fs ESM namespace 不可 redefine）：
    // 配置文件路径被目录占位 → readFileSync 抛 EISDIR（非 ENOENT）
    mkdirSync(FILE_PATH)
    try {
      const config = readRemoteAccessConfig(TMP_DATA_DIR)
      // 降级为关态 fail-closed；token 空串 = 缺失形态（磁盘态不可信，不产磁盘上
      // 不存在的假 token 误导面板——上游 fullUrl 有 token 真值守卫，空值不渲染假链接）
      expect(config.enabled).toBe(false)
      expect(config.token).toBe('')
      expect(config.createdAt).toBeTruthy()
      // 降级 ≠ 吞错：响亮日志（读失败原因 + 恢复指引），对齐 E10 处理强度
      expect(errorSpy).toHaveBeenCalledTimes(1)
      const message = String(errorSpy.mock.calls[0]?.[0])
      expect(message).toContain(REMOTE_ACCESS_FILENAME)
      expect(message).toContain('EISDIR')
      expect(message).toContain('恢复')
      expect(message).toContain('远程访问面板')
      // 读失败降级不写回（目录占位原样留存；若误触写回，rename 落目录路径会失败）
      expect(existsSync(FILE_PATH)).toBe(true)
    } finally {
      rmSync(FILE_PATH, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('降级缺失形态（空 token）后重新开启 → setRemoteAccessEnabled 自愈补发新 token 落盘（恢复通道）', () => {
    if (process.platform === 'win32') return // POSIX 文件权限语义，win32 不跑本用例
    // 真实形态构造「读降级 + 写可成功」组合：文件权限收回（0000）→ readFileSync 抛
    // EACCES 降级空 token；写路径是 tmp + rename 覆盖（只查父目录权限）→ 成功。
    // 无自愈时将落盘「开态 + 空 token」半合法文件（runtime 读侧 fail-closed 全拒，
    // 面板却显示已开启）；有自愈则补发新 token，一步回到可用态。
    seedFile('{"enabled":false,"token":"' + '2'.repeat(64) + '","createdAt":"2026-01-01T00:00:00.000Z"}')
    chmodSync(FILE_PATH, 0o000)
    try {
      const enabled = setRemoteAccessEnabled(true, TMP_DATA_DIR)
      expect(enabled.enabled).toBe(true)
      expect(enabled.token).toMatch(/^[0-9a-f]{64}$/)
      expect(statSync(FILE_PATH).mode & 0o777).toBe(0o600)
      expect(JSON.parse(readFileRaw())).toEqual(enabled)
    } finally {
      chmodSync(FILE_PATH, 0o600)
    }
  })
})

describe('writeRemoteAccessConfig（原子写 + 0600）', () => {
  it('写入后读回一致，目录内无 .tmp 残留（rename 完成态）', () => {
    const config = { enabled: true, token: 'b'.repeat(64), createdAt: '2026-01-01T00:00:00.000Z' }
    writeRemoteAccessConfig(config, TMP_DATA_DIR)
    expect(JSON.parse(readFileRaw())).toEqual(config)
    const leftovers = readdirSync(TMP_DATA_DIR).filter((name) => name.includes('.tmp'))
    expect(leftovers).toEqual([])
  })

  it('文件权限 0600（新建）', () => {
    rmSync(FILE_PATH, { force: true })
    writeRemoteAccessConfig(
      { enabled: false, token: 'c'.repeat(64), createdAt: '2026-01-01T00:00:00.000Z' },
      TMP_DATA_DIR,
    )
    // POSIX 权限位断言（CI 为 macOS/Linux；win32 无 POSIX mode 语义，不跑本用例）
    if (process.platform !== 'win32') {
      expect(statSync(FILE_PATH).mode & 0o777).toBe(0o600)
    }
  })

  it('覆写已存在文件后权限仍 0600（rename 新建 inode + chmod 兜底）', () => {
    // 先写一个被外部放宽为 0644 的文件，模拟「外部 chmod 放宽」场景
    seedFile('{"enabled":false,"token":"' + 'd'.repeat(64) + '","createdAt":"2026-01-01T00:00:00.000Z"}')
    if (process.platform !== 'win32') {
      chmodSync(FILE_PATH, 0o644)
    }
    writeRemoteAccessConfig(
      { enabled: true, token: 'e'.repeat(64), createdAt: '2026-01-01T00:00:00.000Z' },
      TMP_DATA_DIR,
    )
    expect(JSON.parse(readFileRaw()).token).toBe('e'.repeat(64))
    if (process.platform !== 'win32') {
      expect(statSync(FILE_PATH).mode & 0o777).toBe(0o600)
    }
  })

  it('数据目录不存在时自动创建（mkdir recursive）', () => {
    const nested = join(TMP_DATA_DIR, 'deep', 'dir')
    writeRemoteAccessConfig(
      { enabled: false, token: 'f'.repeat(64), createdAt: '2026-01-01T00:00:00.000Z' },
      nested,
    )
    expect(JSON.parse(readFileSync(join(nested, REMOTE_ACCESS_FILENAME), 'utf-8')).enabled).toBe(false)
    rmSync(join(TMP_DATA_DIR, 'deep'), { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
})

describe('rotateRemoteAccessToken（轮换）', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    rmSync(FILE_PATH, { force: true })
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    errorSpy.mockRestore()
  })

  it('轮换后读取一致：新 token 合法，enabled 与 createdAt 保留', () => {
    seedFile('{"enabled":true,"token":"' + '1'.repeat(64) + '","createdAt":"2026-01-01T00:00:00.000Z"}')
    const rotated = rotateRemoteAccessToken(TMP_DATA_DIR)
    expect(rotated.enabled).toBe(true)
    expect(rotated.createdAt).toBe('2026-01-01T00:00:00.000Z')
    expect(rotated.token).toMatch(/^[0-9a-f]{64}$/)
    expect(rotated.token).not.toBe('1'.repeat(64))
    // 落盘与返回值一致（下次热读生效的就是这份）
    expect(JSON.parse(readFileRaw())).toEqual(rotated)
  })

  it('对缺文件轮换：基于默认关态配置产出文件（enabled=false + 新 token）', () => {
    const rotated = rotateRemoteAccessToken(TMP_DATA_DIR)
    expect(rotated.enabled).toBe(false)
    expect(rotated.token).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.parse(readFileRaw())).toEqual(rotated)
  })
})

describe('setRemoteAccessEnabled（开关切换）', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    rmSync(FILE_PATH, { force: true })
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    errorSpy.mockRestore()
  })

  it('开启：enabled=true，token/createdAt 保留', () => {
    seedFile('{"enabled":false,"token":"' + '2'.repeat(64) + '","createdAt":"2026-01-01T00:00:00.000Z"}')
    const updated = setRemoteAccessEnabled(true, TMP_DATA_DIR)
    expect(updated.enabled).toBe(true)
    expect(updated.token).toBe('2'.repeat(64))
    expect(updated.createdAt).toBe('2026-01-01T00:00:00.000Z')
  })

  it('关闭后文件留存（关态文件留存，再开启复活原 token）', () => {
    seedFile('{"enabled":true,"token":"' + '3'.repeat(64) + '","createdAt":"2026-01-01T00:00:00.000Z"}')
    const updated = setRemoteAccessEnabled(false, TMP_DATA_DIR)
    expect(updated.enabled).toBe(false)
    expect(existsSync(FILE_PATH)).toBe(true)
    expect(JSON.parse(readFileRaw()).token).toBe('3'.repeat(64))
  })
})

describe('ensureRemoteAccessIntegrity（E10 损坏重建，经 read 触发）', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    rmSync(FILE_PATH, { force: true })
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    errorSpy.mockRestore()
  })

  it('非法 JSON → 重建默认关态配置写回 + 响亮日志含恢复指引', () => {
    seedFile('{not-valid-json')
    const config = readRemoteAccessConfig(TMP_DATA_DIR)
    expect(config.enabled).toBe(false)
    expect(config.token).toMatch(/^[0-9a-f]{64}$/)
    // 响亮日志 + 恢复指引（指向面板重新开启）
    expect(errorSpy).toHaveBeenCalledTimes(1)
    const message = String(errorSpy.mock.calls[0]?.[0])
    expect(message).toContain(REMOTE_ACCESS_FILENAME)
    expect(message).toContain('远程访问面板')
    // 重建结果已写回文件（下次 runtime 热读拿到合法配置）
    expect(JSON.parse(readFileRaw())).toEqual(config)
  })

  it('字段不合法（token 非 64 位 hex）→ 重建 + 响亮日志', () => {
    seedFile('{"enabled":true,"token":"short","createdAt":"2026-01-01T00:00:00.000Z"}')
    const config = readRemoteAccessConfig(TMP_DATA_DIR)
    expect(config.enabled).toBe(false)
    expect(config.token).toMatch(/^[0-9a-f]{64}$/)
    expect(errorSpy).toHaveBeenCalledTimes(1)
  })

  it('字段类型不合法（enabled 非 boolean）→ 重建', () => {
    seedFile('{"enabled":"yes","token":"' + '4'.repeat(64) + '","createdAt":"2026-01-01T00:00:00.000Z"}')
    const config = readRemoteAccessConfig(TMP_DATA_DIR)
    expect(config.enabled).toBe(false)
    expect(errorSpy).toHaveBeenCalledTimes(1)
  })

  it('合法配置不触发重建日志', () => {
    seedFile('{"enabled":true,"token":"' + '5'.repeat(64) + '","createdAt":"2026-01-01T00:00:00.000Z"}')
    readRemoteAccessConfig(TMP_DATA_DIR)
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('损坏重建写回失败（dataDir 只读，EACCES 形态）→ 不拒启：降级内存关态空 token + 响亮日志含权限恢复指引（损坏文件原样留存）', () => {
    if (process.platform === 'win32') return // POSIX 目录权限语义，win32 不跑本用例
    // 真实 fs 形态制造写失败：损坏文件所在目录被收回写权限 → writeFileSync(.tmp) 抛 EACCES
    seedFile('{corrupted')
    chmodSync(TMP_DATA_DIR, 0o500)
    try {
      const config = readRemoteAccessConfig(TMP_DATA_DIR)
      // fail-safe：降级为内存关态（token 空 = 缺失形态）继续返回，不裸抛拒启；
      // 损坏文件保持原样未被改动（runtime 热读损坏内容走读侧 fail-closed，无开放面）
      expect(config.enabled).toBe(false)
      expect(config.token).toBe('')
      expect(readFileRaw()).toBe('{corrupted')
      // 响亮日志两次（损坏重建 + 写回失败）且写回失败日志含可操作恢复指引
      expect(errorSpy).toHaveBeenCalledTimes(2)
      const writeFailMessage = String(errorSpy.mock.calls[1]?.[0])
      expect(writeFailMessage).toContain('写回失败')
      expect(writeFailMessage).toContain('EACCES')
      expect(writeFailMessage).toContain('chmod u+w')
      expect(writeFailMessage).toContain('远程访问面板')
    } finally {
      chmodSync(TMP_DATA_DIR, 0o700)
    }
  })
})

describe('isValidRemoteAccessConfig（结构守卫）', () => {
  it('合法形态放行', () => {
    expect(
      isValidRemoteAccessConfig({ enabled: true, token: '6'.repeat(64), createdAt: '2026-01-01T00:00:00.000Z' }),
    ).toBe(true)
  })

  it.each([
    ['null', null],
    ['非对象', 'string'],
    ['缺 token', { enabled: true, createdAt: 'x' }],
    ['token 非 hex', { enabled: true, token: 'zz', createdAt: 'x' }],
    ['token 大写 hex', { enabled: true, token: 'A'.repeat(64), createdAt: 'x' }],
    ['enabled 非 boolean', { enabled: 1, token: '7'.repeat(64), createdAt: 'x' }],
    ['createdAt 缺失', { enabled: true, token: '8'.repeat(64) }],
  ])('%s → 拒绝', (_name, value) => {
    expect(isValidRemoteAccessConfig(value)).toBe(false)
  })
})
