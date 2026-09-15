/**
 * ResourceMeta — 资源元数据统一类型族（v5 §4.1 / DM1）
 *
 * workflow 与 agent 两类资源共用同一数据格式（YAML），仅 kind 判别 + 专属字段不同。
 * skills 显式 out-of-scope（归 pi core）。
 *
 * 设计：
 * - 整对象透传——config-loader.toCachedMeta / registry-impl.toScript 改为 meta: parsedMeta
 *   不再 {name,description,phases} 解构重建（消灭 3 重映射丢字段 bug）。
 * - workflow 的 parameters（JSON Schema）由 args-validator（m3）按 schema 校验 args；
 *   usage（markdown）覆盖 schema 表达不了的语义约束 + 真实合法示例命令。
 * - agent 的 tools/model 供 AgentRegistry 执行侧 spawn 子进程用，不进 system prompt 注入段。
 *
 * 层归属：shared（L1 统一资源模型）。
 */

/** 资源种类。skills 归 pi core，本 extension 仅 workflow + agent。 */
export type ResourceKind = "workflow" | "agent";

/** 两类资源共有的路由字段。 */
export interface ResourceMetaBase {
  kind: ResourceKind;
  /** 路由用一句话（受 SSOT lint W1/W2 约束：≤200 字符、不含参数引用语法）。 */
  name: string;
  description: string;
  /** "Use when ..." 正向路由提示（PromptBudget 最后保）。 */
  when?: string;
  /** "Not for ..." 负向路由提示。 */
  notFor?: string;
}

/** workflow 专属：phases + 参数契约 + 语义说明。 */
export interface WorkflowMeta extends ResourceMetaBase {
  kind: "workflow";
  phases: (string | { title: string; detail?: string })[];
  /** 参数契约（JSON Schema draft-07）。未声明则 $ARGS 透传不校验（向后兼容）。 */
  parameters?: Record<string, unknown>;
  /** markdown，覆盖 schema 表达不了的语义约束 + 真实合法示例命令。 */
  usage?: string;
}

/** agent 路由样本（结构化，非嵌入 description 字符串）。 */
export interface RoutingExample {
  match: string;
  action: string;
  /** true=应触发，false=不应触发（正反各一）。 */
  positive: boolean;
}

/** agent 专属：路由样本 + 执行配置。 */
export interface AgentMeta extends ResourceMetaBase {
  kind: "agent";
  examples?: RoutingExample[];
  /** 供 AgentRegistry 执行侧 spawn 时注入，不进 system prompt 注入段。 */
  tools?: string[];
  model?: string;
  /**
   * 执行引擎 id（D9 per-agent 主通道：调用参数 engine > 本字段 > 全局默认）。
   * 与 model 字段同风格——路由字段（不进 system prompt），执行侧（P4 路由层）消费。
   */
  engine?: string;
  /**
   * 执行预算：turn 上限（sink 设计 D3 新增可选执行字段之一）。
   * 消费优先级：显式参数 > 本字段 > 缺省——pi 工具参数 maxTurns 语义不变（本字段
   * 对 pi 是清单元数据），zsw 决策链 timeoutMs > profile.maxTurns > 缺省。
   */
  maxTurns?: number;
  /** tool denylist（D3 可选执行字段）：spawn 侧剔除，与 tools allowlist 正交。 */
  disallowedTools?: string[];
  /**
   * agent 声明依赖的 skill 名清单（D3 可选执行字段）。注意与本文件头注
   * 「skills 归 pi core」的 skills（资源种类）不同物：此处是 agent frontmatter 的
   * 执行配置字段，不是 ResourceKind。
   */
  skills?: string[];
}

/** 判别联合（kind 判别）。 */
export type ResourceMeta = WorkflowMeta | AgentMeta;
