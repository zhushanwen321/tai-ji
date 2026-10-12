/**
 * 删主会话下挂内容事务性级联单测（2026-10-12 架构裁决：删主会话 = 事务性级联删除
 * 其下挂的一切内容；「偏事务性」= 单一清单入口、删前枚举完整、失败有汇总不留静默半态）。
 *
 * 覆盖（验收标准 6 条）：
 * - ①无共享场景：删主会话 → 子代理 .jsonl + 全 sidecars + manifest + .events、
 *   session-view 导出物、base-tool-enhance 目录全部清除；
 * - ②fork 共享场景：A fork 出 B（同 record entries），删 A → 子代理文件保留
 *   （B 仍引用）；再删 B → 清除；
 * - ③并集扫描对 settled.sessionFile 与 registered id 两种锚都生效；
 * - ④某项删除失败（真实 fs 失败注入：sidecar 位建目录）→ 其余项照删 + 汇总告警出声；
 * - ⑤restore 清场路径不触发 A23 目录删除（行为级：removeSessionEntry 汇聚链驱动后
 *   目录仍在；真删通道唯一性源码断言：cascade 调用点仅在 delete）；
 * - ⑥主文件 trash 在下挂清理之后（trash 调用时点断言下挂已清、主 sidecar 未清）。
 *
 * 形态对齐 session-artifact-cascade.test.ts 的 delete 驱动 harness（fake deps 真实
 * 驱动生命周期删链）；全部文件操作落 mkdtempSync 自建自删的 tmpdir（仓规测试红线）。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/session-content-cascade.test.ts
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { cascadeDeleteSessionContent } from '../session-content-cascade.js'
import type { SessionContentCascadeDeps } from '../session-content-cascade.js'
import { SessionLifecycle } from '../session-lifecycle.js'
import { SessionEntryRemovalOrchestrator } from '../session-entry-removal.js'
import type { ILifecycleSessionOps, ISessionRegisterDeps } from '../session-internal.js'
import type { IProcessManager } from '../../ports/pi-engine.js'
import type { IConfigStore } from '../../ports/config.js'
import type { ISessionStore } from '../../ports/session.js'
import type { WorkspaceService } from '../../workspace/workspace-service.js'
import type { SessionSummary } from '@taiji/shared'

// ── fixture 布局（真实 pi 布局收窄形态）──────────────────────────────────────
// root/
//   agent/                          # agentDir
//     sessions/<slug>/main-a.jsonl  # sessionsRoot 全池（slug 子目录）
//     subagents/--enc--/sessions/<ts>_<saId>.jsonl(+sidecars)
//     subagents/--enc--/records/<saId>.json + <saId>.events
//     tmp/session-view-<sid>.md
//     base-tool-enhance/<sid>/registry.json

const ENC = '--enc--'
const SUBAGENT_SIDECAR_EXTS = ['.record-binding', '.alive', '.state', '.cancelled', '.finalized'] as const

// 测试内 fixture 形状载体，非契约接口——类型别名（interface 会被 oe-assert 单实现初筛误拦，
// 同 terminal-lifecycle-cascade.test.ts 先例）。
type Pool = {
  root: string
  agentDir: string
  sessionsRoot: string
  /** 建 `<sessionsRoot>/<slug>/<name>.jsonl` 主会话文件并写入 lines。 */
  addMainSession: (slug: string, name: string, lines: string[]) => string
  /** seed 一个子代理文件族（.jsonl + 全 sidecars + manifest + .events）。 */
  seedSubagentFamily: (saId: string) => {
    sessionFile: string
    sidecars: string[]
    manifest: string
    events: string
  }
  recordsDir: string
  seedRegisteredOnlyJsonl: (saId: string) => string
  sessionViewPath: (sid: string) => string
  bgTaskDir: (sid: string) => string
}

let pool: Pool | null = null


/** 级联删除执行 + 结果断言单源（零失败 + 单保护族），返回 result 供补充断言。 */
async function runCascade(sid: string, mainFile: string, p: ReturnType<typeof makePool>) {
  const result = await cascadeDeleteSessionContent(
    { sessionId: sid, sessionFilePath: mainFile, agentDir: p.agentDir, sessionsRoot: p.sessionsRoot, skipIfMainFileMissing: true },
    makeDeps().deps,
  )
  expect(result.failures).toEqual([])
  expect(result.subagentFamiliesProtected).toBe(1)
  return result
}

function makePool(): Pool {
  const root = mkdtempSync(join(tmpdir(), 'taiji-content-cascade-'))
  const agentDir = join(root, 'agent')
  const sessionsRoot = join(agentDir, 'sessions')
  const subagentsRoot = join(agentDir, 'subagents', ENC)
  mkdirSync(sessionsRoot, { recursive: true })
  const recordsDir = join(subagentsRoot, 'records')
  const p: Pool = {
    root,
    agentDir,
    sessionsRoot,
    recordsDir,
    addMainSession: (slug, name, lines) => {
      const dir = join(sessionsRoot, slug)
      mkdirSync(dir, { recursive: true })
      const filePath = join(dir, `${name}.jsonl`)
      writeFileSync(filePath, lines.join('\n') + '\n', 'utf8')
      return filePath
    },
    seedSubagentFamily: (saId) => {
      const sessionsDir = join(subagentsRoot, 'sessions')
      mkdirSync(sessionsDir, { recursive: true })
      mkdirSync(recordsDir, { recursive: true })
      const sessionFile = join(sessionsDir, `2026-01-01T00-00-00-000Z_${saId}.jsonl`)
      const sidecars = SUBAGENT_SIDECAR_EXTS.map((ext) => sessionFile + ext)
      writeFileSync(sessionFile, '{"type":"session"}\n', 'utf8')
      for (const sc of sidecars) writeFileSync(sc, '{}', 'utf8')
      const manifest = join(recordsDir, `${saId}.json`)
      const events = join(recordsDir, `${saId}.events`)
      writeFileSync(manifest, '{}', 'utf8')
      writeFileSync(events, '{"type":"record-events"}\n', 'utf8')
      return { sessionFile, sidecars: [...sidecars], manifest, events }
    },
    seedRegisteredOnlyJsonl: (saId) => {
      const sessionsDir = join(subagentsRoot, 'sessions')
      mkdirSync(sessionsDir, { recursive: true })
      const filePath = join(sessionsDir, `2026-01-01T00-00-00-000Z_${saId}.jsonl`)
      writeFileSync(filePath, '{"type":"session"}\n', 'utf8')
      return filePath
    },
    sessionViewPath: (sid) => join(agentDir, 'tmp', `session-view-${sid}.md`),
    bgTaskDir: (sid) => join(agentDir, 'base-tool-enhance', sid),
  }
  // session-view 的 tmp 目录预建（fixture 写入前置目录）
  mkdirSync(join(agentDir, 'tmp'), { recursive: true })
  pool = p
  return p
}

/** subagent-record v2 条目行（classify 只判 v/kind；id/sessionFile 照实写）。 */
function registeredLine(id: string): string {
  return JSON.stringify({ type: 'custom', customType: 'subagent-record', data: { v: 2, kind: 'registered', id, rootSessionId: 'root-x', depth: 0, startedAt: 1 } })
}

function settledLine(id: string, sessionFile: string): string {
  return JSON.stringify({ type: 'custom', customType: 'subagent-record', data: { v: 2, kind: 'settled', id, status: 'idle', stopReason: 'end_turn', endedAt: 2, turns: 1, totalTokens: 10, sessionFile } })
}

type DepsHandle = {
  deps: SessionContentCascadeDeps
  warnings: string[]
  trashed: string[]
  mainSidecarsPurged: string[]
}

function makeDeps(): DepsHandle {
  const warnings: string[] = []
  const trashed: string[] = []
  const mainSidecarsPurged: string[] = []
  return {
    deps: {
      trash: vi.fn(async (filePath: string) => { trashed.push(filePath) }),
      purgeMainSidecars: vi.fn((filePath: string) => { mainSidecarsPurged.push(filePath) }),
      reapBackgroundTasks: vi.fn(async () => undefined),
      warn: (message: string) => { warnings.push(message) },
    },
    warnings,
    trashed,
    mainSidecarsPurged,
  }
}

const cleanupDirs: string[] = []

afterEach(() => {
  if (pool !== null) cleanupDirs.push(pool.root)
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
  pool = null
  activePoolRef.current = null
})

/** 断言文件不存在（存在时报出路径）。 */
function expectGone(paths: string | string[]): void {
  for (const p of Array.isArray(paths) ? paths : [paths]) {
    expect({ path: p, exists: existsSync(p) }).toEqual({ path: p, exists: false })
  }
}

function expectPresent(paths: string | string[]): void {
  for (const p of Array.isArray(paths) ? paths : [paths]) {
    expect({ path: p, exists: existsSync(p) }).toEqual({ path: p, exists: true })
  }
}

// ── 验收①：无共享场景全清 ────────────────────────────────────────────────────

describe('cascadeDeleteSessionContent 无共享场景（验收①）', () => {
  it('删主会话清除：settled 族全文件 + registered-only 全段定位族 + 主 sid 的 session-view 与 A23 目录', async () => {
    const p = makePool()
    const h = makeDeps()
    const settled = p.seedSubagentFamily('sa-1')
    const registeredJsonl = p.seedRegisteredOnlyJsonl('sa-2')
    const registeredManifest = join(p.recordsDir, 'sa-2.json')
    const registeredEvents = join(p.recordsDir, 'sa-2.events')
    writeFileSync(registeredManifest, '{}', 'utf8')
    writeFileSync(registeredEvents, '{}', 'utf8')
    const mainSid = 'main-aaaa'
    const mainFile = p.addMainSession('slug-a', `2026T_${mainSid}`, [
      registeredLine('sa-1'),
      settledLine('sa-1', settled.sessionFile),
      registeredLine('sa-2'),
    ])
    mkdirSync(p.bgTaskDir(mainSid), { recursive: true })
    writeFileSync(join(p.bgTaskDir(mainSid), 'registry.json'), '{}', 'utf8')
    writeFileSync(p.sessionViewPath(mainSid), 'x', 'utf8')
    writeFileSync(p.sessionViewPath('sa-1'), 'x', 'utf8')

    const result = await cascadeDeleteSessionContent(
      { sessionId: mainSid, sessionFilePath: mainFile, agentDir: p.agentDir, sessionsRoot: p.sessionsRoot, skipIfMainFileMissing: true },
      h.deps,
    )

    expect(result.failures).toEqual([])
    expect(result.subagentFamiliesDeleted).toBe(2)
    expect(result.subagentFamiliesProtected).toBe(0)
    expect(result.referenceScan).toBe('ok')
    // settled 族：.jsonl + 全 sidecars + manifest + .events
    expectGone([settled.sessionFile, ...settled.sidecars, settled.manifest, settled.events])
    // registered-only 族：全段定位 sessions jsonl + manifest + .events
    expectGone([registeredJsonl, registeredManifest, registeredEvents])
    // 子代理的 session-view 顺带清除
    expectGone(p.sessionViewPath('sa-1'))
    // A21 主会话导出物 + A23 后台任务 registry 目录
    expectGone(p.sessionViewPath(mainSid))
    expectGone(p.bgTaskDir(mainSid))
    // 主文件 trash、主 sidecars 清理回调到达
    expect(h.trashed).toEqual([mainFile])
    expect(h.mainSidecarsPurged).toEqual([mainFile])
  })

  it('无子代理的主会话：级联 no-op 干净收尾（failures 空、trash 照常）', async () => {
    const p = makePool()
    const h = makeDeps()
    const mainSid = 'main-bbbb'
    const mainFile = p.addMainSession('slug-a', `2026T_${mainSid}`, ['{"type":"session"}'])
    const result = await cascadeDeleteSessionContent(
      { sessionId: mainSid, sessionFilePath: mainFile, agentDir: p.agentDir, sessionsRoot: p.sessionsRoot, skipIfMainFileMissing: true },
      h.deps,
    )
    expect(result.failures).toEqual([])
    expect(result.subagentFamiliesDeleted).toBe(0)
    expect(h.trashed).toEqual([mainFile])
  })
})

// ── 验收②：fork 共享场景 ─────────────────────────────────────────────────────

describe('cascadeDeleteSessionContent fork 共享（验收②）', () => {
  it('A fork 出 B：删 A → 子代理族保留（B 仍引用）；再删 B → 清除', async () => {
    const p = makePool()
    const family = p.seedSubagentFamily('sa-fork')
    // fork 产物 = 原样复制 record entries（settled.sessionFile 指向不变——session-fork.ts
    // createForkedSessionFile 逐条 JSON.stringify 复制的真实语义）。
    const entryLines = [registeredLine('sa-fork'), settledLine('sa-fork', family.sessionFile)]
    const fileA = p.addMainSession('slug-a', '2026T_a', ['{"type":"session","id":"a"}', ...entryLines])
    const fileB = p.addMainSession('slug-a', '2026T_b', ['{"type":"session","id":"b"}', ...entryLines])

    // 删 A：B 仍在池内引用同族 → 整族保护
    const r1 = await cascadeDeleteSessionContent(
      { sessionId: 'main-cccc', sessionFilePath: fileA, agentDir: p.agentDir, sessionsRoot: p.sessionsRoot, skipIfMainFileMissing: true },
      makeDeps().deps,
    )
    expect(r1.failures).toEqual([])
    expect(r1.subagentFamiliesProtected).toBe(1)
    expect(r1.subagentFamiliesDeleted).toBe(0)
    expectPresent([family.sessionFile, ...family.sidecars, family.manifest, family.events])
    // 模拟 trash 离场（本用例 trash fake 不动真实 fs）：A 文件出池
    rmSync(fileA)

    // 删 B：池内已无引用（A 已离场）→ 族清除
    const r2 = await cascadeDeleteSessionContent(
      { sessionId: 'main-dddd', sessionFilePath: fileB, agentDir: p.agentDir, sessionsRoot: p.sessionsRoot, skipIfMainFileMissing: true },
      makeDeps().deps,
    )
    expect(r2.failures).toEqual([])
    expect(r2.subagentFamiliesProtected).toBe(0)
    expect(r2.subagentFamiliesDeleted).toBe(1)
    expectGone([family.sessionFile, ...family.sidecars, family.manifest, family.events])
  })
})

// ── 验收③：并集扫描两锚 ──────────────────────────────────────────────────────

describe('cascadeDeleteSessionContent 引用并集两锚（验收③）', () => {
  it('settled.sessionFile 锚：另一会话仅引用同 sessionFile（id 不同）→ 族保留', async () => {
    const p = makePool()
    const family = p.seedSubagentFamily('sa-anchor')
    const mainFile = p.addMainSession('slug-a', '2026T_a', [
      registeredLine('sa-anchor'),
      settledLine('sa-anchor', family.sessionFile),
    ])
    // 另一会话只写一个 settled 条目：sessionFile 相同、id 刻意不同（合成场景，单验
    // sessionFile 锚独立生效——现实 fork 中 id 与 sessionFile 成对引用）。
    p.addMainSession('slug-b', '2026T_b', [settledLine('sa-other', family.sessionFile)])

    await runCascade('main-eeee', mainFile, p)
    expectPresent([family.sessionFile, family.manifest, family.events])
  })

  it('registered id 锚：另一会话仅含 registered 条目（无 sessionFile）→ registered-only 族保留', async () => {
    const p = makePool()
    const jsonl = p.seedRegisteredOnlyJsonl('sa-only')
    const manifest = join(p.recordsDir, 'sa-only.json')
    mkdirSync(p.recordsDir, { recursive: true })
    writeFileSync(manifest, '{}', 'utf8')
    const mainFile = p.addMainSession('slug-a', '2026T_a', [registeredLine('sa-only')])
    p.addMainSession('slug-b', '2026T_b', [registeredLine('sa-only')])

    await runCascade('main-ffff', mainFile, p)
    expectPresent([jsonl, manifest])
  })
})

// ── 验收④：失败注入 → 其余照删 + 汇总出声 ────────────────────────────────────

describe('cascadeDeleteSessionContent 失败汇总（验收④）', () => {
  it('单个 sidecar 删除失败（目录形态真实 fs 失败）→ 其余文件照删 + failures 记录 + warn 出声', async () => {
    const p = makePool()
    const h = makeDeps()
    const family = p.seedSubagentFamily('sa-fail')
    // 注入：把 .record-binding sidecar 替换为目录（unlinkSync 对目录真实失败，零 mock）
    rmSync(family.sidecars[0])
    mkdirSync(family.sidecars[0], { recursive: true })
    const mainSid = 'main-gggg'
    const mainFile = p.addMainSession('slug-a', `2026T_${mainSid}`, [
      registeredLine('sa-fail'),
      settledLine('sa-fail', family.sessionFile),
    ])
    mkdirSync(p.bgTaskDir(mainSid), { recursive: true })
    writeFileSync(p.sessionViewPath(mainSid), 'x', 'utf8')

    const result = await cascadeDeleteSessionContent(
      { sessionId: mainSid, sessionFilePath: mainFile, agentDir: p.agentDir, sessionsRoot: p.sessionsRoot, skipIfMainFileMissing: true },
      h.deps,
    )

    // 失败项出声（逐项 + 汇总），且失败不静默
    expect(result.failures.length).toBeGreaterThan(0)
    expect(h.warnings.some((w) => w.includes('cascade finished with') && w.includes('failures'))).toBe(true)
    expect(h.warnings.some((w) => w.includes('sa-fail'))).toBe(true)
    // 其余项照删：.jsonl、其余 sidecars、manifest、.events、session-view、A23 目录
    expectGone(family.sessionFile)
    expectGone(family.sidecars.slice(1))
    expectGone([family.manifest, family.events, p.sessionViewPath(mainSid), p.sessionViewPath('sa-fail')])
    expectGone(p.bgTaskDir(mainSid))
    // 失败的目录形态残留（未被静默吞掉）
    expectPresent(family.sidecars[0])
    // trash 与主 sidecars 仍到达（失败不阻断主链）
    expect(h.trashed).toEqual([mainFile])
    expect(h.mainSidecarsPurged).toEqual([mainFile])
  })

  it('引用并集扫描失败（他文件坏行）→ 全族保守保留 + 失败出声，主文件 trash 照常', async () => {
    const p = makePool()
    const h = makeDeps()
    const family = p.seedSubagentFamily('sa-guard')
    const mainFile = p.addMainSession('slug-a', '2026T_a', [
      registeredLine('sa-guard'),
      settledLine('sa-guard', family.sessionFile),
    ])
    // 他会话文件内 subagent-record 候选行含坏 JSON（引用状态不可知 → 宁保留）
    p.addMainSession('slug-b', '2026T_bad', ['{"type":"custom","customType":"subagent-record","data":{"v":2,TRUNCATED'])

    const result = await cascadeDeleteSessionContent(
      { sessionId: 'main-hhhh', sessionFilePath: mainFile, agentDir: p.agentDir, sessionsRoot: p.sessionsRoot, skipIfMainFileMissing: true },
      h.deps,
    )
    expect(result.referenceScan).toBe('failed')
    expect(result.subagentFamiliesDeleted).toBe(0)
    expect(result.failures.some((f) => f.includes('reference union scan failed'))).toBe(true)
    expect(h.warnings.some((w) => w.includes('keeping ALL subagent families'))).toBe(true)
    expectPresent([family.sessionFile, ...family.sidecars, family.manifest, family.events])
    // 子代理族保留但主文件删除不受影响
    expect(h.trashed).toEqual([mainFile])
  })
})

// ── 验收⑥：trash 顺序 ────────────────────────────────────────────────────────

describe('cascadeDeleteSessionContent 执行顺序（验收⑥）', () => {
  it('主文件 trash 发生在下挂清理之后、主 sidecars 清理之前', async () => {
    const p = makePool()
    const family = p.seedSubagentFamily('sa-order')
    const mainSid = 'main-iiii'
    const mainFile = p.addMainSession('slug-a', `2026T_${mainSid}`, [
      registeredLine('sa-order'),
      settledLine('sa-order', family.sessionFile),
    ])
    // 主文件 sidecar（purgeMainSidecars 职责域，fake 不真删——时序断言用）
    const mainSidecar = mainFile + '.preset.json'
    writeFileSync(mainSidecar, '{}', 'utf8')
    mkdirSync(p.bgTaskDir(mainSid), { recursive: true })
    const h = makeDeps()
    let observedAtTrash = ''
    h.deps.trash = vi.fn(async (filePath: string) => {
      h.trashed.push(filePath)
      // trash 调用时点快照：下挂已清、主 sidecar 未清（purgeMainSidecars 在 trash 之后）
      observedAtTrash = JSON.stringify({
        subagentJsonlGone: !existsSync(family.sessionFile),
        manifestGone: !existsSync(family.manifest),
        eventsGone: !existsSync(family.events),
        sessionViewGone: !existsSync(p.sessionViewPath(mainSid)),
        bgDirGone: !existsSync(p.bgTaskDir(mainSid)),
        mainSidecarStillThere: existsSync(mainSidecar),
      })
    })

    await cascadeDeleteSessionContent(
      { sessionId: mainSid, sessionFilePath: mainFile, agentDir: p.agentDir, sessionsRoot: p.sessionsRoot, skipIfMainFileMissing: true },
      h.deps,
    )
    expect(JSON.parse(observedAtTrash)).toEqual({
      subagentJsonlGone: true,
      manifestGone: true,
      eventsGone: true,
      sessionViewGone: true,
      bgDirGone: true,
      mainSidecarStillThere: true,
    })
    // trash 之后的收尾：主 sidecars 回调到达
    expect(h.mainSidecarsPurged).toEqual([mainFile])
  })
})

// ── 验收⑤：A23 触发面收窄（restore 清场不触发）───────────────────────────────

describe('A23 触发面收窄（验收⑤，E8）', () => {
  it('removeSessionEntry 汇聚链（restore 清场同链）驱动后 base-tool-enhance 目录仍在', async () => {
    const p = makePool()
    activePoolRef.current = { agentDir: p.agentDir, sessionsRoot: p.sessionsRoot }
    const sid = 'main-jjjj'
    mkdirSync(p.bgTaskDir(sid), { recursive: true })
    writeFileSync(join(p.bgTaskDir(sid), 'registry.json'), '{}', 'utf8')
    // 收殓器 mock 已在文件尾 vi.mock 拦截（hermetic：不碰真实 ps / 数据目录，
    // 同 terminal-lifecycle-cascade 先例）；本断言的实质 = 汇聚链无删目录通道。
    const orchestrator = new SessionEntryRemovalOrchestrator({
      getSession: () => undefined,
      removeEntry: () => {},
      toSummary: (s) => ({ id: s.id, label: s.id, cwd: '', status: 'dead', lastActiveAt: 0, modelId: '', tokenCount: 0 }) as SessionSummary,
      cancelRespawn: () => {},
      clearSessionViewed: () => {},
      fireOnSessionDelete: () => {},
      getOnSessionDestroyedHandlers: () => [],
      unwatchBackgroundTasks: () => {},
      disposeHistoryReader: () => {},
      disposeTraceSync: () => {},
      disposeProjection: () => {},
      disposeRecords: () => {},
      clearMessageBusSession: () => {},
    })
    try {
      orchestrator.remove(sid)
      // 汇聚链只触发收殓（fire-and-forget），无删目录通道——目录必须原样存活
      //（session 存活路径：restore 清场摘碑复活后 registry 继续读写）。
      expectPresent(p.bgTaskDir(sid))
    } finally {
      activePoolRef.current = null
    }
  })

  it('真删通道唯一性：session-lifecycle.ts 中 cascade 调用点仅在 delete 两分支（源码断言）', () => {
    // 先例：index-composition-root-wiring.test.ts / terminal-lifecycle-cascade.test.ts ③
    //（源码级接线断言）。restore 清场链 clearExistingSessionForRestore 不经过 delete，
    // 结构性无 cascade 通道；本断言防未来把级联挂进 session 存活路径。
    const source = readFileSync(join(__dirname, '..', 'session-lifecycle.ts'), 'utf8')
    const callSites = source.match(/this\.cascadeDeletedSessionContent\(/g) ?? []
    expect(callSites.length).toBe(2)
    // active 分支 = skipIfMainFileMissing: true；scanned 分支 = false
    expect(source.includes('cascadeDeletedSessionContent(sessionId, session.sessionFilePath, true)')).toBe(true)
    expect(source.includes('cascadeDeletedSessionContent(sessionId, target.filePath, false)')).toBe(true)
  })
})

// ── SessionLifecycle.delete 端到端（scanned 分支真实驱动）────────────────────

// pi-paths 钉到 fixture（importOriginal 保留其余导出——session-fork 的 encodeCwd、
// btw 域的 getBtwThreadDir 等照常）；vi.hoisted 载体跨 hoisting 边界（mock 工厂
// 延迟求值时读 current）。
const activePoolRef = vi.hoisted(() => ({ current: null as { agentDir: string; sessionsRoot: string } | null }))

vi.mock('../../../infra/pi/pi-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../infra/pi/pi-paths.js')>()
  return {
    ...actual,
    getPiAgentDir: () => {
      const p = activePoolRef.current
      if (p === null) throw new Error('fixture pool not initialized')
      return p.agentDir
    },
    getSessionsDir: () => {
      const p = activePoolRef.current
      if (p === null) throw new Error('fixture pool not initialized')
      return p.sessionsRoot
    },
  }
})

vi.mock('../background-task-reaper.js', () => ({
  reapSessionBackgroundTasks: vi.fn(async () => undefined),
}))

function makeLifecycle(sid: string, filePath: string, cwd: string): SessionLifecycle {
  const svc = {
    findScannedSession: vi.fn(() => ({
      id: sid,
      filePath,
      cwd,
      timestamp: new Date().toISOString(),
      name: 'test',
      outcome: null,
      lastModified: Date.now(),
      size: 100,
    })),
    removeSessionEntry: vi.fn(),
  } as unknown as ILifecycleSessionOps
  const sessionStore = {
    trash: vi.fn(async () => {}),
    invalidateMetaCache: vi.fn(),
    invalidateScanCache: vi.fn(),
    refreshAll: vi.fn(),
  } as unknown as ISessionStore
  const registerDeps = {
    adapterFactory: vi.fn(),
    getMessageBus: vi.fn(() => null),
    broadcastGlobal: vi.fn(),
  } as unknown as ISessionRegisterDeps
  return new SessionLifecycle(
    svc,
    {} as unknown as IProcessManager,
    {} as unknown as IConfigStore,
    sessionStore,
    {} as unknown as WorkspaceService,
    registerDeps,
  )
}

describe('SessionLifecycle.delete 端到端（scanned 分支真实驱动级联）', () => {
  it('delete 走真实链：子代理族 + session-view + base-tool-enhance 目录全清、trash 被调', async () => {
    const p = makePool()
    activePoolRef.current = { agentDir: p.agentDir, sessionsRoot: p.sessionsRoot }
    const family = p.seedSubagentFamily('sa-e2e')
    const sid = 'main-kkkk'
    const mainFile = p.addMainSession('slug-e2e', `2026T_${sid}`, [
      registeredLine('sa-e2e'),
      settledLine('sa-e2e', family.sessionFile),
    ])
    mkdirSync(p.bgTaskDir(sid), { recursive: true })
    writeFileSync(join(p.bgTaskDir(sid), 'registry.json'), '{}', 'utf8')
    writeFileSync(p.sessionViewPath(sid), 'x', 'utf8')

    const lifecycle = makeLifecycle(sid, mainFile, p.root)
    try {
      await lifecycle.delete(sid)
      expectGone([family.sessionFile, ...family.sidecars, family.manifest, family.events])
      expectGone([p.sessionViewPath(sid), p.sessionViewPath('sa-e2e'), p.bgTaskDir(sid)])
    } finally {
      activePoolRef.current = null
    }
  })
})
