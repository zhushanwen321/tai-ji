/**
 * 访问层测试（迁入改造面）：行集查询（session → message → part 三级表）、schema
 * 已知集闸门、库路径投影。fixture 自建自删（os.tmpdir()），不触真实数据目录。
 */

import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { homedir } from 'node:os'

import {
  KNOWN_ZCODE_SCHEMA_VERSIONS,
  ZcodeSchemaDriftError,
  assertKnownSchema,
  hostZcodeDbPath,
  openZcodeSessionDb,
  zcodeImportDbAllowlist,
  zcodeIsolatedDbPath,
} from '../sqlite-access.ts'
import { SqliteUnreadableError } from '../recovery.ts'
import {
  buildFixtureDb,
  defaultTranscriptSeeds,
  isBun,
  makeFixtureDir,
  openWritableSqlite,
  type FixtureDb,
} from './helpers.ts'

const FIXTURE_DIR = 'zss-access-'

async function makeReadyFixture(dir: string, schemaVersion?: string): Promise<FixtureDb> {
  return buildFixtureDb(dir, defaultTranscriptSeeds(), schemaVersion ? { schemaVersion } : undefined)
}

describe('行集查询（getSessionTranscript：session → message → part 三级表）', () => {
  it('message 按 sequence 升序、parts 联合序排好、data 列解析为对象', async () => {
    const fx = makeFixtureDir(FIXTURE_DIR)
    try {
      const fixture = await makeReadyFixture(fx.root)
      const handle = await openZcodeSessionDb(fixture.dbPath)
      try {
        expect(handle.via).toBe(isBun ? 'L2-immutable' : 'L1-direct')
        const transcript = handle.db.getSessionTranscript('sess_fix_a')
        expect(transcript.map((m) => m.id)).toEqual(['m1', 'm2', 'm3', 'm4'])
        expect(transcript[0].parts[0]).toMatchObject({ type: 'text', text: expect.stringContaining('ZZQFIXTURE') })
        // 同一 message 的多 part 按联合序（toolCall 在 text 前）
        expect(transcript[1].parts.map((p) => p['type'])).toEqual(['toolCall', 'text'])
        expect(transcript[1].parts[0]).toMatchObject({ toolCallId: 'tc-1', toolName: 'bash' })
      } finally {
        handle.dispose()
      }
    } finally {
      fx.cleanup()
    }
  })

  it('LEFT JOIN 保留无 part 的 message（parts 空数组）', async () => {
    const fx = makeFixtureDir(FIXTURE_DIR)
    try {
      const fixture = await makeReadyFixture(fx.root)
      const writer = await openWritableSqlite(fixture.dbPath)
      writer
        .prepare('INSERT INTO message (id, session_id, sequence, data) VALUES (?, ?, ?, ?)')
        .run('m9', 'sess_fix_a', 9, JSON.stringify({ role: 'assistant' }))
      writer.close()

      const handle = await openZcodeSessionDb(fixture.dbPath)
      try {
        const transcript = handle.db.getSessionTranscript('sess_fix_a')
        const empty = transcript.find((m) => m.id === 'm9')
        expect(empty).toBeDefined()
        expect(empty?.parts).toEqual([])
      } finally {
        handle.dispose()
      }
    } finally {
      fx.cleanup()
    }
  })

  it('data 列非法 JSON：抛错不静默（上下文带表与行标识）', async () => {
    const fx = makeFixtureDir(FIXTURE_DIR)
    try {
      const fixture = await makeReadyFixture(fx.root)
      const writer = await openWritableSqlite(fixture.dbPath)
      writer
        .prepare('INSERT INTO message (id, session_id, sequence, data) VALUES (?, ?, ?, ?)')
        .run('m-bad', 'sess_fix_a', 10, 'not-json')
      writer.close()

      const handle = await openZcodeSessionDb(fixture.dbPath)
      try {
        expect(() => handle.db.getSessionTranscript('sess_fix_a')).toThrow(/message\(m-bad\)/)
      } finally {
        handle.dispose()
      }
    } finally {
      fx.cleanup()
    }
  })
})

describe('候选行 / 单行 / 字节聚合', () => {
  it('listCandidateSessions：排除 subagent_child、time_updated 降序、limit 截断', async () => {
    const fx = makeFixtureDir(FIXTURE_DIR)
    try {
      const fixture = await makeReadyFixture(fx.root)
      const handle = await openZcodeSessionDb(fixture.dbPath)
      try {
        const all = handle.db.listCandidateSessions()
        expect(all.map((s) => s.id)).toEqual(['sess_fix_a']) // subagent_child 被排除
        const limited = handle.db.listCandidateSessions({ limit: 0 })
        expect(limited).toEqual([])
      } finally {
        handle.dispose()
      }
    } finally {
      fx.cleanup()
    }
  })

  it('getSessionRow：命中返回 camelCase 行 / 未命中返回 undefined', async () => {
    const fx = makeFixtureDir(FIXTURE_DIR)
    try {
      const fixture = await makeReadyFixture(fx.root)
      const handle = await openZcodeSessionDb(fixture.dbPath)
      try {
        const row = handle.db.getSessionRow('sess_fix_a')
        expect(row).toMatchObject({
          id: 'sess_fix_a',
          title: 'fixture session A',
          directory: '/tmp/fix-a',
          taskType: 'interactive',
        })
        expect(typeof row?.timeCreated).toBe('number')
        expect(handle.db.getSessionRow('nope')).toBeUndefined()
      } finally {
        handle.dispose()
      }
    } finally {
      fx.cleanup()
    }
  })

  it('candidatesByteSize：真字节口径（CAST BLOB），无 part 会话不在 Map', async () => {
    const fx = makeFixtureDir(FIXTURE_DIR)
    try {
      const fixture = await makeReadyFixture(fx.root)
      const handle = await openZcodeSessionDb(fixture.dbPath)
      try {
        const sizes = handle.db.candidatesByteSize(['sess_fix_a', 'sess_fix_b'])
        // p1 文本含 CJK：字节 > 字符数（真字节口径的最低限断言）
        const bytes = sizes.get('sess_fix_a') ?? 0
        const charLen = '第一轮用户提问 ZZQFIXTURE 检索锚点'.length
        expect(bytes).toBeGreaterThan(charLen)
        expect(sizes.has('sess_fix_b')).toBe(false)
        expect(handle.db.candidatesByteSize([]).size).toBe(0)
      } finally {
        handle.dispose()
      }
    } finally {
      fx.cleanup()
    }
  })
})

describe('schema 版本已知集闸门', () => {
  it('已知版本（0.16.5）通过：openZcodeSessionDb 正常返回', async () => {
    const fx = makeFixtureDir(FIXTURE_DIR)
    try {
      const fixture = await makeReadyFixture(fx.root, KNOWN_ZCODE_SCHEMA_VERSIONS[0])
      const handle = await openZcodeSessionDb(fixture.dbPath)
      try {
        expect(handle.db.listCandidateSessions().length).toBeGreaterThan(0)
      } finally {
        handle.dispose()
      }
    } finally {
      fx.cleanup()
    }
  })

  it('版本超出已知集：ZcodeSchemaDriftError 且 observedVersion 记录观测值', async () => {
    const fx = makeFixtureDir(FIXTURE_DIR)
    try {
      const fixture = await makeReadyFixture(fx.root, '9.9.9')
      let caught: unknown
      try {
        await openZcodeSessionDb(fixture.dbPath)
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(ZcodeSchemaDriftError)
      expect((caught as ZcodeSchemaDriftError).observedVersion).toBe('9.9.9')
    } finally {
      fx.cleanup()
    }
  })

  it('schema_migration 表缺失：编排入口直接抛 drift 且 observedVersion 为 undefined', async () => {
    const fx = makeFixtureDir(FIXTURE_DIR)
    try {
      const fixture = await makeReadyFixture(fx.root)
      const writer = await openWritableSqlite(fixture.dbPath)
      writer.exec('DROP TABLE schema_migration')
      writer.close()

      let caught: unknown
      try {
        await openZcodeSessionDb(fixture.dbPath)
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(ZcodeSchemaDriftError)
      expect((caught as ZcodeSchemaDriftError).observedVersion).toBeUndefined()
    } finally {
      fx.cleanup()
    }
  })

  it('assertKnownSchema 直测：未知版本抛、已知版本静默', async () => {
    const fx = makeFixtureDir(FIXTURE_DIR)
    try {
      await makeReadyFixture(fx.root)
      const { openWithRecovery } = await import('../recovery.ts')
      const opened = await openWithRecovery(join(fx.root, 'db.sqlite'))
      try {
        expect(() => assertKnownSchema(opened.db)).not.toThrow()
      } finally {
        opened.dispose()
      }

      const fx2 = makeFixtureDir('zss-access-drift-')
      try {
        await buildFixtureDb(fx2.root, defaultTranscriptSeeds(), { schemaVersion: '0.0.1' })
        const opened2 = await openWithRecovery(join(fx2.root, 'db.sqlite'))
        try {
          let caught: unknown
          try {
            assertKnownSchema(opened2.db)
          } catch (err) {
            caught = err
          }
          expect(caught).toBeInstanceOf(ZcodeSchemaDriftError)
          expect((caught as ZcodeSchemaDriftError).observedVersion).toBe('0.0.1')
        } finally {
          opened2.dispose()
        }
      } finally {
        fx2.cleanup()
      }
    } finally {
      fx.cleanup()
    }
  })
})

describe('openZcodeSessionDb 编排入口', () => {
  it('db 文件不存在：普通 Error（消费方映射「库不存在」语义）', async () => {
    const fx = makeFixtureDir(FIXTURE_DIR)
    try {
      let caught: unknown
      try {
        await openZcodeSessionDb(join(fx.root, 'absent.sqlite'))
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(Error)
      expect(caught).not.toBeInstanceOf(SqliteUnreadableError)
      expect((caught as Error).message).toContain('不存在')
    } finally {
      fx.cleanup()
    }
  })
})

describe('库路径投影（SDK 常量同源）', () => {
  it('隔离库 = dataDir + ZCODE_ISOLATED_DB_SEGMENTS', () => {
    expect(zcodeIsolatedDbPath('/data-root')).toBe(join('/data-root', 'engines', 'zcode', 'session-db', 'db.sqlite'))
  })

  it('宿主库 = homedir + ZCODE_HOST_DB_SUFFIX（运行时推导，无硬编码绝对路径）', () => {
    expect(hostZcodeDbPath()).toBe(join(homedir(), '.zcode', 'cli', 'db', 'db.sqlite'))
  })

  it('白名单封闭集合 = [隔离库, 宿主库]', () => {
    const allowlist = zcodeImportDbAllowlist('/data-root')
    expect(allowlist).toEqual([
      join('/data-root', 'engines', 'zcode', 'session-db', 'db.sqlite'),
      join(homedir(), '.zcode', 'cli', 'db', 'db.sqlite'),
    ])
  })
})
