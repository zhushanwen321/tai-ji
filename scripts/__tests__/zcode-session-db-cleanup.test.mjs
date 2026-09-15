/**
 * scripts/zcode-session-db-cleanup.mjs fixture 级验证（impl-plan §2.5 W5a / 设计 A11）。
 *
 * 全部宿主库 / 索引库 / records JSONL 用 mkdtempSync 假库构造，禁触真实
 * ~/.zcode 与 ~/.taiji。索引删除失败用 BEFORE DELETE 触发器 RAISE(ABORT) 模拟
 * （索引库零 FK，无其他可控失败注入点）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import {
  I2_TOLERANCE_MS,
  parseRecordWhitelist,
  analyze,
  executeDeletion,
  replayResidue,
  resolveExecutionMode,
  assertDerivedInvariant,
  CleanupAbortError,
  runCli,
  buildPlanText,
  zcodeSessionDbPathJs,
} from '../zcode-session-db-cleanup.mjs'

const T0 = 1_700_000_000_000

function createHostDb(file) {
  const db = new DatabaseSync(file)
  db.exec(`
    CREATE TABLE session(
      id TEXT PRIMARY KEY,
      parent_id TEXT REFERENCES session(id) ON DELETE SET NULL,
      task_type TEXT NOT NULL,
      title_source TEXT,
      time_created INTEGER
    );
    CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE);
    CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE, session_id TEXT NOT NULL);
    CREATE TABLE model_usage(session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE, tokens INTEGER);
    CREATE TABLE input_history(session_id TEXT NOT NULL, text TEXT);
    CREATE TABLE session_task_link(session_id TEXT REFERENCES session(id) ON DELETE CASCADE, parent_session_id TEXT REFERENCES session(id) ON DELETE SET NULL);
  `)
  return db
}

function createIndexDb(file) {
  const db = new DatabaseSync(file)
  db.exec(`
    CREATE TABLE tasks(task_id TEXT PRIMARY KEY, forked_from_task_id TEXT, off_peak_task_id TEXT);
    CREATE TABLE task_group_members(task_id TEXT);
    CREATE TABLE automations(target_task_id TEXT);
    CREATE TABLE off_peak_tasks(session_id TEXT);
    CREATE TABLE automation_runs(session_id TEXT);
  `)
  return db
}

function insertSession(db, { id, parent = null, type = 'interactive', title = 'generated', created = T0 }) {
  db.prepare('INSERT INTO session(id, parent_id, task_type, title_source, time_created) VALUES (?,?,?,?,?)').run(id, parent, type, title, created)
  db.prepare('INSERT INTO message(id, session_id) VALUES (?,?)').run(`m_${id}`, id)
  db.prepare('INSERT INTO part(id, message_id, session_id) VALUES (?,?,?)').run(`p_${id}`, `m_${id}`, id)
  db.prepare('INSERT INTO model_usage(session_id, tokens) VALUES (?,?)').run(id, 1)
  db.prepare('INSERT INTO input_history(session_id, text) VALUES (?,?)').run(id, 'x')
}

/** 写 record JSONL：含 zsw 侧样本（另一文件、同 schema）+ 噪音行（非 record entry / 坏 JSON / 未知版本）。 */
function writeRecords(dir, rows, { extraFile } = {}) {
  const entry = (sid, startedAt, extra = {}) =>
    JSON.stringify({ type: 'custom', customType: 'subagent-record', data: { v: 1, id: `rec_${sid}`, engine: 'zcode', startedAt, engineHandle: { sessionRef: { sessionId: sid, dbPath: '/x/db.sqlite' }, poolKey: 'shared' }, ...extra } })
  const lines = [
    JSON.stringify({ type: 'custom', customType: 'subagent-identity', data: {} }),
    '{not json',
    JSON.stringify({ type: 'custom', customType: 'subagent-record', data: { v: 2, engineHandle: { sessionRef: { sessionId: 'sess_v2_unknown' } } } }),
    JSON.stringify({ type: 'message', role: 'user', content: '"sessionId":"sess_regex_trap"' }),
  ]
  for (const r of rows) lines.push(entry(r.sessionId, r.startedAt))
  writeFileSync(join(dir, 'root-a.jsonl'), lines.join('\n') + '\n')
  if (extraFile) writeFileSync(join(dir, 'zsw-b.jsonl'), extraFile.map((r) => entry(r.sessionId, r.startedAt)).join('\n') + '\n')
}

describe('zcode-session-db-cleanup', () => {
  let tmp, hostDbPath, indexDbPath, recordsDir, outDir
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'w5-cleanup-'))
    hostDbPath = join(tmp, 'host.sqlite')
    indexDbPath = join(tmp, 'index.sqlite')
    recordsDir = join(tmp, 'sessions')
    outDir = join(tmp, 'out')
    for (const d of [recordsDir, outDir]) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    mkdirSync(recordsDir)
    mkdirSync(outDir)
  })
  afterEach(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }))

  /** 标准 fixture：白名单 4（2 命中宿主 + 1 池时代不在宿主 + 1 zsw 侧命中）；派生 1；用户会话若干。 */
  function seedStandard() {
    const host = createHostDb(hostDbPath)
    insertSession(host, { id: 'sess_ours_1', created: T0 + 1500 })
    insertSession(host, { id: 'sess_ours_2', created: T0 + 10_000 + 3000, title: 'first_input' })
    insertSession(host, { id: 'sess_zsw_1', created: T0 + 20_000 })
    insertSession(host, { id: 'sess_child_1', parent: 'sess_ours_1', type: 'subagent_child' })
    insertSession(host, { id: 'sess_user_1', created: T0 + 2000 })
    insertSession(host, { id: 'sess_user_fork', parent: 'sess_user_1', type: 'fork' })
    host.close()
    const idx = createIndexDb(indexDbPath)
    for (const id of ['sess_ours_1', 'sess_ours_2', 'sess_zsw_1', 'sess_child_1', 'sess_user_1']) idx.prepare('INSERT INTO tasks(task_id) VALUES (?)').run(id)
    idx.close()
    writeRecords(recordsDir, [
      { sessionId: 'sess_ours_1', startedAt: T0 },
      { sessionId: 'sess_ours_2', startedAt: T0 + 10_000 },
      { sessionId: 'sess_pool_era', startedAt: T0 },
    ], { extraFile: [{ sessionId: 'sess_zsw_1', startedAt: T0 + 20_000 + 4000 }] })
  }

  it('白名单只来自结构化 subagent-record entry（噪音行/坏 JSON/未知版本/正文文本陷阱全部不入）', () => {
    seedStandard()
    const wl = parseRecordWhitelist(recordsDir)
    expect(wl.map((r) => r.sessionId).sort()).toEqual(['sess_ours_1', 'sess_ours_2', 'sess_pool_era', 'sess_zsw_1'])
    expect(wl.find((r) => r.sessionId === 'sess_zsw_1').startedAt).toBe(T0 + 24_000)
  })

  it('I1 四数分列正确且与 counts.sql 参照 SQL 一致（白名单 4 / 直接 3 / 派生 1 / 总 4）', () => {
    seedStandard()
    const a = analyze({ whitelistRows: parseRecordWhitelist(recordsDir), hostDbPath, indexDbPath })
    expect(a.whitelistTotal).toBe(4)
    expect(a.directCount).toBe(3)
    expect(a.derivedCount).toBe(1)
    expect(a.deletionTotal).toBe(4)
    expect(a.direct.sort()).toEqual(['sess_ours_1', 'sess_ours_2', 'sess_zsw_1'])
    expect(a.derived).toEqual(['sess_child_1'])
    expect(a.indexConflictHits).toEqual([])
  })

  it('I2 超容差中止（差数小时的用户 interactive+generated id 混入 → 报告该 id）', () => {
    seedStandard()
    const wl = parseRecordWhitelist(recordsDir)
    wl.push({ sessionId: 'sess_user_1', startedAt: T0 + 3 * 3600_000 })
    expect(() => analyze({ whitelistRows: wl, hostDbPath, indexDbPath })).toThrow(CleanupAbortError)
    try { analyze({ whitelistRows: wl, hostDbPath, indexDbPath }) } catch (e) {
      expect(e.report).toContain('I2')
      expect(e.report).toContain('sess_user_1')
      expect(e.report).toContain(String(I2_TOLERANCE_MS))
    }
  })

  it('I2 startedAt 缺失 → 中止', () => {
    seedStandard()
    const wl = parseRecordWhitelist(recordsDir).map((r) => (r.sessionId === 'sess_ours_1' ? { ...r, startedAt: null } : r))
    expect(() => analyze({ whitelistRows: wl, hostDbPath, indexDbPath })).toThrow(/startedAt 缺失/)
  })

  it('I3 反向 fixture：混入用户 fork id（时间戳匹配）→ 形态校验中止', () => {
    seedStandard()
    const wl = parseRecordWhitelist(recordsDir)
    wl.push({ sessionId: 'sess_user_fork', startedAt: T0 })
    expect(() => analyze({ whitelistRows: wl, hostDbPath, indexDbPath })).toThrow(/I3 形态校验失败[\s\S]*sess_user_fork/)
  })

  it('I3 title_source=custom → 中止', () => {
    seedStandard()
    const host = new DatabaseSync(hostDbPath)
    host.prepare("UPDATE session SET title_source='custom' WHERE id='sess_ours_2'").run()
    host.close()
    expect(() => analyze({ whitelistRows: parseRecordWhitelist(recordsDir), hostDbPath, indexDbPath })).toThrow(/I3[\s\S]*sess_ours_2/)
  })

  it('I3b 派生集不变量：parent_id ∉ 直接集 或 task_type != subagent_child → 中止', () => {
    expect(() => assertDerivedInvariant(new Set(['a']), [{ id: 'c', parent_id: 'zzz', task_type: 'subagent_child' }])).toThrow(/I3b/)
    expect(() => assertDerivedInvariant(new Set(['a']), [{ id: 'c', parent_id: 'a', task_type: 'fork' }])).toThrow(/I3b/)
    expect(() => assertDerivedInvariant(new Set(['a']), [{ id: 'c', parent_id: 'a', task_type: 'subagent_child' }])).not.toThrow()
  })

  it('索引预检命中 → 两侧同时剔除并置顶报告；参照 SQL 同口径', () => {
    seedStandard()
    const idx = new DatabaseSync(indexDbPath)
    idx.prepare("INSERT INTO task_group_members(task_id) VALUES ('sess_ours_2')").run()
    idx.close()
    const a = analyze({ whitelistRows: parseRecordWhitelist(recordsDir), hostDbPath, indexDbPath })
    expect(a.indexConflictHits).toEqual(['sess_ours_2'])
    expect(a.direct).not.toContain('sess_ours_2')
    expect(a.deletionTotal).toBe(3)
    expect(a.anomalies[0]).toContain('sess_ours_2')
    const r = executeDeletion({ analysis: a, hostDbPath, indexDbPath, residueDir: outDir, authorizationSource: 'test' })
    const host = new DatabaseSync(hostDbPath, { readOnly: true })
    expect(host.prepare("SELECT COUNT(*) AS n FROM session WHERE id='sess_ours_2'").get().n).toBe(1)
    host.close()
    expect(r.deleted.sort()).toEqual(['sess_child_1', 'sess_ours_1', 'sess_zsw_1'])
  })

  it('执行：宿主 FK 级联 + input_history 显式删 + 派生行纳入；索引面 N→0；凭证与删除集总数匹配', () => {
    seedStandard()
    const a = analyze({ whitelistRows: parseRecordWhitelist(recordsDir), hostDbPath, indexDbPath })
    const r = executeDeletion({ analysis: a, hostDbPath, indexDbPath, residueDir: outDir, operator: 'tester', authorizationSource: '--confirm-count', now: T0 })
    expect(r.residue).toEqual([])
    expect(r.residueFile).toBeNull()
    expect(r.inputHistoryDeleted).toBe(4)
    const host = new DatabaseSync(hostDbPath, { readOnly: true })
    const ids = ['sess_ours_1', 'sess_ours_2', 'sess_zsw_1', 'sess_child_1']
    for (const t of ['session', 'message', 'part', 'model_usage', 'input_history']) {
      const col = t === 'session' ? 'id' : 'session_id'
      expect(host.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE ${col} IN (?,?,?,?)`).get(...ids).n, t).toBe(0)
    }
    expect(host.prepare('SELECT COUNT(*) AS n FROM session').get().n).toBe(2)
    host.close()
    const idx = new DatabaseSync(indexDbPath, { readOnly: true })
    expect(idx.prepare('SELECT COUNT(*) AS n FROM tasks WHERE task_id IN (?,?,?,?)').get(...ids).n).toBe(0)
    expect(idx.prepare("SELECT COUNT(*) AS n FROM tasks WHERE task_id='sess_user_1'").get().n).toBe(1)
    idx.close()
    const cred = JSON.parse(readFileSync(r.credentialFile, 'utf8'))
    expect(cred).toMatchObject({ phrase: 'DELETE 4', operator: 'tester', authorizationSource: '--confirm-count', deletionTotal: 4, timestamp: new Date(T0).toISOString() })
  })

  it('索引删除中途失败 → 残留清单落盘（宿主已删、索引残留）；replay 补删后归空', async () => {
    seedStandard()
    const idx = new DatabaseSync(indexDbPath)
    idx.exec("CREATE TRIGGER fail_once BEFORE DELETE ON tasks WHEN OLD.task_id='sess_ours_2' BEGIN SELECT RAISE(ABORT,'simulated index failure'); END;")
    idx.close()
    const a = analyze({ whitelistRows: parseRecordWhitelist(recordsDir), hostDbPath, indexDbPath })
    const r = executeDeletion({ analysis: a, hostDbPath, indexDbPath, residueDir: outDir, authorizationSource: 'test', now: T0 })
    expect(r.residue).toEqual(['sess_ours_2'])
    expect(r.deleted).toHaveLength(3)
    expect(existsSync(r.residueFile)).toBe(true)
    const host = new DatabaseSync(hostDbPath, { readOnly: true })
    expect(host.prepare("SELECT COUNT(*) AS n FROM session WHERE id='sess_ours_2'").get().n).toBe(0)
    host.close()
    let i = new DatabaseSync(indexDbPath)
    expect(i.prepare("SELECT COUNT(*) AS n FROM tasks WHERE task_id='sess_ours_2'").get().n).toBe(1)
    i.exec('DROP TRIGGER fail_once')
    i.close()
    const out = await runCli({ argv: ['--replay-residue', r.residueFile, '--confirm-count', '1', '--host-db', hostDbPath, '--index-db', indexDbPath], isTTY: false, outDir })
    expect(out.exitCode).toBe(0)
    expect(out.report).toContain('残留清单剩余：空')
    i = new DatabaseSync(indexDbPath, { readOnly: true })
    expect(i.prepare("SELECT COUNT(*) AS n FROM tasks WHERE task_id='sess_ours_2'").get().n).toBe(0)
    i.close()
  })

  it('宿主 FK 删除失败 → id 不计 deleted、不进 residue、单独落 fkFailures（报告不自相矛盾）', () => {
    seedStandard()
    // 诱导宿主侧 FK 失败：新增引用表挂住 sess_ours_2
    const host = new DatabaseSync(hostDbPath)
    host.exec('CREATE TABLE fk_guard (sid TEXT NOT NULL REFERENCES session(id))')
    host.prepare("INSERT INTO fk_guard(sid) VALUES ('sess_ours_2')").run()
    host.close()
    const a = analyze({ whitelistRows: parseRecordWhitelist(recordsDir), hostDbPath, indexDbPath })
    const r = executeDeletion({ analysis: a, hostDbPath, indexDbPath, residueDir: outDir, authorizationSource: 'test', now: T0 })
    expect(r.fkFailures).toHaveLength(1)
    expect(r.fkFailures[0]).toContain('sess_ours_2')
    // 修复锚定：FK 失败 id 既不在 deleted 也不在 residue（replay 前提 = 宿主已删，
    // FK 失败不满足；补删通道 = 解依赖后重跑清理，不走 residue 清单）
    expect(r.deleted.sort()).toEqual(['sess_child_1', 'sess_ours_1', 'sess_zsw_1'])
    expect(r.residue).toEqual([])
    const h = new DatabaseSync(hostDbPath, { readOnly: true })
    expect(h.prepare("SELECT COUNT(*) AS n FROM session WHERE id='sess_ours_2'").get().n).toBe(1)
    h.close()
    const i = new DatabaseSync(indexDbPath, { readOnly: true })
    expect(i.prepare("SELECT COUNT(*) AS n FROM tasks WHERE task_id='sess_ours_2'").get().n).toBe(1)
    i.close()
  })

  it('R9-4 replay fixture ①：篡改清单混入真实用户索引 id（宿主行仍存在）→ 拒删并报告', () => {
    seedStandard()
    const file = join(outDir, 'w5-residue-tampered.json')
    writeFileSync(file, JSON.stringify({ schema: 'w5-residue-v1', residueIds: ['sess_user_1'] }))
    const r = replayResidue({ residueFile: file, hostDbPath, indexDbPath })
    expect(r.status).toBe('refused')
    expect(r.reason).toContain('sess_user_1')
    expect(r.deleted).toEqual([])
    const idx = new DatabaseSync(indexDbPath, { readOnly: true })
    expect(idx.prepare("SELECT COUNT(*) AS n FROM tasks WHERE task_id='sess_user_1'").get().n).toBe(1)
    idx.close()
  })

  it('R9-4 replay fixture ②：过期 id（已不在索引）→ no-op 报告；冲突源命中 → 跳过并报告', () => {
    seedStandard()
    const host = new DatabaseSync(hostDbPath)
    host.exec('PRAGMA foreign_keys=ON')
    host.prepare("DELETE FROM session WHERE id IN ('sess_ours_1','sess_ours_2')").run()
    host.close()
    const idx = new DatabaseSync(indexDbPath)
    idx.prepare("DELETE FROM tasks WHERE task_id='sess_ours_1'").run()
    idx.prepare("INSERT INTO off_peak_tasks(session_id) VALUES ('sess_ours_2')").run()
    idx.close()
    const file = join(outDir, 'w5-residue-stale.json')
    writeFileSync(file, JSON.stringify({ schema: 'w5-residue-v1', residueIds: ['sess_ours_1', 'sess_ours_2'] }))
    const r = replayResidue({ residueFile: file, hostDbPath, indexDbPath })
    expect(r.status).toBe('ok')
    expect(r.noop).toEqual(['sess_ours_1'])
    expect(r.skipped).toEqual(['sess_ours_2'])
    expect(r.deleted).toEqual([])
  })

  it('replay 前置：形状非法 id 拒删；--confirm-count 须等于清单条数', async () => {
    seedStandard()
    const file = join(outDir, 'w5-residue-bad.json')
    writeFileSync(file, JSON.stringify({ schema: 'w5-residue-v1', residueIds: ['bad id\n'] }))
    expect(replayResidue({ residueFile: file, hostDbPath, indexDbPath }).status).toBe('refused')
    const out = await runCli({ argv: ['--replay-residue', file, '--confirm-count', '2', '--host-db', hostDbPath, '--index-db', indexDbPath], isTTY: false, outDir })
    expect(out.exitCode).toBe(2)
    expect(out.report).toContain('清单条数 1')
    const noCount = await runCli({ argv: ['--replay-residue', file, '--host-db', hostDbPath, '--index-db', indexDbPath], isTTY: true, outDir })
    expect(noCount.exitCode).toBe(2)
  })

  it('执行形态：无参数非 TTY → 拒绝且零删除；--confirm-count 错值拒绝、精确匹配执行', async () => {
    seedStandard()
    const base = ['--records-dir', recordsDir, '--host-db', hostDbPath, '--index-db', indexDbPath]
    expect(resolveExecutionMode({ isTTY: false }).mode).toBe('refuse')
    expect(resolveExecutionMode({ isTTY: true }).mode).toBe('interactive')
    expect(resolveExecutionMode({ isTTY: false, confirmCount: 4 }).mode).toBe('confirm-count')

    const refused = await runCli({ argv: base, isTTY: false, outDir })
    expect(refused.exitCode).toBe(2)
    expect(refused.report).toContain('拒绝')
    expect(refused.report).toContain('删除集总数：4')
    const wrong = await runCli({ argv: [...base, '--confirm-count', '3'], isTTY: false, outDir })
    expect(wrong.exitCode).toBe(2)
    let host = new DatabaseSync(hostDbPath, { readOnly: true })
    expect(host.prepare('SELECT COUNT(*) AS n FROM session').get().n).toBe(6)
    host.close()
    expect(readdirSync(outDir)).toEqual([])

    const ok = await runCli({ argv: [...base, '--confirm-count', '4'], isTTY: false, outDir, now: T0 })
    expect(ok.exitCode).toBe(0)
    expect(ok.report).toContain('残留清单归空')
    host = new DatabaseSync(hostDbPath, { readOnly: true })
    expect(host.prepare('SELECT COUNT(*) AS n FROM session').get().n).toBe(2)
    host.close()
    const files = readdirSync(outDir)
    expect(files.some((f) => f.startsWith('w5-cleanup-credential-'))).toBe(true)
    expect(files.some((f) => f.startsWith('w5-residue-'))).toBe(false)
  })

  it('交互确认：stdin 输入删除集总数才执行；输入不符零删除', async () => {
    seedStandard()
    const base = ['--records-dir', recordsDir, '--host-db', hostDbPath, '--index-db', indexDbPath]
    const bad = new PassThrough()
    const p1 = runCli({ argv: base, isTTY: true, stdin: bad, outDir })
    bad.end('3\n')
    expect((await p1).exitCode).toBe(2)
    let host = new DatabaseSync(hostDbPath, { readOnly: true })
    expect(host.prepare('SELECT COUNT(*) AS n FROM session').get().n).toBe(6)
    host.close()

    const good = new PassThrough()
    const p2 = runCli({ argv: base, isTTY: true, stdin: good, outDir, now: T0 })
    good.end('4\n')
    const out = await p2
    expect(out.exitCode).toBe(0)
    expect(out.report).toContain('interactive-stdin-confirm')
    const cred = JSON.parse(readFileSync(join(outDir, readdirSync(outDir).find((f) => f.startsWith('w5-cleanup-credential-'))), 'utf8'))
    expect(cred.authorizationSource).toBe('interactive-stdin-confirm')
    expect(cred.deletionTotal).toBe(4)
  })

  it('分析中止时报告置顶异常汇总且不删除', async () => {
    seedStandard()
    const host = new DatabaseSync(hostDbPath)
    host.prepare("UPDATE session SET time_created=? WHERE id='sess_ours_1'").run(T0 + 5 * 3600_000)
    host.close()
    const out = await runCli({ argv: ['--records-dir', recordsDir, '--host-db', hostDbPath, '--index-db', indexDbPath, '--confirm-count', '4'], isTTY: false, outDir })
    expect(out.exitCode).toBe(1)
    expect(out.report.startsWith('== 异常信号汇总（置顶）==')).toBe(true)
    expect(out.report).toContain('sess_ours_1')
  })

  it('--plan：三库快照清单 + 写者清单（R9-5 pgrep 断言 / R9-6 手动终端项）', () => {
    const text = buildPlanText({ homeDir: '/h', dataDir: '/d' })
    expect(text).toContain('/h/.zcode/cli/db/db.sqlite')
    expect(text).toContain('/h/.zcode/v2/tasks-index.sqlite')
    expect(text).toContain(zcodeSessionDbPathJs('/d'))
    expect(text).toContain('pgrep -flE "zsw|zcode.*app-server"')
    expect(text).toContain('④')
    expect(text).toContain('用户手动终端 zcode CLI')
    expect(text).toMatch(/①.*硬停/)
    expect(text).toMatch(/③.*硬停/)
  })
})
