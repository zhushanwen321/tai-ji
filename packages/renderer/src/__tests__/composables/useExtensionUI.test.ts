// @vitest-environment node

/**
 * useExtensionUI 测试族合并文件（簇 3-2，4 源合一）：
 * - useExtensionUI.test.ts —— bus 队列隔离 T1-T11（本文件即该源，主体在同名节）
 * - useExtensionUI-form-normalize.test.ts —— formFilter 判定矩阵 + view-ready 帧双路径
 * - use-extension-ui-plan-review.test.ts —— planReview 分流（C4/D5/D9③/D4）
 * - panel/use-btw-interaction.test.ts —— btw 内联确认条纯函数群直测
 *
 * mock 注册（工厂体单源在 helpers/use-extension-ui-test-env，hoist 语义要求注册留本文件）
 * 为三源逐字同文去重后的单份；各节 beforeEach/helper 下沉节内（节间零共享可变状态）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ref, nextTick } from 'vue'

vi.mock('@taiji/core/transport/api/domains/extension', async () => {
  const { extensionDomainMocks } = await import('../helpers/use-extension-ui-test-env')
  return extensionDomainMocks
})
vi.mock('@/composables/shell/useExtensionHostBridge', async (importOriginal) => {
  const { bridgeModuleMocks } = await import('../helpers/use-extension-ui-test-env')
  return bridgeModuleMocks(importOriginal)
})

import {
  useExtensionUI,
  formFilter,
  planReviewFilter,
  isPlanReviewRequest,
  __testing,
} from '@/composables/useExtensionUI'
import { sendExtensionUIResponse, getPendingRequests } from '@taiji/core/transport/api/domains/extension'
import type { ExtensionUIRequest } from '@taiji/core/transport/api/domains/extension'
import { useExtensionUIStore } from '@/stores/extension-ui'
import { usePlanStore, __testing as planStoreTesting } from '@/stores/plan-store'
import { useToast } from '@/composables/useToast'
import type { ScheduleDraft } from '@zhushanwen/extension-protocol'
import { __testing as btwInteractionTesting } from '@/composables/panel/useBtwInteraction'
import {
  busSlot,
  emitBusUIRequest,
  extensionDomainMocks,
  resetUseExtensionUITestEnv,
  runInExtensionUIScope,
} from '../helpers/use-extension-ui-test-env'

// ═══ 来源节：useExtensionUI.test.ts —— bus 队列隔离 T1-T11 ═══
describe('useExtensionUI', () => {
  // ── 测试数据构造 helper（DialogRequest 形状——runtime event-adapter ASK_USER_MARKER
  //    分支产出的 view-ready 帧：legacy 归一上移 runtime 后 form 键原生携带）──
  function mkAskUserReq(requestId: string, overrides: Record<string, unknown> = {}) {
    return {
      requestId,
      pluginId: 'p',
      kind: 'select' as const,
      dialogKind: 'select',
      title: 't',
      form: true,
      formQuestions: [{ type: 'text', header: 'q', question: 'q?' }],
      allowCancel: true,
      ...overrides,
    }
  }
  function mkDialogReq(requestId: string, dialogKind: 'confirm' | 'select' | 'input' = 'confirm') {
    return { requestId, pluginId: 'p', kind: dialogKind, dialogKind, title: 't' }
  }

  beforeEach(() => {
    resetUseExtensionUITestEnv(__testing.__resetExtensionBusSubscriptionForTesting)
  })

  describe('useExtensionUI T1/T2 bus 事件入队与 C4 分流', () => {
    it('T1: bus ui-request 事件（form=true）入 store，字段完整（view-ready 帧直入）', () => {
      const { currentFormRequest } = useExtensionUI(ref('sessionA'))

      emitBusUIRequest('sessionA', mkAskUserReq('r1'))

      expect(currentFormRequest.value?.requestId).toBe('r1')
      expect(currentFormRequest.value?.sessionId).toBe('sessionA')
      expect(currentFormRequest.value?.dialogKind).toBe('select')
      // form 键 + formQuestions（runtime marker 分支产出形状）
      expect(currentFormRequest.value?.form).toBe(true)
      expect(currentFormRequest.value?.formQuestions).toEqual([{ type: 'text', header: 'q', question: 'q?' }])
      expect(currentFormRequest.value?.allowCancel).toBe(true)
      expect(currentFormRequest.value?.title).toBe('t')
      expect(typeof currentFormRequest.value?.receivedAt).toBe('number')

      // store 分区为事件 sid
      const records = useExtensionUIStore().getRequestsBySession('sessionA')
      expect(records).toHaveLength(1)
      expect(records[0].requestId).toBe('r1')
    })

    it('T2: 无标记 dialog 请求不入 store（C4 分流）', () => {
      const { currentFormRequest } = useExtensionUI(ref('sessionA'))

      emitBusUIRequest('sessionA', mkDialogReq('r2', 'confirm'))

      expect(currentFormRequest.value).toBeUndefined()
      expect(useExtensionUIStore().getRequestsBySession('sessionA')).toHaveLength(0)
    })

    it('T2b: 事件 sessionId 缺失 → 跳过入队（C2）', () => {
      const { currentFormRequest } = useExtensionUI(ref('sessionA'))
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      // 无 sessionId 的 ui-request 事件
      busSlot.current!.emit({ kind: 'ui-request', request: mkAskUserReq('r-nosid') } as never)

      expect(currentFormRequest.value).toBeUndefined()
      expect(useExtensionUIStore().getRequestsBySession('sessionA')).toHaveLength(0)
      expect(warnSpy).toHaveBeenCalled()
      warnSpy.mockRestore()
    })
  })

  describe('useExtensionUI T3 per-session 队列隔离', () => {
    it('sessionA 与 sessionB 的 ask-user 互不串扰', () => {
      const { currentFormRequest: aAsk } = useExtensionUI(ref('sessionA'))
      const { currentFormRequest: bAsk } = useExtensionUI(ref('sessionB'))

      emitBusUIRequest('sessionA', mkAskUserReq('r-a1'))
      emitBusUIRequest('sessionB', mkAskUserReq('r-b1'))

      expect(aAsk.value?.requestId).toBe('r-a1')
      expect(bAsk.value?.requestId).toBe('r-b1')
      expect(aAsk.value?.requestId).not.toBe('r-b1')
      expect(bAsk.value?.requestId).not.toBe('r-a1')
    })
  })

  describe('useExtensionUI T4 按 requestId 精确 respond/cancel', () => {
    it('队列含多个表单请求，respond 指定 requestId → 仅该请求出队 + 响应参数正确', () => {
      const { respond, currentFormRequest } = useExtensionUI(ref('sessionA'))
      emitBusUIRequest('sessionA', mkAskUserReq('r-ask'))
      emitBusUIRequest('sessionA', mkAskUserReq('r-ask2'))

      respond('r-ask2', true)

      expect(sendExtensionUIResponse).toHaveBeenCalledWith('sessionA', 'r-ask2', 'select', true)
      expect(currentFormRequest.value?.requestId).toBe('r-ask')

      // respond 队首后队列空
      respond('r-ask', false)
      expect(currentFormRequest.value).toBeUndefined()
    })

    it('cancel 传入 requestId 等价于 respond(null)', () => {
      const { cancel } = useExtensionUI(ref('sessionA'))
      emitBusUIRequest('sessionA', mkAskUserReq('r-x'))

      cancel('r-x')
      expect(sendExtensionUIResponse).toHaveBeenCalledWith('sessionA', 'r-x', 'select', null)
    })
  })

  describe('useExtensionUI T6 C3 保留 RPC 路径', () => {
    it('T6: getPendingRequests 拉取结果入 store（RPC 保留）', async () => {
      vi.mocked(getPendingRequests).mockResolvedValue([
        mkAskUserReq('r1'),
        mkAskUserReq('r2'),
      ] as never)
      const { currentFormRequest } = useExtensionUI(ref('sessionA'))

      // 等待拉取 Promise resolve（初始 subscribe 即触发一次 getPendingRequests）
      await nextTick()
      await nextTick()

      expect(getPendingRequests).toHaveBeenCalled()
      expect(currentFormRequest.value?.requestId).toBe('r1')
      expect(useExtensionUIStore().getRequestsBySession('sessionA')).toHaveLength(2)
    })
  })

  describe('useExtensionUI 快照差集剔除（renderer 僵尸表单修剪，§6.2 采用项④ v6.1）', () => {
    it('(a) runtime 清 pending → 空快照应答剔除该 session 分区旧交互条目（空快照也执行）', async () => {
      // 快照恒为空（A 初始权威快照为空，B 亦空）
      vi.mocked(getPendingRequests).mockResolvedValue([])
      const sid = ref<string | null>('sessionA')
      const { result, dispose } = runInExtensionUIScope(() => useExtensionUI(sid))

      // 初始订阅拉取空完成
      await nextTick()
      await nextTick()

      // 模拟「屏上旧表单」：bus 实时帧入 A 分区（未重订阅时它保留在屏上——已声明缺口）
      emitBusUIRequest('sessionA', mkAskUserReq('r-zombie'))
      expect(result.currentFormRequest.value?.requestId).toBe('r-zombie')
      expect(useExtensionUIStore().getRequestsBySession('sessionA')).toHaveLength(1)

      // 触发重订阅（切走再切回）：runtime 已清 pending ⇒ 下一次快照为空 []
      sid.value = 'sessionB'
      await nextTick()
      await nextTick()
      sid.value = 'sessionA'
      await nextTick()
      await nextTick()
      await nextTick()

      // 空快照执行剔除（剔除逻辑在 for 循环之外）：僵尸条目从分区消失、overlay 收起
      expect(result.currentFormRequest.value).toBeUndefined()
      expect(useExtensionUIStore().getRequestsBySession('sessionA')).toEqual([])
      expect(useExtensionUIStore().hasPendingBlockingOverlay('sessionA')).toBe(false)

      dispose()
    })

    it('(b) 快照非空但缺某条 → 差集剔除该条、其余保留（活请求仍可提交）', async () => {
      // 初始快照为空（bus 帧先占屏）；重订阅前才把 r-live 置入权威快照
      let snapshotA: ExtensionUIRequest[] = []
      vi.mocked(getPendingRequests).mockImplementation(async (s: string) =>
        s === 'sessionA' ? snapshotA : [],
      )
      const sid = ref<string | null>('sessionA')
      const { result, dispose } = runInExtensionUIScope(() => useExtensionUI(sid))
      await nextTick()
      await nextTick()

      emitBusUIRequest('sessionA', mkAskUserReq('r-zombie'))
      emitBusUIRequest('sessionA', mkAskUserReq('r-live'))
      expect(useExtensionUIStore().getRequestsBySession('sessionA').map((r) => r.requestId)).toEqual([
        'r-zombie',
        'r-live',
      ])

      // 重订阅：快照只含 r-live（r-zombie 已被 runtime 清）
      snapshotA = [mkAskUserReq('r-live')] as never
      sid.value = 'sessionB'
      await nextTick()
      await nextTick()
      sid.value = 'sessionA'
      await nextTick()
      await nextTick()
      await nextTick()

      const ids = useExtensionUIStore().getRequestsBySession('sessionA').map((r) => r.requestId)
      expect(ids).toEqual(['r-live'])
      // 活请求仍在且可提交（respond 送达 + 出队）
      expect(result.currentFormRequest.value?.requestId).toBe('r-live')
      result.respond('r-live', true)
      expect(sendExtensionUIResponse).toHaveBeenCalledWith('sessionA', 'r-live', 'select', true)
      expect(useExtensionUIStore().getRequestsBySession('sessionA')).toEqual([])

      dispose()
    })

    it('(c) 快照中的条目保持原字段且不重复入队（差集 + dedup 幂等）', async () => {
      let snapshotA: ExtensionUIRequest[] = []
      vi.mocked(getPendingRequests).mockImplementation(async (s: string) =>
        s === 'sessionA' ? snapshotA : [],
      )
      const sid = ref<string | null>('sessionA')
      const { result, dispose } = runInExtensionUIScope(() => useExtensionUI(sid))
      await nextTick()
      await nextTick()

      // bus 实时帧先入（带本地拍戳）
      emitBusUIRequest('sessionA', mkAskUserReq('r-live', { title: 'bus-frame' }))
      const before = useExtensionUIStore().getRequestsBySession('sessionA')[0]

      // 重订阅：快照含同 requestId → 差集保留（不重复追加），且不覆盖已有记录
      snapshotA = [mkAskUserReq('r-live')] as never
      sid.value = 'sessionB'
      await nextTick()
      await nextTick()
      sid.value = 'sessionA'
      await nextTick()
      await nextTick()
      await nextTick()

      const records = useExtensionUIStore().getRequestsBySession('sessionA')
      expect(records).toHaveLength(1)
      expect(records[0].requestId).toBe('r-live')
      expect(records[0].title).toBe('bus-frame') // 活条目未被快照覆盖
      expect(records[0].receivedAt).toBe(before.receivedAt)
      expect(result.currentFormRequest.value?.requestId).toBe('r-live')

      dispose()
    })
  })

  describe('useExtensionUI T7 同实例切 session 隔离（AC-1/AC-2 bus 版）', () => {
    it('AC-1: 同一实例 sessionId 从 A 切到 B 后 currentFormRequest 变 undefined', async () => {
      const sid = ref<string | null>('sessionA')
      const { result, dispose } = runInExtensionUIScope(() => useExtensionUI(sid))

      emitBusUIRequest('sessionA', mkAskUserReq('r-a1'))
      expect(result.currentFormRequest.value?.requestId).toBe('r-a1')

      sid.value = 'sessionB'
      await nextTick()

      expect(result.currentFormRequest.value).toBeUndefined()
      dispose()
    })

    it('AC-2: 切回 A 后 pending 表单请求恢复显示（分区保留 + 快照权威再确认）', async () => {
      // 快照按 session 分源：A 的 fetch 是权威 pending 集（含 r-a1），B 为空。
      vi.mocked(getPendingRequests).mockImplementation(async (s: string) =>
        s === 'sessionA' ? ([mkAskUserReq('r-a1')] as never) : [],
      )
      const sid = ref<string | null>('sessionA')
      const { result, dispose } = runInExtensionUIScope(() => useExtensionUI(sid))

      emitBusUIRequest('sessionA', mkAskUserReq('r-a1'))
      expect(result.currentFormRequest.value?.requestId).toBe('r-a1')

      sid.value = 'sessionB'
      await nextTick()

      expect(result.currentFormRequest.value).toBeUndefined()
      // 切走不清 A 分区（分区语义；A 的修剪只由 A 自己的快照驱动）
      expect(useExtensionUIStore().getRequestsBySession('sessionA')).toHaveLength(1)

      sid.value = 'sessionA'
      await nextTick()
      await nextTick()
      expect(result.currentFormRequest.value?.requestId).toBe('r-a1')

      dispose()
    })

    it('T7b: 切走后旧 sid 迟到事件写旧分区（M1 事件 sid 语义），不污染新分区', async () => {
      // 初始两 session 快照均为空；A 的权威快照在「切回」前才置入迟到请求（模拟 runtime pending）
      const pendingBySession: Record<string, ExtensionUIRequest[]> = { sessionA: [], sessionB: [] }
      vi.mocked(getPendingRequests).mockImplementation(async (s: string) => pendingBySession[s] ?? [])
      const sid = ref<string | null>('sessionA')
      const { result, dispose } = runInExtensionUIScope(() => useExtensionUI(sid))

      sid.value = 'sessionB'
      await nextTick()
      await nextTick()

      // 旧 sid 迟到事件（退订异步，或 runtime 重放）——事件 sid 仍是 A
      emitBusUIRequest('sessionA', mkAskUserReq('r-late-a'))

      // B 分区不被污染；迟到事件写 A 分区（M1：事件自带归属）
      expect(result.currentFormRequest.value).toBeUndefined()
      expect(useExtensionUIStore().getRequestsBySession('sessionB')).toEqual([])
      expect(useExtensionUIStore().getRequestsBySession('sessionA').map((r) => r.requestId)).toEqual(['r-late-a'])

      // 切回 A：快照（权威 pending 集）含该请求 → 差集保留、恢复显示
      pendingBySession.sessionA = [mkAskUserReq('r-late-a')] as never
      sid.value = 'sessionA'
      await nextTick()
      await nextTick()
      expect(result.currentFormRequest.value?.requestId).toBe('r-late-a')

      dispose()
    })
  })

  describe('useExtensionUI T8 filter 第二道闸语义', () => {
    it('formFilter 实例放行表单类请求（dialog 不再经 store）', () => {
      const sid = ref<string | null>('shared')
      const { result: formPanel } = runInExtensionUIScope(() => useExtensionUI(sid, formFilter))

      emitBusUIRequest('shared', mkAskUserReq('r-ask'))

      // formFilter 放行（runtime 产出的 view-ready 帧原生带 form 键）
      expect(formPanel.currentFormRequest.value?.requestId).toBe('r-ask')

      // store 只有一条（formFilter 实例写入）
      expect(useExtensionUIStore().getRequestsBySession('shared')).toHaveLength(1)
    })
  })

  describe('useExtensionUI T9 模块级 refCount 注册/注销（项目规则 #2）', () => {
    it('多实例订阅共享单次 bus.on；全部 dispose 后不再分发', () => {
      const onSpy = vi.spyOn(busSlot.current!, 'on')
      const sid = ref<string | null>('shared')
      const insts = [1, 2, 3].map(() => runInExtensionUIScope(() => useExtensionUI(sid)))

      // 3 实例订阅 → ui-request 通道 bus.on 只被调 1 次（refCount 首个注册）；
      // 另 1 次是 P2-2 失效链的模块级单订阅（'requests-invalidated'，永驻不随实例 dispose）
      expect(onSpy).toHaveBeenCalledTimes(2)
      expect(onSpy.mock.calls.map((c) => c[0]).sort()).toEqual(['requests-invalidated', 'ui-request'])

      // 分发仍工作（3 实例都收到 → store 去重后 1 条）
      emitBusUIRequest('shared', mkAskUserReq('r1'))
      expect(useExtensionUIStore().getRequestsBySession('shared')).toHaveLength(1)
      expect(insts[0].result.currentFormRequest.value?.requestId).toBe('r1')
      expect(insts[2].result.currentFormRequest.value?.requestId).toBe('r1')

      // dispose 2 个 → 第 3 个实例仍收（r2 入队，respond r1 后晋升）
      insts[0].dispose()
      insts[1].dispose()
      emitBusUIRequest('shared', mkAskUserReq('r2'))
      expect(insts[2].result.currentFormRequest.value?.requestId).toBe('r1')
      insts[2].result.respond('r1', true)
      expect(insts[2].result.currentFormRequest.value?.requestId).toBe('r2')

      // 全部 dispose → 不再分发（bus 无 handler，emit 无副作用）
      insts[2].dispose()
      emitBusUIRequest('shared', mkAskUserReq('r3'))
      // r1 已被中途 respond 出队，store 保持 ['r2']——r3 未入队
      expect(useExtensionUIStore().getRequestsBySession('shared').map((r) => r.requestId)).toEqual(['r2'])
    })
  })

  describe('useExtensionUI T10 requestId dedup 双通路（bus 帧 + 拉取）', () => {
    it('bus 实时帧先入队，切回拉取同 requestId 不重复入队', async () => {
      const sid = ref<string | null>('sessionA')
      const { result, dispose } = runInExtensionUIScope(() => useExtensionUI(sid, formFilter))

      // 1. bus 实时帧入 r1
      emitBusUIRequest('sessionA', mkAskUserReq('r1'))
      expect(result.currentFormRequest.value?.requestId).toBe('r1')

      // 2. 切到 B（拉取空）
      sid.value = 'sessionB'
      await nextTick()

      // 3. 切回 A：拉取返回 [r1, r2]，r1 已在队（去重后只入 r2）
      vi.mocked(getPendingRequests).mockResolvedValue([
        mkAskUserReq('r1'),
        mkAskUserReq('r2'),
      ] as never)
      sid.value = 'sessionA'
      await nextTick()
      await nextTick()
      await nextTick()

      // 4. 去重断言：respond(r1) 后晋升 r2（若有重复 r1，currentFormRequest 仍命中第二个 r1）
      result.respond('r1', true)
      expect(result.currentFormRequest.value?.requestId).toBe('r2')

      // 5. respond(r1) 只发送一次
      const r1Calls = vi.mocked(sendExtensionUIResponse).mock.calls.filter((c) => c[1] === 'r1')
      expect(r1Calls).toHaveLength(1)

      dispose()
    })
  })

  describe('useExtensionUI T11 respond 未送达（M1 环 3 / RD-3#1 断连场景）', () => {
    it('send 返 false → removeRequest 不被调用、请求保留、toast 提示；send 恢复 true 后重发送达并出队', () => {
      const { respond, currentFormRequest } = useExtensionUI(ref('sessionA'))
      emitBusUIRequest('sessionA', mkAskUserReq('r-drop'))

      const store = useExtensionUIStore()
      const removeSpy = vi.spyOn(store, 'removeRequest')

      // 1. 断连期点提交：sendExtensionUIResponse 返 false（WS 非 OPEN 未送出）
      vi.mocked(sendExtensionUIResponse).mockReturnValueOnce(false)
      respond('r-drop', true)

      expect(sendExtensionUIResponse).toHaveBeenCalledWith('sessionA', 'r-drop', 'select', true)
      expect(removeSpy).not.toHaveBeenCalled() // 请求保留，不 remove
      expect(currentFormRequest.value?.requestId).toBe('r-drop') // FormOverlay 保留展示
      expect(store.getRequestsBySession('sessionA')).toHaveLength(1)
      // 用户可见提示（toast error，M1 环 3 要求的显形出口）
      const toast = useToast().toasts.value.find((t) => t.type === 'error')
      expect(toast?.message).toBe('回复未送达，连接恢复后可重新提交')

      // 2. 连接恢复（mock 恢复返 true）后用户再次提交：同 requestId 重投成功 → 出队
      respond('r-drop', true)
      expect(removeSpy).toHaveBeenCalledTimes(1)
      expect(currentFormRequest.value).toBeUndefined()
      expect(store.getRequestsBySession('sessionA')).toHaveLength(0)
      removeSpy.mockRestore()
    })

    it('cancel 同样走未送达保留（respond(null) 等价路径）', () => {
      const { cancel, currentFormRequest } = useExtensionUI(ref('sessionA'))
      emitBusUIRequest('sessionA', mkAskUserReq('r-cancel'))

      vi.mocked(sendExtensionUIResponse).mockReturnValueOnce(false)
      cancel('r-cancel')

      expect(sendExtensionUIResponse).toHaveBeenCalledWith('sessionA', 'r-cancel', 'select', null)
      expect(currentFormRequest.value?.requestId).toBe('r-cancel')
    })
  })
})

// ═══ 来源节：useExtensionUI-form-normalize.test.ts —— formFilter 判定矩阵 + view-ready 帧双路径 ═══
describe('useExtensionUI-form-normalize', () => {
  beforeEach(() => {
    resetUseExtensionUITestEnv(__testing.__resetExtensionBusSubscriptionForTesting)
  })

  const draft: ScheduleDraft = {
    kind: 'recurring',
    schedule: '0 9 * * *',
    prompt: '总结昨天的工作进展',
    models: ['m-1', 'm-2'],
    currentModel: 'm-1',
  }

  /** runtime event-adapter ASK_USER_MARKER 分支产出形状（legacy 归一上移后：form + type 推断映射） */
  function mkAskUserReq(requestId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      requestId,
      pluginId: 'p',
      kind: 'select',
      dialogKind: 'select',
      title: 't',
      form: true,
      formQuestions: [{ type: 'choice', header: 'db', question: '选哪个数据库?', options: [{ label: 'Postgres' }] }],
      allowCancel: true,
      ...overrides,
    }
  }

  /** runtime event-adapter SCHEDULE_CREATE_MARKER 分支产出形状（源键保留分流应答形状） */
  function mkScheduleCreateReq(requestId: string): Record<string, unknown> {
    return {
      requestId,
      pluginId: '',
      kind: 'select',
      dialogKind: 'select',
      form: true,
      scheduleCreate: true,
      scheduleDraft: draft,
    }
  }

  /** 假设性旧 runtime 产物：裸 legacy 键帧（无 form 键——归一上移后 runtime 不再产出） */
  function mkBareLegacyAskUserReq(requestId: string): Record<string, unknown> {
    return {
      requestId,
      pluginId: 'p',
      kind: 'select',
      dialogKind: 'select',
      title: 't',
      askUser: true,
      askUserQuestions: [{ header: 'db', question: '选哪个数据库?', options: [{ label: 'Postgres' }] }],
    }
  }

  /** 新 form 帧形状（runtime event-adapter UI_FORM_MARKER 分支） */
  function mkFormReq(requestId: string): Record<string, unknown> {
    return {
      requestId,
      pluginId: '',
      kind: 'select',
      dialogKind: 'select',
      form: true,
      formQuestions: [{ type: 'choice', header: 'db', question: '选哪个数据库?', options: [{ label: 'Postgres' }] }],
      allowCancel: true,
    }
  }

  function mkPlainSelectReq(requestId: string): Record<string, unknown> {
    return { requestId, pluginId: '', kind: 'select', dialogKind: 'select', title: '选择', options: ['a', 'b'] }
  }

  // ── formFilter 判定矩阵（G2 收敛终态：只认 form 键）──────────────────────

  describe('formFilter 判定矩阵（判定侧收敛：只认 form 键）', () => {
    it('form:true → 放行；裸 legacy 键 / 无标记 → 不命中', () => {
      expect(formFilter(mkFormReq('r1') as never as ExtensionUIRequest)).toBe(true)
      expect(formFilter(mkAskUserReq('r2') as never as ExtensionUIRequest)).toBe(true)
      // 裸 legacy 键（无 form 键——归一上移后 runtime 不再产出，假设性畸形帧）不命中
      expect(formFilter(mkBareLegacyAskUserReq('r3') as never as ExtensionUIRequest)).toBe(false)
      expect(formFilter(mkPlainSelectReq('r4') as never as ExtensionUIRequest)).toBe(false)
    })

    it('表单族帧（bus 路径）入 store 后恒带 form 键——formFilter 对 store 记录命中', () => {
      const { dispose } = runInExtensionUIScope(() => useExtensionUI(ref('sessionA')))
      emitBusUIRequest('sessionA', mkAskUserReq('r-ask'))
      emitBusUIRequest('sessionA', mkScheduleCreateReq('r-sc'))

      const records = useExtensionUIStore().getRequestsBySession('sessionA')
      expect(records).toHaveLength(2)
      for (const r of records) {
        expect(formFilter(r)).toBe(true) // runtime 产出的 view-ready 帧原生带 form 键
      }
      dispose()
    })
  })

  // ── C4 契约（归一上移 runtime：只消费 view-ready 帧）─────────────────────

  describe('C4 契约（renderer 只消费 view-ready 帧）', () => {
    it('裸 legacy 键帧（无 form 键，假设性旧 runtime 产物）→ C4 不放行不入 store', () => {
      const { dispose } = runInExtensionUIScope(() => useExtensionUI(ref('sessionA')))

      emitBusUIRequest('sessionA', mkBareLegacyAskUserReq('r-bare'))

      expect(useExtensionUIStore().getRequestsBySession('sessionA')).toHaveLength(0)
      dispose()
    })
  })

  // ── 双路径消费（bus / pending——归一层已删，view-ready 帧直接入队）─────────

  describe('bus 路径（runtime marker 分支产出的 view-ready 帧入队）', () => {
    it('scheduleCreate 源帧（draft 直挂）→ store 记录 form+scheduleCreate 双键、draft 保真', () => {
      const { result, dispose } = runInExtensionUIScope(() => useExtensionUI(ref('sessionA')))

      emitBusUIRequest('sessionA', mkScheduleCreateReq('r-sc'))

      const records = useExtensionUIStore().getRequestsBySession('sessionA')
      expect(records).toHaveLength(1)
      expect(records[0].form).toBe(true)
      expect(records[0].scheduleCreate).toBe(true)
      expect(records[0].scheduleDraft).toEqual(draft)
      expect(records[0].dialogKind).toBe('select')
      // currentFormRequest 命中（find 谓词 form 键）
      expect(result.currentFormRequest.value?.requestId).toBe('r-sc')
      dispose()
    })

    it('scheduleCreate 源帧 respond → 扁平 FormResult JSON 回传（今日 ScheduleCreateOverlay 路径等价）', async () => {
      const { result, dispose } = runInExtensionUIScope(() => useExtensionUI(ref('sessionA')))

      emitBusUIRequest('sessionA', mkScheduleCreateReq('r-sc'))
      const formResult = JSON.stringify({ action: 'create', kind: 'recurring', schedule: '0 9 * * *', prompt: 'p' })
      result.respond('r-sc', formResult)

      expect(vi.mocked(sendExtensionUIResponse)).toHaveBeenCalledWith('sessionA', 'r-sc', 'select', formResult)
      // respond 后出队
      expect(useExtensionUIStore().getRequestsBySession('sessionA')).toHaveLength(0)
      dispose()
    })

    it('无标记普通 select 不入 store（CompanionBand 独占，零重叠）', () => {
      const { dispose } = runInExtensionUIScope(() => useExtensionUI(ref('sessionA')))

      emitBusUIRequest('sessionA', mkPlainSelectReq('r2'))

      expect(useExtensionUIStore().getRequestsBySession('sessionA')).toHaveLength(0)
      dispose()
    })

    it('双源并存排序：askUser 源与 scheduleCreate 源并存 → 先到先渲染、respond 后接管', () => {
      const { result, dispose } = runInExtensionUIScope(() => useExtensionUI(ref('sessionA')))

      emitBusUIRequest('sessionA', mkAskUserReq('r-ask'))
      emitBusUIRequest('sessionA', mkScheduleCreateReq('r-sc'))

      expect(result.currentFormRequest.value?.requestId).toBe('r-ask')
      expect(result.currentFormRequest.value?.form).toBe(true)

      result.respond('r-ask', 'answer')
      expect(result.currentFormRequest.value?.requestId).toBe('r-sc')
      expect(result.currentFormRequest.value?.scheduleCreate).toBe(true)
      dispose()
    })
  })

  describe('pending 路径（runtime {...r,...r.payload} 解包的 view-ready 帧直接入队——respawn / 切回恢复）', () => {
    it('pending 拉取返回 askUser 源帧（runtime 已归一带 form 键）→ 放行入 store（respawn 恢复）', async () => {
      // respawn 场景：pi 挂起 select → 引擎崩溃 → respawn 完成 → renderer 重新订阅拉取
      // pending——runtime marker 分支产出的 payload 自带 form:true，pending 解包帧直接入队
      vi.mocked(getPendingRequests).mockResolvedValue([
        mkAskUserReq('r-recover') as never as ExtensionUIRequest,
      ])
      const { result, dispose } = runInExtensionUIScope(() => useExtensionUI(ref('sessionA')))

      await nextTick()
      await nextTick()

      expect(result.currentFormRequest.value?.requestId).toBe('r-recover')
      expect(result.currentFormRequest.value?.form).toBe(true)
      dispose()
    })

    it('pending 拉取返回 scheduler 源帧 → 同样放行（draft 保真）', async () => {
      vi.mocked(getPendingRequests).mockResolvedValue([
        mkScheduleCreateReq('r-sc-recover') as never as ExtensionUIRequest,
      ])
      const { result, dispose } = runInExtensionUIScope(() => useExtensionUI(ref('sessionA')))

      await nextTick()
      await nextTick()

      expect(result.currentFormRequest.value?.requestId).toBe('r-sc-recover')
      expect(result.currentFormRequest.value?.form).toBe(true)
      expect(result.currentFormRequest.value?.scheduleDraft).toEqual(draft)
      dispose()
    })

    it('pending 返回无标记普通帧 → 不命中 overlay 队列且不入 store 分区（快照补入富交互过滤，C4 语义不扩）', async () => {
      // MF-1-7 收敛后行为（对齐移动侧语义）：快照补入只入富交互帧（factory reconcile 过滤），
      // 普通 dialog 帧不进 store 分区（分区是富交互请求的权威消费副本——CompanionBand 消费的
      // 普通 dialog 帧走 bus 直连，不经 store）
      vi.mocked(getPendingRequests).mockResolvedValue([
        mkPlainSelectReq('r-plain') as never as ExtensionUIRequest,
      ])
      const { result, dispose } = runInExtensionUIScope(() => useExtensionUI(ref('sessionA')))

      await nextTick()
      await nextTick()

      expect(result.currentFormRequest.value).toBeUndefined()
      expect(useExtensionUIStore().getRequestsBySession('sessionA')).toHaveLength(0)
      dispose()
    })
  })
})

// ═══ 来源节：use-extension-ui-plan-review.test.ts —— planReview 分流（C4/D5/D9③/D4） ═══
describe('use-extension-ui-plan-review', () => {
  /** planReview 标记请求（runtime event-adapter 检测 PLAN_REVIEW_MARKER 后的广播形状，D5）；
   *  可带 selfReview（D9③，帧字段与 PlanReviewRequest.selfReview 同名同义） */
  function mkPlanReviewReq(requestId: string, selfReview?: string): Record<string, unknown> {
    return {
      requestId,
      pluginId: '',
      kind: 'select',
      dialogKind: 'select',
      title: '\x00TAIJI_PLAN_REVIEW:',
      options: [JSON.stringify({ docs: [], ...(selfReview !== undefined ? { selfReview } : {}) })],
      planReview: true,
      ...(selfReview !== undefined ? { selfReview } : {}),
    }
  }

  function mkAskUserReq(requestId: string): Record<string, unknown> {
    // runtime ASK_USER_MARKER 分支产出的 view-ready 帧形状（legacy 归一上移 runtime）
    return {
      requestId,
      pluginId: 'p',
      kind: 'select',
      dialogKind: 'select',
      title: 't',
      form: true,
      formQuestions: [{ type: 'text', header: 'q', question: 'q?' }],
      allowCancel: true,
    }
  }

  beforeEach(() => {
    planStoreTesting.__resetPlanReviewColdSinkForTesting()
    resetUseExtensionUITestEnv(__testing.__resetExtensionBusSubscriptionForTesting)
  })

  describe('planReview 分流：C4 放行入 store + 挂起可枚举', () => {
    it('planReview 标记请求入 store（C4 放行），planReviewFilter 实例按 requestId 枚举', () => {
      const { result, dispose } = runInExtensionUIScope(() =>
        useExtensionUI(ref('sess-A'), planReviewFilter),
      )
      const requests = result.currentPlanReviewRequests

      emitBusUIRequest('sess-A', mkPlanReviewReq('pr-1'))

      expect(requests.value).toHaveLength(1)
      expect(requests.value[0]?.requestId).toBe('pr-1')
      expect(isPlanReviewRequest(requests.value[0]!)).toBe(true)
      expect(requests.value[0]?.sessionId).toBe('sess-A')
      // store 分区可查（审批条外其他消费方 / 派生状态可枚举）
      const records = useExtensionUIStore().getRequestsBySession('sess-A')
      expect(records).toHaveLength(1)
      dispose()
    })

    it('formFilter 实例拒绝 planReview 请求（两标记互斥，一请求只归一面）', () => {
      const { result, dispose } = runInExtensionUIScope(() =>
        useExtensionUI(ref('sess-A'), formFilter),
      )

      emitBusUIRequest('sess-A', mkPlanReviewReq('pr-1'))

      // form 实例不入 planReview 请求，currentFormRequest 不受污染（表单类无回归）
      expect(useExtensionUIStore().getRequestsBySession('sess-A')).toHaveLength(0)
      expect(result.currentFormRequest.value).toBeUndefined()
      dispose()
    })

    it('表单请求不进 planReview 枚举（表单类行为无回归）', () => {
      // 两个消费方实例各持各的 filter：planReviewFilter 实例只枚举 planReview；
      // 表单入队回归由 formFilter 实例承载（互斥过滤是设计语义，不是丢失）
      const review = runInExtensionUIScope(() => useExtensionUI(ref('sess-A'), planReviewFilter))
      const form = runInExtensionUIScope(() => useExtensionUI(ref('sess-A'), formFilter))

      emitBusUIRequest('sess-A', mkAskUserReq('au-1'))

      expect(review.result.currentPlanReviewRequests.value).toHaveLength(0)
      expect(form.result.currentFormRequest.value?.requestId).toBe('au-1')
      expect(useExtensionUIStore().getRequestsBySession('sess-A').map((r) => r.requestId)).toEqual(['au-1'])
      review.dispose()
      form.dispose()
    })

    it('respond 按 requestId 精确回传 + 出队；payload 原样透传给 sendExtensionUIResponse', () => {
      const { result, dispose } = runInExtensionUIScope(() =>
        useExtensionUI(ref('sess-A'), planReviewFilter),
      )

      emitBusUIRequest('sess-A', mkPlanReviewReq('pr-1'))
      expect(result.currentPlanReviewRequests.value).toHaveLength(1)

      const payload = JSON.stringify({ decision: 'approve' })
      result.respond('pr-1', payload)

      expect(vi.mocked(sendExtensionUIResponse)).toHaveBeenCalledWith(
        'sess-A',
        'pr-1',
        'select',
        payload,
      )
      expect(result.currentPlanReviewRequests.value).toHaveLength(0)
      expect(useExtensionUIStore().getRequestsBySession('sess-A')).toHaveLength(0)
      dispose()
    })

    it('切 session 后枚举读新分区（Map 分区语义）', () => {
      const sid = ref<string | null>('sess-A')
      const { result, dispose } = runInExtensionUIScope(() => useExtensionUI(sid, planReviewFilter))

      emitBusUIRequest('sess-A', mkPlanReviewReq('pr-a'))
      expect(result.currentPlanReviewRequests.value).toHaveLength(1)

      sid.value = 'sess-B'
      expect(result.currentPlanReviewRequests.value).toHaveLength(0)

      sid.value = 'sess-A'
      expect(result.currentPlanReviewRequests.value.map((r) => r.requestId)).toEqual(['pr-a'])
      dispose()
    })
  })

  describe('pickPlanFields 白名单 selfReview 双入店路径契约（D9③）', () => {
    it('热帧路径：bus → toExtensionUIRequest 白名单搬运携带 selfReview', () => {
      const { result, dispose } = runInExtensionUIScope(() =>
        useExtensionUI(ref('sess-A'), planReviewFilter),
      )

      emitBusUIRequest('sess-A', mkPlanReviewReq('pr-1', '已核对 3 条需求全覆盖'))

      const req = result.currentPlanReviewRequests.value[0]
      expect(req?.selfReview).toBe('已核对 3 条需求全覆盖')
      expect(useExtensionUIStore().getRequestsBySession('sess-A')[0]).toMatchObject({
        requestId: 'pr-1',
        selfReview: '已核对 3 条需求全覆盖',
      })
      dispose()
    })

    it('热帧路径负向：非 string selfReview 不入店（检查即透传闸）', () => {
      const { result, dispose } = runInExtensionUIScope(() =>
        useExtensionUI(ref('sess-A'), planReviewFilter),
      )

      emitBusUIRequest('sess-A', { ...mkPlanReviewReq('pr-1'), selfReview: 42 })

      const req = result.currentPlanReviewRequests.value[0] as { selfReview?: unknown } | undefined
      expect(req?.selfReview).toBeUndefined()
      dispose()
    })

    it('冷补路径：getPendingRequests 快照全量解包携带 selfReview（切回 session 不丢自审行）', async () => {
      extensionDomainMocks.getPendingRequests.mockResolvedValue([
        { ...mkPlanReviewReq('pr-cold', '冷补自审结论'), receivedAt: Date.now() },
      ])
      const { result, dispose } = runInExtensionUIScope(() =>
        useExtensionUI(ref('sess-A'), planReviewFilter),
      )
      await Promise.resolve()
      await Promise.resolve()
      await nextTick()

      const req = result.currentPlanReviewRequests.value[0]
      expect(req?.requestId).toBe('pr-cold')
      expect(req?.selfReview).toBe('冷补自审结论')
      dispose()
    })
  })

  describe('D4 审批窗口漏斗接线（respond/失效置已应答标记；pending 到达解除）', () => {
    it('respond（planReview）→ markPlanReviewAnswered 置已应答标记；非 planReview respond 不置', () => {
      const plan = usePlanStore()
      plan.syncFocus('sess-A') // 窗口位断言读焦点分区（usePlanState 的 syncFocus 义务，本文件直驱）
      const { result, dispose } = runInExtensionUIScope(() =>
        useExtensionUI(ref('sess-A'), planReviewFilter),
      )

      emitBusUIRequest('sess-A', mkPlanReviewReq('pr-1'))
      expect(plan.planReviewAckMarked).toBe(false)

      result.respond('pr-1', JSON.stringify({ decision: 'dismiss' }))
      expect(plan.planReviewAckMarked).toBe(true)

      // 新 planReview pending 到达 → 解除（ready 优先于抑制）
      emitBusUIRequest('sess-A', mkPlanReviewReq('pr-2'))
      expect(plan.planReviewAckMarked).toBe(false)
      dispose()
    })

    it('requestsInvalidated 摘除 planReview → 同置已应答标记（turn abort / /plan abort 解散源）', () => {
      const plan = usePlanStore()
      plan.syncFocus('sess-A')
      runInExtensionUIScope(() => useExtensionUI(ref('sess-A'), planReviewFilter))

      emitBusUIRequest('sess-A', mkPlanReviewReq('pr-1'))
      busSlot.current!.emit({ kind: 'requests-invalidated', sessionId: 'sess-A', requestIds: ['pr-1'], reason: 'turn-aborted' } as never)

      expect(plan.planReviewAckMarked).toBe(true)
    })

    it('多挂起异常形态：respond 其中一条 → 镜像按 registry 现值保持 true + 已应答标记置起', () => {
      const plan = usePlanStore()
      plan.syncFocus('sess-A')
      const { result, dispose } = runInExtensionUIScope(() =>
        useExtensionUI(ref('sess-A'), planReviewFilter),
      )

      emitBusUIRequest('sess-A', mkPlanReviewReq('pr-1'))
      emitBusUIRequest('sess-A', mkPlanReviewReq('pr-2'))
      result.respond('pr-1', JSON.stringify({ decision: 'dismiss' }))

      // registry 仍有 pr-2 → 镜像保持 true（markPlanReviewAnswered 不得覆写为 false）
      expect(result.currentPlanReviewRequests.value.map((r) => r.requestId)).toEqual(['pr-2'])
      expect(plan.planReviewPendingKnown).toBe(true)
      expect(plan.planReviewAckMarked).toBe(true)
      dispose()
    })
  })
})

// ═══ 来源节：use-btw-interaction.test.ts —— btw 内联确认条纯函数群直测 ═══
describe('use-btw-interaction', () => {
  const { toScheduleDraft, toBarQuestionKind, toBarQuestionBase, toBarOptions, toBarQuestion, questionsOf } = btwInteractionTesting

  /** ExtensionUIRequest 最小合法骨架（questionsOf 形参；其余用例直接喂 unknown） */
  function formReq(overrides: Partial<ExtensionUIRequest>): ExtensionUIRequest {
    return { sessionId: 'pi-line-1', requestId: 'r1', dialogKind: 'select', ...overrides } // 线 session id（W4a 后 = pi 真实 id）
  }

  describe('toScheduleDraft（schedule 草稿形状检查）', () => {
    it('合法 once 草稿：必填三字段透传，可选字段缺省即省略（无 undefined 键）', () => {
      expect(toScheduleDraft({ kind: 'once', schedule: '2026-09-24T09:00', prompt: '跑巡检' }))
        .toEqual({ kind: 'once', schedule: '2026-09-24T09:00', prompt: '跑巡检' })
    })

    it('合法 recurring 草稿：model/name/expires 可选字段按类型守卫透传', () => {
      expect(
        toScheduleDraft({
          kind: 'recurring',
          schedule: '0 9 * * *',
          prompt: 'p',
          model: 'prov/m',
          name: '日常',
          expires: '2026-12-31',
        }),
      ).toEqual({
        kind: 'recurring',
        schedule: '0 9 * * *',
        prompt: 'p',
        model: 'prov/m',
        name: '日常',
        expires: '2026-12-31',
      })
    })

    it('非对象（string/number/null/undefined）→ null', () => {
      expect(toScheduleDraft('once')).toBeNull()
      expect(toScheduleDraft(42)).toBeNull()
      expect(toScheduleDraft(null)).toBeNull()
      expect(toScheduleDraft(undefined)).toBeNull()
    })

    it('kind 越界 → null；schedule/prompt 非字符串 → null', () => {
      expect(toScheduleDraft({ kind: 'daily', schedule: '0 9 * * *', prompt: 'p' })).toBeNull()
      expect(toScheduleDraft({ kind: 'once', schedule: 9, prompt: 'p' })).toBeNull()
      expect(toScheduleDraft({ kind: 'once', schedule: '0 9 * * *', prompt: null })).toBeNull()
    })

    it('可选字段类型不符（model 非字符串）→ 该字段剔除，不伪造', () => {
      expect(toScheduleDraft({ kind: 'once', schedule: 's', prompt: 'p', model: 1 }))
        .toEqual({ kind: 'once', schedule: 's', prompt: 'p' })
    })
  })

  describe('toBarQuestionKind（choice/text/schedule 闭集收窄）', () => {
    it('三个合法值原样放行', () => {
      expect(toBarQuestionKind('choice')).toBe('choice')
      expect(toBarQuestionKind('text')).toBe('text')
      expect(toBarQuestionKind('schedule')).toBe('schedule')
    })

    it('闭集外（未知类型/undefined/大小写不符）→ null', () => {
      expect(toBarQuestionKind('boolean')).toBeNull()
      expect(toBarQuestionKind(undefined)).toBeNull()
      expect(toBarQuestionKind('Choice')).toBeNull()
    })
  })

  describe('toBarQuestionBase（header/question 双检查基底）', () => {
    it('双有 → 透传；仅 question → header 省略；仅 header → question 落空串', () => {
      expect(toBarQuestionBase({ header: 'H', question: 'Q' }, 'text'))
        .toEqual({ type: 'text', header: 'H', question: 'Q' })
      expect(toBarQuestionBase({ question: 'Q' }, 'text')).toEqual({ type: 'text', question: 'Q' })
      expect(toBarQuestionBase({ header: 'H' }, 'choice')).toEqual({ type: 'choice', header: 'H', question: '' })
    })

    it('header/question 双缺 → null（非法项，空串键不可答）', () => {
      expect(toBarQuestionBase({}, 'text')).toBeNull()
    })
  })

  describe('toBarOptions（choice 选项数组归一）', () => {
    it('合法数组：label 保留 + description 类型守卫可选透传', () => {
      expect(
        toBarOptions([
          { label: 'A' },
          { label: 'B', description: '更快' },
          { label: 'C', description: 42 },
        ]),
      ).toEqual([{ label: 'A' }, { label: 'B', description: '更快' }, { label: 'C' }])
    })

    it('非数组 → 空数组（题保留，仅选项降级为空）', () => {
      expect(toBarOptions(undefined)).toEqual([])
      expect(toBarOptions('A')).toEqual([])
    })

    it('非法项剔除：非对象项 / 缺 label 项不进结果', () => {
      expect(
        toBarOptions([
          'raw-string',
          null,
          42,
          { description: '无 label' },
          { label: '有效' },
        ]),
      ).toEqual([{ label: '有效' }])
    })
  })

  describe('toBarQuestion（formQuestions 逐项归一）', () => {
    it('choice 题：options 归一 + multi 显式 true + allowOther 缺省 true / 显式 false', () => {
      expect(
        toBarQuestion({
          type: 'choice',
          header: '模型',
          question: '选哪个',
          options: [{ label: 'A' }, { noLabel: true }, 'junk'],
          multi: true,
        }),
      ).toEqual({
        type: 'choice',
        header: '模型',
        question: '选哪个',
        options: [{ label: 'A' }],
        multi: true,
        allowOther: true,
      })
      expect(
        toBarQuestion({ type: 'choice', question: 'Q', options: [], allowOther: false }),
      ).toMatchObject({ allowOther: false })
    })

    it('text 题：无 options/multi/allowOther 键（降档单行输入即可答）', () => {
      expect(toBarQuestion({ type: 'text', question: '说明', options: [{ label: 'X' }] }))
        .toEqual({ type: 'text', question: '说明' })
    })

    it('schedule 题：initial 有效透传；无效（缺字段）→ initial 键省略', () => {
      expect(
        toBarQuestion({ type: 'schedule', question: '排程', initial: { kind: 'once', schedule: 's', prompt: 'p' } }),
      ).toEqual({
        type: 'schedule',
        question: '排程',
        initial: { kind: 'once', schedule: 's', prompt: 'p' },
      })
      expect(toBarQuestion({ type: 'schedule', question: '排程', initial: { kind: 'daily' } }))
        .toEqual({ type: 'schedule', question: '排程' })
    })

    it('非法项 → null：非对象 / type 越界 / header+question 双缺', () => {
      expect(toBarQuestion('junk')).toBeNull()
      expect(toBarQuestion(null)).toBeNull()
      expect(toBarQuestion({ type: 'boolean', question: 'Q' })).toBeNull()
      expect(toBarQuestion({ type: 'text', header: undefined, question: '' })).toBeNull()
    })
  })

  describe('questionsOf（questions 源优先 + legacy 包装）', () => {
    it('formQuestions 源：合法项保留、非法项剔除（与 runtime isFormQuestion 同策略）', () => {
      const qs = questionsOf(
        formReq({
          form: true,
          formQuestions: [
            { type: 'choice', question: '选哪个', options: [{ label: 'A' }, 'junk'] },
            { type: 'boolean', question: '越界类型' },
            { type: 'text' }, // header/question 双缺
            'raw-junk',
            { type: 'text', question: '说明' },
          ],
        }),
      )
      expect(qs).toHaveLength(2)
      expect(qs[0]).toMatchObject({ type: 'choice', question: '选哪个', options: [{ label: 'A' }] })
      expect(qs[1]).toEqual({ type: 'text', question: '说明' })
    })

    it('questions 优先级：formQuestions 有合法项时忽略 legacy scheduleCreate/scheduleDraft', () => {
      const qs = questionsOf(
        formReq({
          form: true,
          formQuestions: [{ type: 'text', question: 'Q' }],
          scheduleCreate: true,
          scheduleDraft: { kind: 'once', schedule: 's', prompt: 'p' },
        }),
      )
      expect(qs).toEqual([{ type: 'text', question: 'Q' }])
    })

    it('legacy scheduleCreate 源：合法 draft → 包装单 schedule 问（question 空串 + initial 预填）', () => {
      expect(
        questionsOf(
          formReq({
            form: true,
            scheduleCreate: true,
            scheduleDraft: { kind: 'recurring', schedule: '0 9 * * *', prompt: 'p', model: 'm' },
          }),
        ),
      ).toEqual([
        { type: 'schedule', question: '', initial: { kind: 'recurring', schedule: '0 9 * * *', prompt: 'p', model: 'm' } },
      ])
    })

    it('formQuestions 全非法 → 回退 legacy 源；scheduleCreate 缺省 / draft 无效 → 空集', () => {
      // 全非法 questions 落空后 legacy 兜底接管
      expect(
        questionsOf(
          formReq({
            form: true,
            formQuestions: [{ type: 'boolean' }, 'junk'],
            scheduleCreate: true,
            scheduleDraft: { kind: 'once', schedule: 's', prompt: 'p' },
          }),
        ),
      ).toEqual([{ type: 'schedule', question: '', initial: { kind: 'once', schedule: 's', prompt: 'p' } }])
      // scheduleCreate 未置位 → 不包装
      expect(
        questionsOf(formReq({ form: true, scheduleDraft: { kind: 'once', schedule: 's', prompt: 'p' } })),
      ).toEqual([])
      // scheduleCreate 置位但 draft 无效 → 不包装
      expect(questionsOf(formReq({ form: true, scheduleCreate: true, scheduleDraft: { kind: 'daily' } }))).toEqual([])
      // 无任何源
      expect(questionsOf(formReq({ form: true }))).toEqual([])
    })
  })
})
