/**
 * scheduler 创建确认的 TUI 组件（ScheduleCreateComponent，pi-tui Component）。
 *
 * 交互形态 = .tmp/tui-schedule-demo.mjs（demo v2，多 tab 表单）转正，状态机范式
 * 对齐 ask-user 的 AskUserComponent（confirmed 不变式 / autoConfirmIfAnswered /
 * pendingCancel 两段取消）：
 *
 *   5 tab：模式 → 时间 → 模型 → 提示词 → 提交
 *   - Enter 逐题确认前进；←/→ 任意切 tab（切走时已答未确认自动提升为已确认）
 *   - 一次性时间 = datetime 掩码光标编辑（数字逐位覆盖、分隔符自动跳过、
 *     退格/DEL 无效）；自定义 cron 与提示词 = 插入式光标编辑（码点级）
 *   - Submit tab 汇总四项确认门（全 confirmed 且全 valid 才可提交）
 *   - 两段 Esc 取消（首 tab 第一段进入待确认、任意非 Esc 键清除、第二段取消）
 *
 * 消费方式（U2 接线方，与 ask-user 的 runTuiInteraction 同构）：
 *
 *   const result = await ctx.ui.custom<ScheduleFormResult | null>(
 *     (tui, theme, _kb, done) => {
 *       const comp = new ScheduleCreateComponent(draft, tui, theme, done)
 *       signal?.addEventListener('abort', () => comp.cancel(), { once: true })
 *       return comp
 *     },
 *   )
 *   // result: ScheduleFormResult（确认）| null（用户取消）| undefined（abort 等）
 *
 * 数据契约（@zhushanwen/extension-protocol，U1）：入参 ScheduleDraft，回传
 * ScheduleFormResult | null。模型列表读 draft.models（组件不自取 settings）；
 * 一次性时间初值由 draft.schedule 经 onceCronToDate 还原（D2 单点，禁止本地重写）；
 * once → cron 折叠回传走 dateToOnceCron（同一单点）。
 */

import { matchesKey, parseKey, truncateToWidth, wrapTextWithAnsi, type Component } from '@earendil-works/pi-tui'
import {
	dateToOnceCron,
	onceCronToDate,
	type ScheduleDraft,
	type ScheduleFormResult,
} from '@zhushanwen/extension-protocol'

import { computeNextRuns, MS_PER_DAY, MS_PER_HOUR, MS_PER_MINUTE, parseSchedule } from './parsing.js'

// ── 组件私有最小接口（同构 ask-user 的 TUILike/ThemeLike，满足真实 TUI 与测试 stub）──

export interface TUILike {
	requestRender(): void
}

export interface ThemeLike {
	fg(token: string, text: string): string
	bg(token: string, text: string): string
	bold(text: string): string
	/** 光标位反显（pi-tui theme 的 inverse；ask-user 未用光标渲染故其 ThemeLike 无此方法） */
	inverse(text: string): string
}

// ── 常量 ──

/** tab 顺序：0 模式 / 1 时间 / 2 模型 / 3 提示词 / 4 提交 */
const TAB_KIND = 0
const TAB_TIME = 1
const TAB_MODEL = 2
const TAB_PROMPT = 3
const SUBMIT_TAB = 4

/** 表单四题的确认态/有效性索引（confirmed / answerValid 共用） */
const ANSWER_KIND = 0
const ANSWER_TIME = 1
const ANSWER_MODEL = 2
const ANSWER_PROMPT = 3

const TAB_NAMES = ['模式', '时间', '模型', '提示词', '提交'] as const

const CRON_PRESETS = [
	{ label: '每 5 分钟', cron: '*/5 * * * *' },
	{ label: '每 30 分钟', cron: '*/30 * * * *' },
	{ label: '每小时', cron: '0 * * * *' },
	{ label: '每天 09:00', cron: '0 9 * * *' },
	{ label: '工作日 09:00', cron: '0 9 * * 1-5' },
] as const

const ONCE_PRESETS = [
	{ label: '15 分钟后', mins: 15 },
	{ label: '30 分钟后', mins: 30 },
	{ label: '1 小时后', mins: 60 },
] as const

/** datetime 掩码形态 "YYYY-MM-DD HH:mm" 的码点长度（纯 ASCII，= UTF-16 长度） */
const MASK_LENGTH = 16
/** 掩码固定分隔符位：YYYY-MM-DD HH:mm 的段边界（年|月、月|日、日|时、时|分） */
const MASK_SEP_YEAR_MONTH = 4
const MASK_SEP_MONTH_DAY = 7
const MASK_SEP_DAY_HOUR = 10
const MASK_SEP_HOUR_MINUTE = 13
const MASK_SEPARATORS = new Set([MASK_SEP_YEAR_MONTH, MASK_SEP_MONTH_DAY, MASK_SEP_DAY_HOUR, MASK_SEP_HOUR_MINUTE])
const MASK_EMPTY = '    -  -     :  '

/** cron/duration 编辑器的字符白名单：cron 语法字符 + duration 单位字母（draft.schedule 允许 "5m" 形态） */
const CRON_CHARS = /^[0-9smhdSMHD \*\/,\-]$/
/** 提示词可插入字符（控制字符之外全放行；中文/emoji 走码点级插入） */
const PROMPT_CHAR = (c: string): boolean => c >= ' '

/** box 边框左右各占 1 列 */
const BORDER_OVERHEAD = 2

/** 提示词正文/预览区的两空格缩进宽度（折行宽度相应收窄） */
const PROMPT_INDENT_WIDTH = 2
/** 提示词摘要行的最小可读宽度与行宽保留（renderSubmitTab 截断用） */
const SUMMARY_MIN_WIDTH = 8
const SUMMARY_RESERVE_WIDTH = 16
/** recurring 下次运行预览：取的运行数与展示条数（demo v2 形态） */
const PREVIEW_RUN_COUNT = 5
const PREVIEW_DISPLAY_COUNT = 3

// ── 编辑器（free / cron 插入式；datetime 掩码覆盖式）──
// cursor 为 UTF-16 index（surrogate pair 感知，同 ask-user editor-ops 的成熟语义）。

export type EditorMode = 'free' | 'cron' | 'datetime'

export interface EditorState {
	text: string
	cursor: number
	mode: EditorMode
}

function newEditor(text: string, mode: EditorMode): EditorState {
	return { text, cursor: text.length, mode }
}

// ── UTF-16 surrogate pair 工具（同 ask-user types.ts 的命名与语义）──
/** 高代理位掩码：charCode & 0xFC00 === 0xD800 判定 surrogate pair 前半 */
const SURROGATE_HIGH_MASK = 0xfc00
/** 高代理起始码点（surrogate pair 前半的判定值） */
const SURROGATE_HIGH_START = 0xd800
/** 一个 surrogate pair 占用的 UTF-16 code unit 数 */
const SURROGATE_PAIR_LEN = 2

function isHighSurrogate(s: string, i: number): boolean {
	return (s.charCodeAt(i) & SURROGATE_HIGH_MASK) === SURROGATE_HIGH_START
}

function editorMoveLeft(e: EditorState): void {
	const left = e.cursor - 1
	e.cursor = left > 0 && isHighSurrogate(e.text, left - 1) ? left - 1 : Math.max(0, left)
}

function editorMoveRight(e: EditorState): void {
	e.cursor = isHighSurrogate(e.text, e.cursor)
		? Math.min(e.text.length, e.cursor + SURROGATE_PAIR_LEN)
		: Math.min(e.text.length, e.cursor + 1)
}

function editorMoveHome(e: EditorState): void {
	e.cursor = 0
}

function editorMoveEnd(e: EditorState): void {
	e.cursor = e.text.length
}

/** 退格：删光标前一个码点（surrogate pair 整对删）。datetime 掩码无效。 */
function editorBackspace(e: EditorState): void {
	if (e.mode === 'datetime') return
	if (e.cursor <= 0) return
	const count = e.cursor >= SURROGATE_PAIR_LEN && isHighSurrogate(e.text, e.cursor - SURROGATE_PAIR_LEN) ? SURROGATE_PAIR_LEN : 1
	e.text = e.text.slice(0, e.cursor - count) + e.text.slice(e.cursor)
	e.cursor -= count
}

/** DEL：删光标处一个码点。datetime 掩码无效。 */
function editorDelete(e: EditorState): void {
	if (e.mode === 'datetime') return
	if (e.cursor >= e.text.length) return
	const count = isHighSurrogate(e.text, e.cursor) ? SURROGATE_PAIR_LEN : 1
	e.text = e.text.slice(0, e.cursor) + e.text.slice(e.cursor + count)
}

/** 输入一个字符：datetime 掩码逐位覆盖（分隔符自动跳过），其余模式插入。 */
function editorTypeChar(e: EditorState, c: string): void {
	if (e.mode === 'datetime') {
		if (!/^[0-9]$/.test(c)) return
		if (MASK_SEPARATORS.has(e.cursor)) e.cursor++
		if (e.cursor >= MASK_LENGTH) return
		const chars = e.text.padEnd(MASK_LENGTH, ' ').split('')
		chars[e.cursor] = c
		e.text = chars.join('')
		e.cursor++
		return
	}
	if (e.mode === 'cron' && !CRON_CHARS.test(c)) return
	e.text = e.text.slice(0, e.cursor) + c + e.text.slice(e.cursor)
	e.cursor += c.length
}

/** 渲染带光标的文本：光标处码点反显（surrogate pair 整对反显；行尾则反显空格）。 */
function editorRender(e: EditorState, theme: ThemeLike): string {
	const char = isHighSurrogate(e.text, e.cursor)
		? e.text.slice(e.cursor, e.cursor + SURROGATE_PAIR_LEN)
		: (e.text[e.cursor] ?? ' ')
	return e.text.slice(0, e.cursor) + theme.inverse(char) + e.text.slice(e.cursor + char.length)
}

/** 编辑态单键 → 编辑器操作查找表（退格/DEL/光标移动；Esc/Enter 语义键不在表内，由 handleEditorInput 先行处理）。 */
const EDITOR_KEY_OPS = [
	['backspace', editorBackspace],
	['delete', editorDelete],
	['left', editorMoveLeft],
	['right', editorMoveRight],
	['home', editorMoveHome],
	['end', editorMoveEnd],
] as const

// ── 本地墙钟格式化/解析（datetime 掩码形态 "YYYY-MM-DD HH:mm"，本地时区）──

/** 两位数字宽度（pad2 的 padStart 宽度） */
const PAD2_WIDTH = 2
const pad2 = (n: number): string => String(n).padStart(PAD2_WIDTH, '0')

function formatLocal(d: Date): string {
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'] as const

function formatAbs(d: Date): string {
	return `${formatLocal(d)} 周${WEEKDAYS[d.getDay()]}`
}

function formatRelative(ms: number): string {
	if (ms < MS_PER_MINUTE) return '不到 1 分钟后'
	if (ms < MS_PER_HOUR) {
		const h = Math.floor(ms / MS_PER_HOUR)
		const m = Math.round((ms % MS_PER_HOUR) / MS_PER_MINUTE)
		return m ? `${h} 小时 ${m} 分后` : `${h} 小时后`
	}
	return `${Math.round(ms / MS_PER_DAY)} 天后`
}

/** 掩码文本 → 本地时刻。格式错 / 字段越界（Date 回验）/ 不晚于当前 → null。 */
function parseMaskedDate(text: string, now: Date): Date | null {
	const m = text.trim().match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/)
	if (!m) return null
	const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), 0, 0)
	if (
		Number.isNaN(d.getTime()) ||
		d.getFullYear() !== Number(m[1]) ||
		d.getMonth() !== Number(m[2]) - 1 ||
		d.getDate() !== Number(m[3]) ||
		d.getHours() !== Number(m[4]) ||
		d.getMinutes() !== Number(m[5]) ||
		d.getTime() <= now.getTime()
	) {
		return null
	}
	return d
}

// ── ScheduleCreateComponent ──

export type ScheduleCreateResult = ScheduleFormResult | null

export class ScheduleCreateComponent implements Component {
	private readonly draft: ScheduleDraft
	private readonly tui: TUILike
	private readonly theme: ThemeLike
	private readonly done: (result: ScheduleCreateResult) => void

	private tab = 0
	/** 每题确认态（Submit 门：前 4 项全 true） */
	private confirmed: [boolean, boolean, boolean, boolean] = [false, false, false, false]

	// tab0 模式
	private kindCursor = 0

	// tab1 时间
	private kind: ScheduleDraft['kind']
	private cronText: string
	private timeCursor = 0
	private cronEdit: EditorState | null = null
	private onceDate: Date | null
	private oncePresetIndex: number | null = null
	private onceEdit: EditorState | null = null

	// tab2 模型
	private modelCursor = 0

	// tab3 提示词
	private prompt: string
	private promptEdit: EditorState | null = null

	// tab4 提交
	private submitFocus: 0 | 1 = 0

	private pendingCancel = false
	private resolved = false

	private cachedWidth?: number
	private cachedLines?: string[]

	constructor(draft: ScheduleDraft, tui: TUILike, theme: ThemeLike, done: (result: ScheduleCreateResult) => void) {
		this.draft = draft
		this.tui = tui
		this.theme = theme
		this.done = done

		this.kind = draft.kind
		// 模式 tab 光标与 draft.kind 一致（Enter 确认模式 tab 时按光标位定 kind）
		this.kindCursor = draft.kind === 'once' ? 1 : 0
		this.prompt = draft.prompt

		// 模型预选：draft.model 精确匹配 → 会话当前模型（精确/后缀）→ 首个
		const models = draft.models
		const byModel = draft.model ? models.indexOf(draft.model) : -1
		const current = draft.currentModel
		const byCurrent =
			current !== undefined
				? models.findIndex((m) => m === current || (current.includes('/') ? m === current : m.endsWith(`/${current}`)))
				: -1
		this.modelCursor = byModel >= 0 ? byModel : byCurrent >= 0 ? byCurrent : 0

		// 时间初值：recurring 直接取 draft.schedule（cron 或 duration）；once 经
		// onceCronToDate 还原（U1 单点），还原失败（非一次性形态/非法）→ 待用户选择
		if (draft.kind === 'once') {
			this.cronText = ''
			this.onceDate = onceCronToDate(draft.schedule)
			if (this.onceDate === null) {
				// 无初值 → 预选首个一次性预设（demo 行为：进入一次性模式给出可确认的默认）
				this.onceDate = onceDateForPreset(0)
				this.oncePresetIndex = 0
			}
		} else {
			this.cronText = draft.schedule
			this.onceDate = null
			this.timeCursor = tab1ItemCount('recurring') - 1
			const presetIndex = CRON_PRESETS.findIndex((p) => p.cron === draft.schedule)
			if (presetIndex >= 0) this.timeCursor = presetIndex
		}

		this.invalidate()
	}

	// ── 派生状态 ──

	private selectedModel(): string | undefined {
		return this.draft.models[this.modelCursor]
	}

	private currentOnceDate(now: Date = new Date()): Date | null {
		if (this.onceEdit) {
			const d = parseMaskedDate(this.onceEdit.text, now)
			if (d) return d
		}
		return this.onceDate
	}

	private cronSpec(): ReturnType<typeof parseSchedule> {
		return parseSchedule(this.cronText)
	}

	private timeValid(now: Date = new Date()): boolean {
		if (this.kind !== 'once') return this.cronSpec() !== undefined
		const d = this.currentOnceDate(now)
		// 已过时刻对 once 无效：dateToOnceCron 折叠的无年份 cron 会被 croner 静默顺延到
		// 明年同刻（用户意图的「今天 14:30」变「明年今天 14:30」）。编辑态 parseMaskedDate
		// 已拒，这里补非编辑态（preset 选定 / draft 预填后停留至过期）——表单持完整
		// 时刻（含年份），是唯一能精确判定的层
		return d !== null && d.getTime() > now.getTime()
	}

	private answerValid(index: number, now: Date = new Date()): boolean {
		switch (index) {
			case ANSWER_KIND:
				return true
			case ANSWER_TIME:
				return this.timeValid(now)
			case ANSWER_MODEL:
				// models 空 = 无可选列表，缺省跟随会话当前模型（恒有效）
				return this.draft.models.length === 0 || this.selectedModel() !== undefined
			case ANSWER_PROMPT:
				return this.prompt.trim().length > 0
			default:
				return false
		}
	}

	private allConfirmed(): boolean {
		return this.confirmed.every(Boolean)
	}

	private canSubmit(now: Date = new Date()): boolean {
		return this.confirmed.every((c, i) => c && this.answerValid(i, now))
	}

	private editing(): boolean {
		return this.cronEdit !== null || this.onceEdit !== null || this.promptEdit !== null
	}

	// ── 导航（对齐 ask-user gotoTab + autoConfirmIfAnswered）──

	private autoConfirmIfAnswered(): void {
		if (this.tab >= SUBMIT_TAB) return
		if (!this.confirmed[this.tab] && this.answerValid(this.tab)) this.confirmed[this.tab] = true
	}

	private gotoTab(target: number): void {
		this.tab = Math.max(0, Math.min(SUBMIT_TAB, target))
		if (this.tab === SUBMIT_TAB) this.submitFocus = 0
		this.pendingCancel = false
		this.invalidate()
		this.tui.requestRender()
	}

	private leaveTabForward(): void {
		this.gotoTab(this.tab + 1)
	}

	// ── Component 契约 ──

	invalidate(): void {
		this.cachedWidth = undefined
		this.cachedLines = undefined
	}

	private rerender(): void {
		this.invalidate()
		this.tui.requestRender()
	}

	render(width: number): string[] {
		if (this.cachedWidth === width && this.cachedLines) return this.cachedLines
		const t = this.theme
		const innerWidth = Math.max(0, width - BORDER_OVERHEAD)
		const inner: string[] = []

		const cancelHint = this.pendingCancel ? '  ' + t.fg('warning', '再按一次 Esc 确认取消') : ''
		inner.push(t.bold('schedule ') + t.fg('dim', '创建定时任务') + '   ' + this.renderTabBar() + cancelHint)

		if (this.pendingCancel) {
			inner.push('')
			inner.push(t.fg('warning', t.bold(' 确认取消创建？')))
			inner.push('')
			inner.push(t.fg('text', ' 已填内容将被丢弃，任务不会创建。'))
			inner.push('')
			inner.push(t.fg('dim', ' Esc 确认取消 · 任意其他键返回表单'))
		} else {
			switch (this.tab) {
				case TAB_KIND:
					this.renderKindTab(inner)
					break
				case TAB_TIME:
					this.renderTimeTab(inner, innerWidth)
					break
				case TAB_MODEL:
					this.renderModelTab(inner)
					break
				case TAB_PROMPT:
					this.renderPromptTab(inner, innerWidth)
					break
				case SUBMIT_TAB:
					this.renderSubmitTab(inner, innerWidth)
					break
			}
		}

		inner.push('')
		const escHint = this.tab === 0 && !this.editing() ? '取消(两次)' : '回上一 tab'
		inner.push(t.fg('dim', `  ←/→ 切 tab · ↑/↓ 选 · Enter 确认/编辑 · Esc ${escHint}`))

		const lines = [t.fg('dim', `┌${'─'.repeat(innerWidth)}┐`)]
		for (const line of inner) {
			lines.push(`${t.fg('dim', '│')}${truncateToWidth(line, innerWidth, '', true)}${t.fg('dim', '│')}`)
		}
		lines.push(t.fg('dim', `└${'─'.repeat(innerWidth)}┘`))

		this.cachedWidth = width
		this.cachedLines = lines
		return lines
	}

	private renderTabBar(): string {
		const t = this.theme
		const parts: string[] = []
		TAB_NAMES.forEach((name, i) => {
			let label = `${i + 1} ${name}`
			if (i < SUBMIT_TAB && this.confirmed[i]) label += ' ✓'
			if (i === this.tab) {
				parts.push(t.bg('selectedBg', t.fg('text', ` ${label} `)))
			} else if (i === SUBMIT_TAB && !this.allConfirmed()) {
				parts.push(t.fg('dim', ` ${label} `))
			} else if (i < SUBMIT_TAB && this.confirmed[i]) {
				parts.push(t.fg('success', ` ${label} `))
			} else {
				parts.push(` ${label} `)
			}
		})
		return parts.join(t.fg('dim', ' │ '))
	}

	private renderKindTab(inner: string[]): void {
		const t = this.theme
		inner.push(t.bold('执行模式') + t.fg('dim', '  （任务到点后以所选模式触发）'))
		inner.push('')
		const options: Array<[label: string, desc: string]> = [
			['循环', '按节奏重复执行（cron 或固定间隔）'],
			['一次性', '到指定时刻执行一次后自动移除'],
		]
		options.forEach(([label, desc], i) => {
			const selected = (this.kind === 'recurring' ? 0 : 1) === i
			const mark = selected ? t.fg('success', '●') : t.fg('dim', '○')
			const cursor = this.kindCursor === i ? t.fg('accent', '>') : ' '
			inner.push(`${cursor} ${mark} ${label}${t.fg('dim', `  ${desc}`)}`)
		})
	}

	private renderTimeTab(inner: string[], innerWidth: number): void {
		const t = this.theme
		inner.push(t.bold('执行时间') + t.fg('dim', this.kind === 'recurring' ? '  （循环节奏，Enter 选中并继续）' : '  （一次性时刻，Enter 选中并继续）'))
		inner.push('')

		if (this.kind === 'recurring') {
			CRON_PRESETS.forEach((p, i) => {
				inner.push(this.optionLine(this.cronText === p.cron, this.timeCursor === i, p.label, p.cron))
			})
			const isPreset = CRON_PRESETS.some((p) => p.cron === this.cronText)
			const customIndex = CRON_PRESETS.length
			if (this.cronEdit) {
				inner.push(`${this.timeCursor === customIndex ? t.fg('accent', '>') : ' '} ${t.fg('success', '●')} 自定义: ${editorRender(this.cronEdit, t)}`)
				inner.push(`     ${t.fg('dim', '←→ 移动光标 · 退格/DEL 删除 · Enter 保存 · Esc 放弃')}`)
			} else {
				inner.push(this.optionLine(!isPreset, this.timeCursor === customIndex, '自定义 cron', isPreset ? '' : this.cronText))
			}
		} else {
			ONCE_PRESETS.forEach((p, i) => {
				inner.push(this.optionLine(this.oncePresetIndex === i, this.timeCursor === i, p.label, formatAbs(onceDateForPreset(i))))
			})
			const customIndex = ONCE_PRESETS.length
			const customSelected = this.oncePresetIndex === null && this.onceDate !== null
			if (this.onceEdit) {
				inner.push(`${this.timeCursor === customIndex ? t.fg('accent', '>') : ' '} ${t.fg('success', '●')} 自定义时间: ${editorRender(this.onceEdit, t)}`)
				inner.push(`     ${t.fg('dim', '数字覆盖所在位 · ←→ 移动光标（自动跳过分隔符） · Enter 保存 · Esc 放弃')}`)
			} else {
				inner.push(this.optionLine(customSelected, this.timeCursor === customIndex, '自定义时间', this.onceDate ? formatAbs(this.onceDate) : 'YYYY-MM-DD HH:mm'))
			}
		}

		inner.push('')
		inner.push(t.fg('dim', '  下次运行'))
		for (const line of this.previewLines(innerWidth)) inner.push(line)
	}

	private renderModelTab(inner: string[]): void {
		const t = this.theme
		const models = this.draft.models
		inner.push(t.bold('执行模型') + t.fg('dim', `  （可选模型 ${models.length} 个，Enter 选中并继续）`))
		inner.push('')
		if (models.length === 0) {
			inner.push(t.fg('dim', '  （无可选模型，跟随会话当前模型）'))
			return
		}
		models.forEach((m, i) => {
			const selected = this.selectedModel() === m
			const isCurrent = m === this.draft.currentModel
			const mark = selected ? t.fg('success', '●') : t.fg('dim', '○')
			const cursor = this.modelCursor === i ? t.fg('accent', '>') : ' '
			inner.push(`${cursor} ${mark} ${m}${isCurrent ? t.fg('dim', '  当前会话') : ''}`)
		})
	}

	private renderPromptTab(inner: string[], innerWidth: number): void {
		const t = this.theme
		const textWidth = Math.max(1, innerWidth - PROMPT_INDENT_WIDTH)
		if (this.promptEdit) {
			inner.push(t.bold('提示词') + t.fg('dim', '  （任务触发时注入给 agent 的消息）'))
			inner.push('')
			for (const line of wrapTextWithAnsi(editorRender(this.promptEdit, t), textWidth)) {
				inner.push('  ' + line)
			}
			inner.push('')
			inner.push(t.fg('dim', '  ←→ 移动光标 · 退格/DEL 删除 · Enter 保存并继续 · Esc 放弃'))
		} else {
			inner.push(t.bold('提示词') + t.fg('dim', '  （任务触发时注入给 agent 的消息，Enter 开始编辑）'))
			inner.push('')
			for (const line of wrapTextWithAnsi(this.prompt, textWidth)) {
				inner.push('  ' + line)
			}
			inner.push('')
			inner.push(t.fg('dim', `  ${[...this.prompt].length} 字${this.prompt.trim() ? '' : t.fg('warning', '（不能为空）')}`))
		}
	}

	private renderSubmitTab(inner: string[], innerWidth: number): void {
		const t = this.theme
		inner.push(t.bold('确认创建'))
		inner.push('')

		for (const [label, value, ok] of this.submitRows(innerWidth)) {
			inner.push(`  ${ok ? t.fg('success', '✓') : t.fg('warning', '✗')} ${t.fg('dim', label)}  ${value}`)
		}

		inner.push('')
		for (const line of this.previewLines(innerWidth)) inner.push(line)
		inner.push('')

		if (!this.canSubmit()) {
			inner.push(`  ${t.fg('warning', '✗')} ${t.fg('dim', '仍有未完成的配置项（见上方 ✗ 行），补全后才能提交')}`)
		}
		this.renderSubmitButtons(inner)
	}

	/** Submit tab 四行汇总（模式/时间/模型/提示词）：label + value + 确认门 ok。 */
	private submitRows(innerWidth: number): Array<[label: string, value: string, ok: boolean]> {
		const t = this.theme
		const onceDate = this.currentOnceDate()
		return [
			['模式', this.kind === 'recurring' ? '循环' : '一次性', this.confirmed[0]],
			['时间', this.submitTimeValue(onceDate), this.confirmed[1] && this.timeValid()],
			['模型', this.selectedModel() ?? t.fg('dim', '（跟随会话当前模型）'), this.confirmed[ANSWER_MODEL] && this.answerValid(ANSWER_MODEL)],
			['提示词', this.submitPromptValue(innerWidth), this.confirmed[ANSWER_PROMPT] && this.answerValid(ANSWER_PROMPT)],
		]
	}

	/** 时间行 value：once 显示确认时刻（未设置/已过则警示），recurring 显示表达式 + 无效标记。 */
	private submitTimeValue(onceDate: Date | null): string {
		const t = this.theme
		if (this.kind === 'once') {
			if (!onceDate) return t.fg('warning', '未设置')
			return onceDate.getTime() > Date.now()
				? `${formatAbs(onceDate)}（一次性）`
				: `${formatAbs(onceDate)}（一次性${t.fg('warning', '，时刻已过')}）`
		}
		return this.cronText + (this.timeValid() ? '' : t.fg('warning', '（表达式无效）'))
	}

	/** 提示词行 value：非空截断为摘要，空则警示。 */
	private submitPromptValue(innerWidth: number): string {
		const trimmed = this.prompt.trim()
		if (!trimmed) return this.theme.fg('warning', '（为空）')
		return truncateToWidth(trimmed, Math.max(SUMMARY_MIN_WIDTH, innerWidth - SUMMARY_RESERVE_WIDTH), '…')
	}

	/** Submit tab 底部按钮区：确认/取消 两 cell 按焦点与提交门着色。 */
	private renderSubmitButtons(inner: string[]): void {
		const t = this.theme
		const submitLabel = '[确认创建]'
		const submitCell =
			this.submitFocus === 0
				? t.fg('accent', submitLabel)
				: this.canSubmit()
					? submitLabel
					: t.fg('dim', submitLabel)
		inner.push(`  ${submitCell}${this.submitFocus === 0 ? t.fg('dim', '  ← Enter 提交') : ''}`)
		const cancelCell = this.submitFocus === 1 ? t.fg('accent', '>[取消]') : '  [取消]'
		inner.push(`  ${cancelCell}`)
	}

	private optionLine(selected: boolean, hovered: boolean, label: string, sub: string): string {
		const t = this.theme
		const mark = selected ? t.fg('success', '●') : t.fg('dim', '○')
		const cursor = hovered ? t.fg('accent', '>') : ' '
		const subText = sub ? t.fg('dim', `  ${sub}`) : ''
		return `${cursor} ${mark} ${label}${subText}`
	}

	/** 下次运行预览（once = 确认时刻；recurring = parseSchedule + computeNextRuns 前 3 条） */
	private previewLines(innerWidth: number): string[] {
		const t = this.theme
		const now = new Date()
		if (this.kind === 'once') {
			const d = this.currentOnceDate(now)
			if (!d) {
				return [`${t.fg('warning', '✗')} ${this.onceEdit ? '日期无效（YYYY-MM-DD HH:mm，须晚于当前）' : '尚未选择时间'}`]
			}
			// 已过警示（timeValid 同判）：无年份 once-cron 提交后会被 croner 顺延到明年同刻
			if (d.getTime() <= now.getTime()) {
				return [`${t.fg('warning', '✗')} ${formatAbs(d)} 已过，请重选未来时刻（否则将顺延到明年同刻执行）`]
			}
			return [`${t.fg('success', '✓')} ${formatAbs(d)} · ${t.fg('accent', formatRelative(d.getTime() - now.getTime()))}（一次性）`]
		}
		const spec = this.cronSpec()
		if (!spec) {
			return [`${t.fg('warning', '✗')} 表达式无效（cron 5 段：分 时 日 月 周，或 duration 如 5m）`]
		}
		const runs = computeNextRuns(spec, now.getTime(), PREVIEW_RUN_COUNT)
		const lines = runs.slice(0, PREVIEW_DISPLAY_COUNT).map((ts, i) => {
			const d = new Date(ts)
			return `${t.fg('dim', String(i + 1).padStart(PAD2_WIDTH))}. ${formatAbs(d)} · ${t.fg('accent', formatRelative(ts - now.getTime()))}`
		})
		const width = Math.max(1, innerWidth - PROMPT_INDENT_WIDTH)
		lines.push(truncateToWidth(t.fg('dim', `   循环执行 · 过期 ${this.draft.expires ?? '7d'}`), width))
		return lines
	}

	// ── 输入路由 ──

	handleInput(data: string): void {
		if (this.resolved) return

		// pendingCancel：Esc 二次确认取消；任意其他键回到表单（demo 探针形态：清除后该键继续正常路由）
		if (!matchesKey(data, 'escape')) this.pendingCancel = false

		// ① 编辑态：光标/删除/Esc 放弃/Enter 保存/字符输入
		if (this.editing()) {
			this.handleEditorInput(data)
			return
		}

		// ② Esc：非首 tab 回退；首 tab 两段取消
		if (matchesKey(data, 'escape')) {
			this.handleEscapeKey()
			return
		}

		// ③ 全局 tab 导航（←/→；切走时已答未确认自动提升）
		if (matchesKey(data, 'left') || matchesKey(data, 'right')) {
			if (this.tab === SUBMIT_TAB) {
				if (matchesKey(data, 'left')) this.gotoTab(SUBMIT_TAB - 1)
				return
			}
			this.autoConfirmIfAnswered()
			this.gotoTab(this.tab + (matchesKey(data, 'right') ? 1 : -1))
			return
		}

		// ④ tab 内 ↑/↓
		if (matchesKey(data, 'up') || matchesKey(data, 'down')) {
			this.handleVerticalNav(matchesKey(data, 'down') ? 1 : -1)
			return
		}

		// ⑤ Enter 确认
		if (matchesKey(data, 'enter')) {
			this.handleEnter()
			return
		}
	}

	/** Esc 键：非首 tab 回退上一 tab；首 tab 走两段取消（pendingCancel 二次确认）。 */
	private handleEscapeKey(): void {
		if (this.tab > 0) {
			this.gotoTab(this.tab - 1)
		} else if (this.pendingCancel) {
			this.cancel()
		} else {
			this.pendingCancel = true
			this.rerender()
		}
	}

	private handleVerticalNav(delta: number): void {
		switch (this.tab) {
			case TAB_KIND:
				this.kindCursor = Math.max(0, Math.min(1, this.kindCursor + delta))
				break
			case TAB_TIME:
				this.timeCursor = Math.max(0, Math.min(tab1ItemCount(this.kind) - 1, this.timeCursor + delta))
				break
			case TAB_MODEL:
				this.modelCursor = Math.max(0, Math.min(this.draft.models.length - 1, this.modelCursor + delta))
				break
			case TAB_PROMPT:
				return
			case SUBMIT_TAB:
				this.submitFocus = this.submitFocus === 0 ? 1 : 0
				break
		}
		this.rerender()
	}

	private handleEnter(): void {
		switch (this.tab) {
			case TAB_KIND:
				this.enterKindTab()
				return
			case TAB_TIME:
				this.enterTimeTab()
				return
			case TAB_MODEL: {
				this.confirmed[ANSWER_MODEL] = true
				this.leaveTabForward()
				return
			}
			case TAB_PROMPT: {
				// Enter 恒进编辑（预填当前值）；编辑态 Enter 保存并前进——对齐 ask-user freeform 语义
				this.promptEdit = newEditor(this.prompt, 'free')
				this.rerender()
				return
			}
			case SUBMIT_TAB:
				this.enterSubmitTab()
				return
		}
	}

	/** Kind tab Enter：按光标位定 kind，同步时间 tab 光标，确认并前进。 */
	private enterKindTab(): void {
		this.kind = this.kindCursor === 0 ? 'recurring' : 'once'
		if (this.kind === 'once') {
			this.syncOnceTimeCursor()
		} else {
			this.syncRecurringTimeCursor()
		}
		this.confirmed[0] = true
		this.leaveTabForward()
	}

	/** 切到一次性：保留 draft 还原/已选时刻；无值则预选首个预设（demo 行为）。 */
	private syncOnceTimeCursor(): void {
		if (this.onceDate === null) {
			this.onceDate = onceDateForPreset(0)
			this.oncePresetIndex = 0
		}
		this.timeCursor = this.oncePresetIndex ?? ONCE_PRESETS.length
	}

	/** 切到循环：匹配既有 cron 预设定位光标，未命中落自定义项。 */
	private syncRecurringTimeCursor(): void {
		const presetIndex = CRON_PRESETS.findIndex((p) => p.cron === this.cronText)
		this.timeCursor = presetIndex >= 0 ? presetIndex : CRON_PRESETS.length
	}

	/** Time tab Enter：自定义项进入编辑态；预设项直接落值，确认并前进。 */
	private enterTimeTab(): void {
		const customIndex = tab1ItemCount(this.kind) - 1
		if (this.timeCursor === customIndex) {
			this.beginTimeEdit()
			return
		}
		if (this.kind === 'recurring') {
			this.cronText = CRON_PRESETS[this.timeCursor]!.cron
		} else {
			this.onceDate = onceDateForPreset(this.timeCursor)
			this.oncePresetIndex = this.timeCursor
			this.onceEdit = null
		}
		this.confirmed[1] = true
		this.leaveTabForward()
	}

	/** 时间 tab 自定义项 Enter：按 kind 打开 cron 插入式 / datetime 掩码式编辑器。 */
	private beginTimeEdit(): void {
		if (this.kind === 'recurring') {
			this.cronEdit = newEditor(this.cronText, 'cron')
		} else {
			const current = this.currentOnceDate()
			this.onceEdit = newEditor(current ? formatLocal(current) : MASK_EMPTY, 'datetime')
		}
		this.rerender()
	}

	/** Submit tab Enter：焦点在确认且提交门通过 → submit；焦点在取消 → cancel。 */
	private enterSubmitTab(): void {
		if (this.submitFocus === 0) {
			if (this.canSubmit()) this.submit()
		} else {
			this.cancel()
		}
	}

	/** 编辑态输入（cron/prompt 插入式；datetime 掩码覆盖式）。Esc 放弃修改退出编辑态。 */
	private handleEditorInput(data: string): void {
		const e = this.cronEdit ?? this.onceEdit ?? this.promptEdit
		if (!e) return

		if (matchesKey(data, 'escape')) {
			this.cronEdit = null
			this.onceEdit = null
			this.promptEdit = null
			this.rerender()
			return
		}
		if (matchesKey(data, 'enter')) {
			this.saveEditor(e)
			return
		}
		if (this.applyEditorKeyOp(e, data)) return
		if (e.mode === 'datetime') {
			this.handleDatetimeEditorKey(e, data)
			return
		}
		this.handleInsertEditorKey(e, data)
	}

	/** 编辑态单键（退格/DEL/光标移动）：命中查找表则执行编辑器操作并重渲染。 */
	private applyEditorKeyOp(e: EditorState, data: string): boolean {
		for (const [key, op] of EDITOR_KEY_OPS) {
			if (matchesKey(data, key)) {
				op(e)
				this.rerender()
				return true
			}
		}
		return false
	}

	/** datetime 掩码态输入：只吃数字键（parseKey 命中转逐位覆盖），其余 no-op。 */
	private handleDatetimeEditorKey(e: EditorState, data: string): void {
		// 掩码态只吃数字：parseKey 命中的数字键转字符输入，其余 no-op
		const keyId = parseKey(data)
		if (keyId !== undefined && /^[0-9]$/.test(keyId)) {
			editorTypeChar(e, keyId)
			this.rerender()
		}
	}

	/** cron/free 编辑态插入输入：parseKey 命中键走单字符插入，未识别序列走码点插入（中文/emoji paste 路径）。 */
	private handleInsertEditorKey(e: EditorState, data: string): void {
		const keyId = parseKey(data)
		if (keyId !== undefined) {
			this.insertParsedKey(e, data, keyId)
			return
		}
		this.insertCodepoints(e, data)
	}

	/** parseKey 命中的键：space 特判转空格，单个可打印 ASCII 直接插入。 */
	private insertParsedKey(e: EditorState, data: string, keyId: string): void {
		if (matchesKey(data, 'space')) {
			editorTypeChar(e, ' ')
			this.rerender()
			return
		}
		if (keyId.length === 1 && keyId >= ' ' && keyId <= '~') {
			editorTypeChar(e, keyId)
			this.rerender()
		}
	}

	/** 未识别输入序列按码点逐个尝试插入（cron 白名单字符 / prompt 非控制字符），有变更才重渲染。 */
	private insertCodepoints(e: EditorState, data: string): void {
		let changed = false
		for (const c of Array.from(data)) {
			if (e.mode === 'cron' ? CRON_CHARS.test(c) : PROMPT_CHAR(c)) {
				editorTypeChar(e, c)
				changed = true
			}
		}
		if (changed) this.rerender()
	}

	/** 编辑态 Enter：有效 → 保存 + 确认 + 前进；无效 → 停留编辑态（预览区红字提示）。 */
	private saveEditor(e: EditorState): void {
		if (e.mode === 'cron') {
			const expr = e.text.trim()
			if (parseSchedule(expr) === undefined) {
				this.rerender()
				return
			}
			this.cronText = expr
			this.cronEdit = null
		} else if (e.mode === 'datetime') {
			const d = parseMaskedDate(e.text, new Date())
			if (d === null) {
				this.rerender()
				return
			}
			this.onceDate = d
			this.oncePresetIndex = null
			this.onceEdit = null
		} else {
			if (!e.text.trim()) {
				this.rerender()
				return
			}
			this.prompt = e.text
			this.promptEdit = null
		}
		if (e.mode === 'free') {
			this.confirmed[3] = true
		} else {
			this.confirmed[1] = true
		}
		this.leaveTabForward()
	}

	// ── 终态 ──

	private submit(): void {
		this.resolved = true
		const onceDate = this.kind === 'once' ? this.currentOnceDate() : null
		const result: ScheduleFormResult = {
			action: 'create',
			kind: this.kind,
			// once 折叠走 U1 单点 dateToOnceCron（D2：与 GUI 共用同一时间语义）
			schedule: this.kind === 'once' && onceDate ? dateToOnceCron(onceDate) : this.cronText.trim(),
			// models 空 → selectedModel() 为 undefined → 字段缺省 = 跟随会话当前模型
			model: this.selectedModel(),
			prompt: this.prompt.trim(),
			name: this.draft.name,
			expires: this.draft.expires,
		}
		this.done(result)
	}

	/** 取消。public 供 signal abort 监听复用 resolved 守卫（abort 晚于用户操作时防二次 done）。 */
	cancel(): void {
		if (this.resolved) return
		this.resolved = true
		this.done(null)
	}
}

// ── 模块级 helper ──

function onceDateForPreset(index: number, now: Date = new Date()): Date {
	return new Date(now.getTime() + ONCE_PRESETS[index]!.mins * MS_PER_MINUTE)
}

function tab1ItemCount(kind: ScheduleDraft['kind']): number {
	return kind === 'recurring' ? CRON_PRESETS.length + 1 : ONCE_PRESETS.length + 1
}
