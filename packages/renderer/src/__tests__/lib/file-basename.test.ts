/**
 * file-basename.ts 单测 —— basename 反查 + 扁平化工具。
 *
 * 覆盖：
 * - findByBasename：0/1/N 匹配场景（含目录同名不应匹配）
 * - collectBasenames：扁平 + 嵌套 children + 只收 file 类型
 * - collectFilePaths：path 收集（与 basenames 对称，供 env.filePaths 白名单）
 *
 * 运行：pnpm --filter @taiji/frontend run test -- src/__tests__/lib/file-basename.test.ts
 */
import { describe, it, expect } from 'vitest'
import type { FileNode } from '@taiji/shared'
import { findByBasename, collectBasenames, collectFilePaths } from '@/lib/file-basename'

/** 构造 file 节点的辅助函数（减少样板） */
function file(path: string, name = path.split('/').pop()!): FileNode {
  return { path, name, type: 'file' }
}

/** 构造 dir 节点（含可选 children） */
function dir(path: string, children: FileNode[] = [], name = path.split('/').pop()!): FileNode {
  return { path, name, type: 'dir', children }
}

describe('findByBasename', () => {
  it('唯一匹配 → 返回单元素数组', () => {
    const nodes = [file('src/index.ts'), file('README.md'), file('package.json')]
    const matches = findByBasename(nodes, 'README.md')
    expect(matches).toHaveLength(1)
    expect(matches[0].path).toBe('README.md')
  })

  it('多匹配 → 返回所有同名文件（歧义场景）', () => {
    const nodes = [
      file('src/a.ts'),
      file('lib/a.ts'),
      file('test/a.ts'),
      file('README.md'),
    ]
    const matches = findByBasename(nodes, 'a.ts')
    expect(matches).toHaveLength(3)
    expect(matches.map((m) => m.path).sort()).toEqual(['lib/a.ts', 'src/a.ts', 'test/a.ts'])
  })

  it('0 匹配 → 返回空数组（文件不存在/缓存过期）', () => {
    const nodes = [file('src/index.ts'), file('README.md')]
    expect(findByBasename(nodes, 'nonexistent.ts')).toEqual([])
  })

  it('目录同名不应匹配（type===dir 过滤）', () => {
    const nodes = [
      file('src/foo.ts'),
      dir('src/foo.ts', [], 'foo.ts'), // 故意构造同名 dir（罕见但防御性测试）
    ]
    const matches = findByBasename(nodes, 'foo.ts')
    expect(matches).toHaveLength(1)
    expect(matches[0].type).toBe('file')
  })

  it('空节点列表 → 返回空数组', () => {
    expect(findByBasename([], 'any.md')).toEqual([])
  })
})

describe('collectBasenames', () => {
  it('扁平列表 → 收集所有 file 的 name', () => {
    const nodes = [
      file('src/index.ts'),
      file('README.md'),
      file('package.json'),
    ]
    const names = collectBasenames(nodes)
    expect(names.size).toBe(3)
    expect(names.has('index.ts')).toBe(true)
    expect(names.has('README.md')).toBe(true)
    expect(names.has('package.json')).toBe(true)
  })

  it('嵌套 children → 递归收集（防未来数据结构变化）', () => {
    const nodes = [
      dir('src', [
        file('src/index.ts'),
        dir('src/utils', [file('src/utils/helper.ts')]),
      ]),
      file('README.md'),
    ]
    const names = collectBasenames(nodes)
    expect(names.has('index.ts')).toBe(true)
    expect(names.has('helper.ts')).toBe(true)
    expect(names.has('README.md')).toBe(true)
  })

  it('目录 name 不进集合（只收 file）', () => {
    const nodes = [
      dir('src', [file('src/index.ts')], 'src'),
      dir('docs', [], 'docs'),
    ]
    const names = collectBasenames(nodes)
    expect(names.has('index.ts')).toBe(true)
    expect(names.has('src')).toBe(false) // 目录名不收
    expect(names.has('docs')).toBe(false)
  })

  it('重复 basename 去重（Set 语义）', () => {
    // 项目里可能有多个 index.ts（src/index.ts + lib/index.ts）
    const nodes = [file('src/index.ts'), file('lib/index.ts')]
    const names = collectBasenames(nodes)
    expect(names.size).toBe(1) // 去重
    expect(names.has('index.ts')).toBe(true)
  })

  it('空列表 → 空 Set', () => {
    expect(collectBasenames([]).size).toBe(0)
  })
})

describe('collectFilePaths', () => {
  it('扁平列表 → 收集全部 file path', () => {
    const nodes = [file('src/index.ts'), file('README.md')]
    const paths = collectFilePaths(nodes)
    expect(paths.has('src/index.ts')).toBe(true)
    expect(paths.has('README.md')).toBe(true)
  })

  it('嵌套 children → 递归收集 path', () => {
    const nodes = [
      dir('src', [file('src/index.ts'), dir('src/utils', [file('src/utils/helper.ts')])]),
      file('README.md'),
    ]
    const paths = collectFilePaths(nodes)
    expect(paths.has('src/index.ts')).toBe(true)
    expect(paths.has('src/utils/helper.ts')).toBe(true)
    expect(paths.has('README.md')).toBe(true)
  })

  it('目录 path 不进集合（只收 file）', () => {
    const nodes = [dir('src', [file('src/index.ts')], 'src'), dir('docs', [], 'docs')]
    const paths = collectFilePaths(nodes)
    expect(paths.has('src/index.ts')).toBe(true)
    expect(paths.has('src')).toBe(false)
    expect(paths.has('docs')).toBe(false)
  })

  it('空列表 → 空 Set', () => {
    expect(collectFilePaths([]).size).toBe(0)
  })
})
