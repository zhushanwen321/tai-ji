/**
 * provider-live-sync 单元测试（设计 §4.2「单元（extension）」全部断言）。
 *
 * 被测面 = 纯函数（`readObservation` / `evaluateSnapshot`），不依赖 pi 运行时：
 * 决策与基线推进是全部语义所在，时钟/timer 不进断言（timer 只做调度）。
 *
 * 覆盖映射（设计行 → 用例）：
 * - 内容变化 → refresh；内容相同 → 零 refresh
 * - auth.json 单独变化仍触发（两文件独立比较）
 * - D3 四态：① 持续缺失（catalog-only 常态）+ 另一文件变化仍触发；② 曾存在→缺失 → 不 refresh；
 *   ③ 非 ENOENT 读失败只跳过该文件；④ 不存在→存在 → refresh
 * - 基线推进：同一坏内容连续 N 拍 → 决策 refresh 恰 1 次（不重复）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import providerLiveSync, {
  evaluateSnapshot,
  readObservation,
  POLL_INTERVAL_MS,
  WATCHED_FILES,
  type FileObservation,
  type Snapshot,
  type WatchedFile,
} from '../index.ts'

// tick 层用例：mock pi 宿主模块的 getAgentDir 指向真实 tmp fixture。纯函数用例不经
// getAgentDir（readObservation 显式传目录），mock 对它们无影响。
const piMocks = vi.hoisted(() => ({ agentDir: '' }))

vi.mock('@earendil-works/pi-coding-agent', () => ({
  getAgentDir: () => piMocks.agentDir,
}))

function makeSnapshot(): Snapshot {
  return { baselines: new Map(), initialized: false, suppressed: new Set() }
}

function obs(entries: Partial<Record<WatchedFile, FileObservation>>): Map<WatchedFile, FileObservation> {
  const m = new Map<WatchedFile, FileObservation>()
  for (const file of WATCHED_FILES) {
    m.set(file, entries[file] ?? { state: 'absent' })
  }
  return m
}

const present = (content: string): FileObservation => ({ state: 'present', content })

describe('evaluateSnapshot —— 变更检测（内容比较 + 按文件独立基线）', () => {
  it('首拍（无基线）建立基线并触发 refresh；内容相同 → 后续拍零 refresh', () => {
    const snap = makeSnapshot()
    const first = evaluateSnapshot(snap, obs({ 'models.json': present('{"providers":{}}') }))
    expect(first).toMatchObject({ action: 'refresh', changedFiles: ['models.json'] })

    const second = evaluateSnapshot(snap, obs({ 'models.json': present('{"providers":{}}') }))
    expect(second).toEqual({ action: 'none', reason: 'unchanged' })
  })

  it('内容变化 → refresh（且只列变化的文件）', () => {
    const snap = makeSnapshot()
    evaluateSnapshot(snap, obs({ 'models.json': present('A'), 'auth.json': present('X') }))
    const d = evaluateSnapshot(snap, obs({ 'models.json': present('B'), 'auth.json': present('X') }))
    expect(d).toMatchObject({ action: 'refresh', changedFiles: ['models.json'] })
  })

  it('auth.json 单独变化（凭据类变更）→ 仍触发 refresh', () => {
    const snap = makeSnapshot()
    evaluateSnapshot(snap, obs({ 'models.json': present('A'), 'auth.json': present('X') }))
    const d = evaluateSnapshot(snap, obs({ 'models.json': present('A'), 'auth.json': present('Y') }))
    expect(d).toMatchObject({ action: 'refresh', changedFiles: ['auth.json'] })
  })

  it('半写内容（截断 JSON）也是「内容变化」→ 触发 refresh；下一拍完整内容到达 → 再刷一次', () => {
    const snap = makeSnapshot()
    evaluateSnapshot(snap, obs({ 'auth.json': present('{"kimi":{"apiKey":"sk-1"}}') }))
    const truncated = evaluateSnapshot(snap, obs({ 'auth.json': present('{"kimi":{"apiK') }))
    expect(truncated).toMatchObject({ action: 'refresh', changedFiles: ['auth.json'] })
    const healed = evaluateSnapshot(snap, obs({ 'auth.json': present('{"kimi":{"apiKey":"sk-1"}}') }))
    expect(healed).toMatchObject({ action: 'refresh', changedFiles: ['auth.json'] })
  })

  it('基线推进与成败无关：同一坏内容连续 N 拍 → refresh 恰 1 次（不重复、无日志风暴）', () => {
    const snap = makeSnapshot()
    let refreshes = 0
    const bad = present('{ not json')
    for (let i = 0; i < 5; i += 1) {
      const d = evaluateSnapshot(snap, obs({ 'models.json': bad }))
      if (d.action === 'refresh') refreshes += 1
    }
    expect(refreshes).toBe(1)
  })
})

describe('evaluateSnapshot —— D3 四态（models.json 缺失是 catalog-only 常态）', () => {
  it('① 持续缺失 + auth.json 变化 → 仍触发 refresh（缺失不阻断另一文件）', () => {
    const snap = makeSnapshot()
    // 首拍：models.json 不存在（catalog-only 安装常态），auth.json 在场
    const first = evaluateSnapshot(snap, obs({ 'auth.json': present('X') }))
    expect(first).toMatchObject({ action: 'refresh', changedFiles: ['auth.json'] })
    // 第二拍：models.json 仍缺失，auth.json 变化 → 仍要刷新（旧「两文件都成功才比较」规则会失效）
    const second = evaluateSnapshot(snap, obs({ 'auth.json': present('Y') }))
    expect(second).toMatchObject({ action: 'refresh', changedFiles: ['auth.json'] })
  })

  it('② 曾存在 → 缺失 → skip-missing（抑制 refresh，防空配置重建可用集合）', () => {
    const snap = makeSnapshot()
    evaluateSnapshot(snap, obs({ 'models.json': present('A'), 'auth.json': present('X') }))
    const d = evaluateSnapshot(snap, obs({ 'models.json': { state: 'absent' }, 'auth.json': present('X') }))
    expect(d).toEqual({ action: 'skip-missing', missingFiles: ['models.json'] })
    // 持续缺失：抑制保持（每拍仍判定 skip-missing），但调用方按跃迁去重 → 只在第一拍记一行
    // 日志（`missingLogged`），后续拍零输出（稳态无噪声，设计 §3.6 行 2/S9a②）。
    const d2 = evaluateSnapshot(snap, obs({ 'models.json': { state: 'absent' }, 'auth.json': present('X') }))
    expect(d2).toEqual({ action: 'skip-missing', missingFiles: ['models.json'] })
  })

  it('②变体1：曾存在 → 缺失 + 另一文件同时变化 → 抑制优先（本拍不刷新）', () => {
    const snap = makeSnapshot()
    evaluateSnapshot(snap, obs({ 'models.json': present('A'), 'auth.json': present('X') }))
    const d = evaluateSnapshot(snap, obs({ 'models.json': { state: 'absent' }, 'auth.json': present('Y') }))
    expect(d).toEqual({ action: 'skip-missing', missingFiles: ['models.json'] })
  })

  it('②变体2（持续抑制）：文件仍缺失时，后续其它文件变化也一律抑制（否则空配置会打塌可用集合）', () => {
    const snap = makeSnapshot()
    evaluateSnapshot(snap, obs({ 'models.json': present('A'), 'auth.json': present('X') }))
    evaluateSnapshot(snap, obs({ 'models.json': { state: 'absent' }, 'auth.json': present('X') }))
    // 第二拍：models.json 仍缺失（基线已 absent），auth.json 又变化 → 仍必须抑制
    const d = evaluateSnapshot(snap, obs({ 'models.json': { state: 'absent' }, 'auth.json': present('Z') }))
    expect(d).toEqual({ action: 'skip-missing', missingFiles: ['models.json'] })
  })

  it('②变体3（恢复）：文件被写回 → 解除抑制并触发一次 refresh', () => {
    const snap = makeSnapshot()
    evaluateSnapshot(snap, obs({ 'models.json': present('A'), 'auth.json': present('X') }))
    evaluateSnapshot(snap, obs({ 'models.json': { state: 'absent' }, 'auth.json': present('X') }))
    const d = evaluateSnapshot(snap, obs({ 'models.json': present('A-fixed'), 'auth.json': present('X') }))
    expect(d).toMatchObject({ action: 'refresh', changedFiles: ['models.json'] })
    // 抑制已解除：后续同内容拍回到「无变化」
    const d2 = evaluateSnapshot(snap, obs({ 'models.json': present('A-fixed'), 'auth.json': present('X') }))
    expect(d2).toEqual({ action: 'none', reason: 'unchanged' })
  })

  it('②变体4（auth.json 不对称）：auth.json 曾存在 → 缺失 → 按普通变化处理（凭据缺失自愈，不抑制）', () => {
    const snap = makeSnapshot()
    evaluateSnapshot(snap, obs({ 'models.json': present('A'), 'auth.json': present('X') }))
    const d = evaluateSnapshot(snap, obs({ 'models.json': present('A'), 'auth.json': { state: 'absent' } }))
    expect(d).toMatchObject({ action: 'refresh', changedFiles: ['auth.json'] })
    // 写回后再次刷新（恢复）
    const d2 = evaluateSnapshot(snap, obs({ 'models.json': present('A'), 'auth.json': present('X') }))
    expect(d2).toMatchObject({ action: 'refresh', changedFiles: ['auth.json'] })
  })

  it('③ 非 ENOENT 读失败（unreadable）→ 只跳过该文件，另一文件照常比较', () => {
    const snap = makeSnapshot()
    evaluateSnapshot(snap, obs({ 'models.json': present('A'), 'auth.json': present('X') }))
    const d = evaluateSnapshot(snap, obs({ 'models.json': { state: 'unreadable' }, 'auth.json': present('Y') }))
    expect(d).toMatchObject({ action: 'refresh', changedFiles: ['auth.json'] })
    // 该文件基线未被动（下拍读得回来仍是原内容 → 不误报变化）
    const d2 = evaluateSnapshot(snap, obs({ 'models.json': present('A'), 'auth.json': present('Y') }))
    expect(d2).toEqual({ action: 'none', reason: 'unchanged' })
  })

  it('③变体：两文件都不可读 → 本拍无动作（不刷新、不推进任何基线）', () => {
    const snap = makeSnapshot()
    const d = evaluateSnapshot(snap, obs({ 'models.json': { state: 'unreadable' }, 'auth.json': { state: 'unreadable' } }))
    expect(d).toEqual({ action: 'none', reason: 'all-unreadable' })
    expect(snap.baselines.size).toBe(0)
  })

  it('④ 不存在 → 存在（首次保存 provider 物化文件）→ refresh', () => {
    const snap = makeSnapshot()
    evaluateSnapshot(snap, obs({ 'models.json': { state: 'absent' }, 'auth.json': present('X') }))
    const d = evaluateSnapshot(snap, obs({ 'models.json': present('{"providers":{"p":{"models":[{"id":"m"}]}}}'), 'auth.json': present('X') }))
    expect(d).toMatchObject({ action: 'refresh', changedFiles: ['models.json'] })
  })
})

describe('readObservation —— 真实文件系统（ENOENT vs 其它错误的区分）', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'provider-live-sync-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('文件存在 → present + 原样内容（不解析）', async () => {
    writeFileSync(join(dir, 'models.json'), '{"providers":{}}')
    const o = await readObservation(dir, 'models.json')
    expect(o).toEqual({ state: 'present', content: '{"providers":{}}' })
  })

  it('文件不存在 → absent（ENOENT 是合法态，不是错误）', async () => {
    expect(await readObservation(dir, 'models.json')).toEqual({ state: 'absent' })
  })

  it('目录位（EISDIR）等非 ENOENT 故障 → unreadable', async () => {
    mkdirSync(join(dir, 'auth.json'))
    expect(await readObservation(dir, 'auth.json')).toEqual({ state: 'unreadable' })
  })

  it('无读权限 → unreadable（不异常外泄）', async () => {
    writeFileSync(join(dir, 'auth.json'), '{}')
    chmodSync(join(dir, 'auth.json'), 0o000)
    try {
      const o = await readObservation(dir, 'auth.json')
      // root 用户（CI 容器）可能无视权限位 → 两种结果都合法，断言不抛即可
      expect(['unreadable', 'present']).toContain(o.state)
    } finally {
      chmodSync(join(dir, 'auth.json'), 0o600)
    }
  })
})

/**
 * tick 层（MF-1-1 回归）：decision 之外的扩展运行时行为——首基线完成的置位时机与
 * `modelRegistry.refresh` 触发。
 *
 * catalog-only 全新安装标准路径：首拍双 absent（models.json/auth.json 均不存在）→ 用户
 * 首次保存凭据（auth.json 物化）→ **必须** refresh。缺陷形态：initialized 只在 refresh
 * 分支内置位，双 absent 首拍 decision=none 提前 return 不置位，首个真实变化被
 * firstBaseline 吞掉（用户首次配完凭据切模型仍报 Model not found）。
 *
 * 驱动方式：getAgentDir mock 指向真实 tmp fixture（mkdtemp 自建自删）；fake pi 只需
 * `on('session_start')` 捕获 ctx（含 refresh/getError spy）；fake timers 只替换
 * setTimeout/clearTimeout——tick 链上的 readFile 与 setImmediate 保持真实，I/O 宏任务
 * 逐事件循环轮次自然落地。
 */
describe('tick 层 —— 首基线置位时机与 refresh 触发', () => {
  let agentDir: string

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), 'provider-live-sync-tick-'))
    piMocks.agentDir = agentDir
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  })

  afterEach(() => {
    vi.useRealTimers()
    rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  function startWithFakeCtx(): { refresh: ReturnType<typeof vi.fn>; appendEntry: ReturnType<typeof vi.fn> } {
    const refresh = vi.fn(async () => ({ aborted: false, errors: new Map() }))
    const getError = vi.fn(() => null)
    const ctx = { modelRegistry: { refresh, getError } }
    const appendEntry = vi.fn()
    const on = vi.fn()
    providerLiveSync({ on, appendEntry } as unknown as ExtensionAPI)
    const handler = on.mock.calls.find((call) => call[0] === 'session_start')?.[1] as
      | ((event: unknown, sessionCtx: unknown) => void)
      | undefined
    expect(handler).toBeTypeOf('function')
    handler({ type: 'session_start' }, ctx)
    return { refresh, appendEntry }
  }

  /** 逐真实事件循环轮次（setImmediate 未被 fake）轮询等待谓词成立。 */
  async function waitFor(predicate: () => boolean, maxTurns = 5_000): Promise<void> {
    for (let i = 0; i < maxTurns && !predicate(); i += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }

  /**
   * 推进一个轮询周期并等本拍 tick **完整落地**。确定性拍屏障：tick 完成后其
   * `.finally(schedule)` 必然注册下一个 fake timer——等 `getTimerCount() >= 1`
   * 即证明本拍 readFile 链（真实线程池 I/O）已结束。固定轮次 flush 不行：线程池
   * 完成回调的到达轮次不定，偶发「tick 晚于下一拍的 writeFileSync 完成 → 新内容
   * 被当首基线」假红。
   */
  async function tickOnce(): Promise<void> {
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    await waitFor(() => vi.getTimerCount() >= 1)
  }

  it('MF-1-1：首拍双 absent（catalog-only 全新安装）→ auth.json 首次出现 → 必须 refresh', async () => {
    const { refresh } = startWithFakeCtx()
    await tickOnce() // 首拍：双 absent 建基线，decision=none（首拍本就不刷新）
    expect(refresh).not.toHaveBeenCalled()
    // 用户首次保存凭据：auth.json 物化（absent → present）——不得被 firstBaseline 吞掉
    writeFileSync(join(agentDir, 'auth.json'), '{"kimi":{"apiKey":"sk-1"}}')
    await tickOnce()
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalledWith({ allowNetwork: false })
  })

  it('对照不变量：首拍双在场建基线不刷新；此后内容变化 → refresh 恰一次', async () => {
    writeFileSync(join(agentDir, 'models.json'), '{"providers":{}}')
    writeFileSync(join(agentDir, 'auth.json'), '{"a":"x"}')
    const { refresh } = startWithFakeCtx()
    await tickOnce() // 首拍 decision=refresh 被 firstBaseline 吞（pi spawn 时已建快照）
    expect(refresh).not.toHaveBeenCalled()
    writeFileSync(join(agentDir, 'auth.json'), '{"a":"y"}')
    await tickOnce()
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  /**
   * 日志通道（MF-2-5 迁移回归）：error 级日志必须落 pi.appendEntry（session JSONL custom
   * entry，持久化、不依赖 pi 不捕获的 extension stderr）。驱动 `getError()` 非空分支——
   * 引擎拒绝配置是「坏配置的唯一机器证据」（SKILL.md 排障入口），其可见性不能寄望 stderr。
   */
  it('MF-2-5：引擎拒绝配置 → logger.error 落 pi.appendEntry（provider-live-sync:log）', async () => {
    writeFileSync(join(agentDir, 'models.json'), '{"providers":{}}')
    writeFileSync(join(agentDir, 'auth.json'), '{"a":"x"}')
    const refresh = vi.fn(async () => ({ aborted: false, errors: new Map() }))
    const getError = vi.fn(() => 'Invalid models.json schema: - providers')
    const ctx = { modelRegistry: { refresh, getError } }
    const appendEntry = vi.fn()
    const on = vi.fn()
    providerLiveSync({ on, appendEntry } as unknown as ExtensionAPI)
    const handler = on.mock.calls.find((call) => call[0] === 'session_start')?.[1] as
      | ((event: unknown, sessionCtx: unknown) => void)
      | undefined
    handler({ type: 'session_start' }, ctx)

    await tickOnce() // 首拍建基线（不刷新）
    writeFileSync(join(agentDir, 'auth.json'), '{"a":"y"}')
    await tickOnce() // 本拍 refresh → getError() 非空 → logger.error

    expect(appendEntry).toHaveBeenCalledWith('provider-live-sync:log', expect.objectContaining({
      level: 'error',
      message: expect.stringContaining('[provider-live-sync] model config rejected by the engine'),
    }))
  })
})
