import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { RecentWorkspacesStore } from '../recent-workspaces-store.js'
import { atomicWrite } from '../../../utils/fs-utils.js'
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 本文件另为 recent-workspaces-store 合并载体（test 根同名文件折叠为分节）。
/**
 * RecentWorkspacesStore pin 语义测试（2026-10-22「pin 固定目录」需求）。
 *
 * 覆盖：setPinned 翻转 / pinned 豁免 LRU 淘汰（INV-6）/ 未 pinned 区独立上限（MAX_RECORDS=6）/
 * pin 上限 MAX_PINNED=5 拒绝 / list() 两区排序（pinned 置前，组内 lastUsedAt 倒序）。
 *
 * 运行命令：cd packages/runtime && pnpm test -- recent-workspaces-store
 */

let configDir: string

function makeStore(): RecentWorkspacesStore {
  return new RecentWorkspacesStore(configDir)
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'recent-workspaces-test-'))
})

afterEach(() => {
  // maxRetries：teardown 递归删除与在途异步写竞争时一次瞬态失败即抛（ENOTEMPTY flake，
  // 教训 commit d9ad39cb）——rmSync 默认 maxRetries=0，显式带重试。
  rmSync(configDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

describe('RecentWorkspacesStore pin 语义', () => {
  it('setPinned 翻转 pinned 标记，list() 中 pinned 条目置前', () => {
    const store = makeStore()
    store.record('/a')
    store.record('/b')

    expect(store.setPinned('/b', true)).toBe(true)
    expect(store.list().map((r) => r.cwd)).toEqual(['/b', '/a'])
    expect(store.list()[0].pinned).toBe(true)

    expect(store.setPinned('/b', false)).toBe(true)
    // unpin 后回到最近使用排序（两 record 同毫秒时序不稳定，只断言成员与 pinned 清除）
    const after = store.list()
    expect(after.map((r) => r.cwd).sort()).toEqual(['/a', '/b'])
    expect(after.every((r) => !r.pinned)).toBe(true)
  })

  it('pinned 条目豁免 LRU 淘汰：record 7 条后未 pinned 的最新 6 条保留，pinned 恒在', () => {
    const store = makeStore()
    // pin 最旧的条目
    store.record('/pinned-old')
    store.record('/r1')
    store.setPinned('/pinned-old', true)
    // 再 record 6 条（总未 pinned 条数达 7 > 6 → 淘汰未 pinned 最旧者 /r1）
    for (const cwd of ['/r2', '/r3', '/r4', '/r5', '/r6', '/r7']) store.record(cwd)

    const cwds = store.list().map((r) => r.cwd)
    expect(cwds).toContain('/pinned-old') // pinned 豁免淘汰
    expect(cwds).not.toContain('/r1') // 未 pinned 最旧者被淘汰
    expect(cwds).toContain('/r7') // 未 pinned 最新者保留
    expect(store.list().filter((r) => !r.pinned)).toHaveLength(6) // 未 pinned 区保持 ≤6
  })

  it('未 pinned 区独立上限：pinned 条目不挤占最近区名额', () => {
    const store = makeStore()
    // pin 5 条（达上限）
    for (let i = 0; i < 5; i++) {
      store.record(`/p${i}`)
      store.setPinned(`/p${i}`, true)
    }
    // 最近区 record 6 条
    for (let i = 0; i < 6; i++) store.record(`/r${i}`)

    const list = store.list()
    expect(list.filter((r) => r.pinned)).toHaveLength(5)
    expect(list.filter((r) => !r.pinned)).toHaveLength(6)
    expect(list[0].pinned).toBe(true) // pinned 置前
  })

  it('pin 上限 5：第 6 个 pin 拒绝（返回 false，列表不变）', () => {
    const store = makeStore()
    for (let i = 0; i < 5; i++) {
      store.record(`/p${i}`)
      expect(store.setPinned(`/p${i}`, true)).toBe(true)
    }
    store.record('/r0')
    expect(store.setPinned('/r0', true)).toBe(false)
    expect(store.list().find((r) => r.cwd === '/r0')?.pinned).toBeFalsy()
  })

  it('setPinned 条目不存在 → no-op 生效（返回 true，不抛）', () => {
    const store = makeStore()
    expect(store.setPinned('/not-exist', true)).toBe(true)
    expect(store.list()).toHaveLength(0)
  })

  it('record 已 pinned 条目保留 pinned 标记（合并写，重录不因 set 整值替换失固定）', () => {
    const store = makeStore()
    store.record('/a')
    store.record('/b')
    expect(store.setPinned('/a', true)).toBe(true)

    // 用户再次选用已固定目录：record 刷新 lastUsedAt/label，pinned 标记不被抹掉
    store.record('/a')

    const again = store.list().find((r) => r.cwd === '/a')
    expect(again?.pinned).toBe(true)
    expect(again?.label).toBe('a')
    expect(store.list()[0].cwd).toBe('/a') // pinned 置前
  })
})

// ════════════════ 来源: recent-workspaces-store.test.ts ════════════════

describe('recent-workspaces-store', () => {
  // Mock fs-utils atomicWrite to count writes
  vi.mock('../../../utils/fs-utils.js', () => ({
    atomicWrite: vi.fn(),
  }))

  // Mock fs to control readFileSync / existsSync / mkdirSync
  vi.mock('node:fs', async () => {
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
    return {
      ...actual,
      readFileSync: vi.fn(),
      existsSync: vi.fn(),
      mkdirSync: vi.fn(),
    }
  })


  const mockedAtomicWrite = vi.mocked(atomicWrite)
  const mockedReadFileSync = vi.mocked(readFileSync)
  const mockedExistsSync = vi.mocked(existsSync)
  const mockedMkdirSync = vi.mocked(mkdirSync)

  const TEST_CONFIG_DIR = '/home/user/.taiji'

  describe('RecentWorkspacesStore', () => {
    let store: RecentWorkspacesStore

    beforeEach(() => {
      vi.useFakeTimers()
      vi.clearAllMocks()
      // 默认：文件不存在（首启场景）
      mockedExistsSync.mockReturnValue(false)
      mockedReadFileSync.mockImplementation(() => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      })
      store = new RecentWorkspacesStore(TEST_CONFIG_DIR)
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    // ── T1.1: record 3 个 cwd → list 返 3 条倒序 ──────────────────

    it('T1.1: record 3 cwd → list returns 3 records in reverse order', () => {
      store.record('/project/a')
      vi.advanceTimersByTime(10)
      store.record('/project/b')
      vi.advanceTimersByTime(10)
      store.record('/project/c')

      const list = store.list()
      expect(list).toHaveLength(3)
      // 倒序：最新的在前
      expect(list[0].cwd).toBe('/project/c')
      expect(list[1].cwd).toBe('/project/b')
      expect(list[2].cwd).toBe('/project/a')
      expect(list[0].label).toBe('c')
      expect(list[1].label).toBe('b')
      expect(list[2].label).toBe('a')
    })

    // ── T1.2: MAX_RECORDS=6 后，7 个 cwd → 淘汰最旧保 6（INV-2，W1 改 10→6）──────────────────

    it('T1.2: 7 cwd → evicts oldest, keeps 6 (INV-2, W1 MAX_RECORDS 10→6)', () => {
      for (let i = 1; i <= 7; i++) {
        store.record(`/project/dir-${i}`)
        vi.advanceTimersByTime(10)
      }

      const list = store.list()
      expect(list).toHaveLength(6)
      // 最旧的 dir-1 被淘汰
      expect(list.find(r => r.cwd === '/project/dir-1')).toBeUndefined()
      // 最新的 dir-7 在首位
      expect(list[0].cwd).toBe('/project/dir-7')
    })

    // ── T1.3: 同 cwd 多次 → 不重复（INV-3）───────────────────────

    it('T1.3: same cwd recorded multiple times → no duplicate (INV-3)', () => {
      store.record('/project/same')
      vi.advanceTimersByTime(10)
      store.record('/project/same')
      vi.advanceTimersByTime(10)
      store.record('/project/other')
      vi.advanceTimersByTime(10)
      store.record('/project/same')

      const list = store.list()
      expect(list).toHaveLength(2)
      // 更新后的 same 在首位
      expect(list[0].cwd).toBe('/project/same')
      expect(list[1].cwd).toBe('/project/other')
    })

    // ── T1.4: cwd 空串静默跳过（INV-1 双层检查）───────────────────

    it('T1.4: empty string cwd silently skipped (INV-1)', () => {
      store.record('')
      store.record('   ')

      expect(store.list()).toHaveLength(0)
    })

    // ── T1.5: 文件不存在首启 → list 返 [] 不抛 ────────────────────

    it('T1.5: file not exist on first launch → list returns [] no throw', () => {
      expect(() => store.list()).not.toThrow()
      expect(store.list()).toEqual([])
    })

    // ── T1.6: 文件损坏非法 JSON → list 返 []（INV-4）───────────────

    it('T1.6: corrupt JSON file → list returns [] (INV-4)', () => {
      mockedReadFileSync.mockReturnValue('not-valid-json{{{')
      mockedExistsSync.mockReturnValue(true)
      // 新建 store 触发 loadPartition
      const corruptStore = new RecentWorkspacesStore(TEST_CONFIG_DIR)
      expect(() => corruptStore.list()).not.toThrow()
      expect(corruptStore.list()).toEqual([])
    })

    // ── T1.7: debounce：record N 次 advance 500ms → atomicWrite 1 次 ─

    it('T1.7: debounce: record N times + advance 500ms → atomicWrite called', () => {
      store.record('/project/a')
      store.record('/project/b')
      store.record('/project/c')

      // debounce 尚未触发
      expect(mockedAtomicWrite).not.toHaveBeenCalled()

      // advance 500ms 触发 flush
      vi.advanceTimersByTime(500)

      // atomicWrite 被调用
      expect(mockedAtomicWrite).toHaveBeenCalled()
      const callCount = mockedAtomicWrite.mock.calls.length

      // 再 advance 不会额外写入（dirty 已清）
      vi.advanceTimersByTime(1000)
      expect(mockedAtomicWrite).toHaveBeenCalledTimes(callCount)
    })

    // ── T1.8: INV-5 路径含 configDir，无硬编码 ────────────────────

    it('T1.8: file path derived from configDir, no hardcoded path (INV-5)', () => {
      store.record('/project/test')
      vi.advanceTimersByTime(500)

      // atomicWrite 应使用 configDir 拼接的路径
      const expectedPath = join(TEST_CONFIG_DIR, 'recent-workspaces.json')
      expect(mockedAtomicWrite).toHaveBeenCalledWith(
        expectedPath,
        expect.any(String),
      )
    })

    it('T1.8b: different configDir → different file path', () => {
      const otherConfigDir = '/tmp/other-config'
      const otherStore = new RecentWorkspacesStore(otherConfigDir)
      otherStore.record('/project/test')
      vi.advanceTimersByTime(500)

      const expectedPath = join(otherConfigDir, 'recent-workspaces.json')
      expect(mockedAtomicWrite).toHaveBeenCalledWith(
        expectedPath,
        expect.any(String),
      )
    })

    // ── W1: persistToFile 用 dirname 推导目录（非手写 substring），修复 Windows 路径 bug ──

    it('W1: persistToFile 用 dirname 推导目录，mkdirSync 收到 configDir 而非空串', () => {
      // existsSync 返 false → persistToFile 走 mkdirSync 分支
      mockedExistsSync.mockReturnValue(false)
      store.record('/project/test')
      vi.advanceTimersByTime(500)

      // dirname(join(configDir, 'recent-workspaces.json')) === configDir
      // 修复前用 substring(0, lastIndexOf('/')) 在 Windows 下得空串
      expect(mockedMkdirSync).toHaveBeenCalledWith(TEST_CONFIG_DIR, { recursive: true })
    })

    // ── W1: loadFromFile 文件损坏（非 ENOENT）→ quarantine 隔离（D1c 对齐，非静默）──

    it('W1: loadFromFile 文件损坏时 quarantine 隔离 + error 日志（非静默、非覆盖）', () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      mockedReadFileSync.mockReturnValue('not-valid-json{{{')
      mockedExistsSync.mockReturnValue(true)

      const corruptStore = new RecentWorkspacesStore(TEST_CONFIG_DIR)
      corruptStore.list()

      // fail-soft 非 fail-silent：quarantineCorruptFile 的隔离日志（error 级）替代旧 warn
      expect(errSpy).toHaveBeenCalledTimes(1)
      const msg = String(errSpy.mock.calls[0]!.join(' '))
      expect(msg).toContain('损坏隔离') // 成功（已隔离至）/ 失败（隔离失败）分支都命中

      errSpy.mockRestore()
    })

    it('W1: loadFromFile ENOENT（首启）静默不 warn', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      // 默认 beforeEach 已是 ENOENT 场景
      const freshStore = new RecentWorkspacesStore(TEST_CONFIG_DIR)
      freshStore.list()

      expect(warnSpy).not.toHaveBeenCalled()

      warnSpy.mockRestore()
    })

    // 注：以下这条为 flushAll 的「行为测试」，不占用 NFR 用例 ID。
    // T1.10（数据目录与 pi 隔离）与 T1.11（atomicWrite 原子性）属于 integration(real)
    // NFR 测试，见 recent-workspaces-real.test.ts（用真实文件系统验证）。

    it('flushAll: persists immediately without waiting for debounce', () => {
      store.record('/project/a')
      store.record('/project/b')

      expect(mockedAtomicWrite).not.toHaveBeenCalled()

      store.flushAll()

      expect(mockedAtomicWrite).toHaveBeenCalled()
    })

    // ── W1（MAX_RECORDS 改 6）：边界用例 ─────────────────────────

    it('W1: 6 cwd → keeps all 6（恰达上限不淘汰）', () => {
      for (let i = 1; i <= 6; i++) {
        store.record(`/project/dir-${i}`)
        vi.advanceTimersByTime(10)
      }

      const list = store.list()
      expect(list).toHaveLength(6)
      // 全部保留（dir-1..dir-6），无一淘汰
      expect(list.find(r => r.cwd === '/project/dir-1')).toBeTruthy()
      expect(list.find(r => r.cwd === '/project/dir-6')).toBeTruthy()
    })

    it('W1: 8 cwd → keeps 6（超过上限即淘汰最旧两个，INV-2）', () => {
      for (let i = 1; i <= 8; i++) {
        store.record(`/project/dir-${i}`)
        vi.advanceTimersByTime(10)
      }

      const list = store.list()
      expect(list).toHaveLength(6)
      // 最旧的 dir-1、dir-2 被淘汰
      expect(list.find(r => r.cwd === '/project/dir-1')).toBeUndefined()
      expect(list.find(r => r.cwd === '/project/dir-2')).toBeUndefined()
      // dir-3..dir-8 保留，dir-8 最新在首位
      expect(list[0].cwd).toBe('/project/dir-8')
    })
  })
})
