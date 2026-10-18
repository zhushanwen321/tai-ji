/**
 * atomicWriteJsonFile（main 侧 JSON 落盘原子写单一助手）单测。
 *
 * 固定的契约（MF-1-9 验收：三套写纪律收敛为单一助手后的机械可验证行为）：
 * - 成功路径：目标文件内容 = JSON.stringify(data, null, 2) + 尾换行；无 tmp 残留；
 *   嵌套父目录自动创建（update/ 子目录场景）
 * - mode 生效：opts.mode 0o600 → 最终文件权限精确 0600（chmodSync 兜底，不受
 *   umask 影响——writeFileSync 的 mode 受 umask 掩码，chmod 归位后才可断言精确值）
 * - rename 失败（如目标被目录占用）→ tmp 清理 + 原样上抛，目标保持旧内容
 * - fsync 档：对真实文件 fd 调用 fsyncSync 且先于 rename（失败注入时目标保持
 *   旧内容、tmp 被清理）；缺省档不调用 fsyncSync
 *
 * mock 策略对齐 remote-access-store-fsync.test.ts 先例：vi.mock('node:fs') 以
 * importOriginal 透传全部真实实现、仅包装 renameSync / fsyncSync（可计数 / 可注入
 * 失败）——除被包装函数外全部真实 fs 形态。
 *
 * 文件 IO 全落 mkdtemp tmp 自建自删（测试红线：禁触真实数据目录）。
 *
 * 运行：cd apps/electron/main && npx vitest run test/atomic-write-json.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, rmSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { atomicWriteJsonFile } from '../utils/atomic-write-json.js'
// vi.fn 包装后的实例（与 atomic-write-json.ts 拿到的是同一 mock 模块图实例）
import { fsyncSync, renameSync } from 'node:fs'

/** fsync 调用记录 + 真实 renameSync 句柄（vi.hoisted：mock 工厂提升后仍可写） */
const hoisted = vi.hoisted(() => ({
  fsyncCalls: [] as Array<{ isFile: boolean }>,
  realRenameSync: null as null | ((from: string, to: string) => void),
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  hoisted.realRenameSync = actual.renameSync
  return {
    ...actual,
    fsyncSync: vi.fn((fd: number): void => {
      hoisted.fsyncCalls.push({ isFile: actual.fstatSync(fd).isFile() })
      actual.fsyncSync(fd)
    }),
    renameSync: vi.fn((from: string, to: string) => hoisted.realRenameSync?.(from, to)),
  }
})

const TMP_DIR = mkdtempSync(join(tmpdir(), 'atomic-write-json-'))

afterAll(() => {
  rmSync(TMP_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

/** 目录内以 .tmp 结尾的文件名清单（孤儿 tmp 残留断言用） */
function tmpResidues(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.endsWith('.tmp'))
}

beforeEach(() => {
  // mockClear 只清调用记录不清基座实现（mockImplementationOnce 自动消费，无需重置）
  hoisted.fsyncCalls.length = 0
  vi.mocked(fsyncSync).mockClear()
  vi.mocked(renameSync).mockClear()
})

describe('atomicWriteJsonFile 成功路径', () => {
  it('内容 = JSON.stringify(data, null, 2) + 尾换行；无 tmp 残留', () => {
    const filePath = join(TMP_DIR, 'a.json')
    atomicWriteJsonFile(filePath, { x: 1, nested: { y: [1, 2] } })
    expect(readFileSync(filePath, 'utf-8')).toBe(JSON.stringify({ x: 1, nested: { y: [1, 2] } }, null, 2) + '\n')
    expect(tmpResidues(TMP_DIR)).toEqual([])
  })

  it('嵌套父目录自动创建（update/ 子目录落盘场景）', () => {
    const filePath = join(TMP_DIR, 'deep', 'nested', 'b.json')
    atomicWriteJsonFile(filePath, { ok: true })
    expect(JSON.parse(readFileSync(filePath, 'utf-8'))).toEqual({ ok: true })
  })

  it('缺省档不调用 fsyncSync（update 三文件的轻量写形态）', () => {
    atomicWriteJsonFile(join(TMP_DIR, 'c.json'), { a: 1 })
    expect(hoisted.fsyncCalls.length).toBe(0)
  })
})

describe('atomicWriteJsonFile mode 档', () => {
  it('opts.mode 0o600 → 最终文件权限精确 0600（chmodSync 兜底，不受 umask 掩码）', () => {
    const filePath = join(TMP_DIR, 'secret.json')
    atomicWriteJsonFile(filePath, { token: 't' }, { mode: 0o600 })
    expect(statSync(filePath).mode & 0o777).toBe(0o600)
  })

  it('对已存在且权限漂移的文件重写 → 权限归位 0600（mode 兜底段的意义）', () => {
    const filePath = join(TMP_DIR, 'drift.json')
    writeFileSync(filePath, '{}', 'utf-8')
    atomicWriteJsonFile(filePath, { token: 't' }, { mode: 0o600 })
    expect(statSync(filePath).mode & 0o777).toBe(0o600)
  })
})

describe('atomicWriteJsonFile 失败路径（tmp 清理 + 目标保持旧内容）', () => {
  it('rename 失败 → tmp 被清理、原样上抛，目标文件保持旧内容', () => {
    const filePath = join(TMP_DIR, 'keep-old.json')
    writeFileSync(filePath, 'old content', 'utf-8')
    vi.mocked(renameSync).mockImplementationOnce(() => {
      throw new Error('EPERM: rename failed (simulated)')
    })
    expect(() => atomicWriteJsonFile(filePath, { newer: true })).toThrow(/EPERM/)
    expect(readFileSync(filePath, 'utf-8')).toBe('old content')
    expect(tmpResidues(TMP_DIR)).toEqual([])
  })

  it('fsync 失败（掉电前兆形态）→ 上抛中止不 rename，目标保持旧内容且 tmp 被清理', () => {
    const filePath = join(TMP_DIR, 'fsync-fail.json')
    writeFileSync(filePath, 'old content', 'utf-8')
    vi.mocked(fsyncSync).mockImplementationOnce(() => {
      throw new Error('EIO: fsync failed (simulated power-loss precursor)')
    })
    expect(() => atomicWriteJsonFile(filePath, { newer: true }, { fsync: true })).toThrow(/EIO/)
    expect(readFileSync(filePath, 'utf-8')).toBe('old content')
    expect(tmpResidues(TMP_DIR)).toEqual([])
  })
})

describe('atomicWriteJsonFile fsync 档', () => {
  it('fsync 档对真实文件 fd 调用 fsyncSync（防实现回退丢失该段）', () => {
    atomicWriteJsonFile(join(TMP_DIR, 'd.json'), { a: 1 }, { fsync: true })
    expect(hoisted.fsyncCalls.length).toBeGreaterThanOrEqual(1)
    expect(hoisted.fsyncCalls.every((call) => call.isFile)).toBe(true)
  })
})
