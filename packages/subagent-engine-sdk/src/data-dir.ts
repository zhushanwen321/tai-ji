// src/data-dir.ts
//
// 引擎数据目录解析（引擎侧原语，自 core execution/engine/common/data-dir.ts 迁入
// @zhushanwen/subagent-engine-sdk）。迁移处置（impl-plan §2.1 data-dir 行）：**拆
// seam**——今天 core 版缺 env 时回退 getHostServices().dataRoot()（引擎进程无
// configureCore 通道，不可复制）；SDK 版 = **参数化/env 优先**，core 侧保留
// getHostServices() 绑定（core 文件不动，引用切换归 W2+）。
//
// SDK 版缺省语义（impl-plan §2.9 数据根注入矩阵，写死）：env 优先；缺 env 且调用方
// 未显式注入 fallback → **显式报错**（错误信息可操作：env 名 + 期望注入动作），不留
// 静默漂目录。带 fallback 注入（pi 扩展宿主 = core 侧解析后显式传入）时保留
// warn-once 语义（回退非权威通道必须可观测），与 core 版行为逐字对齐。
//
// 通道调查结论（2026-08-25，P2 实测证据链，自 core 版头部保留）：
//   - runtime spawn pi 主会话时 RpcClient 出站 env 从 runtime process.env 继承
//     XYZ_ 前缀白名单变量（调查当时经私有 buildSafeEnv，现已被 buildPiOutboundEnv
//     → buildOutboundChildEnv 共享构建器取代），且显式设置 PI_CODING_AGENT_DIR；
//   - dev 模式 Electron main 设置 XYZ_AGENT_DATA_DIR（apps/electron/main/main.ts:122），
//     经 process-control.ts:262 透传给 runtime → 透传链成立；
//   - prod 默认路径（~/.xyz-agent 缺省）下 runtime 进程 env 中**没有**该变量
//     → runtime 侧 process-manager.ts spawn env 补注入 XYZ_AGENT_DATA_DIR 修复。

import { getLogger } from "./logger.ts";

const logger = getLogger("subagents");

/** xyz-agent 数据目录 env 名（与 packages/shared/src/paths.ts 的 SSOT 变量同名）。 */
export const XYZ_DATA_DIR_ENV = "XYZ_AGENT_DATA_DIR";

// warn-once 配置态：globalThis[Symbol.for] slot（core host-services 同款范式）——
// CJS 多 entry 内联副本下模块级 `let` 会分裂成多份（每份各 warn 一次），slot 跨副本一致。
const WARNED_SLOT_KEY = Symbol.for("@zhushanwen/subagent-engine-sdk.data-dir-warned");

function getWarnedSlot(): { current: boolean } {
  let slot = Reflect.get(globalThis, WARNED_SLOT_KEY) as { current: boolean } | undefined;
  if (!slot) {
    slot = { current: false };
    Reflect.set(globalThis, WARNED_SLOT_KEY, slot);
  }
  return slot;
}

/** 测试隔离专用：重置 warn-once 标记（生产禁用）。 */
export function resetDataDirWarnForTests(): void {
  getWarnedSlot().current = false;
}

/**
 * 解析引擎数据目录（journal 落盘 / 隔离池的根）：
 *   1. env[XYZ_AGENT_DATA_DIR]（宿主注入，权威通道）；
 *   2. 缺失 + opts.fallbackDataRoot 显式传入（宿主解析过的数据根）→ 用之 + warn 一次
 *      （非权威通道回退必须可观测——journal 落点变化不留静默漂移）；
 *   3. 两者皆缺 → 抛错（engine_not_found 语义：错误含 env 名、期望值示例与恢复动作；
 *      impl-plan §2.9「缺 env 且无注入 → 显式报错（附期望路径）」）。
 *
 * 每次调用重新解析（env 读取是零成本操作，不缓存路径防测试/宿主切换时读到旧值）。
 */
export function resolveEngineDataDir(
  env: NodeJS.ProcessEnv,
  opts: { fallbackDataRoot?: string; warn?: (msg: string) => void } = {},
): string {
  const fromEnv = env[XYZ_DATA_DIR_ENV]?.trim();
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;

  const fallback = opts.fallbackDataRoot?.trim();
  if (fallback === undefined || fallback === "") {
    throw new Error(
      `[subagent-engine-sdk] engine_not_found: ${XYZ_DATA_DIR_ENV} is not set and no fallback data root was injected. ` +
        `Recovery: the host must inject ${XYZ_DATA_DIR_ENV} into the engine process env ` +
        `(xyz-agent runtime / pi extension host do this at spawn), or pass ` +
        `{ fallbackDataRoot } when calling resolveEngineDataDir from a host that resolves the data root itself.`,
    );
  }

  if (!getWarnedSlot().current) {
    getWarnedSlot().current = true;
    const warn = opts.warn ?? defaultWarn;
    warn(
      `[engine-data-dir] ${XYZ_DATA_DIR_ENV} is not set; engine journal/pool fall back to the injected data root ` +
        `(${fallback}). The xyz-agent host normally injects this env — if you are running inside xyz-agent, ` +
        `check the runtime spawn env; standalone installs intentionally use the injected root.`,
    );
  }
  return fallback;
}

function defaultWarn(msg: string): void {
  logger.warn(msg);
}
