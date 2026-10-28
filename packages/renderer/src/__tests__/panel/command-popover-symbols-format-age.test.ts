/**
 * panel 浮层小组件合并测试（单文件多源合并：8 个源文件同目录、mock 相容、共同装载
 * lucide-vue / reka-ui-slim / shared / extension-protocol）。
 *
 * 为什么单文件：vitest 按测试文件隔离模块图——单文件让全部用例共享一份组件树装载
 * 与环境初始化；拆文件会让每个文件各付一次装载（每份秒级 CPU，8 文件合计约 6.75s
 * 装载 CPU，合并后只装一份）。
 *
 * 来源文件（describe/it 块原样搬运，测试名零改动）：
 *  - command-popover-symbols-format-age.test.ts（formatAge 分档 + 候选构建 + open-fetch）
 *  - command-popover-registry-merge.test.ts（CommandPopover registry 合并源 TC2）
 *  - thinking-level-popover.test.ts（ThinkingLevelPopover 动态档位）
 *  - browser-overlay-mount.test.ts（BrowserOverlay 挂载 / 关闭通道）
 *  - turn-skill-badge.test.ts（Turn skill badge 渲染）
 *  - turn-file-badge.test.ts（Turn file badge 渲染）
 *  - add-menu-popover.test.ts（AddMenuPopover TC4）
 *  - model-picker-panel.test.ts（ModelPickerPanel hoverSelect W3a）
 *
 * hook 处理：各源顶层 beforeEach 均为幂等重置（pinia 重建 + commandStore 重置 + body
 * 清理），取并集为文件级公共 beforeEach；非通用项（overlay 态重置 + windowId history、
 * 节私有 mock 清理）下沉到对应来源节的 describe 内，不泄漏到其他节。
 * 异构同名 helper（turn-skill-badge / turn-file-badge 的 makeTurn / mountTurn）收进
 * 各自 describe 函数作用域，it 内容零改动。
 * mock 并集：@taiji/core/transport/api/domains/composer（部分替换）、@/api（部分替换
 * getCommands，保留其余真实导出——合并后其他节组件可能消费 @/api 其他成员，整模块
 * 替换会断链）、@/lib/ipc（browser 系列捕获），三者互不相交。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/command-popover-symbols-format-age.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { Turn } from '@taiji/ui'
import type {
  FileNode,
  SessionSummary,
  SubagentRecord,
  ServerMessage,
  SkillInfo,
  Message,
  OverlayContentKind,
} from '@taiji/shared'
import * as events from '@taiji/core/transport/api'
import { ActivationManager, CommandRegistry, InternalEventBus, type SlashCommandLike } from '@taiji/core'
import { openBrowser, openCanvasOverlay, openOverlay, closeOverlay, _resetOverlayForTest } from '@taiji/core/domain/overlay'
import { __testing } from '@/composables/features/command/useCommandStore'
import { closeTopContainer } from '@/composables/features/app/key-orchestrator/stack-order'
import type { MessageTurn } from '@/composables/logic/messageTurns'
import { mockChatProvide } from '@/__tests__/helpers/chat-view-deps'

// open-fetch 直接 import composer domain（landing cwd 通道）——mock 之隔离真实 WS 通路。
// u5 re-anchor（e79ba3647/8ca21226f）后实现 import 的是 core 子路径，mock 必须对齐同一
// specifier（旧 '@/api/domains/composer' bridge 已删，mock 指旧路径 = mock 失效）；
// importActual 保留其余真实导出（getFileCandidates/getMentionCandidates）防其他消费方断链
const getFileCandidatesByCwdMock = vi.hoisted(() => vi.fn())
vi.mock('@taiji/core/transport/api/domains/composer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/core/transport/api/domains/composer')>()
  return {
    ...actual,
    getFileCandidatesByCwd: (...args: unknown[]) => getFileCandidatesByCwdMock(...args),
  }
})

// useCommandSync 挂载即拉 session.getCommands：mock 掉避免依赖真实 api 通道
// （全量套跑时 mock 模式标志被其他文件污染，真实 '@/api' 会解析出 MOCK_COMMANDS
// 并覆盖本测试 pushCommands 写入的受控 store 状态——单跑无症状，全量必炸）。
// 合并后改为部分替换：保留 @/api 其余真实导出（其他节的组件可能消费），仅 getCommands
// 返回空，防护语义不变。
vi.mock('@/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api')>()
  return {
    ...actual,
    session: {
      ...actual.session,
      getCommands: vi.fn().mockResolvedValue({ sessionId: '', commands: [] }),
    },
  }
})

// ── mock lib/ipc：browser 系列捕获（web 环境 electronAPI 缺席的等价形态）──
const mockBrowserCreate = vi.fn().mockResolvedValue(undefined)
const mockBrowserNavigate = vi.fn().mockResolvedValue(undefined)
const mockBrowserHide = vi.fn().mockResolvedValue(undefined)
const mockBrowserShow = vi.fn().mockResolvedValue(undefined)
const mockBrowserSetRect = vi.fn().mockResolvedValue(undefined)
const mockBrowserSetOverlayState = vi.fn().mockResolvedValue(undefined)
const mockBrowserSetShields = vi.fn().mockResolvedValue(undefined)
const mockOnBrowserState = vi.fn().mockReturnValue(() => {})

vi.mock('@/lib/ipc', () => ({
  browserCreate: (sessionId: string, windowId: string) => mockBrowserCreate(sessionId, windowId),
  browserNavigate: (sessionId: string, url: string) => mockBrowserNavigate(sessionId, url),
  browserHide: (sessionId: string) => mockBrowserHide(sessionId),
  browserShow: (sessionId: string) => mockBrowserShow(sessionId),
  browserBack: vi.fn().mockResolvedValue(undefined),
  browserForward: vi.fn().mockResolvedValue(undefined),
  browserSetRect: (
    sessionId: string,
    rect: { x: number; y: number; width: number; height: number },
  ) => mockBrowserSetRect(sessionId, rect),
  browserSetZoom: vi.fn().mockResolvedValue(undefined),
  browserGetZoom: vi.fn().mockResolvedValue(1.0),
  browserSetOverlayState: (state: {
    open: boolean
    content: OverlayContentKind | null
    sessionId: string | null
  }) => mockBrowserSetOverlayState(state),
  browserSetShields: (payload: {
    faces: Array<{ id: string; fullscreen: boolean; rect?: { x: number; y: number; width: number; height: number } }>
  }) => mockBrowserSetShields(payload),
  onBrowserState: (cb: unknown) => mockOnBrowserState(cb),
  openExternal: vi.fn().mockResolvedValue(undefined),
}))

import CommandPopover from '@/components/panel/CommandPopover.vue'
import { formatAge, skillDisplayName, buildSlashCandidates, buildSessionCandidates, buildSubagentCandidates } from '@/components/panel/command-popover-symbols'
import { SLASH_COMMAND_SOURCE_KEY } from '@/components/panel/command-popover-source'
import ThinkingLevelPopover from '@/components/panel/ThinkingLevelPopover.vue'
import BrowserOverlay from '@/components/panel/BrowserOverlay.vue'
import AddMenuPopover from '@/components/panel/AddMenuPopover.vue'
import ModelPickerPanel from '@/components/panel/ModelPickerPanel.vue'
import type { ModelPickerGroup } from '@/components/panel/ModelPickerPanel.vue'

// ── 文件级公共 hook（各源顶层幂等重置取并集）──
beforeEach(() => {
  setActivePinia(createPinia())
  __testing.__resetCommandStoreForTesting()
  document.body.innerHTML = ''
})

// ══════════ 来源：command-popover-symbols-format-age.test.ts ══════════

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

describe('formatAge 相对时间分档', () => {
  it('<1m → now；未来时间钳为 now（diff 负值归 0）', () => {
    const now = 1_000_000_000_000
    expect(formatAge(now - 30_000, now)).toBe('now')
    expect(formatAge(now + 5 * MIN, now)).toBe('now')
  })

  it('<1h → Nm', () => {
    const now = 1_000_000_000_000
    expect(formatAge(now - 5 * MIN, now)).toBe('5m')
    expect(formatAge(now - 59 * MIN, now)).toBe('59m')
  })

  it('<1d → Nh', () => {
    const now = 1_000_000_000_000
    expect(formatAge(now - 3 * HOUR, now)).toBe('3h')
    expect(formatAge(now - 23 * HOUR, now)).toBe('23h')
  })

  it('>=1d → Nd 封顶（多天仍用天数）', () => {
    const now = 1_000_000_000_000
    expect(formatAge(now - DAY, now)).toBe('1d')
    expect(formatAge(now - 45 * DAY, now)).toBe('45d')
  })
})

// ─────────────── buildSessionCandidates 删参（D1：landing/panel 统一「有数据就列」） ───────────────

const NOW = 1_000_000_000_000

const SESSIONS: SessionSummary[] = [
  { id: 'sess-alpha', label: 'alpha 设计讨论', cwd: '/p/a', status: 'idle', lastActiveAt: NOW - 60_000, surface: 'sidebar' },
  { id: 'sess-beta', label: 'beta review', cwd: '/p/b', status: 'idle', lastActiveAt: NOW - 3 * 3_600_000, surface: 'sidebar' },
]

describe('buildSessionCandidates 删 hasSessionId 参（D1/D7）', () => {
  it('空 sessions → []（无数据不弹的唯一门，与有无 session 上下文无关）', () => {
    expect(buildSessionCandidates([], '', NOW)).toEqual([])
    expect(buildSessionCandidates([], 'alpha', NOW)).toEqual([])
  })

  it('有数据 → 直接列全量（无 hasSessionId 门：landing/panel 不再有区别；D7 不做 landing 过滤）', () => {
    const items = buildSessionCandidates(SESSIONS, '', NOW)
    expect(items).toHaveLength(2)
    // 降序 + 两行副行维持（跨 cwd 全量口径不变）
    expect(items[0].name).toBe('alpha 设计讨论')
    expect(items[0].subText).toContain('/p/a')
    expect(items[0].subText).toContain('1m')
    expect(items[1].subText).toContain('3h')
  })

  it('surface 非 sidebar 排除 + label/id 子串过滤口径维持（W5 切换：删 hidden 读点、非删过滤）', () => {
    const withBtwLine: SessionSummary[] = [...SESSIONS, { ...SESSIONS[0], id: 'sess-h', label: 'btw line', surface: 'btw' }]
    expect(buildSessionCandidates(withBtwLine, '', NOW)).toHaveLength(2)
    expect(buildSessionCandidates(SESSIONS, 'beta', NOW)).toHaveLength(1)
    expect(buildSessionCandidates(SESSIONS, 'sess-beta', NOW)).toHaveLength(1) // id 子串命中
    expect(buildSessionCandidates(SESSIONS, 'zzz', NOW)).toEqual([])
  })
})

// ─────────── buildSubagentCandidates hasSessionId 保留（G3：@ landing 空语义，A5 护栏） ───────────

const RECORDS: SubagentRecord[] = [
  { subagentId: 'bg-1', sessionFile: null, agent: 'worker', slug: 'build-api', task: 't', status: 'running' },
]

describe('buildSubagentCandidates hasSessionId 保留（landing 空语义）', () => {
  it('hasSessionId=false（landing）→ []（含「新建」项也不返回）', () => {
    expect(buildSubagentCandidates(RECORDS, '', false, '新建 subagent')).toEqual([])
    expect(buildSubagentCandidates([], '', false, '新建 subagent')).toEqual([])
  })

  it('hasSessionId=true（panel）→ records + 固定「新建」尾项（语义不变）', () => {
    const items = buildSubagentCandidates(RECORDS, '', true, '新建 subagent')
    expect(items).toHaveLength(2)
    expect(items[0].slug).toBe('build-api')
    expect(items[1].id).toBe('__new_subagent__')
  })
})

// ─────────── skill 显示名剥前缀（RC-A-5/RC-B-11：pi 裸 `skill:` 形态） ───────────

describe('skillDisplayName 剥前缀（三形态同口径）', () => {
  it('pi 裸名 skill:x（无前导 /）、/skill:x、裸 x 三形态 → 同口径 x', () => {
    // pi getCommands() 对 skill 产 { name: `skill:${skill.name}`, source: 'skill' }（无前导 /），
    // 修复前 skillDisplayName 只剥 `/skill:` 与 `/` ⇒ 裸 `skill:` 原样返回（浮层显示带前缀）。
    expect(skillDisplayName('skill:code-review-graph')).toBe('code-review-graph')
    expect(skillDisplayName('/skill:code-review-graph')).toBe('code-review-graph')
    expect(skillDisplayName('code-review-graph')).toBe('code-review-graph')
  })

  it('非 skill 的 / 前缀命令仍剥 /（既有语义不回归）', () => {
    expect(skillDisplayName('/compact')).toBe('compact')
  })
})

describe('buildSlashCandidates skill 项显示名（RC-A-5）', () => {
  const iconKey = () => 'star'

  it('pi 源（name="skill:x", kind="skill"）→ displayName 剥前缀；name 保留完整路由名供 onSelect', () => {
    const [item] = buildSlashCandidates(
      [{ id: 'skill-code-review-graph', name: 'skill:code-review-graph', kind: 'skill' }],
      '',
      iconKey,
    )
    expect(item.displayName).toBe('code-review-graph')
    expect(item.name).toBe('/skill:code-review-graph') // 归一化后的路由名（补 / 前缀）
    expect(item.isSkill).toBe(true)
  })

  it('对照：/skill:x（landing 声明源形态）与裸名 x 形态 displayName 同口径', () => {
    const [slashForm] = buildSlashCandidates(
      [{ id: 's1', name: '/skill:code-review-graph', kind: 'skill' }],
      '',
      iconKey,
    )
    const [bareForm] = buildSlashCandidates([{ id: 's2', name: 'code-review-graph', kind: 'skill' }], '', iconKey)
    expect(slashForm.displayName).toBe('code-review-graph')
    expect(bareForm.displayName).toBe('code-review-graph')
  })

  it('非 skill 命令显示名仍保留 / 前缀（命令调用语义，不被本修复波及）', () => {
    const [item] = buildSlashCandidates([{ id: 'c1', name: 'commit', kind: 'extension' }], '', iconKey)
    expect(item.displayName).toBe('/commit')
    expect(item.isSkill).toBe(false)
  })

  // N-4（最终复审 info）：displayName 曾只看 c.kind === 'skill'，与 isSkill 判据
  // （kind === 'skill' || name 带 /skill:）不同源 ⇒ kind 非 skill 但名字带 /skill: 的项被
  // 判为 skill（裸名比对 selected + onSelect 走 insertSkillChip），显示却仍带 /skill: 前缀。
  // 当前产线不可达（pi 的 source 恒 'skill'、landing 侧显式写 kind:'skill'），本用例锁住
  // 「一处判定、三处消费」的不变式防漂移。
  it('kind 非 skill 但名字带 /skill:（潜在形态）→ isSkill 与 displayName 同源：显示裸名', () => {
    const [item] = buildSlashCandidates([{ id: 'p1', name: '/skill:hidden', kind: 'extension' }], '', iconKey)
    expect(item.isSkill).toBe(true)
    // 修复前：displayName 走 name（= '/skill:hidden'），与本处 isSkill=true 自相矛盾
    expect(item.displayName).toBe('hidden')
    // 路由名保留完整前缀供 onSelect → pi 路由
    expect(item.name).toBe('/skill:hidden')
  })

  it('kind 非 skill 但名字带 /skill: → selected 比对仍走裸名（与 displayName 同判据）', () => {
    const [item] = buildSlashCandidates(
      [{ id: 'p2', name: '/skill:hidden', kind: 'extension' }],
      '',
      iconKey,
      ['hidden'],
    )
    expect(item.selected).toBe(true)
  })
})

// ─────────────── open-fetch file 路（D3：landing cwd 通道边沿拉，mount 验证） ───────────────

/** body 内浮层候选行（PopoverContent teleport 到 body，v-for 渲染为 .pop-item div） */
function bodyRows(): HTMLElement[] {
  return Array.from(document.body.querySelectorAll('.pop-item'))
}

describe('open-fetch file 路 landing cwd 通道（D2/D3）', () => {
  let wrapper: ReturnType<typeof mount> | null = null

  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    document.body.innerHTML = ''
  })

  it('无 sid 有 cwd：open false→true 边沿按 cwd 拉取，候选渲染进浮层（G1）', async () => {
    const nodes: FileNode[] = [{ path: 'src/index.ts', name: 'index.ts', type: 'file' }]
    getFileCandidatesByCwdMock.mockResolvedValueOnce({ files: nodes, truncated: false })
    wrapper = mount(CommandPopover, {
      attachTo: document.body,
      props: { open: false, type: 'file', cwd: '/repo' },
    })
    await nextTick()
    expect(getFileCandidatesByCwdMock).not.toHaveBeenCalled() // 关闭态/挂载不预拉
    await wrapper.setProps({ open: true })
    await flushPromises()
    expect(getFileCandidatesByCwdMock).toHaveBeenCalledTimes(1)
    expect(getFileCandidatesByCwdMock).toHaveBeenCalledWith('/repo')
    // 拉取结果经 onCwdFileCandidates → items → 浮层 DOM（用户可见）
    expect(bodyRows().some((r) => r.textContent?.includes('index.ts'))).toBe(true)
  })

  it('无 sid 无 cwd：不拉（S4b 无数据源）；但浮层仍渲染通用无匹配反馈行（缺陷 B：open 即渲染）', async () => {
    wrapper = mount(CommandPopover, {
      attachTo: document.body,
      props: { open: false, type: 'file' },
    })
    await nextTick()
    await wrapper.setProps({ open: true })
    await flushPromises()
    await nextTick()
    // 无 cwd ⇒ 无候选源，open-fetch 不拉（不产生 unhandled rejection）
    expect(getFileCandidatesByCwdMock).not.toHaveBeenCalled()
    expect(bodyRows()).toHaveLength(0)
    // [HISTORICAL] 旧行为：该 open 态不渲染任何内容（v-if = items 非空 || fileFallbackVisible）
    // ⇒ 「open 但不可见」。反馈行补齐后 open 即渲染，消费条件得以回到「open 即消费」。
    const row = document.body.querySelector('[data-testid="cmd-popover-empty"]')
    expect(row).not.toBeNull()
    expect(row!.textContent).toContain('无匹配项')
  })

  it('有 sid（panel）：open-fetch 不拉（file 候选专属 store 缓存路，防双路重复 RPC）', async () => {
    wrapper = mount(CommandPopover, {
      attachTo: document.body,
      props: { open: false, type: 'file', sessionId: 's1', cwd: '/repo' },
    })
    await nextTick()
    await wrapper.setProps({ open: true })
    await flushPromises()
    expect(getFileCandidatesByCwdMock).not.toHaveBeenCalled()
  })

  it('1s 节流：窗口内关→开不重新拉取（模式对齐 slash/subagent 路）', async () => {
    const nodes: FileNode[] = [{ path: 'a.ts', name: 'a.ts', type: 'file' }]
    getFileCandidatesByCwdMock.mockResolvedValue(nodes)
    wrapper = mount(CommandPopover, {
      attachTo: document.body,
      props: { open: false, type: 'file', cwd: '/repo' },
    })
    await nextTick()
    await wrapper.setProps({ open: true })
    await flushPromises()
    expect(getFileCandidatesByCwdMock).toHaveBeenCalledTimes(1)
    // 关→开（1s 窗口内）：节流命中，不重新拉取
    await wrapper.setProps({ open: false })
    await wrapper.setProps({ open: true })
    await flushPromises()
    expect(getFileCandidatesByCwdMock).toHaveBeenCalledTimes(1)
  })

  it('拉取失败（session cwd 已删，runtime not_found）→ D7 错误态浮层「加载失败，点击重试」、不 throw', async () => {
    getFileCandidatesByCwdMock.mockRejectedValueOnce(Object.assign(new Error('session cwd not found'), { code: 'not_found' }))
    wrapper = mount(CommandPopover, {
      attachTo: document.body,
      props: { open: false, type: 'file', cwd: '/deleted-dir' },
    })
    await nextTick()
    await wrapper.setProps({ open: true })
    await flushPromises()
    expect(getFileCandidatesByCwdMock).toHaveBeenCalledTimes(1)
    // D7 失败路径（与 #10 合流裁决）：错误态浮层渲染（cmd-file-error）而非静默空候选；
    // unhandled rejection 不冒泡为失败
    const errorRow = document.body.querySelector('[data-testid="cmd-file-error"]')
    expect(errorRow).not.toBeNull()
    // 行可点重试（force 绕节流重发起拉取），重试成功后错误态消失、候选恢复
    getFileCandidatesByCwdMock.mockResolvedValueOnce({ files: [{ path: 'a.ts', name: 'a.ts', type: 'file' } as FileNode], truncated: false })
    ;(errorRow as HTMLElement).click()
    await flushPromises()
    expect(getFileCandidatesByCwdMock).toHaveBeenCalledTimes(2)
    expect(document.body.querySelector('[data-testid="cmd-file-error"]')).toBeNull()
    expect(bodyRows().some((r) => r.textContent?.includes('a.ts'))).toBe(true)
  })
})

// ══════════ 来源：command-popover-registry-merge.test.ts ══════════

/** 真 CommandRegistry（headless，零副作用）→ shell 注入同款 source 适配。 */
function createSlashSource(): { resolveSlashCommands: (pi: SlashCommandLike[]) => ReturnType<CommandRegistry['resolveSlashCommands']> } {
  const bus = new InternalEventBus()
  const activationManager = new ActivationManager({ trigger: { ensureActivated: async () => {} } })
  const registry = new CommandRegistry({ bus, activationManager, executor: { execute: async () => {} } })
  // builtin tasks 声明（builtin-contributions.ts 同款：goal/todo，name 无前导 /）
  registry.registerFromContribution({
    pluginId: 'tasks', contributionId: 'goal', type: 'slashCommand', placement: 'slash', available: true,
    slashCommand: { name: 'goal', description: '创建目标' },
  })
  registry.registerFromContribution({
    pluginId: 'tasks', contributionId: 'todo', type: 'slashCommand', placement: 'slash', available: true,
    slashCommand: { name: 'todo', description: '创建任务' },
  })
  return { resolveSlashCommands: (pi) => registry.resolveSlashCommands(pi) }
}

/** reka-ui PopoverContent teleport 到 body：在 body 内找命令项行（v-for 渲染为 .pop-item div）。 */
function bodyItemButtons(): HTMLElement[] {
  const list = document.body.querySelector('.max-h-\\[180px\\]')
  return Array.from((list ?? document.body).querySelectorAll('.pop-item'))
}

const GLOBAL_SKILLS: SkillInfo[] = [
  { id: 'sk-code-review', name: 'code-review', description: '审查代码变更', enabled: true, source: 'agents', triggers: ['review'], effective: true },
  { id: 'sk-diagnose', name: 'diagnose', description: '诊断 bug', enabled: true, source: 'agents', triggers: ['diagnose'], effective: true },
]

describe('CommandPopover registry 合并源（TC2）', () => {
  let wrapper: ReturnType<typeof mount> | null = null

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    document.body.innerHTML = ''
  })

  function mountWithSource(props: Record<string, unknown>): void {
    wrapper = mount(CommandPopover, {
      attachTo: document.body,
      props: props as never,
      global: { provide: { [SLASH_COMMAND_SOURCE_KEY as symbol]: createSlashSource() } },
    })
  }

  /** 推 session.commands 到 commandStore（pi 真源存在性信息，保留订阅链路）。 */
  function pushCommands(sessionId: string, commands: Array<{ name: string; description?: string; source?: string }>): void {
    const msg = { type: 'session.commands', payload: { sessionId, commands } } as ServerMessage<'session.commands'>
    events.dispatchSession(sessionId, msg)
  }

  it('TC2a: panel 态 merged 源——commandStore 推 goal（缺 todo）→ 显示 /goal（description 取声明）+ /todo 交叉校验隐藏 + /compact 保留', async () => {
    mountWithSource({ open: true, type: 'slash', variant: 'panel', sessionId: 's1', query: '' })
    await flushPromises()
    // pi 真源：有 goal 无 todo（模拟 pi-goal 已装、pi-todo 未装）
    pushCommands('s1', [{ name: 'goal', description: 'pi 侧 goal 描述', source: 'extension' }])
    await flushPromises()
    await nextTick()

    const btns = bodyItemButtons()
    // compact + goal = 2 项（todo 声明侧存在但 pi 无 → 隐藏）
    expect(btns).toHaveLength(2)
    // /goal 显示且 description 元数据来自声明（'创建目标' 非 'pi 侧 goal 描述'）
    const goalRow = btns.find((b) => b.textContent?.includes('/goal'))
    expect(goalRow).toBeTruthy()
    expect(goalRow!.textContent).toContain('创建目标')
    expect(goalRow!.textContent).not.toContain('pi 侧 goal 描述')
    // /todo 不显示（交叉校验：仅声明侧存在 → 隐藏）
    expect(btns.some((b) => b.textContent?.includes('todo'))).toBe(false)
    // /compact 前端注入保留
    expect(btns.some((b) => b.textContent?.includes('/compact'))).toBe(true)
  })

  it('TC2b: landing 态（无 session 真源）→ registry 声明即显示（/goal /todo）+ skills 合并保留', async () => {
    mountWithSource({ open: true, type: 'slash', variant: 'landing', sessionId: undefined, query: '', globalSkills: GLOBAL_SKILLS })
    await flushPromises()
    await nextTick()

    const btns = bodyItemButtons()
    // goal + todo（声明即显示，slice TC2 裁决）+ 2 skills = 4 项
    expect(btns).toHaveLength(4)
    const texts = btns.map((b) => b.textContent ?? '')
    expect(texts.some((t) => t.includes('goal'))).toBe(true)
    expect(texts.some((t) => t.includes('todo'))).toBe(true)
    // description 元数据来自声明
    expect(texts.some((t) => t.includes('创建目标'))).toBe(true)
    // skills 合并保留（显示名去 /skill: 前缀）
    expect(texts.some((t) => t.includes('code-review'))).toBe(true)
    expect(texts.some((t) => t.includes('diagnose'))).toBe(true)
  })

  it('TC2c: landing 态有 session 真源且含 goal → merged（goal 去重元数据取声明）+ skills 合并', async () => {
    mountWithSource({ open: true, type: 'slash', variant: 'landing', sessionId: 'pub', query: '', globalSkills: GLOBAL_SKILLS })
    await flushPromises()
    pushCommands('pub', [{ name: 'goal', description: 'pi desc', source: 'extension' }])
    await flushPromises()
    await nextTick()

    const btns = bodyItemButtons()
    // goal（both，去重 1 项）+ todo（声明侧，pi 有真源可对照 → 隐藏）+ 2 skills = 3 项
    expect(btns).toHaveLength(3)
    const texts = btns.map((b) => b.textContent ?? '')
    // goal 只出现一次（声明 ∪ pi 去重）
    expect(texts.filter((t) => t.includes('goal')).length).toBe(1)
    // 元数据取声明
    expect(texts.some((t) => t.includes('创建目标'))).toBe(true)
    expect(texts.some((t) => t.includes('code-review'))).toBe(true)
  })
})

// ══════════ 来源：thinking-level-popover.test.ts ══════════

// 真实预设（从 useProviderEdit.ts THINKING_PRESETS 同步）
const HIGH_MAX_MAP = { off: 'off', high: 'high', max: 'xhigh' }
const ON_OFF_MAP = { off: 'off', high: 'high' }

describe('ThinkingLevelPopover onSelect 发 value（map 映射后）', () => {
  it('high-max: 选 max 档 → emit xhigh（value），非 max（key）', () => {
    const wrapper = mount(ThinkingLevelPopover, {
      props: { level: 'high', levelMap: HIGH_MAX_MAP },
    })
    const vm = wrapper.vm as unknown as { onSelect: (opt: { level: string; label: string; en: string; available: boolean }) => void }
    vm.onSelect({ level: 'max', label: '最高', en: 'max', available: true })
    const emitted = wrapper.emitted('select')
    expect(emitted).toBeTruthy()
    expect(emitted![0][0]).toBe('xhigh')
  })

  it('high-max: 选 high 档 → emit high', () => {
    const wrapper = mount(ThinkingLevelPopover, {
      props: { level: 'max', levelMap: HIGH_MAX_MAP },
    })
    const vm = wrapper.vm as unknown as { onSelect: (opt: { level: string; label: string; en: string; available: boolean }) => void }
    vm.onSelect({ level: 'high', label: '高', en: 'high', available: true })
    expect(wrapper.emitted('select')![0][0]).toBe('high')
  })

  it('on-off: 选 off 档 → emit off', () => {
    const wrapper = mount(ThinkingLevelPopover, {
      props: { level: 'high', levelMap: ON_OFF_MAP },
    })
    const vm = wrapper.vm as unknown as { onSelect: (opt: { level: string; label: string; en: string; available: boolean }) => void }
    vm.onSelect({ level: 'off', label: '关', en: 'off', available: true })
    expect(wrapper.emitted('select')![0][0]).toBe('off')
  })

  it('all-levels（map 空）→ emit key 自身', () => {
    const wrapper = mount(ThinkingLevelPopover, {
      props: { level: 'medium' },
    })
    const vm = wrapper.vm as unknown as { onSelect: (opt: { level: string; label: string; en: string; available: boolean }) => void }
    vm.onSelect({ level: 'off', label: '关', en: 'off', available: true })
    expect(wrapper.emitted('select')![0][0]).toBe('off')
  })
})

// ══ D3: props.level 为空时显示占位文案 ══
describe('D3: props.level 为空时触发器显示占位文案', () => {
  it('level 不传 → 触发器显示占位「…」', async () => {
    const wrapper = mount(ThinkingLevelPopover, {
      props: {},
    })
    await wrapper.vm.$nextTick()
    // D3：已建 session thinkingLevel 为空 → 显示占位「…」
    expect(wrapper.text()).toContain('…')
  })

  it('level=undefined → 触发器显示占位「…」', async () => {
    const wrapper = mount(ThinkingLevelPopover, {
      props: { level: undefined },
    })
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('…')
  })

  it('level="high" → 触发器正常显示档位名（不显示占位）', async () => {
    const wrapper = mount(ThinkingLevelPopover, {
      props: { level: 'high' },
    })
    await wrapper.vm.$nextTick()
    // 有明确档位时显示 high 档显示文案（getDisplayLabel → '高'，zh-CN 默认 locale）——
    // 断言包含期望文案使「有值仍渲染占位」回归可被抓到（not.toBe 恒真不可证伪）
    expect(wrapper.text()).toContain('高')
    expect(wrapper.text()).not.toContain('…')
  })
})

// ══ U9: pi 新语义（U6 改锚：可用集读 supportedLevels 下发）——mimo 场景档位渲染 ══
// xiaomi-token-plan-cn/mimo-v2.6-flash 的 supportedLevels = pi 同源计算默认五档。
describe('U9: mimo 场景（supportedLevels 未下发）→ 渲染默认五档含 minimal，无 xhigh/max', () => {
  it('DOM 含 5 个档位项：off/minimal/low/medium/high，不含 xhigh/max', async () => {
    const wrapper = mount(ThinkingLevelPopover, {
      props: { level: 'high' }, // supportedLevels 不传（undefined = 归一默认五档）
    })
    // 打开 popover 使档位列表渲染进 DOM
    await (wrapper.vm as unknown as { open: boolean }).$nextTick()
    const vm = wrapper.vm as unknown as { availableOptions: Array<{ level: string }> }
    const renderedLevels = vm.availableOptions.map((o) => o.level)
    expect(renderedLevels).toEqual(['off', 'minimal', 'low', 'medium', 'high'])
    expect(renderedLevels).not.toContain('xhigh')
    expect(renderedLevels).not.toContain('max')
  })

  it('supportedLevels=["off"]（non-reasoning 模型，pi 两级门控产物）→ availableOptions 只有 off', () => {
    const wrapper = mount(ThinkingLevelPopover, {
      props: { level: 'off', supportedLevels: ['off'] },
    })
    const vm = wrapper.vm as unknown as { availableOptions: Array<{ level: string }> }
    expect(vm.availableOptions.map((o) => o.level)).toEqual(['off'])
  })

  it('U6: supportedLevels 含 xhigh/max 档 → 对应档位渲染（下发集是可用档唯一权威）', () => {
    const wrapper = mount(ThinkingLevelPopover, {
      props: { level: 'max', supportedLevels: ['off', 'high', 'xhigh', 'max'] },
    })
    const vm = wrapper.vm as unknown as { availableOptions: Array<{ level: string }> }
    expect(vm.availableOptions.map((o) => o.level)).toEqual(['off', 'high', 'xhigh', 'max'])
  })
})

// ══════════ 来源：browser-overlay-mount.test.ts ══════════

/** 挂载 BrowserOverlay + 开浮层浏览器内容 + 落定挂载链（onMounted → nextTick pushRect/navigate/show） */
async function mountBrowserOverlay(url = 'http://localhost:1420/', sessionId = 'sess-a') {
  const wrapper = mount(BrowserOverlay)
  openBrowser(url, sessionId)
  await nextTick()
  await nextTick()
  await nextTick()
  return wrapper
}

describe('BrowserOverlay（BrowserPane 挂浮层壳，S5 渲染可点）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _resetOverlayForTest()
    // 模拟 window-factory 注入 windowId（BrowserPane onMounted fail-fast 前置）
    window.history.replaceState({}, '', '/?windowId=win-1')
  })

  afterEach(() => {
    _resetOverlayForTest()
    window.history.replaceState({}, '', '/')
  })

  it('openBrowser(url, 发起会话) → 浮层壳内渲染 BrowserPane（URL 注入链终点 DOM）', async () => {
    const wrapper = await mountBrowserOverlay('http://localhost:1420/', 'sess-a')
    expect(wrapper.find('[data-testid="wfvz-overlay"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="wfvz-overlay-panel"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="browser-pane"]').exists()).toBe(true)
    // 标题栏注入 URL（浮层壳标题栏 slot = 内容侧 header 信息）
    expect(wrapper.find('[data-testid="browser-overlay-title"]').text()).toContain('http://localhost:1420/')
    // BrowserPane 以发起会话为 view 键挂载（create + navigate + show 链）
    expect(mockBrowserCreate).toHaveBeenCalledWith('sess-a', expect.any(String))
    expect(mockBrowserNavigate).toHaveBeenCalledWith('sess-a', 'http://localhost:1420/')
    expect(mockBrowserShow).toHaveBeenCalledWith('sess-a')
    wrapper.unmount()
  })

  it('显示收尾事实源：browser:overlay-state 上报 {open, content, sessionId} 且先于 show 请求（谓词事实先行）', async () => {
    const wrapper = await mountBrowserOverlay()
    expect(mockBrowserSetOverlayState).toHaveBeenCalledWith({
      open: true,
      content: 'browser',
      sessionId: 'sess-a',
    })
    // 契约：BrowserPane 挂载/重开前先上报（谓词事实先于 show 请求）——取 open:true 的那次上报比对
    const openReportIndex = mockBrowserSetOverlayState.mock.calls.findIndex(
      (call) => (call[0] as { open: boolean }).open === true,
    )
    expect(openReportIndex).toBeGreaterThanOrEqual(0)
    const reportOrder = mockBrowserSetOverlayState.mock.invocationCallOrder[openReportIndex]
    const showOrder = mockBrowserShow.mock.invocationCallOrder[0]
    expect(reportOrder).toBeLessThan(showOrder)
    wrapper.unmount()
  })

  it("canvas 内容上报：openCanvasOverlay(canvasId, 归属会话) → browser:overlay-state 收 content='canvas' 且 sessionId=null", async () => {
    // [u-canvas] payload 现持归属会话（core openCanvasOverlay 双参契约，画布归属创建会话）；
    // 主进程显示谓词面 sessionId 恒报 null（canvas 内容不驱动 browser view 显示，谓词面语义不变）
    const wrapper = mount(BrowserOverlay)
    openCanvasOverlay('cvs-1', 'sess-canvas')
    await nextTick()
    await nextTick()
    expect(mockBrowserSetOverlayState).toHaveBeenCalledWith({
      open: true,
      content: 'canvas',
      sessionId: null,
    })
    wrapper.unmount()
  })

  it('view 定位浮层视口（S5）：rect 同步观测浮层壳内 browser-vp 元素，推其 getBoundingClientRect round 值', async () => {
    const wrapper = mount(BrowserOverlay)
    openBrowser('http://localhost:1420/', 'sess-a')
    await nextTick()
    // 单元素 stub：若观测目标不是浮层视口内 browser-vp（如旧抽屉视口），推的不是该 rect
    const vp = wrapper.find('[data-testid="browser-vp"]').element
    vi.spyOn(vp, 'getBoundingClientRect').mockReturnValue({
      x: 10.4,
      y: 20.6,
      width: 300.2,
      height: 400.8,
      top: 20.6,
      left: 10.4,
      right: 310.6,
      bottom: 421.4,
      toJSON: () => ({}),
    } as DOMRect)
    await nextTick()
    await nextTick()
    expect(mockBrowserSetRect).toHaveBeenCalledWith('sess-a', { x: 10, y: 21, width: 300, height: 401 })
    wrapper.unmount()
  })
})

describe('BrowserOverlay（关闭通道 + 单例换内容，§7.4 联动③关浮层隐藏）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _resetOverlayForTest()
    // 模拟 window-factory 注入 windowId（BrowserPane onMounted fail-fast 前置）
    window.history.replaceState({}, '', '/?windowId=win-1')
  })

  afterEach(() => {
    _resetOverlayForTest()
    window.history.replaceState({}, '', '/')
  })

  it('closeOverlay（Esc/⌘W 编排器同落点）→ 内容卸载（browserHide keep-alive）+ 关态上报 + DOM 无残留', async () => {
    const wrapper = await mountBrowserOverlay()
    expect(wrapper.find('[data-testid="browser-pane"]').exists()).toBe(true)

    closeOverlay()
    await nextTick()
    await nextTick()
    expect(wrapper.find('[data-testid="wfvz-overlay"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="browser-pane"]').exists()).toBe(false)
    expect(mockBrowserHide).toHaveBeenCalledWith('sess-a')
    expect(mockBrowserSetOverlayState).toHaveBeenLastCalledWith({
      open: false,
      content: null,
      sessionId: null,
    })
    wrapper.unmount()
  })

  it('点遮罩关闭（壳两通道之一）→ 浮层关闭、浏览器内容卸载', async () => {
    const wrapper = await mountBrowserOverlay()
    await wrapper.find('[data-testid="wfvz-overlay"]').trigger('click')
    await nextTick()
    expect(wrapper.find('[data-testid="wfvz-overlay"]').exists()).toBe(false)
    expect(mockBrowserHide).toHaveBeenCalledWith('sess-a')
    wrapper.unmount()
  })

  it('单例换内容：browser → workflow 换出时 browser 壳卸载（两壳互斥不叠显）', async () => {
    const wrapper = await mountBrowserOverlay()
    openOverlay({ kind: 'workflow', payload: { sessionId: 'sess-a', runId: 'wf-1' } })
    await nextTick()
    await nextTick()
    expect(wrapper.find('[data-testid="browser-pane"]').exists()).toBe(false)
    expect(mockBrowserHide).toHaveBeenCalledWith('sess-a')
    // 换出后主进程谓词事实同步为 workflow 内容（view 不显示）
    expect(mockBrowserSetOverlayState).toHaveBeenLastCalledWith({
      open: true,
      content: 'workflow',
      sessionId: 'sess-a',
    })
    wrapper.unmount()
  })

  it('Esc/⌘W 层级序终点（stack-order 编排器落点）：closeTopContainer 剥浮层 → 浏览器内容卸载；页面聚焦态 Esc 归页面（不入转发清单）由主进程键矩阵对账', async () => {
    const wrapper = await mountBrowserOverlay()
    // DOM 侧 Esc 路由落点 = 栈序编排器唯一属主（kind 无关直接关 core 开合态）；
    // 跨 webContents 半边（view 内焦点时 Esc 不转发、⌃`/⌘W 转发）见 browser-forward-keys.test.ts
    const closed = closeTopContainer()
    expect(closed).toBe(true)
    await nextTick()
    expect(wrapper.find('[data-testid="browser-pane"]').exists()).toBe(false)
    expect(mockBrowserHide).toHaveBeenCalledWith('sess-a')
    wrapper.unmount()
  })
})

// ══════════ 来源：turn-skill-badge.test.ts ══════════

const mockOpen = vi.fn()

describe('Turn skill badge 渲染', () => {
  beforeEach(() => {
    mockOpen.mockClear()
  })

  function makeTurn(userOver: Partial<Message> = {}): MessageTurn {
    return {
      index: 1,
      user: {
        id: 'u1',
        role: 'user',
        content: [{ type: 'text', text: '想要都修复' }],
        status: 'complete',
        timestamp: Date.now(),
        ...userOver,
      },
      assistants: [],
      isStreaming: false,
      hasFoldable: false,
    }
  }

  function mountTurn(turn: MessageTurn, sessionId = 's1') {
    return mount(Turn, {
      props: { turn, sessionId },
      global: {
        plugins: [createPinia()],
        provide: mockChatProvide({ openDrawer: mockOpen }),
        stubs: {
          Block: true,
          ChangeSetCard: true,
          MarkdownRenderer: true,
        },
      },
    })
  }

  it('含skillName时渲染紫色badge + skill名（无/skill:前缀，icon已表示类型）', () => {
    const wrapper = mountTurn(makeTurn({
      content: [{ type: 'skill', name: 'cw-cli' }, { type: 'text', text: '想要都修复' }],
    }))
    // 紫色badge元素存在
    const badge = wrapper.find('.text-reasoning')
    expect(badge.exists()).toBe(true)
    // 显示层只显 skill 名（cw-cli），不含 /skill: 前缀（icon+紫色已传达类型）
    expect(badge.text()).toContain('cw-cli')
    expect(badge.text()).not.toContain('/skill:')
  })

  it('点击badge调用openCommandDoc', async () => {
    const wrapper = mountTurn(makeTurn({
      content: [{ type: 'skill', name: 'cw-cli' }, { type: 'text', text: '想要都修复' }],
    }))
    // 点击badge
    const badge = wrapper.find('.cursor-pointer')
    expect(badge.exists()).toBe(true)
    await badge.trigger('click')
    // 验证调用了drawer.open('doc', { commandName })
    expect(mockOpen).toHaveBeenCalledWith('doc', { commandName: '/skill:cw-cli' })
  })

  it('无skillName时走原slashChip逻辑', () => {
    const wrapper = mountTurn(makeTurn({
      content: [{ type: 'text', text: '/compact 压缩上下文' }],
    }))
    // 不显示skill badge（.text-reasoning）
    const badge = wrapper.find('.text-reasoning')
    // 可能有slashChip，但不是skill badge
    if (badge.exists()) {
      expect(badge.text()).not.toContain('/skill:')
    }
  })

  it('无skillName且无slash命令时显示纯文本', () => {
    const wrapper = mountTurn(makeTurn({
      content: [{ type: 'text', text: '普通消息' }],
    }))
    // MarkdownRenderer被stub，检查skill badge不存在
    expect(wrapper.find('.text-reasoning').exists()).toBe(false)
  })
})

// ══════════ 来源：turn-file-badge.test.ts ══════════

const mockOpenDrawer = vi.fn()
const mockSelectFile = vi.fn()

describe('W5: Turn file badge 渲染（FR-7）', () => {
  beforeEach(() => {
    mockOpenDrawer.mockClear()
    mockSelectFile.mockClear()
  })

  function makeTurn(userOver: Partial<Message> = {}): MessageTurn {
    return {
      index: 1,
      user: {
        id: 'u1',
        role: 'user',
        content: [{ type: 'text', text: '看下这个文件' }],
        status: 'complete',
        timestamp: Date.now(),
        ...userOver,
      },
      assistants: [],
      isStreaming: false,
      hasFoldable: false,
    }
  }

  function mountTurn(turn: MessageTurn, sessionId = 's1') {
    return mount(Turn, {
      props: { turn, sessionId },
      global: {
        plugins: [createPinia()],
        provide: mockChatProvide({ onFileClick: mockSelectFile, openDrawer: mockOpenDrawer }),
      },
    })
  }

  it('U14: file segment 渲染绿色 badge（basename + L10-L20 + tooltip 全路径）', () => {
    const turn = makeTurn({
      content: [
        { type: 'file', path: 'src/foo.ts', lineRange: [10, 20] },
        { type: 'text', text: ' 这里有问题' },
      ],
    })
    const wrapper = mountTurn(turn)

    const badge = wrapper.find('[data-testid^="msg-file-badge"]')
    expect(badge.exists()).toBe(true)
    // basename + 行范围后缀
    expect(badge.text()).toContain('foo.ts')
    expect(badge.text()).toContain('L10-L20')
    // tooltip 全路径
    expect(badge.attributes('title')).toBe('src/foo.ts')
    // 绿色 badge（--success token）
    expect(badge.classes().some((c) => c.includes('text-success'))).toBe(true)
  })

  it('U14b: file segment 无行范围时 badge 只显 basename', () => {
    const turn = makeTurn({
      content: [{ type: 'file', path: 'src/bar.ts' }],
    })
    const wrapper = mountTurn(turn)

    const badge = wrapper.find('[data-testid^="msg-file-badge"]')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toContain('bar.ts')
    expect(badge.text()).not.toContain('L')
  })

  it('U14c: 单行 lineRange 显示 L<n>（非 L<n>-L<n>）', () => {
    const turn = makeTurn({
      content: [{ type: 'file', path: 'a.ts', lineRange: [5, 5] }],
    })
    const wrapper = mountTurn(turn)

    const badge = wrapper.find('[data-testid^="msg-file-badge"]')
    expect(badge.text()).toContain('L5')
    expect(badge.text()).not.toContain('L5-L5')
  })

  it('U14d: 点击 badge 调 selectFile + openDrawer detail', async () => {
    const turn = makeTurn({
      content: [{ type: 'file', path: 'src/foo.ts', lineRange: [10, 20] }],
    })
    const wrapper = mountTurn(turn)

    await wrapper.find('[data-testid^="msg-file-badge"]').trigger('click')
    expect(mockSelectFile).toHaveBeenCalledWith('src/foo.ts')
    expect(mockOpenDrawer).toHaveBeenCalledWith('detail', { filePath: 'src/foo.ts' })
  })
})

// ══════════ 来源：add-menu-popover.test.ts ══════════

describe('AddMenuPopover（TC4 slice5）', () => {
  let wrapper: ReturnType<typeof mount> | null = null

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    document.body.innerHTML = ''
  })

  /** 打开 popover 并返回 body 内的命令项按钮（按渲染顺序：attach / image / slash） */
  async function openAndGetItems(): Promise<HTMLElement[]> {
    wrapper = mount(AddMenuPopover)
    ;(wrapper.vm as unknown as { open: boolean }).open = true
    await wrapper.vm.$nextTick()
    // PopoverContent teleport 到 body；命令项容器 min-w-[160px]（M4c demo .popover 基形态宽），
    // 按钮按 v-for 顺序
    const list = document.body.querySelector('.min-w-\\[160px\\]') ?? document.body
    return Array.from(list.querySelectorAll('button'))
  }

  it('TC4a: 渲染 3 项（attach / image / slash），image 项显 image 文案', async () => {
    const items = await openAndGetItems()
    expect(items.length).toBe(3)
    // 顺序：attach / image / slash
    const labels = items.map((b) => b.textContent ?? '')
    expect(labels.some((l) => l.includes('附件') || l.includes('Attachment'))).toBe(true) // attach
    expect(labels.some((l) => l.includes('图片') || l.includes('Image'))).toBe(true) // image
    expect(labels.some((l) => l.includes('命令') || l.includes('Command'))).toBe(true) // slash
  })

  it('TC4b: 点 image 项 → emit("select", "image")', async () => {
    const items = await openAndGetItems()
    // image 是第 2 项（index 1）
    items[1].click()
    await wrapper!.vm.$nextTick()
    const selectEvents = wrapper!.emitted('select')
    expect(selectEvents).toBeTruthy()
    expect(selectEvents![0]).toEqual(['image'])
  })

  it('TC4c: 点 attach 项 → emit("select", "attach")', async () => {
    const items = await openAndGetItems()
    // attach 是第 1 项（index 0）
    items[0].click()
    await wrapper!.vm.$nextTick()
    const selectEvents = wrapper!.emitted('select')
    expect(selectEvents).toBeTruthy()
    expect(selectEvents![0]).toEqual(['attach'])
  })
})

// ══════════ 来源：model-picker-panel.test.ts ══════════

const MODEL_PICKER_GROUPS: ModelPickerGroup[] = [
  { provider: 'Anthropic', models: [{ id: 'claude-4', name: 'Claude 4' }] },
]

function mountPanel(props: Record<string, unknown> = {}) {
  return mount(ModelPickerPanel, { props: { groups: MODEL_PICKER_GROUPS, ...props } })
}

describe('ModelPickerPanel hoverSelect（W3a 可选通道）', () => {
  it('默认关闭：pointerenter 不 emit hoverSelect，列表 DOM 照常渲染（用户可见 DOM 断言）', async () => {
    const wrapper = mountPanel()
    const row = wrapper.find('[data-testid="model-picker-item-claude-4"]')
    expect(row.exists()).toBe(true)

    await row.trigger('pointerenter')
    expect(wrapper.emitted('hoverSelect')).toBeUndefined()
  })

  it('hoverSelect: true → pointerenter 上抛 hoverSelect({ id, providerId })（单 payload，顺带发现 7 起 providerId 随组上行）', async () => {
    const wrapper = mountPanel({ hoverSelect: true })
    const row = wrapper.find('[data-testid="model-picker-item-claude-4"]')
    expect(row.exists()).toBe(true)

    await row.trigger('pointerenter')
    const emitted = wrapper.emitted('hoverSelect')
    expect(emitted).toBeTruthy()
    expect(emitted![0][0]).toEqual({ id: 'claude-4' })
  })

  it('click 通道不受 hoverSelect 影响：照常 emit update:modelValue({ id, providerId })', async () => {
    const wrapper = mountPanel({ hoverSelect: true })
    await wrapper.find('[data-testid="model-picker-item-claude-4"]').trigger('click')
    const emitted = wrapper.emitted('update:modelValue')
    expect(emitted).toBeTruthy()
    expect(emitted![0][0]).toEqual({ id: 'claude-4' })
  })
})
