/**
 * 四级恢复阶梯测试（U3 验收④；设计 §4 场景 1a 变体 W1/W2 配对断言形态）。
 *
 * 双趟口径（D3 源级双跑）：同一断言集 node/bun 各跑一遍。驱动不对称面（F22/F24）
 * 在断言内显式分叉——「静息态直开必 CANTOPEN」是 bun 特有事实，node 趟断言其
 * 不对称半边（直开成功但创建 -shm/-wal），bun 趟（U5）断言 CANTOPEN 半边。
 */

import { describe, expect, it } from 'vitest'
import { chmodSync, existsSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  SNAPSHOT_TMP_PREFIX,
  SqliteUnreadableError,
  countSnapshotDirs,
  openViaSnapshot,
  openWithRecovery,
} from '../recovery.ts'
import { loadSqliteDriver, toSqliteFileUri } from '../sqlite-driver.ts'
import {
  buildFixtureDb,
  defaultTranscriptSeeds,
  dirSnapshot,
  isBun,
  makeFixtureDir,
  openWritableSqlite,
  quiesceDir,
} from './helpers.ts'

const TOTAL_ROWS = 3 // 建库 2 行（sess_fix_a/​sess_fix_b）+ 1 条只存在于 -wal 的行（WALROW-PROOF）

/**
 * W1 构造：写多行 → wal_autocheckpoint=0 保持写连接（数据留 -wal）→ 快照 -wal
 * 留证 → clean close（checkpoint 完成）→ 静息态。返回建库行数与 wal 留证字节数。
 */
async function buildWalLadderFixture(dir: string): Promise<{ dbPath: string; walSizeDuringWrite: number }> {
  const fixture = await buildFixtureDb(dir, defaultTranscriptSeeds())
  const writer = await openWritableSqlite(fixture.dbPath)
  writer.exec('PRAGMA wal_autocheckpoint=0')
  writer
    .prepare('INSERT INTO session (id, directory, title, task_type, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)')
    .run('s-wal-only', '/tmp/wal', 'WALROW-PROOF', 'interactive', 1, 2)
  const walSizeDuringWrite = statSync(`${fixture.dbPath}-wal`).size
  expect(walSizeDuringWrite).toBeGreaterThan(0) // 留证：这行确实只写进 -wal 未 checkpoint
  writer.close() // clean close：checkpoint 完成、附属文件被删
  quiesceDir(dir)
  expect(dirSnapshot(dir)).toEqual(['db.sqlite']) // 静息态前置确认
  return { dbPath: fixture.dbPath, walSizeDuringWrite }
}

describe('W1 恢复路径配对断言（静息态库：-wal 缺失）', () => {
  it('① 不走恢复直开：bun 必失败（CANTOPEN 形态）/ node 成功但创建附属文件（F24 不对称另一半）', async () => {
    const fx = makeFixtureDir('zss-w1-direct-')
    try {
      const { dbPath } = await buildWalLadderFixture(fx.root)
      const driver = await loadSqliteDriver()
      if (isBun) {
        // bun 特有断言（F22）：-wal 缺失直开必然 CANTOPEN，目录可写也失败
        expect(() => driver.open(dbPath, { readOnly: true })).toThrow()
      } else {
        // node 侧不对称半边（F24）：直开成功且创建 -shm/-wal（close 后残留）——
        // 这是恢复阶梯要消除的宿主目录副作用面
        const ro = driver.open(dbPath, { readOnly: true })
        ro.prepare('SELECT COUNT(*) AS c FROM session').get()
        ro.close()
        expect(existsSync(`${dbPath}-shm`) || existsSync(`${dbPath}-wal`)).toBe(true)
        quiesceDir(fx.root)
        expect(dirSnapshot(fx.root)).toEqual(['db.sqlite'])
      }
    } finally {
      fx.cleanup()
    }
  })

  it('② 走 L2 immutable 逃逸：读到全部行（含曾只在 -wal 的行，对照留证）', async () => {
    const fx = makeFixtureDir('zss-w1-imm-')
    try {
      const { dbPath, walSizeDuringWrite } = await buildWalLadderFixture(fx.root)
      expect(walSizeDuringWrite).toBeGreaterThan(0) // 对照留证在位

      const driver = await loadSqliteDriver()
      const before = dirSnapshot(fx.root)
      const snapshotsBefore = countSnapshotDirs()
      const ro = driver.open(toSqliteFileUri(dbPath, true), { readOnly: true })
      try {
        const count = ro.prepare('SELECT COUNT(*) AS c FROM session').get() as Record<string, unknown>
        expect(Number(count['c'])).toBe(TOTAL_ROWS)
        const proof = ro.prepare("SELECT title FROM session WHERE id = 's-wal-only'").get() as
          | Record<string, unknown>
          | undefined
        expect(proof?.['title']).toBe('WALROW-PROOF')
      } finally {
        ro.close()
      }
      // ③ 零拷贝、零 -shm/-wal 创建（immutable 定义性质；快照计数用差分——
      // 不假设 tmpdir 初始无残留）
      expect(dirSnapshot(fx.root)).toEqual(before)
      expect(countSnapshotDirs()).toBe(snapshotsBefore)
    } finally {
      fx.cleanup()
    }
  })
})

describe('W2 两态断言（-wal 在场）', () => {
  it('① 写者打开 + -wal 有内容未 checkpoint：直开成功直接读（不开快照、不触发 L3）', async () => {
    const fx = makeFixtureDir('zss-w2-live-')
    try {
      const fixture = await buildFixtureDb(fx.root, defaultTranscriptSeeds())
      const writer = await openWritableSqlite(fixture.dbPath)
      try {
        writer.exec('PRAGMA wal_autocheckpoint=0')
        writer
          .prepare('INSERT INTO session (id, directory, title, task_type, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)')
          .run('s-w2', '/tmp/w2', 'LIVE-WAL-ROW', 'interactive', 1, 2)
        expect(statSync(`${fixture.dbPath}-wal`).size).toBeGreaterThan(0)
        const snapshotsBefore = countSnapshotDirs()

        const opened = await openWithRecovery(fixture.dbPath)
        try {
          // 双端一致（F22：写者活跃 + -wal 有内容可开且读到已提交行）
          expect(opened.via).toBe('L1-direct')
          const count = opened.db.prepare('SELECT COUNT(*) AS c FROM session').get() as Record<string, unknown>
          expect(Number(count['c'])).toBe(TOTAL_ROWS)
        } finally {
          opened.dispose()
        }
        // 未触发 L3（快照计数差分为零；via 已断言 L1——结构上到不了 L3）
        expect(countSnapshotDirs()).toBe(snapshotsBefore)
      } finally {
        writer.close()
      }
    } finally {
      fx.cleanup()
    }
  })

  it('② 直开失败 ∧ -wal 在场（db 无读权限）：落错误面而绝不触发拷贝/immutable', async () => {
    const fx = makeFixtureDir('zss-w2-gate-')
    try {
      const fixture = await buildFixtureDb(fx.root, defaultTranscriptSeeds())
      const writer = await openWritableSqlite(fixture.dbPath)
      try {
        writer.exec('PRAGMA wal_autocheckpoint=0')
        writer
          .prepare('INSERT INTO session (id, directory, title, task_type, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)')
          .run('s-w2g', '/tmp/w2g', 'GATED', 'interactive', 1, 2)
        const before = dirSnapshot(fx.root)
        const snapshotsBefore = countSnapshotDirs()

        chmodSync(fixture.dbPath, 0o000) // 直开失败（EACCES → CANTOPEN），-wal 在场
        let caught: unknown
        try {
          await openWithRecovery(fixture.dbPath)
        } catch (err) {
          caught = err
        }
        expect(caught).toBeInstanceOf(SqliteUnreadableError)
        const err = caught as SqliteUnreadableError
        // L2/L3 被门控跳过（不入 attempted）；门控原因进 message
        expect(err.attempted).toEqual(['L1-direct'])
        expect(err.message).toContain('-wal present')
        // 绝不触发任何拷贝
        expect(countSnapshotDirs()).toBe(snapshotsBefore)
        expect(dirSnapshot(fx.root)).toEqual(before)

        chmodSync(fixture.dbPath, 0o644)
      } finally {
        chmodSync(fixture.dbPath, 0o644)
        writer.close()
      }
    } finally {
      fx.cleanup()
    }
  })
})

describe('阶梯编排（openWithRecovery）', () => {
  it('静息态合法库：node 命中 L1 直开 / bun 命中 L2 immutable（驱动不对称的编排分叉）', async () => {
    const fx = makeFixtureDir('zss-ladder-')
    try {
      await buildFixtureDb(fx.root, defaultTranscriptSeeds(), { quiesce: true })
      const snapshotsBefore = countSnapshotDirs()
      const opened = await openWithRecovery(join(fx.root, 'db.sqlite'))
      try {
        expect(opened.via).toBe(isBun ? 'L2-immutable' : 'L1-direct')
        const count = opened.db.prepare('SELECT COUNT(*) AS c FROM message').get() as Record<string, unknown>
        expect(Number(count['c'])).toBe(4)
      } finally {
        opened.dispose()
      }
      if (!isBun) {
        // node L1 直开会在宿主目录留 -shm/-wal 残留（F24），dispose 不负责清理宿主
        // 附属（那是只读连接的驱动行为，§3.5「-shm 创建面」已披露）——此处仅确认
        // 快照路径零产物
      }
      expect(countSnapshotDirs()).toBe(snapshotsBefore)
    } finally {
      fx.cleanup()
    }
  })

  it('L1→L2→L3 全链失败（损坏文件）：L4 错误面 attempted 全记录、无快照残留', async () => {
    const fx = makeFixtureDir('zss-ladder-corrupt-')
    try {
      const dbPath = join(fx.root, 'db.sqlite')
      writeFileSync(dbPath, 'definitely not a sqlite database'.repeat(10))
      const snapshotsBefore = countSnapshotDirs()

      let caught: unknown
      try {
        await openWithRecovery(dbPath)
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(SqliteUnreadableError)
      const err = caught as SqliteUnreadableError
      // node:sqlite 打开惰性（open 成功、probe 抛 NOTADB）→ L1 失败进 attempted；
      // -wal 不在 → L2 probe 失败；L3 拷贝后 probe 仍失败 → 全链记录
      expect(err.attempted).toEqual(['L1-direct', 'L2-immutable', 'L3-snapshot'])
      expect(err.message).toContain('recovery ladder exhausted')
      // L3 失败路径 finally 清理：快照目录不残留
      expect(countSnapshotDirs()).toBe(snapshotsBefore)
    } finally {
      fx.cleanup()
    }
  })

  it('db 不存在：L4 错误面（存在性由消费方先行检查，此处以 unreadable 兜底）', async () => {
    const fx = makeFixtureDir('zss-ladder-missing-')
    try {
      let caught: unknown
      try {
        await openWithRecovery(join(fx.root, 'absent.sqlite'))
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(SqliteUnreadableError)
    } finally {
      fx.cleanup()
    }
  })
})

describe('L3 快照兜底（单级）', () => {
  it('成功：db 拷贝 + 自建 0 字节 -wal → 表集合验证 → 行可读；收尾删除快照目录', async () => {
    const fx = makeFixtureDir('zss-l3-ok-')
    try {
      await buildFixtureDb(fx.root, defaultTranscriptSeeds(), { quiesce: true })
      const dbPath = join(fx.root, 'db.sqlite')
      const snapshotsBefore = countSnapshotDirs()

      const snap = await openViaSnapshot(dbPath)
      expect(snap.snapshotDir.split('/').pop()).toMatch(new RegExp(`^${SNAPSHOT_TMP_PREFIX}`))
      // 拷贝集唯一定义：db + 自建 0 字节 -wal（-shm 永不进拷贝集）
      const count = snap.db.prepare('SELECT COUNT(*) AS c FROM session').get() as Record<string, unknown>
      expect(Number(count['c'])).toBe(2)
      const walSize = statSync(`${join(snap.snapshotDir, 'db.sqlite')}-wal`).size
      expect(walSize).toBe(0)

      snap.db.close()
      const { rmSync } = await import('node:fs')
      rmSync(snap.snapshotDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      expect(countSnapshotDirs()).toBe(snapshotsBefore)
    } finally {
      fx.cleanup()
    }
  })

  it('表集合验证失败（损坏拷贝）：报错且快照目录读后即清', async () => {
    const fx = makeFixtureDir('zss-l3-bad-')
    try {
      const dbPath = join(fx.root, 'db.sqlite')
      writeFileSync(dbPath, 'garbage garbage garbage'.repeat(8))
      const snapshotsBefore = countSnapshotDirs()

      let caught: unknown
      try {
        await openViaSnapshot(dbPath)
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(Error)
      expect((caught as Error).message).not.toContain('size gate')
      // 失败路径清理（openViaSnapshot 内 catch 分支）：快照目录已删
      expect(countSnapshotDirs()).toBe(snapshotsBefore)
    } finally {
      fx.cleanup()
    }
  })

  it('规模门：db > 256MB 拒拷（错误面 + 零目录创建）', async () => {
    const fx = makeFixtureDir('zss-l3-gate-')
    try {
      const dbPath = join(fx.root, 'big.sqlite')
      writeFileSync(dbPath, '')
      truncateSync(dbPath, 300 * 1024 * 1024) // 稀疏文件：truncate 即得，0ms 级
      const snapshotsBefore = countSnapshotDirs()

      let caught: unknown
      try {
        await openViaSnapshot(dbPath)
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(SqliteUnreadableError)
      expect((caught as Error).message).toContain('size gate')
      expect(countSnapshotDirs()).toBe(snapshotsBefore)

      const { unlinkSync } = await import('node:fs')
      unlinkSync(dbPath)
    } finally {
      fx.cleanup()
    }
  })
})
