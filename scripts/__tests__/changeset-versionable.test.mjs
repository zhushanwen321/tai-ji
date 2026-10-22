/**
 * changeset-versionable.mjs 单测 + 两个消费脚本端到端（private/ignore 包声明拦截）。
 *
 * 背景：@taiji/* 等 private 包不发 npm，changeset 声明永不生效——纯 private 声明被
 * changeset version 静默跳过（文件永久残留，v0.11.9 发布前人工盘点才发现），
 * 混合声明阻断 version。判定与 changesets shouldSkipPackage 语义对齐（private ∨ ignore）。
 * 端到端组在临时目录（mkdtemp 自建自删）跑真实脚本进程。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  findUnversionable,
  loadPackageRegistry,
  parseChangesetFrontmatter,
} from '../changeset-versionable.mjs'

const HOOK_SCRIPT = fileURLToPath(new URL('../../.githooks/check_changeset_packages.mjs', import.meta.url))
const CHECK_SCRIPT = fileURLToPath(new URL('../changeset-check.mjs', import.meta.url))

// ---------- parseChangesetFrontmatter ----------

describe('parseChangesetFrontmatter：两种引号 + 无 scope 包名 + 边界', () => {
  it('单引号 scope 包名（changeset add 实际产出形态）', () => {
    expect(parseChangesetFrontmatter("---\n'@taiji/shared': minor\n---\n\n正文\n")).toEqual([
      { name: '@taiji/shared', bumpType: 'minor' },
    ])
  })
  it('双引号包名', () => {
    expect(parseChangesetFrontmatter('---\n"@zhushanwen/pi-todo": patch\n---\n')).toEqual([
      { name: '@zhushanwen/pi-todo', bumpType: 'patch' },
    ])
  })
  it('无引号无 scope 包名（create-taiji-plugin 形态，旧 @ 开头正则抓不到）', () => {
    expect(parseChangesetFrontmatter('---\ncreate-taiji-plugin: major\n---\n')).toEqual([
      { name: 'create-taiji-plugin', bumpType: 'major' },
    ])
  })
  it('frontmatter 外正文不解析；非 bump 档位键不解析', () => {
    const text = '---\n"@zhushanwen/pi-todo": minor\n---\n\n`pkg: patch` 出现在正文里不算\n'
    expect(parseChangesetFrontmatter(text)).toEqual([{ name: '@zhushanwen/pi-todo', bumpType: 'minor' }])
  })
  it('缺 frontmatter 或缺结束标记 → 空', () => {
    expect(parseChangesetFrontmatter('无 frontmatter 正文')).toEqual([])
    expect(parseChangesetFrontmatter('---\n"@a/b": patch\n')).toEqual([])
  })
})

// ---------- findUnversionable ----------

describe('findUnversionable：private ∨ ignore 判定（shouldSkipPackage 同语义）', () => {
  const registry = {
    byName: new Map([
      ['@taiji/shared', { private: true, dir: '/x/packages/shared' }],
      ['@zhushanwen/pi-todo', { private: false, dir: '/x/extensions/universal/todo' }],
    ]),
    ignoreSet: new Set(['frozen-pkg']),
  }
  it('private 包命中', () => {
    expect(findUnversionable(['@taiji/shared'], registry)).toEqual(['@taiji/shared'])
  })
  it('ignore 清单命中（含非 private 条目）', () => {
    expect(findUnversionable(['frozen-pkg'], registry)).toEqual(['frozen-pkg'])
  })
  it('发布包与 workspace 外包名放行（typo 归 check-version-changes 承接）', () => {
    expect(findUnversionable(['@zhushanwen/pi-todo', 'no-such-pkg'], registry)).toEqual([])
  })
})

// ---------- 端到端装置 ----------

const tmpDirs = []
function makeTmpRoot() {
  const root = mkdtempSync(join(tmpdir(), 'changeset-ver-'))
  tmpDirs.push(root)
  return root
}
// afterAll（非 afterEach）：git root 由 describe 级 beforeAll 共享（缩数据量——git init 与
// workspace fixture 是 6 用例中唯一的重复建仓成本，git 是被测依赖不可 mock），首个用例
// 后即清会把后续用例的共享 root 删掉
afterAll(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

/** 最小 pnpm workspace：private/ignore/发布包各一 + config.json + git 仓（脚本 createDefaultDeps 需要）。 */
function writeWorkspaceFixture(root, { withConfig = true } = {}) {
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'root', private: true }))
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n')
  for (const [dir, name, priv] of [
    ['packages/shared', '@taiji/shared', true],
    ['packages/frozen', 'frozen-pkg', false],
    ['packages/todo', '@zhushanwen/pi-todo', false],
  ]) {
    mkdirSync(join(root, dir), { recursive: true })
    writeFileSync(join(root, dir, 'package.json'), JSON.stringify({ name, private: priv }))
  }
  mkdirSync(join(root, '.changeset'), { recursive: true })
  if (withConfig) {
    writeFileSync(
      join(root, '.changeset', 'config.json'),
      JSON.stringify({ $schema: 'x', ignore: ['frozen-pkg'] }),
    )
  }
  const init = spawnSync('git', ['init', '-q'], { cwd: root, encoding: 'utf-8' })
  if (init.status !== 0) throw new Error(`git init: ${init.stderr}`)
}

// ---------- check_changeset_packages.mjs（pre-commit 拦截）端到端 ----------

/** 脚本经 `git show :<path>` 读 index 内容：先 add 模拟 pre-commit 时的 staged 状态。 */
function stageFile(root, rel) {
  const r = spawnSync('git', ['add', rel], { cwd: root, encoding: 'utf-8' })
  if (r.status !== 0) throw new Error(`git add ${rel}: ${r.stderr}`)
}

describe('check_changeset_packages.mjs 端到端（--root 指临时仓）', () => {
  // 共享 git root（缩重复 init 成本）：脚本按显式文件参数经 `git show :<path>` 读 index，
  // 用例各写互不相同的 changeset 文件名，残留不进入后续用例的判定范围
  let root
  beforeAll(() => {
    root = makeTmpRoot()
    writeWorkspaceFixture(root)
  })

  it('private 声明 → exit 1，[ERROR]/[FIX] 指向恢复动作', () => {
    const cs = join(root, '.changeset', 'a.md')
    writeFileSync(cs, "---\n'@taiji/shared': minor\n---\n\nbody\n")
    stageFile(root, '.changeset/a.md')
    const r = spawnSync('node', [HOOK_SCRIPT, '--root', root, '.changeset/a.md'], { encoding: 'utf-8' })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain(".changeset/a.md: '@taiji/shared': minor")
    expect(r.stderr).toContain('private（不发 npm）')
    expect(r.stderr).toContain('frontmatter 删除对应行')
  })
  it('ignore 清单声明 → exit 1', () => {
    writeFileSync(join(root, '.changeset', 'b.md'), '---\nfrozen-pkg: patch\n---\n')
    stageFile(root, '.changeset/b.md')
    const r = spawnSync('node', [HOOK_SCRIPT, '--root', root, '.changeset/b.md'], { encoding: 'utf-8' })
    expect(r.status).toBe(1)
  })
  it('发布包声明 → exit 0', () => {
    writeFileSync(join(root, '.changeset', 'c.md'), '---\n"@zhushanwen/pi-todo": patch\n---\n')
    stageFile(root, '.changeset/c.md')
    const r = spawnSync('node', [HOOK_SCRIPT, '--root', root, '.changeset/c.md'], { encoding: 'utf-8' })
    expect(r.status).toBe(0)
  })
  it('无文件参数 → exit 0（不跑判定）', () => {
    const r = spawnSync('node', [HOOK_SCRIPT, '--root', root], { encoding: 'utf-8' })
    expect(r.status).toBe(0)
  })
})

// ---------- changeset-check.mjs 方向②（Gate-1a.5 / dev-merge gates）端到端 ----------

describe('changeset-check.mjs 无效声明方向（fail 无条件于 base）', () => {
  // 独立 root（不与 hook 组共享）：本组脚本是磁盘扫描式（.changeset/*.md 全量），
  // hook 组残留的 a/b/c.md 会进入 unversionable 断言；组内共享 root 缩重复 init 成本
  let root
  beforeAll(() => {
    root = makeTmpRoot()
    writeWorkspaceFixture(root)
  })

  it('磁盘残留 private 声明 → status fail + exit 1（无 git base 也拦）', () => {
    const residue = join(root, '.changeset', 'residue.md')
    writeFileSync(residue, "---\n'@taiji/shared': minor\n---\n")
    const r = spawnSync('node', [CHECK_SCRIPT, '--json'], { cwd: root, encoding: 'utf-8' })
    expect(r.status).toBe(1)
    const j = JSON.parse(r.stdout)
    expect(j.status).toBe('fail')
    expect(j.unversionable).toEqual([
      { file: '.changeset/residue.md', name: '@taiji/shared', bumpType: 'minor' },
    ])
    expect(j.lines[0]).toContain('1 个 changeset 声明了不可版本化的包')
    // 扫描式判定：用例自清残留，防泄漏到同 root 的后续用例
    rmSync(residue)
  })
  it('README.md 不参与判定（非 changeset 文件）', () => {
    writeFileSync(join(root, '.changeset', 'README.md'), "---\n'@taiji/shared': minor\n---\n")
    const r = spawnSync('node', [CHECK_SCRIPT, '--json'], { cwd: root, encoding: 'utf-8' })
    expect(r.status).toBe(0)
    expect(JSON.parse(r.stdout).status).toBe('skip') // 无 git base → 方向① skip
  })
})

// ---------- loadPackageRegistry（真实仓库 smoke） ----------

describe('loadPackageRegistry 对真实仓库', () => {
  it('根包 private + ignore 清单装载（真实仓库自检：判定源可用）', () => {
    const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
    const registry = loadPackageRegistry(repoRoot)
    expect(registry.byName.get('@taiji/shared')?.private).toBe(true)
    expect(registry.byName.get('@zhushanwen/pi-todo')?.private).toBe(false)
    expect(registry.ignoreSet.has('@taiji/ui')).toBe(true)
  })
})
