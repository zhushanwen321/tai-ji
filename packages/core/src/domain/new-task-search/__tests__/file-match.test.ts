/**
 * file-candidates / file-match 下沉回归单测（plan TC-9）。
 *
 * 覆盖 toFileCandidates DTO 映射规则 + filterAndSortFileCandidates 匹配度分级排序
 * （M1 分级 / M2 文件优先 / M3 路径浅优先 / M4 字母序兜底 / M5 无 query / M6 过滤 /
 * M7 大小写不敏感 / M8 #agents 回归）。用例与 renderer __tests__/lib/ 下同名测试对齐
 * （core 版回归防护：原样下沉不得行为漂移）。
 */
import { describe, expect, it } from 'vitest'
import type { FileNode } from '@taiji/shared'
import { toFileCandidates, type FileCandidate } from '../file-candidates'
import { filterAndSortFileCandidates } from '../file-match'

/** 构造候选的辅助函数（减少样板） */
function mk(path: string, type: 'file' | 'dir', basename?: string): FileCandidate {
  const base = basename ?? path.split('/').pop() ?? path
  return {
    id: path,
    name: type === 'dir' ? `${path}/` : base,
    kind: type === 'dir' ? '目录' : '文件',
    path,
    type,
    basename: base,
  }
}

/** 取排序后的 basename 列表（便于断言顺序） */
function names(sorted: FileCandidate[]): string[] {
  return sorted.map((c) => c.basename ?? c.name)
}

describe('toFileCandidates (G16 DTO 映射)', () => {
  it('TC-9a: 目录补斜杠 + 中文 kind，文件保持 basename', () => {
    const nodes: FileNode[] = [
      { path: 'src', name: 'src', type: 'dir' },
      { path: 'a.ts', name: 'a.ts', type: 'file' },
    ]
    const result = toFileCandidates(nodes)
    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ id: 'src', name: 'src/', kind: '目录', path: 'src', type: 'dir' })
    expect(result[1]).toMatchObject({ id: 'a.ts', name: 'a.ts', kind: '文件', path: 'a.ts', type: 'file' })
  })

  it('TC-9b: 空数组 → 空数组；嵌套路径 name 取 basename', () => {
    expect(toFileCandidates([])).toEqual([])
    const nodes: FileNode[] = [{ path: 'src/auth/token.ts', name: 'token.ts', type: 'file' }]
    expect(toFileCandidates(nodes)[0]).toMatchObject({ id: 'src/auth/token.ts', name: 'token.ts', kind: '文件' })
  })
})

describe('filterAndSortFileCandidates', () => {
  it('TC-9c M1: 匹配度分级（完全相等 > 前缀 > basename 子串 > path 子串）', () => {
    const candidates = [
      mk('docs/auth-guide.md', 'file'),
      mk('src/utils/auth-helpers.ts', 'file'),
      mk('auth.ts', 'file'),
      mk('auth', 'file'),
    ]
    const sorted = filterAndSortFileCandidates(candidates, 'auth')
    expect(names(sorted)[0]).toBe('auth')
    expect(names(sorted)[1]).toBe('auth.ts')
  })

  it('TC-9d M2: 同匹配级内文件优先于目录', () => {
    const candidates = [
      mk('src/auth-helpers', 'dir'),
      mk('auth-helpers.ts', 'file'),
    ]
    const sorted = filterAndSortFileCandidates(candidates, 'auth')
    expect(names(sorted)[0]).toBe('auth-helpers.ts')
    expect(names(sorted)[1]).toBe('auth-helpers')
  })

  it('TC-9e M3: 同匹配级 + 同 type 内，路径浅优先', () => {
    const candidates = [
      mk('a/b/c/deep.ts', 'file'),
      mk('shallow.ts', 'file'),
    ]
    const sorted = filterAndSortFileCandidates(candidates, 'ts')
    expect(names(sorted)[0]).toBe('shallow.ts')
  })

  it('TC-9f M4: 同匹配级 + 同 type + 同深度，basename 字母序升序', () => {
    const candidates = [mk('zebra.ts', 'file'), mk('apple.ts', 'file'), mk('mango.ts', 'file')]
    expect(names(filterAndSortFileCandidates(candidates, 'ts'))).toEqual(['apple.ts', 'mango.ts', 'zebra.ts'])
  })

  it('TC-9g M5: 无 query 全量返回（文件优先 + 浅优先 + 字母序）', () => {
    const candidates = [mk('src/auth', 'dir'), mk('zebra.ts', 'file'), mk('apple.ts', 'file')]
    expect(names(filterAndSortFileCandidates(candidates, ''))).toEqual(['apple.ts', 'zebra.ts', 'auth'])
  })

  it('TC-9h M6: 不匹配的候选被过滤掉', () => {
    const candidates = [mk('auth.ts', 'file'), mk('completely-unrelated.ts', 'file')]
    const sorted = filterAndSortFileCandidates(candidates, 'auth')
    expect(sorted).toHaveLength(1)
    expect(names(sorted)[0]).toBe('auth.ts')
  })

  it('TC-9i M7: 大小写不敏感（AGENTS 匹配 agents）', () => {
    expect(names(filterAndSortFileCandidates([mk('AGENTS.md', 'file')], 'agents'))).toEqual(['AGENTS.md'])
  })

  it('TC-9j M8 回归: #agents 时 AGENTS.md 排在 subagents 目录前', () => {
    const candidates = [
      mk('extensions/subagents', 'dir'),
      mk('.agents', 'dir'),
      mk('AGENTS.md', 'file'),
    ]
    const sorted = filterAndSortFileCandidates(candidates, 'agents')
    expect(names(sorted)[0]).toBe('AGENTS.md')
    expect(names(sorted).slice(1)).toEqual(['.agents', 'subagents'])
  })

  it('TC-9k: 纯函数不改原数组', () => {
    const candidates = [mk('auth.ts', 'file'), mk('b.ts', 'file')]
    const before = candidates.slice()
    filterAndSortFileCandidates(candidates, 'auth')
    expect(candidates).toEqual(before)
  })
})
