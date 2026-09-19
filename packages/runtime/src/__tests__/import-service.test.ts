/**
 * ImportService 测试（import-session 设计 §3.3 U2 + 多源 §3.3 SPI 编排层化）。
 *
 * 锁定行为：
 * - 编排层 source 路由：缺省不传 source = 显式 'pi'（向后兼容，存量调用路径行为不变）；
 *   注册表缺项防御（import_source_missing）；degradations 非空 → warning
 *   conversion_degraded（stub source 注入）；sidecar_failed 优先级 + degradations 日志留痕
 * - listCandidates（pi source 语义，零回归）：字段面 / lastModified 降序 / total（过滤前）/
 *   dirs 聚合 / cwdExists 标注 / alreadyImported 打标（导入后立即翻转）/ query 匹配语义
 *   （name∪sessionId∪短ID∪sourcePath∪dirLabel，case-insensitive）/ rootDir 缺省 =
 *   getPiGlobalAgentDir()/sessions 动态推导
 * - importSession（编排序列，零回归）：幂等 already_imported（顺序 + 并发双击两型）、
 *   同 target 异 id target_conflict、copy 失败无残留 + 互斥链异常安全第二跳、marker 文件名
 *   拒绝、projectId 空串/不存在拒绝、sidecar readback 不符 → 成功 + warning（文件不回滚）、
 *   targetPath 构造（encodeCwd(resolve(cwd))）
 *
 * 夹具：os.tmpdir() 真实形态 header jsonl（与 scan-external.test.ts 同手法），afterAll 清理。
 * copy 失败注入：vi.mock 拦截 node:fs/promises.copyFile（failNext 单次翻转，其余透传 actual），
 * 平台无关、不依赖权限位。
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ImportSourceKind } from '@taiji/shared'

// copyFile 失败注入开关（vi.hoisted：vi.mock 工厂提升后仍可引用）。
const copyFailureState = vi.hoisted(() => ({ failNext: false }))

// getPiGlobalAgentDir 定向覆盖（缺省 rootDir 用例）：真实推导在 TAIJI_AGENT_DATA_DIR 指向
// dev/真实数据目录时会解析到 ~/.pi/agent（用户 pi CLI 目录）——fs-guard 会正确拦截。
// 用例改由 mock 定向指到 tmp fixture，精确测「缺省 rootDir = getPiGlobalAgentDir()/sessions」
// 的接线逻辑，不依赖运行时 env 巧合（vi.hoisted 同上）。
const piGlobalDirState = vi.hoisted(() => ({ dir: '' }))

vi.mock('../infra/pi/pi-maintenance.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../infra/pi/pi-maintenance.js')>()
  return {
    ...actual,
    getPiGlobalAgentDir: () => piGlobalDirState.dir,
  }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    copyFile: async (...args: Parameters<typeof actual.copyFile>) => {
      if (copyFailureState.failNext) {
        copyFailureState.failNext = false
        throw new Error('simulated copy failure (disk full)')
      }
      return actual.copyFile(...args)
    },
  }
})

import { encodeCwd, getSessionsDir } from '../infra/pi/pi-paths.js'
import { getPiGlobalAgentDir } from '../infra/pi/pi-maintenance.js'
import { ImportService, ImportServiceError } from '../services/session/import-service.js'
import { ExternalFileImportSource } from '../services/session/import-source-external-file.js'
import type { SessionImportSource } from '../services/session/import-source.js'
// B5 摘碑双路径②验证（memory-leak-remediation §3.2-B5）：import 同 id 复活的 tombstone 摘除
import { SessionDataStore, isSessionDataCleared } from '../services/plugin-service/session-data-store.js'

let fixturesRoot: string

/** 手写真实形态 session JSONL：首行 header（type/version/id/cwd/timestamp）+ session_info + message。 */
function writeSessionJsonl(filePath: string, id: string, cwd: string, name: string): void {
  const lines = [
    JSON.stringify({ type: 'session', version: 1, id, cwd, timestamp: '2026-01-01T00:00:00.000Z' }),
    JSON.stringify({ type: 'session_info', name }),
    JSON.stringify({
      type: 'message', id: `m-${id}`, parentId: null, timestamp: '2026-01-01T00:00:01.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    }),
    '',
  ]
  writeFileSync(filePath, lines.join('\n'))
}

/** 与组合根装配同构（index.ts）：pi source 的 rootDir 缺省 = pi 全局 sessions 动态推导（惰性求值）。 */
function makePiSources(): Map<ImportSourceKind, SessionImportSource> {
  return new Map<ImportSourceKind, SessionImportSource>([
    ['pi', new ExternalFileImportSource({ getRootDir: () => join(getPiGlobalAgentDir(), 'sessions') })],
  ])
}

function makeImportService(sources: ReadonlyMap<ImportSourceKind, SessionImportSource> = makePiSources()): ImportService {
  return new ImportService({
    projects: { load: () => ({ projects: [{ id: 'proj-1' }], activeProjectId: '' }) },
    sources,
  })
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
  return expect.unreachable('expected ImportServiceError but import succeeded')
}

beforeAll(() => {
  fixturesRoot = mkdtempSync(join(tmpdir(), 'import-service-'))
})

afterAll(() => {
  rmSync(fixturesRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  // [HISTORICAL] 2026-09-02 会话丢失事故修复：此处原有 rmSync(getSessionsDir(), { recursive: true })——
  // 删除共享推导路径（落在哪个 dataDir 由 env 决定，env 异常时等于删用户真实会话目录，
  // 当日即删光当时 sessions 推导路径（旧布局 pi/ 子层）致三个 pi 进程 ENOENT 崩溃）。ImportService 的
  // 落盘目标在 globalSetup 注入的 tmp dataDir 下，由 global-setup teardown 统一回收。
})

describe('ImportService.listCandidates', () => {
  it('字段面 / lastModified 降序 / total / dirs 聚合 / cwdExists / dirLabel', async () => {
    const root = join(fixturesRoot, 'cand-root')
    const sub = join(root, 'proj-alpha')
    mkdirSync(sub, { recursive: true })
    const existingCwd = join(fixturesRoot, 'cwd-alpha')
    mkdirSync(existingCwd, { recursive: true })
    writeSessionJsonl(join(sub, 'a1.jsonl'), 'cand-a1-000001', existingCwd, 'Alpha One')
    writeSessionJsonl(join(root, 'a2.jsonl'), 'cand-a2-000002', join(fixturesRoot, 'no-such-cwd'), 'Alpha Two')

    const svc = makeImportService()
    const reply = await svc.listCandidates({ rootDir: root })
    expect(reply.total).toBe(2)
    expect(reply.items).toHaveLength(2)
    // a2 后写 → lastModified 更新 → 降序在前
    expect(reply.items[0].sessionId).toBe('cand-a2-000002')

    const a1 = reply.items.find((i) => i.sessionId === 'cand-a1-000001')!
    expect(a1.name).toBe('Alpha One')
    expect(a1.cwd).toBe(existingCwd)
    expect(a1.sourcePath).toBe(join(sub, 'a1.jsonl'))
    expect(a1.dirLabel).toBe('proj-alpha')
    expect(a1.cwdExists).toBe(true)
    expect(a1.alreadyImported).toBe(false)
    expect(typeof a1.lastModified).toBe('number')
    expect(a1.size).toBeGreaterThan(0)

    const a2 = reply.items.find((i) => i.sessionId === 'cand-a2-000002')!
    expect(a2.dirLabel).toBe('')
    expect(a2.cwdExists).toBe(false)

    // dirs 只聚合一层子目录（顶层条目不入 dirs），计数为过滤前候选数
    expect(reply.dirs).toEqual([{ label: 'proj-alpha', count: 1 }])
  })

  it('query 匹配：name / 短 ID / dirLabel / sourcePath，全部 case-insensitive', async () => {
    const root = join(fixturesRoot, 'query-root')
    mkdirSync(join(root, 'ProjX'), { recursive: true })
    writeSessionJsonl(join(root, 'ProjX', 'f1.jsonl'), 'query-winter1', '/tmp/query-cwd', 'Winter Report')
    writeSessionJsonl(join(root, 'q2.jsonl'), 'query-other2', '/tmp/query-cwd', 'Summer Report')
    const svc = makeImportService()

    // name case-insensitive
    expect((await svc.listCandidates({ rootDir: root, query: 'WINTER' })).items.map((i) => i.sessionId))
      .toEqual(['query-winter1'])
    // uuid 前 6 位短 ID（query-other2 的 slice(0,6)）
    expect((await svc.listCandidates({ rootDir: root, query: 'query-o' })).items.map((i) => i.sessionId))
      .toEqual(['query-other2'])
    // dirLabel case-insensitive（只 ProjX 子目录下的条目命中）
    const byDir = await svc.listCandidates({ rootDir: root, query: 'projx' })
    expect(byDir.items).toHaveLength(1)
    expect(byDir.items[0].sessionId).toBe('query-winter1')
    // sourcePath
    expect((await svc.listCandidates({ rootDir: root, query: 'f1.jsonl' })).items).toHaveLength(1)
    // total 恒为过滤前总数
    expect((await svc.listCandidates({ rootDir: root, query: 'WINTER' })).total).toBe(2)
    // limit 截断
    expect((await svc.listCandidates({ rootDir: root, limit: 1 })).items).toHaveLength(1)
  })

  it('候选含 header 缺 id 的 jsonl 时 query 搜索不崩、结果不含该文件（宽松收录回归）', async () => {
    // 回归锚：修复前 external-scan 宽松收录缺 id header（ExternalSessionMeta.id===undefined），
    // matchesQuery 的 item.sessionId.slice(0, SHORT_ID_LENGTH) TypeError → 任意 query 下
    // listCandidates 整体崩溃（RPC 兜底 import_failed，搜索功能不可用）；无 query 打开
    // 列表不崩，故本用例必须带 query 触发崩溃路径
    const root = join(fixturesRoot, 'no-id-query-root')
    mkdirSync(root, { recursive: true })
    writeSessionJsonl(join(root, 'good.jsonl'), 'noidq-good-0001', '/tmp/noidq-cwd', 'GoodSession')
    writeFileSync(join(root, 'no-id.jsonl'), [
      JSON.stringify({ type: 'session', version: 1, cwd: '/tmp/noidq-cwd', timestamp: '2026-01-01T00:00:00.000Z' }),
      '',
    ].join('\n'))

    const svc = makeImportService()
    // 任意搜索词：不抛错（修复前在此 TypeError）。搜索词用长哨兵串而非短词——
    // [HISTORICAL 2026-09-15] 曾用 query 'xx'，CI 上 mkdtemp 随机后缀恰好为
    // 'bWC4Xx'（含大小写不敏感的 'xx'），sourcePath 子串匹配意外命中 good 会话
    // → 断言「结果为空」偶发红；短查询词会撞随机路径，哨兵串（含连字符 +
    // 4 连字符外字符）在 mkdtemp 字母表与 fixture 字段中不可能出现。
    const reply = await svc.listCandidates({ rootDir: root, query: 'zzzz-no-match' })
    expect(reply.items).toEqual([])
    // 无 query 的全集同样不含该文件（候选侧前置拒收，与导入侧 import_invalid_session 同清单）
    const full = await svc.listCandidates({ rootDir: root })
    expect(full.total).toBe(1)
    expect(full.items.some((i) => i.sourcePath.endsWith('no-id.jsonl'))).toBe(false)
    expect(full.items[0].sessionId).toBe('noidq-good-0001')
  })

  it('alreadyImported：导入后立即翻转（invalidateScanDirCache 生效）', async () => {
    const root = join(fixturesRoot, 'mark-root')
    mkdirSync(root, { recursive: true })
    const src = join(root, 'm1.jsonl')
    writeSessionJsonl(src, 'mark-id-000001', '/tmp/mark-cwd', 'MarkMe')
    const svc = makeImportService()

    const before = await svc.listCandidates({ rootDir: root })
    expect(before.items[0].alreadyImported).toBe(false)

    const imported = await svc.importSession({ sourcePath: src, projectId: 'proj-1' })
    expect(imported.sessionId).toBe('mark-id-000001')
    expect(imported.warning).toBeUndefined()
    // targetPath = getSessionsDir()/encodeCwd(resolve(cwd))/原文件名
    expect(imported.targetPath).toBe(join(getSessionsDir(), encodeCwd('/tmp/mark-cwd'), 'm1.jsonl'))
    expect(existsSync(imported.targetPath)).toBe(true)
    expect(existsSync(src)).toBe(true) // 复制语义：源文件不动（P-isolation 结构面）

    const after = await svc.listCandidates({ rootDir: root })
    expect(after.items[0].alreadyImported).toBe(true)
  })

  it('rootDir 缺省 = pi 全局 sessions（getPiGlobalAgentDir 动态推导）', async () => {
    piGlobalDirState.dir = join(fixturesRoot, 'pi-global-agent')
    const defaultRoot = join(piGlobalDirState.dir, 'sessions')
    mkdirSync(defaultRoot, { recursive: true })
    writeSessionJsonl(join(defaultRoot, 'def.jsonl'), 'def-id-0000001', '/tmp/def-cwd', 'DefaultRoot')
    const svc = makeImportService()
    const reply = await svc.listCandidates({})
    expect(reply.items.some((i) => i.sessionId === 'def-id-0000001')).toBe(true)
    // 显式传其他 root 不被默认根内容污染（扫描按 rootDir 参数化）
    const other = join(fixturesRoot, 'other-root')
    mkdirSync(other, { recursive: true })
    expect((await svc.listCandidates({ rootDir: other })).items).toEqual([])
  })

  it('rootDir 存在但不可读 → import_dir_unreadable；不存在 → 空列表不抛错', async () => {
    const svc = makeImportService()
    // 不存在：scanExternalSessions 容错语义
    expect((await svc.listCandidates({ rootDir: join(fixturesRoot, 'no-such-root') })).items).toEqual([])

    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      // root 下权限位失效，权限型用例无法构造（跳过，与 repo 内 chmod 类先例同口径）
      return
    }
    const unreadable = join(fixturesRoot, 'unreadable-root')
    mkdirSync(unreadable)
    writeSessionJsonl(join(unreadable, 'u.jsonl'), 'unreadable-id-1', '/tmp/ur-cwd', 'U')
    const { chmodSync } = await import('node:fs')
    try {
      // 目录置 0o000 后 readdir 必失败（EACCES）→ import_dir_unreadable
      chmodSync(unreadable, 0o000)
      await expect(catchCode(() => svc.listCandidates({ rootDir: unreadable }))).resolves.toBe('import_dir_unreadable')
    } finally {
      chmodSync(unreadable, 0o755)
    }
  })
})

describe('ImportService.importSession', () => {
  it('幂等：同 id 二次导入 → import_already_imported；并发双击 → 一成一拒（全局互斥）', async () => {
    const root = join(fixturesRoot, 'idem-root')
    mkdirSync(root, { recursive: true })
    const src = join(root, 'idem.jsonl')
    writeSessionJsonl(src, 'idem-id-000001', '/tmp/idem-cwd', 'Idem')
    const svc = makeImportService()

    await svc.importSession({ sourcePath: src, projectId: 'proj-1' })
    await expect(catchCode(() => svc.importSession({ sourcePath: src, projectId: 'proj-1' })))
      .resolves.toBe('import_already_imported')

    // 并发（双击连点）：互斥串行化，同一请求一成一拒，无 duplicate/覆盖
    const src2 = join(root, 'idem2.jsonl')
    writeSessionJsonl(src2, 'idem2-id-00002', '/tmp/idem-cwd', 'Idem2')
    const settled = await Promise.allSettled([
      svc.importSession({ sourcePath: src2, projectId: 'proj-1' }),
      svc.importSession({ sourcePath: src2, projectId: 'proj-1' }),
    ])
    expect(settled.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
    const rejected = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected')!
    expect((rejected.reason as ImportServiceError).code).toBe('import_already_imported')
  })

  it('同 target 异 id：第二跳 → import_target_conflict（并发型同样拒绝）', async () => {
    const root = join(fixturesRoot, 'conflict-root')
    const cwd = '/tmp/conflict-cwd'
    mkdirSync(root, { recursive: true })
    const s1 = join(root, 'same-name.jsonl')
    writeSessionJsonl(s1, 'conf-id-0000001', cwd, 'First')
    const svc = makeImportService()
    await svc.importSession({ sourcePath: s1, projectId: 'proj-1' })

    // 异 id、同 basename、同 cwd → 同 targetPath
    const sub = join(root, 'alt')
    mkdirSync(sub, { recursive: true })
    const s2 = join(sub, 'same-name.jsonl')
    writeSessionJsonl(s2, 'conf-id-0000002', cwd, 'Second')
    const targetPath = join(getSessionsDir(), encodeCwd(cwd), 'same-name.jsonl')

    // 顺序型：明确 target_conflict，先落者不被静默覆盖
    await expect(catchCode(() => svc.importSession({ sourcePath: s2, projectId: 'proj-1' })))
      .resolves.toBe('import_target_conflict')
    expect(existsSync(targetPath)).toBe(true)

    // 并发型（r3 镜像漏斗）：两源异 id、同 basename、同 cwd → 同 targetPath 并发导入，
    // 全局互斥串行 + 第二跳 existsSync 双检 → 一成一拒（不再 rename-over 静默覆盖先落者）
    const concCwd = '/tmp/conflict-conc-cwd'
    const dirA = join(root, 'conc-a')
    const dirB = join(root, 'conc-b')
    mkdirSync(dirA, { recursive: true })
    mkdirSync(dirB, { recursive: true })
    writeSessionJsonl(join(dirA, 'conc.jsonl'), 'conf-id-0000003', concCwd, 'ConcA')
    writeSessionJsonl(join(dirB, 'conc.jsonl'), 'conf-id-0000004', concCwd, 'ConcB')
    const settled = await Promise.allSettled([
      svc.importSession({ sourcePath: join(dirA, 'conc.jsonl'), projectId: 'proj-1' }),
      svc.importSession({ sourcePath: join(dirB, 'conc.jsonl'), projectId: 'proj-1' }),
    ])
    expect(settled.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
    const rejectedC = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected')!
    expect((rejectedC.reason as ImportServiceError).code).toBe('import_target_conflict')
    // 先落者不被静默覆盖：正式名落地且内容仍是先落者（两源 id 不同，包含即证明）
    const fulfilledC = settled.find(
      (r): r is PromiseFulfilledResult<{ sessionId: string; targetPath: string }> => r.status === 'fulfilled',
    )!
    expect(fulfilledC.value.targetPath).toBe(join(getSessionsDir(), encodeCwd(concCwd), 'conc.jsonl'))
    expect(readFileSync(fulfilledC.value.targetPath, 'utf-8')).toContain(fulfilledC.value.sessionId)
  })

  it('copy 失败：无残留 + 正式名未落地 + 互斥链异常安全第二跳成功', async () => {
    const root = join(fixturesRoot, 'copyfail-root')
    mkdirSync(root, { recursive: true })
    const cwd = '/tmp/copyfail-cwd'
    const src = join(root, 'cf.jsonl')
    writeSessionJsonl(src, 'copyfail-id-0001', cwd, 'CopyFail')
    const svc = makeImportService()

    copyFailureState.failNext = true
    await expect(catchCode(() => svc.importSession({ sourcePath: src, projectId: 'proj-1' })))
      .resolves.toBe('import_copy_failed')

    // 无残留：目标目录无 .tmp-import- 临时名，正式名从未落地（重试不被去重拦截，D1 原子性）
    const targetDir = join(getSessionsDir(), encodeCwd(cwd))
    const residue = existsSync(targetDir) ? readdirSync(targetDir).filter((n) => n.includes('.tmp-import-')) : []
    expect(residue).toEqual([])
    expect(existsSync(join(targetDir, 'cf.jsonl'))).toBe(false)

    // 第二跳：互斥链未被前序失败污染（r4-S1 异常安全）
    const second = await svc.importSession({ sourcePath: src, projectId: 'proj-1' })
    expect(second.sessionId).toBe('copyfail-id-0001')
    expect(existsSync(second.targetPath)).toBe(true)
  })

  it('marker 文件名拒绝：.tmp-import- / .tmp-migrate- → import_marker_filename，不落盘', async () => {
    const root = join(fixturesRoot, 'marker-root')
    mkdirSync(root, { recursive: true })
    const cwd = '/tmp/marker-cwd'
    const svc = makeImportService()
    const cases = [
      ['x.jsonl.tmp-import-111.jsonl', 'marker-id-00001'],
      ['y.jsonl.tmp-migrate-222.jsonl', 'marker-id-00002'],
    ] as const
    for (const [file, id] of cases) {
      const src = join(root, file)
      writeSessionJsonl(src, id, cwd, 'Marker')
      await expect(catchCode(() => svc.importSession({ sourcePath: src, projectId: 'proj-1' })))
        .resolves.toBe('import_marker_filename')
      expect(existsSync(join(getSessionsDir(), encodeCwd(cwd), file))).toBe(false)
    }
  })

  it('projectId 空串/不存在 → import_project_invalid，未落盘', async () => {
    const root = join(fixturesRoot, 'proj-root')
    mkdirSync(root, { recursive: true })
    const src = join(root, 'p.jsonl')
    writeSessionJsonl(src, 'proj-id-0000001', '/tmp/proj-check-cwd', 'P')
    const svc = makeImportService()
    for (const projectId of ['', 'proj-no-such']) {
      await expect(catchCode(() => svc.importSession({ sourcePath: src, projectId })))
        .resolves.toBe('import_project_invalid')
    }
    expect(existsSync(join(getSessionsDir(), encodeCwd('/tmp/proj-check-cwd'), 'p.jsonl'))).toBe(false)
  })

  it('sidecar readback 不符 → 成功 + warning sidecar_failed（文件不回滚）', async () => {
    const root = join(fixturesRoot, 'sidecar-root')
    const cwd = '/tmp/sidecar-cwd'
    mkdirSync(root, { recursive: true })
    const src = join(root, 'sc.jsonl')
    writeSessionJsonl(src, 'sidecar-id-00001', cwd, 'Sidecar')
    const targetPath = join(getSessionsDir(), encodeCwd(cwd), 'sc.jsonl')
    // 预置 sidecar 路径为目录：persistBindingSidecar 原子写吞错（best-effort），
    // readProjectBinding 读失败返回 undefined → readback 不符 → warning 通道
    mkdirSync(join(getSessionsDir(), encodeCwd(cwd)), { recursive: true })
    mkdirSync(`${targetPath}.project.json`)
    const svc = makeImportService()

    const reply = await svc.importSession({ sourcePath: src, projectId: 'proj-1' })
    expect(reply.warning).toBe('sidecar_failed')
    expect(reply.sessionId).toBe('sidecar-id-00001')
    expect(reply.targetPath).toBe(targetPath)
    expect(existsSync(targetPath)).toBe(true) // 文件已落地不回滚（r2-S2）
  })

  it('源文件不存在 → import_source_missing；首行非 header / 缺 cwd → import_invalid_session', async () => {
    const root = join(fixturesRoot, 'invalid-root')
    mkdirSync(root, { recursive: true })
    const svc = makeImportService()

    await expect(catchCode(() => svc.importSession({ sourcePath: join(root, 'no-such.jsonl'), projectId: 'proj-1' })))
      .resolves.toBe('import_source_missing')

    writeFileSync(join(root, 'bad.jsonl'), 'not a header line\n')
    await expect(catchCode(() => svc.importSession({ sourcePath: join(root, 'bad.jsonl'), projectId: 'proj-1' })))
      .resolves.toBe('import_invalid_session')

    // D1 字段清单：type==='session' 但 cwd 缺失 → 不容忍（encodeCwd(undefined) 会 TypeError）
    writeFileSync(join(root, 'no-cwd.jsonl'), `${JSON.stringify({ type: 'session', version: 1, id: 'invalid-id-0001', timestamp: '2026-01-01T00:00:00.000Z' })}\n`)
    await expect(catchCode(() => svc.importSession({ sourcePath: join(root, 'no-cwd.jsonl'), projectId: 'proj-1' })))
      .resolves.toBe('import_invalid_session')

    // 首行为字面量 null（r5-MF1）：parse 产物非 object 须被运行时守卫拦下转
    // import_invalid_session，不得逃逸原始 TypeError 被 handler 兜底成 import_failed
    writeFileSync(join(root, 'null-first.jsonl'), 'null\n')
    await expect(catchCode(() => svc.importSession({ sourcePath: join(root, 'null-first.jsonl'), projectId: 'proj-1' })))
      .resolves.toBe('import_invalid_session')
  })

  it('readFirstLineAsync 跨块多字节解码（r1-S2）：CJK cwd 跨 4KB 块边界无损，targetPath 按真实 cwd 构造', async () => {
    const root = join(fixturesRoot, 'cjk-import-root')
    mkdirSync(root, { recursive: true })
    // 构造首行 > 4KB 且首 CJK 字符（3 字节）恰跨 4096 边界：逐块 toString 会拆出 U+FFFD。
    // padding 放在 cwd 之外的旁路 JSON 字段——若塞进 cwd，encodeCwd 目标目录名会超
    // macOS NAME_MAX(255) 抛 ENAMETOOLONG，注入点跑不到断言。
    const CHUNK = 4096
    const head = '{"type":"session","version":1,"id":"cjk-import-0001","pad":"'
    const mid = '","cwd":"/tmp/'
    const cjk = '极长的中文路径目录名用于跨块解码回归'
    const tail = '","timestamp":"2026-01-01T00:00:00.000Z"}'
    // ASCII 前缀字节长 = 字符长；padLen 使 CJK 首字符起于字节 4095、跨 4096 边界
    const padLen = CHUNK - 1 - head.length - mid.length
    const cwd = '/tmp/' + cjk
    const firstLine = head + 'a'.repeat(padLen) + mid + cjk + tail
    expect(firstLine.length).toBeGreaterThan(CHUNK) // 前提：首行跨块
    const src = join(root, 'cjk.jsonl')
    writeFileSync(src, firstLine + '\n')

    const svc = makeImportService()
    const reply = await svc.importSession({ sourcePath: src, projectId: 'proj-1' })
    expect(reply.sessionId).toBe('cjk-import-0001')
    expect(reply.warning).toBeUndefined()
    // cwd 解码无损 → targetPath 按真实（无 U+FFFD）cwd 构造
    expect(reply.targetPath).toBe(join(getSessionsDir(), encodeCwd(cwd), 'cjk.jsonl'))
  })
})

describe('ImportService × B5 摘碑（memory-leak-remediation §3.2-B5 双路径②：doImport 尾部）', () => {
  /** 预置 tombstone 的最小装置：注入 mock trash port（同步移除文件模拟 trash 语义） */
  function makeTombstonedStore(storeDir: string, sid: string): SessionDataStore {
    const store = new SessionDataStore(storeDir, undefined, undefined, async (p) => {
      rmSync(p, { force: true })
    })
    store.set(sid, 'k1', 'v1')
    store.flushSession(sid)
    return store
  }

  it('import 同 id 复活成功 → tombstone 摘除（import 后未打开窗口内插件合法写不被误杀）', async () => {
    const root = join(fixturesRoot, 'tomb-root')
    mkdirSync(root, { recursive: true })
    const sid = 'imp-tomb-00001'
    const src = join(root, 'tomb.jsonl')
    writeSessionJsonl(src, sid, '/tmp/tomb-cwd', 'Tomb')

    // 预置 tombstone（模拟该 id session 先前被删除：clearSession 登记）
    const store = makeTombstonedStore(join(fixturesRoot, 'tomb-store'), sid)
    await store.clearSession(sid)
    expect(isSessionDataCleared(sid)).toBe(true)
    store.dispose()

    const svc = makeImportService()
    const reply = await svc.importSession({ sourcePath: src, projectId: 'proj-1' })
    expect(reply.sessionId).toBe(sid)

    // doImport 尾部显式摘碑（纯文件级导入不投 didCreate，主线程无创建收敛点可依赖）
    expect(isSessionDataCleared(sid)).toBe(false)
  })

  it('import 失败（marker 文件名拒绝，不达尾部）→ tombstone 保留（碑只随成功复活摘）', async () => {
    const root = join(fixturesRoot, 'tomb-fail-root')
    mkdirSync(root, { recursive: true })
    const sid = 'imp-tomb-00002'
    const src = join(root, 'x.tmp-import-residue.jsonl')
    writeSessionJsonl(src, sid, '/tmp/tomb-fail-cwd', 'TombFail')

    const store = makeTombstonedStore(join(fixturesRoot, 'tomb-fail-store'), sid)
    await store.clearSession(sid)

    const svc = makeImportService()
    await expect(catchCode(() => svc.importSession({ sourcePath: src, projectId: 'proj-1' })))
      .resolves.toBe('import_marker_filename')

    expect(isSessionDataCleared(sid)).toBe(true) // 未摘
    store.dispose()
  })
})

describe('ImportService source 路由（SPI 编排层，设计 §3.3/§3.7）', () => {
  it('缺省不传 source = 显式 source:"pi"（向后兼容：存量调用路径行为不变）', async () => {
    const root = join(fixturesRoot, 'route-default-root')
    mkdirSync(root, { recursive: true })
    writeSessionJsonl(join(root, 'r1.jsonl'), 'route-def-00001', '/tmp/route-def-cwd', 'RouteDefault')
    writeSessionJsonl(join(root, 'r2.jsonl'), 'route-exp-00001', '/tmp/route-exp-cwd', 'RouteExplicit')
    const svc = makeImportService()

    // listCandidates：不传 source 与显式 'pi' 结果一致（同一 fixture 集合）
    const implicit = await svc.listCandidates({ rootDir: root })
    const explicit = await svc.listCandidates({ rootDir: root, source: 'pi' })
    expect(explicit).toEqual(implicit)
    expect(explicit.total).toBe(2)

    // importSession：不传 source 走 pi 落地链（readFirstLine + copyFile），产物/语义与存量一致
    const reply = await svc.importSession({ sourcePath: join(root, 'r1.jsonl'), projectId: 'proj-1' })
    expect(reply.sessionId).toBe('route-def-00001')
    expect(reply.warning).toBeUndefined()
    expect(reply.targetPath).toBe(join(getSessionsDir(), encodeCwd('/tmp/route-def-cwd'), 'r1.jsonl'))
    expect(existsSync(reply.targetPath)).toBe(true)
  })

  it('degradations 非空 → reply.warning = conversion_degraded（stub source 注入，pi 不受影响）', async () => {
    // stub 占 'pi' 槽（独立 service 实例 + 专用 id/cwd/fileName，不污染其他用例的 pi 全链路）
    const stub: SessionImportSource = {
      kind: 'pi',
      listCandidates: async () => ({ total: 0, items: [], dirs: [] }),
      prepareImport: async () => ({
        header: { id: 'stub-deg-00001', timestamp: '2026-01-01T00:00:00.000Z', cwd: '/tmp/stub-deg-cwd' },
        fileName: 'stub-deg.jsonl',
        write: async (tmpPath) => {
          writeFileSync(tmpPath, `${JSON.stringify({ type: 'session', version: 1, id: 'stub-deg-00001', cwd: '/tmp/stub-deg-cwd', timestamp: '2026-01-01T00:00:00.000Z' })}\n`)
        },
        degradations: ['file part 丢弃（zcode-artifact:// 私有协议引用无法解析）'],
      }),
    }
    const svc = makeImportService(new Map<ImportSourceKind, SessionImportSource>([['pi', stub]]))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const reply = await svc.importSession({ sourcePath: '/stub/source-not-read-by-stub', projectId: 'proj-1', source: 'pi' })
    // warning 聚合（§3.6）：degradations 非空 → conversion_degraded；明细不进契约面、日志留痕（D6）
    expect(reply.warning).toBe('conversion_degraded')
    expect(reply.sessionId).toBe('stub-deg-00001')
    expect(reply.targetPath).toBe(join(getSessionsDir(), encodeCwd('/tmp/stub-deg-cwd'), 'stub-deg.jsonl'))
    expect(existsSync(reply.targetPath)).toBe(true) // 落地成功（降级是知情提示，非失败）
    // degradations 日志留痕（D6）：只断言存在性——sidecar 等 best-effort 路径的 warn 与
    // 本日志共用 console 通道，次数/顺序不是契约
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('conversion degraded'))).toBe(true)
    warnSpy.mockRestore()
  })

  it('sidecar 不符 + degradations 非空并存 → warning 单字段取 sidecar_failed（需动作警示优先），degradations 仍日志留痕', async () => {
    const cwd = '/tmp/stub-both-cwd'
    const targetPath = join(getSessionsDir(), encodeCwd(cwd), 'stub-both.jsonl')
    // 预置 sidecar 路径为目录：readback 不符 → sidecar_failed（同 sidecar 用例注入手法）
    mkdirSync(join(getSessionsDir(), encodeCwd(cwd)), { recursive: true })
    mkdirSync(`${targetPath}.project.json`)
    const stub: SessionImportSource = {
      kind: 'pi',
      listCandidates: async () => ({ total: 0, items: [], dirs: [] }),
      prepareImport: async () => ({
        header: { id: 'stub-both-0001', timestamp: '2026-01-01T00:00:00.000Z', cwd },
        fileName: 'stub-both.jsonl',
        write: async (tmpPath) => {
          writeFileSync(tmpPath, 'line\n')
        },
        degradations: ['timeline part 丢弃（纯 UI 事件）'],
      }),
    }
    const svc = makeImportService(new Map<ImportSourceKind, SessionImportSource>([['pi', stub]]))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const reply = await svc.importSession({ sourcePath: '/stub/unused', projectId: 'proj-1', source: 'pi' })
    // ImportReply.warning 是单字段（r4-INFO）：sidecar_failed 引导手动归类（需动作）优先于
    // conversion_degraded（知情提示，无需动作）；degradations 明细经日志通道不丢失
    //（sidecar 写失败的 warn 同走 console，只断言 conversion degraded 调用存在）
    expect(reply.warning).toBe('sidecar_failed')
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('conversion degraded'))).toBe(true)
    warnSpy.mockRestore()
  })

  it('write 相位抛领域错误 → 错误码原样透传，不重包装 import_copy_failed（§3.6 相位分离）', async () => {
    // zcode 源的 write 闭包在 write 相位抛领域错误（转换相位 db 消失 →
    // import_source_missing；会话消失/查询失败 → import_invalid_session）——编排层
    // catch 若无条件重包装 import_copy_failed，错误码承载的恢复指引（刷新列表重选/
    // 升级太极）会被降格成「写入目标目录出错」。stub source 锁编排层透传语义。
    const stub: SessionImportSource = {
      kind: 'pi',
      listCandidates: async () => ({ total: 0, items: [], dirs: [] }),
      prepareImport: async () => ({
        header: { id: 'stub-dom-00001', timestamp: '2026-01-01T00:00:00.000Z', cwd: '/tmp/stub-dom-cwd' },
        fileName: 'stub-dom.jsonl',
        write: async () => {
          throw new ImportServiceError('import_invalid_session', '该会话已不在 zcode 库中（sessionId=sess_x），请刷新列表后重选')
        },
        degradations: [],
      }),
    }
    const svc = makeImportService(new Map<ImportSourceKind, SessionImportSource>([['pi', stub]]))

    await expect(catchCode(() => svc.importSession({ sourcePath: '/stub/unused', projectId: 'proj-1', source: 'pi' })))
      .resolves.toBe('import_invalid_session')
    // 领域错误透传同样走 tmp 清理路径：无 .tmp-import- 残留、正式名未落地（重试不被去重拦截）
    const targetDir = join(getSessionsDir(), encodeCwd('/tmp/stub-dom-cwd'))
    const residue = existsSync(targetDir) ? readdirSync(targetDir).filter((n) => n.includes('.tmp-import-')) : []
    expect(residue).toEqual([])
    expect(existsSync(join(targetDir, 'stub-dom.jsonl'))).toBe(false)
  })

  it('注册表缺项 → import_source_missing（防御分支：闭合联合 + 组合根全注册下仅版本不匹配可达）', async () => {
    // U2 阶段 zcode 尚未注册（U3 加入）——空表构造即可触达；同时锁「未知源字面量不静默走 pi」
    const svc = makeImportService(new Map<ImportSourceKind, SessionImportSource>())
    await expect(catchCode(() => svc.importSession({ sourcePath: '/any.jsonl', projectId: 'proj-1', source: 'zcode' })))
      .resolves.toBe('import_source_missing')
    await expect(catchCode(() => svc.listCandidates({ source: 'zcode' }))).resolves.toBe('import_source_missing')
  })
})
