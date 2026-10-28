// local-spawn-env.ts —— conformance 套件共享：假引擎本地 spawn 的 env 基座。
//
// 为什么不能直接摊开 process.env：TaiJi 托管态下跑测（托管 pi 会话派生的测试进程）
// 宿主 env 携带 control env（CONTROL_ENV_SOCKET 等，runtime 注入的托管通道键）——
// 摊开继承会让 EngineClient 误选 runtime transport：引擎改由外层 runtime spawn，
// FAKE_* 注入 env 全部丢失（fake 引擎启动即崩 / spawn 日志缺席），套件连环失败。
// conformance 的语义是协议黑盒本地回放（引擎进程由本测试进程 spawn、stdio 直连），
// 必须显式剥除 control env（键名取 SDK 单源常量，禁手写字符串）。standalone 态
// （无 control env，如 CI）剥除为 no-op，行为不变。
import {
  CONTROL_ENV_ROOT_SESSION_ID,
  CONTROL_ENV_SOCKET,
} from "@zhushanwen/subagent-engine-sdk";

/** process.env 基座 + extra 注入，剥除 control env 两键后的本地 spawn env。 */
export function localSpawnEnv(
  extra: Record<string, string> = {},
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, ...extra };
  delete env[CONTROL_ENV_SOCKET];
  delete env[CONTROL_ENV_ROOT_SESSION_ID];
  return env;
}
