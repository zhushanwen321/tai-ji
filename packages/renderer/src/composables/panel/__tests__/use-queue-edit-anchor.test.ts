/**
 * useQueueEditAnchor composable 装配层直测（chat-flow-consistency D6 + design-queue-delivery
 * Q3/Q4 补章；core 纯判定归 __tests__/panel/queue-edit-anchor.test.ts，本文件只测壳层编排）。
 *
 * 覆盖：编辑入口三裁决接线（already-editing-same 幂等 / conflict 拦截 + toast / peek 往返
 * 预填与放弃竞态）、peek 失败两类处置（gone 清锚 / peekFailed 清锚 + toast）、发送分流
 * （subagent 通道与无锚定同步透传 laneSend / 锚定离场顺手解除 / delivery.edit 原位替换与
 * edited=false 四值降级）、两条 watch 帧驱动路径（条目离场自动解除 / 同会话清空草稿边沿
 * 解除 / 跨会话切换不清分区）。
 *
 * 装配形态：宿主组件 setup 内调 composable（真实组件实例消除 lifecycle warn）；i18n 走
 * vitest-i18n-setup 全局 mock（文案词条在 @taiji/ui locale/zh-CN/panel.ts，断言 zh-CN 实文，
 * 与 composer-shell-model-toast.test.ts 同模式）。
 *
 * 运行：cd packages/renderer && npx vitest run src/composables/panel/__tests__/use-queue-edit-anchor.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import { mount, enableAutoUnmount, type VueWrapper } from '@vue/test-utils'
import { getDeliveryProjectionRef } from '@taiji/core'
import {
  useQueueEditAnchor,
  type QueueEditAnchorDeps,
} from '@/composables/panel/useQueueEditAnchor'
import type { DeliveryFrameEntry } from '@taiji/shared'
import type { Segment } from '@taiji/shared'

// ── delivery RPC 可控注入 ──
const deliveryMock = vi.hoisted(() => ({
  peekDelivery: vi.fn((_sid: string, _clientUuid: string) => Promise.resolve({ found: false })),
  editDelivery: vi.fn((_sid: string, _clientUuid: string, _prompt: string) =>
    Promise.resolve({ clientUuid: _clientUuid, edited: true }),
  ),
}))
vi.mock('@/api/domains/delivery', () => ({ delivery: deliveryMock }))

// ── toast spy ──
const toastMock = vi.hoisted(() => ({ error: vi.fn(), info: vi.fn(), warning: vi.fn() }))
vi.mock('@/composables/useToast', () => ({ useToast: () => toastMock }))

/** 队列帧条目工厂（谓词可见态：lane ≠ direct 且 state ≠ delivered） */
function entry(clientUuid: string): DeliveryFrameEntry {
  return { clientUuid, preview: `p-${clientUuid}`, state: 'queued', lane: 'queued' }
}

/** 宿主装配：deps 各 ref 暴露给测试驱动（sid / draft / subagent 开关可控）。
 *  形状经 mountHost 返回值推导（测试文件内不再声明单实现接口）。 */
const liveWrappers: VueWrapper[] = []
function mountHost(initialSid: string | null = 's1') {
  const sid = ref(initialSid)
  const draft = ref('')
  const isSubagentLane = ref(false)
  const restoreToDraft = vi.fn()
  const laneSend = vi.fn((_sid: string, _segments: Segment[]) => Promise.resolve(true))
  const deps: QueueEditAnchorDeps = {
    sessionIdRef: sid,
    draft,
    attachedItems: ref([]),
    restoreToDraft,
    isSubagentLane,
    laneSend,
  }
  let api!: ReturnType<typeof useQueueEditAnchor>
  const Host = defineComponent({
    setup() {
      api = useQueueEditAnchor(deps)
      return () => h('div')
    },
  })
  liveWrappers.push(mount(Host))
  return { api, sid, draft, isSubagentLane, restoreToDraft, laneSend }
}

enableAutoUnmount(afterEach)

beforeEach(() => {
  vi.clearAllMocks()
  // 派生视图单例隔离：置空 Map（resetDeliveryProjectionForTest 未过 barrel 导出，
  // 置空 ref 与其对本 composable 可见状态等价）
  getDeliveryProjectionRef().value = new Map()
})

describe('beginQueueEntryEdit · 编辑入口三裁决接线（Q4）', () => {
  it('无 sid 早退：peek 不被调', () => {
    const host = mountHost(null)
    host.api.beginQueueEntryEdit('u-1')
    expect(deliveryMock.peekDelivery).not.toHaveBeenCalled()
  })

  it('started → peek 命中 → restoreToDraft 预填（text + segments）', async () => {
    deliveryMock.peekDelivery.mockResolvedValue({
      clientUuid: 'u-1',
      found: true,
      content: 'queued text',
      segments: [{ type: 'text', text: 'queued text' }],
    })
    getDeliveryProjectionRef().value = new Map([['s1', [entry('u-1')]]])
    const host = mountHost()
    host.api.beginQueueEntryEdit('u-1')
    expect(host.api.editingQueueClientUuid.value).toBe('u-1')
    await nextTick()
    await Promise.resolve()
    expect(host.restoreToDraft).toHaveBeenCalledWith({
      text: 'queued text',
      segments: [{ type: 'text', text: 'queued text' }],
    })
  })

  it('同行再点 already-editing-same：幂等 no-op，peek 不重发', async () => {
    deliveryMock.peekDelivery.mockResolvedValue({ clientUuid: 'u-1', found: true, content: 'x' })
    getDeliveryProjectionRef().value = new Map([['s1', [entry('u-1')]]])
    const host = mountHost()
    host.api.beginQueueEntryEdit('u-1')
    await nextTick()
    await Promise.resolve()
    expect(deliveryMock.peekDelivery).toHaveBeenCalledTimes(1)
    host.api.beginQueueEntryEdit('u-1')
    expect(deliveryMock.peekDelivery).toHaveBeenCalledTimes(1)
  })

  it('编辑 A 中点 B → conflict：toast 拦截，锚定保持 A，不 peek B', () => {
    getDeliveryProjectionRef().value = new Map([['s1', [entry('u-1'), entry('u-2')]]])
    const host = mountHost()
    host.api.beginQueueEntryEdit('u-1')
    host.api.beginQueueEntryEdit('u-2')
    expect(toastMock.info).toHaveBeenCalledTimes(1)
    expect(toastMock.info).toHaveBeenCalledWith('正在编辑另一条消息，请先放弃编辑')
    expect(host.api.editingQueueClientUuid.value).toBe('u-1')
    expect(deliveryMock.peekDelivery).toHaveBeenCalledTimes(1)
    expect(deliveryMock.peekDelivery).toHaveBeenCalledWith('s1', 'u-1')
  })

  it('peek found=false → 清锚定 + gone toast（条目已不在内核活跃集）', async () => {
    deliveryMock.peekDelivery.mockResolvedValue({ clientUuid: 'u-1', found: false })
    getDeliveryProjectionRef().value = new Map([['s1', [entry('u-1')]]])
    const host = mountHost()
    host.api.beginQueueEntryEdit('u-1')
    await nextTick()
    await Promise.resolve()
    expect(host.api.editingQueueClientUuid.value).toBeNull()
    expect(toastMock.info).toHaveBeenCalledWith('原消息已不在队列')
  })

  it('peek content 空白 → 同 gone 口径（清锚定 + toast）', async () => {
    deliveryMock.peekDelivery.mockResolvedValue({ clientUuid: 'u-1', found: true, content: '  ' })
    getDeliveryProjectionRef().value = new Map([['s1', [entry('u-1')]]])
    const host = mountHost()
    host.api.beginQueueEntryEdit('u-1')
    await nextTick()
    await Promise.resolve()
    expect(host.api.editingQueueClientUuid.value).toBeNull()
    expect(toastMock.info).toHaveBeenCalledWith('原消息已不在队列')
  })

  it('peek reject → 清锚定 + peekFailed toast（错误不外抛）', async () => {
    deliveryMock.peekDelivery.mockRejectedValue(new Error('rpc boom'))
    getDeliveryProjectionRef().value = new Map([['s1', [entry('u-1')]]])
    const host = mountHost()
    host.api.beginQueueEntryEdit('u-1')
    await nextTick()
    await Promise.resolve()
    await Promise.resolve()
    expect(host.api.editingQueueClientUuid.value).toBeNull()
    expect(toastMock.error).toHaveBeenCalledWith('取回原文失败：rpc boom')
  })

  it('往返期间已放弃 → 不预填不复活锚定（以现值为准）', async () => {
    let resolvePeek: (v: { clientUuid: string; found: boolean; content: string }) => void
    deliveryMock.peekDelivery.mockReturnValue(
      new Promise((res) => {
        resolvePeek = res
      }),
    )
    getDeliveryProjectionRef().value = new Map([['s1', [entry('u-1')]]])
    const host = mountHost()
    host.api.beginQueueEntryEdit('u-1')
    host.api.abandonQueueEdit()
    resolvePeek!({ clientUuid: 'u-1', found: true, content: 'late' })
    await nextTick()
    await Promise.resolve()
    expect(host.restoreToDraft).not.toHaveBeenCalled()
    expect(host.api.editingQueueClientUuid.value).toBeNull()
  })
})

describe('abandonQueueEdit · 放弃编辑', () => {
  it('解除锚定（草稿文本保留由壳层语义，锚定归 null）', () => {
    getDeliveryProjectionRef().value = new Map([['s1', [entry('u-1')]]])
    const host = mountHost()
    host.api.beginQueueEntryEdit('u-1')
    expect(host.api.editingQueueClientUuid.value).toBe('u-1')
    host.api.abandonQueueEdit()
    expect(host.api.editingQueueClientUuid.value).toBeNull()
  })
})

describe('sendWithQueueEdit · 发送分流（D6）', () => {
  it('subagent 通道：同步透传 laneSend（同一 promise，不进 edit 流程）', async () => {
    const host = mountHost()
    host.isSubagentLane.value = true
    const segments: Segment[] = [{ type: 'text', text: 'hi' }]
    const returned = host.api.sendWithQueueEdit('s1', segments)
    expect(host.laneSend).toHaveBeenCalledWith('s1', segments)
    await expect(returned).resolves.toBe(true)
    expect(deliveryMock.editDelivery).not.toHaveBeenCalled()
  })

  it('无锚定：同步透传 laneSend', async () => {
    const host = mountHost()
    const segments: Segment[] = [{ type: 'text', text: 'hi' }]
    await host.api.sendWithQueueEdit('s1', segments)
    expect(host.laneSend).toHaveBeenCalledTimes(1)
    expect(deliveryMock.editDelivery).not.toHaveBeenCalled()
  })

  it('锚定已离场：顺手解除锚定 + 透传 laneSend（活性窄缝兜底同步点）', async () => {
    getDeliveryProjectionRef().value = new Map([['s1', [entry('u-1')]]])
    const host = mountHost()
    host.api.beginQueueEntryEdit('u-1')
    // 锚定后条目离场（delivered 被谓词滤除）
    getDeliveryProjectionRef().value = new Map()
    const segments: Segment[] = [{ type: 'text', text: 'hi' }]
    await host.api.sendWithQueueEdit('s1', segments)
    expect(host.api.editingQueueClientUuid.value).toBeNull()
    expect(host.laneSend).toHaveBeenCalledTimes(1)
    expect(deliveryMock.editDelivery).not.toHaveBeenCalled()
  })

  it('锚定活 → delivery.edit 原位替换：edited=true 直接收尾（无 laneSend、锚定解除）', async () => {
    deliveryMock.editDelivery.mockResolvedValue({ clientUuid: 'u-1', edited: true })
    getDeliveryProjectionRef().value = new Map([['s1', [entry('u-1')]]])
    const host = mountHost()
    host.api.beginQueueEntryEdit('u-1')
    const segments: Segment[] = [{ type: 'text', text: 'edited' }]
    await expect(host.api.sendWithQueueEdit('s1', segments)).resolves.toBe(true)
    expect(deliveryMock.editDelivery).toHaveBeenCalledWith('s1', 'u-1', 'edited', segments)
    expect(host.api.editingQueueClientUuid.value).toBeNull()
    expect(host.laneSend).not.toHaveBeenCalled()
    expect(toastMock.info).not.toHaveBeenCalled()
  })

  it('edited=false 四值降级：toast 分型 + 内容按普通新消息发出（不丢）', async () => {
    deliveryMock.editDelivery.mockResolvedValue({ clientUuid: 'u-1', edited: false, reason: 'cancelled' })
    getDeliveryProjectionRef().value = new Map([['s1', [entry('u-1')]]])
    const host = mountHost()
    host.api.beginQueueEntryEdit('u-1')
    const segments: Segment[] = [{ type: 'text', text: 'still here' }]
    await expect(host.api.sendWithQueueEdit('s1', segments)).resolves.toBe(true)
    expect(toastMock.info).toHaveBeenCalledWith('原消息已撤销，修改内容已作为新消息发送')
    expect(host.laneSend).toHaveBeenCalledWith('s1', segments)
  })
})

describe('watch 帧驱动 · 离场自动解除与清空草稿边沿（Q3/Q4）', () => {
  it('锚定条目离场（帧更新滤除）→ 自动清锚定，不发 toast', async () => {
    getDeliveryProjectionRef().value = new Map([['s1', [entry('u-1')]]])
    const host = mountHost()
    host.api.beginQueueEntryEdit('u-1')
    expect(host.api.editingQueueClientUuid.value).toBe('u-1')
    // 先 flush 一次：begin（锚定 null→'u-1'）与离场帧若在同一同步块，watcher job 去重合并、
    // 边沿回调不触发（Vue watch 语义；生产两事件恒跨任务）——先落定 'u-1' 边沿再模拟离场帧
    await nextTick()
    getDeliveryProjectionRef().value = new Map([['s1', [entry('u-9')]]])
    await nextTick()
    expect(host.api.editingQueueClientUuid.value).toBeNull()
    expect(toastMock.info).not.toHaveBeenCalled()
  })

  it('同会话清空草稿边沿（有内容 → 空）→ 清锚定', async () => {
    getDeliveryProjectionRef().value = new Map([['s1', [entry('u-1')]]])
    const host = mountHost()
    host.api.beginQueueEntryEdit('u-1')
    host.draft.value = 'typing'
    await nextTick()
    expect(host.api.editingQueueClientUuid.value).toBe('u-1')
    host.draft.value = ''
    await nextTick()
    expect(host.api.editingQueueClientUuid.value).toBeNull()
  })

  it('跨会话切换不清源分区锚定（Q4 穷举 3：切走留在分区、切回恢复）', async () => {
    getDeliveryProjectionRef().value = new Map([['s1', [entry('u-1')]], ['s2', []]])
    const host = mountHost()
    host.api.beginQueueEntryEdit('u-1')
    host.draft.value = 'kept'
    host.sid.value = 's2'
    await nextTick()
    // 新会话分区无锚定
    expect(host.api.editingQueueClientUuid.value).toBeNull()
    host.sid.value = 's1'
    await nextTick()
    // 切回源分区：锚定随分区恢复
    expect(host.api.editingQueueClientUuid.value).toBe('u-1')
  })
})
