// app-runtime 投递域透传出口直测（chat-flow-consistency D6 移动壳接线）。
//
// QueueStrip / Composer 的组件级 mock 全量替换了 app-runtime（隔离 core WS），
// 透传函数本体（peek/edit 直调 core transport chat 域 + 锚定分区三出口）在组件测试中
// 不可达——本文件 mock core chat 域后直调出口，锁定透传接线与锚定分区读写语义：
// - peekDelivery / editDelivery：参数原样透传 core chat 域（chatApiPort 不扩口，移动壳
//   直引与 cancelDelivery 透传形态平行）
// - beginQueueEdit / clearQueueEditFor / queueEditAnchorOf：per-session Map 分区 +
//   core queue-edit-anchor 判定（三裁决在 core 单测锁定，此处锁分区接线）
//
// 运行：cd packages/mobile-renderer && npx vitest run src/__tests__/app-runtime-delivery-passthrough.spec.ts
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { Segment } from '@taiji/shared'

const chatApiMock = vi.hoisted(() => ({
  peekDelivery: vi.fn<(sid: string, clientUuid: string) => Promise<unknown>>(),
  editDelivery: vi.fn<
    (sid: string, clientUuid: string, content: string, segments?: unknown[]) => Promise<unknown>
  >(),
}))
// app-runtime 顶层消费 chat 域多成员（abort/send/...），部分展开只覆写 peek/edit 两个透传点
vi.mock('@taiji/core/transport/api/domains/chat', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  peekDelivery: chatApiMock.peekDelivery,
  editDelivery: chatApiMock.editDelivery,
}))

import {
  beginQueueEdit,
  clearQueueEditFor,
  editDelivery,
  peekDelivery,
  queueEditAnchorOf,
} from '../shell/app-runtime'

beforeEach(() => {
  chatApiMock.peekDelivery.mockReset()
  chatApiMock.editDelivery.mockReset()
  // 分区隔离：测试专用 sid（与组件级 spec 的 mock sid 空间不重叠）
  clearQueueEditFor('sid-passthrough')
})

describe('app-runtime 投递域透传出口（D6）', () => {
  it('peekDelivery 参数原样透传 core chat 域，回执直返', async () => {
    chatApiMock.peekDelivery.mockResolvedValue({ clientUuid: 'u-1', found: true, content: 'x' })
    await expect(peekDelivery('sid-passthrough', 'u-1')).resolves.toEqual({
      clientUuid: 'u-1',
      found: true,
      content: 'x',
    })
    expect(chatApiMock.peekDelivery).toHaveBeenCalledWith('sid-passthrough', 'u-1')
  })

  it('editDelivery 参数原样透传 core chat 域（含 segments 快照）', async () => {
    chatApiMock.editDelivery.mockResolvedValue({ clientUuid: 'u-1', edited: true })
    const segments: Segment[] = [{ type: 'text', text: 'edited' }]
    await expect(editDelivery('sid-passthrough', 'u-1', 'edited', segments)).resolves.toEqual({
      clientUuid: 'u-1',
      edited: true,
    })
    expect(chatApiMock.editDelivery).toHaveBeenCalledWith('sid-passthrough', 'u-1', 'edited', segments)
  })

  it('锚定分区三出口：无锚 null → started 登记 → 读口返回 → 解除归 null', () => {
    expect(queueEditAnchorOf('sid-passthrough')).toBeNull()
    expect(beginQueueEdit('sid-passthrough', 'u-1')).toBe('started')
    expect(queueEditAnchorOf('sid-passthrough')).toBe('u-1')
    clearQueueEditFor('sid-passthrough')
    expect(queueEditAnchorOf('sid-passthrough')).toBeNull()
  })

  it('锚定分区按 session 隔离：他行会话不受本会话登记/解除影响', () => {
    expect(beginQueueEdit('sid-passthrough', 'u-1')).toBe('started')
    // 首次调用即建分区（懒初始化），他会话分区独立
    expect(beginQueueEdit('sid-other', 'u-2')).toBe('started')
    clearQueueEditFor('sid-passthrough')
    expect(queueEditAnchorOf('sid-passthrough')).toBeNull()
    expect(queueEditAnchorOf('sid-other')).toBe('u-2')
    clearQueueEditFor('sid-other')
  })
})
