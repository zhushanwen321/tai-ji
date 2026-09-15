/**
 * command-popover-symbols 单测（增量覆盖 gate）+ open-fetch file 路 cwd 通道（D2/D3）。
 *
 * 测试框架：vitest（禁 node:test）。
 * 运行命令：cd packages/renderer && pnpm vitest run src/__tests__/panel/command-popover-symbols-format-age.test.ts
 *
 * - formatAge 分档全覆盖：<1m 'now' / <1h 'Nm' / <1d 'Nh' / >=1d 'Nd' 封顶 + 未来时间钳 0；
 *   now 显式传参，不依赖真实当前时间。
 * - buildSessionCandidates（D1 删 hasSessionId 参）：landing/panel 统一「有数据就列」——
 *   空 sessions → []；有数据不过滤 landing/panel 区别（D7 口径不变：hidden 排除 + 子串过滤 + 降序）。
 * - buildSubagentCandidates：hasSessionId 参数保留（@ landing 空语义，G3/A5 护栏）。
 * - open-fetch file 路（mount）：landing 无 sid 有 cwd 边沿拉、无 cwd 不拉、panel 有 sid 不拉、
 *   1s 节流、拉取失败（session cwd 已删 runtime not_found）降级空候选。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import type { FileNode, SessionSummary, SubagentRecord } from '@taiji/shared'

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

import CommandPopover from '@/components/panel/CommandPopover.vue'
import { formatAge, skillDisplayName, buildSlashCandidates, buildSessionCandidates, buildSubagentCandidates } from '@/components/panel/command-popover-symbols'

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
  { id: 'sess-alpha', label: 'alpha 设计讨论', cwd: '/p/a', status: 'idle', lastActiveAt: NOW - 60_000, modelId: 'm', tokenCount: 0 },
  { id: 'sess-beta', label: 'beta review', cwd: '/p/b', status: 'idle', lastActiveAt: NOW - 3 * 3_600_000, modelId: 'm', tokenCount: 0 },
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

  it('hidden 排除 + label/id 子串过滤口径维持（删参仅删门，非删过滤）', () => {
    const withHidden: SessionSummary[] = [...SESSIONS, { ...SESSIONS[0], id: 'sess-h', label: 'hidden one', hidden: true }]
    expect(buildSessionCandidates(withHidden, '', NOW)).toHaveLength(2)
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

/** body 内浮层候选行（PopoverContent teleport 到 body，v-for 渲染为 .cmd-row div） */
function bodyRows(): HTMLElement[] {
  return Array.from(document.body.querySelectorAll('.cmd-row'))
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

  it('1s 节流：窗口内关→开不重拉（模式对齐 slash/subagent 路）', async () => {
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
    // 关→开（1s 窗口内）：节流命中，不重拉
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
