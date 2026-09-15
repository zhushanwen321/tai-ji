/**
 * git-status-parser.test.ts — parseGitStatus / deriveCounts / parseNumstatEntries 纯函数
 *
 * 覆盖：正常解析、空输入、detached HEAD、重命名、冲突、T 类型变更、
 *       staged/unstaged 计数、二进制文件、含 tab 路径。
 */
import { describe, it, expect } from 'vitest'
import { parseGitStatus, deriveCounts, parseNumstatEntries, xyToGitStatus } from '../src/infra/git/git-status-parser.js'
import type { GitFileStatus } from '@xyz-agent/shared'

describe('xyToGitStatus', () => {
  it('?? → untracked', () => {
    expect(xyToGitStatus('??')).toBe('untracked')
  })

  it('A  → added', () => {
    expect(xyToGitStatus('A ')).toBe('added')
  })

  it('D  → deleted', () => {
    expect(xyToGitStatus('D ')).toBe('deleted')
    expect(xyToGitStatus(' D')).toBe('deleted')
  })

  it('R  → renamed', () => {
    expect(xyToGitStatus('R ')).toBe('renamed')
  })

  it('C  → renamed', () => {
    expect(xyToGitStatus('C ')).toBe('renamed')
  })

  it('M  → modified', () => {
    expect(xyToGitStatus('M ')).toBe('modified')
    expect(xyToGitStatus(' M')).toBe('modified')
    expect(xyToGitStatus('MM')).toBe('modified')
  })

  it('T  → modified (type change)', () => {
    expect(xyToGitStatus('T ')).toBe('modified')
    expect(xyToGitStatus(' T')).toBe('modified')
  })

  it('U  → unmerged (conflict)', () => {
    expect(xyToGitStatus('U ')).toBe('unmerged')
    expect(xyToGitStatus(' U')).toBe('unmerged')
    expect(xyToGitStatus('UU')).toBe('unmerged')
  })

  it('DD / AA / DU / UD → unmerged（both deleted/added + 单侧删除）', () => {
    expect(xyToGitStatus('DD')).toBe('unmerged')
    expect(xyToGitStatus('AA')).toBe('unmerged')
    expect(xyToGitStatus('DU')).toBe('unmerged')
    expect(xyToGitStatus('UD')).toBe('unmerged')
  })
})

describe('parseGitStatus', () => {
  it('空输入返回空结果', () => {
    expect(parseGitStatus('')).toEqual({ files: [] })
  })

  it('解析 branch 头 + 单个文件', () => {
    // `## main` + `M  src/foo.ts` NUL 分隔
    const output = '## main\0M  src/foo.ts'
    const result = parseGitStatus(output)
    expect(result.branch).toBe('main')
    expect(result.files).toHaveLength(1)
    expect(result.files[0].path).toBe('src/foo.ts')
    expect(result.files[0].status).toBe('modified')
  })

  it('detached HEAD 返回 branch=undefined', () => {
    const output = '## HEAD (no branch)\0M  src/foo.ts'
    const result = parseGitStatus(output)
    expect(result.branch).toBeUndefined()
  })

  it('No commits yet 返回 branch=undefined', () => {
    const output = '## No commits yet on main\0?? new-file.txt'
    const result = parseGitStatus(output)
    expect(result.branch).toBeUndefined()
  })

  it('解析 upstream tracking', () => {
    const output = '## main...origin/main [ahead 2]\0M  src/foo.ts'
    const result = parseGitStatus(output)
    expect(result.branch).toBe('main')
  })

  it('重命名文件：XY=R，跳过源路径记录', () => {
    // R  old.ts\0new.ts（dst 在第一条，src 在第二条 NUL 记录）
    const output = '## main\0R  new.ts\0old.ts'
    const result = parseGitStatus(output)
    expect(result.files).toHaveLength(1)
    expect(result.files[0].path).toBe('new.ts')
    expect(result.files[0].status).toBe('renamed')
  })

  it('拷贝文件：XY=C，跳过源路径记录', () => {
    const output = '## main\0C  copy.ts\0original.ts'
    const result = parseGitStatus(output)
    expect(result.files).toHaveLength(1)
    expect(result.files[0].path).toBe('copy.ts')
    expect(result.files[0].status).toBe('renamed')
  })

  it('冲突文件：UU → unmerged', () => {
    const output = '## main\0UU src/conflict.ts'
    const result = parseGitStatus(output)
    expect(result.files).toHaveLength(1)
    expect(result.files[0].status).toBe('unmerged')
  })

  it('T 类型变更 → modified', () => {
    const output = '## main\0T  src/link.ts'
    const result = parseGitStatus(output)
    expect(result.files).toHaveLength(1)
    expect(result.files[0].status).toBe('modified')
  })

  it('多个文件混合状态', () => {
    const output = [
      '## main',
      'M  src/modified.ts',
      'A  src/added.ts',
      'D  src/deleted.ts',
      '?? src/untracked.ts',
    ].join('\0')
    const result = parseGitStatus(output)
    expect(result.files).toHaveLength(4)
    expect(result.files[0].status).toBe('modified')
    expect(result.files[1].status).toBe('added')
    expect(result.files[2].status).toBe('deleted')
    expect(result.files[3].status).toBe('untracked')
  })

  it('跳过空记录（连续 NUL）', () => {
    const output = '## main\0\0\0M  src/foo.ts'
    const result = parseGitStatus(output)
    expect(result.files).toHaveLength(1)
  })
})

describe('deriveCounts', () => {
  it('空文件列表返回零计数', () => {
    expect(deriveCounts([])).toEqual({ stagedCount: 0, unstagedCount: 0, hasConflict: false })
  })

  it('staged 文件（X 列有变化）', () => {
    const files = parseGitStatus('## main\0A  src/new.ts\0M  src/mod.ts').files
    const counts = deriveCounts(files)
    expect(counts.stagedCount).toBe(2)
    expect(counts.unstagedCount).toBe(0)
  })

  it('unstaged 文件（Y 列有变化）', () => {
    const files = parseGitStatus('## main\0 M src/mod.ts\0 D src/del.ts').files
    const counts = deriveCounts(files)
    expect(counts.stagedCount).toBe(0)
    expect(counts.unstagedCount).toBe(2)
  })

  it('未跟踪文件（??）计入 unstaged', () => {
    const files = parseGitStatus('## main\0?? src/new.ts').files
    const counts = deriveCounts(files)
    expect(counts.stagedCount).toBe(0)
    expect(counts.unstagedCount).toBe(1)
  })

  it('混合 staged + unstaged', () => {
    const files = parseGitStatus('## main\0MM src/foo.ts').files
    const counts = deriveCounts(files)
    expect(counts.stagedCount).toBe(1)
    expect(counts.unstagedCount).toBe(1)
  })

  it('冲突文件设置 hasConflict', () => {
    const files = parseGitStatus('## main\0UU src/conflict.ts').files
    const counts = deriveCounts(files)
    expect(counts.hasConflict).toBe(true)
  })

  it('无冲突文件 hasConflict=false', () => {
    const files = parseGitStatus('## main\0M  src/foo.ts').files
    const counts = deriveCounts(files)
    expect(counts.hasConflict).toBe(false)
  })
})

describe('parseNumstatEntries', () => {
  it('空输入返回空数组', () => {
    expect(parseNumstatEntries('')).toEqual([])
  })

  it('正常解析单行', () => {
    const entries = parseNumstatEntries('10\t5\tsrc/foo.ts')
    expect(entries).toHaveLength(1)
    expect(entries[0]).toEqual({ add: 10, del: 5, path: 'src/foo.ts' })
  })

  it('二进制文件：add/del 为 undefined', () => {
    const entries = parseNumstatEntries('-\t-\timage.png')
    expect(entries).toHaveLength(1)
    expect(entries[0].add).toBeUndefined()
    expect(entries[0].del).toBeUndefined()
    expect(entries[0].path).toBe('image.png')
  })

  it('多行解析', () => {
    const output = '10\t5\tsrc/foo.ts\n0\t3\tsrc/bar.ts\n-\t-\timg.png'
    const entries = parseNumstatEntries(output)
    expect(entries).toHaveLength(3)
    expect(entries[2].path).toBe('img.png')
  })

  it('路径含 tab：join 还原', () => {
    // numstat 用 tab 分隔前两列，路径从第 3 列起 join('\t')
    const entries = parseNumstatEntries('1\t0\tpath/with\ttab.ts')
    expect(entries).toHaveLength(1)
    expect(entries[0].path).toBe('path/with\ttab.ts')
  })

  it('跳过列数不足的行', () => {
    const entries = parseNumstatEntries('10\t5\ninvalid-line')
    expect(entries).toHaveLength(0)
  })

  it('NaN 计数解析为 undefined', () => {
    const entries = parseNumstatEntries('abc\t5\tsrc/foo.ts')
    expect(entries).toHaveLength(1)
    expect(entries[0].add).toBeUndefined()
    expect(entries[0].del).toBe(5)
  })
})

// ── 原版独有边界（自 git-status-parser.test.ts 并入，2026-09 测试舰队审查去重）──

describe('parseGitStatus / deriveCounts / parseNumstatEntries — 原版独有边界', () => {
  it('path with spaces preserved (NUL safety)', () => {
    const out = '## main\0M \tmy file with spaces.ts'
    const res = parseGitStatus(out)
    expect(res.files[0]?.path).toBe('my file with spaces.ts')
  })

  it('mixed: AM counts staged only（X=A staged，Y=M unstaged——verify single staged 不双计）', () => {
    const files: GitFileStatus[] = [{ path: 'p', xyCode: 'AM', status: 'added' }]
    const c = deriveCounts(files)
    expect(c.stagedCount).toBe(1)
    expect(c.unstagedCount).toBe(1)
  })

  it('numstat 半二进制：单字段为 -（add 有效、del 二进制）→ add 保留、del undefined', () => {
    const entries = parseNumstatEntries('5\t-\tmixed.bin')
    expect(entries).toHaveLength(1)
    expect(entries[0].add).toBe(5)
    expect(entries[0].del).toBeUndefined()
  })
})
