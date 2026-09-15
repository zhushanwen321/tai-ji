/**
 * Workflow Extension — WorkflowScriptRegistry 仓库接口
 *
 * workflow 脚本的仓库（repository）接口——Engine 定义、Infra 实现。
 *
 * 与 Ports 节的 3 个注入 port（AgentRunner/RunStore/WorkerHost）的区别：
 * - 3 个 port 是"执行依赖"（子进程/文件系统/线程），注入到 LifecycleDeps
 * - WorkflowScriptRegistry 是"发现依赖"（扫描文件系统），是 repository（§8），
 * 不进 LifecycleDeps，由 Interface 层 tool 直接调用（list/get 脚本）
 *
 * 优先级：tmp > project > user（domain-models.md §8）。60s TTL，按 workspaceRoot 分桶。
 * 实现在 Infra 层 WorkflowScriptRegistryImpl（扫描 + 缓存 + 去重）。
 *
 * 层归属：Engine（interface），Infra（impl）。
 *
 * 参考：domain-models.md §8。
 */
import type { WorkflowScript } from "./workflow-script.ts";

/**
 * workflow 脚本仓库接口（repository，需 mock 文件扫描）。
 */
export interface WorkflowScriptRegistry {
 /** 扫描并返回所有 workflow 脚本（含 available=false 的解析失败项）。去重按 tmp>project>user。 */
  loadAll(): Promise<WorkflowScript[]>;

 /** 按名查单个脚本（含缓存）。返回 undefined 当 name 不存在。 */
  get(name: string): Promise<WorkflowScript | undefined>;

 /** 按绝对路径加载单个脚本（workflowRef 统一解析入口——S2 路径统一）。 */
  getPath(ref: string): Promise<WorkflowScript | undefined>;

 /** 失效缓存——下次 loadAll/get 重新扫描文件系统。 */
  invalidate(): void;
}
