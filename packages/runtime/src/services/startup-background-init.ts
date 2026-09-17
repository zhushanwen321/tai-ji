/**
 * 启动后台初始化块（perf W29 D8-1，06 §3.3）——从 index.ts 组合根抽出的可测试序列。
 *
 * 背景：D8-1 把「listen 前无依赖的后置项」全部移到 listen 之后执行，端口先就绪
 * （/health 即 ready），迁移/探测在后台进行。本模块承载该后台序列；index.ts 组合根
 * 仍负责全部服务构造与注入（构造部分留在组合根，符合组合根职责），本模块只编排
 * 执行顺序。抽出独立模块的动机：验收要求「migrateBuiltin → autoUpgrade 顺序 spy 调用序」
 * 断言——内联在 main() 里无法在测试中调用，抽出后行为可测。
 *
 * 执行序（06 §3.3 D8-1 的收敛实现——串行链，2026-08-17 勘误回写口径；文档原文「相互可
 * 并行」为设计阶段判断，实施有意收敛为全串行，见该文档 D8-1 勘误段）：
 *   migrateProviderConfig（存 migrationReady gate）→ migrateBuiltinExtensions →
 *   checkAndAutoUpgrade（migrateBuiltin 必须在 autoUpgrade 前——唯一硬序约束，否则
 *   autoUpgrade 仍会尝试升级打包内置包）→ getPiVersion（mutate appInfo + 补发 app.info）→
 *   skillRegistry.initGlobal → pluginService.initialize → ensureAutoRenameDefault。
 * 全串行的取舍：约束零竞态面 + best-effort 语义最易保持；代价 = 后台总完成时间为各段之和。
 * ⑨ 孤儿 pi 收殓（integrity-hardening §3.4 D4a）不在串行链上——独立 5s 定时器，
 * 调度点在序列最前（宽限从启动起计，见函数体注释）。⑨b 后台任务收殓触发面 B
 * （file-lock-unification D2）在同一 5s 定时器内链式 await ⑨ 完成后执行（硬序
 * 论证见函数体注释）。
 *
 * 每步独立 try/catch：任一步失败不阻塞其余（与改造前 best-effort 语义一致），
 * 无 rejection 逃逸。
 */
import { migrateProviderConfig } from './migration/legacy-provider-migration.js'
import { setMigrationGate } from './session/session-lifecycle.js'
import { cleanupTmpMigrateResidue } from '../infra/pi/session-file-utils.js'
import { getSessionsDir, getPiAgentDir } from '../infra/pi/pi-paths.js'
import { cleanupAgedBackupResidue } from '../utils/json-store.js'
import { join } from 'node:path'
import { getDataDir } from '@taiji/shared/paths'
import { ensureAutoRenameDefault } from './rename-session-config.js'
import { ensureDeclaredStartupConfigs } from './extension-startup-config.js'
import { ORPHAN_REAP_DELAY_MS, reapOrphanPiProcesses } from './reap-orphan-pi.js'
import { reapAllSessionsBackgroundTasks } from './session/background-task-reaper.js'
import {
  TAIJI_RUNTIME_PI_RECLAIM_IDLE_MS,
  TAIJI_RUNTIME_PI_RECLAIM_TICK_MS,
  TAIJI_RUNTIME_PI_RECLAIM_VIEWED_WINDOW_MS,
  DEFAULT_PI_RECLAIM_IDLE_MS,
  DEFAULT_PI_RECLAIM_TICK_MS,
  DEFAULT_PI_RECLAIM_VIEWED_WINDOW_MS,
} from '@taiji/shared'
import type { PiConfigStore } from '../infra/pi/pi-config-store.js'
import type { AuthStorage, CredentialWriter } from './auth/auth-storage.js'
import type { ExtensionService } from './extension-service.js'
import type { ProcessManager } from '../infra/pi/process-manager.js'
import type { SkillRegistry } from './skill-registry.js'
import type { PluginService } from './plugin-service/plugin-service.js'

export interface StartupBackgroundDeps {
  configStore: PiConfigStore
  authStorage: AuthStorage
  /** auth.json 凭据写通道（A1-4 收口）：legacy step1 迁移的 apiKey 写入经 AuthService。 */
  credentialWriter: CredentialWriter
  extensionService: ExtensionService
  pm: ProcessManager
  /** appInfo 同对象（组合根 setServices 注入 broker 的引用）——本模块 mutate piVersion 后补发。 */
  appInfo: { appVersion: string; piVersion: string }
  /** 补发 app.info 广播（server.broadcastAppInfo → broker 全局广播，D8-2）。 */
  broadcastAppInfo: () => void
  skillRegistry: SkillRegistry
  pluginService: PluginService
  /**
   * 启动空闲 pi 回收 reaper（idle-pi-reclamation D4，u3b）。可选成员保证既有测试构造点
   * 不破；undefined = 跳过（行为不变）。构造留在组合根（本模块只编排执行顺序，见文件头
   * 注释）——闭包内完成 seat/豁免/reclaim 全部装配，本模块只在序列里触发一次。
   */
  startIdleReaper?: () => void
  /**
   * 孤儿收殓完成 promise 交付回调（crash-forensics-and-watchdog D3，u5）。定时器调度后
   * 同步调用一次，参数 = 「5s 延迟 + 孤儿 pi 收殓 + 后台任务收殓」全链 settle 的 promise
   * （永不 reject——既有 catch 链尾部 resolve）。消费方 = reattach 编排（live 孤儿未收割完
   * 不 spawn，防双重进程；收割等待经 Promise.race 有界消费，promise 不是 loop handle，
   * 不影响定时器 unref 语义）。可选成员，缺省行为与既有 fire-and-forget 完全一致。
   */
  onOrphanReapChainScheduled?: (completion: Promise<void>) => void
  /**
   * spawn 清单读取（u17 判据 v2，D6c port 纪律）：组合根注入 infra/spawn-markers 的
   * readSpawnMarkerList(getDataDir()) 闭包；null = 清单缺失/坏 → reap 侧 fail-safe 跳过。
   */
  readSpawnMarkers: () => string[] | null
}

/** 空闲 pi 回收三旋钮（D4；默认值权威源 = shared/constants DEFAULT_PI_RECLAIM_*）。 */
export interface ReclaimConfig {
  idleThresholdMs: number
  tickIntervalMs: number
  viewedWindowMs: number
}

/**
 * 解析 env 三旋钮（idle-pi-reclamation D4 env 覆盖；独立导出便于单测 env 覆盖行为）。
 *
 * 值语义：缺失回落 shared 默认；非法值（非数字 / NaN / Infinity / 非正数含 0）一律回落
 * 默认——非正数周期/阈值会让 setInterval 立即连拍或永不回收，视为配置错误按缺省处理
 * （env 是运维逃生旋钮不是校验面，warn 不 throw）。
 */
export function resolveReclaimConfig(env: NodeJS.ProcessEnv): ReclaimConfig {
  const parseMs = (raw: string | undefined, fallback: number): number => {
    if (raw === undefined) return fallback
    const n = Number(raw)
    if (!Number.isFinite(n) || n <= 0) {
      console.warn(`[runtime] invalid reclaim env value "${raw}", falling back to ${fallback}ms`)
      return fallback
    }
    return n
  }
  return {
    idleThresholdMs: parseMs(env[TAIJI_RUNTIME_PI_RECLAIM_IDLE_MS], DEFAULT_PI_RECLAIM_IDLE_MS),
    tickIntervalMs: parseMs(env[TAIJI_RUNTIME_PI_RECLAIM_TICK_MS], DEFAULT_PI_RECLAIM_TICK_MS),
    viewedWindowMs: parseMs(env[TAIJI_RUNTIME_PI_RECLAIM_VIEWED_WINDOW_MS], DEFAULT_PI_RECLAIM_VIEWED_WINDOW_MS),
  }
}

/**
 * 执行后台初始化序列（listen 后调用）。返回的 promise 在全部步骤完成后 resolve
 * （每步自带 catch，不 reject）。测试可直接调用本函数 + spy 断言调用序。
 */
export async function runStartupBackgroundInit(deps: StartupBackgroundDeps): Promise<void> {
  const { configStore, authStorage, credentialWriter, extensionService, pm, appInfo, broadcastAppInfo, skillRegistry, pluginService } = deps
  const tBg = performance.now()

  // ⑨ 孤儿 pi 收殓链调度（孤儿收殓 + 后台任务收殓链式硬序 + 完成 promise 交付；
  // 时序论证与 u5 交付语义见 scheduleOrphanReapChain 函数头注释）。fire-and-forget 不阻塞本序列。
  scheduleOrphanReapChain(deps)

  // ① provider 迁移 → migrationReady gate（D8-3）：session spawn（create/restore/fork）
  // 在迁移完成前等待该 promise（日志块与 best-effort 容错见 startProviderMigration）。
  // 必须先于 setMigrationGate 启动（同步前缀立即执行），gate 在任何 WS 消息（macrotask）
  // 被处理前已就位——listen 后首个 session RPC 必然等到 gate。
  const migrationReady = startProviderMigration(configStore, authStorage, credentialWriter)
  setMigrationGate(migrationReady)
  await migrationReady
  const tMigA = performance.now()

  // ② migrateBuiltinExtensions：清理旧版 mandatory npm install 遗留的 builtin 包记录。
  // 必须在 checkAndAutoUpgrade 前跑（顺序约束，见文件头注释）——否则 autoUpgrade 仍会
  // 尝试升级打包内置包。
  try {
    await extensionService.migrateBuiltinExtensions()
  } catch (e) {
    // best-effort：迁移失败不阻塞启动（最坏情况是 builtin 包被重复发现，不影响功能）
    console.warn('[runtime] builtin extension migration failed:', e)
  }
  const tMigB = performance.now()

  // ③ 自动升级：对开启 autoUpgrade 的 user-installed 扩展批量检查 npm latest 版本，
  // semver.lt 判定后静默升级。失败不阻塞启动（每个扩展独立 try-catch）。
  try {
    const upgradeResults = await extensionService.checkAndAutoUpgrade()
    const upgraded = upgradeResults.filter(r => r.upgraded)
    if (upgraded.length > 0) {
      console.log(`[runtime] auto-upgraded ${upgraded.length} extension(s):`,
        upgraded.map(r => `${r.name} ${r.from ?? '?'}→${r.to ?? '?'}`).join(', '))
    }
  } catch (e) {
    // checkAndAutoUpgrade 内部已 catch 每个扩展，此处是意外错误兜底
    console.warn('[runtime] extension auto-upgrade encountered an error:', e)
  }
  const tAutoUpgrade = performance.now()

  // ④ piVersion 惰性探测（D8-2）：完成后 mutate appInfo 同对象 + 补发 app.info——
  // 侧栏版本标签先显示应用版本，1-2s 内自动补全为完整版本串（V2 验收）。
  // getPiVersion 内部已 catch（失败返回 'unknown'），此处兜底防御。
  try {
    const piVersion = await pm.getPiVersion()
    appInfo.piVersion = piVersion
    broadcastAppInfo()
  } catch (e) {
    // best-effort：探测失败保持 'unknown'，不补发——版本标签显示应用版本即可，下次启动重试
    console.warn('[runtime] pi version detection failed:', e)
  }
  const tPiVersion = performance.now()

  // ⑤ SkillRegistry 全局扫描：启动期扫描全局 skill 目录（piAgentDir/skills、configDir/skills、
  // discovery.skillDirs）并挂 chokidar watcher。失败不阻塞（skill 降级空缓存）。
  try {
    await skillRegistry.initGlobal()
    console.log(`[runtime] skill registry initialized (${skillRegistry.getGlobalSkills().length} global skills)`)
  // eslint-disable-next-line taste/no-silent-catch -- skill 扫描失败不阻塞 runtime，UI 降级空列表
  } catch (e) {
    console.error('[runtime] skill registry initialization failed:', e)
  }
  const tSkillInit = performance.now()

  // ⑥ 插件系统初始化（扫描、激活 onStartupFinished 插件）
  try {
    await pluginService.initialize()
    console.log('[runtime] plugins initialized')
  // eslint-disable-next-line taste/no-silent-catch -- init: plugin failure must not block server
  } catch (e) {
    console.error('[runtime] plugin initialization failed:', e)
  }
  const tPlugins = performance.now()

  // ⑦ auto-rename 默认初始化：首次启动默认开启（创建 flag file + initialized 标记）
  try {
    ensureAutoRenameDefault()
  } catch (e) {
    // best-effort：初始化失败不影响主流程（下次启动重试），仅记录诊断信息
    console.warn('[runtime] auto-rename default initialization failed:', e)
  }

  // ⑦b extension 声明的启动配置统一 ensure（机制与容错见 ensureStartupConfigs 注释）。
  await ensureStartupConfigs(extensionService)

  // ⑧ sessions 目录残留清扫（W3 `.tmp-migrate-`/`.tmp-import-` 崩溃残留 + 缓存治理 U9
  // `<session>.jsonl.model.json` 退役 sidecar 残留）：目录级兜底，补 cleanupMigrateResidues
  // 只在附着前/delete 链触发的覆盖缺口（不再被 restore 的 session 其残留会永久留存）。
  // U9 家族年龄无关全删——sidecar 读写点已全部退役（U8），值可从 session JSONL 反向读
  // 重推导（U7），删除幂等（重复删除走 warn 容错路径不抛出）。同步 readdir/unlink 扫一个
  // 本地目录（毫秒级）且在 listen 后的后台序列里执行，不阻塞启动路径；tmp 标记家族保持
  // 过期阈值（1h）内不删（防并发误删进行中的归一化临时文件），失败逐文件 warn 不上抛。
  try {
    const removed = cleanupTmpMigrateResidue(getSessionsDir())
    if (removed > 0) {
      console.log(`[runtime] cleaned ${removed} residue file(s) from sessions dir (.tmp-migrate-/.tmp-import- stale tmp + retired .model.json sidecar)`)
    }
  } catch (e) {
    // best-effort：清扫失败不影响主流程（残留仅是磁盘垃圾，下次启动重试）
    console.warn('[runtime] tmp-migrate/tmp-import residue cleanup failed:', e)
  }

  // ⑧b 备份残留按龄回收（`.conflict-<ts>` 冲突备份 + `.corrupt-<ts>` 损坏隔离副本）：
  // 两者都是人工恢复取证文件，但无任何消费方清理——每次冲突/损坏新增一份，数据目录
  // 无限堆积。按龄（默认 7 天）回收，正则严格匹配 ISO 压缩后缀防误删。覆盖 JsonStore/
  // WriteBackCache 的落点层：数据目录根（models/settings 等单文件 store）、sessions、
  // session-data、plugins。best-effort，失败不影响主流程。
  try {
    const dataDir = getDataDir()
    const removedBackups = cleanupAgedBackupResidue([
      dataDir,
      getSessionsDir(),
      join(dataDir, 'session-data'),
      join(dataDir, 'plugins'),
    ])
    if (removedBackups > 0) {
      console.log(`[runtime] recycled ${removedBackups} aged backup file(s) (.conflict-/.corrupt- residue beyond retention window)`)
    }
  } catch (e) {
    // best-effort：回收失败不影响主流程（残留仅是磁盘垃圾，下次启动重试）
    console.warn('[runtime] aged backup residue cleanup failed:', e)
  }

  // ⑩ 空闲 pi 回收 reaper 启动（idle-pi-reclamation D4，u3b）：对齐 ⑨ 的 fire-and-forget
  // + try/catch 形态——startIdleReaper 只起一个 setInterval 判定循环（tick 定时器已在
  // reaper 内部 unref，不阻塞进程退出），同步返回无异步面；首拍在 tick 间隔（默认 5min）
  // 之后，与串行链其余步骤零共享状态。缺省（undefined）= 跳过（行为不变，既有测试构造点
  // 不受影响）。
  if (deps.startIdleReaper) {
    try {
      deps.startIdleReaper()
    // eslint-disable-next-line taste/no-silent-catch -- best-effort：闭包装配错误仅 warn，不阻塞启动序列（reaper 缺席 = 现状行为，下轮重启重试）
    } catch (e) {
      console.warn('[runtime] idle pi reaper start failed:', e)
    }
  }

  // 后台初始化耗时分解探针（06 §5 m-7）：listen 后各段（改造前这些段全部堆在 listen 前）。
  console.log(`[runtime] background init breakdown: migrationA=${(tMigA - tBg).toFixed(1)}ms migrateBuiltin=${(tMigB - tMigA).toFixed(1)}ms autoUpgrade=${(tAutoUpgrade - tMigB).toFixed(1)}ms piVersion=${(tPiVersion - tAutoUpgrade).toFixed(1)}ms skillInit=${(tSkillInit - tPiVersion).toFixed(1)}ms plugins=${(tPlugins - tSkillInit).toFixed(1)}ms total=${(tPlugins - tBg).toFixed(1)}ms`)
}

/**
 * ⑨ 孤儿 pi 收殓链调度（integrity-hardening §3.4 D4a + ⑨b file-lock-unification D2）：
 * 主序列最前调度的 5s 宽限定时器——孤儿 pi 收殓 → 后台任务收殓链式硬序 → 完成
 * promise 交付（onOrphanReapChainScheduled → reattach 编排消费）。fire-and-forget，
 * 不阻塞启动序列。时序论证（调度点最前 / 链式 await 硬序 / u5 完成 promise 交付
 * 语义）见设计文档 integrity-hardening §3.4 D4a、file-lock-unification §2.3、
 * crash-forensics-and-watchdog D3。
 */
function scheduleOrphanReapChain(deps: StartupBackgroundDeps): void {
  let settleReapChain: () => void = () => {}
  const reapChainDone = new Promise<void>((resolve) => {
    settleReapChain = resolve
  })
  const reapTimer = setTimeout(() => {
    // u17 判据 v2（设计 §6.12）：孤儿判据消费 spawn 清单，读取函数由组合根经 deps 注入
    // （清单文件 io 在 infra/spawn-markers.ts 读写两侧 SSOT；D6c services 层不 import infra）。
    void reapOrphanPiProcesses({
      dataDir: getDataDir(),
      ownPid: process.pid,
      readSpawnMarkers: deps.readSpawnMarkers,
    })
      .catch((e) => {
        console.warn('[runtime] orphan pi reap failed unexpectedly:', e)
      })
      .then(() => reapAllSessionsBackgroundTasks(getPiAgentDir()))
      .catch((e) => {
        console.warn('[runtime] background task reap-all failed unexpectedly:', e)
      })
      .then(() => {
        settleReapChain()
      })
  }, ORPHAN_REAP_DELAY_MS)
  // unref：不让收殓定时器独自挂住进程生命周期（正常场景 runtime 长活，仅测试/工具受益）。
  reapTimer.unref()
  deps.onOrphanReapChainScheduled?.(reapChainDone)
}

/**
 * ① provider 迁移（D8-3）→ 返回 migrationReady promise（调用方 setMigrationGate 挂载）。
 *
 * gate 显式 .then(onFulfilled, onRejected) 双处理——迁移失败也 resolve（best-effort：
 * warn + 下次重试，不阻塞任何功能）。日志块与容错语义与拆分前逐字一致。
 */
function startProviderMigration(
  configStore: PiConfigStore,
  authStorage: AuthStorage,
  credentialWriter: CredentialWriter,
): Promise<void> {
  return migrateProviderConfig(configStore, authStorage, credentialWriter).then(
    (migrationReport) => {
      const { catalog, enabled } = migrationReport
      if (catalog.migrated.length > 0 || catalog.errors.length > 0 || enabled.migratedEnabled || enabled.fullDisabledWarn) {
        console.log('[runtime] provider config migration:', JSON.stringify({
          catalogMigrated: catalog.migrated.length,
          catalogKept: catalog.kept.length,
          catalogSkipped: catalog.skipped.length,
          catalogFailed: catalog.failed.length,
          enabledMigrated: enabled.migratedEnabled,
          fullDisabledWarn: enabled.fullDisabledWarn ?? false,
        }))
        if (catalog.errors.length > 0) {
          console.warn('[runtime] legacy provider migration errors:', catalog.errors)
        }
        if (enabled.fullDisabledWarn) {
          console.warn('[runtime] all providers were disabled (enabled===false); pi does not support fully-disabled state. After migration all providers are available — please manually remove unwanted providers.')
        }
      }
    },
    (e) => {
      // best-effort 降级：provider config migration 失败不阻塞启动（旧配置保留，用户可在 Settings 手动修正）。
      console.warn('[runtime] provider config migration failed:', e)
    },
  )
}

/**
 * ⑦b extension 声明的启动配置统一 ensure（startup-config 机制）：各 extension 在
 * package.json `taiji.startupConfig` 声明「启动即就绪」的配置文件，此处统一
 * 首建（已存在一律跳过，绝不覆盖用户配置）。详见 extension-startup-config.ts 文件头。
 */
async function ensureStartupConfigs(extensionService: ExtensionService): Promise<void> {
  try {
    const extPaths = await extensionService.getExtensionPaths()
    const report = ensureDeclaredStartupConfigs(extPaths, getPiAgentDir())
    const line = `[runtime] extension startup config ensured=${report.ensured} skipped=${report.skipped} failed=${report.failed}`
    if (report.failed > 0) console.warn(line)
    else if (report.ensured > 0) console.log(line)
  } catch (e) {
    // best-effort：声明读失败不阻塞启动（各 extension 惰性 ensure 仍在，功能不受损）
    console.warn('[runtime] extension startup config ensure failed:', e)
  }
}
