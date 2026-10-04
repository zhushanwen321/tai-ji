// apps/electron/scripts/dev-instance-lib.mjs
//
// dev-instance.mjs 的可测纯函数层（MF-8 守卫测试的加载面；C-build-08 装配器）。
// CLI 本体只保留参数解析 / 真实 fs / process.exit 编排，判定逻辑全部落本模块：
//   - fnv1a / deriveParams：worktree 名 → 端口段 + 数据目录（同名单参稳定）
//   - buildDevEnv：装配 env（剥泄漏变量 + 端口/数据目录统一注入）
//   - 模板复制过滤谓词 + ensureInstanceDir（--fresh 重建语义，io 可注入）
// 修改派生算法/泄漏清单必须同步 __tests__/dev-instance.test.mjs（端口联动是
// C-build-08 的事故类：端口/数据目录静默错配 → 验收证据绑错 worktree）。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const DEV_DATA_PARENT = path.join(os.homedir(), '.taiji-dev')
export const INSTANCES_DIR = path.join(DEV_DATA_PARENT, 'instances')
export const TEMPLATE_DIR = path.join(os.homedir(), '.taiji-dev.template')

/**
 * --data-dir 值域：DEV_DATA_PARENT 树内严格子路径（<homedir>/.taiji-dev/<suffix>）。
 * 刻意不收 homedir 直下的兄弟目录形态（~/.taiji-dev-xxx）——test-guard fs-guard 白名单
 * 是 ~/.taiji-dev 前缀匹配（test-guard/fs-guard-impl.ts allowedRootVariants），树内目录
 * 天然被测试防线覆盖，兄弟目录会整目录落在防线之外；且一棵 .taiji-dev 树好清理。
 * main 侧采信判定在 utils/dev-data-dir.ts resolveDevDataDir（树内含树根即采信）；
 * 本谓词不含树根——树根本体由 resolveCustomDataDir 保留目录拒绝兜住（--fresh 不可删
 * 它），两处判定独立演化、非镜像，改动各自带测试。
 */
export function isWithinDevDataParent(p, devDataParent = DEV_DATA_PARENT) {
  const resolved = path.resolve(p)
  return resolved.startsWith(devDataParent + path.sep)
}

/**
 * 解析并校验 --data-dir CLI 入参：落在 DEV_DATA_PARENT 树内的绝对路径。
 * 非法值抛带恢复指引的 Error（错误 → 权威源 → 重试闭环）；等于保留目录
 * （DEV_DATA_PARENT 本体 / instances 目录）同样拒绝——--fresh 会整目录删除，
 * 保留目录是既有实例布局的祖先，不可作为实例数据目录。
 *
 * @returns 绝对路径（path.resolve 归一化）
 */
export function resolveCustomDataDir(value, opts = {}) {
  const devDataParent = opts.devDataParent ?? DEV_DATA_PARENT
  const instancesDir = opts.instancesDir ?? path.join(devDataParent, 'instances')
  if (!value) {
    throw new Error('[dev-instance] --data-dir 需要显式路径参数')
  }
  const resolved = path.resolve(value)
  if (!isWithinDevDataParent(resolved, devDataParent)) {
    throw new Error(
      `[dev-instance] --data-dir 必须落在 ${devDataParent} 目录之内（如 ${devDataParent}/my-experiment）: ${resolved}\n` +
        `  值域约束原因：test-guard fs-guard 白名单与路径守卫按 ${devDataParent} 前缀放行，树外目录会绕过测试防线；` +
        `禁止指向真实数据目录 ~/.taiji。`,
    )
  }
  if (resolved === devDataParent || resolved === instancesDir) {
    throw new Error(
      `[dev-instance] --data-dir 不可指向保留目录（${devDataParent} 或 ${instancesDir}）——--fresh 会整目录删除\n` +
        `  恢复动作：改用 ${devDataParent}/<自定义子目录>，或不传 --data-dir 走默认实例派生。`,
    )
  }
  return resolved
}

/** workspace AGENTS.md「Dev 与子进程环境变量隔离 MANDATORY」泄漏清单。
 *  TAIJI_AGENT_DATA_DIR 不在列——装配器对它覆盖注入（实例隔离权威来源）。
 *  互引（场景域分化，勿互混）：引擎 spawn 面的另一份剥除清单 =
 *  subagent-engine-sdk env.ts `ENGINE_ENV_DENY_LIST`（镜像 shared SSOT，已退役
 *  RELAY_STD* 三键——引擎侧写入方已清零）；本清单面向 dev 装配链路，RELAY_STD*
 *  仍剥（dev 宿主进程环境防泄漏口径独立于引擎 spawn 面）。 */
export const LEAK_ENV_KEYS = [
  'ELECTRON_RUN_AS_NODE',
  'TAIJI_SUBAGENT_RELAY_STDIN',
  'TAIJI_SUBAGENT_RELAY_STDOUT',
  'TAIJI_SUBAGENT_RELAY_STDERR',
]

// ── 模板配置面（白名单制：只复制这些顶层条目，其余一律不进模板/实例）──────────
// agent/（pi agent 目录，PI_CODING_AGENT_DIR = <dataDir>/agent，v2 方案 B 布局）是
// 「配置+运行时状态」混合体，整目录复制但排除运行时子目录（TEMPLATE_DIR_EXCLUDES）。
export const TEMPLATE_TOP_FILES = [
  'config.json', 'config.toml', 'pi-presets.json', 'model-db.json',
  'provider-catalog-overlay.json', 'proxy-config.json', 'projects.json', 'recent-workspaces.json',
]
export const TEMPLATE_TOP_DIRS = ['agent', 'npm', 'plugins', 'skills', 'agents', 'secrets']
// 混合目录内的运行时状态子目录（会话/记录/调度状态/日志），永不进模板
export const TEMPLATE_DIR_EXCLUDES = [
  'subagents', 'records', 'scheduler', 'workflow-state', 'token-stats', 'cache-ratio', 'logs', 'sessions',
]

// ── 实例参数派生 ──────────────────────────────────────────────────

/** FNV-1a 32bit：稳定（同输入同输出）、无依赖、分布均匀 */
export function fnv1a(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/** worktree 名 → 三端口段 + 数据目录（同名单参稳定；不同名三段互不重叠——
 *  vite/cdp 段取 hash 不同字节位，runtime offset 步进 10 段内不重叠）。 */
export function deriveParams(name, instancesDir = INSTANCES_DIR) {
  const h = fnv1a(name)
  return {
    name,
    vitePort: 1420 + (h % 300),
    cdpPort: 9222 + ((h >>> 8) % 300),
    portOffset: 100 + ((h >>> 16) % 40) * 10,
    dataDir: path.join(instancesDir, name),
  }
}

// ── env 装配 ──────────────────────────────────────────────────────

/** 装配子进程 env：剥泄漏变量 + 端口/数据目录统一注入（vite/electron/runtime/
 *  loadURL 四点一致；不尊重外部碎片注入——要定制实例名用 TAIJI_DEV_INSTANCE_NAME）。
 *  baseEnv 显式传参（默认收 process.env 的快照），纯函数无隐藏输入。 */
export function buildDevEnv(p, baseEnv = process.env) {
  const env = { ...baseEnv }
  for (const k of LEAK_ENV_KEYS) delete env[k]
  env.TAIJI_AGENT_DATA_DIR = p.dataDir
  env.TAIJI_AGENT_PORT_OFFSET = String(p.portOffset)
  env.TAIJI_VITE_PORT = String(p.vitePort)
  env.TAIJI_CDP_PORT = String(p.cdpPort)
  env.TAIJI_VITE_DEV_URL = `http://localhost:${p.vitePort}`
  return env
}

// ── 模板复制 ──────────────────────────────────────────────────────

/** 运行时状态条目判定：rel 为空（被复制根自身）恒放行；其余按 basename 命中
 *  TEMPLATE_DIR_EXCLUDES 即排除（任意深度命中名字，不含路径形态区分）。 */
export function isRuntimeStateEntry(rel) {
  if (!rel) return false
  return TEMPLATE_DIR_EXCLUDES.includes(path.basename(rel))
}

/** 过滤复制：排除运行时状态子目录（任意深度）。 */
export function copyTreeFiltered(src, dst) {
  fs.cpSync(src, dst, {
    recursive: true,
    filter: (entry) => !isRuntimeStateEntry(path.relative(src, entry)),
  })
}

// ── 实例目录（--fresh 重建语义；io 可注入供测试用 tmp 目录） ────────

/**
 * 确保实例目录就绪：安全断言（只允许 instances/ 直属子目录）→ --fresh 清空重建 →
 * 缺失时从模板整树复制。io.exit/fail 注入后不直接触碰 process（测试可控）。
 *
 * @returns true = 目录已就绪（新建或本就存在）；fail 注入抛出时不可达。
 */
export function ensureInstanceDir(p, fresh, opts = {}) {
  const instancesDir = opts.instancesDir ?? INSTANCES_DIR
  const templateDir = opts.templateDir ?? TEMPLATE_DIR
  const log = opts.log ?? (() => {})
  const fail = opts.fail ?? ((msg) => { throw new Error(msg) })
  const resolved = path.resolve(p.dataDir)
  // 安全断言：--fresh 只允许删 instances/ 直属子目录或 DEV_DATA_PARENT 树内目录
  // （后者 = --data-dir 显式指定的实验目录，值域已由 resolveCustomDataDir 收敛且
  // 保留目录——DEV_DATA_PARENT 本体 / instances——在解析期即被拒绝），防误删任意路径
  const inInstances = resolved.startsWith(instancesDir + path.sep)
  const inDevParent = isWithinDevDataParent(resolved, opts.devDataParent ?? DEV_DATA_PARENT)
  if (!inInstances && !inDevParent) {
    fail(`[dev-instance] 实例目录越界（须在 ${instancesDir} 下或 --data-dir 值域内）: ${resolved}`)
    return false
  }
  if (fresh && fs.existsSync(resolved)) {
    fs.rmSync(resolved, { recursive: true, force: true })
    log(`[dev-instance] --fresh 已清空实例目录: ${resolved}`)
  }
  if (fs.existsSync(resolved)) return true
  if (!fs.existsSync(templateDir)) {
    fail(`[dev-instance] 模板不存在: ${templateDir}\n先执行 dev-instance.mjs init-template`)
    return false
  }
  fs.cpSync(templateDir, resolved, { recursive: true })
  log(`[dev-instance] ✅ 实例目录已从模板创建: ${resolved}`)
  return true
}
