/**
 * 测试 fixture 工具：sqlite 库建库/写入也走「运行时探测 + 变量间接」——bun 趟
 * （D3 源级双跑，U5）下 node:sqlite 不可用（F2），fixture 建库必须用当前运行时
 * 的写连接（node: DatabaseSync / bun: Database，均为默认读写模式）。测试进程
 * 里的变量间接形态与生产 src 同纪律（esbuild 规约防护）。
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined'

/** 当前运行时 sqlite 模块的可写连接（fixture 专用；生产读取链恒只读）。 */
export interface WritableStatement {
  run: (...args: unknown[]) => unknown
  all: (...args: unknown[]) => unknown[]
}

export interface WritableConn {
  exec: (sql: string) => void
  prepare: (sql: string) => WritableStatement
  close: () => void
}

interface SqliteWriteModule {
  DatabaseSync?: unknown
  Database?: unknown
}

/** 与生产 sqlite-driver 同款变量间接（硬要求——esbuild 字面量规约防护）。 */
export async function openWritableSqlite(path: string): Promise<WritableConn> {
  if (isBun) {
    const moduleId = 'bun:sqlite'
    const mod = (await import(moduleId)) as SqliteWriteModule
    const Database = mod.Database as new (path: string) => WritableConn
    return new Database(path)
  }
  const moduleId = 'node:sqlite'
  const mod = (await import(moduleId)) as SqliteWriteModule
  const DatabaseSync = mod.DatabaseSync as new (path: string) => WritableConn
  return new DatabaseSync(path)
}

export interface FixtureSession {
  id: string
  title: string
  directory: string
  taskType: string
  timeCreated: number
  timeUpdated: number
}

export interface FixtureMessage {
  id: string
  sessionId: string
  sequence: number
  data: Record<string, unknown>
}

export interface FixturePart {
  id: string
  messageId: string
  sessionId: string
  sequence: number
  data: Record<string, unknown>
}

export interface FixtureDb {
  dbPath: string
  sessions: FixtureSession[]
  messages: FixtureMessage[]
  parts: FixturePart[]
  schemaVersion: string
}

export interface FixtureDir {
  root: string
  cleanup: () => void
}

/** 自建自删的 fixture 根目录（fs-guard 白名单 = os.tmpdir()）。 */
export function makeFixtureDir(prefix: string): FixtureDir {
  const root = mkdtempSync(join(tmpdir(), prefix))
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }) }
}

export interface BuildFixtureOptions {
  schemaVersion?: string
  /** 建库后打开一个写连接返回（W2 场景「写者保持打开」用）；测试负责 close。 */
  keepOpen?: boolean
  /** 建库完成后清掉 -wal/-shm（静息态；默认 close 已自然达成，兜底显式删）。 */
  quiesce?: boolean
}

/**
 * 建消费面 fixture 库：WAL 模式 + session/message/part/schema_migration 四表 +
 * 种子行。行结构与 runtime 旧 fixture 同款（宿主 schema 0.16.5 消费面子集）。
 */
export async function buildFixtureDb(
  dir: string,
  seeds: { sessions?: FixtureSession[]; messages?: FixtureMessage[]; parts?: FixturePart[] },
  opts: BuildFixtureOptions = {},
): Promise<FixtureDb & { writer?: WritableConn }> {
  mkdirSync(dir, { recursive: true })
  const dbPath = join(dir, 'db.sqlite')
  const schemaVersion = opts.schemaVersion ?? '0.16.5'
  const sessions = seeds.sessions ?? []
  const messages = seeds.messages ?? []
  const parts = seeds.parts ?? []

  const writer = await openWritableSqlite(dbPath)
  try {
    writer.exec('PRAGMA journal_mode=WAL')
    writer.exec('BEGIN')
    writer.exec(
      'CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL, title TEXT NOT NULL, ' +
        "task_type TEXT NOT NULL DEFAULT 'interactive', time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL)",
    )
    writer.exec(
      'CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, sequence INTEGER, data TEXT NOT NULL)',
    )
    writer.exec(
      'CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, sequence INTEGER, data TEXT NOT NULL)',
    )
    writer.exec(
      'CREATE TABLE schema_migration (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, app_version TEXT, time_applied INTEGER NOT NULL)',
    )
    writer
      .prepare('INSERT INTO schema_migration (id, checksum, app_version, time_applied) VALUES (?, ?, ?, ?)')
      .run('0001_seed', 'x', schemaVersion, 1)
    const insSession = writer.prepare(
      'INSERT INTO session (id, directory, title, task_type, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)',
    )
    for (const s of sessions) insSession.run(s.id, s.directory, s.title, s.taskType, s.timeCreated, s.timeUpdated)
    const insMessage = writer.prepare('INSERT INTO message (id, session_id, sequence, data) VALUES (?, ?, ?, ?)')
    for (const m of messages) insMessage.run(m.id, m.sessionId, m.sequence, JSON.stringify(m.data))
    const insPart = writer.prepare('INSERT INTO part (id, message_id, session_id, sequence, data) VALUES (?, ?, ?, ?, ?)')
    for (const p of parts) insPart.run(p.id, p.messageId, p.sessionId, p.sequence, JSON.stringify(p.data))
    writer.exec('COMMIT')
  } catch (err) {
    try {
      writer.close()
    } catch {
      /* 建库已失败，close 错误不参与归因 */
    }
    throw err
  }

  if (opts.keepOpen) {
    // 写连接交还调用方（W2：写者保持打开、-wal 有内容）。wal_autocheckpoint=0
    // 由 W2 测试自行 exec（fixture 不预设写者行为）。
    return { dbPath, sessions, messages, parts, schemaVersion, writer }
  }
  checkpointAndClose(writer)
  if (opts.quiesce) quiesceDir(dir)
  return { dbPath, sessions, messages, parts, schemaVersion }
}

/**
 * 双端落盘关闭：bun:sqlite 的 close() 不执行 checkpoint 也不删 -wal/-shm 附属
 * 文件（bun 1.3.8 探针实证；node:sqlite close 自动 checkpoint+清理）——不显式
 * checkpoint 就删附属 = 丢掉未落盘数据（W1 在 bun 腿下 db 主文件残缺的根因）。
 * 所有「写连接关闭后库须数据完整」的 fixture 关闭点一律走本助手；W2 的写者
 * 活跃态构造（close 前不留证）不适用。
 */
export function checkpointAndClose(writer: WritableConn): void {
  writer.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  writer.close()
}

/** 删除目录内 -wal/-shm 附属文件（静息态化；clean close 后通常已无残留）。 */
export function quiesceDir(dir: string): void {
  for (const f of readdirSync(dir)) {
    if (f.endsWith('-wal') || f.endsWith('-shm')) rmSync(join(dir, f), { force: true })
  }
}

/** 目录内文件名集合快照（「零 -shm/-wal 创建 / 无文件被拷走」diff 断言用）。 */
export function dirSnapshot(dir: string): string[] {
  return readdirSync(dir).sort()
}

/**
 * 场景 1a 共用 fixture 行集契约（≥2 轮对话 + toolCall/toolResult 对 + 可检索
 * 关键词 + compaction part）——本包测试只断言行集查询面（converter 断言归 U4），
 * 行集保持与设计契约同形供后续单元复用。
 */
export function defaultTranscriptSeeds(): {
  sessions: FixtureSession[]
  messages: FixtureMessage[]
  parts: FixturePart[]
} {
  const base = 1758379200000
  const sessions: FixtureSession[] = [
    { id: 'sess_fix_a', title: 'fixture session A', directory: '/tmp/fix-a', taskType: 'interactive', timeCreated: base, timeUpdated: base + 100 },
    { id: 'sess_fix_b', title: 'subagent child session', directory: '/tmp/fix-b', taskType: 'subagent_child', timeCreated: base, timeUpdated: base + 90 },
  ]
  const messages: FixtureMessage[] = [
    { id: 'm1', sessionId: 'sess_fix_a', sequence: 0, data: { role: 'user' } },
    { id: 'm2', sessionId: 'sess_fix_a', sequence: 1, data: { role: 'assistant' } },
    { id: 'm3', sessionId: 'sess_fix_a', sequence: 2, data: { role: 'user' } },
    { id: 'm4', sessionId: 'sess_fix_a', sequence: 3, data: { role: 'assistant' } },
  ]
  const textPart = (id: string, messageId: string, sequence: number, text: string) => ({
    id,
    messageId,
    sessionId: 'sess_fix_a',
    sequence,
    data: { type: 'text', text, time: { start: base + sequence * 10 } },
  })
  const parts: FixturePart[] = [
    textPart('p1', 'm1', 0, '第一轮用户提问 ZZQFIXTURE 检索锚点'),
    {
      id: 'p2',
      messageId: 'm2',
      sessionId: 'sess_fix_a',
      sequence: 0,
      data: { type: 'toolCall', toolCallId: 'tc-1', toolName: 'bash', data: { command: 'echo hi' } },
    },
    textPart('p3', 'm2', 1, '第一轮助手回答'),
    {
      id: 'p4',
      messageId: 'm3',
      sessionId: 'sess_fix_a',
      sequence: 0,
      data: { type: 'toolCall', toolCallId: 'tc-1', toolName: 'bash', data: { result: 'hi' } },
    },
    textPart('p5', 'm4', 0, '第二轮助手回答'),
    {
      id: 'p6',
      messageId: 'm4',
      sessionId: 'sess_fix_a',
      sequence: 1,
      data: { type: 'compaction', data: { trigger: 'auto' } },
    },
  ]
  return { sessions, messages, parts }
}

/** 断言辅助：路径存在性。 */
export function expectFileExists(p: string, expected: boolean): boolean {
  return existsSync(p) === expected
}
