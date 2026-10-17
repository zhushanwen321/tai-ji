/**
 * 删主会话下挂内容级联单测（session-store-layout-inversion D5 删除链收敛后）。
 *
 * 覆盖（验收条款 4 条）：
 * - ① 删除链四段：收殓（reapBackgroundTasks）先于整树软删（trashSessionTree =
 *   `<root>/<sid>/` 目录级）→ pi 主文件 trash → pi sidecars 清理；整树软删是树内
 *   全部域（subagents / attachments / background-tasks / session-view …）的唯一
 *   删除单元；树不存在 = 零动作不抛；
 * - ② fork 引用转移回退（D5 分支规则）：引用并集发现存活会话 B 仍引用 A 树内
 *   subagent 文件 → 被引用族保留 A 树残留（拷回原绝对路径，B 的 sessionFile 引用
 *   可解析）；无引用 → 随整树回收；并集扫描失败 → 全族保守保留；
 * - ③ 旧逐域段无残留调用（源码断言：级联模块不再有逐文件 unlink / agentDir 下的
 *   subagents 根、base-tool-enhance 目录、session-view tmp 导出物删除；lifecycle
 *   不再有图片缓存/产物/附件三段 rmSync）；
 * - ④ btw 孤儿补账退役无残留调用（补账模块文件已删除 + 全仓无 import）。
 *
 * tombstone 时序（迟到写拦截）在文件尾 SessionLifecycle 端到端口断言（删除编排中
 * tombstone 登记先于整树软删）。
 *
 * 形态对齐既有 harness（fake deps 真实驱动级联删链）；全部文件操作落 mkdtempSync
 * 自建自删的 tmpdir 或 globalSetup 钉扎的测试数据目录（仓规测试红线）。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/session-content-cascade.test.ts
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
import { getSessionStoreDir } from '@taiji/shared/paths'

// ── fixture 布局（D5 反转后：session 存储树 + pi 宿主树两棵）──────────────────
// root/
//   ext-sessions/                     # sessionStoreRoot（session 存储树）
//     <sid>/
//       subagents/sessions/<ts>_<saId>.jsonl(+sidecars)
//       subagents/records/<saId>.json + <saId>.events
//       attachments/  background-tasks/  session-view.md
//   agent/                            # agentDir（pi 宿主树）
//     sessions/<slug>/<name>.jsonl    # sessionsRoot 全池（主会话文件，布局不动）

const SUBAGENT_SIDECAR_EXTS = ['.record-binding', '.alive', '.state', '.cancelled', '.finalized'] as const

// 测试内 fixture 形状载体，非契约接口——类型别名（interface 会被 oe-assert 单实现初筛误拦，
// 同 terminal-lifecycle-cascade.test.ts 先例）。
type Pool = {
  root: string
  storeRoot: string
  agentDir: string
  sessionsRoot: string
  /** 建 `<sessionsRoot>/<slug>/<name>.jsonl` 主会话文件并写入 lines。 */
  addMainSession: (slug: string, name: string, lines: string[]) => string
  /** seed 一个子代理文件族（新布局：`<root>/<sid>/subagents/`）。 */
  seedSubagentFamily: (sid: string, saId: string) => {
    sessionFile: string
    sidecars: string[]
    manifest: string
    events: string
  }
  /** seed 树内一个普通域文件（附件/日志等，验证随整树回收）。 */
  seedTreeFile: (sid: string, relPath: string, content?: string) => string
  treeDir: (sid: string) => string
  bgTaskDir: (sid: string) => string
  sessionViewPath: (sid: string) => string
}

let pool: Pool | null = null

function makePool(): Pool {
  const root = mkdtempSync(join(tmpdir(), 'taiji-content-cascade-'))
  const storeRoot = join(root, 'ext-sessions')
  const agentDir = join(root, 'agent')
  const sessionsRoot = join(agentDir, 'sessions')
  mkdirSync(sessionsRoot, { recursive: true })
  mkdirSync(storeRoot, { recursive: true })
  const p: Pool = {
    root,
    storeRoot,
    agentDir,
    sessionsRoot,
    addMainSession: (slug, name, lines) => {
      const dir = join(sessionsRoot, slug)
      mkdirSync(dir, { recursive: true })
      const filePath = join(dir, `${name}.jsonl`)
      writeFileSync(filePath, lines.join('\n') + '\n', 'utf8')
      return filePath
    },
    seedSubagentFamily: (sid, saId) => {
      const sessionsDir = join(storeRoot, sid, 'subagents', 'sessions')
      const recordsDir = join(storeRoot, sid, 'subagents', 'records')
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
    seedTreeFile: (sid, relPath, content = 'x') => {
      const filePath = join(storeRoot, sid, relPath)
      mkdirSync(join(filePath, '..'), { recursive: true })
      writeFileSync(filePath, content, 'utf8')
      return filePath
    },
    treeDir: (sid) => join(storeRoot, sid),
    bgTaskDir: (sid) => join(storeRoot, sid, 'background-tasks'),
    sessionViewPath: (sid) => join(storeRoot, sid, 'session-view.md'),
  }
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
  /** 删除链事件序列（顺序断言用：reap / treeTrash / trash / purge）。 */
  events: string[]
  trashed: string[]
  treeTrashed: string[]
  mainSidecarsPurged: string[]
}

function makeDeps(): DepsHandle {
  const warnings: string[] = []
  const events: string[] = []
  const trashed: string[] = []
  const treeTrashed: string[] = []
  const mainSidecarsPurged: string[] = []
  return {
    deps: {
      trash: vi.fn(async (filePath: string) => { events.push(`trash:${filePath}`); trashed.push(filePath) }),
      // 整树软删 fake：记录调用 + 按通道语义移除目录（mac 废纸篓 / 非 mac 递归删的
      // 共同效果 = 原位置不再存在），供「树是唯一删除单元」断言。
      trashSessionTree: vi.fn(async (dirPath: string) => {
        events.push(`treeTrash:${dirPath}`)
        treeTrashed.push(dirPath)
        rmSync(dirPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      }),
      purgeMainSidecars: vi.fn((filePath: string) => { events.push(`purge:${filePath}`); mainSidecarsPurged.push(filePath) }),
      reapBackgroundTasks: vi.fn(async () => { events.push('reap') }),
      warn: (message: string) => { warnings.push(message) },
    },
    warnings,
    events,
    trashed,
    treeTrashed,
    mainSidecarsPurged,
  }
}

/** 跑一次级联（输入按 fixture 装配）。 */
async function runCascade(sid: string, mainFile: string, p: Pool, h: DepsHandle, skipIfMainFileMissing = true) {
  return cascadeDeleteSessionContent(
    { sessionId: sid, sessionFilePath: mainFile, agentDir: p.agentDir, sessionsRoot: p.sessionsRoot, sessionStoreRoot: p.storeRoot, skipIfMainFileMissing },
    h.deps,
  )
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
  for (const path of Array.isArray(paths) ? paths : [paths]) {
    expect({ path, exists: existsSync(path) }).toEqual({ path, exists: false })
  }
}

function expectPresent(paths: string | string[]): void {
  for (const path of Array.isArray(paths) ? paths : [paths]) {
    expect({ path, exists: existsSync(path) }).toEqual({ path, exists: true })
  }
}

// ── 验收①：删除链四段 ────────────────────────────────────────────────────────

describe('cascadeDeleteSessionContent 删除链四段（验收①）', () => {
  it('顺序 = 收殓 → 整树软删 → 主文件 trash → sidecars 清理；整树软删目标 = `<root>/<sid>/`', async () => {
    const p = makePool()
    const h = makeDeps()
    const mainSid = 'main-aaaa'
    const mainFile = p.addMainSession('slug-a', `2026T_${mainSid}`, ['{"type":"session"}'])
    p.seedTreeFile(mainSid, 'attachments/paste-1.png', 'png')

    const result = await runCascade(mainSid, mainFile, p, h)

    expect(result.failures).toEqual([])
    expect(result.sessionTreeTrashed).toBe(true)
    // 四段顺序（收殓先于一切删除动作）
    expect(h.events[0]).toBe('reap')
    expect(h.events[1]).toBe(`treeTrash:${p.treeDir(mainSid)}`)
    expect(h.events[2]).toBe(`trash:${mainFile}`)
    expect(h.events[3]).toBe(`purge:${mainFile}`)
    expect(h.treeTrashed).toEqual([p.treeDir(mainSid)])
    expect(h.trashed).toEqual([mainFile])
    expect(h.mainSidecarsPurged).toEqual([mainFile])
  })

  it('整树软删是树内全部域的唯一删除单元（subagents / attachments / background-tasks / session-view 一并出废纸篓）', async () => {
    const p = makePool()
    const h = makeDeps()
    const mainSid = 'main-bbbb'
    const family = p.seedSubagentFamily(mainSid, 'sa-1')
    const attachment = p.seedTreeFile(mainSid, 'attachments/paste-1.png', 'png')
    const imageCache = p.seedTreeFile(mainSid, 'image-cache/img-1.png', 'png')
    const bgRegistry = p.seedTreeFile(mainSid, 'background-tasks/registry.json', '{}')
    const sessionView = p.seedTreeFile(mainSid, 'session-view.md', 'md')
    const log = p.seedTreeFile(mainSid, 'logs/pi-2026-10-17.jsonl', '{}')
    const mainFile = p.addMainSession('slug-a', `2026T_${mainSid}`, [
      registeredLine('sa-1'),
      settledLine('sa-1', family.sessionFile),
    ])

    const result = await runCascade(mainSid, mainFile, p, h)

    expect(result.failures).toEqual([])
    expect(result.subagentFamiliesResidual).toBe(0) // 无共享 → 族随树回收（无逐族删除段）
    expectGone(p.treeDir(mainSid))
    expectGone([family.sessionFile, ...family.sidecars, family.manifest, family.events])
    expectGone([attachment, imageCache, bgRegistry, sessionView, log])
  })

  it('树不存在 → 零动作不抛（sessionTreeTrashed=false，主文件 trash 照常）', async () => {
    const p = makePool()
    const h = makeDeps()
    const mainSid = 'main-cccc'
    const mainFile = p.addMainSession('slug-a', `2026T_${mainSid}`, ['{"type":"session"}'])

    const result = await runCascade(mainSid, mainFile, p, h)

    expect(result.sessionTreeTrashed).toBe(false)
    expect(result.failures).toEqual([])
    expect(h.treeTrashed).toEqual([]) // 不空跑通道（ENOENT 由存在性守卫挡掉）
    expect(h.trashed).toEqual([mainFile])
  })

  it('active 分支语义：主文件不存在 + skipIfMainFileMissing → 整体零动作（不收殓不删树）', async () => {
    const p = makePool()
    const h = makeDeps()
    const mainSid = 'main-dddd'
    p.seedTreeFile(mainSid, 'attachments/paste-1.png', 'png')
    const missing = join(p.sessionsRoot, 'slug-a', `2026T_${mainSid}.jsonl`)

    const result = await runCascade(mainSid, missing, p, h, true)

    expect(result).toEqual({
      mainFileExisted: false,
      referenceScan: 'skipped',
      sessionTreeTrashed: false,
      subagentFamiliesResidual: 0,
      failures: [],
    })
    expect(h.events).toEqual([])
    expectPresent(p.treeDir(mainSid))
  })

  it('scanned 分支语义：主文件不存在仍收殓 + 整树软删 + 清孤儿 sidecar', async () => {
    const p = makePool()
    const h = makeDeps()
    const mainSid = 'main-eeee'
    p.seedTreeFile(mainSid, 'attachments/paste-1.png', 'png')
    const missing = join(p.sessionsRoot, 'slug-a', `2026T_${mainSid}.jsonl`)

    const result = await runCascade(mainSid, missing, p, h, false)

    expect(result.mainFileExisted).toBe(false)
    expect(result.sessionTreeTrashed).toBe(true)
    expect(result.failures).toEqual([])
    expect(h.events).toEqual(['reap', `treeTrash:${p.treeDir(mainSid)}`, `purge:${missing}`])
    expectGone(p.treeDir(mainSid))
  })
})

// ── 验收②：fork 引用转移回退 ─────────────────────────────────────────────────

describe('cascadeDeleteSessionContent fork 共享回退（验收②）', () => {
  it('B 引用 A 树内族（settled.sessionFile 绝对路径锚）→ 族保留 A 树残留、原路径可解析', async () => {
    const p = makePool()
    const h = makeDeps()
    const family = p.seedSubagentFamily('main-cccc', 'sa-fork')
    // fork 产物 = 原样复制 record entries（settled.sessionFile 指向不变——session-fork.ts
    // createForkedSessionFile 逐条 JSON.stringify 复制的真实语义；形态 = 绝对路径）。
    const entryLines = [registeredLine('sa-fork'), settledLine('sa-fork', family.sessionFile)]
    const fileA = p.addMainSession('slug-a', '2026T_a', ['{"type":"session","id":"a"}', ...entryLines])
    const fileB = p.addMainSession('slug-a', '2026T_b', ['{"type":"session","id":"b"}', ...entryLines])
    // A 树内其他域数据（应随整树回收）
    const attachment = p.seedTreeFile('main-cccc', 'attachments/paste-1.png', 'png')

    const result = await runCascade('main-cccc', fileA, p, h)

    expect(result.failures).toEqual([])
    expect(result.referenceScan).toBe('ok')
    expect(result.subagentFamiliesResidual).toBe(1)
    expect(result.sessionTreeTrashed).toBe(true)
    // 被引用族回到 A 树残留（B 的 sessionFile 绝对路径引用可解析）
    expectPresent([family.sessionFile, ...family.sidecars, family.manifest, family.events])
    // 其余树内域随整树回收
    expectGone(attachment)
    expect(h.warnings.some((w) => w.includes('fork fallback') && w.includes('sa-fork'))).toBe(true)
    // 暂存区已清除（无 .deletion-staging-* 残留）
    expect(readdirSync(p.storeRoot).filter((n) => n.startsWith('.deletion-staging-'))).toEqual([])
    // B 仍在池内：删 B 时池内已无引用 → B 自己树内无该族可删；被引用族物理落在 A 残留
    // 树内，B 的删除编排只回收 B 自己的树（D6 同口径），残留按 D5 回退语义接受。
    rmSync(fileA)
    const h2 = makeDeps()
    const r2 = await runCascade('main-dddd', fileB, p, h2)
    expect(r2.subagentFamiliesResidual).toBe(0)
    expect(r2.sessionTreeTrashed).toBe(false) // B 从未在存储树落数据
    expectPresent([family.sessionFile, ...family.sidecars, family.manifest, family.events])
  })

  it('registered id 锚（另一会话仅含 registered 条目，无 sessionFile）→ registered-only 族保留 A 树残留', async () => {
    const p = makePool()
    const h = makeDeps()
    const family = p.seedSubagentFamily('main-ffff', 'sa-only')
    const mainFile = p.addMainSession('slug-a', '2026T_a', [registeredLine('sa-only')])
    p.addMainSession('slug-b', '2026T_b', [registeredLine('sa-only')])

    const result = await runCascade('main-ffff', mainFile, p, h)

    expect(result.subagentFamiliesResidual).toBe(1)
    expect(result.failures).toEqual([])
    expectPresent([family.sessionFile, ...family.sidecars, family.manifest, family.events])
  })

  it('无引用 → 族随整树回收（无残留、无保留告警）', async () => {
    const p = makePool()
    const h = makeDeps()
    const family = p.seedSubagentFamily('main-gggg', 'sa-solo')
    const mainFile = p.addMainSession('slug-a', `2026T_${'main-gggg'}`, [
      registeredLine('sa-solo'),
      settledLine('sa-solo', family.sessionFile),
    ])

    const result = await runCascade('main-gggg', mainFile, p, h)

    expect(result.subagentFamiliesResidual).toBe(0)
    expect(result.failures).toEqual([])
    expectGone([family.sessionFile, ...family.sidecars, family.manifest, family.events])
    expect(h.warnings.some((w) => w.includes('fork fallback'))).toBe(false)
  })

  it('树删失败（trashSessionTree rejection）→ 原样上抛 + 暂存副本丢弃、A 树原状未动（G4 可恢复形态）', async () => {
    const p = makePool()
    const family = p.seedSubagentFamily('main-hhhh', 'sa-guard')
    const entryLines = [registeredLine('sa-guard'), settledLine('sa-guard', family.sessionFile)]
    const fileA = p.addMainSession('slug-a', '2026T_a', ['{"type":"session","id":"a"}', ...entryLines])
    p.addMainSession('slug-a', '2026T_b', ['{"type":"session","id":"b"}', ...entryLines])
    const h = makeDeps()
    h.deps.trashSessionTree = vi.fn(async () => { throw new Error('移入废纸篓失败（Finder 未在 5s 内响应或命令失败）') })

    await expect(runCascade('main-hhhh', fileA, p, h)).rejects.toThrow('移入废纸篓失败')
    // A 树原状（拷贝形态暂存，无回滚需求）+ 暂存区已清除
    expectPresent([family.sessionFile, ...family.sidecars, family.manifest, family.events])
    expect(readdirSync(p.storeRoot).filter((n) => n.startsWith('.deletion-staging-'))).toEqual([])
    // 主文件未 trash（树删失败即整体失败，本体保留供重试）
    expect(h.trashed).toEqual([])
  })
})

// ── 引用并集保守方向 ─────────────────────────────────────────────────────────

describe('cascadeDeleteSessionContent 引用并集扫描失败（保守保留）', () => {
  it('他会话文件内坏行 → 引用状态不可知 → 全族保留在残留树 + 失败出声', async () => {
    const p = makePool()
    const h = makeDeps()
    const family = p.seedSubagentFamily('main-iiii', 'sa-unknown')
    const mainFile = p.addMainSession('slug-a', '2026T_a', [
      registeredLine('sa-unknown'),
      settledLine('sa-unknown', family.sessionFile),
    ])
    // 他会话文件内 subagent-record 候选行含坏 JSON（引用状态不可知 → 宁保留）
    p.addMainSession('slug-b', '2026T_bad', ['{"type":"custom","customType":"subagent-record","data":{"v":2,TRUNCATED'])

    const result = await runCascade('main-iiii', mainFile, p, h)

    expect(result.referenceScan).toBe('failed')
    expect(result.subagentFamiliesResidual).toBe(1)
    expect(result.failures.some((f) => f.includes('reference union scan failed'))).toBe(true)
    expect(h.warnings.some((w) => w.includes('keeping ALL subagent families'))).toBe(true)
    expectPresent([family.sessionFile, ...family.sidecars, family.manifest, family.events])
    // 树删与主文件删除不受影响
    expect(result.sessionTreeTrashed).toBe(true)
    expect(h.trashed).toEqual([mainFile])
  })
})

// ── 树内校验（换根后的不可信源字段处置）─────────────────────────────────────

describe('cascadeDeleteSessionContent 树内校验', () => {
  it('settled.sessionFile 落在树外（旧布局形态）且被引用 → 无树内文件可保留，留痕不失败', async () => {
    const p = makePool()
    const h = makeDeps()
    const legacySessionFile = join(p.agentDir, 'subagents', '--enc--', 'sessions', 'x_sa-legacy.jsonl')
    const entryLines = [registeredLine('sa-legacy'), settledLine('sa-legacy', legacySessionFile)]
    const fileA = p.addMainSession('slug-a', '2026T_a', ['{"type":"session","id":"a"}', ...entryLines])
    p.addMainSession('slug-a', '2026T_b', ['{"type":"session","id":"b"}', ...entryLines])
    // A 树存在但无该族文件（旧布局族不在树内）
    p.seedTreeFile('main-jjjj', 'attachments/paste-1.png', 'png')

    const result = await runCascade('main-jjjj', fileA, p, h)

    // 树内无该族文件 → 无残留可保留；旧布局文件不在整树删除面上（D6 残留）
    expect(result.subagentFamiliesResidual).toBe(0)
    expect(result.sessionTreeTrashed).toBe(true)
    // 树外锚不是失败（旧布局是合法存量形态）：只留痕，不进 failures
    expect(result.failures).toEqual([])
    expect(h.warnings.some((w) => w.includes('outside session tree subagents root'))).toBe(true)
    expectGone(p.treeDir('main-jjjj'))
  })
})

// ── 验收③：旧逐域段无残留调用（源码断言）────────────────────────────────────

describe('旧逐域段退役（验收③，源码断言）', () => {
  const cascadeSource = readFileSync(join(__dirname, '..', 'session-content-cascade.ts'), 'utf8')
  const lifecycleSource = readFileSync(join(__dirname, '..', 'session-lifecycle.ts'), 'utf8')

  it('级联模块无逐文件删除段（unlinkSync / 旧 subagents 根 / base-tool-enhance 目录 / session-view tmp 导出物）', () => {
    expect(cascadeSource.includes('unlinkSync')).toBe(false)
    expect(cascadeSource.includes("'base-tool-enhance'")).toBe(false)
    expect(cascadeSource.includes("join(agentDir, 'subagents')")).toBe(false)
    expect(cascadeSource.includes("join(ctx.agentDir, 'subagents')")).toBe(false)
    expect(cascadeSource.includes('SESSION_VIEW_TMP_DIRNAME')).toBe(false)
    expect(cascadeSource.includes('deleteSubagentFamilies')).toBe(false)
    expect(cascadeSource.includes('deleteOneFamily')).toBe(false)
  })

  it('级联模块的新删除链接线在位（整树软删 dep + 存储树根入参 + 收殓 await）', () => {
    expect(cascadeSource.includes('trashSessionTree')).toBe(true)
    expect(cascadeSource.includes('sessionStoreRoot: string')).toBe(true)
    expect(cascadeSource.includes('await deps.reapBackgroundTasks(')).toBe(true)
    // fork 回退（保留 A 树）实装在位
    expect(cascadeSource.includes('restoreStagedFamilies')).toBe(true)
  })

  it('lifecycle 三段衍生数据 rm 退役（图片缓存/产物/附件导入与 rmSync 调用均不在）', () => {
    expect(lifecycleSource.includes('getImageCacheDir')).toBe(false)
    expect(lifecycleSource.includes('getSessionArtifactsDir')).toBe(false)
    expect(lifecycleSource.includes('getAttachmentsDir')).toBe(false)
    expect(lifecycleSource.includes('sessionIdFromSessionFilePath')).toBe(false)
    expect(/rmSync\(/.test(lifecycleSource)).toBe(false)
    // 整树软删接线在位
    // D1 收尾：trashDirectory 改经 ISessionStore port 消费（C-comm-03 services 层禁 value import infra）
    expect(lifecycleSource.includes('trashSessionTree: (dirPath) => this.sessionStore.trashDirectory(dirPath)')).toBe(true)
    expect(lifecycleSource.includes('sessionStoreRoot: getSessionStoreDir()')).toBe(true)
  })
})

// ── 验收④：btw 孤儿补账退役无残留调用 ───────────────────────────────────────

describe('btw 孤儿补账退役（验收④，源码断言）', () => {
  it('启动孤儿补账模块文件已删除且 runtime 源码无 import 调用点', () => {
    // 文件名分段拼接（检查脚本按全路径 stem 扫残留引用，测试内不写全路径字面量）
    const moduleFile = ['btw-orphan', '-reconcile.ts'].join('')
    expect(existsSync(join(__dirname, '..', moduleFile))).toBe(false)
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, ent.name)
        if (ent.isDirectory()) { walk(full); continue }
        if (!ent.name.endsWith('.ts') || full === __filename) continue
        const src = readFileSync(full, 'utf8')
        // 只认 import 语句行（本断言文件自身含该字面量，且 `[^;]` 会跨行误配）
        if (/^\s*(import|export)\s[^\n]*orphan-reconcile/m.test(src)) offenders.push(full)
      }
    }
    walk(join(__dirname, '..', '..'))
    expect(offenders).toEqual([])
  })
})

// ── A23 触发面收窄（E8：session 存活路径不删树）─────────────────────────────

describe('A23 触发面收窄（E8）', () => {
  it('removeSessionEntry 汇聚链（restore 清场同链）驱动后树内后台任务 registry 目录仍在', () => {
    const p = makePool()
    activePoolRef.current = { agentDir: p.agentDir, sessionsRoot: p.sessionsRoot }
    const sid = 'main-kkkk'
    p.seedTreeFile(sid, 'background-tasks/registry.json', '{}')
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
      // 汇聚链只触发收殓（fire-and-forget），无删树/删目录通道——目录必须原样存活
      //（session 存活路径：restore 清场摘碑复活后 registry 继续读写）。
      expectPresent(p.bgTaskDir(sid))
    } finally {
      activePoolRef.current = null
    }
  })

  it('真删通道唯一性：session-lifecycle.ts 中 cascade 调用点仅在 delete 两分支（源码断言）', () => {
    const source = readFileSync(join(__dirname, '..', 'session-lifecycle.ts'), 'utf8')
    const callSites = source.match(/this\.cascadeDeletedSessionContent\(/g) ?? []
    expect(callSites.length).toBe(2)
    // active 分支 = skipIfMainFileMissing: true；scanned 分支 = false
    expect(source.includes('cascadeDeletedSessionContent(sessionId, session.sessionFilePath, true)')).toBe(true)
    expect(source.includes('cascadeDeletedSessionContent(sessionId, target.filePath, false)')).toBe(true)
  })
})

// ── SessionLifecycle.delete 端到端（scanned 分支真实驱动级联）────────────────

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

// 整树软删走真实 trashDirectory：platform 钉 linux（任何宿主机都走非 mac 降级
// rmSync 分支，断言落盘效果）；包装成可控 spy 记录调用序（默认经闭包转调真实现）。
// 存储树根 = globalSetup 钉扎的测试数据目录（fs-guard 白名单内）。
const treeTrashOrder = vi.hoisted(() => ({ events: [] as string[] }))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, platform: () => 'linux' }
})

vi.mock('../../../infra/system/trash.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../infra/system/trash.js')>()
  return {
    ...actual,
    trashDirectory: vi.fn((dirPath: string) => {
      treeTrashOrder.events.push(`treeTrash:${dirPath}`)
      return actual.trashDirectory(dirPath)
    }),
  }
})

// tombstone 登记钉成可观测 spy（记录调用序；真实实现在 session-data-store，此处只验时序）
vi.mock('../../plugin-service/session-data-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../plugin-service/session-data-store.js')>()
  return {
    ...actual,
    clearRemovedSessionData: vi.fn((sessionId: string) => {
      treeTrashOrder.events.push(`tombstone:${sessionId}`)
    }),
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
    // D5 整树软删（ISessionStore.trashDirectory）：端到端走真实降级通道（platform 钉 linux），
    // 效果断言 = 原位置目录消失；事件序列入 treeTrashOrder（tombstone 先于 treeTrash 时序断言）。
    trashDirectory: vi.fn(async (dirPath: string) => {
      treeTrashOrder.events.push(`treeTrash:${dirPath}`)
      rmSync(dirPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }),
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

/** globalSetup 钉扎数据目录内的存储树路径（测试只建/删本 sid 目录，不动树根）。 */
function pinnedStoreDir(sid: string): string {
  return join(getSessionStoreDir(), sid)
}

/** 在 pinned 存储树内 seed 一个子代理文件族（返回族文件清单）。 */
function seedPinnedFamily(sid: string, saId: string): { sessionFile: string; sidecars: string[]; manifest: string; events: string } {
  const sessionsDir = join(pinnedStoreDir(sid), 'subagents', 'sessions')
  const recordsDir = join(pinnedStoreDir(sid), 'subagents', 'records')
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
}

describe('SessionLifecycle.delete 端到端（scanned 分支真实驱动级联）', () => {
  it('delete 走真实链：树内 subagents + 附件 + 后台任务目录全清、整树软删通道被调', async () => {
    const p = makePool()
    activePoolRef.current = { agentDir: p.agentDir, sessionsRoot: p.sessionsRoot }
    const sid = 'main-kkkk'
    const family = seedPinnedFamily(sid, 'sa-e2e')
    const treeDir = pinnedStoreDir(sid)
    mkdirSync(join(treeDir, 'attachments'), { recursive: true })
    writeFileSync(join(treeDir, 'attachments', 'paste-1.png'), 'png', 'utf8')
    mkdirSync(join(treeDir, 'background-tasks'), { recursive: true })
    writeFileSync(join(treeDir, 'background-tasks', 'registry.json'), '{}', 'utf8')
    const mainFile = p.addMainSession('slug-e2e', `2026T_${sid}`, [
      registeredLine('sa-e2e'),
      settledLine('sa-e2e', family.sessionFile),
    ])

    const lifecycle = makeLifecycle(sid, mainFile, p.root)
    try {
      await lifecycle.delete(sid)
      expectGone(treeDir)
      expectGone([family.sessionFile, ...family.sidecars, family.manifest, family.events])
      expect(treeTrashOrder.events.some((e) => e === `treeTrash:${treeDir}`)).toBe(true)
    } finally {
      activePoolRef.current = null
      rmSync(treeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('tombstone 登记先于整树软删（迟到写守卫时序，D5②）', async () => {
    const p = makePool()
    activePoolRef.current = { agentDir: p.agentDir, sessionsRoot: p.sessionsRoot }
    const sid = 'main-llll'
    const treeDir = pinnedStoreDir(sid)
    mkdirSync(join(treeDir, 'attachments'), { recursive: true })
    writeFileSync(join(treeDir, 'attachments', 'paste-1.png'), 'png', 'utf8')
    const mainFile = p.addMainSession('slug-e2e', `2026T_${sid}`, ['{"type":"session"}'])
    treeTrashOrder.events = []

    const lifecycle = makeLifecycle(sid, mainFile, p.root)
    try {
      await lifecycle.delete(sid)
      const tombstoneAt = treeTrashOrder.events.findIndex((e) => e === `tombstone:${sid}`)
      const treeTrashAt = treeTrashOrder.events.findIndex((e) => e === `treeTrash:${treeDir}`)
      expect(tombstoneAt).toBeGreaterThanOrEqual(0)
      expect(treeTrashAt).toBeGreaterThan(tombstoneAt)
    } finally {
      activePoolRef.current = null
      rmSync(treeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})
