/**
 * Resource List Injector 工厂（dual-track convergence D7-②）
 *
 * subagent / workflow 两个资源清单 injector 的同构骨架单实现（原两文件逐字同构的
 * 缓存对 / 唯一写点 / 发现函数 / 三 handler 收敛于此，改 fallback 策略只改一处）：
 * - 缓存对：entries + 渲染快照。per-process = per-session——taiji session-pool
 *   模型下每 pi 子进程 = 一 session = 独立扩展实例，闭包级缓存天然 per-session 隔离
 *   （split mode 多 session 各自独立进程）。渲染快照与数据缓存同步更新：before_agent_start
 *   每个 turn 都要注入，format（escapeXml 多趟正则 × 全部字段）在数据不变时输出完全
 *   相同——渲染一次随缓存复用，turn 热路径零重复计算。
 * - 唯一写点 setCache：数据与渲染缓存同步更新（null 清空两者）。
 * - 三 handler 自管缓存生命周期（不耦合 index.ts session 逻辑）：
 *   session_start（含 reload）发现+覆盖缓存（刷新节奏对齐 pi skill，fail-safe 异常
 *   不阻断、缓存保持 null）；before_agent_start 读缓存渲染注入、miss（session_start
 *   未触发/缓存被清）则 fallback 重新发现+赋值，空发现渲染空态段（D4-2：(none
 *   discovered; roots: ...)，不再整段消失；invalids 随段具名呈现——D4-3 损坏文件
 *   不静默），任何异常被吞掉（记日志）不阻断 agent turn；session_shutdown 清缓存。
 *   pi 支持 async handler，同一 event 多 handler 链式（前者返回的 systemPrompt 作
 *   后者输入）。
 *
 * 两实例的真差异经 config 参数化承载：kind（发现种类 + discoveryRoots 宿主槽位）/
 * parse（单文件内容 → entry；workflow 侧 description 截断内聚于其 parse）/ format
 * （entries → XML 注入段；guide 文案差异内聚于各自 format）/ includeTmp（workflow 侧
 * 覆盖 .pi/workflows/.tmp/ generate 产物）/ logTag（错误日志前缀，保持既有可检索性）；
 * assemble（agent 侧真差异：装配循环覆写——U11 下沉 core discoverAgents 后工厂不重复
 * 装配语义，parse 不参与）。
 *
 * model-list-injector 不参与本工厂：数据源是 ModelRegistry 内存快照（真差异，无文件
 * 发现与缓存生命周期），见该文件头注释。
 */

import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ExtensionAPI,
	ExtensionContext,
	SessionShutdownEvent,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";

import { getLogger } from "@zhushanwen/pi-extension-logger";

import { getHostServices } from "@zhushanwen/subagent-core";

import {
	conventionRootDirs,
	discoverResources,
	findWorkspaceRoot,
	formatEmptyResourceList,
	getCachedParsed,
	sortByCodepoint,
	type InvalidResource,
} from "@zhushanwen/subagent-core";
import { toErrorMessage } from "@zhushanwen/pi-ext-guards";

const logger = getLogger("injector");

/** 清单条目最小契约：name（去重键 + 码点序排序键）+ path（<location> 注入，发现层填充）。 */
export interface ResourceListEntry {
	name: string;
	path: string;
}

/** discover 产物（P5 D4-3）：entries = 可用条目；invalids = 损坏文件具名上报
 *  （三处静默点收敛：available=false 占位 / meta 解析失败 / 文件读失败）。 */
export interface ResourceDiscoveryResult<TEntry extends ResourceListEntry> {
	entries: TEntry[];
	invalids: InvalidResource[];
}

/** 工厂参数（真差异承载面，见文件头）。 */
export interface ResourceListInjectorConfig<TEntry extends ResourceListEntry> {
	/** 发现种类（discoverResources kind + discoveryRoots 宿主槽位）。 */
	kind: "agents" | "workflows";
	/** 错误/发现失败日志前缀（如 "[subagent-list-injector]"）。 */
	logTag: string;
	/**
	 * 装配循环覆写：提供时工厂 discover 整体委托它（发现→解析→去重→排序 +
	 * warn/error 口径全归被委托方），工厂不再跑内置装配循环。agent 侧真差异：
	 * U11（sink 设计）装配算法单源 core discoverAgents（第三宿主免复刻 G3/S5），
	 * 壳侧收缩为「宿主注入根现取 + 委托」。此时 parse 不参与工厂装配，
	 * invalids 恒空（core discoverAgents 无 invalid 产出面）。
	 */
	assemble?: (workspaceRoot: string) => Promise<TEntry[]>;
	/** 单文件内容 → entry；null = 损坏文件（invalid 具名上报，D4-3）。assemble 覆写时不需要。 */
	parse?(content: string): TEntry | null;
	/**
	 * entry 列表 → 注入段；返回空串 = 空发现（工厂接管渲染 D4-2 空态段，invalids
	 * 随空态段具名呈现）。第二参 = invalid 具名上报（P5 D4-3），段内渲染点由
	 * 实例的 format 决定（workflow 实例透传 core formatWorkflowList 的 invalids 选项）。
	 */
	format(entries: TEntry[], invalids: readonly InvalidResource[]): string;
	/** workflow 侧真差异：包含 .pi/workflows/.tmp/（workflow-script generate 产物）。 */
	includeTmp?: boolean;
}

/** 工厂产物：setup 注册三 handler；discover 为发现函数（薄模块再导出）。 */
export interface ResourceListInjector<TEntry extends ResourceListEntry> {
	setup(pi: ExtensionAPI): void;
	discover(workspaceRoot: string): Promise<ResourceDiscoveryResult<TEntry>>;
}

/** 码点序排序契约见 core sortByCodepoint（KV-cache 契约：禁 localeCompare——宿主 locale 差异会破坏跨环境字节一致）。 */

/** kind 单数形态（错误日志文案用，保持与合并前逐字一致）。 */
function singularKind(kind: "agents" | "workflows"): string {
	return kind === "agents" ? "agent" : "workflow";
}

/**
 * 空态注入（D4-2）渲染的发现根清单：宿主注入根（discoveryRoots 槽，现取——
 * 实例隔离语义同 discover）+ core 约定根推导（conventionRootDirs 单源，含
 * includeTmp 的 .tmp 根）——本函数只做纯投影，不持有任何 join 字面。
 * TAIJI_EXTENSION_PATHS 刻意不列——taiji 内部 dev-link 通道，非 agent 自救面。
 * 清单是给 agent 的提示信息：顺序无优先级契约，保序去重由渲染函数保证
 * （同 turn 重建字节稳定，KV-cache 契约）。
 */
function discoveryRootDirs(
	workspaceRoot: string,
	kind: "agents" | "workflows",
	includeTmp: boolean,
): string[] {
	const hostRoots = getHostServices().discoveryRoots?.()?.[kind] ?? [];
	const roots = hostRoots.map((root) => root.dir);
	roots.push(...conventionRootDirs({ kind, workspaceRoot, includeTmp }));
	return roots;
}

export function createResourceListInjector<TEntry extends ResourceListEntry>(
	config: ResourceListInjectorConfig<TEntry>,
): ResourceListInjector<TEntry> {
	let discoveryCache: ResourceDiscoveryResult<TEntry> | null = null;
	let injectionCache: string | null = null;

	/**
	 * 缓存唯一写点：数据与渲染缓存同步更新（null 清空两者，此时 workspaceRoot
	 * 不消费）。空发现（format 返回空串——core formatXxxList 空列表的判据契约）
	 * 不再让注入段整段消失，改渲染空态段（D4-2）：agent 可区分「功能关闭」与
	 * 「确实没有」，roots 清单供自救；invalids 随空态段具名呈现（D4-3——条目为零
	 * 与存在损坏文件两个事实同段）。非空路径 format 输出原样缓存（invalids 缺省
	 * 逐字节零变更）。
	 */
	function setCache(
		result: ResourceDiscoveryResult<TEntry> | null,
		workspaceRoot: string,
	): void {
		discoveryCache = result;
		if (result === null) {
			injectionCache = null;
			return;
		}
		const rendered = config.format(result.entries, result.invalids);
		injectionCache = rendered !== ""
			? rendered
			: formatEmptyResourceList(
					config.kind,
					discoveryRootDirs(workspaceRoot, config.kind, config.includeTmp === true),
					result.invalids,
				);
	}

	/**
	 * 用统一资源发现（ADR-031）发现所有可用条目。永不抛错——发现本身 fail-safe，
	 * 单个文件读失败仅记日志（并 invalid 具名上报，不静默）。
	 *
	 * assemble 覆写时整体委托（agent 侧：core discoverAgents 单源装配，U11；
	 * invalids 恒空）；否则跑内置装配循环——
	 * discoverResources 返回按文件名 stem 去重、优先级合并后的 DiscoveredResource[]
	 * （project > user > builtin，返回顺序低→高优先级——Map 后写覆盖依赖此序，不可在
	 * 发现层重排）。此处逐个 parse 提取条目（经 getCachedParsed mtime 级缓存），再按
	 * name 去重（高优先级靠后，Map.set 后者覆盖前者，故最终保留最高优先级同名条目）。
	 *
	 * invalid 收集（P5 D4-3，三处原静默点）：available=false 占位（manifest 声明
	 * 路径缺失，reason 由发现层具名）/ parse null（文件在场但 meta 无效或缺失）/
	 * 读失败（reason = 错误消息，日志照记）。损坏文件从此在注入段具名可见，
	 * 不再静默跳过。
	 *
	 * 输出按 name 码点序排序（KV-cache 契约）：注入段进每 turn system prompt，顺序必须
	 * 与文件系统枚举序（readdir 无契约）解耦——目录内容不变时，session_start / fallback /
	 * resume 任意重建的渲染结果逐字节一致；仅条目增减时文本才变化。
	 */
	async function discover(workspaceRoot: string): Promise<ResourceDiscoveryResult<TEntry>> {
		if (config.assemble) {
			return { entries: await config.assemble(workspaceRoot), invalids: [] };
		}
		if (!config.parse) {
			throw new Error(
				`${config.logTag} invalid injector config: parse is required unless assemble is provided`,
			);
		}
		const resources = await discoverResources({
			kind: config.kind,
			workspaceRoot,
			// 宿主注入根现取（pi 壳 discoveryRoots 每次现取，实例隔离）；agentDir 形参
			// 已删——其唯一用途就是喂 ScanConfig（u0-data-discovery 偏差 #7）
			hostRoots: getHostServices().discoveryRoots?.()?.[config.kind] ?? [],
			...(config.includeTmp ? { includeTmp: true } : {}),
		});

		const map = new Map<string, TEntry>();
		const invalids: InvalidResource[] = [];
		for (const resource of resources) {
			if (!resource.available) {
				invalids.push({
					path: resource.path,
					reason: resource.reason ?? "unavailable",
				});
				continue;
			}
			try {
				const entry = getCachedParsed(resource.path, config.parse);
				if (entry) {
					map.set(entry.name, { ...entry, path: resource.path });
				} else {
					invalids.push({ path: resource.path, reason: "no valid resource metadata" });
				}
			} catch (err) {
				// 单个文件读失败不阻断整条清单注入；具名上报（D4-3）+ 日志照记
				invalids.push({ path: resource.path, reason: toErrorMessage(err) });
				logger.error(
					`${config.logTag} skip unreadable ${singularKind(config.kind)} file ${resource.path}`,
					{ reason: toErrorMessage(err) },
				);
			}
		}
		return { entries: sortByCodepoint([...map.values()], (entry) => entry.name), invalids };
	}

	function setup(pi: ExtensionAPI): void {
		pi.on(
			"session_start",
			async (_event: SessionStartEvent, ctx: ExtensionContext): Promise<void> => {
				try {
					const workspaceRoot = findWorkspaceRoot(ctx.cwd);
					setCache(await discover(workspaceRoot), workspaceRoot);
				} catch (err) {
					// fail-safe：发现异常不阻断 session，缓存保持 null（before_agent_start 会 fallback）
					logger.error(`${config.logTag} session_start discover failed`, {
						reason: toErrorMessage(err),
					});
				}
			},
		);

		pi.on(
			"before_agent_start",
			async (
				event: BeforeAgentStartEvent,
				ctx: ExtensionContext,
			): Promise<BeforeAgentStartEventResult | void> => {
				try {
					// 读缓存；miss（session_start 未触发/缓存被清）则 fallback 重新发现+赋值
					if (discoveryCache === null) {
						const workspaceRoot = findWorkspaceRoot(ctx.cwd);
						setCache(await discover(workspaceRoot), workspaceRoot);
					}
					// injectionCache 与 discoveryCache 不变量同步（setCache 保证），直接复用；
					// 空串仅出现在「空发现且 roots 清单为空」的退化态（约定根恒在，实际不可达）
					const injection = injectionCache;
					if (!injection) return;
					return { systemPrompt: event.systemPrompt + injection };
				} catch (err) {
					logger.error(`${config.logTag} before_agent_start failed`, {
						reason: toErrorMessage(err),
					});
				}
			},
		);

		pi.on(
			"session_shutdown",
			(_event: SessionShutdownEvent, _ctx: ExtensionContext): void => {
				// 清缓存：null 分支不消费 workspaceRoot（空态渲染仅在发现路径发生）
				setCache(null, "");
			},
		);
	}

	return { setup, discover };
}
