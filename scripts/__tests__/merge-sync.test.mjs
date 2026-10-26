/**
 * lib/sync.mjs（阶段 2 的 main 同步）回归测试。
 *
 * 核心防线：reset --hard 前的两道防护——①领先防护（本地 main 领先远端——发布在途
 * 的 bump/notes commit 未 push，或未知本地改动——时必须 fail-fast，而不是把未 push
 * commit 拨回）；②脏树防护（工作区有未提交的 tracked 改动时拒绝——reset --hard 会
 * 静默抹掉且 reflog 不可恢复；untracked 文件 reset --hard 不删，不属本防线损害
 * 形态，status 用 --untracked-files=no 排除）。fetch/checkout/status 退出码必须逐
 * 一检查（fetch 失败 reset 到
 * 陈旧引用；checkout 失败 reset 移动的是错误分支的指针；status 失败被当「干净」放行
 * = 脏树防线静默失效）。全部用注入的假 run 驱动，不触真实 git。
 */
import { describe, it, expect } from 'vitest'
import { syncMain } from '../merge/lib/sync.mjs'

/** 命令表驱动的假 run：args.join(' ') 精确匹配 → 结果；未登记的命令一律成功。 */
function makeRun(table = {}) {
  const calls = []
  const run = (cmd, args) => {
    const key = [cmd, ...args].join(' ')
    calls.push(key)
    const hit = table[key]
    if (hit === undefined) return { code: 0, ok: true, stdout: '', stderr: '', error: null }
    if (typeof hit === 'string') return { code: 0, ok: true, stdout: hit, stderr: '', error: null }
    return { code: hit.code ?? 1, ok: (hit.code ?? 1) === 0, stdout: hit.stdout ?? '', stderr: hit.stderr ?? '', error: null }
  }
  run.calls = calls
  return run
}

const AHEAD = (n) => ({ [`git -C /wt rev-list --count github/main..main`]: String(n) })
const OK_PATH = {
  'git -C /wt rev-list --count github/main..main': '0',
  'git -C /wt rev-parse HEAD': 'abc123\n',
}

describe('syncMain（main 同步与数据丢失防护）', () => {
  it('全通路径：fetch → 领先检查 → checkout → 脏树检查 → reset → 取 HEAD，返回 mainSha', () => {
    const run = makeRun(OK_PATH)
    const r = syncMain({ run, mainWt: '/wt', ghRemote: 'github' })
    expect(r).toEqual({ ok: true, mainSha: 'abc123' })
    expect(run.calls).toEqual([
      'git -C /wt fetch github main',
      'git -C /wt rev-list --count github/main..main',
      'git -C /wt checkout main',
      'git -C /wt status --porcelain --untracked-files=no',
      'git -C /wt reset --hard github/main',
      'git -C /wt rev-parse HEAD',
    ])
  })

  it('本地 main 领先远端 N 个未 push commit → ahead-guard 拒绝，不执行 checkout/reset', () => {
    const run = makeRun(AHEAD(7))
    const r = syncMain({ run, mainWt: '/wt' })
    expect(r).toEqual({ ok: false, step: 'ahead-guard', ahead: 7 })
    expect(run.calls).not.toContain('git -C /wt checkout main')
    expect(run.calls).not.toContain('git -C /wt reset --hard github/main')
  })

  it('工作区有未提交的 tracked 改动（M/A/D 行）→ dirty-tree 拒绝并给处置提示，reset 不执行', () => {
    const run = makeRun({
      ...OK_PATH,
      'git -C /wt status --porcelain --untracked-files=no': ' M packages/app/src/a.ts\nA  packages/app/src/new.ts\n',
    })
    const r = syncMain({ run, mainWt: '/wt' })
    expect(r).toEqual({ ok: false, step: 'dirty-tree', hint: '未提交的 tracked 改动先 commit/stash 或确认丢弃后重跑' })
    expect(run.calls).toContain('git -C /wt status --porcelain --untracked-files=no')
    expect(run.calls).not.toContain('git -C /wt reset --hard github/main')
  })

  it('仅 untracked 文件（--untracked-files=no 下 status 无输出）→ 放行 reset——reset --hard 不删 untracked，不属本防线损害形态', () => {
    const run = makeRun({
      ...OK_PATH,
      'git -C /wt status --porcelain --untracked-files=no': '',
    })
    const r = syncMain({ run, mainWt: '/wt' })
    expect(r).toEqual({ ok: true, mainSha: 'abc123' })
    expect(run.calls).toContain('git -C /wt reset --hard github/main')
  })

  it('status 失败 → status 步失败而非当「干净」放行（脏树防线不静默失效）', () => {
    const run = makeRun({ ...OK_PATH, 'git -C /wt status --porcelain --untracked-files=no': { code: 128 } })
    const r = syncMain({ run, mainWt: '/wt' })
    expect(r).toEqual({ ok: false, step: 'status' })
    expect(run.calls).not.toContain('git -C /wt reset --hard github/main')
  })

  it('领先计数输出非数字（如空串）→ ahead-count 失败而非放行', () => {
    const run = makeRun({ 'git -C /wt rev-list --count github/main..main': '' })
    expect(syncMain({ run, mainWt: '/wt' }).step).toBe('ahead-count')
  })

  it('fetch 失败 → 立即失败并给手动恢复命令（绝不 reset 到陈旧远端引用）', () => {
    const run = makeRun({ 'git -C /wt fetch github main': { code: 128 } })
    const r = syncMain({ run, mainWt: '/wt' })
    expect(r.ok).toBe(false)
    expect(r.step).toBe('fetch')
    expect(r.hint).toBe('git -C /wt fetch github main')
    expect(run.calls).toHaveLength(1)
  })

  it('checkout 失败（main 被其他 worktree 占用等）→ 失败并给恢复命令，reset 不执行', () => {
    const run = makeRun({
      ...OK_PATH,
      'git -C /wt checkout main': { code: 1, stderr: 'already checked out' },
    })
    const r = syncMain({ run, mainWt: '/wt' })
    expect(r.step).toBe('checkout')
    expect(r.hint).toBe('git -C /wt checkout main')
    expect(run.calls).not.toContain('git -C /wt reset --hard github/main')
  })

  it('reset 失败 → 报 reset 步失败；rev-parse HEAD 失败 → 报 head-sha 步失败', () => {
    const r1 = syncMain({ run: makeRun({ ...OK_PATH, 'git -C /wt reset --hard github/main': { code: 1 } }), mainWt: '/wt' })
    expect(r1.step).toBe('reset')
    const r2 = syncMain({ run: makeRun({ ...OK_PATH, 'git -C /wt rev-parse HEAD': { code: 1 } }), mainWt: '/wt' })
    expect(r2.step).toBe('head-sha')
  })
})
