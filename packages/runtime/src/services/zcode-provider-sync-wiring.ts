/**
 * zcode provider 启动同步的组合根接线（engine-provider-unification §3.3 D1/D7，u2-wiring）。
 *
 * 为什么从 index.ts main() 抽成独立模块（run-extras-migration 同族先例）：组合根 import 即
 * 执行 main()，测试无法直接驱动「同步抛错 → 启动不中断」的 D7 降级分支；抽成独立模块后
 * 降级语义固化为可单测契约——任何异常吞掉 + warn 留痕，绝不向调用方上抛。
 *
 * 与 u1-sync（zcode-provider-sync.ts）的职责边界：u1 承载映射与落盘编排（DI 面）；本文件
 * 只承载组合根接线决策——缺省路径拼装（真实三路径 homedir 推导 + 副本路径 getDataDir
 * 派生，段常量 = SDK zcode-db-paths.ts 的 ZCODE_PI_SYNCED_PROVIDER_CONFIG_SEGMENTS 单源，
 * 与 zcode-subagent-cli preparer 解析链同源 import——SDK 是跨包契约根，不违 C-ext-13
 * 的「runtime 不 import 引擎包」红线，control-server.ts 同款先例）+ catalog 单点直传
 * + try/catch 降级 + 结果摘要日志。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ZCODE_PI_SYNCED_PROVIDER_CONFIG_SEGMENTS } from '@zhushanwen/subagent-engine-sdk'
import { getDataDir } from '@taiji/shared/paths'
// logger 是 C-comm-03 文档登记受控例外（横切关注点，port 化只增加无意义间接层）
import { logger } from '../infra/logger.js'
import type { IConfigStore } from './ports/config.js'
import type { IProviderCredentialResolver } from './ports/provider-credential-resolver.js'
import { getMergedCatalogModels, type MergedCatalogView } from './provider-catalog.js'
import {
  syncZcodeProviders,
  type ZcodeProviderSyncOutcome,
  type ZcodeProviderSyncPaths,
} from './zcode-provider-sync.js'

/**
 * 缺省路径拼装：真实文件 = ~/.zcode 树三路径（homedir 推导）；副本路径 =
 * <dataDir>/engines/zcode/pi-synced-provider-config.json（段常量单源 = SDK
 * zcode-db-paths.ts ZCODE_PI_SYNCED_PROVIDER_CONFIG_SEGMENTS，与引擎读侧同源）。
 */
export function defaultZcodeProviderSyncPaths(): ZcodeProviderSyncPaths {
  const zcodeRoot = join(homedir(), '.zcode')
  return {
    realProviderConfigPath: join(zcodeRoot, 'v2', 'provider_config.json'),
    v2ConfigPath: join(zcodeRoot, 'v2', 'config.json'),
    cliConfigPath: join(zcodeRoot, 'cli', 'config.json'),
    syncedCopyPath: join(getDataDir(), ...ZCODE_PI_SYNCED_PROVIDER_CONFIG_SEGMENTS),
  }
}

/** 组合根实际装配的三项必填；其余为测试注入点（缺省 = 生产形态）。 */
export interface ZcodeProviderStartupSyncDeps { // oe-exempt:20261012:framework:接线 DI 契约,单实现常态
  readonly configStore: Pick<IConfigStore, 'readModels' | 'getEnabledModels'>
  readonly credentialResolver: Pick<
    IProviderCredentialResolver,
    'resolveProviderCredential' | 'resolveProviderBaseUrl' | 'listCredentialBackedProviderIds'
  >
  /** models.json 损坏降级态判定（D7①）——生产 = isModelsStoreCorrupted（infra/pi，组合根注入；services 层不 value import infra）。 */
  readonly isModelsCorrupted: () => boolean
  /** 同步路径（缺省 = defaultZcodeProviderSyncPaths()）。 */
  readonly paths?: ZcodeProviderSyncPaths
  /** catalog 合并视图单点（缺省 = getMergedCatalogModels 直传）。 */
  readonly getMergedCatalogModels?: (providerId: string) => MergedCatalogView | undefined
  /** 日志通道（缺省 = logger，warn/info 同落 runtime 日志文件）。 */
  readonly log?: { warn(message: string): void; info(message: string): void }
  /**
   * 触发来源（缺省 'startup'）：'startup' = runtime 启动期一次性同步；'mutation' =
   * provider 变更 write-through。两者同一实现，仅日志措辞分流（变更路径不得出现
   * 「启动同步 / 不阻断 runtime 启动」的误导性表述，排障时按来源区分）。
   */
  readonly trigger?: 'startup' | 'mutation'
}

/** 接线结果：正常返回透传 u1 outcome；意外异常吞掉并标记 failed（不阻断启动）。 */
export type ZcodeProviderStartupSyncResult = // oe-exempt:20261012:framework:接线结果契约,单实现常态
  | { readonly kind: 'completed'; readonly outcome: ZcodeProviderSyncOutcome }
  | { readonly kind: 'failed'; readonly error: unknown }

/**
 * 启动同步接线（D1 时机由调用方保证 = sanitizeInvalidProviders 之后；D7 降级语义在此收敛）：
 * u1 编排正常返回 → 按三态打摘要日志（written=条目数+落盘路径 / skipped-empty=删旧副本回落
 * 真实文件 / aborted=u1 已 warn 详细原因不重复）；任何异常 → warn 留痕（含恢复指引）不上抛，
 * runtime 启动照常继续（副本是可用性增强不是启动前置）。
 */
export async function runZcodeProviderStartupSync(
  deps: ZcodeProviderStartupSyncDeps,
): Promise<ZcodeProviderStartupSyncResult> {
  const log = deps.log ?? logger
  const paths = deps.paths ?? defaultZcodeProviderSyncPaths()
  const mutation = deps.trigger === 'mutation'
  const syncLabel = mutation ? '变更镜像同步完成' : '启动同步完成'
  try {
    const outcome = await syncZcodeProviders({
      configStore: deps.configStore,
      credentialResolver: deps.credentialResolver,
      paths,
      isModelsCorrupted: deps.isModelsCorrupted,
      getMergedCatalogModels: deps.getMergedCatalogModels ?? getMergedCatalogModels,
      warn: message => log.warn(message),
    })
    if (outcome.status === 'written') {
      log.info(
        `[zcode-provider-sync] ${syncLabel}：副本落盘 ${outcome.copyPath}（provider 条目 ${outcome.ruleCount}，跳过 ${outcome.skips.length}）`,
      )
    } else if (outcome.status === 'skipped-empty') {
      log.info(`[zcode-provider-sync] ${syncLabel}：无 pi 映射条目，旧副本已删除（如存在），引擎回落真实 zcode 配置`)
    }
    // aborted：u1 abort() 已 warn 详细原因，此处不重复
    return { kind: 'completed', outcome }
  } catch (err) {
    log.warn(
      mutation
        ? `[zcode-provider-sync] 变更镜像同步意外异常（不阻断配置写入应答，保留现状副本回落；下次 mutation/启动自动重试）：${err instanceof Error ? err.message : String(err)}`
        : `[zcode-provider-sync] 启动同步意外异常（不阻断 runtime 启动，保留现状副本回落；下次启动自动重试）：${err instanceof Error ? err.message : String(err)}`,
    )
    return { kind: 'failed', error: err }
  }
}

/**
 * write-through 触发面工厂（ADR-0142 镜像架构）：组合根把「启动同步」与「变更镜像」
 * 收敛为同一装配点——configStore / credentialResolver / isModelsCorrupted 三依赖单处
 * 组装，避免两次手抄漂移；返回值吞掉同步结果（镜像失败只 warn，不阻断调用方）。
 *
 * 顺序契约（ADR-0122「竞态用顺序契约消解」，MF-4）：返回的触发闭包是唯一串行化点——
 * 所有触发面（settings 域 provider mutation + 凭据域 OAuth 登录/退出事件）共用同一
 * 队列：同一时刻最多一次镜像运行；运行中到达的触发不合弃（pending），本轮结束后按
 * 最新配置重跑一次（latest-wins + re-run）。副本收敛时点 = 队列清空（最后一次变更
 * 的副本已落盘），不以固定时延窗口作保证。重跑读取的是当时的 provider 配置快照，
 * 因此异步凭据解析期间到达的 mutation 不会被更早启动的旧快照覆盖。
 */
export function createZcodeProviderMirrorSync(
  deps: Omit<ZcodeProviderStartupSyncDeps, 'trigger'>,
): () => Promise<void> {
  let running = false
  let pending = false
  let chain: Promise<void> = Promise.resolve()

  const drain = async (): Promise<void> => {
    running = true
    try {
      while (pending) {
        pending = false
        await runZcodeProviderStartupSync({ ...deps, trigger: 'mutation' })
      }
    } finally {
      running = false
    }
  }

  return () => {
    pending = true
    // 运行中：返回当前链（其循环会观察到 pending 并重跑，故解析时点 = 末轮完成）。
    if (running) return chain
    chain = drain()
    return chain
  }
}
