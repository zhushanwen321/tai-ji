// src/constants.ts
//
// pi 引擎包的常量面（W7 迁移自 core engines/pi/pi-engine.ts / session-runner.ts，
// 逐值等价）。core 侧原件过渡期保留（W11 删），本包是引擎进程内的权威。

import { SHARED_POOL_KEY } from "@zhushanwen/subagent-engine-sdk";

/** pi 引擎的 registry key（D9：缺省引擎 = 'pi'）。 */
export const PI_ENGINE_ID = "pi";

/** pi 适配器版本（handle.adapterVersion 数据源——golden 样本对齐排查锚点）。 */
export const PI_ADAPTER_VERSION = "1.0.0";

/** pi 无隔离池（PI_CODING_AGENT_DIR 全局一份，设计 §3.3.9），poolKey 恒 'shared'。 */
export const PI_POOL_KEY = SHARED_POOL_KEY;

/** pi 域 schema env 名（宿主侧唯一活定义；structured-output 扩展读取它注册 tool——
 *  跨包契约另一端为该扩展的 ENV_SCHEMA 副本，等值由其
 *  tests/cross-package-contract.test.ts 守卫）。 */
export const SCHEMA_ENV_VAR = "PI_WORKFLOW_SCHEMA";

/** schema env 上限的 KiB 数与每 KiB 字节数（E2BIG 防护）。 */
const SCHEMA_ENV_MAX_KIB = 256;
const BYTES_PER_KIB = 1024;

/** schema env 的 UTF-8 字节上限（256KiB）：env 值随 spawn 走 execve/ARG_MAX 语义，
 *  超大值在 spawn 调用点报 E2BIG（与 schema 内容无关的表象，难归因）——故注入前
 *  按此上限 fail-fast 拒绝（spawn-args.ts applySchemaEnvToChildEnv）。 */
export const SCHEMA_ENV_MAX_BYTES = SCHEMA_ENV_MAX_KIB * BYTES_PER_KIB;

/** [D3-① race-F4] SIGTERM 优雅窗口：30s 超窗升级 SIGKILL（core 现状值）。 */
export const PI_KILL_GRACE_MS = 30_000;
