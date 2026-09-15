/** 修复 GUI 启动时的残缺 PATH + 补齐 ambient 云凭证 env（spec §7 / wave-env-check）。 */

/**
 * [HISTORICAL] 背景：Electron 从 Dock/Finder 启动时，macOS LaunchServices 给的 PATH
 * 是最小值（典型 `/usr/bin:/bin:/usr/sbin:/sbin`），不含 `~/.local/bin`、`~/.cargo/bin`、
 * `/opt/homebrew/bin` 等用户级 bin。这个残缺 PATH 经 buildSafeEnv 白名单（PATH 在白名单内
 * 被保留但不补全）→ runtime → pi 一路原样传递，pi 的 bash 工具找不到用户安装的 CLI（uv 等）。
 *
 * 修复方式：用用户登录 shell（`$SHELL -ilc 'env'`）读取完整环境，
 * 在 shell PATH 比当前 PATH 更长时覆盖 process.env.PATH。
 * 后续 buildSafeEnv 自然把完整 PATH 传递到 pi，一处修复全链路受益。
 *
 * 自实现而非引 shell-env/fix-path 包：核心逻辑就是 spawnSync + 解析 KEY=VALUE，
 * 引包要同步改 package.json deps + vite.config.main.ts external + electron-builder.yml files
 * + preflight-check.sh，碰打包链路代价过大（规则 #12）。
 */
import { spawnSync } from 'node:child_process'
import { AMBIENT_ENV_NAMES } from '@taiji/shared'

/** spawnSync 超时（ms）——用户 shell 配置异常时防卡死 */
const SHELL_ENV_TIMEOUT = 5000

/** 合法环境变量名：字母/下划线开头，后跟字母/数字/下划线 */
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * 从登录 shell 读取完整环境，补全 process.env.PATH + 补齐 ambient 云凭证变量。
 *
 * 合并策略（spec §7「不能 blind overwrite process.env 已有值」）：
 * - PATH：只在 shell PATH 比当前 PATH 更长时覆盖（既有安全策略不变）
 * - ambient 变量（AMBIENT_ENV_NAMES）：shell 有值且当前未设置/空 → 补齐；当前已有值 → 保留（不覆盖用户显式配置）
 *
 * 任何失败（无 $SHELL、spawnSync 失败、超时）均不修改 process.env（fail-safe）。
 */
export function fixShellEnv(): void {
  // Windows GUI 应用从注册表读取 PATH，通常完整，跳过
  if (process.platform === 'win32') return

  const shell = process.env.SHELL
  if (!shell) return

  const result = spawnSync(shell, ['-ilc', 'env'], {
    timeout: SHELL_ENV_TIMEOUT,
    encoding: 'utf8',
  })

  // 非零退出、超时、无输出 → 不修改
  if (result.status !== 0 || !result.stdout) return

  const shellEnv = parseEnvOutput(result.stdout)

  const shellPath = shellEnv.PATH
  if (shellPath) {
    const currentPath = process.env.PATH ?? ''
    // 只在 shell PATH 更长时覆盖（安全策略）
    if (shellPath.length > currentPath.length) {
      process.env.PATH = shellPath
    }
  }

  // ambient 云凭证变量：只补缺失（shell 有值且当前未设置/空），不覆盖已有值。
  // GUI 启动时 LaunchServices 最小环境缺这些变量（google-vertex/amazon-bedrock 的 env 型凭证检测不到），
  // 补齐后 pi 子进程经 ENV_WHITELIST_PREFIXES 白名单（具体变量名已追加）透传。
  for (const name of AMBIENT_ENV_NAMES) {
    const shellValue = shellEnv[name]
    if (shellValue === undefined) continue
    const currentValue = process.env[name]
    if (currentValue === undefined || currentValue === '') {
      process.env[name] = shellValue
    }
  }
}

/** @deprecated 改名 fixShellEnv（wave-env-check：现在也补 ambient env）。保留别名兼容 main.ts 历史调用。 */
export function fixPathEnv(): void {
  fixShellEnv()
}

/**
 * 解析 `env` 命令输出为 Record<string, string>。
 * 只认 `KEY=VALUE` 格式的行，跳过 motd/fortune 等污染输出。
 */
function parseEnvOutput(stdout: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of stdout.split('\n')) {
    const eqIndex = line.indexOf('=')
    if (eqIndex <= 0) continue
    const key = line.slice(0, eqIndex)
    if (!ENV_KEY_PATTERN.test(key)) continue
    env[key] = line.slice(eqIndex + 1)
  }
  return env
}
