/**
 * ArchiveSummaryView 组件测试（session-archive 设计 D11，u-renderer-summary）。
 *
 * 覆盖（验收条款逐项）：
 * - 双 tab 切换：默认用户摘要流 → 点 agent 引用视图切 mono 预检视图（tablist a11y 范式）
 * - turn 无文本占位：agent null → 「（此 turn 以工具调用结束……」占位，非 null turn 正常渲染
 * - 纯图片占位：user 空串 → 气泡内「[图片/附件消息]」
 * - staging 全占位：全区「摘要生成中」，tab/摘要流不渲染；banner 压缩信息显示「压缩中」
 * - 已归档 pill 与压缩信息渲染：pill 文案 + `12.4 MB → 2.5 MB · -79%` meta
 * - 恢复钮 emit restore；agent 引用视图正文 = session_read 返回形态（D7 字面）
 *
 * 挂载为纯展示组件（无 pinia / 无 ChatViewDeps 依赖）；i18n 经全局 setup mock
 * （vitest-i18n-setup.ts，zh-CN 直读）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/components/archive-summary-view.test.ts
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import type { ArchiveSummary } from '@taiji/shared'
import ArchiveSummaryView from '@/components/archive/ArchiveSummaryView.vue'

/** 构造 archived 态归档条目（rawBytes/compressedBytes 取 MB 换算干净值）。 */
function makeArchived(overrides: Partial<Extract<ArchiveSummary, { status: 'archived' }>> = {}): ArchiveSummary {
  return {
    sessionId: 'sess-arch-1',
    name: 'v0.10 renderer 重构',
    originalFile: '2026-10-20T10-00-00_a1b2c3d4.jsonl',
    cwd: '/Users/demo/proj',
    archivedAt: '2026-10-20T12:34:56.789Z',
    rawBytes: 12.4 * 1024 * 1024,
    status: 'archived',
    codec: 'zstd-3',
    compressedBytes: 2.5 * 1024 * 1024,
    sha256: 'a'.repeat(64),
    summary: {
      turns: [
        { user: 'v0.10 的 renderer 重构开始，先出分层方案。', agent: '六层分层：Shell / Workspace / …' },
        { user: '继续第二阶段', agent: null },
        { user: '', agent: '收到这张截图，布局如上处理。' },
      ],
    },
    projectId: 'proj-1',
    ...overrides,
  }
}

/** 构造 staging 态归档条目（summary null，无压缩产物字段）。 */
function makeStaging(): ArchiveSummary {
  return {
    sessionId: 'sess-staging-1',
    name: '压缩中的会话',
    originalFile: '2026-10-20T11-00-00_e5f6a7b8.jsonl',
    cwd: '/Users/demo/proj',
    archivedAt: '2026-10-20T12:00:00.000Z',
    rawBytes: 1024,
    status: 'staging',
    summary: null,
  }
}

function mountView(archive: ArchiveSummary, projectName?: string) {
  return mount(ArchiveSummaryView, {
    props: projectName === undefined ? { archive } : { archive, projectName },
  })
}

describe('ArchiveSummaryView · banner（已归档 pill 与压缩信息）', () => {
  it('已归档 pill + 会话名 + 原项目/压缩信息 meta 渲染（12.4 MB → 2.5 MB · -79%）', () => {
    const wrapper = mountView(makeArchived(), 'taiji')

    const pill = wrapper.find('[data-testid="archive-archived-pill"]')
    expect(pill.exists()).toBe(true)
    expect(pill.text()).toBe('已归档')

    expect(wrapper.find('[data-testid="archive-summary-name"]').text()).toBe('v0.10 renderer 重构')

    // 压缩信息：rawBytes=12.4MB compressedBytes=2.5MB → (1 - 2.5/12.4) ≈ 79.8% → -80%
    const meta = wrapper.find('[data-testid="archive-summary-meta"]').text()
    expect(meta).toContain('原项目：taiji')
    expect(meta).toContain('12.4 MB → 2.5 MB')
    expect(meta).toMatch(/-\d+%$/)
  })

  it('projectName 缺省时 banner 省略原项目段（仅压缩信息）', () => {
    const wrapper = mountView(makeArchived())
    const meta = wrapper.find('[data-testid="archive-summary-meta"]').text()
    expect(meta).not.toContain('原项目')
    expect(meta).toContain('12.4 MB → 2.5 MB')
  })

  it('name 空串（提取失败合法形态）→ 未命名会话占位', () => {
    const wrapper = mountView(makeArchived({ name: '' }))
    expect(wrapper.find('[data-testid="archive-summary-name"]').text()).toBe('未命名会话')
    // agent 引用视图头行回退 sessionId（D7 同款回退）
  })

  it('[恢复完整会话] accent 钮点击 emit restore', async () => {
    const wrapper = mountView(makeArchived())
    await wrapper.find('[data-testid="archive-restore-button"]').trigger('click')
    expect(wrapper.emitted('restore')).toHaveLength(1)
  })
})

describe('ArchiveSummaryView · 双 tab 切换', () => {
  it('默认用户摘要 tab：摘要流可见、agent 引用视图不渲染；tablist a11y 范式', () => {
    const wrapper = mountView(makeArchived())

    expect(wrapper.find('[data-testid="archive-summary-flow"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="archive-agent-reference"]').exists()).toBe(false)

    const tablist = wrapper.find('[role="tablist"]')
    expect(tablist.exists()).toBe(true)
    const tabs = wrapper.findAll('[role="tab"]')
    expect(tabs).toHaveLength(2)
    expect(tabs[0]!.attributes('aria-selected')).toBe('true')
    expect(tabs[1]!.attributes('aria-selected')).toBe('false')
    expect(tabs[0]!.text()).toBe('用户摘要')
    expect(tabs[1]!.text()).toBe('agent 引用视图')
  })

  it('点 agent 引用视图 tab → mono 预检视图替换摘要流', async () => {
    const wrapper = mountView(makeArchived())

    await wrapper.find('[data-testid="archive-summary-tab-agent"]').trigger('click')

    expect(wrapper.find('[data-testid="archive-summary-flow"]').exists()).toBe(false)
    const ref = wrapper.find('[data-testid="archive-agent-reference"]')
    expect(ref.exists()).toBe(true)
    // mono 字体类
    expect(ref.classes()).toContain('font-mono')

    const tabs = wrapper.findAll('[role="tab"]')
    expect(tabs[0]!.attributes('aria-selected')).toBe('false')
    expect(tabs[1]!.attributes('aria-selected')).toBe('true')
  })

  it('agent 引用视图正文 = session_read 返回形态（头部标注 + turns + 尾注，D7 字面）', async () => {
    const wrapper = mountView(makeArchived())
    await wrapper.find('[data-testid="archive-summary-tab-agent"]').trigger('click')

    const text = wrapper.find('[data-testid="archive-agent-reference"]').text()
    expect(text).toContain('[session-reader] session: v0.10 renderer 重构')
    expect(text).toContain('状态: 已归档 (archived) — 完整内容已压缩离线，以下仅为摘要')
    expect(text).toContain('── turn 1 ──')
    expect(text).toContain('user: v0.10 的 renderer 重构开始，先出分层方案。')
    expect(text).toContain('assistant (摘要): 六层分层：Shell / Workspace / …')
    // 纯图片 turn：user 占位；无文本 turn：agent 占位（extension 同字面）
    expect(text).toContain('user: [图片/附件消息]')
    expect(text).toContain('assistant (摘要): （此 turn 以工具调用结束，无文本回复）')
    expect(text).toContain('注: 如需完整历史，请让用户在归档列表中恢复该会话。')
  })
})

describe('ArchiveSummaryView · 摘要流占位规则', () => {
  it('turn 无 agent 文本（以工具调用结束）→ 「摘要跳过该段」占位；有文本 turn 正常渲染', () => {
    const wrapper = mountView(makeArchived())

    // turn 1：正常 agent 文本
    expect(wrapper.find('[data-testid="archive-summary-turn-0-agent-text"]').text())
      .toBe('六层分层：Shell / Workspace / …')
    // turn 2：agent null → 占位（D11 字面含「—— 摘要跳过该段」后缀）
    const placeholder = wrapper.find('[data-testid="archive-summary-turn-1-agent-placeholder"]')
    expect(placeholder.exists()).toBe(true)
    expect(placeholder.text()).toBe('（此 turn 以工具调用结束，无文本回复 —— 摘要跳过该段）')
    expect(wrapper.find('[data-testid="archive-summary-turn-1-agent-text"]').exists()).toBe(false)
    // turn 3 正常
    expect(wrapper.find('[data-testid="archive-summary-turn-2-agent-text"]').text())
      .toBe('收到这张截图，布局如上处理。')
  })

  it('纯图片/附件 user 空串 → 气泡内 [图片/附件消息] 占位；有文本 turn 渲染原文', () => {
    const wrapper = mountView(makeArchived())

    expect(wrapper.find('[data-testid="archive-summary-turn-0-user"]').text())
      .toBe('v0.10 的 renderer 重构开始，先出分层方案。')
    expect(wrapper.find('[data-testid="archive-summary-turn-2-user"]').text())
      .toBe('[图片/附件消息]')
  })

  it('用户气泡右浮（justify-end）/ agent 块左侧（Assistant · 摘要 标签 + 文本）', () => {
    const wrapper = mountView(makeArchived())

    expect(wrapper.find('[data-testid="archive-summary-turn-0-user"]').classes()).toContain('justify-end')
    const agentBlock = wrapper.find('[data-testid="archive-summary-turn-0-agent"]')
    expect(agentBlock.text()).toContain('Assistant · 摘要')
  })

  it('turns 空数组（合法簿记形态）→ 空态占位', () => {
    const wrapper = mountView(makeArchived({ summary: { turns: [] } }))
    expect(wrapper.find('[data-testid="archive-summary-empty"]').text()).toBe('（无对话记录）')
  })
})

describe('ArchiveSummaryView · staging 全占位', () => {
  it('全区「摘要生成中」占位：tablist/摘要流/引用视图均不渲染', () => {
    const wrapper = mountView(makeStaging())

    const staging = wrapper.find('[data-testid="archive-summary-staging"]')
    expect(staging.exists()).toBe(true)
    expect(staging.text()).toContain('摘要生成中')
    expect(staging.text()).toContain('后台压缩完成后自动刷新')

    expect(wrapper.find('[data-testid="archive-summary-tablist"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="archive-summary-flow"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="archive-agent-reference"]').exists()).toBe(false)
  })

  it('banner 保留（pill + 名称）且压缩信息显示「压缩中」；恢复钮仍在（staging 恢复合法，V6）', async () => {
    const wrapper = mountView(makeStaging())

    expect(wrapper.find('[data-testid="archive-archived-pill"]').text()).toBe('已归档')
    expect(wrapper.find('[data-testid="archive-summary-name"]').text()).toBe('压缩中的会话')
    expect(wrapper.find('[data-testid="archive-summary-meta"]').text()).toContain('压缩中')

    await wrapper.find('[data-testid="archive-restore-button"]').trigger('click')
    expect(wrapper.emitted('restore')).toHaveLength(1)
  })
})
