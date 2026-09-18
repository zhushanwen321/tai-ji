import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getLogger, setPiHandle } from "@zhushanwen/pi-extension-logger";
import { Type } from "typebox";

import { registerAutoRenameCommand } from "./commands.js";
import { landTitle } from "./landing.js";
import { debugLog as llmDebugLog, extractMessageText, isSubagentSession } from "./llm.js";
import {
	cleanTitle,
	countSuccessfulAssistantReplies,
	countUserMessages,
	loadRenameConfig,
} from "./pure.js";

const logger = getLogger("rename-session");

/**
 * turn_end 事件的宽松类型（参考 pi extensions/types.ts 的 TurnEndEvent）。
 * message 收紧为带 stopReason 的宽松结构（turn_end 快速路径读取），不依赖 pi 类型导出。
 * 注意交叉目标用 `& object` 而非 `& Record<string, unknown>`：pi 的 AgentMessage 联合成员是
 * interface（无隐式 index signature），后者会导致 handler 注册 on("turn_end") 时参数逆变校验
 * 失败（tsc 实测重载匹配崩掉）；`& object` 同样表达「是对象 + 可选 stopReason」且可编译。
 */
interface TurnEndLikeEvent {
	type: "turn_end";
	turnIndex: number;
	message: { stopReason?: string } & object;
	toolResults: unknown[];
}

/**
 * message_end 事件的宽松类型（first-prompt 入口）。同 TurnEndLikeEvent 的
 * `& object` 逆变技巧；message 只读 role（分派过滤）与 content（载荷取文本）。
 */
interface MessageEndLikeEvent {
	type: "message_end";
	message: { role?: string } & object;
}

/**
 * mode 切走后残留 rename_session 工具被调用的 execute 守卫文案（isError 经 throw 产生）。
 * 与失败路径表「守卫拒绝」行 / V10 通过标准三处对齐：含恢复动作指引。
 */
const RENAME_TOOL_MODE_GUARD_MESSAGE =
	"模式已切换，rename_session 仅在 agent-tool 模式可用；本会话可切回 agent-tool 立即恢复（live 读 mode），或手动改名（GUI rename / pi 原生 /name）。";

/**
 * subagent session 的 rename_session 工具 execute 守卫文案（守卫闭环，C-ext-21 三入口
 * 复用；isError 经 throw 产生）。不暴露内部路径细节——subagents 目录形态是跨包实现耦合，
 * 面向 agent 的报错只说结论与指引。
 */
const RENAME_TOOL_SUBAGENT_GUARD_MESSAGE =
	"当前会话是 subagent 子任务会话（临时产物，不参与会话命名体系），不支持重命名；请继续当前任务，无需重试。";

/**
 * 注册 rename_session 工具（agent-tool 模式）。
 *
 * 关键语义：
 * - subagent session 守卫：isSubagentSession 命中即 throw isError——subagent
 *   子进程同样加载本 extension（全局 mode=agent-tool 时 subagent 也注册本工具），
 *   子会话是临时产物不参与 rename 体系，与 message_end / turn_end 两入口同语义。
 * - execute 内 live 读 config 守卫：mode !== "agent-tool"（mode 切走后本工具残留在
 *   已存活 session 的工具清单——pi 无 unregisterTool）→ throw isError（pi 0.84.4 实装：
 *   execute 正常返回的 isError 字段被丢弃，isError 状态只能经 throw 产生，
 *   agent-loop.js executePreparedToolCall catch → createErrorToolResult(message)）。
 * - cleanTitle 空值同样 throw isError（空白/纯标点标题不可落库）。
 * - 非空直接 pi.setSessionName，不走 getSessionName() 防覆盖守卫——agent 显式调用
 *   是「代表用户的意图」，语义等同 GUI 手动 rename，允许覆盖任何既有名（含自动名/语义名）。
 */
function registerRenameSessionTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "rename_session",
		label: "Rename Session",
		description:
			"Rename the current session with a short, descriptive title. Call this proactively once the session's purpose is clear (typically after the first exchange), or whenever the user asks to name or rename the session. The title is a slug-style phrase: noun or gerund phrase, 3-6 words, same language as the conversation, no trailing punctuation, no full sentences. Replaces any existing session name.",
		parameters: Type.Object({
			title: Type.String({
				description: "New session title. Slug-style phrase (e.g. '修复登录超时', 'refactor-config-loader'), 3-6 words, no trailing punctuation.",
			}),
		}),
		async execute(
			_toolCallId: string,
			params: { title: string },
			_signal: AbortSignal | undefined,
			_onUpdate: undefined,
			ctx: ExtensionContext,
		): Promise<AgentToolResult<Record<string, never>>> {
			// subagent session 守卫先于 mode 守卫：subagent 拒绝与 mode 无关（即便 mode 仍为
			// agent-tool 也不该命名临时子会话），且文案归因到 subagent 而非误导性的「模式已切换」
			if (isSubagentSession(ctx.sessionManager.getSessionDir())) {
				throw new Error(RENAME_TOOL_SUBAGENT_GUARD_MESSAGE);
			}
			const config = loadRenameConfig();
			if (config.mode !== "agent-tool") {
				throw new Error(RENAME_TOOL_MODE_GUARD_MESSAGE);
			}
			const title = cleanTitle(params.title, config.maxTitleLength);
			if (!title) {
				throw new Error(
					"title 清洗后为空（空白 / 纯标点 / 引号包裹），无法命名；请换一个有意义的标题文本。",
				);
			}
			pi.setSessionName(title);
			llmDebugLog(`tool renamed to "${title}"`);
			return { content: [{ type: "text", text: `已命名：${title}` }], details: {} };
		},
	});
}

/**
 * pi-rename-session extension 工厂函数。
 * 三种触发模式（默认 first-stop）共用同一落库管道（callRenameLLM → 防覆盖重查 →
 * setSessionName）：
 * - first-stop（默认）：首个成功 round 末触发（turn_end 入口，现状行为）
 * - first-prompt：首条 user 消息发出即触发（message_end 入口，不等回复，标题只基于 prompt）
 * - agent-tool：不自动生成；load 时注册 rename_session 工具由 agent 在对话中自主改名
 */
export default function renameSessionExtension(pi: ExtensionAPI): void {
	// 日志通道注入（extension-logger 两阶段初始化：工厂拿 pi → setPiHandle，最早期调用）。
	// 不注入则 logger.warn/error 只有文件日志通道（TAIJI_AGENT_DEBUG=1），appendEntry
	// （session entry，README「debug 证据链」的 E2E 断言数据源）不生效。
	setPiHandle(pi);

	registerAutoRenameCommand(pi);

	// 工具注册面（求值时点边界）：只在 extension load 时求值一次——pi 无 unregisterTool，
	// 切 mode 后已存活 session 的工具清单不回溯（切到 agent-tool 当前 session 无工具、切走则
	// 工具残留），残留工具由 execute 内 live mode 守卫兜底（RENAME_TOOL_MODE_GUARD_MESSAGE）。
	if (loadRenameConfig().mode === "agent-tool") {
		registerRenameSessionTool(pi);
	}

	// 在途去重标志：工厂闭包级而非模块级——pi 的 extensionCache 缓存 factory、每次
	// session 创建重执行工厂函数，闭包变量 = per-session 生命周期；模块顶层变量进程级存活，
	// 进程内 /fork、/session 切换 session 时会跨 session 污染、吞掉新 session 的唯一命名机会。
	let firstPromptInFlight = false;

	// message_end 入口（first-prompt 模式）：首条 user 消息发出即命名，不等回复完成。
	pi.on("message_end", async (event: MessageEndLikeEvent, ctx: ExtensionContext) => {
		// handler 侧 debug 日志（C3 同款契约）：firstPrompt 前缀区分触发入口（与 turn_end 路径
		// 共享 skip: name exists / renamed to 契约文案，harness 断言可归因到本入口）
		const debugLog = (message: string): void => {
			llmDebugLog(`firstPrompt ${message}`);
		};
		try {
			// 1. role 过滤：assistant / toolResult 的 message_end 不是 prompt 信号
			if (event.message.role !== "user") return;

			// 2. 开关检查（loadRenameConfig：flag 文件 live 覆盖 + config.enabled 回落，见 pure.ts [COMPAT] 契约）
			const config = loadRenameConfig();
			if (!config.enabled) return;

			// 3. mode 分派（事件面 live 读：GUI 切 mode 对活跃 session 的自动命名即时生效——
			//    first-stop / agent-tool 模式下本入口静默返回，V10 A 段「切走即停」）
			if (config.mode !== "first-prompt") {
				debugLog(`skip: mode=${config.mode}`);
				return;
			}

			// 4. 排除 subagent 子进程 session（守卫链复用，C-ext-21 覆盖面含本新入口）
			if (isSubagentSession(ctx.sessionManager.getSessionDir())) return;

			// 5. 首条 user 判定：extension handler 先于本条 message 的 entries append 执行
			//    （探针 P1 实测：user message_end 时 getEntries() 的 user 计数为 0，assistant
			//    message_end 时已变 1），计数 === 0 ⇔ 本条即 session 首条 user——steering/follow-up
			//    队列消息到达时首条已入 entries（计数 ≥1），天然不重复触发
			const userCount = countUserMessages(ctx.sessionManager.getEntries());
			if (userCount !== 0) {
				debugLog(`skip: userCount=${userCount}`);
				return;
			}

			// 6. prompt 文本从 event 载荷取（entries 此时不含本条，只能从载荷取；探针 P1 实测
			//    content 为 text blocks 数组，extractMessageText → joinTextBlocks 拼出完整 prompt）
			const promptText = extractMessageText(event.message);
			if (promptText === "") {
				debugLog("skip: empty prompt");
				return;
			}

			// 7. 在途去重：by construction 第二条 user 到达时首条已 append（步 5 拦截），本
			//    标志兜住极端交错双发；settle 后释放（首条窗口已消费，释放后新到达靠步 5 拦截）
			if (firstPromptInFlight) return;
			firstPromptInFlight = true;

			// 8. fire-and-forget（同 turn_end 契约）：handler 立即 resolve，LLM 调用与 setSessionName
			//    在后台异步完成。finalMessage 传空 content——first-prompt 语义即「不等回复」，
			//    finalText 为空串走 buildTitleMessages 两条降级（标题只基于 prompt）
			void landTitle(pi, ctx, config, { content: [] }, { debugLog, promptText }).finally(() => {
				firstPromptInFlight = false;
			});
			// rename 是 best-effort，任何 LLM 失败（网络/提取/auth/model 不可用）都静默跳过保留原 label，
			// 不进 session history。
		} catch (e) {
			// best-effort 降级：message_end handler 同步部分（守卫判定）抛错时记录但不阻断
			// 事件链——rename 是非关键副作用，任何失败不得干扰主对话。
			logger.error("failed", { error: String(e) });
		}
	});

	// turn_end 入口（first-stop 模式，现状行为）：首个成功 round 末触发。
	pi.on("turn_end", async (event: TurnEndLikeEvent, ctx: ExtensionContext) => {
		// handler 侧 debug 日志（C3）：skip 文案 + t=<ISO> + turnIndex=<n>
		// （turnIndex 只在此侧输出——该字段只在 handler 作用域可达，不为日志字段扩 callRenameLLM 签名；
		// 复用 llm.ts 的 debugLog，前缀 turnIndex 后输出格式与旧实现逐字节一致）
		const debugLog = (message: string): void => {
			llmDebugLog(`turnIndex=${event.turnIndex} ${message}`);
		};
		try {
			// 1. 开关检查（loadRenameConfig：flag 文件 live 覆盖 + config.enabled 回落，见 pure.ts [COMPAT] 契约）
			const config = loadRenameConfig();
			if (!config.enabled) return;

			// 2. mode 分派（事件面 live 读）：first-stop 才走 turn_end 自动命名——
			//    first-prompt / agent-tool 模式下本入口静默返回（V10 A 段「切走即停」；
			//    切回 first-stop 后 live 恢复分派，但已跑过成功 round 的 session 受一次性窗口约束）
			if (config.mode !== "first-stop") {
				debugLog(`skip: mode=${config.mode}`);
				return;
			}

			// 3. 排除 subagent 子进程 session（子 session 是临时产物，rename 产生噪音）
			if (isSubagentSession(ctx.sessionManager.getSessionDir())) return;

			// 4. O(1) 快速路径：turn_end 每个 iteration 发一次，只有 stopReason==='stop' 的
			// 最终 turn 才触发（过滤 toolUse 中间轮与 error/aborted/length 异常轮）
			if (event.message.stopReason !== "stop") {
				debugLog(`skip: stopReason=${event.message.stopReason}`);
				return;
			}

			// 5. 首 turn 判定：成功（stop）assistant 回复数 === 1。触发时刻的 turn_end 必然是
			// round 的最终 turn，其 event.message 即最终 assistant message（final text 零遍历可得）
			const entries = ctx.sessionManager.getEntries();
			const successCount = countSuccessfulAssistantReplies(entries);
			if (successCount !== 1) {
				debugLog(`skip: count=${successCount}`);
				return;
			}

			// 6. LLM 生成标题并落库。pi 运行时的事件链是 await 的（runner.emit → await handler），
			// 若 await callRenameLLM 会阻塞 agent 进入下一次迭代。这里用 detached promise 脱离 await 链，
			// 真正实现 fire-and-forget：handler 立即 resolve，LLM 调用与 setSessionName 在后台异步完成。
			// 落库管道（起 LLM → 防覆盖重查 → setSessionName → renamed to 日志）见 landing.ts：
			// 与 first-prompt 入口共用同一段，usage 落账回调 / skip / renamed to 契约由该处单点保证
			void landTitle(pi, ctx, config, event.message, { debugLog });
			// rename 是 best-effort，任何 LLM 失败（网络/提取/auth/model 不可用）都静默跳过保留原 label，
			// 不进 session history。
		} catch (e) {
			// best-effort 降级：turn_end handler 同步部分（开关/subagent/判定）抛错时记录但不阻断
			// agent 循环——rename 是非关键副作用，任何失败不得干扰主对话。
			logger.error("failed", { error: String(e) });
		}
	});
}
