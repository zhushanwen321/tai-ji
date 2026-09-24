/**
 * 错误契约路径测试（2026-09-23 review round 1 MF-1-25 补齐——lcov 实测 sqlite-access
 * 14/79 + recovery 8/80 未覆盖的错误分支）：
 *
 * - `parseRowData` 三段 throw 的缺测两段（非 string / 解析后非对象；「非法 JSON」段已由
 *   access.test.ts「data 列非法 JSON」用例覆盖）——schema 漂移映射的上游契约：不在本层
 *   静默跳过（整行丢失会破坏切段配对），错误上下文带表与行标识；
 * - `candidatesByteSize` 行守卫（bytes 非 number → warn 留痕 + 跳过——消费端以 null 语义
 *   呈现「大小未知」，不回填 0 B 假数据，RT-5#10）；
 * - recovery 阶梯错误收尾契约（经 sqlite-driver 假驱动注入——真实驱动的 close 无法构造
 *   失败形态；probe / schema 行为按 sql 路由）：probe 失败先 close 再原样上抛（close
 *   错误吞掉、归因以探测错误为准）、closeQuietly 吞错（只读连接 close 失败不影响读取
 *   结果）、L3 表集合验证失败报错且快照目录读后即清、readSchemaVersion best-effort。
 *
 * 假驱动只在本文件生效（vi.mock 文件级）：fixture 用例（前两组 describe）走真实驱动
 * （slot 置空回退 actual.loadSqliteDriver）。
 */

import { describe, expect, it, vi, afterEach } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  SNAPSHOT_TMP_PREFIX,
  SqliteUnreadableError,
  countSnapshotDirs,
  openViaSnapshot,
  openWithRecovery,
} from '../recovery.ts'
import type { SqliteDb, SqliteDriver } from '../sqlite-driver.ts'
import { openZcodeSessionDb } from '../sqlite-access.ts'
import { checkpointAndClose, makeFixtureDir, openWritableSqlite } from './helpers.ts'

// ── 假驱动注入面（仅 recovery 错误收尾契约组使用；slot 为空 = 回退真实驱动）──────────

const fakeDriverSlot = vi.hoisted(() => ({ driver: null as SqliteDriver | null }))

vi.mock('../sqlite-driver.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../sqlite-driver.ts')>()
  return {
    ...actual,
    loadSqliteDriver: async () => fakeDriverSlot.driver ?? actual.loadSqliteDriver(),
  }
})

afterEach(() => {
  fakeDriverSlot.driver = null
  vi.restoreAllMocks()
})

/** 按 sql 路由的假连接：sqlite_master 探测 / schema_migration 版本 / 其余查询三分支。 */
interface RoutingOpts {
  /** sqlite_master 探测查询直接抛错（probe 失败形态） */
  masterThrows?: boolean
  /** sqlite_master 探测返回的表名行（默认空） */
  masterRows?: Array<{ name: string }>
  /** schema_migration 查询的延迟抛错开关（开库时须成功、读版本时失败） */
  schemaThrowsLater?: () => boolean
  /** schema_migration 返回行（默认 0.16.5） */
  schemaVersionRow?: unknown
  /** close() 抛错（closeQuietly / probe 失败收尾的吞错分支） */
  closeThrows?: boolean
}

function routingFakeDb(opts: RoutingOpts): SqliteDb {
  return {
    prepare(sql: string) {
      if (sql.includes('sqlite_master')) {
        if (opts.masterThrows) throw new Error('fake probe NOTADB')
        const rows = opts.masterRows ?? []
        return { all: () => rows, get: () => rows[0] }
      }
      if (sql.includes('schema_migration')) {
        if (opts.schemaThrowsLater?.()) throw new Error('fake schema read broken')
        const row = opts.schemaVersionRow ?? { app_version: '0.16.5' }
        return { all: () => [row], get: () => row }
      }
      return { all: () => [], get: () => undefined }
    },
    close() {
      if (opts.closeThrows) throw new Error('fake close broken')
    },
  }
}

function installFakeDriver(opts: RoutingOpts): void {
  const db = routingFakeDb(opts)
  fakeDriverSlot.driver = { id: 'fake-test-driver', open: () => db }
}

// ── parseRowData 三段 throw（fixture 真库 + 真实驱动）────────────────────────────

describe('parseRowData 错误契约（schema 漂移上游——不静默跳过，上下文带行标识）', () => {
  it('非 string（message data 为 BLOB 形态）：throw 列类型异常（期望 JSON 字符串）', async () => {
    const fx = makeFixtureDir('zss-ec-ns-')
    try {
      const writer = await openWritableSqlite(join(fx.root, 'db.sqlite'))
      writer.exec('CREATE TABLE session (id TEXT PRIMARY KEY)')
      writer.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, sequence INTEGER, data)')
      writer.exec('CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, sequence INTEGER, data)')
      writer.exec(
        'CREATE TABLE schema_migration (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, app_version TEXT, time_applied INTEGER NOT NULL)',
      )
      writer
        .prepare('INSERT INTO schema_migration (id, checksum, app_version, time_applied) VALUES (?, ?, ?, ?)')
        .run('0001', 'x', '0.16.5', 1)
      // fixture DDL 的 data 列无 NOT NULL，可绑 BLOB（Buffer）——typeof 读回非 string
      writer
        .prepare('INSERT INTO message (id, session_id, sequence, data) VALUES (?, ?, ?, ?)')
        .run('m-blob', 's1', 1, Buffer.from('raw-bytes'))
      checkpointAndClose(writer)

      const handle = await openZcodeSessionDb(join(fx.root, 'db.sqlite'))
      try {
        expect(() => handle.db.getSessionTranscript('s1')).toThrow(/message\(m-blob\)\.data 列类型异常（期望 JSON 字符串/)
      } finally {
        handle.dispose()
      }
    } finally {
      fx.cleanup()
    }
  })

  it('解析后非对象（message data 合法 JSON 数组）：throw 解析后非对象（实际 array）', async () => {
    const fx = makeFixtureDir('zss-ec-arr-')
    try {
      const writer = await openWritableSqlite(join(fx.root, 'db.sqlite'))
      writer.exec('CREATE TABLE session (id TEXT PRIMARY KEY)')
      writer.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, sequence INTEGER, data)')
      writer.exec('CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, sequence INTEGER, data)')
      writer.exec(
        'CREATE TABLE schema_migration (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, app_version TEXT, time_applied INTEGER NOT NULL)',
      )
      writer
        .prepare('INSERT INTO schema_migration (id, checksum, app_version, time_applied) VALUES (?, ?, ?, ?)')
        .run('0001', 'x', '0.16.5', 1)
      writer
        .prepare('INSERT INTO message (id, session_id, sequence, data) VALUES (?, ?, ?, ?)')
        .run('m-arr', 's1', 1, '[1,2]')
      checkpointAndClose(writer)

      const handle = await openZcodeSessionDb(join(fx.root, 'db.sqlite'))
      try {
        expect(() => handle.db.getSessionTranscript('s1')).toThrow(/message\(m-arr\)\.data 解析后非对象（实际 array）/)
      } finally {
        handle.dispose()
      }
    } finally {
      fx.cleanup()
    }
  })

  it('解析后非对象（part data 合法 JSON 字符串标量，part 调用点）：throw 解析后非对象（实际 string）', async () => {
    const fx = makeFixtureDir('zss-ec-str-')
    try {
      const writer = await openWritableSqlite(join(fx.root, 'db.sqlite'))
      writer.exec('CREATE TABLE session (id TEXT PRIMARY KEY)')
      writer.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, sequence INTEGER, data)')
      writer.exec('CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, sequence INTEGER, data)')
      writer.exec(
        'CREATE TABLE schema_migration (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, app_version TEXT, time_applied INTEGER NOT NULL)',
      )
      writer
        .prepare('INSERT INTO schema_migration (id, checksum, app_version, time_applied) VALUES (?, ?, ?, ?)')
        .run('0001', 'x', '0.16.5', 1)
      writer
        .prepare('INSERT INTO message (id, session_id, sequence, data) VALUES (?, ?, ?, ?)')
        .run('m-ok', 's1', 1, '{"role":"user"}')
      writer
        .prepare('INSERT INTO part (id, message_id, session_id, sequence, data) VALUES (?, ?, ?, ?, ?)')
        .run('p-str', 'm-ok', 's1', 0, '"scalar-string"')
      checkpointAndClose(writer)

      const handle = await openZcodeSessionDb(join(fx.root, 'db.sqlite'))
      try {
        expect(() => handle.db.getSessionTranscript('s1')).toThrow(/part\(message=m-ok\)\.data 解析后非对象（实际 string）/)
      } finally {
        handle.dispose()
      }
    } finally {
      fx.cleanup()
    }
  })
})

// ── candidatesByteSize 行守卫（fixture 真库 + 真实驱动）─────────────────────────

describe('candidatesByteSize 行守卫（bytes 非 number → warn 留痕 + 跳过）', () => {
  it('全 NULL part.data 组 SUM 返 NULL：该会话不入 Map（大小未知非 0 B）+ warn 留痕；健康会话照常', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fx = makeFixtureDir('zss-ec-bytes-')
    try {
      const writer = await openWritableSqlite(join(fx.root, 'db.sqlite'))
      writer.exec('CREATE TABLE session (id TEXT PRIMARY KEY)')
      writer.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, sequence INTEGER, data)')
      // part.data 可空（宿主真 schema 允许 NULL；SUM(全 NULL) 返 NULL 是该守卫的真实触发面）
      writer.exec('CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, sequence INTEGER, data)')
      writer.exec(
        'CREATE TABLE schema_migration (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, app_version TEXT, time_applied INTEGER NOT NULL)',
      )
      writer
        .prepare('INSERT INTO schema_migration (id, checksum, app_version, time_applied) VALUES (?, ?, ?, ?)')
        .run('0001', 'x', '0.16.5', 1)
      writer
        .prepare('INSERT INTO part (id, message_id, session_id, sequence, data) VALUES (?, ?, ?, ?, ?)')
        .run('p-null', 'm-x', 'sess-null-data', 0, null)
      writer
        .prepare('INSERT INTO part (id, message_id, session_id, sequence, data) VALUES (?, ?, ?, ?, ?)')
        .run('p-ok', 'm-y', 'sess-healthy', 0, '{"type":"text"}')
      checkpointAndClose(writer)

      const handle = await openZcodeSessionDb(join(fx.root, 'db.sqlite'))
      try {
        const sizes = handle.db.candidatesByteSize(['sess-null-data', 'sess-healthy'])
        expect(sizes.has('sess-null-data')).toBe(false) // 大小未知：不入 Map，不回填 0
        expect(sizes.get('sess-healthy')).toBeGreaterThan(0)
        expect(
          warnSpy.mock.calls.some((c) => String(c[0]).includes('bytes 非 number') && String(c[0]).includes('sess-null-data')),
        ).toBe(true)
      } finally {
        handle.dispose()
      }
    } finally {
      fx.cleanup()
    }
  })
})

// ── recovery 阶梯错误收尾契约（假驱动注入）──────────────────────────────────────

describe('recovery 错误收尾契约（假驱动：close 失败 / probe 失败 / 表集缺失）', () => {
  it('probe 失败 ∧ close 也失败：先 close 防泄漏、归因仍以探测错误为准，全链 attempted 记录', async () => {
    installFakeDriver({ masterThrows: true, closeThrows: true })
    const fx = makeFixtureDir('zss-ec-probe-')
    try {
      const dbPath = join(fx.root, 'db.sqlite')
      writeFileSync(dbPath, 'dummy bytes — probe will fail before parsing')
      const snapshotsBefore = countSnapshotDirs()

      let caught: unknown
      try {
        await openWithRecovery(dbPath)
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(SqliteUnreadableError)
      const err = caught as SqliteUnreadableError
      expect(err.attempted).toEqual(['L1-direct', 'L2-immutable', 'L3-snapshot'])
      // 归因以探测错误为准：close 错误吞掉不参与（失败路径错误面不污染）
      expect(err.message).toContain('fake probe NOTADB')
      expect(err.message).not.toContain('fake close broken')
      // L3 失败路径收尾：快照目录读后即清
      expect(countSnapshotDirs()).toBe(snapshotsBefore)
    } finally {
      fx.cleanup()
    }
  })

  it('closeQuietly 吞错：probe 成功 + close 失败 → dispose 不抛（读取结果不受影响）', async () => {
    installFakeDriver({
      masterRows: [{ name: 'session' }, { name: 'message' }, { name: 'part' }],
      closeThrows: true,
    })
    const fx = makeFixtureDir('zss-ec-closeq-')
    try {
      const opened = await openWithRecovery(join(fx.root, 'db.sqlite'))
      expect(opened.via).toBe('L1-direct')
      expect(() => opened.dispose()).not.toThrow()
    } finally {
      fx.cleanup()
    }
  })

  it('L3 表集合验证失败（开库成功但缺表）：报错含期望表集，且快照目录读后即清', async () => {
    installFakeDriver({ masterRows: [{ name: 'session' }] })
    const fx = makeFixtureDir('zss-ec-tables-')
    try {
      const dbPath = join(fx.root, 'db.sqlite')
      writeFileSync(dbPath, 'dummy bytes — snapshot copy will open but lack tables')
      const snapshotsBefore = countSnapshotDirs()

      let caught: unknown
      try {
        await openViaSnapshot(dbPath)
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(Error)
      expect((caught as Error).message).toContain('table-set validation')
      expect((caught as Error).message).toContain('session/message/part')
      expect(countSnapshotDirs()).toBe(snapshotsBefore)
    } finally {
      fx.cleanup()
    }
  })

  it('readSchemaVersion best-effort + wrapDb close 吞错：查询失败返 undefined 不外抛，dispose 不抛', async () => {
    let schemaBroken = false
    installFakeDriver({
      masterRows: [{ name: 'session' }, { name: 'message' }, { name: 'part' }],
      schemaThrowsLater: () => schemaBroken,
      closeThrows: true,
    })
    const fx = makeFixtureDir('zss-ec-schema-')
    try {
      const dbPath = join(fx.root, 'db.sqlite')
      writeFileSync(dbPath, 'dummy bytes — orchestration entry requires the file to exist')
      const handle = await openZcodeSessionDb(dbPath)
      schemaBroken = true // 开库闸门已过；读版本 best-effort 面失败
      expect(handle.db.readSchemaVersion()).toBeUndefined()
      expect(() => handle.dispose()).not.toThrow()
      // wrapDb.close 吞错（[HISTORICAL] 只读连接 close 失败不影响读取结果）：
      // dispose 走 recovery 的 closeQuietly，close 面须单独驱动
      expect(() => handle.db.close()).not.toThrow()
      // 前缀常量仍在断言面（快照目录识别 SSOT 未漂移）
      expect(SNAPSHOT_TMP_PREFIX).toBe('taiji-zcode-snap-')
    } finally {
      fx.cleanup()
    }
  })
})
