/**
 * model-events — model 域事件 handler（主 agent 模型切换的缓存刷新）。
 *
 * 原内联在 workflow-events.ts 装配 seam（跨域 handler 迁出，原样搬移——行为与
 * 日志文案逐字保留）；ModelConfigService 缓存是 model 域状态，与 workflow 域
 * 装配零数据耦合。由 setupWorkflowDomain 在原注册位置调用 setupModelEvents
 * （pi.on 注册顺序逐位不变，workflow-events-registration-order.test.ts 锁定）。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getLogger } from "@zhushanwen/pi-extension-logger";
import { getModelConfigService } from "@zhushanwen/subagent-core";

// 模块级 logger（与 index.ts 同 component 名；setPiHandle 注入后自动走 appendEntry）
const logger = getLogger("subagents");

/**
 * 注册 model 域事件：用户切换 model 时刷新 ModelConfigService 缓存。
 */
export function setupModelEvents(pi: ExtensionAPI): void {
  pi.on("model_select", (event) => {
    const service = getModelConfigService();
    if (service && typeof service.setCtxModel === "function") {
      service.setCtxModel(event.model);
    } else {
      // [C2] 不再静默：service 缺席（session_start 装配链失败）时模型切换缓存未
      // 刷新，后续 resolveModel 会用旧模型——warn 留痕接通「现象 → 根因」链路。
      // model_select 是低频用户操作，不会刷屏。
      logger.warn(
        "[subagent-workflow] model_select ignored: model config service not initialized (session_start assembly failed) — model switch will not take effect for new subagents until session reload",
        { model: event.model },
      );
    }
  });
}
