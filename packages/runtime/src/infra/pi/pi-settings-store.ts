/**
 * PiSettingsStore — settings.json 的唯一读写层（D17 收口 + P0-1 + D1a/D1b 跨进程写治理）。
 *
 * 背景：settings.json 是 pi 的配置文件（pi 读取它，路径 <dataDir>/agent/settings.json），
 * 无法拆分成多个文件（pi 只认一个 schema/路径）。写方有两类进程：
 *   - taiji runtime（本模块的调用方：model 域经 pi-provider-store、extension 域经
 *     IExtensionSettings port、skills 投影经 pi-skill-paths）
 *   - pi 子进程（rpc 面落盘写点仅 set_auto_retry 无条件 persist；set_model /
 *     set_thinking_level 是会话级切换不落盘——persist 是 options 条件分支且 rpc 入口
 *     不传，pi 0.84.4 rpc-mode.js:367-374/:390、agent-session.js:1252-1261/:1358-1366）
 *
 * 本模块是 settings.json 的**单一所有者**：
 *   - 唯一读写点：read() / write() / updateSettingsFields()，模块外不直接碰文件。
 *   - 分区：每个域只经自己的字段读写，物理上同一个文件，逻辑上各管各的 key。
 *
 * 🔒 跨进程锁（D1a，integrity-hardening.md §3.1；协议已在 /tmp/w1-probe 探针验证）：
 * updateSettingsFields 的 RMW 全程持统一 mkdir 锁 @zhushanwen/pi-file-lock/core
 * （磁盘协议与 pi 内嵌 proper-lockfile 兼容；lockfile 路径 <settings.json>.lock，
 * 与 pi 同一把锁）。pi 侧真实锁形态（实装 0.84.1 settings-manager.js
 * acquireLockSyncWithRetry，设计期已 read 源码核实）：
 *   - lockSync(path, { realpath: false })，ELOCKED 时 CPU 自旋 20ms × 最多 10 次
 *     （总等待 ≤200ms）后**抛错放弃本次保存**；
 *   - 仅文件存在才加锁；无自定义 stale（proper-lockfile 默认 10s）——pi 崩溃持锁时
 *     锁残留，pi 自己的自旋预算内等不到 stale 夺取，即 pi 不自愈。
 *
 * 不对称安全性论证（为何 taiji 设 stale 30s、pi 侧如上，协议仍正确且更优）：
 *   ① 互斥正确性只依赖「同一 lockfile 文件 + 双方都先取锁再写」——retries/stale
 *      差异不影响互斥，只影响等待策略与崩溃恢复；
 *   ② stale 30s 的语义是「锁 mtime 超 30s 视为持锁者已死，可夺取」。两个临界区都是
 *      毫秒级同步读改写（探针实测 taiji 临界区 p99=1ms/max=2ms），30s ≫ 最坏持锁时长，
 *      stale 实际触发的唯一场景就是持锁者崩溃——正是要恢复的场景；
 *   ③ taiji 的 stale 夺取会顺带清掉残留锁，此后 pi 写入恢复正常——taiji 的 stale 让
 *      **双方**都自愈（探针 SIGKILL 场景验证：夺取后 pi 形态写方 1ms 内取到锁）；
 *   ④ 双向等待预算对称成立：taiji 重试预算 ~1s ≫ pi 毫秒级临界区，pi 等待预算 200ms ≫
 *      taiji 毫秒级临界区。注意该点依赖「taiji 临界区毫秒级」契约（mutator 禁 I/O，
 *      持锁范围 = 读文件 + mutator + atomicWrite）——探针的契约外压力场景
 *      （taiji 持锁 150ms）会让 pi 放弃保存，契约是 load-bearing 的。
 *
 * 字段域 merge（D1b）：写回时只覆盖 scope 声明的顶层 key，其余 key 取锁内最新读——
 * 进程内「分区靠调用方自觉」的历史约定升级为 API 强制（mutator 误改他域字段会被丢弃）。
 *
 * disabled-packages.json 是 taiji 自己的文件（pi 不读），不在本 store 管辖（C4 单独收口）。
 *
 * 🔒 三层架构：本模块属 infra（直接碰文件系统），services 经 port 访问，不直接 import 本模块。
 */

import { JsonStore } from '../../utils/json-store.js'
import { withFileLockSync, type SyncFileLockOptions } from '../../utils/file-lock.js'
import { getSettingsPath } from './pi-paths.js'

/**
 * settings.json 的完整 schema（pi 认的形状）。
 * model 域与 extension 域的字段都在这里，分区由 updateSettingsFields 的 scope 强制。
 */
export interface PiSettings {
  // ── model 域（pi-provider-store 管理）──
  defaultProvider?: string
  defaultModel?: string
  defaultThinkingLevel?: string
  enabledModels?: string[]
  // pi 侧 UI 偏好字段：不在 taiji 侧 SCOPE_FIELDS.model 写域（taiji 无写入方，pi 自写），
  // 由字段域 merge 的「其余 key 取锁内最新读」保住 pi 的最新值不被 taiji 写回覆盖
  hideThinkingBlock?: boolean
  skills?: string[]
  // ── extension 域（extension-service 管理）──
  packages?: string[]
  extensions?: string[]
  // ── retry 域（pi-retry-settings 管理）──
  // 透传类型：pi 侧 schema 可含未知子字段且可能为坏值（D3/D7 容错），结构由消费方
  // pi-retry-settings 解析，store 不做形状假设。
  retry?: unknown
  // ── pi 其他未知字段（透传，不破坏）──
  [key: string]: unknown
}

/**
 * 字段域声明（D1b）：调用方对自己负责的顶层 key 的显式声明。
 * 写回时只覆盖 scope 声明的 key，其余 key 取锁内最新读。
 * 字段域定义（覆盖 pi 实际写的全部字段，含 pi setModel 落盘的 defaultProvider，
 * 见 cli/commands.ts 磁盘格式注释互证）：
 *   - model     = defaultProvider / defaultModel / defaultThinkingLevel / enabledModels
 *   - skills    = skills（discovery 投影专写）
 *   - extension = packages（extension-service 域）
 *   - retry     = retry（LLM 重试配置域，pi-retry-settings 管理；域内嵌套键级
 *     merge 见 pi-retry-settings 的 D3 规则）
 *   - full      = 全部。**白名单仅一个调用点**：pi-maintenance.ts 启动迁移
 *     （无并发 pi 进程窗口）。新代码禁止使用 full scope（review checklist 项，
 *     见 docs/architecture/data-source-registry.md 跨进程文件登记表）。
 */
export type SettingsFieldScope = 'model' | 'skills' | 'extension' | 'retry' | 'full'

/** 各 scope 覆盖的顶层字段（full 走全量，不在此表）。 */
const SCOPE_FIELDS: Record<Exclude<SettingsFieldScope, 'full'>, readonly string[]> = {
  model: ['defaultProvider', 'defaultModel', 'defaultThinkingLevel', 'enabledModels'],
  skills: ['skills'],
  extension: ['packages'],
  retry: ['retry'],
}

/**
 * settings.json 存储：read-through（TTL 缓存 + ENOENT 容错）+ atomicWrite。
 * schema guard（必须是 object）放进 deserialize 钩子。
 */
let settingsStore = createSettingsStore(getSettingsPath())

/**
 * 锁参数覆盖（仅测试用，如把重试预算压到几十 ms 快速验证 fail-fast）。
 * 生产保持 file-lock.ts 的默认值（stale 30s / 25ms / 1s，探针验证过）。
 */
let lockOptions: SyncFileLockOptions = {}

function createSettingsStore(path: string): JsonStore<PiSettings> {
  return new JsonStore<PiSettings>(path, {}, {
    ttlMs: 3_000,
    deserialize: (raw): PiSettings => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        console.warn(`[pi-settings-store] ${path} schema 不匹配，使用 fallback`)
        return {}
      }
      return raw as PiSettings
    },
  })
}

/**
 * 覆盖 settings.json 路径（仅测试用）。生产不应调用。
 * 重建 store 实例并清空缓存，确保后续读拿到新路径的文件。
 */
export function setSettingsPath(path: string): void {
  settingsStore = createSettingsStore(path)
}

/** 覆盖锁参数（仅测试用）。传 {} 恢复默认。 */
export function setSettingsLockTimingForTest(opts: SyncFileLockOptions): void {
  lockOptions = opts
}

/** 当前 settings.json 路径（getSettingsPath() 或测试覆盖值）。 */
export function getActiveSettingsPath(): string {
  return settingsStore.getPath()
}

/** 失效缓存（外部改了文件后调用）。 */
export function invalidateSettingsCache(): void {
  settingsStore.invalidate()
}

/**
 * 读取 settings.json（带 3s 缓存）。
 * 模块外的「读」统一经此函数；缓存让高频读（getDefaultModel 等）不每次触盘。
 */
export function readSettings(): PiSettings {
  return settingsStore.read()
}

/**
 * 写入 settings.json（全量覆盖，刷新缓存）。**不持跨进程锁**——生产写路径必须走
 * updateSettingsFields（锁内 RMW + 字段域 merge）；本函数仅供测试直接摆盘，
 * 当前无生产调用方。
 */
export function writeSettings(settings: PiSettings): void {
  settingsStore.write(settings)
}

/**
 * settings.json 的跨进程写锁（D1a）。参数与 pi 侧的对照、不对称安全性四点论证
 * 见模块头注释与 utils/file-lock.ts。
 */
function withSettingsLock<T>(fn: () => T): T {
  return withFileLockSync(getActiveSettingsPath(), fn, lockOptions)
}

/**
 * 锁内同步 read-modify-write + 字段域 merge（D1a + D1b）。
 *
 * 时序：取锁（ELOCKED busy-wait ~25ms/次，预算 ~1s，耗尽 fail-fast）→ 锁内失效缓存
 * 重读最新文件（吃进 pi 并发写）→ mutator 改深拷贝 → 按 scope merge → atomicWrite →
 * 释放锁（finally）。
 *
 * @param scope 调用方声明负责的字段域。写回时只覆盖 scope 内的顶层 key（mutator 对
 *   scope 外 key 的修改会被丢弃——API 强制分区），其余 key 保留锁内最新读的值。
 *   full 仅限 pi-maintenance 启动迁移白名单。
 * @param mutator 接收当前 settings 的深拷贝，原地修改自己 scope 内的字段。
 *   **契约：mutator 内禁止任何 I/O、await、嵌套 updateSettingsFields**（纯内存改字段；
 *   同步持锁上下文里做 I/O 会拉长临界区挤压 pi 的 200ms 预算，嵌套取锁必然死等预算）。
 */
export function updateSettingsFields(scope: SettingsFieldScope, mutator: (settings: PiSettings) => void): void {
  withSettingsLock(() => {
    // 锁内重读最新（绕过 3s TTL 缓存——缓存值可能早于取锁，基于它写回会丢并发方修改）
    settingsStore.invalidate()
    const latest = readSettings()
    const draft: PiSettings = JSON.parse(JSON.stringify(latest))
    mutator(draft)
    writeSettings(scope === 'full' ? draft : mergeScopeFields(scope, latest, draft))
  })
}

/** 只把 draft 中 scope 声明的字段叠加到锁内最新读上（其余 key 以最新读为准）。 */
function mergeScopeFields(scope: Exclude<SettingsFieldScope, 'full'>, latest: PiSettings, draft: PiSettings): PiSettings {
  const merged: PiSettings = JSON.parse(JSON.stringify(latest))
  for (const field of SCOPE_FIELDS[scope]) {
    // draft 无该 key（mutator delete 或本就不存在）→ 从落盘结果中移除，
    // 支持 clearEnabledModels 的「物理删除字段」语义（与从未设置不可区分）
    if (field in draft) {
      merged[field] = draft[field]
    } else {
      delete merged[field]
    }
  }
  return merged
}
