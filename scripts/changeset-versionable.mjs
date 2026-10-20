/**
 * changeset-versionable.mjs —— changeset 声明包合法性判定（唯一判定源）。
 *
 * 「哪些包可被 .changeset/*.md frontmatter 声明」与 changesets 的 shouldSkipPackage
 * 语义对齐：private 包或 .changeset/config.json ignore 清单内的包不可声明。对 private
 * 包的声明永不生效——纯 private 声明被 `changeset version` 静默跳过（文件永久残留），
 * 与发布包混合声明则阻断 version（assemble-release-plan throw）。
 *
 * 消费方：.githooks/check_changeset_packages.mjs（pre-commit，staged 文件）与
 * scripts/changeset-check.mjs（Gate-1a.5 / dev-merge gates，磁盘全量）。禁止在消费方
 * 复制判定逻辑。apply-version.sh 的 --changed 守卫是独立实现（bash 内嵌、传参通道），
 * 语义相同，未收敛——改动本判定时须连带核对该脚本 isVersionable。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getPackagesSync } from '@manypkg/get-packages'

/** frontmatter 内一条声明：包名 + 版本档位。 */
export function parseChangesetFrontmatter(text) {
  const lines = text.split('\n')
  if (lines[0]?.trim() !== '---') return []
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---')
  if (end === -1) return []
  const out = []
  for (const line of lines.slice(1, end)) {
    // 带引号（'@taiji/shared': minor）与无引号（pkg: patch）两种格式；bump 档位限定
    // patch|minor|major，防止把 frontmatter 里其他键（如未来新增的元数据键）当包名
    const m = line.match(/^\s*['"]?([A-Za-z0-9@][A-Za-z0-9@/._-]*)['"]?\s*:\s*(patch|minor|major)\s*$/)
    if (m) out.push({ name: m[1], bumpType: m[2] })
  }
  return out
}

/**
 * root 下的包全景 → 判定输入。包发现经 @manypkg/get-packages（changesets 同源机制），
 * 包存在性与 private 状态与工具自身看到的一致，workspace 定义变化自动跟随。
 * 同步 API（getPackagesSync）：调用方（pre-commit / Gate-1a.5）与既有 runCheck 测试
 * 均为同步链，保持零 await 侵入。
 */
export function loadPackageRegistry(root) {
  const { packages } = getPackagesSync(root)
  const byName = new Map()
  for (const pkg of packages) {
    byName.set(pkg.packageJson.name, { private: !!pkg.packageJson.private, dir: pkg.dir })
  }
  let ignore = []
  try {
    const config = JSON.parse(readFileSync(join(root, '.changeset', 'config.json'), 'utf-8'))
    ignore = Array.isArray(config.ignore) ? config.ignore : []
  } catch {
    // config 缺失/非法 = 无 ignore 清单，private 判定照常
  }
  return { byName, ignoreSet: new Set(ignore) }
}

/**
 * 声明包名清单 → 不可版本化子集（private ∨ ignore）。包不存在于 workspace 的声明
 * 不在此判（typo 由 check-version-changes.sh WARN_DECLARED_PACKAGE_NOT_FOUND 承接，
 * 两个检查互不越界）。
 */
export function findUnversionable(declaredNames, registry) {
  return declaredNames.filter((name) => {
    const pkg = registry.byName.get(name)
    return (pkg && pkg.private) || registry.ignoreSet.has(name)
  })
}
