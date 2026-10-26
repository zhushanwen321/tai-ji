// remote-access-merged.test.ts —— electron-main-test C04 簇合并产物（round5-G）。
// 共同被测业务模块：`remote-access/store.ts`。mock 相容：单侧 mock node:fs——合并后 mock 全文件生效，未 mock 方用例经产物自检全绿核对。
// 顶层正文按来源包 describe 纯前缀分节，it 层名零改动。
//
// 来源：
//   - test/remote-access-store-fsync.test.ts（2 用例，skip 0）
//   - test/remote-access-store.test.ts（27 用例，skip 0）

import { describe, it, expect, vi, beforeEach, afterAll, afterEach } from 'vitest'
// vi.fn 包装后的 fsyncSync 实例（与 store.ts 拿到的是同一 mock 模块图实例，可注入失败）
import { mkdtempSync, rmSync, writeFileSync, readFileSync, fsyncSync, existsSync, readdirSync, statSync, mkdirSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REMOTE_ACCESS_FILENAME } from '@taiji/shared'
import { writeRemoteAccessConfig, readRemoteAccessConfig, generateRemoteAccessToken, rotateRemoteAccessToken, setRemoteAccessEnabled, isValidRemoteAccessConfig } from '../remote-access/store'

/** fsync 调用记录（vi.hoisted：mock 工厂提升后仍可写；impl 内经 fstat 验证 fd 指向真实文件） */
const fsyncCalls = vi.hoisted(() => {
  return [] as Array<{ isFile: boolean }>
})
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    fsyncSync: vi.fn((fd: number): void => {
      fsyncCalls.push({ isFile: actual.fstatSync(fd).isFile() })
      actual.fsyncSync(fd)
    }),
  }
})

// ======== 来源：remote-access-store-fsync.test.ts ========
describe("remote-access-store-fsync", () => {
  const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), 'remote-access-store-fsync-'))

  const FILE_PATH = join(TMP_DATA_DIR, REMOTE_ACCESS_FILENAME)

  afterAll(() => {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  describe('writeRemoteAccessConfig（rename 前 fsync 掉电半写防护）', () => {
    beforeEach(() => {
      rmSync(FILE_PATH, { force: true })
      fsyncCalls.length = 0
      vi.mocked(fsyncSync).mockClear()
    })

    it('写入路径调用 fsyncSync 且 fd 指向真实文件（防实现回退丢失 fsync 段）', () => {
      writeRemoteAccessConfig(
        { enabled: false, token: 'a'.repeat(64), createdAt: '2026-01-01T00:00:00.000Z' },
        TMP_DATA_DIR,
      )
      expect(fsyncCalls.length).toBeGreaterThanOrEqual(1)
      expect(fsyncCalls.every((call) => call.isFile)).toBe(true)
      // fsync 成功路径行为不变：内容完整落盘
      expect(JSON.parse(readFileSync(FILE_PATH, 'utf-8')).token).toBe('a'.repeat(64))
    })

    it('fsyncSync 失败（掉电前兆形态）→ 写入裸抛中止，不 rename 半写文件，目标文件保持旧内容（固定 fsync 先于 rename）', () => {
      // 旧内容落盘（模拟「完整旧内容」的既有文件）
      writeFileSync(FILE_PATH, '{"enabled":false,"token":"' + 'b'.repeat(64) + '","createdAt":"2026-01-01T00:00:00.000Z"}', 'utf-8')
      // 一次性注入 fsync 失败（模拟掉电前兆：EIO 形态）
      vi.mocked(fsyncSync).mockImplementationOnce(() => {
        throw new Error('EIO: fsync failed (simulated power-loss precursor)')
      })
      expect(() =>
        writeRemoteAccessConfig(
          { enabled: true, token: 'c'.repeat(64), createdAt: '2026-01-01T00:00:00.000Z' },
          TMP_DATA_DIR,
        ),
      ).toThrow(/EIO/)
      // fsync 失败 → rename 未执行 → 目标文件保持旧内容；新配置未落盘
      expect(JSON.parse(readFileSync(FILE_PATH, 'utf-8')).token).toBe('b'.repeat(64))
    })

  })
});

// ======== 来源：remote-access-store.test.ts ========
describe("remote-access-store", () => {
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
        // 不存在的假 token 误导面板——上游 fullUrl 有 token 真值检查，空值不渲染假链接）
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

    it('崩溃残留 tmp 不被复用（唯一 tmp 名）+ 目标被外部放宽 → 写入后目标仍 0600，不新增 tmp 残留', () => {
      if (process.platform === 'win32') return // POSIX 文件权限语义，win32 不跑本用例
      // 固定 tmp 名的旧纪律下，上次写入在 writeFileSync 之后、rename 之前崩溃留下的
      // `.tmp` 残留会被本次写入重新打开（O_CREAT 不应用 mode），rename 后目标继承
      // 残留 inode 的宽松权限，只能靠 rename 后的 chmodSync 拉回 0600。现纪律
      // （atomic-write-json：pid+序号唯一 tmp 名）每次写入恒新建 tmp（mode 在创建时
      // 生效），残留 tmp 永不被复用。本用例固定三点：① 残留 tmp 原样留存（无复用
      // 通道——宽松权限的残留内容不可能进入目标）；② 目标 inode 被外部放宽后，
      // chmodSync 兜底保证最终权限精确 0600；③ 写入自身不新增 tmp 残留。
      const config = { enabled: true, token: 'g'.repeat(64), createdAt: '2026-01-01T00:00:00.000Z' }
      const staleTmpName = `${REMOTE_ACCESS_FILENAME}.crashed-writer.tmp`
      const staleTmpPath = join(TMP_DATA_DIR, staleTmpName)
      // ① 先正常写一次（合法基线态），随后手动构造崩溃残留 + 目标被外部放宽为 0644
      writeRemoteAccessConfig({ enabled: false, token: 'h'.repeat(64), createdAt: '2026-01-01T00:00:00.000Z' }, TMP_DATA_DIR)
      writeFileSync(staleTmpPath, 'stale-content-from-crashed-writer', { mode: 0o644 })
      chmodSync(staleTmpPath, 0o644)
      chmodSync(FILE_PATH, 0o644)
      // 前置自检：目标确为 0644（放宽形态成立，防用例假绿）
      expect(statSync(FILE_PATH).mode & 0o777).toBe(0o644)
      // ② 再写入：目标权限回到 0600；残留 tmp 不被消费（内容未进入目标）；无新增 tmp
      writeRemoteAccessConfig(config, TMP_DATA_DIR)
      expect(statSync(FILE_PATH).mode & 0o777).toBe(0o600)
      expect(JSON.parse(readFileRaw())).toEqual(config)
      expect(readFileSync(staleTmpPath, 'utf-8')).toBe('stale-content-from-crashed-writer')
      const leftovers = readdirSync(TMP_DATA_DIR).filter((name) => name.includes('.tmp'))
      expect(leftovers).toEqual([staleTmpName])
      // 清掉手动构造的残留，不污染同目录后续用例的 leftovers 断言
      rmSync(staleTmpPath, { force: true })
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

  describe('isValidRemoteAccessConfig（结构检查）', () => {
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
});
