#!/usr/bin/env node
/**
 * versionable-packages.mjs — workspace 包清单单一 CLI（「哪些包需要版本处理」的权威出口）。
 *
 * 包枚举唯一源 = @manypkg getPackagesSync（跟随 pnpm-workspace.yaml globs）+ .changeset/
 * config.json ignore 名单（经 changeset-versionable.mjs 的 loadPackageRegistry，与无效
 * 声明方向同源）。历史上「哪些包需要版本处理」有四份平行枚举：check-version-changes.sh
 * 与 apply-version.sh 各持硬编码目录、changeset-check.mjs 方向① 持 extensions/ 正则
 * （v0.11.16 六包漏声明直穿终局 PR 即此分叉的实测后果——packages/ 完全不在该正则内）。
 * 本 CLI 收敛枚举：上述三处 + 方向① 全部消费本出口，目录布局变化自动跟随 workspace 定义。
 *
 * 用法：node scripts/versionable-packages.mjs [--json]
 *   --json：单行 { packages: [{ name, dir, version, private, ignored, versionable,
 *            wsDeps: [{ dep, range, depType }] }], ignore: [name, ...] }
 *            dir = 相对仓库根的 POSIX 路径；wsDeps = 三类 deps 中 workspace: range 的边
 *   默认：逐包一行 name <dir> <private|ignored|versionable>
 * 退出码：0 正常；2 工具错误
 */
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getPackagesSync } from '@manypkg/get-packages'
import { loadPackageRegistry } from './changeset-versionable.mjs'

/** 包清单（同步——调用方 shell 内嵌 cjs 与既有测试均为同步链）。 */
export function loadWorkspacePackages(root) {
  const { packages } = getPackagesSync(root)
  const registry = loadPackageRegistry(root)
  const out = []
  for (const pkg of packages) {
    const name = pkg.packageJson.name
    if (!name) continue
    const entry = registry.byName.get(name)
    const priv = entry ? entry.private : !!pkg.packageJson.private
    const ignored = registry.ignoreSet.has(name)
    const wsDeps = []
    for (const depType of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const [dep, range] of Object.entries(pkg.packageJson[depType] || {})) {
        if (typeof range === 'string' && range.startsWith('workspace')) {
          wsDeps.push({ dep, range, depType })
        }
      }
    }
    out.push({
      name,
      dir: relative(root, pkg.dir).split('\\').join('/'),
      version: pkg.packageJson.version,
      private: priv,
      ignored,
      versionable: !priv && !ignored,
      wsDeps,
    })
  }
  out.sort((a, b) => a.name.localeCompare(b.name))
  return { packages: out, ignore: [...registry.ignoreSet].sort() }
}

function main(argv) {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: process.cwd(), encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
  const { packages, ignore } = loadWorkspacePackages(root)
  if (argv.includes('--json')) {
    console.log(JSON.stringify({ packages, ignore }))
    return
  }
  for (const p of packages) {
    const tag = p.private ? 'private' : p.ignored ? 'ignored' : 'versionable'
    console.log(`${p.name} <${p.dir}> ${tag}${p.wsDeps.length > 0 ? ` wsDeps=${String(p.wsDeps.length)}` : ''}`)
  }
  console.log(`ignore 名单：${ignore.length} 项`)
}

const invokedDirectly = (() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()

if (invokedDirectly) {
  main(process.argv.slice(2))
}
