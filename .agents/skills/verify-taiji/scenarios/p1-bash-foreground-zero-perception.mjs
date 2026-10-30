/**
 * p1-bash-foreground-zero-perception —— V3 正常路径零感知（包装跑透传 + B2 收尾无痕）
 * （foreground-idle-to-background 设计 §6.2 V3 = 矩阵 A5/B2；验收项 A4）。
 *
 * 范围裁决（第二批创作时定）：V3 的「官方直跑 vs 包装跑逐字对比」归 M2 透传等价
 * 测试族（单测，六族用例）；本真机剧本只验包装跑一侧的零感知四断言——机制在场
 * （idleBackgroundSec=30 注入，非 null）时短命令快速自然完成走 B2 路径：
 *   结果正常到达（输出透传、无标记行）→ 无登记条目 → 无任何完成通知 →
 *   background-tasks 目录无三文件残留（cmd.sh/pidfile/日志目录枚举断言）。
 *
 * 命令集：`ls`（哨兵化）、`pnpm -v`（设计 §6.2 V3 原文），外加一条 3s 中速命令
 * （`sleep 3 && echo`）作为 B2 窗口锚点——短命令执行窗口 <500ms，ps 轮询抓不到
 * 包装进程；没有「包装在场」锚，三文件清理断言无法区分「B2 清理生效」与「从未
 * 包装」（HEAD 形态下两者同形全绿，剧本失去红灯能力）。3s 窗口给 ps 采样 ~10 次，
 * 远小于 30s 阈值仍走 B2。
 *
 * 实现前 HEAD 形态（预期红）：命令官方直跑秒回——结果/无登记/无通知/无残留四断言
 * 天然绿，但「包装在场」断言红（无 taiji-fg-wrap 进程）→ uncovered 登记告知
 * 「零感知断言未在包装路径上验证」；D3 全量重跑判绿。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
	findSessionFile,
	pollSessionFile,
	pollUntil,
	psFind,
	readRegistry,
	registryPathOf,
	toolResultsFor,
	waitForBashCallStart,
	writeIdleConfig,
} from './lib/fg-bg-lib.mjs'

/** 空闲转后台阈值（秒）：30——机制在场（非 null），短命令在阈值前完成走 B2。 */
const IDLE_SEC = 30
/** 包装脚本进程名（设计 §5 部件 1：bin/taiji-fg-wrap）。 */
const WRAPPER_NAME = 'taiji-fg-wrap'
/** B2 窗口锚点命令时长（秒）：3s——ps 采样 ~10 次，远小于 30s 阈值。 */
const B2_ANCHOR_SEC = 3

/** 三条命令的输出哨兵（JSONL toolResult 锚，各不相同）。 */
const LS_MARK = 'FGBG-A4-LS-9f21'
const PNM_MARK = 'FGBG-A4-PNPM-9f22'
const B2_MARK = 'FGBG-A4-B2-9f23'
/** 命令集（设计 §6.2 V3 真机侧子集 + B2 窗口锚点）。 */
const LS_COMMAND = `echo ${LS_MARK} && ls`
const PNM_COMMAND = 'pnpm -v'
const B2_COMMAND = `echo ${B2_MARK}-START && sleep ${B2_ANCHOR_SEC} && echo ${B2_MARK}-DONE`
/** 通知原文锚：任何 [background-bash] 头行（B2 路径应零条）。 */
const NOTIFY_ANY_RE = /\[background-bash\][^\n]*/g

export const meta = {
	id: 'p1-bash-foreground-zero-perception',
	priority: 'P1',
	title: 'V3 真机零感知：机制在场时短命令包装跑——透传到达、零登记、零通知、三文件无残留',
	covers: ['env.launch', 'env.ready', 'env.doctor', 'session.create', 'chat.send', 'chat.wait', 'chat.stream'],
	requires: ['faux'],
	estimateSec: 150,
	faux: {
		responses: [
			// 轮 1：ls（短命令，自然完成走 B2）
			{ toolCalls: [{ name: 'bash', args: { command: LS_COMMAND } }], stopReason: 'toolUse' },
			// 轮 2：pnpm -v（设计 V3 原文命令）
			{ toolCalls: [{ name: 'bash', args: { command: PNM_COMMAND } }], stopReason: 'toolUse' },
			// 轮 3：3s 中速命令（B2 窗口锚点——ps 在此窗口抓包装进程）
			{ toolCalls: [{ name: 'bash', args: { command: B2_COMMAND } }], stopReason: 'toolUse' },
			// 轮 4：文本收尾（B2 无通知 → 无 steer 唤醒 → 不消耗第 5 步；若误登记误通知，
			// 唤醒的 run 会消费本步之外的空脚本以 error 收尾，通知计数断言同步红）
			{ text: 'FGBG-A4-ZERO-PERCEPTION-SEEN', stopReason: 'stop' },
		],
	},
	provable: [
		'C：三条命令结果正常到达（toolResult 输出透传：ls 哨兵 / pnpm 版本号形态 / B2 起止哨兵）',
		'C：结果文本不含 [TAIJI-FG-BG] 标记行（未转后台——B2 正常完成）',
		'C：B2 窗口锚点命令执行窗口内包装进程在场（taiji-fg-wrap，ps 可见——证明走了包装路径）',
		'C：registry 无任何登记条目（无本次调用条目）',
		'C：会话 JSONL 无任何 [background-bash] 完成通知（+8s 静默窗复查仍为 0）',
		'C：background-tasks 目录无三文件残留（*.sh / *.pid / *.log 目录枚举为空）',
	],
	notProvable: [
		'官方直跑 vs 包装跑的结果逐字对比（六族用例）——归 M2 透传等价测试族（单测）；本真机剧本只验包装跑一侧的零感知',
		'exit 7 失败命令 / 持续输出循环 / 读 stdin 命令（head -n 1）三个 V3 命令族——同归 M2 测试族与后续批次，本剧本按第二批任务范围取 ls + pnpm -v',
		'执行中流式输出的 200ms 级延迟可见性（V3 表内时序子项）——faux 无流式逐 token 观察面，留给 e2e spec / 手工验收',
	],
}

/** 读会话 JSONL 原文（通知计数按原文统计）。 */
function readRaw(sessionFile) {
	try {
		return sessionFile ? fs.readFileSync(sessionFile, 'utf8') : ''
	} catch {
		return ''
	}
}

/** 枚举 background-tasks 目录的三文件残留（*.sh / *.pid / *.log；registry.json 与 .lock 不算）。 */
function leftoverThreeFiles(dataDir, sessionId) {
	const dir = path.join(dataDir, 'ext-sessions', sessionId, 'background-tasks')
	if (!fs.existsSync(dir)) return []
	return fs.readdirSync(dir).filter((f) => /\.(sh|pid|log)$/.test(f))
}

export async function run(ctx) {
	const { protocol, ev, log, dataDir } = ctx
	const uncovered = []
	const gotchas = [
		'idleBackgroundSec=30 注入 ≠ 关闭机制——V3 验的是「机制在场时短命令零感知」，idle=null 关闭是 N3 场景（另一剧本）',
		'三文件清理断言必须搭配「包装在场」锚（3s 窗口锚点命令 + ps 抓 taiji-fg-wrap）——否则 HEAD 形态（无包装、目录本来就空）与 B2 清理生效同形全绿，剧本失去红灯能力',
		'三文件残留枚举排除 registry.json 与 .lock（B2 语义 = 删 cmd.sh/pidfile/日志三文件，registry 空表文件可留存）',
		'通知计数按 JSONL 原文 [background-bash] 头行统计；三条命令与收尾文本均不含该串，无自匹配伪命中',
		'实现前 HEAD 形态：命令官方直跑秒回，四零断言天然绿但「包装在场」断言红——uncovered 登记，D3 全量重跑判绿',
	]

	// ── 1. 注入空闲阈值（机制在场） ───────────────────────────────
	const cfgPath = writeIdleConfig(dataDir, { idleBackgroundSec: IDLE_SEC })
	ev.step({ step: 'config.idle-inject', command: `write ${cfgPath}`, exitCode: 0, stats: { idleBackgroundSec: IDLE_SEC } })

	// ── 2. 建会话（临时 cwd，不污染 repo） ────────────────────────
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-fgbg-a4-'))
	const created = await protocol.call('session.create', { cwd, label: 'p1-fgbg-a4' }, { timeoutMs: 120_000 })
	const sid = created.session?.id
	ev.assert('B: session.create 返回 sessionId', Boolean(sid), {
		channel: 'B',
		expected: 'session.id 非空',
		actual: JSON.stringify(created.session ?? {}).slice(0, 200),
	})
	if (!sid) throw new Error('session.create 未返回 sessionId')
	await protocol.subscribe(sid)
	log(`session=${sid} cwd=${cwd}`)

	// ── 3. 驱动：一次 send，faux 按序消费四步 ────────────────────
	const since = protocol.events.length
	await protocol.send(sid, 'FGBG-A4-START 依次跑三条普通命令')

	// 轮 1 ls：结果到达（结构化 toolResult 锚——原文谓词会被 assistant toolCall 的
	// arguments 命令文本抢先命中，A2 首跑实测）
	const sessionFile = created.session?.sessionFile ?? (await pollUntil(() => findSessionFile(dataDir, sid), { timeoutMs: 15_000 }))
	ev.step({ step: 'evidence.session-file', command: `locate ${sid}`, exitCode: sessionFile ? 0 : 1, stats: { sessionFile: sessionFile ?? '未找到' } })

	const lsStart = await waitForBashCallStart(protocol, sid, { commandIncludes: LS_MARK, timeoutMs: 60_000, since })
	ev.assert('B: ls 命令调用发起（tool_call_start）', Boolean(lsStart), {
		channel: 'B',
		expected: 'echo 哨兵 + ls 的 tool_call_start',
		actual: lsStart ? `at=${new Date(lsStart.receivedAt).toISOString()}` : '60s 内未观察到',
	})
	const { entries: e1 } = await pollSessionFile(
		sessionFile,
		(es) => toolResultsFor(es, 'bash').some((r) => r.text.includes(LS_MARK)),
		{ timeoutMs: 30_000 },
	)
	const lsResult = toolResultsFor(e1, 'bash').find((r) => r.text.includes(LS_MARK)) ?? null
	ev.assert('C: ls 结果到达且输出透传（含哨兵 + 目录列表非空）', Boolean(lsResult && lsResult.text.includes(LS_MARK) && lsResult.text.trim().length > LS_MARK.length), {
		channel: 'C',
		expected: `toolResult 含 ${LS_MARK} 且有目录内容`,
		actual: lsResult ? lsResult.text.slice(0, 200) : '30s 内无 toolResult',
	})
	ev.step({ step: 'bash.ls', command: LS_COMMAND, exitCode: lsResult ? 0 : 1, stats: { arrived: Boolean(lsResult) } })

	// 轮 2 pnpm -v：版本号形态
	const pnpmStart = await waitForBashCallStart(protocol, sid, { commandIncludes: 'pnpm -v', timeoutMs: 60_000, since })
	ev.assert('B: pnpm -v 命令调用发起（tool_call_start）', Boolean(pnpmStart), {
		channel: 'B',
		expected: 'pnpm -v 的 tool_call_start',
		actual: pnpmStart ? `at=${new Date(pnpmStart.receivedAt).toISOString()}` : '60s 内未观察到',
	})
	const { entries: e2 } = await pollSessionFile(
		sessionFile,
		(es) => toolResultsFor(es, 'bash').some((r) => /\d+\.\d+\.\d+/.test(r.text) && !r.text.includes(LS_MARK)),
		{ timeoutMs: 30_000 },
	)
	const pnpmResult = toolResultsFor(e2, 'bash').find((r) => /\d+\.\d+\.\d+/.test(r.text) && !r.text.includes(LS_MARK)) ?? null
	ev.assert('C: pnpm -v 结果到达且为版本号形态（无 command not found）', Boolean(pnpmResult && /\d+\.\d+\.\d+/.test(pnpmResult.text) && !pnpmResult.text.includes('command not found')), {
		channel: 'C',
		expected: 'toolResult 含 semver 版本号',
		actual: pnpmResult ? pnpmResult.text.trim().slice(0, 120) : '30s 内无版本号形态 toolResult',
	})
	ev.step({ step: 'bash.pnpm-v', command: PNM_COMMAND, exitCode: pnpmResult ? 0 : 1, stats: { arrived: Boolean(pnpmResult) } })

	// 轮 3 B2 窗口锚点：先等 tool_call_start，窗口内抓包装进程，再等结果
	const b2Start = await waitForBashCallStart(protocol, sid, { commandIncludes: `${B2_MARK}-START`, timeoutMs: 60_000, since })
	ev.assert('B: B2 窗口锚点命令调用发起（tool_call_start）', Boolean(b2Start), {
		channel: 'B',
		expected: 'sleep 3 锚点命令的 tool_call_start',
		actual: b2Start ? `at=${new Date(b2Start.receivedAt).toISOString()}` : '60s 内未观察到',
	})
	// 包装进程抓取窗口 = 命令自然时长 3s + 派发开销；间隔 200ms 采样
	const wrapperSeen = await pollUntil(() => psFind(WRAPPER_NAME)[0], { timeoutMs: (B2_ANCHOR_SEC + 4) * 1000, intervalMs: 200 })
	ev.assert('C: B2 窗口内包装进程在场（taiji-fg-wrap，ps 可见——证明走了包装路径）', Boolean(wrapperSeen), {
		channel: 'C',
		expected: `ps 含 ${WRAPPER_NAME}（${B2_ANCHOR_SEC}s 窗口）`,
		actual: wrapperSeen ? `pid=${wrapperSeen.pid}` : '窗口内未见包装进程（实现前 HEAD 形态：官方直跑无包装）',
	})
	if (wrapperSeen) ev.attach('b2-wrapper-ps', JSON.stringify(wrapperSeen, null, 2))

	const { entries: e3 } = await pollSessionFile(
		sessionFile,
		(es) => toolResultsFor(es, 'bash').some((r) => r.text.includes(`${B2_MARK}-DONE`)),
		{ timeoutMs: 30_000 },
	)
	const b2Result = toolResultsFor(e3, 'bash').find((r) => r.text.includes(`${B2_MARK}-DONE`)) ?? null
	ev.assert('C: B2 锚点命令自然完成、起止输出均透传（START + DONE）', Boolean(b2Result && b2Result.text.includes(`${B2_MARK}-START`) && b2Result.text.includes(`${B2_MARK}-DONE`)), {
		channel: 'C',
		expected: `toolResult 含 ${B2_MARK}-START 与 ${B2_MARK}-DONE`,
		actual: b2Result ? b2Result.text.slice(0, 300) : '30s 内无 toolResult',
	})
	ev.step({ step: 'bash.b2-anchor', command: B2_COMMAND, exitCode: b2Result ? 0 : 1, stats: { arrived: Boolean(b2Result), wrapperSeen: Boolean(wrapperSeen) } })

	// ── 4. 零感知核心断言（三条结果都不含标记行） ─────────────────
	const allResults = [lsResult, pnpmResult, b2Result]
	const withMarker = allResults.filter((r) => r && r.text.includes('[TAIJI-FG-BG]'))
	ev.assert('C: 三条结果文本均不含 [TAIJI-FG-BG] 标记行（未转后台）', withMarker.length === 0, {
		channel: 'C',
		expected: '含标记行的结果数 = 0',
		actual: `含标记行 ${withMarker.length} 条${withMarker.length > 0 ? `：${withMarker.map((r) => r.text.slice(0, 120)).join(' / ')}` : ''}`,
	})

	// ── 5. turn 收尾（一次 complete，无通知唤醒的第二轮） ─────────
	let end1 = null
	try {
		end1 = await protocol.waitTurnEnd(sid, { since, timeoutMs: 60_000 })
	} catch (e) {
		ev.attach('turn1-end-miss', String(e?.message ?? e).slice(0, 600))
	}
	ev.assert('B: turn 以 message.complete 收尾（单次——B2 零感知无通知唤醒）', end1?.type === 'message.complete' && end1.ok, {
		channel: 'B',
		expected: 'message.complete（faux 轮 4 文本收尾）',
		actual: end1 ? `${end1.type} stop=${String(end1.payload?.stopReason)}` : '未等到',
	})

	// ── 6. 无登记条目（registry 空） ─────────────────────────────
	// 读盘前给收尾 IO 一个短窗；registry.json 可能不存在（无任何后台任务 = 最干净形态）
	await new Promise((r) => setTimeout(r, 1_500))
	const registryRaw = readRegistry(dataDir, sid)
	const entryValues = Array.isArray(registryRaw)
		? registryRaw
		: Array.isArray(registryRaw?.entries)
			? registryRaw.entries
			: Object.values(registryRaw?.entries ?? {})
	const entryCount = (entryValues ?? []).filter((e) => e && typeof e === 'object').length
	ev.assert('C: registry 无任何登记条目（B2 不登记）', entryCount === 0, {
		channel: 'C',
		expected: 'entries 数 = 0（或 registry.json 不存在）',
		actual: registryRaw === null ? 'registry.json 不存在（零登记最干净形态）' : `entries 数 = ${entryCount}：${JSON.stringify(entryValues).slice(0, 300)}`,
	})
	ev.step({ step: 'evidence.registry-empty', command: `read ${registryPathOf(dataDir, sid)}`, exitCode: entryCount === 0 ? 0 : 1, stats: { entryCount, fileExists: registryRaw !== null } })

	// ── 7. 无任何完成通知（+8s 静默窗复查） ──────────────────────
	await new Promise((r) => setTimeout(r, 8_000))
	const notifyHeads = readRaw(sessionFile).match(NOTIFY_ANY_RE) ?? []
	ev.assert('C: 会话 JSONL 无任何 [background-bash] 完成通知（+8s 静默窗）', notifyHeads.length === 0, {
		channel: 'C',
		expected: 'count=0',
		actual: `count=${notifyHeads.length}${notifyHeads.length > 0 ? `：${notifyHeads.slice(0, 3).join(' | ').slice(0, 300)}` : ''}`,
	})

	// ── 8. 三文件无残留（目录枚举） ──────────────────────────────
	const leftovers = leftoverThreeFiles(dataDir, sid)
	ev.assert('C: background-tasks 目录无三文件残留（*.sh / *.pid / *.log 枚举为空）', leftovers.length === 0, {
		channel: 'C',
		expected: 'B2 清理后无 <taskId>.sh / <taskId>.pid / <taskId>.log（registry.json 不计）',
		actual: leftovers.length === 0 ? '目录无三文件形态残留' : `残留：${leftovers.join(', ')}`,
	})
	ev.step({ step: 'evidence.three-files-clean', command: `ls ${path.join(dataDir, 'ext-sessions', sid, 'background-tasks')}`, exitCode: leftovers.length === 0 ? 0 : 1, stats: { leftovers } })

	if (!wrapperSeen) {
		uncovered.push('V3 零感知四断言未在包装路径上验证（B2 窗口内无 taiji-fg-wrap 进程——实现前 HEAD 形态官方直跑；D1 开发中，D3 全量重跑本剧本判绿）')
	}
	log(`done sid=${sid} wrapper=${wrapperSeen ? 'seen' : 'miss'} notify=${notifyHeads.length} leftovers=${leftovers.length}`)
	return { uncovered, gotchas }
}
