/**
 * check-publish-surface.mjs 单测（实施计划 npm-publish-surface-guard u1）：
 * 发现 / 幽灵条目 / 自包含探针三步判定 / 反向覆盖 / 体积 warning 的判定逻辑
 * 机器锁定。fixture 全部落 tmpdir（rootDir 注入 runGuard / 磁盘路径注入直测函数），
 * 不依赖真实仓库状态——按 check-core-dist-gate.test.mjs 惯例。
 *
 * 用例对应设计 docs/architecture/npm-publish-surface-guard.md：D3（三步判定顺序 +
 * ajv/dist/runtime/* 豁免含预期计数 4 与 .default 形态锚点）、D5（动态发现 +
 * 磁盘 stat 判定 + 反向覆盖）、D7（体积 warning 不红）；S1/S1b 场景的 fixture
 * 等价复现（真实仓库临时改包核验由主 agent 执行，不在此做）。
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import {
  discoverGuardedPackages,
  checkGhostEntries,
  checkSelfContained,
  checkReverseCoverage,
  runGuard,
} from '../check-publish-surface.mjs'

const MB = 1024 * 1024

/**
 * tmpdir 仓库根 fixture 工厂：files 为 rel 路径 → 内容（string / Buffer）映射，
 * emptyDirs 为需预建的空目录列表（写文件无法产生空目录），调用方 finally rmSync 清理。
 */
function makeRepo(files, emptyDirs = []) {
  const root = mkdtempSync(join(tmpdir(), 'publish-surface-fx-'))
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  for (const d of emptyDirs) mkdirSync(join(root, d), { recursive: true })
  return root
}

const pkgJsonOf = (fields) => JSON.stringify({ name: '@fixture/guarded', ...fields })

/**
 * 豁免清单标准形态（4 处，.default 后缀）。单/双引号混合是刻意的测试设计——
 * 覆盖 REQUIRE_RE 的单/双引号两个分支；真实产物实测 4 处 ajv 字面量全为双引号、
 * 单引号 0 处（混合分布不是真实产物现状，是 fixture 放宽的引号形态覆盖）。
 */
const AJV_EXEMPT_OK = [
  'require("ajv/dist/runtime/validation_error").default;',
  "require('ajv/dist/runtime/uri').default;",
  'require("ajv/dist/runtime/ucs2length").default;',
  "require('ajv/dist/runtime/equal').default;",
].join('\n')

describe('discoverGuardedPackages（D5 动态发现）', () => {
  it('dist 前缀目录条目三形态纳入（"dist" / "dist/" / "dist.bundle/"）', () => {
    const root = makeRepo({
      'packages/a/package.json': pkgJsonOf({ name: '@fixture/a', files: ['dist', 'README.md'] }),
      'packages/b/package.json': pkgJsonOf({ name: '@fixture/b', files: ['dist/', 'dist.bundle/'] }),
      'packages/c/package.json': pkgJsonOf({ name: '@fixture/c', files: ['src/', 'dist/**/*.cjs'] }),
    })
    try {
      const found = discoverGuardedPackages(join(root, 'packages'))
      expect(found.map((p) => p.name).sort()).toEqual(['@fixture/a', '@fixture/b', '@fixture/c'])
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
  it('private 包不纳入发现面', () => {
    const root = makeRepo({
      'packages/priv/package.json': pkgJsonOf({ name: '@fixture/priv', private: true, files: ['dist/'] }),
    })
    try {
      expect(discoverGuardedPackages(join(root, 'packages'))).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
  it('files 无 dist 条目的 TS 源直发包不纳入', () => {
    const root = makeRepo({
      'packages/ts-src/package.json': pkgJsonOf({ name: '@fixture/ts', files: ['src/', 'index.ts'] }),
      'packages/nofiles/package.json': pkgJsonOf({ name: '@fixture/nf', description: '无 files 字段' }),
    })
    try {
      expect(discoverGuardedPackages(join(root, 'packages'))).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})

describe('checkGhostEntries（检查项 1：磁盘 stat 判定形态）', () => {
  const DIR = (root) => join(root, 'packages', 'p')
  it('npm 排除语义条目（"!" 前缀）不参与幽灵检查——排除的是 tarball 扣除规则而非存在性承诺', () => {
    const root = makeRepo({
      'packages/p/package.json': pkgJsonOf({}),
      'packages/p/src/index.ts': 'export {}',
      'packages/p/dist/index.js': 'export {}',
    })
    try {
      // "!src/__tests__" 指向的路径磁盘上不存在：排除规则对不存在的东西排除
      // 是合法 npm 形态（subagent-engine-sdk files 实态），不得按幽灵条目红
      expect(checkGhostEntries(DIR(root), ['src/', '!src/__tests__', 'dist/'], '@fixture/p')).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
  it('目录条目磁盘不存在 → 红（含幽灵定性 + 三处构建段恢复指引 + --filter 包名）', () => {
    const root = makeRepo({ 'packages/p/package.json': pkgJsonOf({}) })
    try {
      const problems = checkGhostEntries(DIR(root), ['dist/'], '@fixture/p')
      expect(problems.length).toBe(1)
      expect(problems[0]).toContain('"dist/" 在磁盘上不存在（幽灵条目）')
      expect(problems[0]).toContain('release-npm.yml')
      expect(problems[0]).toContain('release-npm-dev.yml')
      expect(problems[0]).toContain('ci.yml')
      expect(problems[0]).toContain('Build dist packages')
      expect(problems[0]).toContain('pnpm --filter @fixture/p run <script>')
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
  it('目录存在但为空 → 红（npm pack 对空目录同样静默跳过）', () => {
    const root = makeRepo({ 'packages/p/package.json': pkgJsonOf({}) }, ['packages/p/dist'])
    try {
      const problems = checkGhostEntries(DIR(root), ['dist/'], '@fixture/p')
      expect(problems.length).toBe(1)
      expect(problems[0]).toContain('"dist/" 在磁盘上是空目录（幽灵条目')
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
  it('目录只含空子目录 → 红（非空断言按递归文件数判定）', () => {
    const root = makeRepo({ 'packages/p/package.json': pkgJsonOf({}) }, ['packages/p/dist/nested'])
    try {
      expect(checkGhostEntries(DIR(root), ['dist/'], '@fixture/p').length).toBe(1)
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
  it('文件条目缺失 → 红；零字节文件 → 红；非零文件 → 绿', () => {
    const root = makeRepo({
      'packages/p/package.json': pkgJsonOf({}),
      'packages/p/empty.md': '',
      'packages/p/README.md': '# p',
    })
    try {
      const problems = checkGhostEntries(DIR(root), ['MISSING.md', 'empty.md', 'README.md'], '@fixture/p')
      expect(problems.length).toBe(2)
      expect(problems[0]).toContain('"MISSING.md" 在磁盘上不存在（幽灵条目）')
      expect(problems[1]).toContain('"empty.md" 在磁盘上是零字节文件（幽灵条目）')
      expect(checkGhostEntries(DIR(root), ['README.md'], '@fixture/p')).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
  it('glob 条目零命中 → 红；命中 ≥1 → 绿（minimatch 语义）', () => {
    const root = makeRepo({
      'packages/p/package.json': pkgJsonOf({}),
      'packages/p/dist/index.cjs': 'module.exports = 1',
      'packages/p/dist/sub/deep.js': 'x',
    })
    try {
      const miss = checkGhostEntries(DIR(root), ['dist/**/*.mjs'], '@fixture/p')
      expect(miss.length).toBe(1)
      expect(miss[0]).toContain('"dist/**/*.mjs" 未命中任何文件（幽灵条目）')
      expect(checkGhostEntries(DIR(root), ['dist/**/*.cjs', '**/*.js'], '@fixture/p')).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
  it('无尾斜杠目录条目（"dist" 精确条目指向目录）：空目录红、含文件绿', () => {
    const root = makeRepo({ 'packages/p/package.json': pkgJsonOf({}) }, ['packages/p/dist'])
    try {
      expect(checkGhostEntries(DIR(root), ['dist'], '@fixture/p').length).toBe(1)
      writeFileSync(join(DIR(root), 'dist', 'index.js'), 'module.exports = 1')
      expect(checkGhostEntries(DIR(root), ['dist'], '@fixture/p')).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})

describe('checkSelfContained（检查项 2：D3 三步判定 + 豁免锚点）', () => {
  const ENTRY = (root) => join(root, 'packages', 'p', 'dist.bundle', 'index.cjs')
  const probeOf = (content) => makeRepo({ 'packages/p/dist.bundle/index.cjs': content })
  const probe = (root) => checkSelfContained(ENTRY(root), 'dist.bundle/index.cjs', 'packages/p')

  // 三步顺序用例统一附 4 处标准豁免形态作计数基线：豁免计数核对是对全局清单
  // 无条件跑的（hits < 预期即 notice），不带基线会混入计数 notice 干扰顺序验证。
  it('第一步先行：fs/promises 与 node:fs/promises 内建子路径 PASS（不进豁免检查）', () => {
    const root = probeOf(
      `const a = require("fs/promises");\nconst b = require('node:fs/promises');\n${AJV_EXEMPT_OK}\n`,
    )
    try {
      const { problems, notices } = probe(root)
      expect(problems).toEqual([])
      expect(notices).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
  it('内建裸名（fs / node:fs / node:path）与相对路径（./ ../）PASS', () => {
    const root = probeOf(
      [
        `const a = require("fs");`,
        `const b = require('node:fs');`,
        `const c = require("node:path");`,
        `const d = require("./chunk.cjs");`,
        `const e = require('../other.cjs');`,
        AJV_EXEMPT_OK,
      ].join('\n'),
    )
    try {
      expect(probe(root)).toEqual({ problems: [], notices: [] })
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
  it('裸名外部说明符 → 红（报错指向 tsup bundleConfig.noExternal + 自包含语义）', () => {
    const root = probeOf(`const ajv = require("ajv");\n`)
    try {
      const { problems } = probe(root)
      expect(problems.length).toBe(1)
      expect(problems[0]).toContain('外部依赖 require("ajv")')
      expect(problems[0]).toContain('packages/p/tsup.config.ts bundleConfig.noExternal')
      expect(problems[0]).toContain('自包含档必须内联全部运行时依赖')
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
  it('豁免标准形态恰 4 处 → 零红零 notice', () => {
    const root = probeOf(`${AJV_EXEMPT_OK}\nconst fs = require("fs");\n`)
    try {
      expect(probe(root)).toEqual({ problems: [], notices: [] })
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
  it('子路径外部说明符未命中豁免 → 红（fail-closed，含双分支处置口径）', () => {
    const root = probeOf(`const u = require("yaml/dist/util");\n`)
    try {
      const { problems } = probe(root)
      expect(problems.length).toBe(1)
      expect(problems[0]).toContain('require("yaml/dist/util")——未命中豁免清单（fail-closed）')
      expect(problems[0]).toContain('SUBPATH_EXEMPTIONS')
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
  it('豁免命中数超预期（5 处同前缀）→ 红', () => {
    const root = probeOf(
      [AJV_EXEMPT_OK, "require('ajv/dist/runtime/extra').default;"].join('\n'),
    )
    try {
      const { problems } = probe(root)
      expect(problems.length).toBe(1)
      expect(problems[0]).toContain('命中 5 处 > 预期计数 4')
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
  it('豁免命中少于预期（2 处）→ notice 不红', () => {
    const root = probeOf(
      ['require("ajv/dist/runtime/equal").default;', "require('ajv/dist/runtime/uri').default;"].join('\n'),
    )
    try {
      const { problems, notices } = probe(root)
      expect(problems).toEqual([])
      expect(notices.length).toBe(1)
      expect(notices[0]).toContain('命中 2 处 < 预期计数 4')
      expect(notices[0]).toContain('复核预期计数')
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
  it('形态锚点失配（命中处无 .default 后缀）→ 红', () => {
    const root = probeOf(
      [
        'require("ajv/dist/runtime/validation_error");',
        "require('ajv/dist/runtime/uri');",
        'require("ajv/dist/runtime/ucs2length");',
        "require('ajv/dist/runtime/equal');",
      ].join('\n'),
    )
    try {
      const { problems } = probe(root)
      expect(problems.length).toBe(1)
      expect(problems[0]).toContain('形态锚点失配')
      expect(problems[0]).toContain('.default')
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
  it('入口文件不存在 → 红（探针无对象，fail-closed 不 crash）', () => {
    const { problems } = checkSelfContained('/nonexistent/dist.bundle/index.cjs')
    expect(problems.length).toBe(1)
    expect(problems[0]).toContain('不存在')
  })
})

describe('checkReverseCoverage（检查项 3：漏声明方向）', () => {
  const DIR = (root) => join(root, 'packages', 'p')
  const repoWithWorker = () =>
    makeRepo({
      'packages/p/package.json': pkgJsonOf({ files: ['dist/', 'README.md'] }),
      'packages/p/dist/index.js': 'module.exports = 1',
      'packages/p/README.md': '# p',
      'packages/p/dist.worker/placeholder.cjs': '// placeholder',
    })

  it('顶层 dist.worker 目录未被 files 覆盖 → 红（含双分支恢复指引）', () => {
    const root = repoWithWorker()
    try {
      const problems = checkReverseCoverage(DIR(root), ['dist/', 'README.md'])
      expect(problems.length).toBe(1)
      expect(problems[0]).toContain('"dist.worker/" 存在但未被 files 白名单覆盖')
      expect(problems[0]).toContain('files 补条目')
      expect(problems[0]).toContain('不得用 dist 前缀')
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
  it('目录条目 "dist.worker/" 覆盖 → 绿', () => {
    const root = repoWithWorker()
    try {
      expect(checkReverseCoverage(DIR(root), ['dist/', 'dist.worker/', 'README.md'])).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
  it('同名无尾斜杠条目 "dist.worker" 覆盖 → 绿', () => {
    const root = repoWithWorker()
    try {
      expect(checkReverseCoverage(DIR(root), ['dist/', 'dist.worker', 'README.md'])).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
  it('精确条目 "dist" 覆盖顶层 dist 目录；非 dist 前缀目录不触发', () => {
    const root = makeRepo({
      'packages/p/package.json': pkgJsonOf({ files: ['dist', 'README.md'] }),
      'packages/p/dist/index.js': 'x',
      'packages/p/README.md': '# p',
      'packages/p/build/tmp.js': 'x',
      'packages/p/coverage/lcov.info': 'x',
    })
    try {
      expect(checkReverseCoverage(DIR(root), ['dist', 'README.md'])).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})

describe('runGuard（rootDir 注入全链路）', () => {
  it('S1 场景等价复现：files 含 dist.worker/ 但磁盘无 → 幽灵红（含恢复指引）', () => {
    const root = makeRepo({
      'packages/p/package.json': pkgJsonOf({ files: ['dist/', 'dist.worker/', 'README.md'] }),
      'packages/p/dist/index.js': 'module.exports = 1',
      'packages/p/README.md': '# p',
    })
    try {
      const { guarded, failures, notices, warnings } = runGuard(root)
      expect(guarded.length).toBe(1)
      expect(failures.length).toBe(1)
      expect(failures[0]).toContain('✗ @fixture/guarded:')
      expect(failures[0]).toContain('"dist.worker/" 在磁盘上不存在（幽灵条目）')
      expect(failures[0]).toContain('pnpm --filter @fixture/guarded run <script>')
      expect(notices).toEqual([])
      expect(warnings).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
  it('S1b 场景等价复现：mkdir dist.worker + 占位 .cjs 不加 files → 反向覆盖红；补条目后全绿', () => {
    const root = makeRepo({
      'packages/p/package.json': pkgJsonOf({ files: ['dist/', 'README.md'] }),
      'packages/p/dist/index.js': 'module.exports = 1',
      'packages/p/README.md': '# p',
      'packages/p/dist.worker/placeholder.cjs': '// placeholder',
    })
    try {
      const red = runGuard(root)
      expect(red.failures.length).toBe(1)
      expect(red.failures[0]).toContain('"dist.worker/" 存在但未被 files 白名单覆盖')

      writeFileSync(
        join(root, 'packages', 'p', 'package.json'),
        pkgJsonOf({ files: ['dist/', 'dist.worker/', 'README.md'] }),
      )
      const green = runGuard(root)
      expect(green.failures).toEqual([])
      expect(green.notices).toEqual([])
      expect(green.warnings).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
  it('全绿链路：双档包（dist/ + dist.bundle/ 标准豁免形态）三数组全空', () => {
    const root = makeRepo({
      'packages/p/package.json': pkgJsonOf({ files: ['dist/', 'dist.bundle/', 'README.md'] }),
      'packages/p/dist/index.js': 'module.exports = 1',
      'packages/p/dist.bundle/index.cjs': `const fs = require("fs");\n${AJV_EXEMPT_OK}\n`,
      'packages/p/README.md': '# p',
    })
    try {
      const { guarded, failures, notices, warnings } = runGuard(root)
      expect(guarded.map((p) => p.name)).toEqual(['@fixture/guarded'])
      expect(failures).toEqual([])
      expect(notices).toEqual([])
      expect(warnings).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
  it('探针全链路红：dist.bundle 入口含裸名外部 require → failures 含自包含红', () => {
    const root = makeRepo({
      'packages/p/package.json': pkgJsonOf({ files: ['dist/', 'dist.bundle/', 'README.md'] }),
      'packages/p/dist/index.js': 'module.exports = 1',
      'packages/p/dist.bundle/index.cjs': `const y = require("yaml");\n${AJV_EXEMPT_OK}\n`,
      'packages/p/README.md': '# p',
    })
    try {
      const { failures } = runGuard(root)
      expect(failures.length).toBe(1)
      expect(failures[0]).toContain('自包含档 dist.bundle/index.cjs 含外部依赖 require("yaml")')
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
  it('豁免少于预期走 runGuard 仍绿：notices 非空、failures 空', () => {
    const root = makeRepo({
      'packages/p/package.json': pkgJsonOf({ files: ['dist/', 'dist.bundle/'] }),
      'packages/p/dist/index.js': 'module.exports = 1',
      'packages/p/dist.bundle/index.cjs':
        'require("ajv/dist/runtime/equal").default;\nrequire(\'ajv/dist/runtime/uri\').default;\n',
    })
    try {
      const { failures, notices } = runGuard(root)
      expect(failures).toEqual([])
      expect(notices.length).toBe(1)
      expect(notices[0]).toContain('命中 2 处 < 预期计数 4')
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
  it('体积估算 warning：files 条目总和超 5MB → warning 且 failures 空；恰 5MB 不触发', () => {
    const root = makeRepo({
      'packages/p/package.json': pkgJsonOf({ files: ['dist/'] }),
      'packages/p/dist/big.bin': Buffer.alloc(5 * MB, 'a'),
    })
    try {
      expect(runGuard(root).warnings).toEqual([])

      writeFileSync(join(root, 'packages', 'p', 'dist', 'big.bin'), Buffer.alloc(5 * MB + 1, 'a'))
      const { failures, warnings } = runGuard(root)
      expect(failures).toEqual([])
      expect(warnings.length).toBe(1)
      expect(warnings[0]).toContain('超 5MB')
      expect(warnings[0]).toContain('D7')
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
  it('private 包 / 无 dist 条目包经 runGuard 不产生任何检查结果', () => {
    const root = makeRepo({
      'packages/priv/package.json': pkgJsonOf({ name: '@fixture/priv', private: true, files: ['dist/'] }),
      'packages/ts-src/package.json': pkgJsonOf({ name: '@fixture/ts', files: ['src/'] }),
      'packages/ts-src/src/index.ts': 'export {}',
    })
    try {
      const { guarded, failures, notices, warnings } = runGuard(root)
      expect(guarded).toEqual([])
      expect(failures).toEqual([])
      expect(notices).toEqual([])
      expect(warnings).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})
