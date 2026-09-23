/**
 * btw 线进程 spawn options 工厂（btw-question M2-b 组合根回调的可测提取）。
 *
 * 原组合根内联的 `BtwServiceDeps.buildLineSpawnOptions` 回调提取为窄依赖注入工厂：
 * 决策面（preset 回落链 / skillPaths 回落 / 模型终态语义）可不经组合根直测。
 *
 * 决策语义（线进程 = 附着态启动，逐字段对齐 lifecycle.spawnRestoreClient）：
 *   - preset 回落链：线 launch 快照取主会话 preset——`findScannedSession(mainSid)
 *     ?.launchPresetId ?? BUILTIN_PRESET_IDS.FULL`（sidecar 缺失回落 builtin:full =
 *     FR-10 兜底；活跃/冷会话统一读扫盘面，spawnRestoreClient 同源）；
 *   - resolution 回落：preset 解析出 skillPaths/extensionPaths 时取 resolution 值，
 *     resolution 缺失或 skillPaths undefined 时回落全局解析；
 *   - 模型终态：`model: undefined` + `inheritSessionModel: true`——pi CLI --model 恒
 *     优先 entry 恢复，拼 --model 会把 fork 快照里用户切换过的模型压回（P1 final
 *     gate V1⑤），模型终态随线会话文件 entry 恢复；
 *   - D8-3 迁移门（与主 create/restore 同约束）：provider 迁移完成前禁启动 pi。
 */
import { BUILTIN_PRESET_IDS } from '@taiji/shared'
import type { RpcClientOptions } from '../../infra/pi/rpc-client.js'
import type { PresetResolution } from '../preset-service.js'
import {
  buildPresetClientOptions,
  buildPresetFallbackEnv,
  resolveAppendSystemPrompt,
  resolveEffectiveSystemPrompt,
} from './launch-params.js'
import type { BtwLineSpawnContext } from './btw-service.js'

/** 组合根注入面（sessionService 窄面 + 迁移门；测试注入 fake 直测回落链）。 */
export interface BtwLineSpawnOptionsDeps {
  /** D8-3 迁移门（组合根接 session-lifecycle getMigrationGate：迁移完成前禁启动 pi）。 */
  migrationGate(): Promise<unknown>
  /** 主会话扫盘查询（活跃/冷统一读扫盘面——launchPresetId 取主会话创建档）。 */
  findScannedSession(sessionId: string): { launchPresetId?: string } | undefined
  /** launch preset 解析（PresetService.resolve 委托；undefined = 未注入/解析失败）。 */
  getLaunchPresetOptions(presetId: string, cwd: string): Promise<PresetResolution | undefined>
  /** 全局 skill 路径（resolution 缺 skillPaths 时回落）。 */
  getSkillPaths(cwd: string): string[]
  /** 全局 extension 路径（resolution 缺失时回落）。 */
  getExtensionPaths(cwd?: string): Promise<string[]>
  /** 全局替换系统提示词（resolveEffectiveSystemPrompt 的全局档）。 */
  getReplaceSystemPrompt(): string | undefined
}

/**
 * 构建 `BtwServiceDeps.buildLineSpawnOptions` 回调（组合根装配点）。
 * 返回 ports 面完整 `RpcClientOptions`——BtwService 消费侧按 `BtwLineSpawnOptions`
 * 最小结构面（cwd/env/appendSystemPrompt）结构性收窄。
 */
export function createBtwLineSpawnOptionsFactory(
  deps: BtwLineSpawnOptionsDeps,
): (ctx: BtwLineSpawnContext) => Promise<RpcClientOptions> {
  return async (ctx) => {
    // D8-3 迁移门（与 create/restore 同约束）：provider 迁移完成前禁启动 pi。
    await deps.migrationGate()
    // 线 launch 快照取主会话 preset（工具/权限面 = 主会话创建档；活跃/冷会话统一读
    // 扫盘面——spawnRestoreClient 同源，sidecar 缺失回落 builtin:full = FR-10 兜底）。
    const presetId = deps.findScannedSession(ctx.mainSid)?.launchPresetId ?? BUILTIN_PRESET_IDS.FULL
    const resolution = await deps.getLaunchPresetOptions(presetId, ctx.cwd)
    // 组合形态逐字段对齐 lifecycle.spawnRestoreClient（线进程 = 附着态启动）：模型终态
    // 随线会话文件 entry 恢复——pi CLI --model 恒优先 entry 恢复，拼 --model 会把 fork
    // 快照里用户切换过的模型压回（P1 final gate V1⑤）。显式 `model: undefined` 覆盖
    // buildPresetClientOptions 可能 spread 进来的 preset modelOverride。
    const options: RpcClientOptions = {
      skillPaths: resolution?.skillPaths ?? deps.getSkillPaths(ctx.cwd),
      extensionPaths: resolution?.extensionPaths ?? await deps.getExtensionPaths(ctx.cwd),
      systemPrompt: resolveEffectiveSystemPrompt(resolution, deps.getReplaceSystemPrompt()),
      appendSystemPrompt: resolveAppendSystemPrompt(resolution),
      env: buildPresetFallbackEnv(resolution),
      ...buildPresetClientOptions(resolution, undefined, undefined),
      model: undefined,
      inheritSessionModel: true,
    }
    return options
  }
}
