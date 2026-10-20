#!/usr/bin/env node
/**
 * check_changeset_packages.mjs —— pre-commit：changeset 声明包合法性检查。
 *
 * 拦截对不可版本化包（private ∨ .changeset/config.json ignore）的 changeset 声明：
 * 纯 private 声明被 changeset version 静默跳过（文件永久残留，v0.11.9 发布前才被
 * 人工发现），混合声明阻断 version。判定唯一源 = scripts/changeset-versionable.mjs。
 *
 * 用法（install-hooks.sh 挂载）：node .githooks/check_changeset_packages.mjs <staged .changeset/*.md 路径>...
 *       （测试/手工探针）node .githooks/check_changeset_packages.mjs --root <dir> <路径>...
 * 退出码：0 = 放行（无 changeset 文件或全部合法）；1 = 检出不可版本化声明；2 = 工具错误
 */
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findUnversionable, loadPackageRegistry, parseChangesetFrontmatter } from '../scripts/changeset-versionable.mjs'

function gitShowStaged(root, path) {
  return execFileSync('git', ['show', `:${path}`], {
    cwd: root,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function main(argv) {
  let root = process.cwd()
  const files = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') {
      root = resolve(argv[++i])
    } else {
      files.push(argv[i])
    }
  }
  if (files.length === 0) process.exit(0)

  let registry
  try {
    registry = loadPackageRegistry(root)
  } catch (e) {
    console.error(`[ERROR] 包全景扫描失败：${e.message}。恢复：确认 ${root} 为 workspace 根后重跑`)
    process.exit(2)
  }

  const declared = []
  for (const file of files) {
    let text
    try {
      text = gitShowStaged(root, file)
    } catch (e) {
      // staged 路径读不到 index 内容（add 后又被删等竞态）按工具错误处理，不静默放行
      console.error(`[ERROR] 读取 staged 内容失败：${file}（${e.message}）。恢复：git status 核对该文件状态后重试提交`)
      process.exit(2)
    }
    declared.push(...parseChangesetFrontmatter(text).map((d) => ({ ...d, file })))
  }

  const bad = findUnversionable(declared.map((d) => d.name), registry)
  if (bad.length === 0) process.exit(0)

  console.error('[ERROR] changeset 声明了不可版本化的包（private 或 config.ignore 清单内），声明永不生效：')
  for (const name of bad) {
    const hits = declared.filter((d) => d.name === name)
    for (const h of hits) {
      console.error(`  - ${h.file}: '${h.name}': ${h.bumpType}`)
    }
  }
  console.error('[FIX] 该包为 private（不发 npm），版本语义由 Electron 发布线承载，不经 changesets：')
  console.error('[FIX]   从 frontmatter 删除对应行，或 git restore --staged --worktree .changeset/<文件> 删除整个 changeset 文件')
  process.exit(1)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
}
