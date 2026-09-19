/**
 * ZcodeImportSource 测试（session-import-unified 设计 §3.3/§3.4 T1/§3.7——U3 领地）。
 *
 * 锁定行为：
 * - 候选列表：D8 排除 subagent_child（interactive/fork/selection_side_chat 在列）；
 *   字段映射（sessionId=原始 id/name=title/cwd=directory/lastModified=time_updated/
 *   sourcePath=dbPath/dirLabel=basename）；lastModified 降序；total（过滤前）；
 *   dirs 按 dirLabel 聚合（过滤前全集）；cwdExists；limit 截断
 * - query 匹配（§3.7 zcode 行为）：name ∪ sessionId ∪ directory ∪ dirLabel
 *   case-insensitive includes；sourcePath（db 路径结构占位）不参与匹配
 * - size 真字节口径（§3.7）：SUM(length(CAST(data AS BLOB)))——CJK 内容按 UTF-8 字节
 *   而非字符数（TEXT 直接 length() 低估）；无 part 会话记 0
 * - alreadyImported 归一化域（§3.7）：扫描集（header.id 域）命中判定的输入是 T1 归一化
 *   id 而非原始 sess_ 形态——预置归一化形态 id 命中、预置原始形态 id 不命中（失配对照）
 * - normalize（§3.4 T1 三步骤 + 后置条件 fail-fast）：剥前缀一次/无前缀/_→-/空串/
 *   纯 sess_/首尾非法字符/单字符/幂等性
 * - 错误映射（§3.6）：db 不存在 → import_source_missing；schema 漂移（表缺失）→
 *   import_invalid_session 且 message 带 schema_migration 版本；sessionId 缺失/不存在 →
 *   import_invalid_session
 * - prepareImport（T1 全量 header/fileName）：fileName 尾段 === header.id 不变量；
 *   write = U4 转换器落盘（空会话产物 = header + session_info 两行；转换明细测试在
 *   zcode-import/converter.test.ts——U4 领地）
 *
 * 夹具：node:sqlite 在 mkdtemp(tmpdir) 自建最小列集库（session/message/part +
 * schema_migration）。fixture 库注入通道：listCandidates 走构造依赖
 * （getHostDbPath，候选契约无 dbPath 字段——§3.7 dbPath 只在 ImportRequest）、
 * prepareImport 走 request.dbPath——两条通道都永不触达真实宿主库（~/.zcode）。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { getSessionsDir } from '../infra/pi/pi-paths.js'
import { invalidateScanDirCache, scanPiSessions } from '../infra/pi/session-file-utils.js'
import { ImportServiceError } from '../services/session/import-source.js'
import { ZcodeImportSource } from '../services/session/import-source-zcode.js'
import { normalizeZcodeSessionId, zcodeCandidateKey } from '../services/session/zcode-import/normalize.js'

let fixturesRoot: string

/** fixture 库 session 行种子。 */
interface SessionSeed {
  id: string
  title: string
  directory: string
  taskType: string
  timeCreated: number
  timeUpdated: number
}

/**
 * 建最小列集 fixture 库（宿主 schema 0.16.5 的消费面子集：session 六列 + message/part
 * 存在性 + schema_migration）。parts 直挂 session_id（本单元的字节聚合只消费
 * part.session_id/part.data，message 形态是 U4 转换器的面）。
 */
function buildFixtureDb(
  dbPath: string,
  sessions: SessionSeed[],
  parts: Array<{ sessionId: string; data: string }>,
  opts?: { omitSessionTable?: boolean; schemaVersion?: string },
): void {
  const db = new DatabaseSync(dbPath)
  try {
    db.exec('BEGIN')
    db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, sequence INTEGER, data TEXT NOT NULL)')
    db.exec(
      'CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, sequence INTEGER, data TEXT NOT NULL)',
    )
    if (!opts?.omitSessionTable) {
      db.exec(
        'CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL, title TEXT NOT NULL, ' +
          "task_type TEXT NOT NULL DEFAULT 'interactive', time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL)",
      )
      const ins = db.prepare('INSERT INTO session (id, directory, title, task_type, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)')
      for (const s of sessions) ins.run(s.id, s.directory, s.title, s.taskType, s.timeCreated, s.timeUpdated)
    }
    const insPart = db.prepare('INSERT INTO part (id, message_id, session_id, sequence, data) VALUES (?, ?, ?, ?, ?)')
    parts.forEach((p, i) => insPart.run(`p-${i}`, `m-${i}`, p.sessionId, i, p.data))
    db.exec(
      'CREATE TABLE schema_migration (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, app_version TEXT, time_applied INTEGER NOT NULL)',
    )
    db.prepare('INSERT INTO schema_migration (id, checksum, app_version, time_applied) VALUES (?, ?, ?, ?)').run(
      '0001_seed',
      'x',
      opts?.schemaVersion ?? '0.16.5',
      1,
    )
    db.exec('COMMIT')
  } finally {
    db.close()
  }
}

/** 预置一个太极扫描集 session 文件（header.id = 归一化形态打标域断言用）。 */
function seedTaijiSession(id: string): void {
  const fileName = `2026-01-01T00.00.00.000Z_${id}.jsonl`
  const filePath = join(getSessionsDir(), fileName)
  mkdirSync(getSessionsDir(), { recursive: true })
  writeFileSync(
    filePath,
    `${JSON.stringify({ type: 'session', version: 3, id, cwd: '/tmp/zc-seed-cwd', timestamp: '2026-01-01T00:00:00.000Z' })}\n`,
  )
}

function makeSource(dbPath: string): ZcodeImportSource {
  return new ZcodeImportSource({ getHostDbPath: () => dbPath })
}

function codeOf(e: unknown): string {
  return (e as ImportServiceError).code
}

async function catchCode(work: () => Promise<unknown>): Promise<string> {
  try {
    await work()
  } catch (e) {
    return codeOf(e)
  }
  return expect.unreachable('expected ImportServiceError but call succeeded')
}

beforeAll(() => {
  fixturesRoot = mkdtempSync(join(tmpdir(), 'import-source-zcode-'))
})

afterAll(() => {
  rmSync(fixturesRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  // alreadyImported 用例预置进 tmp dataDir sessions 根的种子文件随 globalSetup teardown 回收
})

describe('normalizeZcodeSessionId（T1 三步骤 + 后置条件 fail-fast）', () => {
  it('步骤①：sess_ 前缀剥一次；双前缀只剥一次', () => {
    expect(normalizeZcodeSessionId('sess_0198f7c4-5b21-7abc-8912-3def456789ab')).toBe('0198f7c4-5b21-7abc-8912-3def456789ab')
    // sess_sess_ab → 剥一次 → sess_ab → _→- → sess-ab（幂等：再 normalize 不变）
    expect(normalizeZcodeSessionId('sess_sess_ab')).toBe('sess-ab')
    expect(normalizeZcodeSessionId(normalizeZcodeSessionId('sess_sess_ab'))).toBe('sess-ab')
  })

  it('步骤①：无前缀不剥；步骤②：_ 全部 → -', () => {
    expect(normalizeZcodeSessionId('0198f7c4-5b21-7abc-8912-3def456789ab')).toBe('0198f7c4-5b21-7abc-8912-3def456789ab')
    expect(normalizeZcodeSessionId('sess_ab_cd')).toBe('ab-cd')
    expect(normalizeZcodeSessionId('a_b_c')).toBe('a-b-c')
    // subagent_child 形态（当前被 D8 排除，未来放开时由步骤②封闭处理）
    expect(normalizeZcodeSessionId('sess_subagent_agent_0198abcd')).toBe('subagent-agent-0198abcd')
  })

  it('步骤③ 后置条件 fail-fast（import_invalid_session，message 带原 id）', () => {
    for (const raw of ['', 'sess_', '_', '-']) {
      // eslint 参数循环内断言 message：空串/纯 sess_（剥后空）、'_'/'-'（字符集或首尾非法）
      try {
        normalizeZcodeSessionId(raw)
        expect.unreachable(`expected normalizeZcodeSessionId(${JSON.stringify(raw)}) to throw`)
      } catch (e) {
        expect(codeOf(e)).toBe('import_invalid_session')
        expect((e as Error).message).toContain(raw)
      }
    }
    // 首字符非法（- 开头）/ 尾字符非法（- 结尾）
    expect(() => normalizeZcodeSessionId('sess_-abc')).toThrow(ImportServiceError)
    expect(() => normalizeZcodeSessionId('sess_abc-')).toThrow(ImportServiceError)
    expect(() => normalizeZcodeSessionId('sess_ab.c')).toThrow(ImportServiceError)
  })

  it('单字符合法（首尾即唯一字符，字母数字均可）', () => {
    expect(normalizeZcodeSessionId('sess_a')).toBe('a')
    expect(normalizeZcodeSessionId('7')).toBe('7')
  })

  it('zcodeCandidateKey 与 normalizeZcodeSessionId 同一函数（打标域 = 转换域）', () => {
    expect(zcodeCandidateKey).toBe(normalizeZcodeSessionId)
    expect(zcodeCandidateKey('sess_ab')).toBe('ab')
  })
})

describe('ZcodeImportSource.listCandidates', () => {
  let dbPath: string
  let existingDir: string

  beforeAll(() => {
    existingDir = join(fixturesRoot, 'proj-exists')
    mkdirSync(existingDir, { recursive: true })
    dbPath = join(fixturesRoot, 'zc-candidates.sqlite')
    buildFixtureDb(
      dbPath,
      [
        // time_updated 降序断言：newest → interactive-b → subagent（排除）→ fork → oldest
        { id: 'sess_0198old0-0000-0000-0000-000000000001', title: 'Oldest interactive', directory: '/tmp/zc-proj-alpha', taskType: 'interactive', timeCreated: 1000, timeUpdated: 1000 },
        { id: 'sess_0198frk0-0000-0000-0000-000000000002', title: 'A fork session', directory: '/tmp/zc-proj-alpha', taskType: 'fork', timeCreated: 2000, timeUpdated: 3000 },
        { id: 'sess_0198sub0-0000-0000-0000-000000000003', title: 'Subagent child noise', directory: '/tmp/zc-proj-alpha', taskType: 'subagent_child', timeCreated: 3000, timeUpdated: 4000 },
        { id: 'sess_0198sid0-0000-0000-0000-000000000004', title: 'Side chat session', directory: existingDir, taskType: 'selection_side_chat', timeCreated: 4000, timeUpdated: 5000 },
        { id: 'sess_0198new0-0000-0000-0000-000000000005', title: 'Newest interactive', directory: existingDir, taskType: 'interactive', timeCreated: 5000, timeUpdated: 6000 },
      ],
      [
        // 字节口径：'中文'=6B + 'abc'=3B → sid005 共 9B；sid004 无 part → 0
        { sessionId: 'sess_0198new0-0000-0000-0000-000000000005', data: '中文' },
        { sessionId: 'sess_0198new0-0000-0000-0000-000000000005', data: 'abc' },
      ],
    )
  })

  it('D8：排除 subagent_child，interactive/fork/selection_side_chat 全在列；字段映射/降序/total/dirs/cwdExists/size 字节口径', async () => {
    const reply = await makeSource(dbPath).listCandidates({})

    // D8 负面断言（A8 单测化）：subagent_child 行不出现在 items，也不计入 total
    expect(reply.total).toBe(4)
    expect(reply.items.map((i) => i.sessionId)).toEqual([
      'sess_0198new0-0000-0000-0000-000000000005',
      'sess_0198sid0-0000-0000-0000-000000000004',
      'sess_0198frk0-0000-0000-0000-000000000002',
      'sess_0198old0-0000-0000-0000-000000000001',
    ])

    const newest = reply.items[0]
    expect(newest.name).toBe('Newest interactive')
    expect(newest.cwd).toBe(existingDir)
    expect(newest.sourcePath).toBe(dbPath)
    expect(newest.lastModified).toBe(6000)
    expect(newest.dirLabel).toBe(basename(existingDir))
    expect(newest.cwdExists).toBe(true)
    expect(newest.alreadyImported).toBe(false)
    // 真字节口径：'中文' UTF-8 6B + 'abc' 3B = 9（字符数口径会是 3+3=6——CAST BLOB 断言区分）
    expect(newest.size).toBe(9)

    const side = reply.items[1]
    expect(side.cwdExists).toBe(true) // existingDir 真实存在
    expect(side.size).toBe(0) // 无 part 会话记 0
    const oldest = reply.items[3]
    expect(oldest.cwd).toBe('/tmp/zc-proj-alpha')
    expect(oldest.cwdExists).toBe(false)
    expect(oldest.dirLabel).toBe('zc-proj-alpha')

    // dirs：按 dirLabel 聚合自过滤前全集（label 排序），与搜索独立
    expect(reply.dirs).toEqual([
      { label: basename(existingDir), count: 2 },
      { label: 'zc-proj-alpha', count: 2 },
    ])
  })

  it('query 匹配：name / sessionId / directory / dirLabel，case-insensitive；sourcePath（db 路径占位）不参与', async () => {
    const source = makeSource(dbPath)
    // name（title）case-insensitive
    expect((await source.listCandidates({ query: 'NEWEST' })).items.map((i) => i.name))
      .toEqual(['Newest interactive'])
    // sessionId 整串（sess_ 前缀形态）
    expect((await source.listCandidates({ query: 'sess_0198frk0' })).items).toHaveLength(1)
    // directory
    expect((await source.listCandidates({ query: 'zc-proj-alpha' })).total).toBe(4) // total 过滤前
    expect((await source.listCandidates({ query: 'zc-proj-alpha' })).items).toHaveLength(2)
    // dirLabel case-insensitive（basename 形态命中同 directory 的全部候选）
    const byLabel = await source.listCandidates({ query: basename(existingDir).toUpperCase() })
    expect(byLabel.items).toHaveLength(2)
    // sourcePath 不参与匹配（db 文件名片段只存在于 dbPath，任何候选字段不含）
    expect((await source.listCandidates({ query: '.sqlite' })).items).toEqual([])
    // 无命中
    expect((await source.listCandidates({ query: 'zzzz-no-match' })).items).toEqual([])
  })

  it('limit 截断：items 截 N、total 恒为过滤前总数', async () => {
    const reply = await makeSource(dbPath).listCandidates({ limit: 2 })
    expect(reply.items).toHaveLength(2)
    expect(reply.total).toBe(4)
  })

  it('alreadyImported 归一化域：扫描集含归一化 id → 命中；含原始 sess_ 形态 → 不命中（失配对照）', async () => {
    const dbPath2 = join(fixturesRoot, 'zc-marked.sqlite')
    // sess_marked_0001 → 归一化 'marked-0001'；sess_plain_0002 → 'plain-0002'
    buildFixtureDb(
      dbPath2,
      [
        { id: 'sess_marked_0001', title: 'Marked', directory: '/tmp/zc-mark-cwd', taskType: 'interactive', timeCreated: 1000, timeUpdated: 1000 },
        { id: 'sess_plain_0002', title: 'Plain', directory: '/tmp/zc-plain-cwd', taskType: 'interactive', timeCreated: 2000, timeUpdated: 2000 },
      ],
      [],
    )
    // 预置太极扫描集：一个用归一化形态 id（应命中）、一个用原始 sess_ 形态 id（不应命中——
    // 扫描集是 header.id 域，原始形态直接比对失配即本断言的对照组）
    seedTaijiSession('marked-0001')
    seedTaijiSession('sess_plain_0002')
    invalidateScanDirCache()
    const scanned = new Set(scanPiSessions().map((s) => s.id))
    expect(scanned.has('marked-0001')).toBe(true)
    expect(scanned.has('sess_plain_0002')).toBe(true)

    const reply = await makeSource(dbPath2).listCandidates({})
    const marked = reply.items.find((i) => i.sessionId === 'sess_marked_0001')!
    const plain = reply.items.find((i) => i.sessionId === 'sess_plain_0002')!
    expect(marked.alreadyImported).toBe(true)
    expect(plain.alreadyImported).toBe(false)
  })

  it('alreadyImported 打标：单行 id 形态漂移 → 该行降级 false、列表不崩（导入侧 fail-fast 不受影响）', async () => {
    // 回归锚：打标输入 zcodeCandidateKey（=normalizeZcodeSessionId）后置条件不满足会抛，
    // 修复前单行坏 id 让整表崩溃（listCandidates 整体 import_invalid_session → 前端列表 404）；
    // 同条件在导入侧（prepareImport T1 校验）仍 fail-fast（下方 prepareImport describe 已锁定）
    const dbPath3 = join(fixturesRoot, 'zc-badid-list.sqlite')
    buildFixtureDb(
      dbPath3,
      [
        // 'sess_-badid-0001' 剥前缀后首字符 '-'，超出后置条件字符集（首尾必须字母数字）
        { id: 'sess_-badid-0001', title: 'Drifted id row', directory: '/tmp/zc-drift-cwd', taskType: 'interactive', timeCreated: 1000, timeUpdated: 1000 },
        { id: 'sess_goodid-0002', title: 'Good id row', directory: '/tmp/zc-drift-cwd', taskType: 'interactive', timeCreated: 2000, timeUpdated: 2000 },
      ],
      [],
    )
    const reply = await makeSource(dbPath3).listCandidates({})
    // 列表仍完整返回：坏 id 行不缺失、不拖垮其余行（warn 留痕不强制断言——降级 ≠ 吞错，
    // 日志通道与 conversion degraded 留痕共用 console，次数/顺序不是契约）
    expect(reply.total).toBe(2)
    const drifted = reply.items.find((i) => i.sessionId === 'sess_-badid-0001')!
    expect(drifted.alreadyImported).toBe(false)
    expect(reply.items.find((i) => i.sessionId === 'sess_goodid-0002')!.alreadyImported).toBe(false)
    // 导入侧同条件保持 fail-fast（降级只在列表展示面，幂等防线不放松）
    await expect(catchCode(() => makeSource(dbPath3).prepareImport({ sourcePath: '', projectId: 'p', source: 'zcode', sessionId: 'sess_-badid-0001', dbPath: dbPath3 })))
      .resolves.toBe('import_invalid_session')
  })

  it('db 不存在 → import_source_missing（listCandidates 与 prepareImport 同映射）', async () => {
    const missing = join(fixturesRoot, 'no-such.sqlite')
    expect(existsSync(missing)).toBe(false)
    const source = makeSource(missing)
    await expect(catchCode(() => source.listCandidates({}))).resolves.toBe('import_source_missing')
    await expect(catchCode(() => source.prepareImport({ sourcePath: '', projectId: 'p', source: 'zcode', sessionId: 'sess_x', dbPath: missing })))
      .resolves.toBe('import_source_missing')
  })

  it('schema 漂移（session 表缺失）→ import_invalid_session，message 带 schema_migration 版本', async () => {
    const drifted = join(fixturesRoot, 'zc-drifted.sqlite')
    buildFixtureDb(drifted, [], [], { omitSessionTable: true, schemaVersion: '9.9.9' })
    const source = makeSource(drifted)
    await expect(catchCode(() => source.listCandidates({}))).resolves.toBe('import_invalid_session')
    try {
      await source.prepareImport({ sourcePath: '', projectId: 'p', source: 'zcode', sessionId: 'sess_x', dbPath: drifted })
      expect.unreachable('expected prepareImport to throw')
    } catch (e) {
      expect(codeOf(e)).toBe('import_invalid_session')
      expect((e as Error).message).toContain('9.9.9')
    }
  })
})

describe('ZcodeImportSource.prepareImport（T1 header/fileName 全量）', () => {
  let dbPath: string

  beforeAll(() => {
    dbPath = join(fixturesRoot, 'zc-prepare.sqlite')
    buildFixtureDb(
      dbPath,
      [
        { id: 'sess_0198prep0-0000-0000-0000-00000000000a', title: 'Prepare me', directory: '/tmp/zc-prep-cwd', taskType: 'interactive', timeCreated: 1767225600000, timeUpdated: 1767225700000 },
      ],
      [],
    )
  })

  it('header = {归一化 id, ISO(time_created), directory}；fileName 尾段 === header.id（不变量）', async () => {
    const artifact = await makeSource(dbPath).prepareImport({
      sourcePath: '',
      projectId: 'p',
      source: 'zcode',
      sessionId: 'sess_0198prep0-0000-0000-0000-00000000000a',
      dbPath,
    })
    const normalized = '0198prep0-0000-0000-0000-00000000000a'
    expect(artifact.header).toEqual({ id: normalized, timestamp: '2026-01-01T00:00:00.000Z', cwd: '/tmp/zc-prep-cwd' })
    // ISO 段 ：→. 后与归一化 id 均不含 '_'，文件名唯一 '_' 即分隔符
    expect(artifact.fileName).toBe(`2026-01-01T00.00.00.000Z_${normalized}.jsonl`)
    expect(artifact.fileName.replace(/\.jsonl$/, '').split('_').pop()).toBe(normalized)
    // prepareImport 时点 degradations 恒空（转换在 write 闭包内发生，明细 write 后才可见）
    expect(artifact.degradations).toEqual([])
    // write 落地产物（U4 转换器）：空会话（无 message 行）= 首行 header + 第 2 行 session_info
    const tmpPath = join(fixturesRoot, 'zc-tmp.jsonl')
    await artifact.write(tmpPath)
    const outLines = readFileSync(tmpPath, 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(outLines).toHaveLength(2)
    expect(outLines[0]).toEqual({ type: 'session', version: 3, id: normalized, timestamp: '2026-01-01T00:00:00.000Z', cwd: '/tmp/zc-prep-cwd' })
    expect(outLines[1]?.type).toBe('session_info')
    expect((outLines[1] as { name?: unknown }).name).toBe('Prepare me')
    expect(artifact.degradations).toEqual([])
  })

  it('sessionId 缺失 / 不在库中 → import_invalid_session', async () => {
    const source = makeSource(dbPath)
    await expect(catchCode(() => source.prepareImport({ sourcePath: '', projectId: 'p', source: 'zcode', dbPath })))
      .resolves.toBe('import_invalid_session')
    await expect(catchCode(() => source.prepareImport({ sourcePath: '', projectId: 'p', source: 'zcode', sessionId: 'sess_no_such', dbPath })))
      .resolves.toBe('import_invalid_session')
  })

  it('归一化后置条件不满足在此 fail-fast（不进 write 阶段）：id 剥前缀后为空', async () => {
    // 库中放一行 id='sess_' 的会话（超出已验证域 sess_<uuid>，模拟 id 值形态漂移）
    const dbPath2 = join(fixturesRoot, 'zc-badid.sqlite')
    buildFixtureDb(
      dbPath2,
      [{ id: 'sess_', title: 'Bad id', directory: '/tmp/zc-bad-cwd', taskType: 'interactive', timeCreated: 1000, timeUpdated: 1000 }],
      [],
    )
    await expect(catchCode(() => makeSource(dbPath2).prepareImport({ sourcePath: '', projectId: 'p', source: 'zcode', sessionId: 'sess_', dbPath: dbPath2 })))
      .resolves.toBe('import_invalid_session')
  })
})
