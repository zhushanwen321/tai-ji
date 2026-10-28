/**
 * changeset-check.mjs 单测：与原 check_changeset() 行为对拍 + 发布/非发布判定边界。
 *
 * 期望文案 = scripts/pr-pre-merge.sh 原 check_changeset() 的 log 文案快照（决策 7：
 * 改调后 Gate-1a.5 消费其输出行为不变——文案漂移即红）。端到端组在临时 git 仓库
 * （os.tmpdir 下 mkdtemp 自建自删）跑真实脚本进程。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  resolveBase,
  extractChangedPkgs,
  extractDeclaredPkgs,
  computeMissing,
  renderLines,
  runCheck,
} from '../changeset-check.mjs'

const SCRIPT = fileURLToPath(new URL('../changeset-check.mjs', import.meta.url))

function fakeGit(routes) {
  return (args) => {
    const key = args.join(' ')
    for (const [prefix, out] of Object.entries(routes)) {
      if (key.startsWith(prefix)) return out
    }
    throw new Error(`fake git: no route for ${key}`)
  }
}

describe('extractChangedPkgs：registry 目录匹配 + src 过滤 + 去重 + 最长前缀', () => {
  // pkgEntries 形态 = runCheck 从 loadPackageRegistry 推导的可版本化包（dir 仓库相对）
  const entries = [
    { name: '@zhushanwen/pi-todo', dir: 'extensions/universal/todo' },
    { name: '@zhushanwen/pi-system-prompt', dir: 'extensions/taiji/system-prompt' },
    { name: '@zhushanwen/pi-file-lock', dir: 'extensions/shared/file-lock' },
    { name: '@zhushanwen/session-delivery', dir: 'packages/session-delivery' },
  ]

  it('分组布局（taiji/universal/shared）与 packages/ 都识别——packages/ 是 v0.11.16 漏声明直穿的形态', () => {
    const files = [
      'extensions/universal/todo/src/index.ts',
      'extensions/taiji/system-prompt/src/foo.ts',
      'extensions/shared/file-lock/src/lock.ts',
      'packages/session-delivery/src/a.ts',
    ]
    expect(extractChangedPkgs(files, entries)).toEqual([
      '@zhushanwen/pi-todo',
      '@zhushanwen/pi-system-prompt',
      '@zhushanwen/pi-file-lock',
      '@zhushanwen/session-delivery',
    ])
  })
  it('非 src 改动（README/docs/examples/workflows）不算发布改动', () => {
    const files = [
      'extensions/universal/todo/README.md',
      'extensions/universal/todo/docs/guide.md',
      'extensions/universal/todo/examples/demo.ts',
      'extensions/universal/todo/workflows/wf.js',
      'packages/session-delivery/package.json',
    ]
    expect(extractChangedPkgs(files, entries)).toEqual([])
  })
  it('不在 registry 清单内的目录（含已删除的包 / workspace 外目录）不触发', () => {
    const files = ['extensions/universal/removed-pkg/src/x.ts', 'extensions/universal/todo/src/y.ts']
    expect(extractChangedPkgs(files, entries)).toEqual(['@zhushanwen/pi-todo'])
  })
  it('同包多文件去重；嵌套目录取最长前缀', () => {
    const nested = [
      ...entries,
      { name: '@zhushanwen/nested', dir: 'packages/session-delivery/sub' },
    ]
    expect(
      extractChangedPkgs(['packages/session-delivery/src/a.ts', 'packages/session-delivery/src/b.ts'], nested),
    ).toEqual(['@zhushanwen/session-delivery'])
    expect(extractChangedPkgs(['packages/session-delivery/sub/src/c.ts'], nested)).toEqual(['@zhushanwen/nested'])
  })
})

describe('changeset 声明解析与 missing 判定', () => {
  it('单双引号 frontmatter 两种格式都识别、去重排序（对拍 grep -oE | sort -u）', () => {
    const texts = [
      "---\n'@zhushanwen/pi-todo': minor\n---\n\nfeat: x\n",
      '---\n"@zhushanwen/pi-system-prompt": patch\n---\n\nfix: y\n',
    ]
    expect(extractDeclaredPkgs(texts)).toEqual(['@zhushanwen/pi-system-prompt', '@zhushanwen/pi-todo'])
  })
  it('missing 判定 = 子串语义（grep -qF 对拍：declared 条目包含 pkg 即视为已声明）', () => {
    // 已知口径（对拍保留）：pi-foo 是 pi-foobar 的前缀 → 误判「已声明」（误放方向）
    expect(computeMissing(['@zhushanwen/pi-foo'], ['@zhushanwen/pi-foobar'])).toEqual([])
    expect(computeMissing(['@zhushanwen/pi-todo'], ['@zhushanwen/pi-other'])).toEqual(['@zhushanwen/pi-todo'])
  })
})

describe('renderLines：文案与原 check_changeset 逐字对拍（缺 [pr-pre-merge] 前缀）', () => {
  it('skip：找不到 main 分支', () => {
    expect(renderLines({ status: 'skip', changed: [], missing: [] })).toEqual([
      '↷ skip（找不到 main 分支，无法对比）',
    ])
  })
  it('pass（无发布包改动）', () => {
    expect(renderLines({ status: 'pass', changed: [], missing: [] })).toEqual([
      '✓ 无发布包 src/ 改动，跳过 changeset 检查',
    ])
  })
  it('pass（全部有 changeset）', () => {
    expect(renderLines({ status: 'pass', changed: ['@a/b', '@c/d'], missing: [] })).toEqual([
      '✓ 所有改动的发布包都有 changeset（2 个包）',
    ])
  })
  it('warn：缺 changeset 清单 + 发布/忽略指引（Gate-1a.5 消费形态）', () => {
    expect(renderLines({ status: 'warn', changed: ['@a/b'], missing: ['@a/b'] })).toEqual([
      '⚠ 1 个发布包改了 src/ 但无 changeset：',
      '  - @a/b',
      '如需发布，运行: pnpm changeset',
      '如是纯文档/测试/重构改动无需发布，可忽略此警告',
    ])
  })
})

describe('端到端（临时 git 仓库跑真实脚本进程）', () => {
  const dirs = []
  // 方向②（scanUnversionable）与方向①（registry 目录匹配）都经 @manypkg 扫包全景：
  // fixture 需 workspace 定义，glob 集合镜像真实仓库（packages/apps/extensions 三分组）
  function writeWorkspaceDefs(dir) {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture-root', private: true }))
    writeFileSync(
      join(dir, 'pnpm-workspace.yaml'),
      'packages:\n  - packages/*\n  - apps/*\n  - extensions/taiji/*\n  - extensions/universal/*\n  - extensions/shared/*\n',
    )
  }
  function makeRepo() {
    const dir = mkdtempSync(join(tmpdir(), 'changeset-check-test-'))
    dirs.push(dir)
    const git = (args) => {
      const r = spawnSync('git', args, { cwd: dir, encoding: 'utf-8' })
      if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
      return r.stdout
    }
    git(['init', '-q', '-b', 'main'])
    git(['config', 'user.email', 't@t.local'])
    git(['config', 'user.name', 't'])
    writeWorkspaceDefs(dir)
    return { dir, git }
  }
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    dirs.length = 0
  })

  it('无 main 分支 → skip（no main）', () => {
    // 只有 feature 分支（init -b feat），main 不存在——本形态需要独立建仓，
    // 不走 makeRepo（其 init -b main 恰是本用例要排除的形态）
    const dir2 = mkdtempSync(join(tmpdir(), 'changeset-check-test-'))
    dirs.push(dir2)
    const git2 = (args) => {
      const r = spawnSync('git', args, { cwd: dir2, encoding: 'utf-8' })
      if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
      return r.stdout
    }
    git2(['init', '-q', '-b', 'feat'])
    git2(['config', 'user.email', 't@t.local'])
    git2(['config', 'user.name', 't'])
    writeFileSync(join(dir2, 'x.txt'), 'x')
    writeFileSync(join(dir2, 'package.json'), JSON.stringify({ name: 'fixture-root', private: true }))
    writeFileSync(join(dir2, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n')
    git2(['add', '-A'])
    git2(['commit', '-qm', 'init'])
    const deps = { root: dir2, git: git2 }
    expect(runCheck(deps).status).toBe('skip')
  })

  it('发布改动无 changeset → warn + missing 清单（发布判定边界）', () => {
    const { dir, git } = makeRepo()
    const pkgDir = join(dir, 'extensions/universal/todo')
    mkdirSync(join(pkgDir, 'src'), { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@zhushanwen/pi-todo' }))
    writeFileSync(join(pkgDir, 'src', 'index.ts'), 'export const a = 1\n')
    git(['add', '-A'])
    git(['commit', '-qm', 'init'])
    git(['checkout', '-qb', 'feat'])
    writeFileSync(join(pkgDir, 'src', 'index.ts'), 'export const a = 2\n')
    git(['add', '-A'])
    git(['commit', '-qm', 'feat'])
    const result = runCheck({ root: dir, git })
    expect(result.status).toBe('warn')
    expect(result.missing).toEqual(['@zhushanwen/pi-todo'])
    expect(renderLines(result)[0]).toBe('⚠ 1 个发布包改了 src/ 但无 changeset：')
  })

  it('packages/ 包改 src 无 changeset → warn（v0.11.16 六包漏声明直穿的回归形态——旧 extensions/ 正则结构性扫不到）', () => {
    const { dir, git } = makeRepo()
    const pkgDir = join(dir, 'packages/session-delivery')
    mkdirSync(join(pkgDir, 'src'), { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@zhushanwen/session-delivery' }))
    writeFileSync(join(pkgDir, 'src', 'topic.ts'), 'export const a = 1\n')
    git(['add', '-A'])
    git(['commit', '-qm', 'init'])
    git(['checkout', '-qb', 'feat'])
    writeFileSync(join(pkgDir, 'src', 'topic.ts'), 'export const a = 2\n')
    git(['add', '-A'])
    git(['commit', '-qm', 'feat'])
    const result = runCheck({ root: dir, git })
    expect(result.status).toBe('warn')
    expect(result.missing).toEqual(['@zhushanwen/session-delivery'])
  })

  it('private 包改 src 不触发 WARN（不发 npm、无 changeset 语义——与 pkgOf 口径对齐）', () => {
    const { dir, git } = makeRepo()
    const pkgDir = join(dir, 'packages/internal-tool')
    mkdirSync(join(pkgDir, 'src'), { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@zhushanwen/internal-tool', private: true }))
    writeFileSync(join(pkgDir, 'src', 'a.ts'), 'export const a = 1\n')
    git(['add', '-A'])
    git(['commit', '-qm', 'init'])
    git(['checkout', '-qb', 'feat'])
    writeFileSync(join(pkgDir, 'src', 'a.ts'), 'export const a = 2\n')
    git(['add', '-A'])
    git(['commit', '-qm', 'feat'])
    const result = runCheck({ root: dir, git })
    expect(result.status).toBe('pass')
    expect(result.changed).toEqual([])
  })

  it('带齐 changeset → pass（发布判定边界另一侧）', () => {
    const { dir, git } = makeRepo()
    const pkgDir = join(dir, 'extensions/universal/todo')
    mkdirSync(join(pkgDir, 'src'), { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@zhushanwen/pi-todo' }))
    writeFileSync(join(pkgDir, 'src', 'index.ts'), 'export const a = 1\n')
    mkdirSync(join(dir, '.changeset'), { recursive: true })
    writeFileSync(join(dir, '.changeset', 'cool-dogs.md'), "---\n'@zhushanwen/pi-todo': minor\n---\n\nfeat: x\n")
    git(['add', '-A'])
    git(['commit', '-qm', 'init'])
    git(['checkout', '-qb', 'feat'])
    writeFileSync(join(pkgDir, 'src', 'index.ts'), 'export const a = 2\n')
    git(['add', '-A'])
    git(['commit', '-qm', 'feat'])
    const result = runCheck({ root: dir, git })
    expect(result.status).toBe('pass')
    expect(result.changed).toEqual(['@zhushanwen/pi-todo'])
  })

  it('只改注释类内容（非 src）→ pass，非发布改动不产生 WARN（对照组边界）', () => {
    const { dir, git } = makeRepo()
    const pkgDir = join(dir, 'extensions/universal/todo')
    mkdirSync(join(pkgDir, 'src'), { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@zhushanwen/pi-todo' }))
    writeFileSync(join(pkgDir, 'README.md'), 'readme\n')
    git(['add', '-A'])
    git(['commit', '-qm', 'init'])
    git(['checkout', '-qb', 'feat'])
    writeFileSync(join(pkgDir, 'README.md'), 'readme updated\n')
    git(['add', '-A'])
    git(['commit', '-qm', 'docs only'])
    const result = runCheck({ root: dir, git })
    expect(result.status).toBe('pass')
    expect(result.changed).toEqual([])
  })

  it('--base 显式基点：分支增量只含本 PR 改动，不混入 base 分支自身的 dev 线内容（发现 1 回归）', () => {
    const { dir, git } = makeRepo()
    const mk = (name) => {
      const pkgDir = join(dir, 'extensions/universal', name)
      mkdirSync(join(pkgDir, 'src'), { recursive: true })
      writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: `@zhushanwen/pi-${name}` }))
      writeFileSync(join(pkgDir, 'src', 'index.ts'), 'export const a = 1\n')
    }
    mk('todo')
    mk('bar')
    git(['add', '-A'])
    git(['commit', '-qm', 'init'])
    git(['checkout', '-qb', 'dev-0.11.16'])
    writeFileSync(join(dir, 'extensions/universal/bar/src/index.ts'), 'export const a = 2\n')
    git(['add', '-A'])
    git(['commit', '-qm', 'dev line change'])
    git(['checkout', '-qb', 'feat'])
    writeFileSync(join(dir, 'extensions/universal/todo/src/index.ts'), 'export const a = 3\n')
    git(['add', '-A'])
    git(['commit', '-qm', 'feat change'])
    // 缺省（main）：分支增量混入 dev 线的 bar——周期后段每个 PR 都为整条 dev 线举证
    const byMain = runCheck({ root: dir, git })
    expect(byMain.base).toBe('main')
    expect(byMain.changed.sort()).toEqual(['@zhushanwen/pi-bar', '@zhushanwen/pi-todo'])
    // 显式 --base dev-0.11.16：只判本分支的 todo
    const byDev = runCheck({ root: dir, git, base: 'dev-0.11.16' })
    expect(byDev.base).toBe('dev-0.11.16')
    expect(byDev.changed).toEqual(['@zhushanwen/pi-todo'])
  })

  it('--json 单行输出含 status/changed/missing/lines（pr-pre-merge.sh 消费契约）', () => {
    const { dir, git } = makeRepo()
    writeFileSync(join(dir, 'x.txt'), 'x')
    git(['add', '-A'])
    git(['commit', '-qm', 'init'])
    git(['checkout', '-qb', 'feat'])
    const r = spawnSync('node', [SCRIPT, '--json'], { cwd: dir, encoding: 'utf-8' })
    expect(r.status).toBe(0) // WARN/skip 不阻断
    const parsed = JSON.parse(r.stdout.trim())
    expect(parsed).toHaveProperty('status')
    expect(parsed).toHaveProperty('changed')
    expect(parsed).toHaveProperty('missing')
    expect(parsed.lines).toEqual(renderLines(parsed))
  })
})

describe('resolveBase：显式 --base 优先；缺省 main 优先、github/main 兜底、全无 → null', () => {
  it('显式 base 直接采用（不试探 main）；解析失败抛 exitCode 2 错误（不静默 skip 成「无检查即绿」）', () => {
    expect(resolveBase(fakeGit({ 'rev-parse --verify dev-0.11.16': 'ok\n' }), 'dev-0.11.16')).toBe('dev-0.11.16')
    const throwsForGone = (args) => {
      if (args.join(' ').includes('dev-gone')) throw new Error('unknown revision')
      return 'ok\n'
    }
    let caught = null
    try { resolveBase(throwsForGone, 'dev-gone') } catch (e) { caught = e }
    expect(caught).not.toBeNull()
    expect(caught.exitCode).toBe(2)
    expect(String(caught.message)).toContain('dev-gone')
  })
  it('解析顺序与原实现对拍（main → github/main）', () => {
    expect(resolveBase(fakeGit({ 'rev-parse --verify main': 'ok\n' }))).toBe('main')
    const gitNoMain = (args) => {
      if (args.join(' ').includes('main') && !args.join(' ').includes('github/main')) throw new Error('no')
      return 'ok\n'
    }
    expect(resolveBase(gitNoMain)).toBe('github/main')
    expect(resolveBase(fakeGit({}))).toBeNull()
  })
})
