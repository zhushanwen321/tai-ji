/**
 * useBtwTabData 单测（btw-question M3-b：badge 数据通道 + updateFor 隔离 + 虚拟 key 清理登记）。
 *
 * 三视角（TEST-STRATEGY §3）：
 * - 使用者（黑盒 DOM）：Host 把 threads 计数 / Σ unread 投影成文本节点，每条用例断言可见文本
 *   （拉取落地 / 迟到响应不串台 / 进视口清除 / 剪枝后归零）
 * - 观察者（形态）：挂载即主动拉取（不依赖广播）；线列表与 badge 数据面按主会话分区落位
 * - 构建者（白盒）：updateFor(capturedSid) 迟到响应写旧分区（规则 8 隔离）+ 虚拟 key 登记
 *   三函数（get/clear/reconcile——M4-a 消费面先写后读）+ 出册线观察停止
 *
 * mock 策略（TEST-STRATEGY §5）：vi.mock('@/api') 局部替换 btw 域（spread actual 保门面
 * 其余域，btw-panel 同款）；真实 chat store（setMessages 真实分区增长驱动未读 watch）+
 * 真实 core drawer 域（视口判定与抽屉活动触发面）。i18n 走全局 setup（本文件无文案断言）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/panel/use-btw-tab-data.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { flushPromises, mount, enableAutoUnmount, type VueWrapper } from '@vue/test-utils'
import { computed, defineComponent, nextTick, ref } from 'vue'
import type { Ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import type { Message } from '@taiji/shared'
import {
  bindDrawerSessionId,
  drawerControl,
  openDrawerTab,
  _resetDrawerForTest,
} from '@taiji/core/domain/drawer'
import { useBtwTabData, getBtwVirtualIdsByMain, clearBtwVirtualKeyMapping } from '@/composables/panel/useBtwTabData'
import { __clearSessionCleanupRegistryForTest } from '@/composables/useSessionScopedState'
import { useChatStore } from '@/stores/chat'

// ── @/api 门面局部 mock：只替换 badge 数据源 btw 域 ──
const btwMock = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  remove: vi.fn(),
}))
vi.mock('@/api', async (importActual) => {
  const actual = await importActual<typeof import('@/api')>()
  return { ...actual, btw: btwMock }
})

const SID_A = 's-btw-data-a'
const SID_B = 's-btw-data-b'

/** 最小 Host：把 composable 暴露面投影成可见文本节点（使用者视角断言面） */
const Host = defineComponent({
  props: { sid: { type: String, default: null } },
  setup(props) {
    const sidRef = computed(() => props.sid as string | null)
    const { state, totalUnread } = useBtwTabData(sidRef)
    return { state, totalUnread }
  },
  template: `
    <div>
      <span data-testid="threads">{{ state.threads.length }}</span>
      <span data-testid="unread">{{ totalUnread }}</span>
    </div>
  `,
})

let boundSid: Ref<string | null>

function mountHost(sid: string | null): VueWrapper {
  return mount(Host, { props: { sid } })
}

function text(w: VueWrapper, testid: string): string {
  return w.find(`[data-testid="${testid}"]`).text()
}

async function settle(w: VueWrapper): Promise<void> {
  await flushPromises()
  await nextTick()
  await nextTick()
}

function msg(id: string): Message {
  return { id, role: 'assistant', content: 'x', status: 'complete', timestamp: 0 }
}

enableAutoUnmount(afterEach)

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  btwMock.list.mockResolvedValue([])
  boundSid = ref(SID_A)
  bindDrawerSessionId(boundSid)
  _resetDrawerForTest()
  __clearSessionCleanupRegistryForTest()
  clearBtwVirtualKeyMapping(SID_A)
  clearBtwVirtualKeyMapping(SID_B)
})

describe('挂载/切会话主动拉取（broadcast 时序竞争规则：必拉不依赖广播）', () => {
  it('挂载即主动拉取 btw.list(mainSid)，线列表落当前分区', async () => {
    btwMock.list.mockResolvedValue([{ vid: 'btw:t1' }, { vid: 'btw:t2' }])
    const w = mountHost(SID_A)
    await settle(w)

    expect(btwMock.list).toHaveBeenCalledWith(SID_A)
    expect(text(w, 'threads')).toBe('2') // 用户可见：线列表投影
    expect(text(w, 'unread')).toBe('0')
  })

  it('切会话：按新 mainSid 重拉，两主会话分区互不污染', async () => {
    btwMock.list.mockImplementation((sid: string) =>
      Promise.resolve(sid === SID_A ? [{ vid: 'btw:ta' }] : [{ vid: 'btw:tb1' }, { vid: 'btw:tb2' }]),
    )
    const w = mountHost(SID_A)
    await settle(w)
    expect(text(w, 'threads')).toBe('1')

    await w.setProps({ sid: SID_B })
    await settle(w)
    expect(btwMock.list).toHaveBeenLastCalledWith(SID_B)
    expect(text(w, 'threads')).toBe('2')
  })
})

describe('updateFor(capturedSid) 隔离（AGENTS 规则 8：迟到响应写旧分区）', () => {
  it('切会话后旧 sid 的迟到响应只写旧分区，不污染当前分区；切回恢复', async () => {
    let resolveA!: (v: { vid: string }[]) => void
    btwMock.list.mockImplementation((sid: string) => {
      if (sid === SID_A) {
        return new Promise((resolve) => {
          resolveA = resolve
        })
      }
      return Promise.resolve([{ vid: 'btw:tb1' }, { vid: 'btw:tb2' }])
    })
    const w = mountHost(SID_A)
    await flushPromises() // A 的拉取挂起（capture 已回写 loadSeq）
    await w.setProps({ sid: SID_B })
    await settle(w)
    expect(text(w, 'threads')).toBe('2') // 当前 = B 的线

    // A 迟到落地：若实现误用 update（当前 sid），B 分区会被覆写成 1
    resolveA([{ vid: 'btw:ta' }])
    await settle(w)
    expect(text(w, 'threads')).toBe('2')

    // 切回 A：分区保留（迟到响应确实写进了 captured 分区）
    await w.setProps({ sid: SID_A })
    await flushPromises()
    await nextTick()
    expect(text(w, 'threads')).toBe('1')
  })
})

describe('未读计数与视口清除（D8 终态表「未读」行）', () => {
  it('非视口增长计数；线内容进视口即清；视口内不计；离开视口再计', async () => {
    btwMock.list.mockResolvedValue([{ vid: 'btw:t1' }])
    const w = mountHost(SID_A)
    await settle(w)
    const chat = useChatStore()

    chat.setMessages('btw:t1', [msg('a1')])
    await settle(w)
    expect(text(w, 'unread')).toBe('1')

    // 进视口（drawer 开 btw tab + 选中该线）→ 清
    openDrawerTab('btw')
    drawerControl.setBtwView('btw:t1')
    await settle(w)
    expect(text(w, 'unread')).toBe('0')

    // 视口内到达：不计
    chat.setMessages('btw:t1', [msg('a1'), msg('a2')])
    await settle(w)
    expect(text(w, 'unread')).toBe('0')

    // 离开视口：新回复再计
    drawerControl.close()
    await settle(w)
    chat.setMessages('btw:t1', [msg('a1'), msg('a2'), msg('a3')])
    await settle(w)
    expect(text(w, 'unread')).toBe('1')
  })
})

describe('虚拟 key 清理登记（M3-b 登记结构；deleteSession 消费面归 M4-a）', () => {
  it('拉取成功登记 mainSid → vid 映射，clearBtwVirtualKeyMapping 后出册', async () => {
    btwMock.list.mockResolvedValue([{ vid: 'btw:t1' }, { vid: 'btw:t2' }])
    const w = mountHost(SID_A)
    await settle(w)

    expect(text(w, 'threads')).toBe('2') // 使用者可见面
    expect(getBtwVirtualIdsByMain(SID_A)).toEqual(['btw:t1', 'btw:t2'])
    clearBtwVirtualKeyMapping(SID_A)
    expect(getBtwVirtualIdsByMain(SID_A)).toEqual([])
  })

  it('出册线：重拉剪枝残留未读与登记，观察停止后不再计数', async () => {
    btwMock.list.mockResolvedValue([{ vid: 'btw:t1' }, { vid: 'btw:t2' }])
    const w = mountHost(SID_A)
    await settle(w)
    const chat = useChatStore()

    chat.setMessages('btw:t2', [msg('b1')])
    await settle(w)
    expect(text(w, 'unread')).toBe('1')

    // 关线后重拉（抽屉活动触发面）：权威列表只剩 t1
    btwMock.list.mockResolvedValue([{ vid: 'btw:t1' }])
    openDrawerTab('btw')
    await settle(w)
    expect(text(w, 'threads')).toBe('1')
    expect(text(w, 'unread')).toBe('0') // 残留未读按权威列表剪掉（视口清除支不触达：未选中线）
    expect(getBtwVirtualIdsByMain(SID_A)).toEqual(['btw:t1']) // 登记 reconcile

    // 出册线后续增长不再产生 badge 信号（观察已停）
    chat.setMessages('btw:t2', [msg('b1'), msg('b2')])
    await settle(w)
    expect(text(w, 'unread')).toBe('0')
  })
})
