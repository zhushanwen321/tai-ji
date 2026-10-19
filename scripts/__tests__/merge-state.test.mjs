/**
 * merge 管线状态文件与 workspace 定位（scripts/merge/lib/state.mjs + workspace.mjs）。
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readMergeState, writeMergeState, mergeStatePath } from '../merge/lib/state.mjs'
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

  it('损坏 JSON 读取为 null 不抛；写入失败（只读目录）返回 null 不抛', () => {
    const root = makeTmp()
    try {
      mkdirSync(join(root, '.merge-state'), { recursive: true })
      writeFileSync(mergeStatePath(root), '{not json')
      expect(readMergeState(root)).toBeNull()
      // 写失败路径：把状态文件替换为同名目录，writeFileSync 落目录必失败
      rmSync(mergeStatePath(root))
      mkdirSync(mergeStatePath(root))
      expect(writeMergeState(root, { pr: 2 })).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
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
