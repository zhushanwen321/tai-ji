#!/usr/bin/env node
// scripts/check-pi-resources-links.mjs — resources/pi 外部 symlink 打包互斥检测
//
// 背景（2026-10 codesign 构建事故）：`pnpm dev` 装配器把 worktree 的
// apps/electron/resources/pi/ 各条目 stage 成指向 workspace 级缓存 .pi-binary-cache/
// 的 symlink（免重复下载）。electron-builder 经 extraResources（electron-builder.yml
// `from: resources/pi`）**从磁盘原样拷贝**这些链接进 bundle，codesign 校验以
// 「bundle 必须自包含」拒绝：invalid destination for symbolic link in bundle。
//
// [HISTORICAL] preflight-check.sh 检查 7 曾有「git check-ignore 命中的 symlink 跳过」
// 豁免——其假设（gitignored 的 dev 缓存 symlink「不进 git，非打包风险」）是错的：
// electron-builder 拷贝源是磁盘而非 git，gitignored symlink 恰是本地打包的头号风险源。
// 且 preflight 只在 pre-commit（配置变更时）与 CI build.yml 显式 step 运行，本地
// `pnpm build` 全程不经过它——本脚本同时挂在两处消费（build 脚本链最前 + preflight
// 检查 7），单一逻辑源。
//
// CI 影响：零。CI 上 prepare-pi-resources.sh 走真实下载复制，无 symlink，检查空过。
//
// 用法：
//   node scripts/check-pi-resources-links.mjs          # 检测；发现外部 symlink → 退出 1
//   node scripts/check-pi-resources-links.mjs --fix    # 外部 symlink 替换为真实复制后复检
//
// 判定：symlink 目标经 path.resolve 解析后位于 resources/pi 目录内部 → 放行（bundle
// 内相对链接 codesign 合法）；否则（含断链、指向 workspace 缓存/绝对路径）→ 拦截。

import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readlinkSync, readdirSync, rmSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PI_RES_DIR = path.join(PROJECT_ROOT, 'apps', 'electron', 'resources', 'pi')

const FIX_MODE = process.argv.includes('--fix')

/** 递归收集 dir 下全部 symlink（绝对路径）。目录不存在 → 空数组。 */
function collectSymlinks(dir) {
  if (!existsSync(dir)) return []
  const found = []
  const walk = (current) => {
    for (const entry of readdirSync(current)) {
      const full = path.join(current, entry)
      let st
      try {
        st = lstatSync(full)
      } catch {
        continue
      }
      if (st.isSymbolicLink()) found.push(full)
      else if (st.isDirectory()) walk(full)
    }
  }
  walk(dir)
  return found
}

/** symlink 目标解析出的绝对路径是否落在 pi 资源目录内部（bundle 自包含语义）。 */
function resolvesInsidePi(linkPath) {
  const raw = readlinkSync(linkPath)
  const resolved = path.resolve(path.dirname(linkPath), raw)
  return resolved === PI_RES_DIR || resolved.startsWith(PI_RES_DIR + path.sep)
}

/**
 * 递归实体化复制：遇到 symlink 跟随其目标递归复制内容（断链显式报错），
 * 文件保留权限位（pi 二进制需要可执行位）。
 * 不用 cpSync(dereference: true)：实测 Node v24 对目录内部的 symlink 不 dereference
 * （实测 pi-0.80.3 缓存的 assets/theme/export-html 内各有一个指向旧 workspace 的子链接，
 * cpSync 原样保留 → bundle 仍不自包含）。
 */
function materializeTree(src, dest, visiting = new Set()) {
  const st = lstatSync(src)
  if (st.isSymbolicLink()) {
    const resolved = path.resolve(path.dirname(src), readlinkSync(src))
    if (!existsSync(resolved)) {
      throw new Error(`断链无法实体化: ${src} -> ${resolved}`)
    }
    // DFS 路径环检测：链接图成环时（实测 2026-10 旧 .pi-binary-cache/pi-0.80.3 内部
    // 子链接跨 workspace 自环）不设防会 dest 无限加深直至 ENAMETOOLONG。
    if (visiting.has(resolved)) {
      throw new Error(`环形链接（缓存目录内容损坏，建议删除对应缓存目录后重跑 prepare-pi-resources.sh）: ${src} -> ${resolved}`)
    }
    visiting.add(resolved)
    try {
      materializeTree(resolved, dest, visiting)
    } finally {
      visiting.delete(resolved)
    }
    return
  }
  if (st.isDirectory()) {
    mkdirSync(dest, { recursive: true })
    for (const entry of readdirSync(src)) {
      materializeTree(path.join(src, entry), path.join(dest, entry), visiting)
    }
    return
  }
  copyFileSync(src, dest)
  chmodSync(dest, st.mode & 0o777)
}

/** 把单个外部 symlink 替换为对其目标的真实复制（todo 登记的恢复语义，Node 跨平台）。 */
function materializeLink(linkPath) {
  const target = path.resolve(path.dirname(linkPath), readlinkSync(linkPath))
  if (!existsSync(target)) {
    throw new Error(`symlink 目标不存在，无法复制: ${linkPath} -> ${target}`)
  }
  // collectSymlinks 已用 lstat 确认是 symlink —— unlinkSync 只删链接本身不碰目标；
  // rmSync 对指向目录的链接会抛 "Path is a directory"（实测），不能用。
  unlinkSync(linkPath)
  try {
    materializeTree(target, linkPath)
  } catch (err) {
    // 清理半成品：复制中途失败残留的部分目录比 symlink 更隐蔽（复检不再报、内容却不全）
    rmSync(linkPath, { recursive: true, force: true })
    throw err
  }
}

// ── 主流程 ────────────────────────────────────────────────────────

if (!existsSync(PI_RES_DIR)) {
  // 目录缺失 = 本地从未 stage pi 资源（CI fresh checkout 常态）——不是本检查的职责面，
  // 打包所需资源由 prepare-pi-resources.sh / dev 装配器负责就绪。
  console.log(`✓ resources/pi 不存在（未 stage），无 symlink 风险`)
  process.exit(0)
}

const external = collectSymlinks(PI_RES_DIR).filter((l) => !resolvesInsidePi(l))

if (external.length === 0) {
  console.log(`✓ resources/pi 无外部 symlink`)
  process.exit(0)
}

console.error(`✗ resources/pi 存在 ${external.length} 个外部 symlink（打包后 codesign 校验必炸：bundle 必须自包含）：`)
for (const link of external) {
  console.error(`    ${path.relative(PI_RES_DIR, link)} -> ${readlinkSync(link)}`)
}

if (!FIX_MODE) {
  console.error(`  修复（二选一）：`)
  console.error(`    a) node scripts/check-pi-resources-links.mjs --fix   # 替换为真实复制（产物目录 gitignored，不影响 dev 复用）`)
  console.error(`    b) 跑一次 pnpm dev 前先执行 a；下次 pnpm dev 会重建 symlink 形态，构建前需重查`)
  process.exit(1)
}

let failed = 0
for (const link of external) {
  try {
    materializeLink(link)
    console.log(`  已替换为真实复制: ${path.relative(PI_RES_DIR, link)}`)
  } catch (err) {
    console.error(`  替换失败: ${path.relative(PI_RES_DIR, link)}: ${err.message}`)
    failed++
  }
}

// 复检：修复后必须干净，否则仍按失败退出（例如复制中途磁盘错误留下半成品）
const remaining = collectSymlinks(PI_RES_DIR).filter((l) => !resolvesInsidePi(l))
if (remaining.length > 0 || failed > 0) {
  console.error(`✗ 修复后仍有 ${remaining.length} 个外部 symlink / ${failed} 项替换失败`)
  process.exit(1)
}
console.log(`✓ 全部外部 symlink 已替换为真实复制`)
