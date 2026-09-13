// src/env.ts
//
// pi 出站 env 组装（公共层）：buildPiOutboundEnv = extras 过滤 + 托管日志开关
// 恒注入 + 底层白名单构建器（DI）+ pi agent 目录隔离。
//
// 来源（行为逐字等价提取，非重写）：runtime rpc-client.ts buildPiOutboundEnv
// （B3 出站契约收口，docs/architecture/env-propagation-boundary.md §5-U3）。
//
// 底层 buildChildEnv 经依赖注入而非硬依赖：白名单过滤 + deny 兜底的 SSOT 现状
// 是两份（@xyz-agent/shared spawn-env-contract 供 runtime；subagent-engine-sdk
// env.ts 供引擎 CLI——独立 npm 发布需自包含），本包不复刻第三份。runtime 接线
// 传 shared 版（C-proc-09 唯一构建点的过滤/deny 语义不变）。
//
// pi-subagent-cli 侧不消费本函数（其子进程 env 走 SDK buildEngineChildEnv 三层
// 契约 + schemaEnv/relay 键，无 pi agent 目录隔离需求——PI_CODING_AGENT_DIR 全局
// 一份，无隔离池；依据 = 原 subagent-engine-abstraction.md §3.3.9（已删，git
// 可追溯），现行登记 constraints.json C-ext-15）。

/** 底层出站构建器形状（shared buildOutboundChildEnv / SDK 同形，DI 注入）。 */
export type BuildChildEnvFn = (opts: {
  parentEnv: NodeJS.ProcessEnv
  extras?: Record<string, string | undefined>
}) => Record<string, string | undefined>

export interface PiOutboundEnvOptions {
  parentEnv: NodeJS.ProcessEnv
  /** 调用方注入的 extras（undefined 值键跳过不写，见 buildPiOutboundEnv 注释）。 */
  extras?: Record<string, string | undefined>
  /** 底层白名单过滤 + deny 兜底构建器（shared / SDK 版由调用方注入）。 */
  buildChildEnv: BuildChildEnvFn
  /** xyz 托管 pi agent 目录（<dataDir>/agent/，pi-paths SSOT 推导后传入）。 */
  piAgentDir: string
}

/**
 * pi 子进程出站 env 组装（runtime 主链路 spawn 专用）。
 *
 * 顺序语义：白名单过滤父 env 为基座 → extras 整体覆盖（undefined 键跳过——
 * 「undefined=删除」语义属 main 侧 safe-env，跳过防上游误传 undefined 时吞掉
 * 白名单基座继承键，如 PATH 被删 → hooks 里 command not found）→
 * XYZ_AGENT_EXT_LOG 恒注入 '1'（托管环境 extension-logger 落盘 INFO 级日志，
 * 不开放 extras 覆盖）→ PI_CODING_AGENT_DIR 指向托管 agent 目录（数据隔离，
 * 开发/打包统一 <dataDir>/agent/，不用系统 pi 的 ~/.pi/agent/）。
 */
export function buildPiOutboundEnv(opts: PiOutboundEnvOptions): NodeJS.ProcessEnv {
  const outboundExtras: Record<string, string> = {}
  for (const [key, value] of Object.entries(opts.extras ?? {})) {
    // 旧实现对 undefined extras 键跳过不写。保留跳过行为（R2 远距离爆炸防线）。
    if (value !== undefined) outboundExtras[key] = value
  }
  // D4/G4 观测补齐：xyz 托管环境恒注入 extension 日志开关——extension-logger 见此
  // 变量即落盘 INFO 级日志（XYZ_AGENT_DEBUG=1 的 DEBUG 全量语义不变，两变量并存
  // 取更详细；均未注入的裸 pi 独立用户保持 no-op，零磁盘影响）。托管语义恒为
  // '1'，不开放 extras 覆盖。
  outboundExtras.XYZ_AGENT_EXT_LOG = '1'
  const env = opts.buildChildEnv({ parentEnv: opts.parentEnv, extras: outboundExtras })
  env.PI_CODING_AGENT_DIR = opts.piAgentDir
  return env as NodeJS.ProcessEnv
}
