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
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  evaluateSnapshot,
  readObservation,
  WATCHED_FILES,
  type FileObservation,
  type Snapshot,
  type WatchedFile,
} from '../index.ts'

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
