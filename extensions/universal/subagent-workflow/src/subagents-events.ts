/**
 * subagents-events — subagents 域父级联事件 handler（/fork /new 级联关闭）。
 *
 * 原内联在 workflow-events.ts 装配 seam（跨域 handler 迁出，原样搬移——行为与
 * 日志文案逐字保留）；级联关闭的对象是 SubagentService 的 record 池，与 workflow
 * 域装配零数据耦合。由 setupWorkflowDomain 在原注册位置调用
 * setupSubagentsCascadeEvents（pi.on 注册顺序逐位不变，
 * workflow-events-registration-order.test.ts 锁定）。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getLogger } from "@zhushanwen/pi-extension-logger";
import { getSubagentService } from "@zhushanwen/subagent-core";

// 模块级 logger（与 index.ts 同 component 名；setPiHandle 注入后自动走 appendEntry）
const logger = getLogger("subagents");

/**
 * SP-4: 注册父级联关闭事件（/fork 与 /new）。
 *
 * 主 session /fork 或 /new 时，清理旧 record（disposeAllRecords：CAS 转终态 +
 * archive + worktree 清理）。before 事件在 session 替换前触发，确保旧 session 的
 * subagent 在新 session 创建前被清理（随后的 session_shutdown → dispose 收割子进程）。
 *
 * [M2 修复] 旧实现把 /new 级联挂在 session_before_tree 上——SDK 中该事件只由
 * AgentSession.navigateTree()（/tree 同 session 分支切换）触发，/new 走
 * session_before_switch(reason:"new") + session_shutdown(reason:"new")，从不触发
 * before_tree。后果双向：/new 级联是死代码；普通 /tree 分支导航反而误杀全部活跃
 * subagent。现 /new 改挂 session_before_switch(reason==="new")，before_tree handler
 * 移除（/tree 是同 session 内导航，record/子进程归属不变，无级联关闭诉求）。
 */
export function setupSubagentsCascadeEvents(pi: ExtensionAPI): void {
  pi.on("session_before_fork", (_event, _ctx) => {
    const service = getSubagentService();
    if (service) {
      const count = service.onParentFork();
      if (count > 0) {
        logger.warn(`[subagents] /fork 级联关闭 ${count} 个 subagent`);
      }
    }
  });

  pi.on("session_before_switch", (event, _ctx) => {
    // /new（reason:"new"）创建全新 session → 级联关闭旧 record。
    // reason:"resume"（/resume /import 回到已有 session）不级联：record 按 rootSessionId
    // 归属隔离，跨 session 读写由 store 过滤守卫，无需销毁。
    if (event.reason !== "new") return;
    const service = getSubagentService();
    if (service) {
      const count = service.onParentNew();
      if (count > 0) {
        logger.warn(`[subagents] /new 级联关闭 ${count} 个 subagent`);
      }
    }
  });
}
