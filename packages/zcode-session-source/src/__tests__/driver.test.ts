/**
 * 驱动适配层单测（U3 验收③）：node/bun 双趟可跑——node 趟走 node:sqlite 路径，
 * bun 趟（U5 补跑）走 bun:sqlite 路径，同一断言集覆盖两驱动的公共子集
 * （open/prepare/all/get/close + 只读拒绝写）。
 */

import { describe, expect, it } from 'vitest'
import { join } from 'node:path'

import {
  loadSqliteDriver,
  toSqliteFileUri,
  type SqliteDb,
} from '../sqlite-driver.ts'
import {
  buildFixtureDb,
  checkpointAndClose,
  defaultTranscriptSeeds,
  dirSnapshot,
  expectFileExists,
  isBun,
  makeFixtureDir,
  openWritableSqlite,
} from './helpers.ts'

describe('loadSqliteDriver', () => {
  it('探测当前运行时的驱动 id（node 趟 = node:sqlite / bun 趟 = bun:sqlite）', async () => {
    const driver = await loadSqliteDriver()
    expect(driver.id).toBe(isBun ? 'bun:sqlite' : 'node:sqlite')
  })

  it('进程内缓存：重复加载返回同一实例', async () => {
    const a = await loadSqliteDriver()
    const b = await loadSqliteDriver()
    expect(b).toBe(a)
  })
})

describe('toSqliteFileUri', () => {
  it('immutable=1 形态追加 query', () => {
    expect(toSqliteFileUri('/data/db.sqlite', true)).toBe('file:/data/db.sqlite?immutable=1')
  })

  it('非 immutable 为纯 file: URI', () => {
    expect(toSqliteFileUri('/data/db.sqlite', false)).toBe('file:/data/db.sqlite')
  })

  it('URI 结构字符（% ? #）百分号编码（否则被解析为 query/fragment）', () => {
    expect(toSqliteFileUri('/da%ta/a?b/db.sqlite', true)).toBe('file:/da%25ta/a%3Fb/db.sqlite?immutable=1')
    expect(toSqliteFileUri('/da#ta/db.sqlite', true)).toBe('file:/da%23ta/db.sqlite?immutable=1')
  })
})

describe('驱动公共子集（open/prepare/all/get/close）', () => {
  it('readonly 打开 fixture 库可查询：get 命中/未命中、all 多行、参数绑定', async () => {
    const fx = makeFixtureDir('zss-driver-')
    try {
      const seeds = defaultTranscriptSeeds()
      const fixture = await buildFixtureDb(fx.root, seeds)
      const driver = await loadSqliteDriver()
      const db: SqliteDb = driver.open(fixture.dbPath, { readOnly: true })
      try {
        const byId = db.prepare('SELECT id, title FROM session WHERE id = ?')
        const hit = byId.get('sess_fix_a') as Record<string, unknown> | undefined
        expect(hit).toBeDefined()
        expect(hit?.['id']).toBe('sess_fix_a')
        expect(hit?.['title']).toBe('fixture session A')
        expect(byId.get('nope')).toBeUndefined()

        const all = db.prepare('SELECT id FROM session ORDER BY time_updated DESC').all()
        expect(all).toHaveLength(2)

        const bound = db.prepare('SELECT COUNT(*) AS c FROM part WHERE session_id = ?').get('sess_fix_a') as
          | Record<string, unknown>
          | undefined
        expect(Number(bound?.['c'])).toBe(6)
      } finally {
        db.close()
      }
    } finally {
      fx.cleanup()
    }
  })

  it('readonly 语义：写拒绝（G4 严格只读的驱动面保证）', async () => {
    const fx = makeFixtureDir('zss-driver-ro-')
    try {
      const fixture = await buildFixtureDb(fx.root, defaultTranscriptSeeds())
      const driver = await loadSqliteDriver()
      const db = driver.open(fixture.dbPath, { readOnly: true })
      try {
        // 生产语句类型面无 run（readonly 连接不写）；此处断言驱动真的拒绝写，
        // 用局部形状断言补出 run（bun 可能 prepare 即抛，node 是 run 时抛——
        // 都包进同一断言）
        const insert = db.prepare(
          "INSERT INTO session (id, directory, title, task_type, time_created, time_updated) VALUES ('x', 'x', 'x', 'interactive', 1, 1)",
        ) as unknown as { run: (...args: unknown[]) => unknown }
        expect(() => insert.run()).toThrow()
      } finally {
        db.close()
      }
    } finally {
      fx.cleanup()
    }
  })

  it('immutable URI 开库（L2 行为面）：静息态库全行可读、零附属文件创建', async () => {
    const fx = makeFixtureDir('zss-driver-imm-')
    try {
      const fixture = await buildFixtureDb(fx.root, defaultTranscriptSeeds(), { quiesce: true })
      const before = dirSnapshot(fx.root)
      expect(before).toEqual(['db.sqlite']) // 静息态前置确认

      const driver = await loadSqliteDriver()
      const db = driver.open(toSqliteFileUri(fixture.dbPath, true), { readOnly: true })
      try {
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
        const names = tables.map((t) => (t as Record<string, unknown>)['name']).sort()
        expect(names).toContain('session')
        expect(names).toContain('message')
        expect(names).toContain('part')
        expect(names).toContain('schema_migration')

        const rows = db.prepare('SELECT COUNT(*) AS c FROM message').get() as Record<string, unknown>
        expect(Number(rows['c'])).toBe(4)
      } finally {
        db.close()
      }
      // immutable 定义性质：零 -shm/-wal 创建
      expect(dirSnapshot(fx.root)).toEqual(before)
      expect(expectFileExists(`${fixture.dbPath}-shm`, false)).toBe(true)
    } finally {
      fx.cleanup()
    }
  })

  it('变量间接写法的运行时证据：fixture 写连接与生产驱动同源于当前运行时', async () => {
    // fixture 建库 helper 与 loadSqliteDriver 都经变量间接动态 import——本断言锁定
    // 两者解析到同一模块系统（双趟下分别是 node:sqlite / bun:sqlite）。
    const fx = makeFixtureDir('zss-driver-src-')
    try {
      const writer = await openWritableSqlite(join(fx.root, 'w.sqlite'))
      writer.exec('CREATE TABLE t (a TEXT)')
      writer.prepare('INSERT INTO t VALUES (?)').run('v')
      checkpointAndClose(writer) // bun:sqlite close 不 checkpoint（探针实证），须显式落盘
      const driver = await loadSqliteDriver()
      const db = driver.open(join(fx.root, 'w.sqlite'), { readOnly: true })
      try {
        const row = db.prepare('SELECT a FROM t').get() as Record<string, unknown>
        expect(row['a']).toBe('v')
      } finally {
        db.close()
      }
    } finally {
      fx.cleanup()
    }
  })
})
