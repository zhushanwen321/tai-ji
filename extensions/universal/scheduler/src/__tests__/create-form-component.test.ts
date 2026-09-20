// create-form-component.test.ts
// ScheduleCreateComponent 状态机单测——demo v2 探针形态转 vitest
// （实施计划 U3 验收：tab 推进 / 两段 Esc / 掩码覆盖 / cron·prompt 插入编辑 /
//   Submit 确认门 / once→cron 折叠回传）。
// 驱动方式与 ask-user component.test.ts 同构：handleInput 键序列 + render DOM 断言。
import { describe, expect, it, vi } from 'vitest'

import { dateToOnceCron, onceCronToDate, type ScheduleDraft } from '@zhushanwen/extension-protocol'

import {
	ScheduleCreateComponent,
	type ScheduleCreateResult,
	type ThemeLike,
} from '../create-form-component.js'

// ── fixtures（同构 ask-user __tests__/fixtures.ts）──

const stubTheme: ThemeLike = {
	fg: (_t: string, s: string) => s,
	bg: (_t: string, s: string) => s,
	bold: (s: string) => s,
	// 光标反显打标，便于掩码/编辑器断言
	inverse: (s: string) => `[${s}]`,
}

const mockTui = { requestRender: (): void => {} }

const ENTER = '\r'
const ESC = '\x1b'
const DOWN = '\x1b[B'
const RIGHT = '\x1b[C'
const LEFT = '\x1b[D'
const HOME = '\x1b[H'
const END = '\x1b[F'
const BACKSPACE = '\x7f'
const DELETE = '\x1b[3~'

// 固定远期时刻（掩码还原/折叠断言确定性；测试生命期内恒为未来）
const FAR_DATE = new Date(2099, 11, 31, 8, 30, 0, 0)
const FAR_ONCE_CRON = dateToOnceCron(FAR_DATE) // '30 8 31 12 *'
const FAR_ABS = '2099-12-31 08:30'

// onceCronToDate 语义 = 「下一次发生的该时刻」（U1）：cron 不含年份，还原值是
// 最近的未来 12-31 08:30（≈当年/次年），非 2099。期望值与组件共用同一默认 now 计算。
const pad2 = (n: number): string => String(n).padStart(2, '0')
const RESTORED = onceCronToDate(FAR_ONCE_CRON) as Date
const RESTORED_ABS = `${RESTORED.getFullYear()}-${pad2(RESTORED.getMonth() + 1)}-${pad2(RESTORED.getDate())} ${pad2(RESTORED.getHours())}:${pad2(RESTORED.getMinutes())}`
/** 掩码预填串在位置 k 覆盖数字 d 后的光标渲染形态（光标反显在 k+1 位） */
function maskAfterOverwrite(d: string, k = 0): string {
	return `自定义时间: ${d}[${RESTORED_ABS[k + 1]}]${RESTORED_ABS.slice(k + 2)}`
}

const baseDraft: ScheduleDraft = {
	kind: 'recurring',
	schedule: '0 9 * * *',
	prompt: '总结昨天的工作进展',
	models: ['zai/glm-5.3', 'zai/glm-5.3-flash', 'kimi/k3'],
	currentModel: 'zai/glm-5.3',
}

function make(
	draft: ScheduleDraft = baseDraft,
): { c: ScheduleCreateComponent; result: { val: ScheduleCreateResult | undefined } } {
	const result = { val: undefined as ScheduleCreateResult | undefined }
	const c = new ScheduleCreateComponent(draft, mockTui, stubTheme, (r) => {
		result.val = r
	})
	return { c, result }
}

/** 渲染行合并为单一字符串便于 includes 断言 */
function text(c: ScheduleCreateComponent, width = 100): string {
	return c.render(width).join('\n')
}

/** recurring 草稿从初始态推进到 Submit tab（默认值逐题 Enter） */
function fillRecurringToSubmit(c: ScheduleCreateComponent): void {
	c.handleInput(ENTER) // tab0 确认循环
	c.handleInput(ENTER) // tab1 确认预设（初值 cron）
	c.handleInput(ENTER) // tab2 确认模型
	c.handleInput(ENTER) // tab3 进 prompt 编辑
	c.handleInput(ENTER) // 保存 prompt 并前进
}

/** once 草稿经掩码逐位输入推进到 Submit tab（掩码预填草稿时刻，HOME 后整串重输） */
function fillOnceToSubmit(c: ScheduleCreateComponent): void {
	c.handleInput(ENTER) // tab0 确认一次性（光标已在自定义行）
	c.handleInput(ENTER) // 进掩码编辑器（预填 FAR_ABS，光标行尾）
	c.handleInput(HOME)
	for (const d of '209912310830') c.handleInput(d) // 逐位覆盖（分隔符自动跳过）
	c.handleInput(ENTER) // 保存时刻并前进
	c.handleInput(ENTER) // tab2 确认模型
	c.handleInput(ENTER) // tab3 进 prompt 编辑
	c.handleInput(ENTER) // 保存并前进
}

// ── 初值还原（D6/§3.4：once 初值由 onceCronToDate 还原）──

describe('ScheduleCreateComponent — draft 初值还原', () => {
	it('R-1: recurring 草稿的时间 tab 显示 cron 并显示匹配预设', () => {
		const { c } = make()
		c.handleInput(ENTER) // → 时间 tab
		const t = text(c)
		expect(t).toContain('0 9 * * *')
		expect(t).toContain('每天 09:00')
	})

	it('R-2: once 草稿经 onceCronToDate 还原为可显示时刻', () => {
		const { c } = make({ ...baseDraft, kind: 'once', schedule: FAR_ONCE_CRON })
		c.handleInput(ENTER) // → 时间 tab
		expect(text(c)).toContain(RESTORED_ABS)
	})

	it('R-3: 模型列表来自 draft.models 且按 currentModel 预选（不自取 settings）', () => {
		const { c } = make()
		c.handleInput(ENTER) // → 时间 tab
		c.handleInput(ENTER) // 确认预设 → 模型 tab
		const t = text(c)
		expect(t).toContain('执行模型')
		expect(t).toContain('zai/glm-5.3-flash')
		expect(t).toContain('kimi/k3')
		expect(t).toContain('当前会话')
		// 光标停在 currentModel（首行）：直接确认回传该模型
		c.handleInput(ENTER) // 确认模型 → 提示词
		c.handleInput(ENTER) // 进 prompt 编辑
		c.handleInput(ENTER) // 保存 → 提交 tab
		c.handleInput(ENTER) // 提交
		expect(c.render(100)).toBeDefined()
	})
})

// ── tab 推进（Enter 前进 / ←→ 边界 / autoConfirm）──

describe('ScheduleCreateComponent — tab 推进', () => {
	it('T-1: Enter 逐题前进：模式→时间→模型→提示词→提交', () => {
		const { c } = make()
		expect(text(c)).toContain('执行模式')
		c.handleInput(ENTER)
		expect(text(c)).toContain('执行时间')
		c.handleInput(ENTER)
		expect(text(c)).toContain('执行模型')
		c.handleInput(ENTER)
		expect(text(c)).toContain('提示词')
		c.handleInput(ENTER)
		c.handleInput(ENTER)
		expect(text(c)).toContain('确认创建')
	})

	it('T-2: ←/→ 边界：首 tab ← 不动，提交 tab → 不动、← 回提示词', () => {
		const { c } = make()
		c.handleInput(LEFT)
		expect(text(c)).toContain('执行模式')
		fillRecurringToSubmit(c)
		c.handleInput(RIGHT)
		expect(text(c)).toContain('确认创建')
		c.handleInput(LEFT)
		expect(text(c)).toContain('提示词')
	})

	it('T-3: ← 切走时已答未确认自动提升为已确认（autoConfirm）', () => {
		const { c } = make()
		c.handleInput(ENTER) // → 时间 tab（初值有效但未确认）
		c.handleInput(RIGHT) // 切走 → autoConfirm
		c.handleInput(LEFT) // 回时间 tab
		expect(text(c)).toContain('2 时间 ✓')
	})

	it('T-4: Esc 回退上一 tab', () => {
		const { c } = make()
		c.handleInput(ENTER)
		c.handleInput(ESC)
		expect(text(c)).toContain('执行模式')
	})
})

// ── 两段 Esc 取消（pendingCancel 状态机）──

describe('ScheduleCreateComponent — 两段 Esc 取消', () => {
	it('E-1: 首 tab 第一段 Esc 进入待确认（覆盖层提示、不取消）', () => {
		const { c, result } = make()
		c.handleInput(ESC)
		expect(result.val).toBeUndefined()
		expect(text(c)).toContain('确认取消创建')
	})

	it('E-2: 待确认态按非 Esc 键清除提示、留在表单', () => {
		const { c, result } = make()
		c.handleInput(ESC)
		c.handleInput('x')
		expect(result.val).toBeUndefined()
		expect(text(c)).not.toContain('确认取消创建')
		expect(text(c)).toContain('执行模式')
	})

	it('E-3: 第二段 Esc 取消 → done(null)', () => {
		const { c, result } = make()
		c.handleInput(ESC)
		c.handleInput(ESC)
		expect(result.val).toBeNull()
	})

	it('E-4: 非首 tab Esc 只回退、不进入待确认', () => {
		const { c, result } = make()
		c.handleInput(ENTER)
		c.handleInput(ESC)
		expect(text(c)).not.toContain('再按一次 Esc 确认取消')
		expect(result.val).toBeUndefined()
	})
})

// ── datetime 掩码编辑（逐位覆盖 / 分隔符跳过 / 退格无效）──

describe('ScheduleCreateComponent — datetime 掩码编辑', () => {
	function openMaskEditor(c: ScheduleCreateComponent): void {
		c.handleInput(ENTER) // tab0 → once（光标已在自定义行）
		c.handleInput(ENTER) // 进掩码编辑器（预填草稿时刻，光标行尾）
		c.handleInput(HOME) // 光标到行首，从年份逐位覆盖
	}

	it('M-1: 数字逐位覆盖 + 分隔符自动跳过', () => {
		const { c } = make({ ...baseDraft, kind: 'once', schedule: FAR_ONCE_CRON })
		openMaskEditor(c)
		c.handleInput('2')
		// 覆盖首位后光标到位置 1（预填串原位反显）
		expect(text(c)).toContain(maskAfterOverwrite('2'))
		c.handleInput('0')
		c.handleInput('9')
		c.handleInput('9')
		// 年份已被逐位改为 2099，光标落在分隔符位 4：反显 '-'
		expect(text(c)).toContain('2099[-]12-31 08:30')
		c.handleInput('9')
		// 输入先跳过 '-' 再覆盖月位 → '12' 变 '92'，光标到日段
		expect(text(c)).toContain('2099-9[2]-31 08:30')
	})

	it('M-2: 掩码态退格/DEL 无效、非数字不入选', () => {
		const { c } = make({ ...baseDraft, kind: 'once', schedule: FAR_ONCE_CRON })
		openMaskEditor(c)
		c.handleInput('2')
		c.handleInput(BACKSPACE)
		c.handleInput(DELETE)
		c.handleInput('a')
		expect(text(c)).toContain(maskAfterOverwrite('2'))
	})

	it('M-3: 完整掩码输入保存为时刻并确认前进，提交折叠回一次性 cron（D2 单点）', () => {
		const { c, result } = make({ ...baseDraft, kind: 'once', schedule: FAR_ONCE_CRON })
		fillOnceToSubmit(c)
		expect(text(c)).toContain('确认创建')
		expect(text(c)).toContain(FAR_ABS)
		c.handleInput(ENTER)
		expect(result.val).not.toBeNull()
		expect(result.val!.kind).toBe('once')
		expect(result.val!.schedule).toBe(FAR_ONCE_CRON)
	})

	it('M-4: 覆盖为过去时刻 Enter 不保存、停留编辑态', () => {
		const { c, result } = make({ ...baseDraft, kind: 'once', schedule: FAR_ONCE_CRON })
		openMaskEditor(c)
		c.handleInput('0') // 年份首位覆盖为 0 → 0026 年（过去）
		c.handleInput(ENTER)
		expect(result.val).toBeUndefined()
		expect(text(c)).toContain(maskAfterOverwrite('0'))
	})
})

// ── cron / prompt 插入式编辑（码点级）──

describe('ScheduleCreateComponent — cron/prompt 插入编辑', () => {
	function openCronEditor(c: ScheduleCreateComponent): void {
		c.handleInput(ENTER) // → 时间 tab
		for (let i = 0; i < 5; i++) c.handleInput(DOWN) // 末行：自定义 cron
		c.handleInput(ENTER) // 进编辑器（预填草稿 cron）
	}

	it('C-1: cron 白名单外字符被拒、白名单内插入', () => {
		const { c } = make()
		openCronEditor(c)
		c.handleInput('5')
		// 预填 '0 9 * * *' 尾部插入 '5'，光标行尾反显空格
		expect(text(c)).toContain('自定义: 0 9 * * *5[')
		c.handleInput('w') // 非白名单（w 不在 0-9smhdSMHD 与 cron 语法字符）
		expect(text(c)).toContain('自定义: 0 9 * * *5[')
		expect(text(c)).not.toContain('*5w')
		c.handleInput('*')
		expect(text(c)).toContain('自定义: 0 9 * * *5*[')
	})

	it('C-2: 有效 cron Enter 保存并前进；无效 cron 停留编辑态', () => {
		const { c, result } = make()
		openCronEditor(c)
		for (let i = 0; i < 9; i++) c.handleInput(BACKSPACE) // 清空 '0 9 * * *'
		c.handleInput(ENTER) // 空表达式无效 → 停留
		expect(result.val).toBeUndefined()
		expect(text(c)).toContain('自定义: [')
		for (const ch of '5 9 * * *') c.handleInput(ch)
		c.handleInput(ENTER) // 有效 → 前进
		expect(text(c)).toContain('执行模型')
		c.handleInput(ENTER) // 模型
		c.handleInput(ENTER) // prompt 编辑
		c.handleInput(ENTER) // 保存
		expect(text(c)).toContain('确认创建')
		expect(text(c)).toContain('5 9 * * *')
		expect(result.val).toBeUndefined() // 尚未提交
		c.handleInput(ENTER)
		expect(result.val!.schedule).toBe('5 9 * * *')
	})

	it('C-3: prompt 编辑码点级：emoji 整码点退格、跨 pair 光标移动、单码点删除', () => {
		const { c, result } = make({ ...baseDraft, prompt: '总结' })
		c.handleInput(ENTER)
		c.handleInput(ENTER)
		c.handleInput(ENTER)
		c.handleInput(ENTER) // tab3 进 prompt 编辑（预填 '总结'，光标行尾）
		c.handleInput('😀') // surrogate pair 走 paste 路径整码点插入
		expect(text(c)).toContain('总结😀')
		c.handleInput(BACKSPACE) // 光标在 emoji 后退格 → 整对删除
		expect(text(c)).not.toContain('😀')
		c.handleInput('😀')
		c.handleInput(LEFT) // ← 跨过 emoji 整码点（cursor 停在其前）
		c.handleInput(BACKSPACE) // 删 '结'（单码点）
		expect(text(c)).toContain('总')
		expect(text(c)).toContain('😀')
		expect(text(c)).not.toContain('总结')
		c.handleInput(ENTER) // 保存并前进
		expect(text(c)).toContain('确认创建')
		c.handleInput(ENTER)
		expect(result.val!.prompt).toBe('总😀')
	})
})

// ── Submit 确认门 + 回传契约 ──

describe('ScheduleCreateComponent — Submit 确认门与回传', () => {
	it('S-1: 四题全确认后 Enter 提交 FormResult（recurring 原样回传 cron）', () => {
		const { c, result } = make()
		fillRecurringToSubmit(c)
		expect(text(c)).toContain('确认创建')
		expect(text(c)).toContain('✓ 模式')
		expect(text(c)).toContain('✓ 时间')
		expect(text(c)).toContain('✓ 模型')
		expect(text(c)).toContain('✓ 提示词')
		c.handleInput(ENTER)
		expect(result.val).toEqual({
			action: 'create',
			kind: 'recurring',
			schedule: '0 9 * * *',
			model: 'zai/glm-5.3',
			prompt: '总结昨天的工作进展',
			name: undefined,
			expires: undefined,
		})
	})

	it('S-2: 有未完成项（prompt 空）时 Enter 不提交', () => {
		const { c, result } = make({ ...baseDraft, prompt: '   ' })
		c.handleInput(ENTER)
		c.handleInput(ENTER)
		c.handleInput(ENTER) // → 提示词 tab
		c.handleInput(ENTER) // 进编辑
		c.handleInput(ESC) // 放弃（保持空、未确认）
		c.handleInput(RIGHT) // → 提交 tab
		expect(text(c)).toContain('仍有未完成的配置项')
		c.handleInput(ENTER)
		expect(result.val).toBeUndefined()
	})

	it('S-3: 提交 tab ↓ 切到取消 → Enter → done(null)', () => {
		const { c, result } = make()
		fillRecurringToSubmit(c)
		c.handleInput(DOWN)
		c.handleInput(ENTER)
		expect(result.val).toBeNull()
	})

	it('S-4: once 全流程回传折叠 cron + name/expires 透传', () => {
		const { c, result } = make({
			...baseDraft,
			kind: 'once',
			schedule: FAR_ONCE_CRON,
			name: ' nightly ',
			expires: '3d',
		})
		fillOnceToSubmit(c)
		c.handleInput(ENTER)
		expect(result.val).toEqual({
			action: 'create',
			kind: 'once',
			schedule: FAR_ONCE_CRON,
			model: 'zai/glm-5.3',
			prompt: '总结昨天的工作进展',
			name: ' nightly ',
			expires: '3d',
		})
	})

	it('S-5: 终态后继续按键 no-op（resolved 守卫）', () => {
		const { c, result } = make()
		fillRecurringToSubmit(c)
		c.handleInput(ENTER)
		const doneValue = result.val
		c.handleInput(ESC)
		c.handleInput(ENTER)
		expect(result.val).toBe(doneValue)
	})

	it('S-6: 用户改选模型后回传新选择', () => {
		const { c, result } = make()
		c.handleInput(ENTER)
		c.handleInput(ENTER)
		c.handleInput(DOWN) // 光标到 glm-5.3-flash
		c.handleInput(ENTER)
		c.handleInput(ENTER) // prompt 编辑
		c.handleInput(ENTER) // 保存
		c.handleInput(ENTER) // 提交
		expect(result.val!.model).toBe('zai/glm-5.3-flash')
	})

	it('S-7: models 为空时模型题恒有效，回传缺省 model', () => {
		const { c, result } = make({ ...baseDraft, models: [] })
		fillRecurringToSubmit(c)
		c.handleInput(ENTER)
		expect(result.val).not.toBeNull()
		expect(result.val!.model).toBeUndefined()
	})

	// 非编辑态过期拦截：掩码编辑态 parseMaskedDate 已拒过去时刻（M-4），本用例锁
	// 「时刻合法保存后随时间流逝过期」的缝隙——不拦则折叠出的无年份 once-cron 会被
	// croner 顺延到明年同刻静默创建（登记残留风险的现网表现）
	it('S-8: once 时刻保存后停留至过期 → 时间行/预览警示已过且 Enter 不提交', () => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date(2026, 8, 19, 8, 0, 0, 0))
		try {
			const { c, result } = make({ ...baseDraft, kind: 'once', schedule: FAR_ONCE_CRON })
			c.handleInput(ENTER) // tab0 确认一次性
			c.handleInput(ENTER) // 进掩码编辑器（预填还原值）
			c.handleInput(HOME)
			for (const d of '202609190810') c.handleInput(d) // 输入 08:10（> 08:00 合法保存）
			c.handleInput(ENTER) // 保存时刻并前进
			c.handleInput(ENTER) // tab2 确认模型
			c.handleInput(ENTER) // tab3 进 prompt 编辑
			c.handleInput(ENTER) // 保存并前进 → Submit tab

			// 未过期：时间行正常（✓ 一次性）
			expect(text(c)).toContain('一次性）')

			// 时间流逝到 08:11（时刻已过 1 分钟）：timeValid 非编辑态判定生效
			// 时间流逝到 08:11（时刻已过 1 分钟）：timeValid 非编辑态判定生效。
			// render 有行缓存（真实 TUI 由交互驱动重绘）——invalidate 模拟下次重绘
			vi.setSystemTime(new Date(2026, 8, 19, 8, 11, 0, 0))
			c.invalidate()
			const out = text(c)
			expect(out).toContain('时刻已过') // Submit 时间行 ✗ 说明
			expect(out).toContain('已过，请重选未来时刻') // 预览警示
			c.handleInput(ENTER) // 确认按钮 Enter → canSubmit false 拦截
			expect(result.val).toBeUndefined()
		} finally {
			vi.useRealTimers()
		}
	})
})

// ── abort 通道（cancel() public，U2 接线用）──

describe('ScheduleCreateComponent — cancel/abort', () => {
	it('A-1: cancel() 直接回传 null；resolved 后 cancel() no-op', () => {
		const { c, result } = make()
		fillRecurringToSubmit(c)
		c.cancel()
		expect(result.val).toBeNull()
		c.cancel()
		expect(result.val).toBeNull()
	})
})
