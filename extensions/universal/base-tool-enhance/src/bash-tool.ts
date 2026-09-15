/**
 * bash 工具同名 override 定义（设计文档 docs/design/base-tool-enhance.md §3.2 方案 B / §3.5）。
 *
 * 前台行为 100% 委托 pi 官方工厂 createBashToolDefinition——override 后工具的全部
 * 行为归本包负责，前台语义必须跟随 pi 版本升级而不是自研复刻（自研 spawn 会与
 * pi 升级双向漂移，截断规则 / shellPath / PI_* env / stdin transport 细节遗漏即回归）。
 * 本模块真正的增量：
 *  1. input schema 新增 background?: boolean（D2：工具名保持 bash，只扩 schema）
 *  2. description 重写——官方文案不含 background 用法，不重写则模型永远发现不了
 *     新参数，「模型主动要求后台」的路径不可达
 *  3. background:true 分支（M2）：spawn 后台任务立即返回 task_id（D14：subagent
 *     进程内降级忽略 background，走前台同步语义）
 *  4. 白名单强制后台（M4，D3/D13）：命令命中 force-test/force-longrun/用户正则 →
 *     无视 background 参数强制后台，忽略 LLM 显式 timeout；双模式 timeout 配置注入
 *     （前台未填 → foregroundTimeoutSeconds，后台未填 → backgroundTimeoutSeconds）
 */

import type { AgentToolUpdateCallback, BashToolDetails, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
	resolveBackgroundTimeoutSec,
	spawnBackgroundTask,
	truncateCommand,
} from "./background/spawn-background.ts";
import { isSubagentProcess } from "./background/subagent-guard.ts";
import { loadBaseToolEnhanceConfig, type BaseToolEnhanceConfig } from "./config.ts";
import { compileForcePatterns, describeForceMatch, matchForceBackground } from "./force-patterns.ts";

/**
 * override 后的 bash input schema。
 *
 * 在官方 schema（bash.js bashSchema：command + timeout?）基础上只追加 background。
 * timeout 单位与官方一致 = 秒；background 缺省 false（不传 = 前台，等价官方行为）。
 */
const enhancedBashSchema = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	timeout: Type.Optional(
		Type.Number({ description: "Timeout in seconds (optional; if omitted, the configured default timeout applies when set)" }),
	),
	background: Type.Optional(
		Type.Boolean({
			description:
				"Run in background: returns a task_id immediately instead of waiting for the command to finish. Default false.",
		}),
	),
});

/**
 * 重写的 bash description（给 LLM 的，英文，风格对齐官方文案 bash.js:233）。
 *
 * 覆盖设计文档 §3.5 要求的三个要点：
 *  1. background:true 语义（立即返回 task_id，bash_output 查询 / bash_kill 终止）
 *  2. 白名单命中命令自动转后台（即使未要求 background）
 *  3. timeout 单位秒、显式填写会被尊重（唯一例外：白名单强转后台时忽略，D13）
 *
 * bash_output / bash_kill 工具由 M2 单元注册，description 先行提及（D2/§3.5 要求）。
 */
const ENHANCED_BASH_DESCRIPTION = [
	"Execute a bash command in the current working directory. Returns stdout and stderr.",
	"Output is truncated to last 2000 lines or 50KB (whichever is hit first). If truncated, full output is saved to a temp file.",
	"Optionally provide a timeout in seconds; an explicit timeout is respected, except when a whitelisted long-running command is force-routed to background. If no timeout is given, a configured default timeout applies when set.",
	"",
	"Background mode: set background: true to start the command without waiting for it. The tool returns immediately with a task_id, the pid, and an output file path, and you can continue other work while it runs.",
	"Poll progress and fetch output with bash_output {task_id} (omit task_id to list known background tasks); terminate a task with bash_kill {task_id}.",
	"",
	"Commands matching the force-background whitelist (test suites, dev servers, watch jobs and similar long-running commands) are automatically routed to background even when background was not requested; in that case the result carries a task_id to poll.",
].join("\n");

/**
 * spawn 后台任务并拼装立即返回的 tool result（白名单强转与显式 background:true
 * 两分支共用——spawn 入参、失败抛错、返回文案只有这一份，改文案不再有漏改分叉）。
 * extraNotes：分支差异文案（如 force 命中说明），插在 Output file 行与 Poll 指引之间。
 */
function startBackgroundAndReply(
	command: string,
	ctx: ExtensionContext,
	config: BaseToolEnhanceConfig,
	timeoutSec: number | undefined,
	extraNotes: string[] = [],
) {
	const spawned = spawnBackgroundTask({
		command,
		cwd: ctx.cwd,
		dataDir: getAgentDir(),
		sessionId: ctx.sessionManager.getSessionId(),
		timeoutSec,
		maxConcurrent: config.maxConcurrentBackground,
	});
	if (!spawned.ok) {
		throw new Error(spawned.error);
	}
	const { task } = spawned;
	return {
		content: [
			{
				type: "text" as const,
				text: [
					`Background task started: ${truncateCommand(task.command)}`,
					`task_id: ${task.taskId}  pid: ${task.pid}`,
					`Output file: ${task.outputFile}`,
					...extraNotes,
					`Poll with bash_output {task_id:"${task.taskId}"} or omit task_id to list all tasks; terminate with bash_kill {task_id:"${task.taskId}"}.`,
				].join("\n"),
			},
		],
		details: undefined as undefined,
	};
}

/**
 * 构建 bash override 的 ToolDefinition。
 *
 * cwd 处理：官方工厂在调用时固化 cwd（execute 闭包捕获），而 extension load 时机
 * 早于会话 cwd 确定。因此以 execute 时 ctx.cwd 为权威：cwd 变化（cd / session 切换）
 * 就地重建 delegate；同 cwd 复用（工厂是纯函数，重建仅多创建 ops 闭包，单槽缓存
 * 防止每次工具调用重复构建）。promptSnippet / promptGuidelines / renderCall /
 * renderResult 等未覆盖字段从官方 delegate 展开透传——override 掉整个 definition
 * 后不透传会丢掉系统提示里的工具片段（types.d.ts ToolDefinition：无 promptSnippet
 * 的 custom tool 会被 Available tools 段省略）与 TUI 渲染（pi 0.84.1 bash 实装的
 * renderCall 命令格式化 / renderResult elapsed 计时与富结果组件）。
 */
export function createBashOverrideToolDefinition() {
	let cachedCwd: string | undefined;
	// 官方工厂返回值的形状 = ToolDefinition（bash.js createBashToolDefinition），
	// 类型交由 pi 公开导出推断，不在本地重复声明（防与 pi 升级漂移）。
	type OfficialBashTool = ReturnType<typeof createBashToolDefinition>;
	let cachedDelegate: OfficialBashTool | undefined;

	const getDelegate = (cwd: string): OfficialBashTool => {
		if (cachedDelegate === undefined || cachedCwd !== cwd) {
			cachedDelegate = createBashToolDefinition(cwd);
			cachedCwd = cwd;
		}
		return cachedDelegate;
	};

	// registerTool 发生在 extension load 时（无 execute ctx），初始 delegate 用
	// 进程 cwd 建立——name/label/promptSnippet/renderCall/renderResult 等静态字段与
	// cwd 无关，execute 路径会被 getDelegate(ctx.cwd) 纠正。
	const initial = getDelegate(process.cwd());

	return {
		// 官方 delegate 展开透传（render 面委托）：pi 0.84.1 bash definition 实装带
		// renderCall（命令格式化）/ renderResult（elapsed 计时、富结果组件），独立
		// pi TUI 用户安装本包后渲染不降级为通用组件——凡未在下方显式覆盖的字段
		// （label/promptSnippet/promptGuidelines/renderCall/renderResult 等）全部随
		// delegate 透传，cwd 重建 delegate 时静态闭包引用不变（render 闭包与 cwd 无关）
		...initial,
		// D2（禁止改名）：桌面侧六处按工具 key 'bash' 硬编码（truncate-tool-output、
		// useToolMeta、block-icon、pi-preset BUILTIN_TOOLS 与 deniedTools、permission
		// extractCommand）——改名后这些消费面全部失配，审批退化为逐次弹窗、渲染错位
		name: initial.name, // "bash"：同名覆盖内置工具（agent-session _refreshToolRegistry 后注册者胜）
		description: ENHANCED_BASH_DESCRIPTION,
		parameters: enhancedBashSchema,
		async execute(
			toolCallId: string,
			args: { command: string; timeout?: number; background?: boolean },
			signal: AbortSignal | undefined,
			// 与官方 delegate 同型（展开透传后泛型 TDetails=BashToolDetails|undefined
			// 随 render 面传入，execute 签名必须对齐，否则 registerTool 赋值检查不过）
			onUpdate: AgentToolUpdateCallback<BashToolDetails | undefined> | undefined,
			ctx: ExtensionContext,
		) {
			// 配置每次 execute 读时加载（热重载契约：禁止上层缓存，同进程改配置文件
			// 不重启即生效）。D14：subagent 降级是全量的——白名单与 background 参数
			// 同时失效（判定一次，两个分支共用）
			const config = loadBaseToolEnhanceConfig();
			const subagent = isSubagentProcess();

			// 白名单强制后台（D3/M4）：判定在 execute 内部、不改写 input——permission
			// 审批的永远是原始 command/background/timeout（P1 探针结论的前提）。命中 →
			// 强制走 background，无视 background:false/缺省
			if (!subagent) {
				const forceMatch = matchForceBackground(
					args.command,
					compileForcePatterns(config.forceBackgroundPatterns, config.disableBuiltinForcePatterns),
				);
				if (forceMatch !== undefined) {
					// D13：忽略 LLM 显式 timeout（unified-hooks 时代「跑测试带 timeout」习惯
					// 会精确复刻 §2.2 要解决的失败模式），按「配置默认 → 不限」取值
					const timeoutSec = resolveBackgroundTimeoutSec(
						undefined,
						config.backgroundTimeoutSeconds ?? undefined,
					);
					const notes = [
						`Forced to background: command matched force-background whitelist ${describeForceMatch(forceMatch)}.`,
						...(args.timeout !== undefined
							? [
									`Ignored explicit timeout ${args.timeout}s for whitelisted command ` +
										`(background timeout: ${timeoutSec !== undefined ? `${timeoutSec}s (config default)` : "unlimited"}).`,
								]
							: []),
					];
					return startBackgroundAndReply(args.command, ctx, config, timeoutSec, notes);
				}
			}

			// background 分支（M2）：显式 background:true 且非 subagent 降级（D14——
			// subagent 进程内忽略 background 走前台，保持内置同步语义）。abort/interrupt
			// 不传播到后台任务（D15）：本分支不接触 signal，立即返回
			if (args.background === true && !subagent) {
				// timeout 优先级（§3.5）：LLM 显式值 > 配置默认 > 不限；无效显式值沿用
				// pi 内置文案抛错（注入只发生在「LLM 未填 && 配置了默认」，D4）
				const timeoutSec = resolveBackgroundTimeoutSec(args.timeout, config.backgroundTimeoutSeconds ?? undefined);
				return startBackgroundAndReply(args.command, ctx, config, timeoutSec);
			}
			const delegate = getDelegate(ctx.cwd);
			// 前台委托：只转发官方 schema 已识别的字段（command/timeout），background
			// 是本包增量，官方 execute 不认识（其解构也只取这两个键，显式构造让
			// 「本层转发面」在代码上自解释）。subagent 降级（D14）与 background 缺省
			// 都落到这条路径。
			//
			// 前台 timeout 注入（M4/G3）：LLM 未填 && foregroundTimeoutSeconds 配置了
			// 默认 → 注入；默认 null 不注入 = pi 原生不限时语义（D4）。注入与 subagent
			// 降级正交——D14 只废 background/白名单语义，前台默认超时是全局挂死保护
			const foregroundTimeout =
				args.timeout !== undefined ? args.timeout : (config.foregroundTimeoutSeconds ?? undefined);
			return delegate.execute(
				toolCallId,
				{ command: args.command, timeout: foregroundTimeout },
				signal,
				onUpdate,
				ctx,
			);
		},
	};
}
