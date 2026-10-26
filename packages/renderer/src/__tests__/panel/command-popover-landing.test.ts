/**
 * CommandPopover landing 态 slash 命令源 单测（L1-L14，W4 重构后）。
 *
 * W4 改动：landing 全局 skill 源从 settingsStore.skills 改为 globalSkills prop（经 useGlobalSkills
 * 拉取 skillRegistry globalCache，FR-5：不走 settingsStore.skills 配置态扫描）。CommandPopover 不再
 * import useSettingsStore，变纯展示组件（globalSkills + projectSkills 两 prop 驱动）。
 *
 * 验证按 variant 分支：landing 态（variant='landing'）合并 globalSkills（全局）∪ projectSkills
 * （当前 cwd），skill name 归一化为 /skill:<name>；panel 态用 commandStore + compact，不并入
 * globalSkills。__ 前缀命令过滤（host 内部命令不显示）。
 *
 * 覆盖三视角：
 * - 构建者（白盒）：items 来源（commandStore vs globalSkills/projectSkills props）、归一化字段
 * - 使用者（黑盒）：输入 / → 能看到并选中 skill 命令（L7 select）
 * - 观察者（形态）：命令项 DOM、svg 图标渲染、PopoverContent 显隐
 *
 * AC-8 反向断言：slash 命令源不读 settingsStore.skills（FR-5）。验证：即使 settingsStore.skills
 * 有值，landing 不显示（globalSkills prop 空时 landing 为空）。
 *
 * ── 波 2a 簇 2-10 合并说明 ──
 * 节 2（本文件尾部）= model-thinking-aggregate.test.ts：ModelThinkingAggregate 聚合按钮
 * （click 弹层 + hover 即切 D2 + pending 单飞锁）。
 * 节 3（本文件尾部）= model-select-popover.test.ts：ModelSelectPopover 纯受控 + store 数据源。
 * 三节同域（composer 模型/命令弹层）。'@/api' mock 由原窄化替换改造为保留式部分 mock
 * （见下方 mock 块注释）；MODELS 常量按节改名 TA_MODELS / MSP_MODELS；节 2/3 原
 * 文件级 beforeEach 下沉为节内（节 2 经 taBeforeEach 挂 5 个 describe、节 3 单
 * describe），防止三重文件级 beforeEach 重建 pinia 互踩 models 注入。describe/it 名零改动。
 *
 * 运行：cd packages/renderer && TAIJI_SKIP_REAL_PI=1 npx vitest run src/__tests__/panel/command-popover-landing.test.ts --pool=threads
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, h, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import type { ServerMessage, SkillInfo } from '@taiji/shared'
import * as events from '@taiji/core/transport/api'
import { getSettingsStore, provideSettingsTransport, provideSettingsStore, createSettingsStore } from '@taiji/core'
import { makeSkillsReloadTransportStub } from '../helpers/settings-transport-stub'
import { __testing } from '@/composables/features/command/useCommandStore'
import CommandPopover from '@/components/panel/CommandPopover.vue'
import type { VueWrapper } from '@vue/test-utils'
import ModelThinkingAggregate from '@/components/panel/ModelThinkingAggregate.vue'
import ModelSelectPopover from '@/components/panel/ModelSelectPopover.vue'

// Wave3 TC5：useGlobalSkills 走真实 events 订阅链路（dispatchGlobal → handler → loadGlobal(true) → DOM 刷新）。
// onSkillCacheInvalidated 接真实 events.onGlobalType，使广播能端到端触达 composable。
// getGlobalSkills 为可控 mock（TC5 中途改返回值模拟 runtime 重扫后缓存更新）。
const getGlobalSkillsMock = vi.hoisted(() => vi.fn().mockResolvedValue([]))
// useCommandSync 依赖 session.getCommands，landing 态 sessionId 为 undefined 时不触发拉取，
// 但 mock 须声明 session 导出防 vi.mock 的严格校验。
const getCommandsMock = vi.hoisted(() => vi.fn().mockResolvedValue({ sessionId: '', commands: [] }))
// [波 2a 合并改造] 保留式部分 mock（importOriginal spread actual + 仅覆写目标成员）：
// 原窄化替换（只返回 config/session 两域）会砍掉门面其余全部域导出，泄漏进同文件
// model-thinking-aggregate / model-select-popover 节的组件链（settingsStore 装配等
// 消费 @/api 其他成员 → undefined → 全节红）。
vi.mock('@/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api')>()
  const realEvents = await import('@taiji/core/transport/api')
  return {
    ...actual,
    config: {
      ...actual.config,
      getGlobalSkills: getGlobalSkillsMock,
      onSkillCacheInvalidated: (handler: (p: { scope: 'global' | 'project'; cwd?: string }) => void) =>
        realEvents.onGlobalType('config.skillCacheInvalidated', (msg) => {
          handler(msg.payload as { scope: 'global' | 'project'; cwd?: string })
        }),
    },
    session: {
      ...actual.session,
      getCommands: getCommandsMock,
    },
  }
})

// fixture：对照 api/mock/settings-data.ts fixtureSkills（7 条，name 不带 /）。
// sourcePath（I-7）：D3 的 location 链（SkillInfo.sourcePath → buildLandingSlashCandidates
// → CmdItem.location → emit select.location → insertSkillChip dataset）必须有真实值可断——
// 此前 fixture 无 sourcePath，L7 只能把 location: undefined 当期望值锁死，链路断裂仍全绿。
const SKILLS_ROOT = '/Users/test/.agents/skills'
const LANDING_SKILLS: SkillInfo[] = [
  { id: 'sk-code-review', name: 'code-review', description: '审查代码变更', enabled: true, source: 'agents', triggers: ['review'], effective: true, sourcePath: `${SKILLS_ROOT}/code-review/SKILL.md` },
  { id: 'sk-diagnose', name: 'diagnose', description: '诊断 bug 和性能问题', enabled: true, source: 'agents', triggers: ['diagnose'], effective: true, sourcePath: `${SKILLS_ROOT}/diagnose/SKILL.md` },
  { id: 'sk-impeccable', name: 'impeccable', description: '前端界面设计与优化', enabled: true, source: 'claude', triggers: ['impeccable'], effective: true, sourcePath: `${SKILLS_ROOT}/impeccable/SKILL.md` },
  { id: 'sk-fallow', name: 'fallow', description: '代码库健康分析', enabled: true, source: 'pi', triggers: ['fallow'], effective: true, sourcePath: `${SKILLS_ROOT}/fallow/SKILL.md` },
  { id: 'sk-tavily', name: 'tavily-web-search', description: '网络搜索', enabled: true, source: 'agents', triggers: ['搜索'], effective: true, sourcePath: `${SKILLS_ROOT}/tavily-web-search/SKILL.md` },
  { id: 'sk-batch-tracer', name: 'batch-tracer', description: '批量代码分析', enabled: true, source: 'agents', triggers: ['批量分析'], effective: true, sourcePath: `${SKILLS_ROOT}/batch-tracer/SKILL.md` },
  { id: 'sk-pi-goal', name: 'pi-goal', description: '目标驱动的任务管理', enabled: true, source: 'piinstall', triggers: ['goal'], effective: true, sourcePath: `${SKILLS_ROOT}/pi-goal/SKILL.md` },
]

// session 源 fixture：对照 command-store.test.ts RAW（3 条 pi 动态命令，name 带 /）。
// compact 不在此列——pi get_commands 不返回 builtin（仅服务 pi TUI autocomplete），
// 由 CommandPopover slashCommands computed 在前端注入。此处若再加 compact 会与前端注入重复。
const SESSION_CMDS = [
  { name: '/commit', description: '提交改动', source: 'extension' },
  { name: '/review', description: '代码审查', source: 'extension' },
  { name: '/fix', description: '修复问题', source: 'skill' },
]

/** reka-ui PopoverContent teleport 到 body：在 body 内找命令项行（v-for 渲染为 .pop-item div）。
 *  按 item 列表容器（.max-h-[180px]）定位——不依赖行文本含 /（skill 项显示去掉了 / 前缀）。
 *  行 = 纯 div（demo .pop-item 行），选择器 '.pop-item'。 */
function bodyItemButtons(): HTMLElement[] {
  const list = document.body.querySelector('.max-h-\\[180px\\]')
  return Array.from((list ?? document.body).querySelectorAll('.pop-item'))
}

beforeEach(() => {
  setActivePinia(createPinia())
  provideSettingsStore(createSettingsStore())
  // [w5] CommandPopover 改经壳单例（core 实例）：reset 防跨用例残留 commandsBySession/appCommands
  __testing.__resetCommandStoreForTesting()
})

describe('CommandPopover landing 态用 globalSkills prop（L1-L14，W4）', () => {
  let wrapper: ReturnType<typeof mount> | null = null

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    document.body.innerHTML = ''
  })

  /** mount landing 态：variant='landing' + globalSkills prop（W4：替代 settingsStore.skills）。
   *  [W3] 公共 session 已移除，生产 landing composerSid 为 null。这里传非空 sid 仅复用
   *  CommandPopover 合并逻辑验证（组件支持非空 sessionId + extCmds）；L11 另用 undefined 测空源。 */
  async function mountLanding(query = '', globalSkills: SkillInfo[] = LANDING_SKILLS, sid = 'public-sid'): Promise<void> {
    wrapper = mount(CommandPopover, {
      attachTo: document.body,
      props: { open: true, type: 'slash', variant: 'landing', sessionId: sid, query, globalSkills },
    })
    await flushPromises()
    await nextTick()
  }

  it('L1 landing（variant=landing + 非空 sessionId）+ globalSkills 7 条 → 渲染 7 项，首项含 code-review（显示去 /skill: 前缀）', async () => {
    await mountLanding('')
    const btns = bodyItemButtons()
    expect(btns).toHaveLength(7)
    // 显示层：skill 只显名字（icon 已表示类型），不含 /skill: 或 / 前缀
    expect(btns[0].textContent).toContain('code-review')
  })

  it('L2 query="co" → 仅 code-review（1 项）', async () => {
    await mountLanding('co')
    const btns = bodyItemButtons()
    expect(btns).toHaveLength(1)
    expect(btns[0].textContent).toContain('code-review')
  })

  it('L3 query="zzz" → 0 项，PopoverContent 不渲染（v-if items.length>0）', async () => {
    await mountLanding('zzz')
    expect(bodyItemButtons()).toHaveLength(0)
    expect(document.body.querySelector('[data-radix-popper-content-wrapper]')).toBeNull()
  })

  it('L4 globalSkills 空 → 0 项', async () => {
    await mountLanding('', [])
    expect(bodyItemButtons()).toHaveLength(0)
  })

  // [ADR-0050 二次修订翻转] panel 态 slash 段 skill 换源保留：SESSION_CMDS 的 /fix
  // source='skill'（pi 真源 skill 快照项）仍剔除，globalSkills 的 registry 源 skill 项补入
  // （与 landing 单列形态同构的追加函数）。
  it('L5 session 态（variant=panel + sessionId=s1）→ compact + 2 extension 命令 + registry 源 skill 项(7)补入；pi 真源 skill 项（/fix source=skill）不进 slash 段', async () => {
    wrapper = mount(CommandPopover, {
      attachTo: document.body,
      props: { open: true, type: 'slash', variant: 'panel', sessionId: 's1', query: '', globalSkills: LANDING_SKILLS },
    })
    await flushPromises()
    // 推 session 源命令（3 条 pi 动态命令：2 extension + 1 skill）
    const msg = {
      type: 'session.commands',
      payload: { sessionId: 's1', commands: SESSION_CMDS },
    } as ServerMessage<'session.commands'>
    events.dispatchSession('s1', msg)
    await flushPromises()
    await nextTick()

    const btns = bodyItemButtons()
    // compact + 2 extension + 7 registry skills = 10 项
    expect(btns).toHaveLength(10)
    expect(btns.some((b) => b.textContent?.includes('/compact'))).toBe(true) // 前端注入的 builtin，globalSkills 里没有
    expect(btns.some((b) => b.textContent?.includes('commit'))).toBe(true)
    expect(btns.some((b) => b.textContent?.includes('fix'))).toBe(false) // pi 真源 skill 快照项剔除（reload 才刷新，换源保留的剔除半边）
    // registry 源 skill 项补入
    expect(btns.some((b) => b.textContent?.includes('code-review'))).toBe(true)
    expect(btns.some((b) => b.textContent?.includes('pi-goal'))).toBe(true)
  })

  // L5b [ADR-0050 二次修订] 换源保留的剔除半边：panel 态 slash 段对 pi 真源 `skill:` 前缀
  // 命令剔除（pi 的 skill 命令名是裸 `skill:<name>`，reload 才刷新的快照）；未传 registry
  // 源 props 时无 skill 项补入。registry 源补入的正向断言由 L5 覆盖；landing 态含 skill
  // 不变（单列形态回归锁）。
  it('L5b panel 态 slash 段剔除 pi 真源 skill: 前缀项（未传 registry 源则无 skill 补入）；landing 态 slash 含 skill 不变（回归锁）', async () => {
    wrapper = mount(CommandPopover, {
      attachTo: document.body,
      props: { open: true, type: 'slash', variant: 'panel', sessionId: 's1', query: '' },
    })
    await flushPromises()
    const msg = {
      type: 'session.commands',
      payload: {
        sessionId: 's1',
        commands: [
          { name: 'skill:alpha', description: 'A', source: 'skill' },
          { name: '/commit', description: '提交', source: 'extension' },
        ],
      },
    } as ServerMessage<'session.commands'>
    events.dispatchSession('s1', msg)
    await flushPromises()
    await nextTick()

    const btns = bodyItemButtons()
    // compact + commit = 2 项；pi 快照 skill:alpha 剔除、未传 registry 源故无 skill 项补入
    expect(btns).toHaveLength(2)
    expect(btns.some((b) => b.textContent?.includes('alpha'))).toBe(false)
    expect(btns.some((b) => b.textContent?.includes('commit'))).toBe(true)
    expect(btns.some((b) => b.textContent?.includes('/compact'))).toBe(true)
    wrapper?.unmount()
    wrapper = null

    // 对照：landing 态 slash 含 skill 不变（L1 单列形态，过滤仅限 panel）
    wrapper = mount(CommandPopover, {
      attachTo: document.body,
      props: { open: true, type: 'slash', variant: 'landing', sessionId: undefined, query: '', globalSkills: LANDING_SKILLS },
    })
    await flushPromises()
    await nextTick()
    const landingBtns = bodyItemButtons()
    expect(landingBtns).toHaveLength(7)
    expect(landingBtns.some((b) => b.textContent?.includes('code-review'))).toBe(true)
  })

  it('L6 每个命令项含 svg（icon=star 渲染）', async () => {
    await mountLanding('')
    const btns = bodyItemButtons()
    for (const b of btns) {
      expect(b.querySelector('svg')).toBeTruthy()
    }
  })

  it('L7 选中首项 → emit select {type:"slash", name:"/skill:code-review", icon:"star", description:"审查代码变更", location: SKILL.md 路径}（AC-4 + D3 location 链）', async () => {
    // AC-4：landing 选中 skill 后 emit name 形如 /skill:<name>（pi agent-session.ts:1210 要求 /skill: 前缀）
    // D3 location 链：[I-7] 断言 SkillInfo.sourcePath 直达 payload.location（此前 fixture 无 sourcePath，
    // 用例只能锁 location: undefined，location 链断裂也不报错）
    await mountLanding('')
    const btns = bodyItemButtons()
    await btns[0].click()
    const selectEvents = wrapper!.emitted('select')
    expect(selectEvents).toBeTruthy()
    const payload = selectEvents!.at(-1)![0] as { type: string; name: string; icon?: string; description?: string }
    // isSkill/location 是 D3 项类型路由新增透传字段（skill 项 → onCmdSelect 分流 skill 通路）；
    // 其余 session/subagent 字段缺省 undefined，一并入全等形状
    expect(payload).toEqual({
      type: 'slash',
      name: '/skill:code-review',
      icon: 'star',
      description: '审查代码变更',
      isSkill: true,
      location: `${SKILLS_ROOT}/code-review/SKILL.md`,
      sessionId: undefined,
      label: undefined,
      subagentId: undefined,
      slug: undefined,
    })
  })

  // L20 [I-7 边界]：sourcePath 缺失是 location === undefined 的**唯一**原因（与 L7 配对区分两因：
  // L7 有 sourcePath → 真实路径；本用例无 sourcePath → undefined，不是「链路没接」而是「源无值」）
  it('L20 边界：skill 无 sourcePath → emit select.location === undefined（区分 location 链断裂与源无值）', async () => {
    const noPathSkills: SkillInfo[] = [
      { id: 'sk-no-path', name: 'no-path-skill', description: '无路径', enabled: true, source: 'agents', effective: true },
    ]
    await mountLanding('', noPathSkills)
    const btns = bodyItemButtons()
    expect(btns).toHaveLength(1)
    await btns[0].click()
    const payload = wrapper!.emitted('select')!.at(-1)![0] as { name: string; location?: string; isSkill?: boolean }
    expect(payload.name).toBe('/skill:no-path-skill')
    expect(payload.isSkill).toBe(true)
    expect(payload.location).toBeUndefined()
  })

  // L19 [S-2]：slash 路（行首命令浮层 / + 菜单「命令」入口）同样消费 selectedSkillNames——
  // 已插入的 skill 项标 selected（「已选」+ aria-disabled）且 onSelect 早退，防同一 skill
  // 经 slash 路重复插入 ⇒ runtime 注入两遍 SKILL.md 全文。未命中项不受影响。
  it('L19 slash 路已选 skill 禁选（S-2）：命中项显示「已选」+ aria-disabled、点击不 emit select；未命中项正常选', async () => {
    wrapper = mount(CommandPopover, {
      attachTo: document.body,
      props: {
        open: true,
        type: 'slash',
        variant: 'landing',
        sessionId: 'public-sid',
        query: '',
        globalSkills: LANDING_SKILLS,
        selectedSkillNames: ['code-review'],
      },
    })
    await flushPromises()
    await nextTick()

    const btns = bodyItemButtons()
    expect(btns).toHaveLength(7)
    const selectedRow = btns.find((b) => b.textContent?.includes('code-review'))!
    expect(selectedRow.getAttribute('aria-disabled')).toBe('true')
    expect(selectedRow.textContent).toContain('已选')

    // 命中项点击 → onSelect 早退，不 emit select
    await selectedRow.click()
    expect(wrapper!.emitted('select')).toBeFalsy()

    // 未命中项（diagnose）不受禁选影响，正常 emit（禁选只作用于命中项，非整路失效）
    const otherRow = btns.find((b) => b.textContent?.includes('diagnose'))!
    expect(otherRow.getAttribute('aria-disabled')).toBeNull()
    await otherRow.click()
    const selectEvents = wrapper!.emitted('select')
    expect(selectEvents).toBeTruthy()
    expect(selectEvents!.at(-1)![0]).toMatchObject({ type: 'slash', name: '/skill:diagnose', isSkill: true })
  })

  // L9 [AC-2]：landing 合并源验证——同时显示 pi extension 命令 + globalSkills
  // [W3] 生产 landing 态无 pi 命令源；本用例显式 dispatch pi 命令验证合并逻辑（组件支持非空 sessionId + extCmds）。
  it('L9 landing（variant=landing + sessionId=public-sid + commandStore 有 public-sid 命令）→ 同时显示 pi extension 命令 + globalSkills（合并源）', async () => {
    wrapper = mount(CommandPopover, {
      attachTo: document.body,
      props: { open: true, type: 'slash', variant: 'landing', sessionId: 'public-sid', query: '', globalSkills: LANDING_SKILLS },
    })
    await flushPromises()
    // 推 pi extension 命令（3 条，模拟 session.commands 事件，组件合并逻辑验证）
    const msg = {
      type: 'session.commands',
      payload: { sessionId: 'public-sid', commands: SESSION_CMDS },
    } as ServerMessage<'session.commands'>
    events.dispatchSession('public-sid', msg)
    await flushPromises()
    await nextTick()

    const btns = bodyItemButtons()
    // 3 pi extension 命令 + 7 globalSkills = 10 项（landing 合并源，无 compact）
    expect(btns).toHaveLength(10)
    // pi extension 命令在列（/commit 来自 SESSION_CMDS）
    expect(btns.some((b) => b.textContent?.includes('commit'))).toBe(true)
    // globalSkills 在列（code-review 来自 LANDING_SKILLS）
    expect(btns.some((b) => b.textContent?.includes('code-review'))).toBe(true)
    // landing 不含 compact（无上下文可压缩）
    expect(btns.some((b) => b.textContent?.includes('compact'))).toBe(false)
  })

  // L10 [R2 fix]：pi 源 skill 命令与 globalSkills 同名 → 去重（pi 源优先），不重复显示
  // [W3] 生产 landing 态无 pi 命令源（公共 session 已移除）；本用例显式 dispatch pi 命令验证合并去重逻辑
  // （CommandPopover 组件本身仍支持非空 sessionId + extCmds 去重，panel 态会用到）。
  it('L10 landing pi 源 skill 与 globalSkills 同名 → 去重（1 项非 2 项，pi 源优先）', async () => {
    // pi 返回的 skill 命令：name='skill:code-review'（pi 真实格式，归一化后 /skill:code-review）
    const piCmdsWithSkill = [
      { name: 'skill:code-review', description: 'pi 扫描的 code-review', source: 'skill' },
      { name: '/goal', description: '目标管理', source: 'extension' },
    ]
    // globalSkills 也有 code-review（同名重叠）+ diagnose（独有，全局补项目级）
    const globalSkills = [
      LANDING_SKILLS[0], // code-review（与 pi 源重叠，去重）
      LANDING_SKILLS[1], // diagnose（全局独有）
    ]
    wrapper = mount(CommandPopover, {
      attachTo: document.body,
      props: { open: true, type: 'slash', variant: 'landing', sessionId: 'public-sid', query: '', globalSkills },
    })
    await flushPromises()
    const msg = {
      type: 'session.commands',
      payload: { sessionId: 'public-sid', commands: piCmdsWithSkill },
    } as ServerMessage<'session.commands'>
    events.dispatchSession('public-sid', msg)
    await flushPromises()
    await nextTick()

    const btns = bodyItemButtons()
    // pi 源 2 项（skill:code-review + /goal）+ globalSkills 独有 1 项（diagnose）= 3 项
    // code-review 不重复（pi 源优先，globalSkills 的被去重掉）
    expect(btns).toHaveLength(3)
    // code-review 只出现一次（去重验证）
    const codeReviewCount = btns.filter((b) => b.textContent?.includes('code-review')).length
    expect(codeReviewCount).toBe(1)
    // diagnose 在列（globalSkills 独有项保留）
    expect(btns.some((b) => b.textContent?.includes('diagnose'))).toBe(true)
  })

  // L11 [R3 fix]：landing + sessionId=undefined（W3 后常态：composerSid 为 null）→ 仅显 globalSkills 不崩溃
  it('L11 landing + sessionId=undefined → 仅显 globalSkills（不加载 pi 命令，不崩溃）', async () => {
    // [W3] 公共 session 已移除，landing composerSid 恒为 null（Landing.vue 不再有 publicSessionId fallback）
    wrapper = mount(CommandPopover, {
      attachTo: document.body,
      props: { open: true, type: 'slash', variant: 'landing', sessionId: undefined, query: '', globalSkills: LANDING_SKILLS },
    })
    await flushPromises()
    await nextTick()

    const btns = bodyItemButtons()
    // 无 pi 命令源，只显 7 条 globalSkills（extCmds 为空，全部 skills 都是「独有」不过滤）
    expect(btns).toHaveLength(7)
    expect(btns.some((b) => b.textContent?.includes('code-review'))).toBe(true)
    // 无 compact（landing 态）
    expect(btns.some((b) => b.textContent?.includes('compact'))).toBe(false)
  })

  // L8:回归防护 — 浮层宽度严格对齐 composer-box（w=anchor-width），不溢出。
  // [HISTORICAL] 事故：原 min-w + max-w-[820px] 让浮层可扩展到 >composer 宽度（slash 命令
  // 提示词列撑宽），landing 720px composer 时浮层右边缘溢出 ~70px。改 w-[anchor-width] 固定。
  // happy-dom 无布局，仅断言 class 含 w-[var(--reka-popper-anchor-width)]（宽度对齐 SSOT）。
  // 真实布局验证靠 CDP 实测（width/left/right 三项 match）。
  it('L8 PopoverContent class 含 w-[anchor-width]（固定宽度对齐 composer-box，不溢出）', async () => {
    await mountLanding('')
    const content = document.body.querySelector('[data-side]')
    expect(content).toBeTruthy()
    // 关键：w-[var(--reka-popper-anchor-width)] 让浮层宽度=composer-box 宽度
    expect(content!.className).toContain('w-[var(--reka-popper-anchor-width)]')
    // 不应再含旧的 min-w（min-w 允许内容撑宽导致溢出）
    expect(content!.className).not.toContain('min-w-[var(--reka-popper-anchor-width)]')
    // max-w 兜底防视口溢出（非旧的 820px 固定值）
    expect(content!.className).toContain('max-w-[calc(100vw-16px)]')
  })

  // ── W4：landing 两源合并（globalSkills + projectSkills）──
  // landing 分支合并两源：globalSkills(全局 skillRegistry) ∪ projectSkills(当前 cwd 项目 skill，
  // useProjectSkills 按 cwd key 缓存)。按归一化 name 去重。[W3] 已移除公共 session pi 命令源。
  it('L12 landing + projectSkills prop → 两源合并（全局 skills + 项目 skills）', async () => {
    // 全局 skill（globalSkills prop）2 条
    const globalSkills: SkillInfo[] = [
      { id: 'sk-global-1', name: 'global-skill-1', description: 'g1', enabled: true, source: 'pi', effective: true },
      { id: 'sk-global-2', name: 'global-skill-2', description: 'g2', enabled: true, source: 'pi', effective: true },
    ]
    // 项目 skill（projectSkills prop）2 条
    const projectSkills: SkillInfo[] = [
      { id: 'sk-proj-1', name: 'proj-skill-1', description: 'p1', enabled: true, source: 'agents', effective: true },
      { id: 'sk-proj-2', name: 'proj-skill-2', description: 'p2', enabled: true, source: 'agents', effective: true },
    ]
    wrapper = mount(CommandPopover, {
      attachTo: document.body,
      props: { open: true, type: 'slash', variant: 'landing', sessionId: 'public-sid', query: '', globalSkills, projectSkills },
    })
    await flushPromises()
    await nextTick()

    const btns = bodyItemButtons()
    // 2 全局 + 2 项目 = 4 项（无 publicSession pi 命令推送，extCmds 空）
    expect(btns).toHaveLength(4)
    expect(btns.some((b) => b.textContent?.includes('global-skill-1'))).toBe(true)
    expect(btns.some((b) => b.textContent?.includes('proj-skill-1'))).toBe(true)
  })

  it('L13 landing 三源去重——全局 skill 与项目 skill 同名 → 去重 1 项（全局优先）', async () => {
    // 全局和项目都有同名 skill（模拟全局 ~/.agents/skills 与项目 .agents/skills 重叠场景）
    const overlap = { id: 'sk-overlap', name: 'overlap-skill', description: 'overlap', enabled: true, source: 'agents', effective: true }
    const globalSkills: SkillInfo[] = [overlap, { id: 'sk-g', name: 'global-only', description: 'g', enabled: true, source: 'pi', effective: true }]
    const projectSkills: SkillInfo[] = [overlap, { id: 'sk-p', name: 'proj-only', description: 'p', enabled: true, source: 'agents', effective: true }]

    wrapper = mount(CommandPopover, {
      attachTo: document.body,
      props: { open: true, type: 'slash', variant: 'landing', sessionId: 'public-sid', query: '', globalSkills, projectSkills },
    })
    await flushPromises()
    await nextTick()

    const btns = bodyItemButtons()
    // overlap-skill 去重 1 项 + global-only 1 项 + proj-only 1 项 = 3 项（非 4 项）
    expect(btns).toHaveLength(3)
    const overlapCount = btns.filter((b) => b.textContent?.includes('overlap-skill')).length
    expect(overlapCount).toBe(1)
  })

  it('L14 landing projectSkills 默认空（未传 prop）→ 仅全局 skill，行为与修复前一致', async () => {
    // 不传 projectSkills（默认空），globalSkills 传 7 条
    wrapper = mount(CommandPopover, {
      attachTo: document.body,
      props: { open: true, type: 'slash', variant: 'landing', sessionId: 'public-sid', query: '', globalSkills: LANDING_SKILLS },
    })
    await flushPromises()
    await nextTick()

    const btns = bodyItemButtons()
    // 仅 7 条全局 skill（projectSkills 空）
    expect(btns).toHaveLength(7)
  })

  // ── W4：__ 前缀命令过滤（host 内部命令不显示）──
  // skill name 以 __ 开头的命令不显示（内部触发命令）。
  it('L15 landing globalSkills 含 __ 前缀 skill → 不显示（W5 内部命令过滤）', async () => {
    const skillsWithInternal: SkillInfo[] = [
      { id: 'sk-normal', name: 'normal-skill', description: '正常', enabled: true, source: 'agents', effective: true },
      { id: 'sk-internal', name: '__taiji_reload', description: '内部命令', enabled: true, source: 'agents', effective: true },
    ]
    await mountLanding('', skillsWithInternal)
    const btns = bodyItemButtons()
    // 仅 1 项（normal-skill），__taiji_reload 被过滤
    expect(btns).toHaveLength(1)
    expect(btns[0].textContent).toContain('normal-skill')
    expect(btns.some((b) => b.textContent?.includes('foo_reload'))).toBe(false)
  })

  it('L16 panel 态 pi 命令含 /__ 前缀 → 不显示（panel 态同样过滤内部命令）', async () => {
    wrapper = mount(CommandPopover, {
      attachTo: document.body,
      props: { open: true, type: 'slash', variant: 'panel', sessionId: 's1', query: '' },
    })
    await flushPromises()
    // pi 返回的命令含 /__taiji_reload（带 / 前缀）+ 正常命令
    const msg = {
      type: 'session.commands',
      payload: {
        sessionId: 's1',
        commands: [
          { name: '/__taiji_reload', description: '内部 reload', source: 'extension' },
          { name: '/commit', description: '提交', source: 'extension' },
        ],
      },
    } as ServerMessage<'session.commands'>
    events.dispatchSession('s1', msg)
    await flushPromises()
    await nextTick()

    const btns = bodyItemButtons()
    // compact + commit = 2 项，/__taiji_reload 被过滤
    expect(btns).toHaveLength(2)
    expect(btns.some((b) => b.textContent?.includes('foo_reload'))).toBe(false)
    expect(btns.some((b) => b.textContent?.includes('compact'))).toBe(true)
    expect(btns.some((b) => b.textContent?.includes('commit'))).toBe(true)
  })

  // ── W4 AC-8：反向断言——slash 命令源不读 settingsStore.skills（FR-5）──
  // 验证：settingsStore.skills 有值，但 globalSkills prop 为空时，landing 不显示任何 skill。
  // 这证明 CommandPopover 已与 settingsStore.skills 解耦（W4 前 landing 读 settingsStore.skills）。
  it('L18: CommandPopover.handleKeydown IME 检查（composingRef + isComposing 双保险，设计 D2）', async () => {
    // [HISTORICAL] 本用例原断言「handleKeydown 不检查 isComposing（检查职责在 Composer 层）」——
    // composer-chip-insertion-semantics 设计 D2（r1/r2 修订）将 IME 检查移入浮层 Enter/Tab 分支：
    // window capture 入口无 Composer 层前置检查，不检查会劫持 IME 组合确认 Enter 为「选中浮层
    // 第一项」。检查 = composingRef（compositionstart/end 维护）+ e.isComposing 双保险。
    // Composer 层 isComposing 检查仍保留（composer-keydown.ts，纵深防御）。时序锁集成用例见
    // composer-keydown.test.ts「D2 时序锁」。
    await mountLanding('co')
    const btns = bodyItemButtons()
    expect(btns).toHaveLength(1)

    const popover = wrapper!.findComponent(CommandPopover)
    const handleKeydown = popover.vm.handleKeydown as (e: KeyboardEvent) => boolean
    expect(typeof handleKeydown).toBe('function')

    // composition 中 Enter 事件（isComposing: true）
    const imeEvent = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
    Object.defineProperty(imeEvent, 'isComposing', { value: true })

    // handleKeydown 不消费（返回 false）——IME 检查生效，事件放行给 target 做候选词确认
    const result = handleKeydown(imeEvent)
    expect(result).toBe(false)
    // select 未被 emit（组合中 Enter 绝不选中浮层候选）
    expect(wrapper!.emitted('select')).toBeFalsy()
  })

  it('L17 AC-8 反向：settingsStore.skills 有值但 globalSkills prop 空 → landing 不显示 skill（FR-5 解耦）', async () => {
    // settingsStore.skills 注入 7 条（模拟修复前的数据源）
    getSettingsStore().skills.value = LANDING_SKILLS
    // globalSkills prop 不传（空）
    await mountLanding('', [])
    const btns = bodyItemButtons()
    // 0 项——证明 settingsStore.skills 的 7 条未被读取（FR-5：不走 settingsStore.skills）
    expect(btns).toHaveLength(0)
  })

  // ── Wave3 TC5：渲染 gate（MANDATORY，架构约定 #5-8）──
  // 端到端验证：广播 config.skillCacheInvalidated {scope:'global'} → useGlobalSkills 订阅回调
  // → loadGlobal(true) force 重新拉取 → globalSkills ref 刷新 → CommandPopover DOM 反映新 skill 列表。
  // 用 wrapper 组件调 useGlobalSkills() 拿响应式 globalSkills，传给 CommandPopover（模拟 Composer.vue 的接线）。
  it('TC5: 广播 global scope 失效信号 → landing slash 浮层 DOM 反映 globalSkills 刷新', async () => {
    // lazy import：避免顶层 import 触发 useProjectSkills 模块加载（其顶层订阅依赖 mock 已挂载，OK）。
    const { useGlobalSkills } = await import('@/composables/features/settings/useProjectSkills')
    // [C3] 打 seam：getGlobalSkills 可控 mock + onSkillCacheInvalidated 桥真实 events
    //（单源 = helpers/settings-transport-stub 的 makeSkillsReloadTransportStub，语义同
    // 本文件 '@/api' mock 工厂——广播端到端触达 useGlobalSkills 订阅）。
    provideSettingsTransport(await makeSkillsReloadTransportStub(getGlobalSkillsMock))

    const SKILL_1: SkillInfo[] = [
      { id: 'sk-1', name: 'skill1', description: 'one', enabled: true, source: 'agents', effective: true },
    ]
    const SKILL_1_2: SkillInfo[] = [
      { id: 'sk-1', name: 'skill1', description: 'one', enabled: true, source: 'agents', effective: true },
      { id: 'sk-2', name: 'skill2', description: 'two', enabled: true, source: 'agents', effective: true },
    ]

    // wrapper：模拟 Composer.vue 接线（useGlobalSkills → CommandPopover globalSkills prop）
    const Harness = defineComponent({
      name: 'GlobalSkillsHarness',
      setup() {
        const { globalSkills } = useGlobalSkills()
        return () =>
          h(CommandPopover, {
            open: true,
            type: 'slash',
            variant: 'landing',
            sessionId: undefined,
            query: '',
            globalSkills: globalSkills.value,
          })
      },
    })

    // 初始 getGlobalSkills resolve([skill1]) → 渲染 1 项 /skill:skill1
    getGlobalSkillsMock.mockResolvedValue(SKILL_1)
    wrapper = mount(Harness, { attachTo: document.body })
    await flushPromises()
    await nextTick()

    await vi.waitFor(() => {
      const btns = bodyItemButtons()
      expect(btns).toHaveLength(1)
      expect(btns[0].textContent).toContain('skill1')
    })

    // mock 改返回 [skill1, skill2]（模拟 runtime 重扫 globalCache 后缓存更新）
    getGlobalSkillsMock.mockResolvedValue(SKILL_1_2)
    // 派发 global scope 失效信号 → loadGlobal(true) force 重新拉取 → globalSkills ref 刷新 → DOM 更新
    events.dispatchGlobal({
      type: 'config.skillCacheInvalidated',
      payload: { scope: 'global' },
    } as ServerMessage<'config.skillCacheInvalidated'>)

    await vi.waitFor(() => {
      const btns = bodyItemButtons()
      expect(btns).toHaveLength(2)
      expect(btns.some((b) => b.textContent?.includes('skill1'))).toBe(true)
      expect(btns.some((b) => b.textContent?.includes('skill2'))).toBe(true)
    })
  })
})

// ══════════ 节 2/3 — 来源: model-thinking-aggregate.test.ts ══════════

/**
 * ModelThinkingAggregate 测试 —— W3a 模型+思考聚合按钮（D2：click 出弹层，hover 行即切换）。
 *
 * 三视角：
 * - 使用者黑盒：click 触发器出弹层（body portal 内可见模型列表 + 思考档位行），
 *   hover / click 行为后的弹层开合状态以用户可见 DOM 断言；
 * - 观察者形态：emit 面（selectModel 同形 payload / selectThinking 发 runtime 实际值）；
 * - 构建者白盒：同值 hover 不 emit（去抖）——空 emit 断言（not.toBeDefined）。
 *
 * 数据注入：setActivePinia + 直赋 getSettingsStore().models（与 model-select-popover 节同模式）。
 */
const TA_MODELS: ModelInfo[] = [
  { id: 'claude-4', name: 'Claude 4', providerId: 'anthropic' as ProviderId, providerName: 'Anthropic' },
  { id: 'gpt-4', name: 'GPT-4', providerId: 'openai' as ProviderId, providerName: 'OpenAI' },
]

/** 高低两档映射（max 发 xhigh，与 ThinkingLevelPopover 测试同款 fixture） */
const LEVEL_MAP = { off: 'off', high: 'high', max: 'xhigh' }

let wrapper: VueWrapper | null = null

function mountAggregate(props: Record<string, unknown> = {}): VueWrapper {
  wrapper = mount(ModelThinkingAggregate, {
    props: {
      selected: 'anthropic/claude-4',
      level: 'high',
      levelMap: LEVEL_MAP,
      supportedLevels: ['off', 'high', 'max'],
      ...props,
    },
    attachTo: document.body,
  })
  return wrapper
}

/** click 触发器开弹层（reka Popover click 语义；打开后内容进 body portal） */
async function openAggregate(w: VueWrapper): Promise<void> {
  await w.find('[data-testid="composer-model-thinking-aggregate"]').trigger('click')
  await flushPromises()
}

function pickerPanel(): Element | null {
  return document.body.querySelector('[data-testid="model-picker-panel"]')
}

/** 对 portal 内元素派发 pointerenter（teleport 到 body，wrapper.find 够不到） */
async function hover(el: Element): Promise<void> {
  el.dispatchEvent(new Event('pointerenter'))
  await nextTick()
}

/** 对 portal 内元素派发 click（bubbles 模拟真实指针点击） */
async function click(el: Element): Promise<void> {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await flushPromises()
}

/** portal 内直查弹层行并断言在场（teleport 到 body，wrapper.find 够不到；hover/click 用例公共开场） */
function pickerRow(testid: string): Element {
  const row = document.body.querySelector(`[data-testid="${testid}"]`)
  expect(row).not.toBeNull()
  return row!
}

/** 断言事件已 emit 且取回首条 payload（emitted[0][0]；已发 N 条的追加断言由调用方自写） */
function firstEmit(w: VueWrapper, event: string): unknown {
  const emitted = w.emitted(event)
  expect(emitted).toBeTruthy()
  return emitted![0][0]
}

/** 节级 beforeEach（原文件级下沉：models 注入必须晚于文件级 landing beforeEach 的 pinia 重建）。 */
function taBeforeEach() {
  setActivePinia(createPinia())
  provideSettingsStore(createSettingsStore())
  getSettingsStore().models.value = TA_MODELS
  document.body.innerHTML = ''
  wrapper = null
}

describe('触发器与弹层（使用者黑盒）', () => {
  beforeEach(taBeforeEach)

  it('触发器：单图标 Boxes 按钮，title「模型 · 思考等级」（用户可见 DOM）', () => {
    const w = mountAggregate()
    const btn = w.find('[data-testid="composer-model-thinking-aggregate"]')
    expect(btn.exists()).toBe(true)
    expect(btn.attributes('title')).toBe('模型 · 思考等级')
    expect(btn.findAll('svg')).toHaveLength(1)
  })

  it('click 触发器 → 弹层打开：模型列表 + 思考档位行同屏可见', async () => {
    const w = mountAggregate()
    await openAggregate(w)

    // 模型段（用户可见 DOM）
    expect(pickerPanel()).not.toBeNull()
    expect(document.body.textContent ?? '').toContain('Claude 4')
    expect(document.body.textContent ?? '').toContain('GPT-4')
    // 思考段：三档行（off/high/max）+ 当前档（high）带选中态文案可见
    expect(document.body.querySelector('[data-testid="thinking-level-row-off"]')).not.toBeNull()
    expect(document.body.querySelector('[data-testid="thinking-level-row-high"]')).not.toBeNull()
    expect(document.body.querySelector('[data-testid="thinking-level-row-max"]')).not.toBeNull()
  })
})

describe('hover 切换（D2：hover 即切，不关弹层；同值不 emit）', () => {
  beforeEach(taBeforeEach)

  it('hover 模型行（值有变化）→ emit selectModel（同形 payload），弹层保持打开', async () => {
    const w = mountAggregate()
    await openAggregate(w)

    const gptRow = pickerRow('model-picker-item-gpt-4')
    await hover(gptRow)

    expect(firstEmit(w, 'selectModel')).toEqual({ modelId: 'gpt-4', provider: 'openai' })
    // hover 切换不关弹层（用户还要继续瞄别的行）
    expect(pickerPanel()).not.toBeNull()
  })

  it('hover 当前选中模型行（裸 id 同值）→ 不 emit（天然去抖）', async () => {
    const w = mountAggregate()
    await openAggregate(w)

    const claudeRow = document.body.querySelector('[data-testid="model-picker-item-claude-4"]')
    expect(claudeRow).not.toBeNull()
    await hover(claudeRow!)

    expect(w.emitted('selectModel')).toBeUndefined()
    expect(pickerPanel()).not.toBeNull()
  })

  it('hover 思考行（档位有变化）→ emit selectThinking（map 映射后的实际值 xhigh），弹层保持打开', async () => {
    const w = mountAggregate()
    await openAggregate(w)

    await hover(pickerRow('thinking-level-row-max'))

    expect(firstEmit(w, 'selectThinking')).toBe('xhigh')
    expect(pickerPanel()).not.toBeNull()
  })

  it('hover 当前思考档行（同值）→ 不 emit（天然去抖）', async () => {
    const w = mountAggregate()
    await openAggregate(w)

    const highRow = document.body.querySelector('[data-testid="thinking-level-row-high"]')
    expect(highRow).not.toBeNull()
    await hover(highRow!)

    expect(w.emitted('selectThinking')).toBeUndefined()
  })

  it('hover 启动切换后同目标 click 幂等：只发一条 selectModel（pending 去重）', async () => {
    const w = mountAggregate()
    await openAggregate(w)

    // hover 已 emit 启动切换（pending = gpt-4），随后指针落定同目标的 click 不得再发第二条 RPC
    const gptRow = pickerRow('model-picker-item-gpt-4')
    await hover(gptRow)
    await click(gptRow)

    expect(w.emitted('selectModel')).toHaveLength(1)
    expect(firstEmit(w, 'selectModel')).toEqual({ modelId: 'gpt-4', provider: 'openai' })
  })

  it('switching=true（U4 单飞锁）→ hover/click 均不 emit，click 仅关弹层', async () => {
    const w = mountAggregate({ switching: true })
    await openAggregate(w)

    const gptRow = document.body.querySelector('[data-testid="model-picker-item-gpt-4"]')
    const maxRow = document.body.querySelector('[data-testid="thinking-level-row-max"]')
    expect(gptRow).not.toBeNull()
    expect(maxRow).not.toBeNull()

    // 切换中：hover 模型行 / 思考行均不触发 emit
    await hover(gptRow!)
    await hover(maxRow!)
    expect(w.emitted('selectModel')).toBeUndefined()
    expect(w.emitted('selectThinking')).toBeUndefined()

    // click 同样不 emit，仅保留关浮层语义
    await click(gptRow!)
    expect(w.emitted('selectModel')).toBeUndefined()
    expect(w.emitted('selectThinking')).toBeUndefined()
    expect(pickerPanel()).toBeNull()
  })
})

describe('pending 回流/终态清理（emit 去重基准复位，U4 单飞锁配套）', () => {
  beforeEach(taBeforeEach)

  it('模型 hover 启动切换后 selected 回流同目标 → pending 清除；切走后同目标可再次 emit', async () => {
    const w = mountAggregate() // selected=anthropic/claude-4
    await openAggregate(w)
    const gptRow = document.body.querySelector('[data-testid="model-picker-item-gpt-4"]')!
    await hover(gptRow) // pending=gpt-4，emit 第 1 条
    // 切换回流：runtime 确认 selected=gpt-4 → watch(selectedBare) 清 pending
    await w.setProps({ selected: 'openai/gpt-4' })
    // 用户又切回 claude-4（基准值离开 gpt-4）→ 再次 hover gpt-4 应重新 emit
    // （若 pending 未清，第二次 hover 被幂等拦截，只有 1 条）
    await w.setProps({ selected: 'anthropic/claude-4' })
    await hover(gptRow)
    const emitted = w.emitted('selectModel')
    expect(emitted).toBeTruthy()
    expect(emitted).toHaveLength(2)
    expect(emitted![1][0]).toEqual({ modelId: 'gpt-4', provider: 'openai' })
  })

  it('switching true→false 回落（切换终态）→ pending 清除；同目标可再次 emit', async () => {
    const w = mountAggregate()
    await openAggregate(w)
    const gptRow = document.body.querySelector('[data-testid="model-picker-item-gpt-4"]')!
    await hover(gptRow) // pending=gpt-4，emit 第 1 条
    await w.setProps({ switching: true })
    await w.setProps({ switching: false }) // 切换终态回落（覆盖失败/超时）→ 清 pending
    await hover(gptRow) // pending 已清 → 重新 emit（允许用户重试同目标）
    const emitted = w.emitted('selectModel')
    expect(emitted).toBeTruthy()
    expect(emitted).toHaveLength(2)
  })

  it('思考档 hover 后 level 回流同目标 → pending 清除；切走后同档位可再次 emit', async () => {
    const w = mountAggregate() // level=high
    await openAggregate(w)
    const maxRow = document.body.querySelector('[data-testid="thinking-level-row-max"]')!
    await hover(maxRow) // pendingLevelKey='max'，emit 第 1 条（实际值 xhigh）
    // 切换回流：level=xhigh → currentLevelKey 反查为 'max' → watch 清 pending
    await w.setProps({ level: 'xhigh' })
    // 基准值离开 max → 再次 hover max 应重新 emit（若 pending 未清则被幂等拦截）
    await w.setProps({ level: 'high' })
    await hover(maxRow)
    const emitted = w.emitted('selectThinking')
    expect(emitted).toBeTruthy()
    expect(emitted).toHaveLength(2)
    expect(emitted![1][0]).toBe('xhigh')
  })
})

describe('click 选中（关弹层）', () => {
  beforeEach(taBeforeEach)

  it('click 模型行 → emit selectModel 后弹层关闭', async () => {
    const w = mountAggregate()
    await openAggregate(w)

    await click(pickerRow('model-picker-item-gpt-4'))

    expect(firstEmit(w, 'selectModel')).toEqual({ modelId: 'gpt-4', provider: 'openai' })
    expect(pickerPanel()).toBeNull()
  })

  it('click 思考行 → emit selectThinking（实际值）后弹层关闭', async () => {
    const w = mountAggregate()
    await openAggregate(w)

    await click(pickerRow('thinking-level-row-max'))

    expect(firstEmit(w, 'selectThinking')).toBe('xhigh')
    expect(pickerPanel()).toBeNull()
  })
})

describe('数据范围与 ModelSelectPopover 同源（model-picker-data）', () => {
  beforeEach(taBeforeEach)

  it('enabled===false 的模型不进聚合列表（双保险过滤同源）', async () => {
    const mixed: ModelInfo[] = [
      ...TA_MODELS,
      { id: 'claude-haiku', name: 'Claude Haiku', providerId: 'anthropic' as ProviderId, providerName: 'Anthropic', enabled: false },
    ]
    getSettingsStore().models.value = mixed

    const w = mountAggregate()
    await openAggregate(w)

    expect(document.body.querySelector('[data-testid="model-picker-item-claude-4"]')).not.toBeNull()
    expect(document.body.querySelector('[data-testid="model-picker-item-claude-haiku"]')).toBeNull()
  })

  it('selected 带 provider 前缀时按裸 id 高亮（复合串拆段，同值判定同源）', async () => {
    // selected 已是 'anthropic/claude-4'（fixture 默认）——hover claude-4 不 emit 即反证裸 id 对齐；
    // 此处补 DOM 侧选中态断言（选中指示 = 行尾对勾显隐，demo R3：弹层行无底无框）
    const w = mountAggregate()
    await openAggregate(w)

    const claudeRow = document.body.querySelector('[data-testid="model-picker-item-claude-4"]')
    // 选中行无底/框选中态类（demo R3：弹层行不进选中范式），行尾对勾显形（opacity-100）——
    // 非选中行对勾隐藏——裸 id 反查对齐的 DOM 侧证
    expect(claudeRow?.className ?? '').not.toContain('shadow-[inset')
    expect(claudeRow?.className ?? '').not.toContain('bg-bg-elevated')
    const claudeCheck = claudeRow?.querySelector('svg')
    expect(claudeCheck?.getAttribute('class') ?? '').toContain('opacity-100')
    const gptCheck = document.body.querySelector('[data-testid="model-picker-item-gpt-4"]')?.querySelector('svg')
    expect(gptCheck?.getAttribute('class') ?? '').not.toContain('opacity-100')
  })
})


// ══════════ 节 3/3 — 来源: model-select-popover.test.ts ══════════

/**
 * ModelSelectPopover 单测（数据源 store 化 + 竞态回归）。
 *
 * 锁定两条主轴：
 * 1. 纯受控：去掉本地 selected ref + watch（旧实现 onSelect 后本地态被旧 props 拉回，UI 闪退）
 *    - currentName 解析复合串 "provider/modelId" → 裸 modelId → 查 ModelInfo.name
 *    - props.selected 变化时触发器文案跟随更新，不依赖本地副本
 * 2. 数据源 store 化（2026-07-01 竞态修复）：模型列表不再组件内 onMounted 订阅 onModels，
 *    改从 settingsStore.models 常驻订阅读取。旧实现随 Composer v-if 重新挂载会错过
 *    sendInitialState 一次性推送 → 列表空；新实现读 store，store 已有数据则立即可见。
 *
 * 数据注入：setActivePinia(createPinia()) 后直接赋 getSettingsStore().models（不 mock store，
 * 与 landing 节同模式——验证组件真实读 store）。
 */
const MSP_MODELS: ModelInfo[] = [
  { id: 'claude-4', name: 'Claude 4', providerId: 'anthropic', providerName: 'Anthropic' },
  { id: 'gpt-4', name: 'GPT-4', providerId: 'openai', providerName: 'OpenAI' },
] as unknown as ModelInfo[]


describe('ModelSelectPopover 纯受控 + store 数据源', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    provideSettingsStore(createSettingsStore())
    document.body.innerHTML = ''
  })

  it('U18: props.selected 为复合串时，触发器显示对应模型名', async () => {
    getSettingsStore().models.value = MSP_MODELS
    const wrapper = mount(ModelSelectPopover, {
      props: { selected: 'anthropic/claude-4' },
    })
    await wrapper.vm.$nextTick()
    // 触发器文案含模型名（title="切换模型" 的 Button 内 span）
    expect(wrapper.text()).toContain('Claude 4')
  })

  it('U18b: props.selected 变化时，触发器文案跟随更新（纯受控，不依赖本地副本）', async () => {
    getSettingsStore().models.value = MSP_MODELS
    const wrapper = mount(ModelSelectPopover, {
      props: { selected: 'anthropic/claude-4' },
    })
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('Claude 4')

    // 父组件更新 selected（模拟 Composer 切换回执生效后的 props 回传）
    await wrapper.setProps({ selected: 'openai/gpt-4' })
    expect(wrapper.text()).toContain('GPT-4')
    expect(wrapper.text()).not.toContain('Claude 4')
  })

  it('U19: onSelect 后 emit modelId+provider，不依赖本地态回写', async () => {
    getSettingsStore().models.value = MSP_MODELS
    const wrapper = mount(ModelSelectPopover, {
      props: { selected: 'anthropic/claude-4' },
    })
    await wrapper.vm.$nextTick()

    // 直接调组件实例方法（绕过 Popover 交互）
    ;(wrapper.vm as unknown as { onSelect: (id: string, p: string) => void }).onSelect('gpt-4', 'openai')
    const emitted = wrapper.emitted('select')
    expect(emitted).toBeTruthy()
    // emitted('select')[0] = 第一次 emit 的参数数组，[0] = payload 对象
    expect(emitted![0][0]).toEqual({ modelId: 'gpt-4', provider: 'openai' })
  })

  it('U15: props.selected 为空串时，触发器显示占位文案（…）而非空串', async () => {
    getSettingsStore().models.value = MSP_MODELS
    const wrapper = mount(ModelSelectPopover, {
      props: { selected: '' },
    })
    await wrapper.vm.$nextTick()
    // D3：已建 session modelId 为空 → 显示占位「…」，不兜底全局默认
    expect(wrapper.find('[title="切换模型"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('…')
  })

  it('U9: store 已有数据时 mount，触发器立即显示模型名（竞态回归——模拟 v-if 翻转后重新 mount，无任何推送）', async () => {
    // 旧实现：组件内 onMounted 订阅 onModels，重新挂载会错过 sendInitialState 一次性推送 → 列表空。
    // 新实现：读 settingsStore.models，store 已有数据则立即可见。此处不触发任何推送。
    getSettingsStore().models.value = MSP_MODELS
    const wrapper = mount(ModelSelectPopover, {
      props: { selected: 'anthropic/claude-4' },
    })
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('Claude 4')
  })

  it('U10: 分组渲染——2 个 provider 各 1 model，groups 有 2 组', async () => {
    getSettingsStore().models.value = MSP_MODELS
    const wrapper = mount(ModelSelectPopover, {
      props: { selected: 'anthropic/claude-4' },
    })
    await wrapper.vm.$nextTick()
    const groups = (wrapper.vm as unknown as { groups: { provider: string; providerId: string; models: ModelInfo[] }[] }).groups
    expect(groups).toHaveLength(MSP_MODELS.length)
    // 两个 provider 名都出现
    const providers = groups.map((g) => g.provider)
    expect(providers).toContain('Anthropic')
    expect(providers).toContain('OpenAI')
  })

  it('U11: 搜索过滤——输入 "cla" 仅渲染 Claude 相关（经 ModelPickerPanel 搜索框）', async () => {
    getSettingsStore().models.value = MSP_MODELS
    const wrapper = mount(ModelSelectPopover, {
      props: { selected: 'anthropic/claude-4' },
    })
    await wrapper.vm.$nextTick()
    // 打开 popover（内容 teleport 到 body）
    ;(wrapper.vm as unknown as { open: boolean }).open = true
    await wrapper.vm.$nextTick()
    // 搜索框由抽出的 ModelPickerPanel 提供（用户可见 DOM 断言）
    const search = document.body.querySelector('[data-testid="model-picker-search"]') as HTMLInputElement | null
    expect(search).not.toBeNull()
    search!.value = 'cla'
    search!.dispatchEvent(new Event('input', { bubbles: true }))
    await wrapper.vm.$nextTick()
    const bodyText = document.body.textContent ?? ''
    expect(bodyText).toContain('Claude 4')
    expect(bodyText).not.toContain('GPT-4')
  })

  it('U12: store 空时渲染引导空态（P2：模型池为空 → 引导导入凭据/配置，区别于搜索无结果）', async () => {
    getSettingsStore().models.value = []
    const wrapper = mount(ModelSelectPopover, {
      props: { selected: '' },
    })
    await wrapper.vm.$nextTick()
    const groups = (wrapper.vm as unknown as { groups: unknown[] }).groups
    expect(groups).toHaveLength(0)
    // groups.length===0 且模型池为空 → PopoverContent 内渲染「暂无可用模型」引导空态。
    // reka-ui PopoverContent teleport 到 body：打开 popover 后查 body 文案。
    ;(wrapper.vm as unknown as { open: boolean }).open = true
    await wrapper.vm.$nextTick()
    expect(document.body.textContent).toContain('暂无可用模型，请先在设置中导入凭据或配置供应商')
    expect(document.body.textContent).not.toContain('无匹配模型')
  })

  it('U6: enabled===false 的 model 不出现在分组列表（runtime aggregateModels 已过滤，前端兜底）', async () => {
    // 双保险：runtime aggregateModels 已过滤 enabled===false，但 ModelSelectPopover 直读
    // settingsStore.models（与 providers 同源广播），若某次广播未过滤则会泄漏禁用模型到切换器。
    // 故前端在 groups computed 内也过滤 enabled===false。
    const mixed: ModelInfo[] = [
      { id: 'claude-4', name: 'Claude 4', providerId: 'anthropic', providerName: 'Anthropic', enabled: true },
      { id: 'claude-haiku', name: 'Claude Haiku', providerId: 'anthropic', providerName: 'Anthropic', enabled: false },
      { id: 'gpt-4', name: 'GPT-4', providerId: 'openai', providerName: 'OpenAI', enabled: true },
    ] as unknown as ModelInfo[]
    getSettingsStore().models.value = mixed
    const wrapper = mount(ModelSelectPopover, {
      props: { selected: 'anthropic/claude-4' },
    })
    await wrapper.vm.$nextTick()
    const groups = (wrapper.vm as unknown as { groups: { provider: string; models: ModelInfo[] }[] }).groups
    const allIds = groups.flatMap((g) => g.models.map((m) => m.id))
    expect(allIds).toContain('claude-4')
    expect(allIds).toContain('gpt-4')
    // enabled===false 的 claude-haiku 被过滤
    expect(allIds).not.toContain('claude-haiku')
  })

  it('S4: 默认触发器模型名不带 truncate/max-w 截断 class（非聚合态恒完整，两态规格）', async () => {
    // 三步聚合 S4：模型名只有「完整展示 / 聚合按钮」两态——展开态 DOM 不得携带任何截断 class；
    // 名字过长由 fit 实测回路升级到聚合按钮，而非在展开态内省略（验收判据 1，2026-09-25）。
    getSettingsStore().models.value = MSP_MODELS
    const wrapper = mount(ModelSelectPopover, {
      props: { selected: 'anthropic/claude-4' },
    })
    await wrapper.vm.$nextTick()
    const trigger = wrapper.find('[title="切换模型"]')
    expect(trigger.exists()).toBe(true)
    expect(trigger.text()).toContain('Claude 4')
    const nameSpan = trigger.find('span')
    expect(nameSpan.exists()).toBe(true)
    expect(nameSpan.classes()).not.toContain('truncate')
    expect(trigger.html()).not.toContain('max-w-[')
  })
})
