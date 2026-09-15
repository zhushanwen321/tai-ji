// src/shared/injection-render.ts
//
// 三段 XML 注入渲染（<available_subagents> / <available_workflows> /
// <available_provider_models>）——从 pi-sw 插件层下沉的平台无关纯函数
// （convergence D-3）。渲染骨架 escapeXml/renderXmlSection 见同目录
// xml-injection.ts。pi 侧原函数曾内嵌于三 injector（基线 5557e109b，C5 起改调
// 本模块，逐字节等价证据见
// docs/design/subagent-core-convergence.probe-a2-baseline.md）。
//
// 与 pi-sw 原实现的差异（本模块定约）：
// - guide 文案必填注入：core 不内嵌任何平台文案，宿主（pi-sw / zsw）各自传入；
// - ModelEntry 并集口径：除 id/name 外全字段 optional（红线 5）——undefined
//   消费点显式守卫（input 缺席不抛、contextWindow 缺席不渲染该元素、
//   provider 缺席/空串时 id 裸渲染），不是自然降级；
// - 分段条目预算：subagents/workflows 可传 maxEntries，超限按排序键码点序
//   截尾 + 追加宿主注入的兜底指引行（红线 7：内置条目无截断豁免，不做
//   「内置优先保留」两段式）；models 段无预算参数，完整渲染永不截（设计钉死）；
// - format 内部先排后截：pi 调用链数据已排时重排幂等，不破坏「pi 现调用
//   形态下输出逐字节等价」（CA2 快照验收前提）。
//
// 设计权威源：docs/design/subagent-core-convergence.md §3.2 D-3 / §3.3 红线 5、7。

import { escapeXml, renderXmlSection } from "./xml-injection.ts";

/** 从 agent .md frontmatter 提取的最小 agent 信息（随 D-3 从 pi-sw 下沉） */
export interface AgentEntry {
	name: string;
	description: string;
	when?: string;
	examples?: Array<{ match: string; action: string; positive: boolean }>;
	/** agentRef：agent .md 文件的绝对路径（注入段 <location>，模型直接引用） */
	path: string;
}

/** 解析后的 workflow 条目（name + 摘要后的 description + 脚本路径） */
export interface WorkflowEntry {
	name: string;
	description: string;
	/** workflowRef：脚本 .js 文件的绝对路径（注入段 <location>，模型直接引用） */
	path: string;
}

/** reasoning 对象形态（zsw 投影的档位结构）；渲染面仅按 truthy 消费，字段值不进输出 */
export interface ModelReasoningInfo {
	variants?: unknown[];
	defaultVariant?: unknown;
}

/**
 * 注入段的最小模型投影——pi 与 zsw 两侧数据形态的并集（D-3 + 本仓 provider 补充）：
 * id/name 为条目最小必填（缺则无渲染意义），其余字段 optional（红线 5）。
 * - pi 投影：provider/reasoning:boolean/input[]/contextWindow 全给；
 * - zsw 投影：reasoning:{variants} 档位对象、input 缺席；
 * - label 与 reasoning.variants 进类型并集但渲染面暂不消费（宿主按需再扩）。
 */
export interface ModelEntry {
	id: string;
	name: string;
	provider?: string;
	label?: string;
	contextWindow?: number;
	reasoning?: boolean | ModelReasoningInfo;
	input?: string[];
}

/** 条目段（subagents/workflows）渲染选项：guide 宿主注入 + 可选条目预算 */
export interface ListFormatOptions {
	/** 注入段引导文案——必填，core 不内嵌平台文案（D-3 guide 参数化） */
	guide: string;
	/**
	 * 条目预算上限：超限按排序键码点序截尾（保留靠前条目）。缺省不限制
	 * （pi 现行为全量）。models 段无此参数（永不截，设计钉死）。
	 */
	maxEntries?: number;
	/** 截断发生时在段末追加的兜底指引行（宿主注入，如查看全量的命令）；未提供则不追加 */
	truncationNotice?: string;
}

/** models 段渲染选项：仅 guide——无条目预算（完整渲染永不截，D-3 钉死） */
export interface ModelListFormatOptions {
	guide: string;
}

/**
 * 码点序排序（显式契约，禁 localeCompare——宿主 locale 差异会破坏跨环境
 * 字节一致；注入段进每 turn system prompt，顺序必须与枚举序解耦）。
 * 非变异：返回排序副本，入参数组不动（core 纯函数定位；截尾语义依赖此序）。
 */
export function sortByCodepoint<T>(
  items: readonly T[],
  key: (item: T) => string,
): T[] {
  return [...items].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

/** 注入段中单个 workflow 的最大描述长度（控制每 turn prompt 体积） */
const MAX_DESC_LEN = 160;

/** 断句阈值比例：句末标点位置须 >= maxLen 的 40% 才采用，否则硬截断保留更多信息 */
const DESC_BOUNDARY_MIN_RATIO = 0.4;

/**
 * 将 workflow description 截断为 prompt 友好的摘要。
 * 优先在 limit 内的最后一个句末标点处断句；无合适断点则硬截断 + 省略号。
 */
export function summarizeDescription(
  desc: string,
  maxLen = MAX_DESC_LEN,
): string {
  const trimmed = desc.trim();
  if (trimmed.length <= maxLen) return trimmed;
  const slice = trimmed.slice(0, maxLen);
  const boundary = Math.max(
    slice.lastIndexOf("。"),
    slice.lastIndexOf("；"),
    slice.lastIndexOf(";"),
    slice.lastIndexOf(". "),
  );
  // 断点过靠前（< 阈值比例）时不采用，改硬截断保留更多信息
  if (boundary > maxLen * DESC_BOUNDARY_MIN_RATIO) return slice.slice(0, boundary + 1);
  return `${slice}…`;
}

/**
 * 排序后应用条目预算：超限截尾（保留码点序靠前条目）。返回保留条目与是否截断。
 * 红线 7：内置条目无截断豁免——不做「内置优先保留」两段式。
 */
function applyEntryBudget<T>(
  sorted: T[],
  maxEntries: number | undefined,
): { kept: T[]; truncated: boolean } {
  if (maxEntries === undefined || sorted.length <= maxEntries) {
    return { kept: sorted, truncated: false };
  }
  return { kept: sorted.slice(0, maxEntries), truncated: true };
}

/**
 * 将 agent 列表格式化为 XML 注入段。
 *
 * 内部先按 name 码点序排序再渲染截断（超预算截尾语义依赖码点序；pi 调用链
 * 数据已排时重排幂等，不破坏与 pi 现输出的逐字节等价）。空列表返回空串
 * （不注入）；预算截断发生时在段末追加宿主注入的兜底指引行（缺省不追加）。
 */
export function formatAgentList(
  agents: AgentEntry[],
  opts: ListFormatOptions,
): string {
  if (agents.length === 0) return "";

  const sorted = sortByCodepoint(agents, (a) => a.name);
  const { kept, truncated } = applyEntryBudget(sorted, opts.maxEntries);

  const items = kept.map((agent) => {
    let block = `  <agent><name>${escapeXml(agent.name)}</name><description>${escapeXml(agent.description)}</description>`;
    // 路由样本（when + examples 正反原样渲染——negative 的 action 由作者写
    // 「不调用（原因）」，渲染器不硬编码；全部内容 escapeXml 防 XML 注入段破坏）
    if (agent.when) {
      block += `<when>${escapeXml(agent.when)}</when>`;
    }
    if (agent.examples && agent.examples.length > 0) {
      const exampleLines = agent.examples.map(
        (e) => `      - "${escapeXml(e.match)}" → ${escapeXml(e.action)}`,
      );
      block += `\n    <examples>\n${exampleLines.join("\n")}\n    </examples>`;
    }
    block += `<location>${escapeXml(agent.path)}</location></agent>`;
    return block;
  });
  if (truncated && opts.truncationNotice !== undefined) {
    items.push(opts.truncationNotice);
  }
  return renderXmlSection({
    tag: "available_subagents",
    guide: opts.guide,
    items,
  });
}

/**
 * 将 workflow 列表格式化为 XML 注入段。
 *
 * 与 formatAgentList 同约：先按 name 码点序排序再渲染截尾；空列表返回空串
 * （不注入）；截断时追加宿主注入的兜底指引行（缺省不追加）。
 */
export function formatWorkflowList(
  workflows: WorkflowEntry[],
  opts: ListFormatOptions,
): string {
  if (workflows.length === 0) return "";

  const sorted = sortByCodepoint(workflows, (w) => w.name);
  const { kept, truncated } = applyEntryBudget(sorted, opts.maxEntries);

  const items = kept.map((wf) =>
    `  <workflow><name>${escapeXml(wf.name)}</name><description>${escapeXml(wf.description)}</description><location>${escapeXml(wf.path)}</location></workflow>`,
  );
  if (truncated && opts.truncationNotice !== undefined) {
    items.push(opts.truncationNotice);
  }
  return renderXmlSection({
    tag: "available_workflows",
    guide: opts.guide,
    items,
  });
}

/** 码点序比较（显式契约，禁 localeCompare——同 sortByCodepoint 注释） */
function compareByCodepoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * models 段排序：provider 归一为非空串参与比较（缺席/空串 → ""）——
 * pi 投影（provider 全给且非空）下与 pi 现实现 (provider, id) 两段码点序一致；
 * zsw 投影（provider 缺席）整体退化为 id 码点序；混合形态下无 provider 条目
 * 排最前（空串码点最小），口径确定可复现。
 */
function compareModelEntries(a: ModelEntry, b: ModelEntry): number {
  const pa = a.provider ?? "";
  const pb = b.provider ?? "";
  return pa === pb
    ? compareByCodepoint(a.id, b.id)
    : compareByCodepoint(pa, pb);
}

/**
 * 能力标记：reasoning truthy（布尔 true 或对象形态——zsw 的 {variants} 投影）
 * → "reasoning"；input 含 image → "vision"。空则省略 caps 段。
 * 红线 5 守卫：input 缺席经 optional chaining 不抛（pi 版此处对 undefined 抛
 * TypeError，本仓 L73 已核实）。
 */
function formatCaps(entry: ModelEntry): string {
  const caps: string[] = [];
  if (entry.reasoning) caps.push("reasoning");
  if (entry.input?.includes("image") ?? false) caps.push("vision");
  return caps.join(",");
}

/**
 * 将模型列表格式化为 XML 注入段。
 *
 * 输入按归一 (provider, id) 码点序排序（见 compareModelEntries）——同一数据集
 * 输出字节稳定（KV-cache 契约）。空列表返回空串（不注入）。
 * models 段无条目预算（完整渲染永不截，D-3 钉死）。
 * 红线 5 守卫：contextWindow 缺席不渲染该元素（不输出 "undefined" 垃圾）；
 * provider 缺席/空串时 id 裸渲染。
 */
export function formatModelList(
  models: ModelEntry[],
  opts: ModelListFormatOptions,
): string {
  if (models.length === 0) return "";

  const sorted = [...models].sort(compareModelEntries);

  const items = sorted.map((m) => {
    const caps = formatCaps(m);
    const idText = m.provider ? `${m.provider}/${m.id}` : m.id;
    return (
      `  <model><id>${escapeXml(idText)}</id>`
				+ `<name>${escapeXml(m.name)}</name>`
				+ (caps ? `<caps>${caps}</caps>` : "")
				+ (m.contextWindow !== undefined
				  ? `<contextWindow>${m.contextWindow}</contextWindow>`
				  : "")
				+ `</model>`
    );
  });
  return renderXmlSection({
    tag: "available_provider_models",
    guide: opts.guide,
    items,
  });
}
