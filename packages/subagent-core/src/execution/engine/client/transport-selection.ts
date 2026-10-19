// src/execution/engine/client/transport-selection.ts
//
// [M3] transport 选择谓词单源（设计 relay-spawn-transport §3.3 D5/D9）：EngineClient
// 的 resolveTransport 与 stream-sink 的 widget 抑制判据共用本模块——两处必须看到同一
// 结果，否则「引擎由谁 spawn」与「live 流由谁供数」会分裂。
//
// D9 逃生舱 TAIJI_SUBAGENT_TRANSPORT=local 优先于 control env 判定：强制 local 后引擎
// 由 extension 本地 spawn（stdio 只有三根 pipe，没有 fd3/raw mirror），因此依赖 runtime
// tee 供数的消费者（GUI widget 私货）必须按本谓词恢复自供。

import { isControlEnvActive } from "@zhushanwen/subagent-engine-sdk";

/** env 基座形态（process.env 与其可注入替身同构）。 */
export type TransportEnv = NodeJS.ProcessEnv | Record<string, string | undefined>;

/**
 * [D9 逃生舱] transport 强制覆盖键：值 `local` → 跳过 control env 判定强制 local。
 * 设计 D9「一个发布周期后删除」；值不合法/未设时按既有谓词判定。
 */
export const SUBAGENT_TRANSPORT_ENV = "TAIJI_SUBAGENT_TRANSPORT";

/** D9 逃生舱是否生效（trim 后等于 `local`；未设置/非法值不改变默认谓词）。 */
export function isForcedLocalTransport(env: TransportEnv): boolean {
  return (env[SUBAGENT_TRANSPORT_ENV] ?? "").trim() === "local";
}

/**
 * 宿主实际选中的 transport 是否为 runtime（托管态）：control env 非空且未被 D9
 * 逃生舱强制 local。
 *
 * 「mirror 可用」与「runtime transport」当前同构：runtime transport 意味着引擎由
 * runtime spawn，runtime 在 spawn 时必然开启 fd3 raw mirror（设计 D6）。扩展侧没有
 * 独立的 mirror 探测面（混合版本 runtime 不开启镜像的情形不可探测，属 D9 已登记的
 * 混合版本退化），故本谓词即「runtime tee 可供数」的判据。
 */
export function usesRuntimeTransport(env: TransportEnv): boolean {
  return !isForcedLocalTransport(env) && isControlEnvActive(env);
}
