/**
 * cross-branch-overlap.mjs 单测：交集计算 + 空集/兄弟线缺席边界 + 未合并过滤。
 *
 * 聚合逻辑走 fake git 注入（gitStatus 可编程 0/1）；末组端到端在临时 git 仓库
 * （os.tmpdir 下 mkdtemp 自建自删）跑真实脚本进程验证 dev-* 枚举与真实交集。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { computeOverlap, runOverlap, renderLines } from '../cross-branch-overlap.mjs'

const SCRIPT = fileURLToPath(new URL('../cross-branch-overlap.mjs', import.meta.url))

describe('computeOverlap：交集计算（纯函数）', () => {
  it('交集按排序输出', () => {
    expect(computeOverlap(['b.ts', 'a.ts', 'c.ts'], new Set(['a.ts', 'b.ts', 'd.ts']))).toEqual([
      'a.ts',
      'b.ts',
    ])
  })
  it('空集边界：任一侧为空 → 空交集', () => {
    expect(computeOverlap([], new Set(['a.ts']))).toEqual([])
    expect(computeOverlap(['a.ts'], new Set())).toEqual([])
  })
})

function fakeDeps(routes, ancestorStatuses = {}) {
  return {
    git: (args) => {
      const key = args.join(' ')
      for (const [prefix, out] of Object.entries(routes)) {
        if (key.startsWith(prefix)) return out
      }
      throw new Error(`fake git: no route for ${key}`)
    },
    gitStatus: (args) => {
      const key = args.join(' ')
      for (const [prefix, st] of Object.entries(ancestorStatuses)) {
        if (key.startsWith(prefix)) return st
      }
      return 1
    },
  }
}

describe('runOverlap：聚合逻辑（fake git）', () => {
  const baseRoutes = {
    'rev-parse --verify main': 'ok\n',
    'diff main...HEAD --name-only': 'shared.ts\nmine.ts\n',
    'branch --list dev-* --format=%(refname:short)': 'dev-0.10.6\ndev-0.10.7\n',
    'branch --show-current': 'dev-0.10.5\n',
    'diff main...dev-0.10.6 --name-only': 'shared.ts\ntheirs.ts\n',
    'diff main...dev-0.10.7 --name-only': 'other.ts\n',
  }

  it('未合并兄弟线的修改文件交集呈报（overlap / clean 分档）', () => {
    const deps = fakeDeps(baseRoutes, {
      'merge-base --is-ancestor dev-0.10.6': 1,
      'merge-base --is-ancestor dev-0.10.7': 1,
    })
    const result = runOverlap(deps, { branch: 'HEAD' })
    expect(result.base).toBe('main')
    expect(result.rows).toEqual([
      { sibling: 'dev-0.10.6', status: 'overlap', files: ['shared.ts'] },
      { sibling: 'dev-0.10.7', status: 'clean', files: [] },
    ])
  })
  it('已合并兄弟线排除（merge-base --is-ancestor = 0，无裁决意义）', () => {
    const deps = fakeDeps(baseRoutes, {
      'merge-base --is-ancestor dev-0.10.6': 0,
      'merge-base --is-ancestor dev-0.10.7': 1,
    })
    const { rows } = runOverlap(deps, { branch: 'HEAD' })
    expect(rows[0]).toEqual({ sibling: 'dev-0.10.6', status: 'merged', files: [] })
  })
  it('当前分支自身从兄弟线枚举排除（dev-merge 场景：当前线是 dev-*）', () => {
    const routes = {
      ...baseRoutes,
      'branch --list dev-* --format=%(refname:short)': 'dev-0.10.5\ndev-0.10.6\n',
    }
    const deps = fakeDeps(routes, { 'merge-base --is-ancestor dev-0.10.6': 1 })
    const { rows } = runOverlap(deps, { branch: 'HEAD' })
    expect(rows.map((r) => r.sibling)).toEqual(['dev-0.10.6'])
  })
  it('无 dev-* 兄弟线 → rows 空且文案输出「无兄弟线」', () => {
    const deps = fakeDeps({
      ...baseRoutes,
      'branch --list dev-* --format=%(refname:short)': '',
    })
    const result = runOverlap(deps, { branch: 'HEAD' })
    expect(result.rows).toEqual([])
    expect(renderLines(result).join('\n')).toContain('无 dev-* 兄弟线')
  })
  it('main 与 github/main 均缺 → 用法错误（exit 2 语义，含 --base 指引）', () => {
    const deps = fakeDeps({})
    expect(() => runOverlap(deps, { branch: 'HEAD' })).toThrow('--base')
  })
  it('--base 显式覆盖默认解析', () => {
    const deps = fakeDeps({
      'diff dev-0.10.4...HEAD --name-only': 'x.ts\n',
      'branch --list dev-* --format=%(refname:short)': '',
    })
    expect(runOverlap(deps, { base: 'dev-0.10.4', branch: 'HEAD' }).base).toBe('dev-0.10.4')
  })
})

describe('端到端（临时 git 仓库跑真实脚本进程）', () => {
  const dirs = []
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    dirs.length = 0
  })

  function commitFile(git, dir, rel, content, msg) {
    const abs = join(dir, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, content)
    git(['add', '-A'])
    git(['commit', '-qm', msg])
  }
  function makeGit(dir) {
    return (args) => {
      const r = spawnSync('git', args, { cwd: dir, encoding: 'utf-8' })
      if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
      return r.stdout
    }
  }

  it('dev-merge 场景：当前线 dev-0.10.5 与兄弟线 dev-0.10.6 的交集 = 双方都改的文件', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cross-overlap-test-'))
    dirs.push(dir)
    const git = makeGit(dir)
    git(['init', '-q', '-b', 'main'])
    git(['config', 'user.email', 't@t.local'])
    git(['config', 'user.name', 't'])
    commitFile(git, dir, 'base.txt', 'base\n', 'init')
    // 当前线 dev-0.10.5：改 shared.txt 与 mine.txt
    git(['checkout', '-qb', 'dev-0.10.5'])
    commitFile(git, dir, 'shared.txt', 'from 5\n', 'line5 shared')
    commitFile(git, dir, 'mine.txt', 'mine\n', 'line5 mine')
    // 兄弟线 dev-0.10.6（自 main 分出）：改 shared.txt 与 theirs.txt
    git(['checkout', '-qb', 'dev-0.10.6', 'main'])
    commitFile(git, dir, 'shared.txt', 'from 6\n', 'line6 shared')
    commitFile(git, dir, 'theirs.txt', 'theirs\n', 'line6 theirs')
    git(['checkout', '-q', 'dev-0.10.5'])

    const r = spawnSync('node', [SCRIPT, '--json'], { cwd: dir, encoding: 'utf-8' })
    expect(r.status).toBe(0) // 呈报不阻塞
    const parsed = JSON.parse(r.stdout.trim())
    expect(parsed.base).toBe('main')
    // 当前分支 dev-0.10.5 自身排除；dev-0.10.6 未合入 → 交集恰为 shared.txt
    expect(parsed.rows).toEqual([
      { sibling: 'dev-0.10.6', status: 'overlap', files: ['shared.txt'] },
    ])
    // 人可读输出含吸收/暂缓裁决指引
    const human = spawnSync('node', [SCRIPT], { cwd: dir, encoding: 'utf-8' })
    expect(human.stdout).toContain('shared.txt')
  })

  it('已合入的兄弟线被排除（merged 状态）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cross-overlap-test-'))
    dirs.push(dir)
    const git = makeGit(dir)
    git(['init', '-q', '-b', 'main'])
    git(['config', 'user.email', 't@t.local'])
    git(['config', 'user.name', 't'])
    commitFile(git, dir, 'base.txt', 'base\n', 'init')
    git(['checkout', '-qb', 'dev-0.10.5'])
    commitFile(git, dir, 'mine.txt', 'mine\n', 'line5')
    git(['checkout', '-qb', 'dev-0.10.6'])
    commitFile(git, dir, 'theirs.txt', 'theirs\n', 'line6')
    git(['checkout', '-q', 'dev-0.10.5'])
    git(['merge', '-q', '--no-ff', '-m', 'merge dev-0.10.6', 'dev-0.10.6'])

    const r = spawnSync('node', [SCRIPT, '--json'], { cwd: dir, encoding: 'utf-8' })
    const parsed = JSON.parse(r.stdout.trim())
    expect(parsed.rows).toEqual([
      { sibling: 'dev-0.10.6', status: 'merged', files: [] },
    ])
  })
})
