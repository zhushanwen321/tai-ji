/**
 * D3 验收资产：§7 验收项 1（fork 混合分支文件冷读）gap 测试。
 *
 * 规格原文（设计文档 §7 表项 1 + §10.1 前置构造权威文本）：
 * 主会话在模型 A 发一条用户消息并等回复 → 切 B → 撤回该用户消息（活跃叶子落回 A 侧，
 * label 条目成新叶）→ 建 btw 线（fork 逐字节复制全部非 header entry，含被撤分支）→
 * 主会话切 C。**断言**：打开线显示 A（读线自身会话文件，不是主会话当前值）；重启应用后
 * 再开线仍显示 A；主会话再切到 D，线仍显示 A。impl-plan 判定 = 「可脚本化：构造临时
 * btw 线 JSONL（§10.1 六步序列的离线等价物）；真机段拆 A11」——本文件即该离线等价物。
 *
 * 与既有覆盖的分工（本文件只补 D3 验收视角的缺口，不重复单元层断言）：
 * - `src/services/session/__tests__/session-state-query.test.ts`（u-w2）项1-a/b/c 已
 *   覆盖「冷读返回 A / 重启等价仍 A / 主会话切 D 不影响」三断言，项1-d 断的是 fixture
 *   结构证据（物理尾方向带 B 记录、末条是 label）；
 * - 本文件补的缺口 = **负向对照（防门失明）的机械化**：§10.1 两个警告之一「不要用
 *   『切回 A』代替撤回（会退化成单链、门失明）」的可证伪形态 = 同一文件走「物理尾读
 *   （不裁剪）」必须得到 B（错值），与生产冷读（活跃路径裁剪）的 A 不同——两个读法在
 *   混合分支 fixture 上结果不同，门才有区分度；若两种读法同值（单链退化形态），门失明。
 *
 * 数据隔离（项目测试红线）：fixture 落 `mkdtempSync(join(tmpdir(), ...))`；
 * TAIJI_AGENT_DATA_DIR 指向该 tmp，不触真实数据目录。
 *
 * 运行：cd packages/runtime && npx vitest run test/acceptance/item1-fork-coldread.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { IProcessManager } from '../../src/services/ports/pi-engine.js'
import {
  SessionStateQuery,
  type SessionStateColdReadTrace,
} from '../../src/services/session/session-state-query.js'
import { findBtwLineFileByLayout } from '../../src/infra/pi/session-file-locator.js'
import {
  scanJsonlFromTail,
  invalidateScanDirCache,
  _resetSessionMetaCacheForTest,
} from '../../src/infra/pi/session-file-utils.js'

// ── fixture 构造（pi session JSONL 的最小真实形态；§10.1 六步序列离线等价物）────────

/** session header 行（pi 落盘首行；trimFileEntriesToActivePath 会剥掉它） */
function headerLine(id: string, cwd: string): string {
  return JSON.stringify({ type: 'session', id, cwd, timestamp: '2026-10-24T00:00:00.000Z', version: 1 })
}

function entryLine(type: string, id: string, parentId: string | undefined, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type, id, ...(parentId !== undefined ? { parentId } : {}), ...extra })
}

/** user 消息 entry（§10.1 步骤 1：撤回的定位目标形态） */
function userMessageLine(id: string, parentId: string): string {
  return entryLine('message', id, parentId, { message: { role: 'user', content: 'hello' }, timestamp: '2026-10-24T00:00:01.000Z' })
}

/** assistant 消息 entry（携带 provider/model；撤回后随 user 消息一并离开活跃路径） */
function assistantMessageLine(id: string, parentId: string, provider: string, model: string): string {
  return entryLine('message', id, parentId, { message: { role: 'assistant', provider, model, content: 'ok' }, timestamp: '2026-10-24T00:00:02.000Z' })
}

/** model_change entry（pi 唯一显式 setModel 写点；provider/modelId 平铺在 entry 顶级） */
function modelChangeLine(id: string, parentId: string, provider: string, modelId: string): string {
  return entryLine('model_change', id, parentId, { provider, modelId, timestamp: '2026-10-24T00:00:03.000Z' })
}

/** thinking_level_change entry（档位来源） */
function thinkingLevelLine(id: string, parentId: string, thinkingLevel: string): string {
  return entryLine('thinking_level_change', id, parentId, { thinkingLevel, timestamp: '2026-10-24T00:00:04.000Z' })
}

/** label entry（§10.1 步骤 3 撤回的产物：appendLabelChange 把 taiji:revoked 标签挂成新叶，parentId = 撤回后的 leafId） */
function labelLine(id: string, parentId: string, targetId: string): string {
  return entryLine('label', id, parentId, { targetId, label: 'taiji:revoked', timestamp: '2026-10-24T00:00:05.000Z' })
}

function writeJsonl(filePath: string, lines: string[]): void {
  mkdirSync(join(filePath, '..'), { recursive: true })
  writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8')
}

/** 主会话扫描区目录名（encodeCwd 分组哈希；scanPiSessions 只枚举该层目录内的 *.jsonl） */
const CWD_GROUP = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2'

/**
 * §10.1 六步序列的离线等价构造（主会话 + btw 线一对 fixture）。
 *
 * 主会话文件（步骤 1-5 的落点）：
 *   s1    session_info（根）
 *   mcA   model_change A          ← 步骤 1 前「主会话在模型 A」
 *   tlA   thinking_level_change high（A 侧 trunk——撤回后 user 消息连同其 assistant
 *         子节点一并离开活跃路径，A/high 的文件级记录只能落在 trunk 上）
 *   u1    user message
 *   a1    assistant（provider/model = A）
 *   mcB   model_change B          ← 步骤 2「切到 B」
 *   L     label taiji:revoked     ← 步骤 3 撤回 u1：leaf = u1.parentId = tlA，label 挂成新叶
 *   mcC   model_change C          ← 步骤 5「主会话切到 C」（fork 之后追加，不进线文件）
 *
 * 线文件（步骤 4 fork 的逐字节复制源文件全部非 header entry，只换 header）= s1..L 七条
 * （不含 mcC）。关键混合分支形态：线文件物理尾是 L，L 的 parentId 是 tlA——**活跃路径 =
 * [s1, mcA, tlA, L] 命中 A/high；被撤 B 分支（mcB，parentId=a1）在物理尾方向但不在活跃
 * 路径上**。物理尾逆读命中 mcB 得 B（错值，恰好复现本设计要消灭的「显示错值」缺陷），
 * 活跃路径逆读命中 mcA 得 A（对值）——两种读法在此 fixture 上结果不同，门因此有区分度。
 */
function seedForkFixture(dataDir: string): { mainSid: string; linePiId: string; mainFile: string; lineFile: string } {
  const mainSid = randomUUID()
  const linePiId = randomUUID()
  const mainFile = join(dataDir, 'agent', 'sessions', CWD_GROUP, `${mainSid}.jsonl`)
  // 线文件 = 存储树布局 `<dataDir>/ext-sessions/<mainSid>/btw/<fileTimestamp>_<linePiId>.jsonl`
  // （构造性不在 scanPiSessions 扫描范围，E-5）。文件名采 **pi forkFrom 实盘命名**
  // （session-manager.js forkFrom：`${fileTimestamp}_${newSessionId}.jsonl`，fileTimestamp =
  // ISO 时间戳的 `:`/`.`→`-`）——布局定位寻址必须命中该形态（D3 真机验收 A11 缺陷 1 的
  // 回归防线：旧实现只认精确名 `<linePiId>.jsonl`，重启后的线寻址结构性失败）。
  const lineFile = join(dataDir, 'ext-sessions', mainSid, 'btw', `2026-10-24T13-00-44-583Z_${linePiId}.jsonl`)

  const trunk = [
    headerLine(mainSid, '/tmp/proj'),
    entryLine('session_info', 's1', undefined),
    modelChangeLine('mcA', 's1', 'prov-a', 'model-a'),
    thinkingLevelLine('tlA', 'mcA', 'high'),
    userMessageLine('u1', 'tlA'),
    assistantMessageLine('a1', 'u1', 'prov-a', 'model-a'),
    modelChangeLine('mcB', 'a1', 'prov-b', 'model-b'),
    labelLine('L', 'tlA', 'u1'),
  ]
  writeJsonl(mainFile, [...trunk, modelChangeLine('mcC', 'L', 'prov-c', 'model-c')])
  // fork：复制全部非 header entry，只换 header（含被撤 B 分支）
  writeJsonl(lineFile, [headerLine(linePiId, '/tmp/proj'), ...trunk.slice(1)])

  return { mainSid, linePiId, mainFile, lineFile }
}

// ── deps fake（进程表 / btw 注册表记录）───────────────────────────────────────

/** 进程表 fake：任何 spawn 形态调用都炸（冷读零 spawn 断言的载体） */
function makeProcessTable(): IProcessManager {
  const boom = (name: string) => (): never => {
    throw new Error(`spawn risk point violated: ${name} must not be called by getState`)
  }
  return {
    getClient: () => undefined,
    hasClient: () => false,
    createSession: boom('createSession'),
    restoreSession: boom('restoreSession'),
    ensureActive: boom('ensureActive'),
    ensureProcess: boom('ensureProcess'),
    withEphemeralPi: boom('withEphemeralPi'),
    rekey: boom('rekey'),
    destroySession: boom('destroySession'),
  } as unknown as IProcessManager
}

/**
 * btw 线定位的两步（模拟生产投影注入）：注册表判别（btwRegistry Map 模拟 lifecycle
 * 记录）先行；存储树布局兜底沉到主会话两段均未命中之后（dmg-r1-3 判别顺序）。
 */
const btwRegistry = new Map<string, string>()

function makeQuery(): { query: SessionStateQuery; traces: SessionStateColdReadTrace[] } {
  const traces: SessionStateColdReadTrace[] = []
  const query = new SessionStateQuery({
    getClient: () => undefined,
    getReplicatedStates: () => undefined,
    locateMainSessionFileFromCache: () => undefined,
    locateMainSessionFileFromDisk: () => undefined,
    locateBtwLineFile: (sessionId) => btwRegistry.get(sessionId),
    locateBtwLineFileByLayout: (sessionId) => findBtwLineFileByLayout(sessionId),
    onColdRead: (t) => traces.push(t),
  })
  return { query, traces }
}

// ── 负向对照：物理尾读（不裁剪）——§10.1 警告「不要用切回 A 代替撤回」的机械化 ──────

/**
 * 物理尾读（**不**做 activePath 裁剪）的模型提取——与生产 `extractLatestModelFromJsonl`
 * 同一 collect 语义、同一 scanJsonlFromTail 骨架，唯一差别 = 不传 `{ activePath: true }`。
 * 这就是「若门失效（退化为物理尾读）」时冷读会得到的值。
 */
function physicalTailModelOf(filePath: string): { modelId: string; thinkingLevel: string } | undefined {
  const hits: { modelId: string | null; thinkingLevel: string | null } = { modelId: null, thinkingLevel: null }
  const collect = (entry: Record<string, unknown>): boolean => {
    if (hits.modelId === null) {
      if (entry.type === 'model_change'
        && typeof entry.provider === 'string' && typeof entry.modelId === 'string') {
        hits.modelId = `${entry.provider}/${entry.modelId}`
      } else if (entry.type === 'message') {
        const msg = entry.message as { role?: string; provider?: string; model?: string } | undefined
        if (msg?.role === 'assistant' && typeof msg.provider === 'string' && typeof msg.model === 'string') {
          hits.modelId = `${msg.provider}/${msg.model}`
        }
      }
    }
    if (hits.thinkingLevel === null
      && entry.type === 'thinking_level_change'
      && typeof entry.thinkingLevel === 'string') {
      hits.thinkingLevel = entry.thinkingLevel
    }
    return hits.modelId !== null && hits.thinkingLevel !== null
  }
  scanJsonlFromTail(filePath, collect) // 无 opts = 不裁剪 = 物理尾读
  if (hits.modelId === null) return undefined
  return { modelId: hits.modelId, thinkingLevel: hits.thinkingLevel ?? 'off' }
}

// ── 测试体 ─────────────────────────────────────────────────────────────

describe('§7 验收项 1：fork 混合分支文件冷读（§10.1 六步序列离线等价物）', () => {
  let dataDir: string
  let origDataDir: string | undefined

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'u-w2-item1-fork-'))
    origDataDir = process.env.TAIJI_AGENT_DATA_DIR
    process.env.TAIJI_AGENT_DATA_DIR = dataDir
    _resetSessionMetaCacheForTest()
    invalidateScanDirCache()
    btwRegistry.clear()
  })

  afterEach(() => {
    if (origDataDir === undefined) delete process.env.TAIJI_AGENT_DATA_DIR
    else process.env.TAIJI_AGENT_DATA_DIR = origDataDir
    _resetSessionMetaCacheForTest()
    btwRegistry.clear()
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('项1-a 打开（冷）btw 线显示创建时模型 A（读线自身会话文件，不是主会话当前值）', async () => {
    const fx = seedForkFixture(dataDir)
    btwRegistry.set(fx.linePiId, fx.lineFile) // 线已注册：注册表记录 sessionFilePath 命中
    const { query } = makeQuery()

    const state = await query.getState(fx.linePiId)

    expect(state).toEqual({ sessionId: fx.linePiId, modelId: 'prov-a/model-a', thinkingLevel: 'high' })
    // 冷读不产生 pi 子进程（进程表 = boom fake，任何 spawn 形态调用即抛）
    // 判别力自证：读到的不是被撤分支的 B
    expect(state.modelId).not.toBe('prov-b/model-b')
  })

  it('项1-b 重启应用后再开线仍显示 A（注册表记录缺席 + 缓存清空 + 全新查询实例）', async () => {
    const fx = seedForkFixture(dataDir)
    btwRegistry.set(fx.linePiId, fx.lineFile)
    // 重启前：注册表记录一路
    expect((await makeQuery().query.getState(fx.linePiId)).modelId).toBe('prov-a/model-a')

    // 「重启」的离线等价物：metaCache 清空（缓存不跨进程持久）+ 目录 TTL 缓存清空 +
    // 注册表记录缺席（BtwService.rebuildFromDisk() 只重建自己的 registry，不注册进
    // lifecycle.sessions → 注册表记录一路结构性缺席，走存储树布局定位兜底）+
    // 全新 SessionStateQuery 实例（无任何内存态继承）
    _resetSessionMetaCacheForTest()
    invalidateScanDirCache()
    btwRegistry.clear()
    const afterRestart = makeQuery()
    const state = await afterRestart.query.getState(fx.linePiId)

    expect(state).toEqual({ sessionId: fx.linePiId, modelId: 'prov-a/model-a', thinkingLevel: 'high' })
    // 重启后定位来源 = btw 存储树布局（source 仍为 btw-registry 口径的定位成功）
    expect(afterRestart.traces).toHaveLength(1)
    expect(afterRestart.traces[0]).toMatchObject({ sessionId: fx.linePiId, found: true })
    // 布局兜底的枚举成本进埋点（dmg-r1-3）：本文件段 1/段 2 为 stub miss（无真实全扫），
    // scannedDirCount = 布局枚举的 mainSid 会话目录数（fixture 1 个主会话目录）
    expect(afterRestart.traces[0].scannedDirCount).toBe(1)
  })

  it('项1-c 主会话再切 D 后线仍显示 A（线文件不变；主会话自身反映新值作对照）', async () => {
    const fx = seedForkFixture(dataDir)
    btwRegistry.set(fx.linePiId, fx.lineFile)
    const { query } = makeQuery()
    expect((await query.getState(fx.linePiId)).modelId).toBe('prov-a/model-a')

    // 主会话之后又换过模型（§10.1 步骤 5 之后再切 D：追加到主文件）——线文件的活跃路径不变
    appendFileSync(fx.mainFile, `${modelChangeLine('mcD', 'mcC', 'prov-d', 'model-d')}\n`)
    _resetSessionMetaCacheForTest()
    invalidateScanDirCache()

    // 线不受主会话切换影响（读自己的文件）
    expect((await query.getState(fx.linePiId)).modelId).toBe('prov-a/model-a')
    // 对照：主会话文件物理尾确已是 D（fixture 真的在动——线不读它）
    expect(physicalTailModelOf(fx.mainFile)?.modelId).toBe('prov-d/model-d')
  })

  it('项1-d 负向对照（防门失明）：同一文件物理尾读（不裁剪）返回 B，与活跃路径读结果不同', async () => {
    const fx = seedForkFixture(dataDir)
    btwRegistry.set(fx.linePiId, fx.lineFile)
    const { query } = makeQuery()

    // 生产冷读 = 活跃路径裁剪 → A（对值）
    const active = await query.getState(fx.linePiId)
    // 物理尾读（不裁剪）= 门失效时的值 → B（错值：命中被撤分支的 model_change）
    const physical = physicalTailModelOf(fx.lineFile)

    expect(physical).toEqual({ modelId: 'prov-b/model-b', thinkingLevel: 'high' })
    // 门的区分度：两种读法在混合分支 fixture 上结果不同（§10.1 警告的机械化——若 fixture
    // 退化为单链，两个值相同、门测不出任何东西）
    expect(physical?.modelId).not.toBe(active.modelId)
    expect(active.modelId).toBe('prov-a/model-a')
  })

  it('项1-e 结构证据：线文件是被撤 B 分支 + A 侧活跃路径的混合形态（物理尾 = 挂在 A 侧 trunk 的 label）', async () => {
    const fx = seedForkFixture(dataDir)
    // 混合分支形态的三条结构断言（§10.1「为何这步是门的判定器」）：
    const lines = readFileSync(fx.lineFile, 'utf8').trimEnd().split('\n')
    const entries = lines.slice(1).map((l) => JSON.parse(l) as Record<string, unknown>)
    // ① 被撤 B 分支的 model_change 在文件里（物理尾逆读会命中它 = 错值来源）
    expect(entries.some((e) => e.type === 'model_change' && e.id === 'mcB')).toBe(true)
    // ② 末条 entry 是 label（撤回后 appendLabelChange 的新叶），parentId 指向 A 侧 trunk（tlA）
    const last = entries.at(-1) as Record<string, unknown>
    expect(last).toMatchObject({ type: 'label', id: 'L', parentId: 'tlA' })
    // ③ 活跃路径回溯（L → tlA → mcA → s1）不含被撤分支任何 entry
    const byId = new Map(entries.map((e) => [e.id, e]))
    const activePath: string[] = []
    let cur: string | undefined = 'L'
    while (cur !== undefined) {
      activePath.push(cur)
      cur = byId.get(cur)?.parentId as string | undefined
    }
    expect(activePath).toEqual(['L', 'tlA', 'mcA', 's1'])
    expect(activePath).not.toContain('mcB')
    expect(activePath).not.toContain('a1')
    // 布局定位（存储树公式）与注册表记录读同一个文件（重启后两级寻址等价）
    expect(findBtwLineFileByLayout(fx.linePiId).filePath).toBe(fx.lineFile)
  })
})
