// SubagentSheet 组件级单测（remote-use-mobile-v2 §6.10 / §7.2 子代理行）。
//
// 锁定两级 stage 全语义（同 key 内部推进，§6.13）：
// - 列表态：fetchSubagents 主动拉 + 两态显示映射（running/idle/failed 三态行）+
//   displayName slug 兜底 + oversize 降级提示 + 空态 + found=false 保留数据；
// - 详情态：openDetail 拉最近执行历史（N≈8 窗口截断）+ 头部元信息行（缺省字段不渲染行）
//   + backToList；
// - 停止：running 详情态 stopSubagent → appendActionNotice + 重拉收敛；失败 → showErrorBar；
// - 直落：initialSubagentId（u-activity 进行中屏子代理行契约）在册直进详情态、不在册落列表态。
//
// mock 策略（对齐 model-sheet.test 先例）：app-runtime 部分模块级 mock——清单/历史/停止
// 三 RPC 与 appendActionNotice 替换；error-bar 的 showErrorBar 替换（断言出口而非单例槽位）。
// Sheet 内容经 reka portal 渲染到 document.body（document 查询，permission-sheet.test 同款）。
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import type { SubagentRecord } from '@taiji/shared'
import SubagentSheet from '../SubagentSheet.vue'
import { i18n } from '../../i18n'
import type { MobileSubagentHistoryMessage } from '../../shell/app-runtime'

const { fetchSubagentsMock, fetchHistoryMock, stopSubagentMock, appendNoticeMock, showErrorBarMock } =
  vi.hoisted(() => ({
    fetchSubagentsMock: vi.fn<() => Promise<{ subagents: SubagentRecord[]; oversize?: boolean; found?: boolean }>>(),
    fetchHistoryMock: vi.fn<() => Promise<MobileSubagentHistoryMessage[]>>(),
    stopSubagentMock: vi.fn<() => Promise<void>>(),
    appendNoticeMock: vi.fn<(sessionId: string, text: string) => void>(),
    showErrorBarMock: vi.fn<(text: string) => void>(),
  }))

vi.mock('../../shell/app-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../shell/app-runtime')>()
  return {
    ...actual,
    fetchSubagents: fetchSubagentsMock,
    fetchSubagentHistory: fetchHistoryMock,
    stopSubagent: stopSubagentMock,
    appendActionNotice: appendNoticeMock,
  }
})

vi.mock('../../shell/error-bar', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../shell/error-bar')>()
  return { ...actual, showErrorBar: showErrorBarMock }
})

const SID = 'sid-subagent-sheet'

function record(overrides: Partial<SubagentRecord> & { subagentId: string }): SubagentRecord {
  return {
    sessionFile: null,
    agent: 'general-purpose',
    slug: '',
    task: 'fixture task',
    status: 'idle',
    ...overrides,
  }
}

function bodyEl(testid: string): HTMLElement | null {
  return document.body.querySelector(`[data-testid="${testid}"]`)
}

function bodyText(testid: string): string {
  return bodyEl(testid)?.textContent ?? ''
}

async function mountSheet(props?: { initialSubagentId?: string }): Promise<VueWrapper> {
  const wrapper = mount(SubagentSheet, {
    props: { open: true, sessionId: SID, ...props },
    global: { plugins: [i18n] },
    attachTo: document.body,
  })
  await flushPromises()
  return wrapper
}

function historyMsg(id: string, status: string): MobileSubagentHistoryMessage {
  return { id, role: 'assistant', text: `消息 ${id}`, status }
}

beforeEach(() => {
  fetchSubagentsMock.mockReset().mockResolvedValue({ subagents: [], oversize: false, found: true })
  fetchHistoryMock.mockReset().mockResolvedValue([])
  stopSubagentMock.mockReset().mockResolvedValue(undefined)
  appendNoticeMock.mockClear()
  showErrorBarMock.mockClear()
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('SubagentSheet 列表态（§6.10 主动拉 + §7.2 两态显示映射）', () => {
  it('三态行渲染：running 状态词 / failed 附错误文本 / displayName slug 空串兜底 agent 名', async () => {
    fetchSubagentsMock.mockResolvedValue({
      subagents: [
        record({ subagentId: 'sa-run', slug: 'runner', status: 'running' }),
        record({ subagentId: 'sa-fail', agent: 'reviewer', status: 'idle', error: 'tool crashed' }),
        record({ subagentId: 'sa-idle', slug: ' sleeper', status: 'idle' }),
      ],
    })
    const wrapper = await mountSheet()

    expect(fetchSubagentsMock).toHaveBeenCalledWith(SID)
    expect(bodyEl('subagent-sheet-item-sa-run')!.textContent).toContain('runner')
    expect(bodyText('subagent-sheet-item-sa-run')).toContain(
      (i18n.global.t as (k: string) => string)('mobile.subagent.stateRunning'),
    )
    // failed：stateFailed 词 + 错误文本行；slug 空串 → agent 名兜底
    const failText = bodyText('subagent-sheet-item-sa-fail')
    expect(failText).toContain('reviewer')
    expect(failText).toContain('tool crashed')
    expect(failText).toContain((i18n.global.t as (k: string) => string)('mobile.subagent.stateFailed'))
    // idle（无 error）→ stateEnded 词
    expect(bodyText('subagent-sheet-item-sa-idle')).toContain(
      (i18n.global.t as (k: string) => string)('mobile.subagent.stateEnded'),
    )
    wrapper.unmount()
  })

  it('oversize=true：列表不可用降级提示在场（结构化回执，不呈现空列表假象）', async () => {
    fetchSubagentsMock.mockResolvedValue({ subagents: [], oversize: true })
    const wrapper = await mountSheet()

    expect(bodyEl('subagent-sheet-oversize')).not.toBeNull()
    expect(bodyEl('subagent-sheet-empty')).toBeNull()
    wrapper.unmount()
  })

  it('空清单：空态文案在场（loaded 且无 oversize 且无条目）', async () => {
    fetchSubagentsMock.mockResolvedValue({ subagents: [] })
    const wrapper = await mountSheet()

    expect(bodyEl('subagent-sheet-empty')).not.toBeNull()
    wrapper.unmount()
  })

  it('拉取失败：降级已加载（空态不误报 oversize），warn 留痕不抛', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    fetchSubagentsMock.mockRejectedValue(new Error('ws gone'))

    const wrapper = await mountSheet()
    await flushPromises()

    expect(bodyEl('subagent-sheet-empty')).not.toBeNull()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
    wrapper.unmount()
  })
})

describe('SubagentSheet 详情态（§6.10 执行历史派生 + 元信息行）', () => {
  const TARGET = record({
    subagentId: 'sa-x',
    slug: 'fixer',
    status: 'running',
    model: 'glm-5.3',
    thinkingLevel: 'high',
    turns: 3,
    totalTokens: 1234,
    elapsedSeconds: 90,
  })

  beforeEach(() => {
    fetchSubagentsMock.mockResolvedValue({ subagents: [TARGET] })
  })

  it('列表项点击 → 详情态：标题 = 展示名、元信息行渲染、执行记录拉取 + N=8 窗口截断、返回回列表', async () => {
    fetchHistoryMock.mockResolvedValue(
      Array.from({ length: 12 }, (_, i) => historyMsg(`m${i}`, 'done')),
    )
    const wrapper = await mountSheet()

    bodyEl('subagent-sheet-item-sa-x')!.click()
    await flushPromises()

    expect(fetchHistoryMock).toHaveBeenCalledWith(SID, 'sa-x')
    const detail = bodyEl('subagent-sheet-detail')
    expect(detail).not.toBeNull()
    // N≈8 窗口：只渲染最近 8 条（m4..m11）
    expect(document.body.querySelectorAll('[data-testid^="subagent-sheet-history-m"]').length).toBe(8)
    expect(bodyEl('subagent-sheet-history-m11')).not.toBeNull()
    expect(bodyEl('subagent-sheet-history-m3')).toBeNull()
    // 元信息行：agent/model/thinking/turns/tokens/elapsed 全渲染（fixture 全量字段）
    const meta = bodyText('subagent-sheet-detail-meta')
    expect(meta).toContain('glm-5.3')
    expect(meta).toContain('high')
    expect(meta).toContain('3')
    expect(meta).toContain('1234')
    expect(meta).toContain('90s')

    bodyEl('subagent-sheet-back')!.click()
    await flushPromises()
    expect(bodyEl('subagent-sheet-list')).not.toBeNull()
    expect(bodyEl('subagent-sheet-detail')).toBeNull()
    wrapper.unmount()
  })

  it('历史三态状态词：streaming/error/done 各自的显示词（historyStatusLabel 全分支）', async () => {
    fetchHistoryMock.mockResolvedValue([
      historyMsg('h-s', 'streaming'),
      historyMsg('h-e', 'error'),
      historyMsg('h-d', 'done'),
    ])
    const wrapper = await mountSheet()

    bodyEl('subagent-sheet-item-sa-x')!.click()
    await flushPromises()

    const t = (k: string) => (i18n.global.t as (key: string) => string)(k)
    expect(bodyText('subagent-sheet-history-h-s')).toContain(t('mobile.subagent.historyStreaming'))
    expect(bodyText('subagent-sheet-history-h-e')).toContain(t('mobile.subagent.historyError'))
    expect(bodyText('subagent-sheet-history-h-d')).toContain(t('mobile.subagent.historyDone'))
    wrapper.unmount()
  })

  it('停止（running 详情态）：stopSubagent 透传 → appendActionNotice（展示名口径）+ 重拉收敛', async () => {
    stopSubagentMock.mockResolvedValue(undefined)
    const wrapper = await mountSheet()

    bodyEl('subagent-sheet-item-sa-x')!.click()
    await flushPromises()
    bodyEl('subagent-sheet-stop')!.click()
    await flushPromises()

    expect(stopSubagentMock).toHaveBeenCalledWith(SID, 'sa-x')
    expect(appendNoticeMock).toHaveBeenCalledTimes(1)
    expect(appendNoticeMock.mock.calls[0]![0]).toBe(SID)
    expect(appendNoticeMock.mock.calls[0]![1]).toContain('fixer')
    // 收敛 = 重拉清单（fetchSubagents 再次被调）
    expect(fetchSubagentsMock.mock.calls.length).toBeGreaterThanOrEqual(2)
    wrapper.unmount()
  })

  it('停止失败：showErrorBar 出口（不写成功通知）', async () => {
    stopSubagentMock.mockRejectedValue(new Error('cancel rejected'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const wrapper = await mountSheet()

    bodyEl('subagent-sheet-item-sa-x')!.click()
    await flushPromises()
    bodyEl('subagent-sheet-stop')!.click()
    await flushPromises()

    expect(showErrorBarMock).toHaveBeenCalledWith(
      (i18n.global.t as (k: string) => string)('mobile.subagent.stopFailed'),
    )
    expect(appendNoticeMock).not.toHaveBeenCalled()
    warn.mockRestore()
    wrapper.unmount()
  })

  it('停止钮仅在 running 态呈现（idle 条目详情态无停止钮）', async () => {
    fetchSubagentsMock.mockResolvedValue({ subagents: [record({ subagentId: 'sa-idle', slug: 'sleeper', status: 'idle' })] })
    const wrapper = await mountSheet()

    bodyEl('subagent-sheet-item-sa-idle')!.click()
    await flushPromises()

    expect(bodyEl('subagent-sheet-stop')).toBeNull()
    wrapper.unmount()
  })
})

describe('SubagentSheet 直落详情（u-activity 进行中屏子代理行契约）', () => {
  it('initialSubagentId 在册：打开即进详情态（不经列表点击）', async () => {
    fetchSubagentsMock.mockResolvedValue({
      subagents: [record({ subagentId: 'sa-direct', slug: 'direct', status: 'running' })],
    })
    fetchHistoryMock.mockResolvedValue([])
    const wrapper = await mountSheet({ initialSubagentId: 'sa-direct' })
    await flushPromises()

    expect(bodyEl('subagent-sheet-detail')).not.toBeNull()
    expect(fetchHistoryMock).toHaveBeenCalledWith(SID, 'sa-direct')
    wrapper.unmount()
  })

  it('initialSubagentId 不在册：落列表态不报错（直落意图单次消费）', async () => {
    fetchSubagentsMock.mockResolvedValue({ subagents: [record({ subagentId: 'sa-other', status: 'idle' })] })
    const wrapper = await mountSheet({ initialSubagentId: 'sa-gone' })
    await flushPromises()

    expect(bodyEl('subagent-sheet-list')).not.toBeNull()
    expect(bodyEl('subagent-sheet-detail')).toBeNull()
    wrapper.unmount()
  })
})

describe('SubagentSheet 关闭出口', () => {
  it('关闭钮 emit close（壳侧 closeSheet 接线契约）', async () => {
    const wrapper = await mountSheet()

    bodyEl('subagent-sheet-close')!.click()
    await flushPromises()

    expect(wrapper.emitted('close')).toBeTruthy()
    wrapper.unmount()
  })
})
