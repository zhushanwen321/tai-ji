/**
 * foreground-idle-to-background 剧本族公共装配（verify-taiji scenarios/lib）。
 *
 * 承载七剧本（p0-bash-idle-to-background / p0-bash-idle-notify-once /
 * p0-bash-abort-process-group / p0-bash-wrapper-crash-fallback /
 * p1-bash-foreground-zero-perception / p1-bash-sidebar-converted-task /
 * p1-bash-pool-full-register）共享的驱动与取证原语；
 * 设计依据 = ~/.agents/skill-data/tech-design/fix-chat-flow-stuck-84f23fa0/
 * foreground-idle-to-background.md（§3.2 矩阵、§5 部件、§6.2 验收场景）。
 *
 * 事实锚（实现时逐一核实过的契约，勿凭记忆改）：
 * - 扩展配置文件 = `<dataDir>/agent/config/base-tool-enhance-ext-config.json`
 *   （llm-shared getConfigPath：pi getAgentDir() = PI_CODING_AGENT_DIR = <dataDir>/agent，
 *   join 'config' + `<pkg>-ext-config.json`；base-tool-enhance config.ts 每次 execute
 *   读时热重载——launch 后写入即生效，无需重启）。
 * - 后台任务 registry = `<dataDir>/ext-sessions/<sid>/background-tasks/registry.json`
 *   （registry.ts getRegistryPath；条目字段见 extension-protocol BackgroundTaskRegistryEntry）。
 * - runtime 协议 kill/查询回路（侧边栏终止同款，shared/protocol.ts backgroundTask 域）：
 *   `backgroundTask.list {sessionId}` → `backgroundTask.tasks {tasks}`；
 *   `backgroundTask.output {sessionId,taskId,maxBytes?}` → `backgroundTask.outputResult {text,lost}`；
 *   `backgroundTask.kill {sessionId,taskId}` → `backgroundTask.killResult {killed,reason}`。
 * - pi 会话 JSONL = `<dataDir>/agent/sessions/<encodeCwd>/<ISO>_<uuid>.jsonl`，首行
 *   `{type:'session', id:<sessionId>}`；工具结果 entry = `{type:'message', timestamp,
 *   message:{role:'toolResult', toolCallId, toolName, content:[{type:'text',text}]}}`。
 * - 完成通知 = pi.sendMessage customType 'background-bash'（notify.ts），steer + triggerTurn
 *   ——注入会唤醒新 run 并消耗一个 faux step（faux 脚本必须排通知应答步）。
 *
 * 零第三方依赖（node:*）。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/** base-tool-enhance 扩展配置文件相对路径（相对实例 dataDir）。 */
export const EXT_CONFIG_REL = path.join('agent', 'config', 'base-tool-enhance-ext-config.json')

/**
 * 写入扩展配置（合并式：保留既有键，patch 值 undefined 的键不写）。
 * 键形态与 base-tool-enhance config.ts 对齐：idleBackgroundSec = 空闲转后台阈值秒数
 * （设计 §4.2：默认 600，null 关闭）；maxConcurrentBackground = 后台任务并发上限
 * （spawn 准入门，设计 §5 部件 2，默认 8）。当前实现前的 HEAD 上未识别键被
 * normalize 忽略（前向兼容），写入无副作用。
 */
export function writeExtConfig(dataDir, patch = {}) {
	const file = path.join(dataDir, EXT_CONFIG_REL)
	let config = {}
	try {
		const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) config = parsed
	} catch {
		/* 不存在 / 坏 JSON：以空对象起 */
	}
	for (const [key, value] of Object.entries(patch)) {
		if (value !== undefined) config[key] = value
	}
	fs.mkdirSync(path.dirname(file), { recursive: true })
	fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
	return file
}

/** 写 idle 单键配置（writeExtConfig 的便捷形态，首批四剧本既有调用面不变）。 */
export function writeIdleConfig(dataDir, { idleBackgroundSec } = {}) {
	return writeExtConfig(dataDir, { idleBackgroundSec })
}

/** `<dataDir>/ext-sessions/<sid>/background-tasks/registry.json`（registry.ts 契约）。 */
export function registryPathOf(dataDir, sessionId) {
	return path.join(dataDir, 'ext-sessions', sessionId, 'background-tasks', 'registry.json')
}

/** 读 registry（文件不存在 / 坏 JSON → null）。 */
export function readRegistry(dataDir, sessionId) {
	try {
		return JSON.parse(fs.readFileSync(registryPathOf(dataDir, sessionId), 'utf8'))
	} catch {
		return null
	}
}

/** 按 command 子串在 registry 里找条目（entries 可能是对象或数组形态，两态都解）。 */
export function findRegistryEntry(registry, commandIncludes) {
	if (!registry) return null
	const values = Array.isArray(registry)
		? registry
		: Array.isArray(registry.entries)
			? registry.entries
			: Object.values(registry.entries ?? registry)
	return (values ?? []).find((e) => e && typeof e === 'object' && String(e.command ?? '').includes(commandIncludes)) ?? null
}

/** 定位本 sid 的 pi 会话 JSONL（首行 `{type:'session', id}` 匹配；找不到 = null）。 */
export function findSessionFile(dataDir, sessionId) {
	const root = path.join(dataDir, 'agent', 'sessions')
	if (!fs.existsSync(root)) return null
	const found = []
	const walk = (dir) => {
		for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
			const p = path.join(dir, e.name)
			if (e.isDirectory()) walk(p)
			else if (e.name.endsWith('.jsonl')) found.push(p)
		}
	}
	walk(root)
	for (const f of found) {
		try {
			const first = fs.readFileSync(f, 'utf8').split('\n', 1)[0]
			const head = JSON.parse(first)
			if (head?.type === 'session' && head.id === sessionId) return f
		} catch {
			/* 首行非 JSON（写入中）：跳过 */
		}
	}
	return null
}

/** 会话 JSONL 全量解析（坏行跳过；文件不存在 = []）。 */
export function readSessionEntries(sessionFile) {
	if (!sessionFile || !fs.existsSync(sessionFile)) return []
	const out = []
	for (const line of fs.readFileSync(sessionFile, 'utf8').split('\n')) {
		const t = line.trim()
		if (!t) continue
		try {
			out.push(JSON.parse(t))
		} catch {
			/* 尾部半行：跳过 */
		}
	}
	return out
}

/** toolResult 消息内容纯文本（content 为 Segment[] 或 string 两态）。 */
function contentText(content) {
	if (typeof content === 'string') return content
	if (!Array.isArray(content)) return ''
	return content.map((s) => (s?.type === 'text' ? String(s.text ?? '') : '')).join('')
}

/** 提取指定工具名的全部 toolResult：{toolCallId, toolName, text, timestamp}。 */
export function toolResultsFor(entries, toolName) {
	return entries
		.filter((e) => e?.type === 'message' && e?.message?.role === 'toolResult' && e?.message?.toolName === toolName)
		.map((e) => ({
			toolCallId: e.message.toolCallId,
			toolName: e.message.toolName,
			text: contentText(e.message.content),
			timestamp: e.timestamp,
		}))
}

/**
 * 条件轮询会话 JSONL 直到 predicate(entries) 真值。
 * @returns {Promise<{entries:Array, hit:boolean}>} 超时返回最后一次读取（hit=false，调用方断言红）。
 */
export async function pollSessionFile(sessionFile, predicate, { timeoutMs = 15_000, intervalMs = 400 } = {}) {
	const deadline = Date.now() + timeoutMs
	let entries = []
	for (;;) {
		entries = readSessionEntries(sessionFile)
		if (predicate(entries)) return { entries, hit: true }
		if (Date.now() >= deadline) return { entries, hit: false }
		await new Promise((r) => setTimeout(r, intervalMs))
	}
}

/** 条件轮询（通用）：predicate 真值返回其结果；超时返回 undefined。 */
export async function pollUntil(predicate, { timeoutMs, intervalMs = 400 } = {}) {
	const deadline = Date.now() + timeoutMs
	for (;;) {
		const value = await predicate()
		if (value) return value
		if (Date.now() >= deadline) return undefined
		await new Promise((r) => setTimeout(r, intervalMs))
	}
}

/**
 * ps 快照按 command 子串过滤（本进程 argv 不含哨兵串，无自匹配）。
 * @returns {Array<{pid:number, pgid:number, command:string}>}
 */
export function psFind(pattern) {
	const r = spawnSync('ps', ['-eo', 'pid=,pgid=,command='], { encoding: 'utf8', timeout: 10_000 })
	if (r.status !== 0) return []
	const out = []
	for (const line of String(r.stdout).split('\n')) {
		if (!line.includes(pattern)) continue
		const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)
		if (m) out.push({ pid: Number(m[1]), pgid: Number(m[2]), command: m[3] })
	}
	return out
}

/** 哨兵进程清理（只杀 command 含哨兵串的 pid；返回被杀 pid 列表；幂等）。 */
export function killByPattern(pattern) {
	const killed = []
	for (const p of psFind(pattern)) {
		try {
			process.kill(p.pid, 'SIGKILL')
			killed.push(p.pid)
		} catch {
			/* 已退出 / 权限：跳过 */
		}
	}
	return killed
}

/** 从结果文本提取 taskId（标记行/登记文案里的 `bt-<id>` 形态）。 */
export function extractTaskId(text) {
	return typeof text === 'string' ? (text.match(/bt-[A-Za-z0-9_-]+/)?.[0] ?? null) : null
}

/** 等指定 bash 调用的 tool_call_start（按 arguments 里的命令子串识别；返回事件或 null）。 */
export async function waitForBashCallStart(protocol, sessionId, { commandIncludes, timeoutMs = 60_000, since = 0 } = {}) {
	try {
		return await protocol.waitFor(
			(e) =>
				e.type === 'message.tool_call_start' &&
				e.payload?.entry?.toolName === 'bash' &&
				JSON.stringify(e.payload.entry.arguments ?? {}).includes(commandIncludes),
			{ sessionId, timeoutMs, since },
		)
	} catch {
		return null
	}
}

/**
 * 卡死回合收尾（实现前 HEAD 形态：bash 前台调用永不返回）：abort 官方中止 +
 * 等终态 + 哨兵进程清理。全部 best-effort，不抛错（红断言由调用方登记）。
 */
export async function abortStuckTurn(protocol, sessionId, { sentinel, log } = {}) {
	const actions = []
	try {
		const reply = await protocol.call('message.abort', { sessionId }, { replyType: 'message.status', timeoutMs: 30_000 })
		actions.push(`abort reply=${JSON.stringify(reply).slice(0, 120)}`)
	} catch (e) {
		actions.push(`abort 失败：${String(e?.message ?? e).slice(0, 160)}`)
	}
	try {
		const end = await protocol.waitTurnEnd(sessionId, { timeoutMs: 45_000 })
		actions.push(`turn 终态 ${end.type} stop=${String(end.payload?.stopReason)}`)
	} catch (e) {
		actions.push(`turn 终态等待超时：${String(e?.message ?? e).slice(0, 160)}`)
	}
	if (sentinel) {
		const killed = killByPattern(sentinel)
		actions.push(`哨兵清理 killed=${JSON.stringify(killed)}`)
	}
	log?.(`[cleanup] ${actions.join(' | ')}`)
	return actions
}
