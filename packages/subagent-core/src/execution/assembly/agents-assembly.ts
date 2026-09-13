// src/execution/assembly/agents-assembly.ts
//
// agent 装配函数（sink 设计 U2 / A6）：发现 → parseAgentProfile → frontmatter name
// 去重 → 码点序，warn 口径内聚。workflow 侧 discoverWorkflows（config-loader）的
// 对称面——第三宿主仅凭该函数即可「列 agents」（G3/S5），无需复刻装配循环。
//
// 与 pi 壳装配循环（subagent-list-injector.discoverAllAgents）的等值口径：
// - 清单可见性 = IF1 严格层（profile.meta !== null）——缺 name/description 的资产
//   不进清单（注入投影「路由可见性」双轨语义，D3 定稿；宽容解析只服务执行消费面）；
// - warn 口径内聚：仅「有 frontmatter 但严格校验未通过」才 warn——README 等无
//   frontmatter 的 .md 静默跳过（每 turn 扫描不刷屏，pi m5 评审先例）；
// - 扫描 / 遮蔽语义归 shared/resource-discovery（ADR-031），本文件零扫描逻辑。

import type { AgentEntry } from "../../shared/injection-render.ts";
import { sortByCodepoint } from "../../shared/injection-render.ts";
import { discoverResources, getCachedFileContent } from "../../shared/resource-discovery.ts";
import type { DiscoveryRoot } from "../../core/host-services.ts";
import { getLogger } from "../../core/logger.ts";
import { parseAgentProfile } from "./agent-registry.ts";

const logger = getLogger("agents-assembly");

/**
 * 发现并列出全部可用 agent（U2/A6 装配函数）。
 *
 * 流程：discoverResources（按优先级低→高，last-writer-wins）→ 逐文件
 * parseAgentProfile → 仅 IF1 严格层通过（profile.meta !== null）的条目进清单 →
 * 按 frontmatter name 去重（高优先级靠后覆盖，Map 后写胜）→ name 码点序输出
 * （KV-cache 契约：顺序与 readdir 枚举序解耦，重建结果逐字节一致）。
 *
 * 抛错面（如实声明）：单文件读失败仅记日志跳过；目录不存在返回空列表；但底层
 * discoverResources 的不可恢复扫描错误会原样向上传播（readdir 遇权限拒绝、
 * EMFILE 竞态等——resource-discovery 自述 "Throws on unrecoverable scan errors"，
 * Promise.all 首个 reject 即整体拒绝），调用方需自行兜底。
 *
 * @param workspaceRoot 项目根（findWorkspaceRoot 推导结果）
 * @param hostRoots 宿主注入发现根（pi 壳 = getAgentDir 三根；无则传 []——
 *                  user-agents/project-agents 硬编码槽仍生效，与 ScanConfig 语义一致）。
 *                  注意：hostRoots 之外还有四个硬编码根恒进入扫描，无法经参数关闭——
 *                  `~/.agents/agents`、`<workspaceRoot>/.pi/agents`、
 *                  `<workspaceRoot>/.agents/agents` 与 `XYZ_EXTENSION_PATHS`
 *                  环境变量展开的扩展源码路径（resource-discovery buildScanTargets
 *                  固定槽位，注入 hostRoots 只是增列而非替换扫描面）
 */
export async function discoverAgents(
  workspaceRoot: string,
  hostRoots: DiscoveryRoot[],
): Promise<AgentEntry[]> {
  const resources = await discoverResources({
    kind: "agents",
    workspaceRoot,
    hostRoots,
  });

  const agentMap = new Map<string, AgentEntry>();
  for (const resource of resources) {
    // manifest 校验失败的包整体占位（available=false），不进清单
    if (!resource.available) continue;

    const content = getCachedFileContent(resource.path);
    if (content === null) {
      // 单文件读失败不阻断整条 agent 列表装配
      logger.error(`[agents-assembly] skip unreadable agent file ${resource.path}`);
      continue;
    }

    // 宽容解析（执行消费面单点）；清单可见性按严格层 meta 判定
    const profile = parseAgentProfile(content, resource.path);
    if (profile.meta !== null) {
      agentMap.set(profile.name, {
        name: profile.name,
        description: profile.description,
        ...(profile.when !== undefined ? { when: profile.when } : {}),
        ...(profile.examples !== undefined ? { examples: profile.examples } : {}),
        path: resource.path,
      });
    } else if (content.trimStart().startsWith("---")) {
      // 仅「有 frontmatter 但严格校验未通过」才 warn——无 frontmatter 的 README 等
      // 普通 .md 静默跳过（pi m5 评审先例：缺 name/description 或单条 examples 非法
      // 致整体 reject 时作者需要知道，普通文档不需要）。
      logger.warn(
        `[agents-assembly] ${resource.path}: agent frontmatter 解析失败（IF1 校验不通过）——agent 未进清单`,
      );
    }
  }

  return sortByCodepoint([...agentMap.values()], (a) => a.name);
}
