/**
 * IInstaller 的 infra 实现 —— 封装 npm 安装（纯 Node.js，不依赖 npm CLI）+ git clone。
 *
 * 🔒 归属（R3c2，三层架构）：infra/installers/，实现 services/ports.ts 的 IInstaller。
 * npm registry HTTPS 调用 + git 子进程 spawn 是外部系统调用，归属 infra。
 * ExtensionService 经此 port 执行安装/卸载，不直接 spawn git 或调 npm-installer 函数。
 *
 * npm 部分委托给同目录的 npm-installer.ts 独立函数（installPackage/uninstallPackage/
 * installDependencies）；git clone 从 extension-service.ts 迁入（R3c2）。
 */
import { execFileSync } from 'node:child_process'
import type { IInstaller, DepsInstallFailure } from '../../services/ports/installer.js'
import { buildOutboundChildEnv } from '../spawn-env.js'
import {
  installPackage,
  uninstallPackage,
  installDependencies,
  fetchLatestVersion,
} from './npm-installer.js'

const GIT_CLONE_DEFAULT_TIMEOUT = 120_000

// git(git-remote-https/libcurl) 消费确凿的标准代理键全集。收编 C-proc-09 后子进程 env 以
// 入站白名单基座构建（ENV_WHITELIST_PREFIXES 不含任何 PROXY 键，已核对 constants.ts），
// 不显式 forward 则用户代理环境（git clone GitHub 为 extension 安装主场景）直接不可用。
// 键集与 main 侧 update/proxy-config.ts 既有消费对齐（大小写双形），补齐 ALL_PROXY/
// NO_PROXY 属 libcurl 标准族而非顺手扩清单。
const GIT_PROXY_ENV_KEYS = [
  'HTTPS_PROXY', 'https_proxy',
  'HTTP_PROXY', 'http_proxy',
  'ALL_PROXY', 'all_proxy',
  'NO_PROXY', 'no_proxy',
] as const

/** 从父 env 快照提取代理键（有值才带，undefined 键天然不入 extras）。
 * 导出供 shell-runner / git-executor 复用：这三个出站点（clone / fetch / shell 脚本
 * 内嵌 git+pnpm）共享同一 git 代理消费面，键集分叉会造成「clone 走代理而 fetch 不走」
 * 的隐性不一致。 */
export function pickProxyExtras(parentEnv: Record<string, string | undefined>): Record<string, string> {
  const extras: Record<string, string> = {}
  for (const key of GIT_PROXY_ENV_KEYS) {
    const value = parentEnv[key]
    if (value !== undefined) extras[key] = value
  }
  // SSH_AUTH_SOCK：git@… ssh remote 的 ssh-agent 认证通道（OpenSSH 标准消费）。
  // 值守卫：仅在父 env 已设置时转发，不凭空注入。
  if (parentEnv.SSH_AUTH_SOCK !== undefined) extras.SSH_AUTH_SOCK = parentEnv.SSH_AUTH_SOCK
  return extras
}

/** 版本检查默认超时 15s——比 install 的 60s 更快失败（轻量 metadata 查询不应长时间挂起）。 */
const VERSION_CHECK_DEFAULT_TIMEOUT = 15_000

export class NpmGitInstaller implements IInstaller {
  async installNpm(pkgName: string, nodeModulesDir: string, opts?: { timeout?: number }): Promise<void> {
    // npm-installer 抛 NpmInstallError（含 code 字段）。service 经结构化类型读取 err.code，
    // 不 import NpmInstallError 具体类（依赖倒置）。
    await installPackage(pkgName, nodeModulesDir, opts ? { timeout: opts.timeout } : undefined)
  }

  async uninstallNpm(name: string, nodeModulesDir: string): Promise<void> {
    await uninstallPackage(name, nodeModulesDir)
  }

  async installDeps(dir: string): Promise<{ failed: DepsInstallFailure[] }> {
    return installDependencies(dir)
  }

  async installGit(url: string, destDir: string, timeout?: number): Promise<void> {
    // execFileSync prevents command injection (no shell). Throws on non-zero exit.
    // env 经出站契约构建器组装（C-proc-09 收编）：白名单基座过滤父 env + deny 兜底剥
    // TAIJI_AGENT_PACKAGED / TAIJI_RUNTIME_TOKEN；extras 经 pickProxyExtras forward 代理键
    // 与 SSH_AUTH_SOCK（git@… ssh remote 的 ssh-agent 认证通道，值守卫：仅在父 env
    // 已设置时转发）。自有键零注入——clone 输入只有 argv（url + destDir）。
    execFileSync('git', ['clone', '--depth', '1', url, destDir], {
      stdio: 'pipe',
      timeout: timeout ?? GIT_CLONE_DEFAULT_TIMEOUT,
      env: buildOutboundChildEnv({ parentEnv: process.env, extras: pickProxyExtras(process.env) }),
    })
  }

  async getLatestVersion(pkgName: string, timeout?: number): Promise<string> {
    return fetchLatestVersion(pkgName, timeout ?? VERSION_CHECK_DEFAULT_TIMEOUT)
  }

}
