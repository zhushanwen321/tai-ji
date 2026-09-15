/**
 * 出站子进程 env 构建器 —— runtime 侧门面。
 *
 * U3 主链路接线起，三步语义实现归位 shared 契约 SSOT（spawn-env-contract.ts）：
 * main 进程 B2 边界 safe-env 薄封装需要同款过滤/extras 组合能力但不吃 deny 兜底
 * （deny 键是 runtime 自身的合法输入），跨包复用的唯一合理归属是契约同文件；
 * 本文件仅保留既有相对 import 路径（'../spawn-env.js'）供 runtime 内各接线点
 * （rpc-client 及 U4 周边 spawn 点）与既有测试零漂移消费。
 *
 * 语义与红线全文见 @taiji/shared 的 spawn-env-contract 头注释：
 * 1. prefixes 过滤父 env 为基座（缺省 = 入站白名单 SSOT）——R2：Node spawn env 是
 *    整体替换语义，禁从空对象起拼，否则 PATH/HOME 静默丢失；
 * 2. merge extras——undefined = 显式删除；
 * 3. apply SPAWN_ENV_OUTBOUND_DENY_LIST 兜底剥除 TAIJI_AGENT_PACKAGED / TAIJI_RUNTIME_TOKEN。
 * 纯函数、env 全 DI、不 mutate 入参（R1/R3）。
 */
export {
  buildOutboundChildEnv,
  composeChildEnvBase,
} from '@taiji/shared'
export type { BuildOutboundChildEnvOptions } from '@taiji/shared'
