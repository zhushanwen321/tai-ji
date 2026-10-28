/**
 * merge 管线状态文件与 workspace 定位（scripts/merge/lib/state.mjs + workspace.mjs）。
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readMergeState, writeMergeState, mergeStatePath, TERMINAL_STAGES, isPipelineBusy, isSamePipeline, buildMergedPatch } from '../merge/lib/state.mjs'
import { findWorkspaceRoot, mainWorktreePath } from '../merge/lib/workspace.mjs'

function makeTmp() {
  return mkdtempSync(join(tmpdir(), 'merge-state-'))
}

describe('merge 状态文件', () => {
  it('无文件时读取为 null；写入后可读回，浅合并保留旧字段', () => {
    const root = makeTmp()
    try {
      expect(readMergeState(root)).toBeNull()
      writeMergeState(root, { pr: 45, headSha: 'abc', stage: 'merged' })
      expect(readMergeState(root)).toMatchObject({ pr: 45, headSha: 'abc', stage: 'merged' })
      writeMergeState(root, { stage: 'released' })
      expect(readMergeState(root)).toMatchObject({ pr: 45, headSha: 'abc', stage: 'released' })
      expect(typeof readMergeState(root).updatedAt).toBe('string')
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('状态文件落在 workspace 根的 .merge-state/current.json（git 工作树之外）', () => {
    const root = makeTmp()
    try {
      writeMergeState(root, { pr: 1 })
      expect(mergeStatePath(root)).toBe(join(root, '.merge-state', 'current.json'))
      expect(existsSync(mergeStatePath(root))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('reset 开启新管线：上一轮 release 字段（tag/releasedAt 等）整体清除，不跨轮残留', () => {
    const root = makeTmp()
    try {
      writeMergeState(root, { pr: 45, tag: 'v0.11.15', releaseUrl: 'x', releasedAt: '2026-10-23T00:00:00Z', stage: 'released' })
      writeMergeState(root, { pipelineId: 'p2', pr: 61, stage: 'init' }, { reset: true })
      const next = readMergeState(root)
      expect(next).toMatchObject({ pipelineId: 'p2', pr: 61, stage: 'init' })
      expect(next.tag).toBeUndefined()
      expect(next.releaseUrl).toBeUndefined()
      expect(next.releasedAt).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('reset 缺省时保持浅合并（同一管线内阶段推进不丢字段）；终态词表含 released', () => {
    const root = makeTmp()
    try {
      writeMergeState(root, { pipelineId: 'p1', pr: 61, mergeSha: 'aa', stage: 'merged' })
      writeMergeState(root, { stage: 'released', tag: 'v0.11.16' })
      expect(readMergeState(root)).toMatchObject({ pipelineId: 'p1', pr: 61, mergeSha: 'aa', stage: 'released', tag: 'v0.11.16' })
      expect(TERMINAL_STAGES).toContain('released')
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('损坏 JSON 读取为 null 不抛；写入失败（只读目录）返回 null 不抛', () => {
    const root = makeTmp()
    try {
      mkdirSync(join(root, '.merge-state'), { recursive: true })
      writeFileSync(mergeStatePath(root), '{not json')
      expect(readMergeState(root)).toBeNull()
      // 写失败路径：把状态文件替换为同名目录，renameSync 落目录必失败
      rmSync(mergeStatePath(root))
      mkdirSync(mergeStatePath(root))
      expect(writeMergeState(root, { pr: 2 })).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('原子写：成功写入经 tmp+rename 落主文件，无 .tmp 残留', () => {
    const root = makeTmp()
    try {
      const next = writeMergeState(root, { pr: 7, stage: 'merged' })
      expect(next).not.toBeNull()
      expect(existsSync(mergeStatePath(root))).toBe(true)
      expect(existsSync(`${mergeStatePath(root)}.tmp`)).toBe(false)
      expect(readMergeState(root)).toMatchObject({ pr: 7, stage: 'merged' })
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})

describe('管线判定谓词（pr-merge 开线前的互斥与身份归属）', () => {
  const now = new Date().toISOString()

  it('isPipelineBusy：非终态 + 12h 窗口内 = 在途；终态/超窗/null/无 stage 不算', () => {
    expect(isPipelineBusy({ stage: 'merged', updatedAt: now })).toBe(true)
    expect(isPipelineBusy({ stage: 'init', updatedAt: now })).toBe(true)
    expect(isPipelineBusy({ stage: 'released', updatedAt: now })).toBe(false)
    expect(isPipelineBusy({ stage: 'merged', updatedAt: '2020-01-01T00:00:00Z' })).toBe(false)
    expect(isPipelineBusy(null)).toBe(false)
    expect(isPipelineBusy({ stage: '', updatedAt: now })).toBe(false)
    expect(isPipelineBusy({ updatedAt: now })).toBe(false)
  })

  it('isSamePipeline：非终态且 pr 同号才属于本管线；终态/不同号/null 不属于', () => {
    expect(isSamePipeline({ stage: 'init', pr: 61 }, 61)).toBe(true)
    expect(isSamePipeline({ stage: 'merged', pr: 61 }, 61)).toBe(true)
    expect(isSamePipeline({ stage: 'released', pr: 61 }, 61)).toBe(false)
    expect(isSamePipeline({ stage: 'merged', pr: 45 }, 61)).toBe(false)
    expect(isSamePipeline(null, 61)).toBe(false)
  })

  it('init 跳过 + 上一轮 released：不触发互斥（终态非在途），buildMergedPatch 按新管线——不延续旧 pipelineId/branch/headSha', () => {
    const root = makeTmp()
    try {
      // 上一轮管线已 released（终态残留），本次 pr-merge（pr=61）未跑 init 直接落盘
      writeMergeState(root, { pipelineId: 'old-1', branch: 'feat-x', pr: 45, headSha: 'sha-old', stage: 'released', tag: 'v0.11.15' })
      const prev = readMergeState(root)
      expect(isPipelineBusy(prev)).toBe(false)
      const patch = buildMergedPatch(prev, { prNumber: 61, headBranch: 'feat-y', headSha: 'sha-new', mergeSha: 'm1' })
      expect(patch.pipelineId).not.toBe('old-1')
      expect(patch).toMatchObject({ branch: 'feat-y', pr: 61, headSha: 'sha-new', mergeSha: 'm1', stage: 'merged' })
      // HEAD_BRANCH/HEAD_SHA 缺失时兜底空串，绝不回填上一轮管线的值
      const patch2 = buildMergedPatch(prev, { prNumber: 61, headBranch: '', headSha: '', mergeSha: 'm1' })
      expect(patch2.branch).toBe('')
      expect(patch2.headSha).toBe('')
      // 经 writeMergeState 落盘后上一轮 release 字段不跨轮残留
      writeMergeState(root, patch, { reset: true })
      expect(readMergeState(root)).toMatchObject({ pipelineId: patch.pipelineId, pr: 61, stage: 'merged' })
      expect(readMergeState(root).tag).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('init 正常跑过（非终态、pr 同号）：buildMergedPatch 延续本管线 pipelineId，缺省字段从 prevState 兜底', () => {
    const prev = { pipelineId: 'p-init', branch: 'feat-y', pr: 61, headSha: 'sha-new', stage: 'init' }
    const patch = buildMergedPatch(prev, { prNumber: 61, headBranch: '', headSha: '', mergeSha: 'm1' })
    expect(patch.pipelineId).toBe('p-init')
    expect(patch.branch).toBe('feat-y')
    expect(patch.headSha).toBe('sha-new')
  })

  it('阶段 3 在途（merged、pr 不同号、12h 内）：互斥判定命中——pr-merge 应拒绝而非覆盖', () => {
    const prev = { pipelineId: 'p9', branch: 'feat-a', pr: 45, stage: 'merged', updatedAt: now }
    expect(isPipelineBusy(prev)).toBe(true)
    expect(prev.pr !== 61).toBe(true)
  })
})

describe('workspace 定位', () => {
  it('从深层目录向上找到含 .bare/ 的根', () => {
    const root = makeTmp()
    try {
      mkdirSync(join(root, '.bare'))
      const deep = join(root, 'feat-x', 'packages', 'runtime')
      mkdirSync(deep, { recursive: true })
      expect(findWorkspaceRoot(deep)).toBe(root)
      expect(mainWorktreePath(root)).toBe(join(root, 'main'))
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('无 .bare 的目录树向上到根返回 null（给出可判定的失败而非误定位）', () => {
    const root = makeTmp()
    try {
      expect(findWorkspaceRoot(root)).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})
