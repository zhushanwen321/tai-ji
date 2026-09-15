/**
 * Cross-platform path utilities: `~` expansion/normalization + comparison helpers.
 *
 * [修复] isUnderOrEqual 曾被误迁到 @taiji/shared（W1a），但 shared 是浏览器/runtime 共享层，
 * node:path 在浏览器被 vite externalize 成空对象 → dev 启动崩溃。isUnderOrEqual 所有调用点
 * 都在 runtime（file-service / git-service / extension-service），属 runtime 专用，回归此文件。
 *
 * expandHome / normalizeToHome 是 R4 收敛的单一权威定义：此前 scanner-base /
 * config-service / skill-dir-config / pi-provider-store 各自复制了同一份逻辑，
 * 注释自承「与 scanner-base.expandHome 对齐」。现统一自此 import。
 */
import { realpathSync } from 'node:fs'
import { relative, resolve, isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'

/**
 * 展开 `~` 前缀为用户家目录（`~/.pi` → `/Users/.../.pi`）。无 `~` 前缀则原样返回。
 *
 * 单一权威定义（R4）：scanner-base / config-service / skill-dir-config 不再各自复制。
 */
export function expandHome(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p
}

/**
 * 家目录下的绝对路径归一化为 `~` 前缀（`/Users/.../.pi` → `~/.pi`），便于与 UI 预设候选统一比较。
 * 家目录本身归一为 `~`；非家目录路径原样返回。与 {@link expandHome} 互逆。
 */
export function normalizeToHome(p: string): string {
  const home = homedir()
  if (p === home) return '~'
  if (p.startsWith(`${home}/`)) return `~${p.slice(home.length)}`
  return p
}

/**
 * 判断 child 是否在 parent 目录下或等于 parent（词法判定，不解析 symlink）。
 *
 * 算法：path.relative(parent, child) → 结果为空串/不以 '..' 开头/不以路径分隔符开头 → true。
 * 使用 path.resolve 规范化后再比较，处理 '..' 和多余分隔符。
 *
 * 安全语义：用于文件树越界守门（listTree/expandDir/readFile 入口校验 path 不逃出 cwd）。
 */
export function isUnderOrEqual(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Is `child` strictly under `parent` (not equal)? */
export function isStrictlyUnder(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

const GIT_SUFFIX = '.git'

/**
 * 从 Git URL 提取仓库名（用于 clone 目标子目录命名）。
 *
 * 处理 https:// / ssh:// / git@ 三种格式，取末段去 `.git` 后缀：
 * `git@github.com:user/repo.git` → `repo`；`https://github.com/user/repo` → `repo`。
 * 解析失败 fallback `'repo'`。
 */
export function extractRepoName(url: string): string {
  const cleanUrl = url.split(/[?#]/)[0]
  const parts = cleanUrl.replace(/[/]+$/, '').split(/[/]/)
  const last = parts[parts.length - 1] ?? ''
  const name = last.endsWith(GIT_SUFFIX) ? last.slice(0, -GIT_SUFFIX.length) : last
  return name || 'repo'
}

/** 规范化路径为 realpath（解析符号链接）。
 *  realpathSync 失败（文件不存在/权限）时返回原值，不抛异常。
 *  用于 extension 去重 key 计算等需要稳定唯一路径的场景。 */
export function canonicalizePath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}
