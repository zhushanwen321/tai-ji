import { RuntimeServer } from './transport/server.js'
import { SessionService } from './services/session/session-service.js'
import { GenStatsService } from './services/session/gen-stats-service.js'
import { createSessionDeliveryRegistry } from './services/session/session-delivery-registry.js'
import { createCompletionBackflow } from './services/session/completion-backflow.js'
import { fanOutSettled } from './services/session/agent-settled-fanout.js'
// D4（rename-session-three-modes）：session-renamed 扇出处理体（label 回写 + 整表广播）。
import { createSessionRenamedHandler } from './services/session/session-rename-fanout.js'
import { ConfigService } from './services/config-service.js'
import { AuthService } from './services/auth/auth-service.js'
import { AuthStorage } from './services/auth/auth-storage.js'
import { ProviderCredentialResolver } from './services/auth/provider-credential-resolver.js'
import type { IProviderCredentialResolver } from './services/ports/provider-credential-resolver.js'
import { PresetService } from './services/preset-service.js'
import { ModelService } from './services/model-service.js'

import { BASE_PORT, MAX_PORT } from '@xyz-agent/shared'
import { getDataDir } from '@xyz-agent/shared/paths'
import { initLogger, closeLogger, logger, captureMemorySnapshot, formatMemoryWatermarkLine, MEMORY_WATERMARK_INTERVAL_MS } from './infra/logger.js'
// u1b（crash-forensics-and-watchdog D1）runtime 台账单例。初始化是组合根职责（与
// initLogger 同形态：模块级单例 + 未初始化 no-op）——不初始化则 getCrashJournal()
// 恒返回 no-op，pi-respawn / message-bus 守卫 / session 生命周期的全部 runtime 侧
// 事件静默丢弃（crashes/runtime.jsonl 永不创建）。close 挂点属 shutdown 链（u7c）。
import { initCrashJournal, closeCrashJournal } from './infra/crash-journal.js'
import { isContainedStreamError } from './infra/system/uncaught-policy.js'

import { ProcessManager } from './infra/pi/process-manager.js'
import { getProviderConfig, clearProviderApiKey, initProviderCredentialResolver, cleanLeakedPackages, sanitizeInvalidProviders } from './infra/pi/pi-provider-store.js'
import { getExtensionsDir, getNpmDir, getTmpDir, getProviderExtrasPath, getPiAgentDir } from './infra/pi/pi-paths.js'
import { getPiGlobalAgentDir, syncBundledResources, warnLegacyPiLayout } from './infra/pi/pi-maintenance.js'
import { PiConfigStore } from './infra/pi/pi-config-store.js'
import { PiSessionStore } from './infra/pi/session-store.js'
import { ModelApiDiscoverer } from './infra/model-api-discoverer.js'
import { ModelConnectionTester } from './infra/model-connection-tester.js'
import { NpmGitInstaller } from './infra/installers/npm-git-installer.js'
import { NpmPluginInstaller } from './infra/installers/plugin-installer-adapter.js'
import { ExtensionResolver } from './infra/installers/extension-resolver.js'
import { PiExtensionSettings } from './infra/pi/pi-extension-settings.js'
import { PiRetrySettings } from './infra/pi/pi-retry-settings.js'
import { EventAdapter } from './infra/pi/event-adapter.js'
import { FileChangeDiffAdapter } from './infra/pi/file-change-diff-adapter.js'
import { EventInterpreter, applySessionOccupancyTransition } from './services/session/event-interpreter.js'
import { join, resolve, isAbsolute } from 'node:path'
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import { ExtensionService } from './services/extension-service.js'
import { SkillRegistry } from './services/skill-registry.js'
import { ReloadOrchestrator } from './services/session/reload-orchestrator.js'
import { PluginRegistry } from './services/plugin-service/plugin-registry.js'
import { PluginService } from './services/plugin-service/plugin-service.js'
import { GitService } from './services/git-service.js'
import { GitExecutor } from './infra/git-executor.js'
import { GitStateService } from './services/git/git-state-service.js'
import { GitInfoReader } from './infra/system/git-info-reader.js'
import { ShellRunner } from './infra/shell-runner.js'
import { WorktreeService } from './services/worktree/worktree-service.js'
import { TerminalService } from './services/terminal/terminal-service.js'
import { QuotaService } from './services/quota-service.js'
import { FileService } from './services/file-service.js'
import { getSkillDirs } from './infra/pi/discovery-store.js'
import { expandHome } from './utils/path-utils.js'
import { HandoffService } from './services/handoff-service.js'
// MessageBus（wave:bus-core 产物）：per-session 消息广播核心。
// wave:runtime-wiring 在组合根创建单例并注入到 SessionService（session 级消息单通道走
// bus.publish——wave:perf-w09 D1-2 删双写后唯一通道）+
// RuntimeServer（subscribe/unsubscribe RPC handler + ConnectionManager.onClose → unsubscribeAll）。
// 保留 re-export 供外部消费（renderer-subscribe wave 等可能 import 类型）。
import { MessageBus, DEFAULT_OUTBOUND_FRAME_GUARD_OPTIONS } from './services/message-bus/message-bus.js'
export { MessageBus } from './services/message-bus/message-bus.js'
export type { BusClient, SessionBusState } from './services/message-bus/types.js'
import { getAppVersion } from './services/plugin-service/plugin-version-checker.js'
import { FsExecutor } from './infra/fs-executor.js'
import { RecentWorkspacesStore } from './services/workspace/recent-workspaces-store.js'
import { ProjectStore } from './services/project/project-store.js'
import { ImportService } from './services/session/import-service.js'
import { WorkspaceService } from './services/workspace/workspace-service.js'
import { WorkspaceDetector } from './services/worktree/workspace-detector.js'
// D8-1（perf W29）：后台初始化序列（listen 后执行）——独立模块承载使「migrateBuiltin →
// autoUpgrade 顺序」可 spy 断言（06 §5 门禁），组合根只负责构造与注入。
// resolveReclaimConfig（u3b，idle-pi-reclamation D4）：reaper 三旋钮 env 解析。
import { runStartupBackgroundInit, resolveReclaimConfig } from './services/startup-background-init.js'
// u5（crash-forensics-and-watchdog D3）：reattach 编排 + 孤儿收殓完成 promise 交付回调。
import { runStartupReattach } from './services/startup-reattach.js'
// u6（crash-forensics-and-watchdog D4）：内存看门狗——60s heap 采样环 + 两级阈值 +
// memory-relief 动作点。resolveWatchdogConfig：Gate W 武装门与三旋钮 env 解析。
import { startWatchdog, resolveWatchdogConfig } from './infra/watchdog.js'
import type { WatchdogHandle } from './infra/watchdog.js'
export { startWatchdog, resolveWatchdogConfig } from './infra/watchdog.js'
export type { WatchdogHandle, WatchdogOptions, WatchdogSample, WatchdogStatus } from './infra/watchdog.js'
// u7c（crash-forensics-and-watchdog D5）：滚动重启编排（推迟判定/上限/硬升级/T-30s 预告/
// 状态机）+ shutdown 步骤打点面（SHUTDOWN_STEP_SEQUENCE 是打点序列 SSOT）。
import { startRollingRestart, resolveRollingRestartConfig, shutdownStep } from './services/session/rolling-restart.js'
import type { RollingRestartHandle } from './services/session/rolling-restart.js'
export {
  startRollingRestart,
  resolveRollingRestartConfig,
  shutdownStep,
  SHUTDOWN_STEP_SEQUENCE,
  ENV_ROLLING_RESTART_DEFER_LIMIT_MS,
  ENV_WATCHDOG_FORCE_PCT,
  DEFAULT_ROLLING_RESTART_DEFER_LIMIT_MS,
} from './services/session/rolling-restart.js'
export type {
  RollingRestartHandle,
  RollingRestartOptions,
  RollingRestartBroadcastType,
  RollingRestartBroadcastPayload,
  ShutdownStepName,
} from './services/session/rolling-restart.js'
// u7c：滚动重启计划内退出码（D5 ④；SSOT 在 shared，main 侧 PLANNED_EXIT_CODE 是同值转发）。
import { RUNTIME_PLANNED_EXIT_CODE } from '@xyz-agent/shared'
// u17（设计 §6.12）：spawn 清单读侧在 infra SSOT（读写同模块）；组合根注入给 services 层
// （D6c port 纪律——reap/startup-background-init 不直接 import infra）。
import { readSpawnMarkerList } from './infra/pi/spawn-markers.js'
// A1-2（provider-config-quota 架构）：models.json 寄生字段 → config/providers.json 迁移。
// 挂载薄包装在独立小模块 run-extras-migration.ts（失败语义 + 返回值契约可单测，
// 组合根 import 即执行 main() 不可直测）；此处 readExtrasWithFallback 供 QuotaService 双读。
import { readExtrasWithFallback } from './services/migration/provider-extras-migration.js'
import { runProviderExtrasMigration } from './services/migration/run-extras-migration.js'
import { migrateProviderEnabledToWhitelist } from './services/migration/legacy-provider-migration.js'
import { XyzProviderStore } from './services/provider-extras-store.js'
// E-2（subagent-realtime-channel §4）：relay 基建——socket server + 子进程注册表 +
// tee 翻译层。纯新增模块，经 messageBus.publish 广播 tee 帧；env 注入在
// process-manager（getRelaySpawnEnv，与 server 激活状态联动）。
import { initRelayServer, deinitRelayServer, getActiveRelayRegistry } from './infra/relay/relay-server.js'
// u3b（idle-pi-reclamation D2/D4/D6）：空闲 pi 回收装配原语——ReclaimSeat 占座单例 +
// startIdlePiReaper 周期判定循环（DI 形态，依赖在下方 wiring 段组装）。
import { ReclaimSeat, startIdlePiReaper } from './services/session/idle-pi-reaper.js'
import type { IdlePiReaperHandle, ReclaimExemptions } from './services/session/idle-pi-reaper.js'
import { reapSessionBackgroundTasks } from './services/session/background-task-reaper.js'
import { toErrorMessage } from './utils/errors.js'
// W8 宿主接线：runtime 协议客户端的自持引擎实例 dispose 钩子（idle 5min 复用的
// 回收面之外，进程退出的兜底回收——设计 §3.6 退出钩子落点）。
import { disposeRuntimeEngineClients } from './services/session/subagent-engine-history.js'

function parseArgs(): { port: number; projectRoot?: string; builtinPluginsDir?: string } {
  // eslint-disable-next-line no-magic-numbers -- argv[0] is node, argv[1] is script
  const args = process.argv.slice(2)
  const portOffset = Math.max(0, Math.min(parseInt(process.env.XYZ_AGENT_PORT_OFFSET ?? '0', 10) || 0, MAX_PORT - BASE_PORT))
  let port = BASE_PORT + portOffset
  let projectRoot: string | undefined
  let builtinPluginsDir: string | undefined
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && i + 1 < args.length) {
      const parsed = parseInt(args[i + 1], 10)
      if (isNaN(parsed)) {
        console.error(`[runtime] invalid --port value: ${args[i + 1]}`)
        process.exit(1)
      }
      port = parsed
    } else if (args[i].startsWith('--port=')) {
      const parsed = parseInt(args[i].split('=')[1], 10)
      if (isNaN(parsed)) {
        console.error(`[runtime] invalid --port value: ${args[i].split('=')[1]}`)
        process.exit(1)
      }
      port = parsed
    } else if (args[i] === '--project-root' && i + 1 < args.length) {
      projectRoot = args[i + 1]
    } else if (args[i].startsWith('--project-root=')) {
      projectRoot = args[i].split('=')[1]
    } else if (args[i] === '--builtin-plugins-dir' && i + 1 < args.length) {
      builtinPluginsDir = args[i + 1]
    } else if (args[i].startsWith('--builtin-plugins-dir=')) {
      builtinPluginsDir = args[i].split('=')[1]
    }
  }
  return { port, projectRoot, builtinPluginsDir }
}

/**
 * 解析 WS auth token（S1-W1，spec §3.3 D4）：优先 env XYZ_RUNTIME_TOKEN（Electron 主进程
 * spawn 时注入），缺失时 fallback 读 <dataDir>/runtime-token 文件（CLI / 脚本消费的通道）。
 * 两者都缺失 → 返回 null（fail-closed：ConnectionManager 拒绝全部 WS 连接）。
 *
 * 独立函数而非内联：解析链与 fail-closed 语义是传输安全的关键路径，后续 D4 校验期
 * 单测可直接 import 此函数探针（env 注入 / 文件注入 / 双缺失三态）。
 */
function resolveRuntimeToken(): string | null {
  const envToken = process.env.XYZ_RUNTIME_TOKEN
  if (envToken && envToken.trim().length > 0) return envToken.trim()
  try {
    const fileToken = fs.readFileSync(join(getDataDir(), 'runtime-token'), 'utf-8').trim()
    if (fileToken.length > 0) return fileToken
  } catch (error) {
    // token 文件不存在/不可读 → 落到下方 fail-closed warning（正常 dev 直跑场景，
    // scripts/verify-*.sh 会显式注入 env 或写 token 文件）。
    // debug 级（prod info 过滤）：文件不存在是常态路径不刷屏，dev 排查权限类失败时可见
    console.debug('[runtime] read <dataDir>/runtime-token failed:', error)
  }
  console.warn('[runtime] WS auth token unavailable (XYZ_RUNTIME_TOKEN env / <dataDir>/runtime-token both missing) — fail-closed: ALL WebSocket connections will be rejected')
  return null
}

// ── u5b-runtime-forensics D6-②：runtime 内存水位定时器 ──────────────────
// 每 5 分钟一行（rss/heapUsed/heapTotal/external + 活跃 session 数 + pi 进程数），
// 走既有 logger（runtime-<date>.log）。E2 事故（7 session 连坐 SIGTERM）无法归因的
// 直接缺口就是无水位序列——A8 验收断言「runtime 日志有 5 分钟间隔水位行」。
//
// timer 句柄刻意做成模块级可取消形态：u8（pi respawn）将改写本文件的 shutdown 序列，
// 届时直接调 stopMemoryWatermarkTimer() 接入新清理链，不需要重构本段。
let memoryWatermarkTimer: NodeJS.Timeout | undefined

/** 停止内存水位定时器（shutdown / u8 改造 shutdown 序列时的取消入口）。幂等。 */
export function stopMemoryWatermarkTimer(): void {
  if (memoryWatermarkTimer !== undefined) {
    clearInterval(memoryWatermarkTimer)
    memoryWatermarkTimer = undefined
  }
}

// ── u6（crash-forensics-and-watchdog D4）：内存看门狗句柄 ─────────────────
// 句柄做成模块级可取消形态（对齐上方水位定时器先例）：u7c 将改写本文件的 shutdown
// 序列（D5 退出链「以 index.ts 为准逐行继承」），届时直接调 stopWatchdog() 接入清理链。
let watchdogHandle: WatchdogHandle | undefined

/** 停止内存看门狗（shutdown / u7c 改造 shutdown 序列时的取消入口）。幂等。 */
export function stopWatchdog(): void {
  watchdogHandle?.stop()
  watchdogHandle = undefined
}

// ── u7c（crash-forensics-and-watchdog D5）：滚动重启编排句柄 ─────────────────
// 句柄做成模块级可取消形态（对齐上方水位定时器/看门狗先例）：shutdown 首步
// cancelRollingRestart（D5 退出链「取消推迟定时器是 shutdown 首步」——推迟等待中的
// runtime 收到 app 级 SIGTERM 时不得继续执行滚动重启）。
let rollingRestartHandle: RollingRestartHandle | undefined

/** 取消滚动重启推迟/预告定时器并复位状态机（shutdown 首步收口）。幂等。 */
export function cancelRollingRestart(): void {
  rollingRestartHandle?.cancel()
  rollingRestartHandle = undefined
}

/**
 * 启动内存水位定时器（组合根 listen 成功后调用一次）。
 * unref：水位打点是纯观测面，不得阻止进程自然退出（shutdown 显式 clearInterval 是
 * 第一道，unref 是不阻塞退出路径的兜底）。
 */
function startMemoryWatermarkTimer(
  getActiveSessions: () => number,
  getPiProcesses: () => number,
): void {
  stopMemoryWatermarkTimer() // 幂等防御（重复调用不产生双定时器）
  memoryWatermarkTimer = setInterval(() => {
    const sample = {
      ...captureMemorySnapshot(),
      activeSessions: getActiveSessions(),
      piProcesses: getPiProcesses(),
    }
    // 单行水位行（human grep）+ meta（机器消费同源数值），writeLogEntry 保证单行落盘
    logger.info(formatMemoryWatermarkLine(sample), sample)
  }, MEMORY_WATERMARK_INTERVAL_MS)
  memoryWatermarkTimer.unref?.()
}

/**
 * sd-u5/u6 共用：组合根 agentSettledListeners 多播列表的订阅装配（add + 返回退订函数）。
 * sessionDelivery（U5 send 排队）与 completionBackflow（U6 完成回流）同一列表、同一语义。
 */
function subscribeAgentSettledIn(
  listeners: Set<(sessionId: string) => void>,
): (cb: (sessionId: string) => void) => () => void {
  return (cb) => {
    listeners.add(cb)
    return () => { listeners.delete(cb) }
  }
}

async function main(): Promise<void> {
  const { port, projectRoot, builtinPluginsDir } = parseArgs()
  const effectiveRoot = projectRoot ?? process.cwd()
  // perf W29（D8-1）启动耗时分解探针（06 §5 m-7）：listen 前各段打点，
  // 输出进日志文件供 D8 价值评估（基线实测：getPiVersion 1.1-1.3s 主导 listen 延迟）。
  const tStart = performance.now()

  // 日志持久化（架构约定 #4）：组合根最早期初始化 + monkey-patch console。
  // 必须在所有 service 创建前（runtime 内 ~140 处裸 console.log 经 patch 自动落盘）。
  // [HISTORICAL] handoff 2026-07-04 P1「pi 静默卡死」——之前日志只在终端，关掉即丢，
  // 无法事后诊断 pi 发了什么事件。initLogger 后所有 console.* 自动 tee 到
  // <dataDir>/logs/runtime-YYYY-MM-DD.log。
  initLogger(getDataDir())

  // u1b（crash-forensics-and-watchdog D1）：runtime 台账单例初始化。位置与时序对齐上方
  // initLogger（同处于组合根最早期、数据目录 getDataDir() 可用性已由 initLogger 验证）；
  // 必须在任何 service 可能 append 之前——pi-respawn 的 auto-respawn 四态、message-bus
  // 守卫的 frame-truncated/registry-miss、session 生命周期事件全部经 getCrashJournal()
  // 单例落 `<dataDir>/logs/crashes/runtime.jsonl`。幂等；目录创建失败降级 no-op
  // （旁路设施故障不放大为调用链故障，见 crash-journal.ts 契约）。第二参注入 logger
  // 单例作留痕出口（write 失败 / endAndAwait 超时 warn/error）——crash-journal 不
  // import logger，logger → crash-journal 单向（循环依赖零容忍，C-comm-01）。
  initCrashJournal(getDataDir(), logger)

  // S1-W1：token 解析在 initLogger 之后（fail-closed warning 落盘）、server 构造之前。
  const runtimeToken = resolveRuntimeToken()

  // Infrastructure
  const pm = new ProcessManager(effectiveRoot)

  // Transport layer
  const server = new RuntimeServer(port, projectRoot, runtimeToken)

  // MessageBus 单例（wave:runtime-wiring）：per-session 消息广播核心。
  // 在 server 构造后、setServices 前创建并注入——server 的 ConnectionManager.onDisconnect
  // 回调经 setMessageBus 拿到引用，setServices 装配 sessionHandler 时读 server.messageBus。
  // 默认 ring 容量 1000（bus-core DEFAULT_RING_CAPACITY，D4 决策）。
  //
  // u8 接线（实施计划偏差表 D1 移交项，u4a-outbound-guard 遗留）：push 通路（MessageBus
  // 第二参）与 reply 通路（下方 server.setServices 的 replyGuardResolver）共用同一
  // resolver 实例——出站帧超限的占位文案（formatTruncationNote / formatReplyOversizeMessage）
  // 从「（见 runtime 日志）」升级为携带 session 文件实路径（错误规格表「出站 reply/push 超
  // 32MB」两行的恢复指引）。闭包引用 sessionService 声明在下方（createAdapter/
  // completionBackflow 同款「先声明后构造、调用时恒就绪」模式——publish/reply 仅发生在
  // server.start 后，构造期无调用窗口）。解析链：活跃 session 直读内存 sessionFilePath；
  // 否则扫盘（findScannedSession）兜底冷 session。实现抛错被守卫吞掉退化为 null 占位
  // （resolvePathSafe，不打断消息流转）。
  const resolveSessionFilePath = (sessionId: string): string | null | undefined =>
    sessionService.getSession(sessionId)?.sessionFilePath ?? sessionService.findScannedSession(sessionId)?.filePath
  // 首参缺省 = DEFAULT_RING_CAPACITY（1000）。D1（u8）：resolver 见上方 const（两通路共用）；
  // resolver 抛错被 resolvePathSafe 吞掉退化为「（见 runtime 日志）」占位，不打断消息流转。
  const messageBus = new MessageBus(undefined, { ...DEFAULT_OUTBOUND_FRAME_GUARD_OPTIONS,
    resolveSessionFilePath })
  server.setMessageBus(messageBus)

  // ── Phase 1: create all service instances (no cross-service deps at construction time) ──

  // 打包模式 bundled 资源同步（skills/extensions，全仓唯一 bundled skills 同步点，
  // 打包版全新安装依赖）+ 旧布局残留探测（WARN 指引 scripts/migrate-pi-layout-v2.mjs，
  // 不迁移不阻塞启动）。
  // [HISTORICAL] 此处曾为一次性目录迁移的启动调用位——迁移使命终结后退役删除
  // （v9 布局对齐，设计 §6.11），残留交手工迁移脚本 + WARN 指引承接。
  // D8-1（perf W29）：同步段保持 listen 前——「首次配置读取前」硬约束（06 §3.3 证据）。
  const tSyncMigrations = performance.now()
  syncBundledResources()
  warnLegacyPiLayout()
  // 清理 settings.json.packages 中泄漏到 pi 全局目录的相对路径项（架构约定 #1 隔离保障）
  cleanLeakedPackages()
  // PiConfigStore 提前构造（纯委托无副作用）：下方 A1-2 迁移经 port 读写 models.json。
  const configStore = new PiConfigStore()
  // XyzProviderStore：config/providers.json 唯一读写者（组合根单例，下方注入迁移/ConfigService/QuotaService）。
  const providerExtrasStore = new XyzProviderStore(getProviderExtrasPath())
  // step2（provider 级 enabled → enabledModels 白名单）先于 A1-2：A1-2 会剥除 enabled
  // 字段，先跑保住启停语义。后台序列的 migrateProviderConfig 会再调 step2，幂等 no-op。
  await migrateProviderEnabledToWhitelist(configStore)
  // A1-2：models.json 寄生字段（quota/authMethod/models[].enabled）剥离迁入 providers.json。
  // 顺序约束：必须在 sanitizeInvalidProviders 之前——sanitize 对非 catalog 空壳条目（八字段
  // 全缺，如 setProvider 仅传 quota/name 的历史形态）直接删除，先迁移才能把其寄生数据保入
  // providers.json。迁移失败不阻塞启动（warn + 下次重试，幂等），失败语义收在
  // run-extras-migration.ts 薄包装（返回值契约由其单测守卫）。
  const extrasMigration = await runProviderExtrasMigration(configStore, providerExtrasStore)
  // 清洗 models.json：① 空串键剥除（pi minLength:1 全集）+ ② catalog 条目的 provider 级键处置
  // （api 一律剥除 / baseUrl 按 extras 网关标记）→ 再做既有空壳判定/修复（设计 D2 顺序契约）。
  // 历史背景：空壳 provider（五字段全缺）导致 bundled pi 0.80.3 严格校验时整个 models.json
  // 加载失败（Model not found）。系统 pi 0.83 容错但 bundled 不容错，重装后必现；
  // sanitize 让 xyz-agent 自愈这种脏数据（如外部脚本写入的测试 fixture）。
  // 仅迁移成功后执行（失败时寄生数据未出 models.json，sanitize 会物理删除空壳条目致
  // 寄生数据永久丢失，round 1 review DG#3；门控返回值语义由 run-extras-migration.test.ts 守卫）。
  if (extrasMigration.ok) {
    // 标记读取经注入的同步原语（C-comm-03：infra/pi 层不 import services 实现，设计 D2 审查 R3-3）。
    const sanitizeOutcome = sanitizeInvalidProviders({
      getExtrasSync: (providerId) => providerExtrasStore.getExtrasSync(providerId),
    })
    // D2② 写读错位自愈（写序契约「先写 extras 标记、后写 models.json」的崩溃中间态 =
    // 标记在、models.json 无 baseUrl 键）：清多余标记。锁内写在本 async 阶段执行，
    // 不塞进同步清洗段。标记已被并发清除时短路不调 modify（modify 无内容 diff 守卫，
    // 避免无谓写盘）。
    for (const providerId of sanitizeOutcome.staleGatewayMarkers) {
      if (providerExtrasStore.getExtrasSync(providerId)?.gatewayBaseUrl === undefined) continue
      await providerExtrasStore.modify(providerId, current => {
        const next = { ...current }
        delete next.gatewayBaseUrl
        return next
      })
    }
  }

  const sessionStore = new PiSessionStore()
  const modelSource = new ModelApiDiscoverer()
  // IModelConnectionTester port 的 infra 实现（D-21 端口化）：组合根构造 + 经
  // server.setServices 注入 settingsHandler ctx（transport 不再 value import infra）。
  const connectionTester = new ModelConnectionTester()
  const extensionInstaller = new NpmGitInstaller()
  const extensionResolver = new ExtensionResolver({
    settingsDir: configStore.getPiAgentDir(),
    thirdPartyDir: getExtensionsDir(),
    npmDir: getNpmDir(),
  })
  // IExtensionSettings port 的 infra 实现：经 pi-settings-store 统一读写 settings.json（D17）。
  // 构造时对齐 settings 路径到 pi agent 目录，保证 model 域与 extension 域读写同一文件。
  const extensionSettings = new PiExtensionSettings(configStore.getPiAgentDir())
  // ILlmRetrySettings port 的 infra 实现：settings.json retry 域读写（同 extensionSettings 注装模式）。
  const llmRetrySettings = new PiRetrySettings(configStore.getPiAgentDir())
  const extensionService = new ExtensionService({
    settingsDir: configStore.getPiAgentDir(),
    projectRoot: effectiveRoot,
    installer: extensionInstaller,
    resolver: extensionResolver,
    extensionSettings,
    configStore,
    extensionsDir: getExtensionsDir(),
    npmDir: getNpmDir(),
    tmpDir: getTmpDir(),
  })
  // AuthStorage（OAuth 路径 B）：auth.json 在 pi agent 目录（与 models.json 同路径，与 pi 读取侧一致）。
  // ConfigService 用它做 I9 清理①（setProvider 保存 apiKey 时清 auth.json oauth）+ I8（deleteProvider 清 auth.json）。
  const authStorage = new AuthStorage(join(configStore.getPiAgentDir(), 'auth.json'))
  // D3 链 3 接线（M2c）：凭据解析唯一通道实例 + 模块级 init 注入（检查点 5 首选形态——
  // pi-provider-store 的消费点是模块级函数，构造参数到不了）。
  // 装配序契约：本行位于上方全部迁移/清洗之后、**全部 service 装配与 server.start 之前**，
  // 因此严格早于任何 findValidDefaultModel 调用（默认模型裁定只发生在 server.start 之后的
  // pi spawn / session 激活 / RPC 处理与启动后台初始化里）。resolver 构造无 IO、读取懒发生。
  // authService 在下方才构造（它依赖 configService 与 clearApiKey），此处经闭包延迟引用：
  // resolver 的 sync 腿只碰 authStorage，async 腿（resolveProviderCredential）只在
  // server.start 之后消费，届时 authService 已就绪。
  const providerCredentialResolver: IProviderCredentialResolver = new ProviderCredentialResolver({
    authService: { getCredential: (providerId: string) => authService.getCredential(providerId) },
    authStorage,
    configStore,
  })
  initProviderCredentialResolver(providerCredentialResolver)
  // providerExtrasStore 注入：setProvider 的 authMethod 改写 providers.json（A1-5 写侧切换）。
  // providerCredentialResolver（D3 链 5 接线）：listProviders 的凭据判定经唯一通道批量 sync 版。
  const configService = new ConfigService(effectiveRoot, configStore, authStorage, providerExtrasStore, llmRetrySettings, providerCredentialResolver)
  // ADR-0021 §1 一次性迁移：旧版本 skill 路径存在 settings.json.skills，
  // 首启用时提升为 discovery.json SSOT。幂等：discovery 已有数据则 no-op。
  // D8-1 位置判断（perf W29，06 §5 m-7 结论）：保持 listen 前同步执行——
  // fileService 构造时 allowedReadDirs 读 getSkillDirs()（discovery.json），
  // 迁移后置会让首次升级启动的 skill 容器漏出 file.read 白名单（认知回归）。
  // 成本：幂等 no-op 仅两次 JSON 读，实测 <1ms，非 listen 延迟主导项。
  configService.migrateSettingsSkillsToDiscovery()
  // PresetService（pi-launch-presets 设计 §8.1）：独立 service，与 ConfigService 对称。
  // 依赖 configStore（pi-presets.json 路径推导）+ extensionService（resolve 用 builtin/scanExtensions）。
  // 组合根构造，经 setPresetService 注入 SessionService（与 setConfigService 同模式）。
  const presetService = new PresetService(configStore, extensionService)
  const modelService = new ModelService(modelSource)

  // ── Phase 2: create services that reference other services via closures / deps ──
  // PluginService.deps are all optional and only used at runtime (initialize / event handling),
  // so sessionService can be wired in after construction.
  const configDir = configService.getConfigDir()
  // RecentWorkspacesStore：最近工作区持久化（WriteBackCache 固定 partition 'global'）。
  // configDir 由 configService 动态推导，无硬编码路径（INV-5）。
  const recentWorkspacesStore = new RecentWorkspacesStore(configDir)
  const workspaceService = new WorkspaceService(recentWorkspacesStore, new WorkspaceDetector(fs))
  // ProjectStore：project 列表持久化（D14，2026-08-04 迁 runtime projects.json，
  // 与 recent-workspaces 同模式；前端 localStorage 仅首启迁移源）。
  const projectStore = new ProjectStore(configDir)
  // ImportService：外部 pi 会话导入（import-session U2）。projects 仅用于 importSession 的
  // projectId 存在性校验（D5 import_project_invalid），结构化最小依赖面；getRootDir 供
  // listCandidates 的 rootDir 缺省（D5：pi 全局 sessions 经 getPiGlobalAgentDir 动态推导，
  // 组合根合法 import infra 装配——services 层禁止 value import pi-maintenance，C-comm-03）。
  const importService = new ImportService({
    projects: projectStore,
    getRootDir: () => join(getPiGlobalAgentDir(), 'sessions'),
  })
  // S1-W4（D3）：built-in 插件目录显式注入（主进程 spawn 时传 --builtin-plugins-dir）。
  // 提供时 registry 只扫该目录、不做 cwd 探测（防用户 repo 预置目录冒充 built-in）；
  // 缺失（dev 直跑/测试）时 registry 回退探测链并落 warning。
  const pluginRegistry = new PluginRegistry(effectiveRoot, configDir, builtinPluginsDir)
  const pluginInstaller = new NpmPluginInstaller(join(configDir, 'plugins'))
  const pluginService = new PluginService(pluginRegistry, server, {
    configService,
    modelService,
    configDir,
    pluginInstaller,
    broadcastFn: (type, payload) => server.broadcast({ type: type as 'config.sessions', id: `push_${Date.now()}`, payload } as import('@xyz-agent/shared').ServerMessage),
  })
  // wave:perf-w09（接口收敛 wire 归位）：plugin 的 session 级广播点（plugin:viewUpdate /
  // plugin:uiRequest）接 bus 定向发布。原在 server.setServices 内 wire（wave:perf-w08 的
  // 过渡位置），services 间依赖注入统一归组合根——与下方 sessionService.setMessageBus 同模式。
  pluginService.setMessageBus(messageBus)

  // ── R1 重构：EventAdapter（infra 纯翻译）+ EventInterpreter（service 编排）──
  // adapterFactory closure captures pluginService / sessionService / server by reference.
  // All are already assigned above — no temporal coupling.
  // Note: onContextUpdate also references `sessionService` (assigned below) as a self-reference —
  // the interpreter queries its owning session's data. createAdapter is only called at session
  // creation time, so sessionService is always set by then.
  //

  // GitExecutor + GitStateService：git 状态统一读取基础设施（perf W16，03 D4-1）。
  // 在 fileChangeDiff 之前创建——W18 起 FileChangeDiffAdapter 的采集（snapshotStatus/numstat）
  // 委托 GitStateService；GitService（下方，依赖 sessionService）与 GitMessageHandler 的
  // 写操作失效共享同一实例（in-flight 单飞 + sessionId+cwd TTL 缓存 + 非仓库负缓存）。
  const gitExecutor = new GitExecutor()
  const gitStateService = new GitStateService({ executor: gitExecutor })

  const fileChangeDiff = new FileChangeDiffAdapter(gitStateService)

  // sd-u5（session-delivery）：agent_settled 多播订阅列表。原 onAgentSettled 注入点是
  // flushPendingBashResults 单播（下方 createAdapter 闭包内）；扩展为多播形态——interpreter
  // 注入点仍保持单回调，回调体内先执行原单播腿再分发到本列表（delivery 内核的 settled
  // 边沿唤醒经 sessionDelivery 装配订阅；sd-u6 完成回流检测将挂更多订阅者）。
  // 声明须在 createAdapter 之前（闭包捕获；订阅发生在 sessionService 构造之后，无时序耦合）。
  const agentSettledListeners = new Set<(sessionId: string) => void>()

  // sd-u6（session-delivery）：完成回流编排（design.md §3.1 调用方 C）。子 session（agent-managed）
  // settled / exit → 查 spawnSource+parentAgentSessionId → 经 sd-u5 注册表投父（单例 handle）。
  // 顺序约束：exit 订阅须先于 `new SessionService` 内的 exit 清理腿（removeSessionEntry 删内存态，
  // 按订阅序分发，本腿排前才能读到打标）；getSession/getDelivery 前向引用（createAdapter 同款模式）。
  const completionBackflow = createCompletionBackflow({
    getSession: (sid) => sessionService.getSession(sid),
    subscribeAgentSettled: subscribeAgentSettledIn(agentSettledListeners),
    subscribeSessionExit: (cb) => pm.onSessionExit(cb),
    getSessionOutcome: (filePath) => sessionStore.extractSessionOutcome(filePath),
    getDelivery: (parentSid) => sessionDelivery.getOrCreateDelivery(parentSid),
  })

  const createAdapter = (sessionId: string, send: (msg: import('@xyz-agent/shared').ServerMessage) => void, cwd?: string) => {
    // EventInterpreter 持有业务态（currentMessageId/writeContents/diffChain 帧序三件套）+ 业务回调，
    // 消费 EventAdapter 翻译出的 PiTranslatedEvent[]，执行 hook / diff / 回写 / 路由副作用。
    const interpreter = new EventInterpreter(sessionId, {
      // #8 G1 cwd：注入 session cwd（write 工具 added/modified 判定 + agent_end git 对账用）。
      // SessionService.initializeManagedSession 调用时传入（该处已有 cwd 参数）。
      cwd,
      send,
      fileChangeDiff,
      onExtensionUIRequest: (requestId, sid, method, payload) => {
        server.registerExtensionTimeout(sid, requestId, method, payload)
      },
      // session-manager 请求路由：fire-and-forget 调 server.handleSessionManagerRequest
      //（由 SessionManagerHandler 异步处理并回写 pi response）。
      onSessionManagerRequest: (requestId, sessionId, action, params) => {
        server.handleSessionManagerRequest(requestId, sessionId, action, params)
      },
      onBridgeUIRequest: (requestId, sid, method, data) => {
        server.handleBridgeRequest(sid, requestId, method, data)
      },
      onStatusSetUpdate: (payload) => {
        server.handleStatusSetUpdate(payload)
      },
      onContextUpdate: (sid, ctxData) => {
        // session 级状态单一 owner：context 事件（turn-usage / turn-end / compaction）经
        // SessionService.applyContextUpdate 只做 usage 实例失效（W10 五写点收编；W12 起
        // context.update 广播也退役为快照挂钩发布——payload 全字段来自 usage 实例快照，
        // 事件参数不再进任何 payload）。竞态保护由单一数据源结构保证（见该方法注释）。
        sessionService.applyContextUpdate(sid, ctxData.inputTokens, ctxData.totalTokens)
      },
      // W3：turn_end 单 turn 副作用（原 attachUsageListener turn_end 分支迁移至此，经中间事件链路触发；
      // W1 后 label 持久化移交 pi set_session_name RPC，此处承载 project sidecar 兜底）。
      onTurnUsage: (sid) => sessionService.handleTurnUsageSideEffects(sid),
      // composer-gen-stats（D1/D2）：turn-usage 组装 GenStatsSample 后采样（recordSample 内部
      // 完成落盘 + 映射写 1 + 扩展广播；同步 fire-and-forget 不阻塞事件流）。genStatsService
      // 声明在下方（先于 sessionService 构造后）——createAdapter 仅在 session 创建后调用，
      // 引用恒就绪（与上方 sessionService 自引用闭包同模式）。
      onGenStats: (sid, sample) => genStatsService.recordSample(sid, sample),
      // W3：agent_end 副作用——isGenerating 复位（W1 后 label 直写兜底已随机制删除）。
      // 原 attachUsageListener agent_end 分支迁移至此。不迁移则 session 永远 busy（下条消息被拒）。
      // W4：转发 stopReason 用于 session_end 终态判定（'error'→error，其余→done）。
      onTurnFinalize: (sid, stopReason) => {
        sessionService.handleTurnEndSideEffects(sid, stopReason)
      },
      // D4（rename-session-three-modes 显示侧扇出修复）：session_info_changed 事件到达时
      // ① label 回写（session_info_changed 事件路径唯一写方，toSummary/config.sessions 读
      // 它；label 的 ReplicatedState 实例已撤销，PR #185 MF1）——清名事件（name undefined）
      // 回落 basename(cwd) 派生，对齐 scanner 兜底；② 追加整表广播，行为契约对齐手动
      // rename 先例（session-message-handler 的 handleSessionRename），修复「落库成功但
      // 侧边栏不动」。处理体提取在 session-rename-fanout（本文件 import 即执行 main()
      // 不可直测，agent-settled-fanout 同款先例）。
      onSessionRenamed: createSessionRenamedHandler({
        setLabelCache: (sid, label) => sessionService.setLabelCache(sid, label),
        getSessionCwd: (sid) => sessionService.getSessionCwd(sid),
        broadcastSessionList: () => server.broadcastSessionList(),
      }),
      // W7：标量实例失效接线（延迟解析——interpreter 构造时实例尚未注册，见 opts 类型注释）。
      thinkingLevelState: () => sessionService.getScalarReplicatedStates(sessionId)?.thinkingLevel,
      executeHooks: (hookType, context) => pluginService.executeHooks(hookType, {
        pluginId: '',
        hookType: hookType as import('./services/plugin-service/plugin-types.js').HookType,
        data: { ...context, sessionId },
        timestamp: Date.now(),
      }),
      // [ADR-0047] ping 探测连续 3 次失败（180s）判定 pi 进程真死，触发 abort。
      // 复用 sessionService.abort → message-dispatcher.abort 完整路径（client.abort 成功/失败
      // 均有兜底广播 + 复位 isGenerating）。.catch 兜底防 unhandledRejection
      // （abort 内部已 try/catch 广播终态，此处只防极端异常逃逸）。
      onSilentAbort: ({ sessionId: sid }) => {
        sessionService.abort(sid).catch(() => {})
      },
      // M4 compaction 事件驱动：interpreter 从 compaction_start/end 唯一编排广播（session.compacting /
      // message.compactionSummary / session.compacted）。[session-dead-structural-fixes D2 挂点迁移，
      // u3b] 原此处对三布尔的直写（布尔赋值）改调原语对应行（'compacting-start' /
      // 'compacting-end'）：isCompacting 派生 + occupancy 合并 + state 帧广播原子完成——结构上
      // 消灭「只写布尔不写投影」的残留直写（interpreter #5/#6 的 onOccupancyTransition 通道
      // 调同一原语行，幂等去重）。
      onCompactingStateChange: (sid, v) => {
        const s = sessionService.getSession(sid)
        if (s) applySessionOccupancyTransition(s, messageBus, v ? 'compacting-start' : 'compacting-end')
      },
      // occupancy 挂点接线（session-dead-structural-fixes D2 挂点迁移，u3b）：interpreter 侧
      // 挂点（#2-#6 + turn-end 异常兜底）传封闭转移枚举值，经本闭包写 session 记录——原语
      // 原子完成「合并三维 + 派生三布尔 + 幂等去重 + state 帧广播」（interpreter 不持有全量
      // occupancy，经 session 记录权威聚合，与上方 onCompactingStateChange 同构）。
      onOccupancyTransition: (transition) => {
        const s = sessionService.getSession(sessionId)
        if (s) applySessionOccupancyTransition(s, messageBus, transition)
      },
      // session-trace（A33）：增量腿触发回调——interpreter 的四类触发事件到达后做
      // 追赶式 since 补拉（syncTraceEntries 内部自查 leaf 基线，无基线 no-op；串行链
      // 吸 burst）。自引用闭包与上方 onContextUpdate 同模式（sessionService 构造前仅存引用）。
      onTraceSync: (sid, trigger) => {
        sessionService.syncTraceEntries(sid, trigger)
      },
      // [ADR-0047] ping get_state 进程健康探测（替代事件静默检测）。
      // 延迟解析 client：interpreter 在 session 创建时构造，那时 client 可能尚未 spawn。
      // pm（ProcessManager）在本闭包外已创建，getClient 返回 undefined 时计为一次失败
      // （AC-9），但不抛错——client 偶发未就绪不应让 interpret 批次崩溃。
      pingPi: async () => {
        const client = pm.getClient(sessionId)
        if (!client) return undefined
        return client.getState()
      },
      // W18（data-source-governance P3.1）：自描述 record entry（subagent-record /
      // workflow-record）到达 → 派生缓存失效。sessionService 同
      // thinkingLevelState 的延迟解析模式（createAdapter 闭包先于 sessionService 构造，
      // 调用发生在 session 创建后，引用恒就绪）。
      onRecordEntriesInvalidated: (sid, customType) => {
        sessionService.invalidateRecordEntries(sid, customType)
      },
      // W1（fix-chat-flow-order 探针 ②）：agent_settled（run 级联结束，晚于 pi finally 的
      // bash 落盘 flush）→ dispatcher 按序发布 per-session bash 待落列（D2 双分支延迟）。
      // sd-u5 起多播化：bash flush 是第一条腿（原单播语义不变），其后分发 agentSettledListeners
      // （delivery 内核 settled 边沿唤醒 + sd-u6 回流检测）；逐订阅者隔离 try/catch 收敛在
      // fanOutSettled（agent-settled-fanout.ts，可单测——本文件 import 即执行 main() 不可直测）。
      onAgentSettled: (sid) => {
        sessionService.flushPendingBashResults(sid)
        // [session-dead 2026-09-10] run 级联结束（pi _runAgentPrompt 的 finally 确定性 emit）→
        // 复位 isGenerating。agent_end 在 retry / auto-compaction 续跑时会重发、post-run 尾段
        // 直接 settle 的收尾路径更不含 agent_end——只靠 agent_end 复位会让 processing 分支置的
        // true 残留（幽灵忙碌）。语义与竞态自愈论证见 handleAgentSettledSideEffects 注释。
        sessionService.handleAgentSettledSideEffects(sid)
        fanOutSettled(agentSettledListeners, sid)
      },
    })
    // EventAdapter：纯翻译器，把翻译结果喂给 interpreter 编排。
    // 第三参（background-task-sidebar D2 触发面②，u-runtime-rpc）：后台任务事件旁路——
    // customType background-bash（exit 边沿）与 bash 工具结束（spawn 路径）到达时对
    // watched 集合跑一次变更检测（与 2s 轮询/自写自检共享同一 last-seen，单广播源非第二源）。
    // sessionService 为闭包引用（createAdapter 先于其构造声明，工厂体仅在 session 建立时执行，
    // 引用恒就绪——同下方 onRecordEntriesInvalidated 延迟解析模式）；backgroundTasks 端口由
    // SessionService 构造器恒创建，`?.` 为端口缺省（防御）形态的静默 no-op。
    return new EventAdapter(
      sessionId,
      (events) => interpreter.interpret(events),
      (_sid) => sessionService.backgroundTasks?.checkForChanges(),
      // [定向复审缺陷 2] detach 转调 interpreter.dispose：销毁路径（forceQuit/exit/delete/
      // restore 清场）经 adapter.detach 收口时，清 interpreter 在途 settling 延迟 timer +
      // 置 disposed 短路，防迟到副作用打在同 id restore 重注册的新 session 记录上。
      () => interpreter.dispose(),
    )
  }

  const sessionService = new SessionService(
    pm,
    server,
    createAdapter,
    effectiveRoot,
    extensionService,
    configStore,
    sessionStore,
    // IGitInfoReader：infra 实现（rev-parse 查询 + .git 文件判 worktree + 缓存），注入 session 摘要链。
    // 与 GitExecutor 同为 git 域 infra，但语义不同（窄查询 vs 通用 exec）——故独立 port（services/ports/git-info.ts）。
    new GitInfoReader(),
    workspaceService,
    // messageBus：注入 dispatcher 的 session 级事件通道（wave:perf-w09 D1-2 后单通道——
    // dispatcher 只依赖 publish 抽象，bus.publish 是唯一出口，broker 依赖已随接口收敛删除）。
    messageBus,
  )

  // sd-u5（session-delivery）：delivery 内核的 runtime 装配（design.md §3.1 调用方 B）。
  // sessionId 单例注册表——session-manager 的 send 排队（U5）与完成回流（U6 复用）共用；
  // subscribeSettled 经上方 agentSettledListeners 多播（interpreter onAgentSettled 注入点的
  // 分发腿）；port.send 的 ensureActive → prompt(streamingBehavior) → D7 置位副作用见
  // session-delivery-registry.ts。
  const sessionDelivery = createSessionDeliveryRegistry({
    getSession: (sid) => sessionService.getSession(sid),
    ensureActive: (sid) => sessionService.ensureActive(sid),
    subscribeAgentSettled: subscribeAgentSettledIn(agentSettledListeners),
    recordWorkspace: (cwd) => workspaceService.record(cwd),
    // [A2 D-A2-2] skillNotice 广播通道（deliverText 注入的 notice 发布用）；组合根
    // messageBus 恒就绪，getter 形态与 SessionRecordsDeps 装配同款。
    getMessageBus: () => messageBus,
  })
  // session 销毁（主动删 / 进程退出 / restore 清场全部路径）→ 丢弃该 session 的 delivery
  // 队列与订阅（setOnSessionDestroyed 追加式注册，与 server 的 extension timeout 清理腿并存）。
  sessionService.setOnSessionDestroyed((summary) => sessionDelivery.dispose(summary.id))

  // HandoffService：fast-handoff 编排层。依赖 sessionService（create/sendMessage/abort/getHistory/getSession）
  // + server（IMessageBroker 广播）+ pm（getClient 取源 session pi 句柄）。与 GitService/FileService 同模式
  // （经 server.setServices 注入到 handler），但额外经 onTurnFinalize opt 接到 EventInterpreter（见上方闭包）。
  //
  // BLOCKER 2 / WARNING nextPushId：注入 broadcastSessionList + nextPushId（来自 broker），
  // 与 session-message-handler 的 create/fork/delete/rename 一致。
  // handoffService 经 server.setServices 注入到 handler（session-message-handler.ts）。
  const handoffService = new HandoffService({
    sessionService,
    broker: server,
    broadcastSessionList: () => server.broadcastSessionList(),
    nextPushId: () => server.nextPushId(),
  })

  // ── Phase 3: wire cross-service runtime deps ──
  pluginService.setSessionService(sessionService)
  // GitService：composition root 注入 infra executor（数组参数防注入）+ sessionService（取 cwd）。
  // 经 server.setServices 注入到 GitMessageHandler（git.* 路由）。
  // perf W17（03 D4-4 U2）：gitService.getStatus 收编走 GitStateService（上方已创建，
  // 与 FileChangeDiffAdapter 共享同一实例——file_changes 采集与面板状态读取共享单飞/负缓存）。
  const gitService = new GitService({ sessionService, executor: gitExecutor, stateService: gitStateService })
  // FileService：对称注入 infra FsExecutor（node:fs/promises adapter）+ sessionService（取 cwd 做越界守门）。
  // 经 server.setServices 注入到 FileMessageHandler（file.tree/expand/write.* 路由）。
  // allowedReadDirs：file.read 的 BC-3 白名单（~/.agents/skills、piAgentDir/skills、piAgentDir/npm），
  //   从 configService 算出传入（FileService 不直接依赖 configService，保持单一职责）。
  const piAgentDir = configService.getPiAgentDir()
  const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? ''

  // AuthService（OAuth 路径 B）：编排 device/callback flow 拿 token 写 auth.json。
  // 依赖 authStorage + builtin oauthConfig（configService.listBuiltinProviders）+ broadcast/nextPushId
  // （server/broker）+ clearApiKey（I9 清理②：OAuth 成功清 models.json apiKey，防 both provider 凭据冲突）。
  // 经 server.setServices 注入到 handler（settings-message-handler 的 config.oauthLogin/oauthCancel）。
  const authService = new AuthService({
    authStorage,
    getOAuthConfig: (providerId) => configService.listBuiltinProviders().find(p => p.id === providerId)?.oauthConfig,
    broadcast: (msg) => server.broadcast(msg),
    nextPushId: () => server.nextPushId(),
    // I9 清理②：OAuth 授权成功后清除 models.json apiKey（both provider 切换凭据源，防冲突）。
    // 语义 = 纯删键 RMW（不写空串）——实现提取到 pi-provider-store.clearProviderApiKey
    // 以便落盘断言（本文件不可 import：import 即执行 main()）。
    clearApiKey: clearProviderApiKey,
  })
  // A1-4 收口：auth.json 写入唯一入口 = AuthService.saveCredential。AuthService 依赖
  // configService（getOAuthConfig），构造在 configService 之后——setter 回填（回填前无
  // RPC 处理，server.start 在全部装配后，无窗口期）。
  configService.setCredentialWriter(authService)
  const fileService = new FileService({
    sessionService,
    executor: new FsExecutor(),
    // allowedReadDirs：file.read 白名单。除三个固定目录外，动态合并用户在 discovery.json
    // 配置的 skill 目录（globalPaths，如 ~/.claude/skills）——否则这些 skill 的 SKILL.md
    // 既不在 cwd 内（cwd 守门拒）也不在固定白名单内（白名单拒），两路 file.read 都失败，
    // drawer 误显示「该 skill 无文档正文」。projectPaths（相对 cwd）走 cwd 守门，不需进白名单。
    // expandHome 处理 globalPaths 里 ~/ 开头路径；filter(isAbsolute) 丢弃相对路径（白名单需绝对路径）。
    allowedReadDirs: [
      resolve(homeDir, '.agents/skills'),
      resolve(piAgentDir, 'skills'),
      resolve(piAgentDir, 'npm'),
      ...getSkillDirs()
        .map((d) => expandHome(d))
        .filter((d) => isAbsolute(d))
        .map((d) => resolve(d)),
    ],
  })

  modelService.setServices(sessionService, configService, server)

  // U6（D2② 在线对账接线）：①session 附着触发对账（fire-and-forget，内部降级不阻断附着）；
  // ②drift 事件上报出口——setCapabilityDriftSink 订阅后经全局通道广播
  // 'model:capabilityDrift'（drift 项已同步记 runtime 日志，本帧供前端后续消费）。
  sessionService.setModelCapabilityReconciler((sid) => modelService.reconcileModelCapabilities(sid))
  modelService.setCapabilityDriftSink((drifts) => {
    server.broadcast({ type: 'model:capabilityDrift', payload: { drifts } })
  })

  // 注入 ConfigService 供 getReplaceSystemPrompt 委托（spawn pi 时透传替换系统提示词）。
  sessionService.setConfigService(configService)
  // 注入 PresetService 供 getLaunchPresetOptions 委托（spawn pi 时按 launch preset 构建 args）。
  // 与 setConfigService 同模式（pi-launch-presets 设计 §8.1 + §4.3）。
  sessionService.setPresetService(presetService)
  // 注入 MessageBus（wave:runtime-wiring）：session 级消息（带 sessionId payload）单通道走
  // bus.publish（wave:perf-w09 D1-2 删双写后唯一通道；bus 负责 per-session seq 分配 + ring
  // buffer + 订阅者广播），session 销毁时 removeSessionEntry 调 bus.clearSession。
  // 与 setConfigService 同模式（setter 注入，避免破坏 SessionService 测试调用点）。
  // bus 两条注入通道（构造参数 + 本 setter）组合根都走：构造参数经 SessionService 构造器
  // 传导给 dispatcher；setter 内部同步回填 dispatcher（仅走 setter 路径时保证 dispatcher
  // 不持 undefined bus，见 session-service.setMessageBus）。
  sessionService.setMessageBus(messageBus)

  // ── composer-gen-stats（u3）：GenStatsService 装配（依赖 bus publish 通道 + pm + sessionService；
  // 存储算法 SSOT 在 gen-stats-store.ts，本处只接线）。三件事：
  // ① 映射「清」腿：销毁回调挂 onSessionDestroyedHandlers（removeSessionEntry 汇聚点）；
  // ② 映射「写 2」腿：state_changed 发布后置 tap（session-service 投影专用 bus 视图触发，
  //    固定帧序 MF9：state_changed 同步送达后才重登记+推快照帧）；
  // ③「写 1 + 降级链 + 扩展广播」经 interpreter onGenStats 与 session.getGenStats RPC case
  //    触达（后者经 server.setServices 注入，见下方 optional 对象）。
  const genStatsService = new GenStatsService({
    publish: (sid, msg) => messageBus.publish(sid, msg),
    pm,
    sessionService,
  })
  genStatsService.registerSessionCleanup()
  sessionService.setGenStatsModelSwitchTap((sid, modelKey) => genStatsService.onModelSwitched(sid, modelKey))

  // ── SkillRegistry（W1）：全局 + 项目级 skill 缓存 + chokidar 文件监听 ──
  // 构造在 sessionService 之后（依赖其 getActiveSessionIds/getSessionCwd 窄接口）。
  // initGlobal() 在 server.start 后调（下文），启动期扫描全局 skill 目录挂 watcher。
  const skillRegistry = new SkillRegistry({
    configStore: {
      getSkillPathScopes: () => configService.getSkillPathScopes(),
      getPiAgentDir: () => configService.getPiAgentDir(),
    },
    configDir,
    sessionService,
  })

  // TerminalService：drawer 集成终端的 PTY 生命周期管理（node-pty spawn + per-session 映射）。
  // 声明在生命周期挂钩之前（session 销毁回调引用它，TDZ 要求先声明）。
  // wave:perf-w07（D1-1 / R-05）：发布通道从 broker.broadcast 改为 MessageBus——terminal 三类
  // 消息按 topicOf 分类（data=transient 直传、alive/exit=stream 入 ring）定向推给订阅该 sid 的 ws。
  // publish-only 不叠加 broadcast：terminal.data 无 seq，叠加盲广播会被已订阅 renderer 双 dispatch
  // （终端输出重复渲染），见 TerminalServiceDeps.publish 注释。W09（D1-2）删双写已落地——
  // bus.publish 是 session 级消息唯一通道，publish-only 即终态语义（非过渡态）。
  // Phase 6 接入 configService 读 shell 配置（当前用 $SHELL fallback）。
  const terminalService = new TerminalService({
    publish: (sid, msg) => messageBus.publish(sid, msg),
    configService,
  })

  // ── W5 ReloadOrchestrator：skill 变动 → 受影响 session pi reload（重扫 skill）────
  // 依赖 sessionService 窄接口（isSessionIdle/promptReload/hasSession），故在 skillRegistry 之后构造。
  // 绑定两条链路：
  //   1. skillRegistry.onChange → onSkillChange（skill 变动触发）
  //   2. sessionService message.complete 广播 → onMessageComplete（running session 生成完成消费 pending 队）
  const reloadOrchestrator = new ReloadOrchestrator({ sessionService })
  skillRegistry.onChange((event) => {
    // 既有链路：pi reload（只用 affectedSessionIds 字段）
    void reloadOrchestrator.onSkillChange(event.affectedSessionIds)
    // 新增链路：广播 config.skillCacheInvalidated 让 landing 缓存失效重拉
    server.broadcastSkillCacheInvalidated(event.scope, event.cwd)
  })
  sessionService.setOnMessageComplete((sid) => {
    void reloadOrchestrator.onMessageComplete(sid)
  })
  // R3：session 删除（主动 delete / 进程异常退出）清 pendingReload 残留。
  // Terminal：同步销毁该 session 绑定的 PTY（kill 进程 + 清 ptyMap）。
  sessionService.setOnSessionDelete((sid) => {
    reloadOrchestrator.clearPending(sid)
    terminalService.destroyPty(sid)
  })

  // D8-2（perf W29）：appInfo 惰性——piVersion 先 'unknown'（同步 getAppVersion），
  // getPiVersion 探测完成后 mutate 同对象 + 补发 app.info（下方后台初始化块）。
  // setServices 注入同一对象引用，broker 的 buildAppInfoMsg spread 读到 mutate 后的新值。
  const appInfo: { appVersion: string; piVersion: string } = { appVersion: getAppVersion(), piVersion: 'unknown' }

  // WorktreeService：编排 worktree 创建（bare-workspace / plain-repo 两种模式）。
  // 依赖全注入：GitExecutor（git 子命令）/ ShellRunner（setup 脚本，用 child_process.spawn）/
  // GitInfoReader（当前分支查询）/ ConfigService（worktreeRootDir 配置）/ fs（existsSync，检测 .bare 与目录冲突）。
  // 经 server.setServices 注入到 WorktreeMessageHandler（worktree.create 路由）。
  const worktreeService = new WorktreeService({
    gitExecutor: new GitExecutor(),
    shellRunner: new ShellRunner({ spawn }),
    gitInfoReader: new GitInfoReader(),
    configService,
    fs,
  })

  // QuotaService：Coding Plan 额度查询（hover 触发 + 缓存 + log）。
  // 经 server.setServices 注入到 QuotaMessageHandler（quota.fetch/getCached/refresh/configure 路由）。
  // getProviderInfo：从 providerId 解析 ProviderInfo（baseUrl/name/quota.fetcher），
  // quota.fetcher 优先于 matchQuotaPreset（设计文档 §8.2 + 手动选择 fetcher 需求）。
  // A1-5 写侧切换：quota 配置改落 config/providers.json（providerExtrasStore），
  // providerExists 聚合层判定（catalog 或 custom 均可配置，不再要求 models.json 有条目）。
  // A1-3 读源切换：quota 经 readExtrasWithFallback 双读（providers.json 优先 + models.json
  // 旧寄生字段兜底）；baseUrl/name 仍是 pi 原生语义字段，继续读 models.json。
  // A2-2 凭证源：auth.json 通道注入 AuthService.getCredential（api_key.key / oauth.access，
  // 直读不缓存——pi 侧 refresh 写回后立即读到新值，D6）。
  // models.json 单条目读通道注入 configStore.getProviderConfig（arch-boundary S2：
  // providerExists 默认回退与 readQuotaFallback 兜底经 port 读，消除 services → infra
  // 新增直连；未注入回退仅在单测场景生效）。
  const quotaService = new QuotaService({
    getProviderInfo: (providerId) => {
      const cfg = getProviderConfig(providerId)
      const extras = readExtrasWithFallback(providerExtrasStore, configStore, providerId)
      if (!cfg && !extras?.quota) return undefined
      return { baseUrl: cfg?.baseUrl, name: cfg?.name, quota: extras?.quota }
    },
    providerExtrasStore,
    providerExists: (providerId) => configService.listProviders().some(p => p.id === providerId),
    getAuthCredential: (providerId) => authService.getCredential(providerId),
    getProviderConfig: (providerId) => configStore.getProviderConfig(providerId),
    // D3 链 1 接线（M2c）：api-key 形态的 provider 凭据经唯一通道（secrets 专属 key 段保留在前）。
    providerCredentialResolver,
  })

  // D12（改动 5）：删除链 quota 副产物清理回填——QuotaService 依赖 ConfigService（providerExists /
  // readExtrasWithFallback），构造在 configService 之后，构造期拿不到，故 setter 后置回填
  // （先例 setCredentialWriter）。漏回填不报错但 D12 静默失效（可选注入 = 未注入 no-op），
  // 只有 S14 场景能发现。删除链侧保证只在 extras 条目确认清除后调用（防幽灵标记）。
  configService.setQuotaStateCleaner((providerId) => quotaService.clearProviderState(providerId))

  const tServicesReady = performance.now()
  server.setServices(sessionService, configService, modelService, {
    extension: extensionService,
    plugin: pluginService,
    git: gitService,
    file: fileService,
    workspace: workspaceService,
    appInfo,
    skillRegistry,
    worktree: worktreeService,
    terminal: terminalService,
    quota: quotaService,
    handoff: handoffService,
    preset: presetService,
    auth: authService,
    project: projectStore,
    // D3 链 2 接线（M2c）：settingsHandler ctx 的 discover 凭据回查经唯一通道。
    providerCredentialResolver,
    // D-21 端口化接线：settingsHandler ctx 的测试连接 HTTP 适配器（mode=test 路由）。
    connectionTester,
    // sd-u5：sessionId 单例注册表（上方 createSessionDeliveryRegistry 装配）。
    // 缺席时 server 构造退化实例并 warn（违反单例约束，仅测试装配遗漏场景）。
    delivery: sessionDelivery,
    // 导入 pi 会话（import-session D5/U2）：session.importCandidates / session.import 路由。
    importService,
    // composer-gen-stats（D4）：session.getGenStats 恢复腿 RPC（降级链 + 写 3 回填在 service 内部）。
    genStats: genStatsService,
    // u8（reply 通路对称接线）：reply 超限错误 envelope 的恢复指引携带 session 文件实路径，
    // 与上方 MessageBus（push 通路）共用同一 resolveSessionFilePath resolver 实例。
    replyGuardResolver: resolveSessionFilePath,
  })

  // ── u3b（idle-pi-reclamation）：空闲 pi 进程回收装配 ──
  // 设计与七豁免/占座语义见 docs/design/idle-pi-reclamation.md（已删除，git 可追溯）D2/D3/D4/D6。
  // ReclaimSeat 单例：reaper 判定 / reclaimManagedSession 占座 / ensureActive 让路三处
  // 共享同一互斥状态（D6-2）；reaper 经后台序列 ⑩ 才启动，此前 seat 缺省行为不变。
  const reclaimSeat = new ReclaimSeat()
  sessionService.setReclaimSeat(reclaimSeat)

  // 七类豁免闭包（D2 表序逐一对应，全部只读访问器）。任一命中 = 本拍跳过该候选。
  const reclaimExemptions: ReclaimExemptions = {
    // #1 occupancy 三维非 idle（undefined = 未附着无占用信号，不豁免，与 lifecycle
    // 最终豁免块同款判定）。
    isOccupied: (sid) => {
      const occ = sessionService.getSessionOccupancy(sid)
      return occ !== undefined && (occ.turn !== 'idle' || occ.compacting || occ.bash)
    },
    // #2 有 running 后台任务（失败模式 B 硬约束：回收会让任务被判孤儿杀掉）。
    hasRunningBackgroundTasks: (sid) =>
      sessionService.backgroundTasks.listTasks(sid).entries.some((e) => e.state === 'running'),
    // #3 有在途 relay 子进程（失败模式 C）。registry 由 initRelayServer（listen 后）创建，
    // 此处延迟解析；未激活（测试/降级）= 无在途子进程，方向安全（宁漏不误杀）。
    hasInflightRelayChildren: (sid) => getActiveRelayRegistry()?.hasByMainSessionId(sid) ?? false,
    // #4 handoff 进行中。#5 delivery 内核有排队投递（completion-backflow 回流）。
    hasHandoffInflight: (sid) => handoffService.hasInflightHandoff(sid),
    hasQueuedDeliveries: (sid) => sessionDelivery.hasDeliveryActivity(sid),
    // #6 最近被查看时间戳（undefined = 从未被查看，不豁免——0 是合法 epoch 不可当哨兵）。
    getLastViewedAt: (sid) => sessionService.getSessionLastViewedAt(sid),
    // #7 restore 进行中（回收自身占座由 reaper 经 seat 自查）。
    isRestoring: (sid) => sessionService.isSessionRestoring(sid),
  }

  // 回收执行 = SessionService.reclaimSession → lifecycle 七步最小摘除编排（D3）。
  const reclaim = (sid: string): Promise<boolean> =>
    sessionService.reclaimSession(sid, {
      seat: reclaimSeat,
      // relay 尾扫快照枚举（D3 第 5 步①）：同步单段快照，registry 未激活返回空表。
      listRelayChildrenByMainSession: (s) => getActiveRelayRegistry()?.listTargetsByMainSessionId(s) ?? [],
      // 定向后台任务收殓（D3 第 5 步②）：复用 reaper 单 session 入口，与 removeSessionEntry
      // 触发面同款；路径经 getPiAgentDir 动态推导（禁硬编码）。显式丢弃结果对象
      // （deps 契约 Promise<void>；reap 摘要在函数内部已落日志）。
      reapBackgroundTasks: async (s) => {
        await reapSessionBackgroundTasks(getPiAgentDir(), s)
      },
      // pendingReload 定向清（D3 第 6 步，防御性 no-op）。
      clearPendingReload: (s) => reloadOrchestrator.clearPending(s),
    })

  // reaper handle：保存供 shutdown 收口（tick 定时器已 unref 不阻塞退出，stop 是双保险）。
  let idleReaperHandle: IdlePiReaperHandle | undefined
  const startIdleReaper = (): void => {
    idleReaperHandle = startIdlePiReaper({
      seat: reclaimSeat,
      exemptions: reclaimExemptions,
      // 空闲信号（u1a）：client.lastActivityAt；无 client = 无信号，宁漏不误杀。
      getClientActivity: (sid) => pm.getClient(sid)?.lastActivityAt,
      // 候选枚举：lifecycle 全量活跃键（附着中 session，含公共 session）——回收候选语义
      // 正是「已附着」，已回收条目不在 Map 内天然不再枚举。
      listCandidateSessionIds: () => sessionService.getActiveSessionIds(),
      reclaim,
      // 按拍合并广播（D3 第 7 步）：与 handoffService/authService 同款 broker 广播入口。
      broadcast: () => server.broadcastSessionList(),
      // 三旋钮：shared/constants SSOT 默认值 + XYZ_RUNTIME_PI_RECLAIM_* env 覆盖（D4）。
      ...resolveReclaimConfig(process.env),
    })
  }

  // Graceful shutdown on signals
  // u7c（crash-forensics-and-watchdog D5 退出链）：本序被 SIGINT/SIGTERM/uncaughtException
  // 与滚动重启执行（rollingRestart → exit 86）四源共用，逐行继承既有链只加步骤打点
  // （A4 机械验证继承完整性：每步经 shutdownStep(ShutdownStepName 字面量) 打点，序列
  // SSOT = SHUTDOWN_STEP_SEQUENCE，写错名字 tsc 红）。
  let shuttingDown = false
  const shutdown = async (signal: string, exitCode = 0) => {
    if (shuttingDown) return
    shuttingDown = true
    // u7c（D5 退出链首步）：取消推迟/预告定时器、使滚动重启状态机失效——推迟等待中的
    // runtime 收到 app 级 SIGTERM 时不得继续执行滚动重启；86 执行序内的再入由
    // shuttingDown guard 与编排 executed 标志双重防护。
    shutdownStep('cancel-rolling-restart')
    cancelRollingRestart()
    // D6-②：停水位定时器（shutdown 后不再有水位行）。
    shutdownStep('stop-memory-watermark-timer')
    stopMemoryWatermarkTimer()
    // u6（crash-forensics D4）：停内存看门狗采样环（定时器已 unref，此 stop 是显式
    // 收口双保险——shutdown 后不再有 relief/通知判定拍）。
    shutdownStep('stop-watchdog')
    stopWatchdog()
    // u8（crash-resilience D7-②）：取消全部 pending 自动恢复 timer——必须在下方
    // server.stop（内部 destroyAll 全部 pi 子进程）之前：若取消晚于 destroyAll，shutdown
    // 中途 timer 触发会 spawn 新孤儿 pi（收割器只在下次启动后 5s 跑一次，用户直接退出
    // app 则孤儿无限存活烧 token）。对齐上方 stopMemoryWatermarkTimer 的先取消先例。
    shutdownStep('cancel-pending-respawns')
    sessionService.cancelAllPendingRespawns()
    // u3b（idle-pi-reclamation）：停空闲回收判定循环（若已启动）——shutdown 后不再有
    // 回收拍。timer 已 unref，此 stop 是显式收口双保险（先取消先例同上）。
    shutdownStep('stop-idle-reaper')
    idleReaperHandle?.stop()
    console.log(`\n[runtime] received ${signal}, shutting down...`)
    try {
      shutdownStep('flush-stores')
      recentWorkspacesStore.flushAll()
      projectStore.flushAll()
      // R1：关闭 SkillRegistry 的 chokidar watcher（global + project），防句柄泄漏阻塞退出。
      shutdownStep('dispose-skill-registry')
      skillRegistry.dispose()
      // sd-u6：退订完成回流（settled / exit 两腿）
      shutdownStep('dispose-completion-backflow')
      completionBackflow.dispose()
      // E-2 + W8：relay 优雅关停与引擎协议客户端 dispose **并行**——deinitRelayServer
      // 内部有 3s grace，串行（先 relay 后 dispose）会把引擎进程消失时间拖到 3s 之后，
      // 违反 A11「dispose 发起起算 1s 内引擎进程消失」；并行发起后 dispose 单侧上界
      // 3s（EngineClient dispose 帧超时即杀）+ 聚合上界 3s。先收割自己受托的子进程
      // 与引擎再关传输层（原「先于 server.stop」语义不变）。
      // 落点约束（设计 §3.6）：钩子在 shutdown() 内、与 deinitRelayServer() **并行发起**
      // （dispose 不等 relay 收敛，上两条注释的时序契约）；不用 process.on('exit')
      // （回调不能 await，异步 dispose 会被 process.exit 截断）。
      shutdownStep('deinit-relay-server')
      const engineClientsDisposed = disposeRuntimeEngineClients()
      await deinitRelayServer()
      await engineClientsDisposed
      shutdownStep('server-stop')
      await server.stop()
      // u7c（D5 退出链新增步骤）：引擎池 dispose——zcode appserver 杀链，挂点钉死在
      // server.stop 之后、closeLogger 之前（杀链期间的日志与 stderr tee 要经 logger
      // 落盘，closeLogger 先行则现场丢失）。引擎池的物理宿主在 pi 进程内（registry
      // 是进程级 globalThis 状态）：server.stop 的 destroyAll 向全部 pi 发 SIGTERM →
      // pi 侧 extension 收割钩子 killAllSpawnedChildren 先 disposeEngines（杀 zcode
      // appserver 常驻进程，D6①「SIGTERM 先发会丢 close 帧」顺序由该入口保证）再杀
      // per-record children。runtime 进程注册表当前恒空（无引擎注册），本步骤在场 =
      // 设计钉死的序列位置与打点完整性；未来引擎宿主迁移 runtime 侧时此处是杀链接线点。
      shutdownStep('engine-pool-dispose')
    // eslint-disable-next-line taste/no-silent-catch -- shutdown: best-effort stop, process exits regardless
    } catch (e) {
      console.error('[runtime] error during shutdown:', e)
    }
    // D1 台账 flush（crash-forensics §3.3 D1）：closeCrashJournal 等 runtime.jsonl 的
    // 在途轮转与 WriteStream 缓冲落盘——server.stop→destroyAll 触发的 pi 层 shutdown/
    // deleted 行（#16 计划内排除归因依赖的行）经异步缓冲写入，process.exit 不等待即丢
    // 尾部。挂点在 closeLogger 之前：台账 close 自身的降级日志（轮转失败 warn 等）仍能
    // 经 logger 落盘。幂等（重复 close no-op），未初始化时直接 resolve。
    shutdownStep('close-crash-journal')
    await closeCrashJournal()
    // D10-1（perf W30）：退出 flush——closeLogger 现在需要 await（end 主日志 + 全部 pi
    // session 写流并等待落盘）。process.exit 立即终止进程不等待异步 IO，必须在 flush
    // 完成后才退出，否则缓冲窗口内尾部日志丢失（pi 卡死诊断证据，见 logger.ts 头部）。
    shutdownStep('close-logger')
    await closeLogger()
    process.exit(exitCode)
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  // [HISTORICAL] unhandledRejection 兜底：防止 async 异常逃逸导致 Node.js 进程崩溃。
  // 之前 server.ts 的 ws.on('message') 回调中没有 await handleMessage()，
  // 导致 async 错误变成 unhandled rejection，Node.js 16+ 默认行为是终止进程。
  // 虽然 server.ts 已修复（加了 .catch），这里作为最后防线保留。
  process.on('unhandledRejection', (reason) => {
    console.error('[runtime] *** UNHANDLED REJECTION *** (should not happen):', reason)
  })

  // [HISTORICAL] uncaughtException 兜底（D6 入口防御）：进程级最后防线。
  // 与上方 unhandledRejection handler 的分工：unhandledRejection 捕获「未被 await
  // 的 async 异常」（Promise 断头链），记录后进程继续运行（有明确的后续处理边界，
  // 单条 rejection 不破坏运行时一致性）；uncaughtException 捕获「同步回调链的异常
  // 逃逸」（WS/Worker/IPC 消息回调 throw 等），Node 默认行为是进程立即退出——
  // runtime 一崩全部 session 的 pi 子进程失去管理。宿主层（plugin-host* 的
  // safeDispatchHostMessage）已挡第一道；这里兜住所有其他来源：记日志 + 走优雅
  // shutdown（flush 日志与 session 数据），退出码 1 让 supervisor 感知异常退出。
  // 不尝试带伤继续服务：uncaught 后运行时一致性无法保证，可观测 + 有序退出是
  // 本防线的目标。
  //
  // 分级护栏（2026-09-04 整机崩溃事故）：已识别的连接/流级错误码（EPIPE 等，见
  // uncaught-policy）只可能产自流操作且影响限于单连接，log-continue 不升级为整机
  // shutdown——即便未来出现源头修复遗漏的写点，也不再拿全部 session 陪葬。其余
  // 错误维持原语义（shutdown + exit 1）。
  process.on('uncaughtException', (err) => {
    if (isContainedStreamError(err)) {
      console.warn('[runtime] stream-level exception contained (no shutdown):', err)
      return
    }
    console.error('[runtime] *** UNCAUGHT EXCEPTION *** (attempting graceful shutdown):', err)
    void shutdown('uncaughtException', 1)
  })

  // D8-1（perf W29）：先 listen（端口即就绪）——迁移/探测等无 listen 前依赖的后置项
  // 全部移入下方后台初始化块（06 §3.3 D8-1）。listen 前仅剩：同步迁移 + 服务构造 + setServices。
  const tListen = performance.now()
  try {
    await server.start()
  } catch (err) {
    // 与 ConnectionManager.start reject 的分工：传输层对 listen 失败（EADDRINUSE 等）只
    // reject（对齐 callback-server.ts 先例，可被测试捕获/换端口重试，不杀进程）；
    // 进程退出决策归组合根——生产语义不变：端口被占即快速失败 exit(1)，但打可操作
    // 排查指引（指向恢复动作：查占用 → 关实例 → 重启），而非静默退出。
    const code = err instanceof Error && 'code' in err ? (err as NodeJS.ErrnoException).code : undefined
    if (code === 'EADDRINUSE') {
      console.error(`[runtime] fatal: 端口 ${port} 被占用（EADDRINUSE）——可能已有另一个 xyz-agent 实例在运行。`)
      console.error(`  排查: lsof -i :${port} 查看占用进程；关闭其他实例后重启。原始错误: ${toErrorMessage(err)}`)
    } else {
      console.error('[runtime] fatal: WS listen failed:', err)
    }
    process.exit(1)
  }
  console.log('[runtime] ready')

  // ── E-2：relay socket server（listen 后、后台初始化前）──────────────────
  // 早建早发现权限问题（设计 §4.1）。fatal 语义：实例冲突（残留 socket 被活实例持有）
  // 与 listen 失败都退出——覆盖/复用会劫持他人注册表。staged 脚本缺失与执行器探针
  // 失败不在此层（getRelaySpawnEnv 降级为不注入 env，relay 整体不激活，回落现状）。
  try {
    await initRelayServer({
      projectRoot: effectiveRoot,
      publish: (sid, msg) => messageBus.publish(sid, msg),
    })
  } catch (err) {
    console.error('[runtime] fatal: relay server init failed:', err)
    process.exit(1)
  }
  // ── u5b-runtime-forensics D6-②：内存水位定时器启动 ──────────────────
  // listen 成功后启动（依赖 sessionService/pm 均已装配）。activeSession 数含公共
  // session（getActiveSessionIds 全量 lifecycle 键），pi 进程数是 ProcessManager 托管
  // 的 RpcClient 数（relay 子进程不在此列，其取证走 relay-registry 决策日志）。
  startMemoryWatermarkTimer(
    () => sessionService.getActiveSessionIds().length,
    () => pm.size,
  )

  // ── u7c（crash-forensics-and-watchdog D5）：滚动重启编排启动 ─────────────
  // 挂点 = listen 后、与 watchdog/reattach 同区（编排先例：startup-reattach）。Gate W
  // armed 门与 watchdog 共用同一 resolveWatchdogConfig 结果（XYZ_RUNTIME_WATCHDOG_ARMED
  // 默认 off）——off 时编排零动作（onMemoryPressure 对 critical 直接忽略，B2：u6 语义
  // 延伸到重启编排）。执行 = onExecute → 既有完整 shutdown 序 + 专用退出码 86（D5 ④：
  // supervisor 按码识别 planned 立即重启零退避零计数）；退出序首步取消本编排推迟定时器。
  // status provider 注入 server：rollingRestart.status 只读 RPC（renderer 重连/刷新后
  // 拉取恢复横幅——「broadcast 时序竞争」教训：持续态必须可拉取，deferred/forced/
  // countdown 广播只作加速显示）。
  const watchdogConfig = resolveWatchdogConfig(process.env)
  const rollingRestartHandleLocal = startRollingRestart({
    armed: watchdogConfig.armed,
    ...resolveRollingRestartConfig(process.env),
    listSessionIds: () => sessionService.getActiveSessionIds(),
    // relay 在途面（D5 判定源 ②）组合根接线：registry 句柄归 index.ts（reclaim 豁免 #3
    // 同款延迟解析），services 层不 value import 有状态 IO infra。
    relayInFlight: () => getActiveRelayRegistry()?.size ?? 0,
    onExecute: () => { void shutdown('rollingRestart', RUNTIME_PLANNED_EXIT_CODE) },
    broadcast: (type, payload) => server.broadcast({ type, payload } as import('@xyz-agent/shared').ServerMessage),
  })
  rollingRestartHandle = rollingRestartHandleLocal
  server.setRollingRestartStatusProvider(() => rollingRestartHandleLocal.getStatus())

  // ── u6（crash-forensics-and-watchdog D4）：内存看门狗启动 ─────────────
  // 挂点 = listen 后、与水位定时器同区（同为内存观测面；设计 D4 未指明 listen 前后，
  // 取「listen 后与 background-init 并行」的端口先就绪序）。武装门 Gate W 默认 off
  // （XYZ_RUNTIME_WATCHDOG_ARMED）——off 时纯观测：采样环照跑补全水位数据，relief 与
  // renderer 通知不执行（设计 §3.2 方案 B）。
  // u7c 接线两处：① onRelief = 清全部历史重建缓存（D4 可回收物 ①，偏差 #28①——
  // renderer LRU 收紧 ② 走 broadcast → renderer useMemoryPressure 通道，动作本体随
  // u7d 落地）；② broadcast 出口同拍喂滚动重启编排（critical 档 = D5 决策输入，warn
  // 档编排侧忽略）。stop 挂 shutdown 序（上方）。
  watchdogHandle = startWatchdog({
    ...watchdogConfig,
    onRelief: () => {
      sessionService.clearHistoryRebuildCache()
    },
    broadcast: (payload) => {
      server.broadcast({ type: 'watchdog:memoryPressure', payload })
      rollingRestartHandleLocal.onMemoryPressure(payload)
    },
  })

  // 启动耗时分解探针（06 §5 m-7）：listen-ready 各段耗时（baseline 对比见汇报——
  // 改造前 getPiVersion 占 listen 延迟 1.1-1.3s，重排后该段归零）。
  console.log(`[runtime] startup breakdown: syncMigrations=${(tSyncMigrations - tStart).toFixed(1)}ms construction=${(tServicesReady - tSyncMigrations).toFixed(1)}ms listen=${(performance.now() - tListen).toFixed(1)}ms total=${(performance.now() - tStart).toFixed(1)}ms`)

  // ── 后台初始化块（D8-1）：listen 后执行，不阻塞端口就绪 ──────────────
  // 序列与顺序约束见 startup-background-init.ts 文件头注释（migrateProviderConfig →
  // migrateBuiltinExtensions → checkAndAutoUpgrade → getPiVersion → skill → plugins）。
  // fire-and-forget：每步自带 catch，无 rejection 逃逸；失败不阻塞其余步骤。
  //
  // u5（crash-forensics D3）：孤儿收殓完成 promise 经交付回调同步捕获（调度即交付——
  // 回调在本调用同步段内触发，早于 reattach 编排的首个 await），供下方编排等待收割。
  let orphanReapChain: Promise<void> = Promise.resolve()
  void runStartupBackgroundInit({
    configStore,
    authStorage,
    // A1-4 收口：legacy step1 迁移的 apiKey 写 auth.json 经 AuthService（唯一写入口）
    credentialWriter: authService,
    extensionService,
    pm,
    appInfo,
    broadcastAppInfo: () => server.broadcastAppInfo(),
    skillRegistry,
    pluginService,
    // u3b（idle-pi-reclamation D4）：reaper 启动闭包（装配在上方 wiring 段）——经后台
    // 序列 ⑩ 触发一次，fire-and-forget 形态由该序列保证。
    startIdleReaper,
    // u5（crash-forensics D3）：收割完成 promise 交付（reattach 编排的唯一消费方）。
    onOrphanReapChainScheduled: (completion) => {
      orphanReapChain = completion
    },
    // u17 判据 v2：spawn 清单读取（infra 读侧经 port 注入；闭包绑定组合根同源 getDataDir()）
    readSpawnMarkers: () => readSpawnMarkerList(getDataDir()),
  })

  // ── u5（crash-forensics-and-watchdog D3）：reattach 编排 ─────────────────────
  // WS listen 后独立并行任务（D3 编排挂点：与 startup-background-init 串行链解耦，不违背
  // 「端口先就绪」原则，也不阻塞链尾 reaper 启动——收割等待经 Promise.race 有界消费）。
  // 冷启动无 checkpoint（clean exit 已删 / 首次启动）→ read() 返回 undefined → 编排零动作
  // （A3b 冷启动维持 lazy）。restore 走 lifecycle registerSession 汇聚点（onSessionRegistered
  // 挂点随附触发）。内部全容错不抛；外层 .catch 是防御兜底（对齐上方 fire-and-forget 形态）。
  // 偏差 #27：onDeferredBroadcast = 高水位延迟进入/缓解的 reattach:deferred WS 推送出口
  // （u7c 滚动重启 broadcast 注入同形态；renderer 横幅腿 = useRollingRestartStatus）。
  void runStartupReattach({
    restore: (sessionId) => sessionService.restoreSession(sessionId),
    waitForOrphanReap: () => orphanReapChain,
    onDeferredBroadcast: (payload) => server.broadcast({ type: 'reattach:deferred', payload }),
  }).catch((e) => {
    console.error('[runtime] reattach orchestration failed unexpectedly:', e)
  })
}

main().catch((e) => {
  console.error('[runtime] fatal:', e)
  process.exit(1)
})
