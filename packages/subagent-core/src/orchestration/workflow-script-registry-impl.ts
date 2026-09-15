/**
 * Workflow Extension — WorkflowScriptRegistryImpl
 *
 * WorkflowScriptRegistry port 的 Infra 实现。
 *
 * 职责：扫描 .pi/workflows/ + ~/.pi/agent/workflows/ 目录，按 regex 提取
 * meta（不执行用户代码），按 tmp>project>user 优先级去重，60s TTL 缓存。
 *
 * 层归属：Infra（D-12）。implements Engine 层的 WorkflowScriptRegistry port。
 *
 * 设计：
 * - WorkflowScriptRegistryImpl 是 port 的实现，但底层扫描/缓存/去重仍委托
 * config-loader.ts 的 loadWorkflows/getWorkflow/invalidateCache 自由函数
 * （config-loader 是稳定 Infra 工具，registry 在其上包装为 WorkflowScript 实体）。
 * - 返回 WorkflowScript 实体（而非裸 CachedWorkflowMeta）。
 * - get(name) 精确匹配；fuzzy 匹配由 Interface 层 tool 负责。
 */

import { WorkflowScript } from "./models/workflow-script.ts";
import { getCachedFileContent } from "../shared/resource-discovery.ts";
import type { WorkflowScriptRegistry } from "./models/workflow-script-registry.ts";
import {
  type CachedWorkflowMeta,
  discoverWorkflows,
  getWorkflow,
  getWorkflowByPath,
  invalidateCache,
  loadWorkflows,
  type WorkflowScanConfig,
} from "./config-loader.ts";

// ── barrel 导出面（sink 设计 U1：WorkflowScript 实体 + 按路径加载工厂）──

// WorkflowScript 类（实体：sourceCode/validate/toExecutable 收敛）导出给 barrel
// re-export——第三宿主仅凭导出面即可消费实体（G3），不再鸭子复刻整类（§2.2 A2）。
export { WorkflowScript };

/**
 * 按绝对路径加载单个 workflow 脚本的自由函数工厂（U1）。
 *
 * 与 `new WorkflowScriptRegistryImpl().getPath(path)` 等价的无状态形态：barrel
 * 消费面（zsw vendor / 第三宿主）不暴露 registry 实例时的一次性加载入口。底层走
 * getWorkflowByPath 的 60s TTL 缓存与 m5 mtime 缓存层，重复调用不重复读盘。
 *
 * 返回 undefined：引用非法（相对路径 / 非 .js / 含 `..` 段——normalizeRef 拒绝）。
 * 返回 available=false 的 stub：文件不可读或 meta 提取失败（loader never throws）。
 */
export async function loadWorkflowScriptByPath(
  path: string,
): Promise<WorkflowScript | undefined> {
  return new WorkflowScriptRegistryImpl().getPath(path);
}

// ── WorkflowScriptRegistryImpl ───────────────────────────────

/**
 * WorkflowScriptRegistry port 的 Infra 实现。
 *
 * @param config 可选扫描配置。传入时 registry 只扫 config 声明的目录
 *              （测试隔离用）；省略时走生产默认（全局 ~/.pi/agent/* 目录）。
 */
export class WorkflowScriptRegistryImpl implements WorkflowScriptRegistry {
  constructor(private readonly config?: WorkflowScanConfig) {}

  /**
	 * 扫描所有 workflow 脚本（project + user + tmp），按 tmp>project>user 优先级
	 * 去重，返回 WorkflowScript 实体数组（含 available=false 的解析失败项）。
	 *
	 * 60s TTL 缓存——同 workspace 60s 内重复调用走缓存。
	 */
  async loadAll(): Promise<WorkflowScript[]> {
    const metas = this.config
      ? await discoverWorkflows(this.config)
      : await loadWorkflows();
    return metas.map((m) => this.toScript(m));
  }

  /**
	 * 按名查单个脚本。精确匹配。
	 * 返回 undefined 当 name 不存在。
	 *
	 * 注：fuzzy 匹配由 Interface 层 tool-workflow负责——registry 只做精确查。
	 *
	 * 性能注记：无 config（生产路径）时走 getWorkflow 的 60s TTL 单条缓存。
	 * 有 config（测试隔离）时退化为每次 discoverWorkflows 全扫——测试场景
	 * 可接受，生产路径不受影响。
	 */
  async get(name: string): Promise<WorkflowScript | undefined> {
    const meta = this.config
      ? (await discoverWorkflows(this.config)).find((w) => w.name === name)
      : await getWorkflow(name);
    return meta ? this.toScript(meta) : undefined;
  }

  /**
  * 按绝对路径加载单个脚本（S2 路径统一）。任意路径（不限扫描源）。
  * 供 workflow tool 的 run/info（name 参数 = workflowRef）。
  */
  async getPath(ref: string): Promise<WorkflowScript | undefined> {
    const meta = await getWorkflowByPath(ref);
    return meta ? this.toScript(meta) : undefined;
  }

  /** 失效缓存——下次 loadAll/get 重新扫描文件系统。 */
  invalidate(): void {
    invalidateCache();
  }

  /**
 * 把 CachedWorkflowMeta 转换为 WorkflowScript 实体。
 *
 * m2：整对象透传——m 已是 WorkflowMeta（CachedWorkflowMeta extends WorkflowMeta），
 * 直接传 meta: m，不再 {name,description,phases} 重建。消灭第 3 处重映射，
 * parameters/usage/when/notFor 一路流到 script.meta。
 *
 * sourceCode 在此 readFile 填充（FR-2：registry 是唯一读文件处）。
 * available：meta 提取失败或文件不可读时为 false。
 */
  private toScript(m: CachedWorkflowMeta): WorkflowScript {
    // FR-2: registry 是唯一读文件处。readFileSync 填 sourceCode —— 这样 launcher/tool
    // 直接调 toExecutable/validate 即可，无需各自 readFile（避免重复读，60s TTL 缓存生效）。
    let sourceCode = "";
    let available = m.available;
    if (available) {
      try {
        const cachedContent = getCachedFileContent(m.path); // m5：统一 mtime 缓存层
        if (cachedContent === null) {
          // ENOENT/不可读竞态 → available=false（exec-review major-3：?? '' 会静默
          // 返回空源码 workflow——恢复旧 readFileSync throw → catch → available=false 语义）
          sourceCode = "";
          available = false;
        } else {
          sourceCode = cachedContent;
        }
      } catch {
        // 文件不可读（race condition 删除、权限等）——标 available=false，
        // 与 meta 提取失败的现有语义一致（loader "never throws"）。
        sourceCode = "";
        available = false;
      }
    }
    return new WorkflowScript({
      name: m.name,
      source: m.source,
      path: m.path,
      sourceCode,
      // meta: m 整对象透传（m2 决策）：故意不做显式投影——投影会重引入
      // {name,description,phases} 解构重映射反模式（m2 消灭的丢字段 bug）。
      // CachedWorkflowMeta 多带的 path/available/source 是良性泄漏（无消费者
      // 序列化 script.meta）；若未来有消费者，改为组合式 { meta, path, ... } 而非投影。
      meta: m,
      available,
    });
  }
}
