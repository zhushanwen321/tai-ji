// src/control-env.ts
//
// [M3] subagent control 通道 env 名 SSOT（设计 relay-spawn-transport §3.3 D4/D5、
// §3.4.3）。跨进程契约单源：runtime（注入主 pi 与引擎）、extension（transport
// 选择谓词）、嵌套 extension（同一 socket 建独立连接）从这里消费键名，禁各处手写字符串。
//
// env 语义（D4 env × spawn 点矩阵）：
// - SOCKET 非空 = 托管态（runtime control server 已注入）→ RuntimeEngineTransport；
//   空串/缺失 = standalone → LocalEngineTransport（warn）——「不存在两个 env」谓词，
//   激活判定单源 = isControlEnvActive。
// - ROOT_SESSION_ID = runtime 注入的主会话根 id；第一个 engine_open 确定连接归属，
//   嵌套 task pi 经引擎出站 env 继承同值（共享同一根）。
//
// 键族归属（防 deny 方向错位）：control 两键是引擎与 runtime 之间的 L0 基础设施键
// （SDK env.ts ENGINE_ENV_L0_INFRA_KEYS 登记）——**不进** ENGINE_ENV_DENY_LIST
// （引擎/嵌套 extension 是合法读者），**不进** shared 出站 deny（task pi 也要携带，
// 嵌套子代理走同一 socket）。

/** control socket 路径（runtime 监听 `<dataDir>/run/subagent-<pid>.sock`；Windows 为 named pipe）。 */
export const CONTROL_ENV_SOCKET = "TAIJI_SUBAGENT_CONTROL_SOCKET";

/** 主会话根 id（runtime 注入；嵌套链所有层同值——连接归属与 channel 树的归属键）。 */
export const CONTROL_ENV_ROOT_SESSION_ID = "TAIJI_SUBAGENT_CONTROL_ROOT_SESSION_ID";

/**
 * transport 选择谓词（D5 选择逻辑的单一实现）：SOCKET 非空 = 托管态 → runtime
 * transport；空串/缺失 = standalone → local transport（调用方 warn）。消费方 =
 * EngineClient transport 选择（u-m3-rt-transport）；缺失即 local，不存在
 * 「注入了一半」的中间态。
 */
export function isControlEnvActive(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): boolean {
  return Boolean(env[CONTROL_ENV_SOCKET]);
}
