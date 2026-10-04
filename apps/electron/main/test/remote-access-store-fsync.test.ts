/**
 * remote-access store 原子写 fsync 段单测（掉电半写防护）。
 *
 * writeRemoteAccessConfig 在 rename 前对 `.tmp` 的 fd 做 fsyncSync：writeFileSync
 * 返回 ≠ 数据已落盘（page cache 异步刷写），掉电时 rename 可能先于数据刷写落定，
 * 留下内容为空的「完整」新文件（runtime 热读侧拿到合法 JSON 但 token 为空）。
 *
 * fsync 的持久性效果无法在单测直接断言（模拟掉电不现实），本文件断言的是可机械
 * 验证的契约面：
 * - 写路径确实对真实文件 fd 调用了 fsyncSync（防实现回退丢失该段）；
 * - fsyncSync 失败（掉电前兆形态）→ 写入裸抛中止，不 rename 可能半写的文件，
 *   目标文件保持旧内容（同时钉死 fsync 先于 rename 的顺序——若顺序颠倒，fsync
 *   失败抛出时目标文件已是新内容，本用例即红）；
 * - fsync 段不破坏 0600 权限语义。
 *
 * mock 策略：vi.mock('node:fs') 以 importOriginal 透传全部真实实现、仅用 vi.fn
 * 包装 fsyncSync（可计数 / 可注入失败）——除 fsync 外全部真实 fs 形态，与 store
 * 测试的「真实形态优先」风格一致（vi.spyOn 对 node:fs ESM namespace 不可
 * redefine，故用模块级 mock）。
 *
 * 数据目录经 dataDir 参数注入 mkdtemp tmp 自建自删（测试红线：禁触真实数据目录）。
 *
 * 运行：cd apps/electron/main && npx vitest run test/remote-access-store-fsync.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REMOTE_ACCESS_FILENAME } from '@taiji/shared'
import { writeRemoteAccessConfig } from '../remote-access/store.js'
// vi.fn 包装后的 fsyncSync 实例（与 store.ts 拿到的是同一 mock 模块图实例，可注入失败）
import { fsyncSync } from 'node:fs'

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

  it('fsyncSync 失败（掉电前兆形态）→ 写入裸抛中止，不 rename 半写文件，目标文件保持旧内容（钉死 fsync 先于 rename）', () => {
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

  it('fsync 段不破坏 0600 权限语义（新建文件）', () => {
    writeRemoteAccessConfig(
      { enabled: false, token: 'd'.repeat(64), createdAt: '2026-01-01T00:00:00.000Z' },
      TMP_DATA_DIR,
    )
    if (process.platform !== 'win32') {
      expect(statSync(FILE_PATH).mode & 0o777).toBe(0o600)
    }
    expect(existsSync(FILE_PATH)).toBe(true)
  })
})
