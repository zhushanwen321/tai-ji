// src/execution/engine/common/data-dir.ts
//
// 引擎数据目录解析（P2）。设计权威源：
// docs/architecture/subagent-engine-abstraction.md D5/D6——engines 根锚定 getDataDir()
// 顶层（journal / 隔离池的父目录），extension 写侧与 runtime 校验侧同源推导。
//
// 通道调查结论（2026-08-25，P2 实测证据链）：
//   - runtime spawn pi 主会话时 RpcClient 出站 env 从 runtime process.env 继承
//     XYZ_ 前缀白名单变量（调查当时经私有 buildSafeEnv，现已被 buildPiOutboundEnv
//     → buildOutboundChildEnv 共享构建器取代），且显式设置 PI_CODING_AGENT_DIR；
//   - dev 模式 Electron main 设置 XYZ_AGENT_DATA_DIR（apps/electron/main/main.ts:122），
//     经 process-control.ts:262 透传给 runtime → 透传链成立；
//   - prod 默认路径（~/.xyz-agent 缺省）下 runtime 进程 env 中**没有**该变量
//     （shared getDataDir 缺省时不写 env）→ 透传链断——已在 runtime 侧
//     process-manager.ts spawn env 补注入 XYZ_AGENT_DATA_DIR 修复（跨包改动）。
//
// 回退语义与分段归属（u0-data-discovery，设计 D2 计划期细化③）：缺 env 时回退宿主
// 数据根（getHostServices().dataRoot()——pi 壳返回 getAgentDir()，尊重
// PI_CODING_AGENT_DIR 实例隔离，独立 pi 用户直跑 extension 的场景不漂目录）并 warn
// 一次——不留静默漂移（journal 落点变化必须可观测）。本文件保留 env 优先段与
// warn-once 语义，壳不重复实现；未 configureCore 即消费 dataRoot 抛
// core_host_not_configured（显式报错取代缺省静默漂目录）。

import { getHostServices } from "../../../core/host-services.ts";
import { getLogger } from "../../../core/logger.ts";

const logger = getLogger("subagents");

/** xyz-agent 数据目录 env 名（与 packages/shared/src/paths.ts 的 SSOT 变量同名）。 */
export const XYZ_DATA_DIR_ENV = "XYZ_AGENT_DATA_DIR";

/** 测试隔离专用：重置 warn-once 标记（生产禁用）。 */
let warned = false;
export function resetDataDirWarnForTests(): void {
  warned = false;
}

/**
 * 解析引擎数据目录（journal 落盘 / 隔离池的根）：
 *   1. process.env.XYZ_AGENT_DATA_DIR（xyz-agent 宿主注入，权威通道）；
 *   2. 缺失 → 宿主数据根（getHostServices().dataRoot()）+ warn 一次。
 * 每次调用重新解析（env 读取是零成本操作，不缓存路径防测试/宿主切换时读到旧值）。
 */
export function getEngineDataDir(
  env: NodeJS.ProcessEnv = process.env,
  warn: (msg: string) => void = defaultWarn,
): string {
  const fromEnv = env[XYZ_DATA_DIR_ENV]?.trim();
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;

  // warn 文案与 fallback 值逐字保留现语义（零行为变化）：pi 壳 dataRoot() 现取
  // getAgentDir()，落点与改造前一致；zsw 壳接入后此处自动跟随其数据根。
  const fallback = getHostServices().dataRoot();
  if (!warned) {
    warned = true;
    warn(
      `[engine-data-dir] ${XYZ_DATA_DIR_ENV} is not set; engine journal/pool fall back to the pi agent dir ` +
        `(${fallback}). The xyz-agent host normally injects this env — if you are running inside xyz-agent, ` +
        `check the runtime spawn env; standalone pi installs intentionally use the pi agent dir.`,
    );
  }
  return fallback;
}

function defaultWarn(msg: string): void {
  logger.warn(msg);
}
