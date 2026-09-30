/**
 * Workflow Extension — launcher
 *
 * workflow 拒单文案单点（workflowNotFoundMessage / formatAvailableWorkflowRefs）。
 *
 * 历史上的 runAndWait（同步阻塞至终态的编程入口）与 executeNestedWorkflow
 * （脚本内 workflow() 嵌套调用实现）已整族删除（嵌套 workflow() 编排 API 退役，
 * 审计 C-1/C-2 + A-1）：脚本内只经 agent()/parallel()/pipeline() 编排，run 的
 * 启动面收敛为 workflow tool 的 actionRun（fire-and-forget + 完成通知）。
 *
 * 层归属：Engine。依赖 registry（脚本发现）。
 */

import type { LifecycleDeps } from "./models/ports.ts";
import type { WorkflowScript } from "./models/workflow-script.ts";
import type { WorkflowScriptRegistry } from "./models/workflow-script-registry.ts";

/**
 * Launcher 依赖：LifecycleDeps + registry（脚本发现）。
 *
 * registry 是「发现依赖」（文件系统扫描），与 LifecycleDeps 的 3 个 port
 * （执行依赖：子进程/线程/持久化）性质不同——故单独扩展，不进 LifecycleDeps。
 */
export interface LauncherDeps extends LifecycleDeps {
 /** workflow 脚本仓库。 */
  registry: WorkflowScriptRegistry;
}

/**
 * 可用 workflow 清单 item 模板单源。每项一行起头（可选 [source] 标签 + name +
 * ":" + description），includeLocation 时追加缩进 location 绝对路径行——按名解析
 * 已退役，location 是唯一可派发形态。
 *
 * 该模板是三个 render 点的共同底座（available filter 与 item 行拼接只许在这里）：
 * - run 拒单（workflowNotFoundMessage，缺省形态）
 * - 壳 workflow-script lint 的 not-found 清单（缺省形态——与 run 拒单有意统一，
 *   清单带 location 行，LLM 自纠指引一致）
 * - 壳 workflow-script list 的 actionList（includeSource:true / includeLocation:false
 *   ——source 标签保留、分隔符统一为 ":"）。标题与空态文案属调用点语境，不在此。
 *
 * 缺省参数组合的输出与历史 run 拒单格式逐字节一致（既有测试锁定）。
 *
 * @param opts 两个布尔选项，缺省 includeLocation=true / includeSource=false。
 *   出现第三个选项的需求时先停下——这层刻意只表达「行内投影裁剪」这一个变化轴。
 */
export function formatAvailableWorkflowRefs(
  all: readonly WorkflowScript[],
  opts?: { includeLocation?: boolean; includeSource?: boolean },
): string {
  const includeLocation = opts?.includeLocation ?? true;
  const includeSource = opts?.includeSource ?? false;
  return all
    .filter((wf) => wf.available)
    .map((wf) => {
      const sourceTag = includeSource ? `[${wf.source}] ` : "";
      const locationLine = includeLocation ? `\n    location: ${wf.path}` : "";
      return `  - ${sourceTag}${wf.name}: ${wf.meta.description || "(no description)"}${locationLine}`;
    })
    .join("\n");
}

/**
 * not found 拒单文案单点（extension 顶层 workflow tool 的 run action 消费）：
 * 清单来自 registry.loadAll() 现扫快照——调用方最贴近的可行动面，失败一次即可
 * 按 location 自救。
 */
export async function workflowNotFoundMessage(name: string, deps: LauncherDeps): Promise<string> {
  const all = await deps.registry.loadAll();
  return (
    `Workflow '${name}' not found. Available (name — use the absolute location path as 'name' when the bare name is rejected):\n` +
    `${formatAvailableWorkflowRefs(all) || "  (none)"}`
  );
}
