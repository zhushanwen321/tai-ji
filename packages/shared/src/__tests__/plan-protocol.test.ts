/**
 * plan-protocol.test.ts — plan 模式重设计协议登记契约校验
 *
 * 验证 plan 模式投影面（D1-⑥ 冷启动首拉 + D5 退出命令）三面登记完整：
 *  - 新帧 session.planState 在 ServerMessageType 联合 + ServerMessageMapBase 有精确登记
 *    （防 payload 漂移——漏登记会落 Record<string, unknown> 占位，消费侧被迫 as）
 *  - 新 RPC session.getPlanState / session.abortPlan 在 ClientMessageType 联合 +
 *    ClientMessageMap + ReplyPayloadMap 三处登记；getPlanState reply 复用
 *    session.planState 广播 payload（getSubagents 先例），abortPlan 为 ack 型
 *  - PlanStateView 字段与 plan-state entry schema 一致：四必填 + 四 optional——
 *    optional 性是 D4 向后兼容契约（旧 entry 无新字段，前端逐字段判存在降级），
 *    optional 改必填 = 旧 session 重开派生 View 缺字段编译红，本测试机器拦截。
 *    reviewStateSource（降级态来源标记，plan-mode-ux-refactor §3.4）旧 entry 必无——
 *    重放兼容断言用 __tests__/fixtures/plan-state-entries.ts 的旧 entry fixture
 *    （含 awaiting reviewState、无 reviewStateSource，可被后续单元复用导出）
 *  - PlanDocMeta 与 @zhushanwen/extension-protocol core/types 的 PlanDocMeta 跨包同形：
 *    devDependency 引对侧做编译期 AssertExact 双向断言（单侧改字段即红），
 *    另保留字面量绝对锚点断言防两侧同步漂移。devDep 不构成运行时反向依赖
 *    （shared 是 private 包不发布；import type 编译期剥除，vitest 运行期零加载）
 *
 * 模式与 gen-stats.test.ts 一致（本目录在 tsconfig include:["src"] 内——编译期断言
 * 经 tsc --noEmit 机器强制，非仅编辑器期提示）：
 * 编译期 AssertHasKey/AssertExtends/AssertExact + 运行期对象字面量可赋值断言（vitest）。
 * 纯类型层，零运行时依赖，无 fs 操作。
 *
 * 运行：cd packages/shared && pnpm run typecheck && npx vitest run
 */
import { describe, it, expect } from 'vitest'
import type {
  ClientMessage,
  ClientMessageType,
  ClientMessageMap,
  ServerMessage,
  ServerMessageType,
  ServerMessageMapBase,
  ServerMessageUnion,
  ReplyPayloadMap,
  PlanStateView,
  PlanDocMeta,
} from '../protocol'
// 对侧同形契约源：跨包断言的另一半（devDependency，仅类型消费）
import type { PlanDocMeta as ProtocolPlanDocMeta } from '@zhushanwen/extension-protocol'
// 旧 entry 重放 fixture（升级前落盘形态：awaiting reviewState + 无 reviewStateSource）
import { LEGACY_AWAITING_PLAN_STATE_ENTRY, LEGACY_AWAITING_PLAN_STATE_VIEW } from './fixtures/plan-state-entries'

// ── 编译期类型断言辅助（同 gen-stats.test.ts / protocol-seq.test.ts 模式）──

type AssertHasKey<T, K extends keyof T> = true
type AssertExtends<A, B> = A extends B ? true : ['ERROR: A does not extend B', A, B]
type AssertExact<A, B> = [A] extends [B]
  ? ([B] extends [A] ? true : ['ERROR: B does not extend A', B, A])
  : ['ERROR: A does not extend B', A, B]

// ── 广播帧登记：ServerMessageType 联合 + ServerMessageMapBase 精确 payload ──
type _Assert_Frame_union = AssertExtends<'session.planState', ServerMessageType>
type _Assert_Frame_map_key = AssertHasKey<ServerMessageMapBase, 'session.planState'>
type _Assert_Frame_payload_exact = AssertExact<
  ServerMessageMapBase['session.planState'],
  { sessionId: string; planState: PlanStateView }
>

// ── RPC 登记：ClientMessageType 联合 + ClientMessageMap + ReplyPayloadMap 三处 ──
type _Assert_GetPlanState_union = AssertExtends<'session.getPlanState', ClientMessageType>
type _Assert_GetPlanState_map_key = AssertHasKey<ClientMessageMap, 'session.getPlanState'>
type _Assert_GetPlanState_payload_exact = AssertExact<ClientMessageMap['session.getPlanState'], { sessionId: string }>
type _Assert_GetPlanState_reply_key = AssertHasKey<ReplyPayloadMap, 'session.getPlanState'>
// reply 复用广播 payload（getSubagents → session.subagents 复用先例）
type _Assert_GetPlanState_reply_shape = AssertExact<ReplyPayloadMap['session.getPlanState'], ServerMessageMapBase['session.planState']>

type _Assert_AbortPlan_union = AssertExtends<'session.abortPlan', ClientMessageType>
type _Assert_AbortPlan_map_key = AssertHasKey<ClientMessageMap, 'session.abortPlan'>
type _Assert_AbortPlan_payload_exact = AssertExact<ClientMessageMap['session.abortPlan'], { sessionId: string }>
type _Assert_AbortPlan_reply_key = AssertHasKey<ReplyPayloadMap, 'session.abortPlan'>
// ack 型（状态变化经投影链广播推回，reply 仅确认命令受理——session.forceQuit 同构）
type _Assert_AbortPlan_reply_void = AssertExact<ReplyPayloadMap['session.abortPlan'], void>

// ── PlanStateView 字段契约：四必填 + 四 optional（optional 性 = D4 向后兼容契约）──
type _Assert_View_keys = AssertExact<keyof PlanStateView, 'isActive' | 'planFilePath' | 'requirement' | 'templateName' | 'skills' | 'docs' | 'reviewState' | 'reviewStateSource'>
type _Assert_View_isActive = AssertExact<PlanStateView['isActive'], boolean>
type _Assert_View_planFilePath = AssertExact<PlanStateView['planFilePath'], string | null>
type _Assert_View_requirement = AssertExact<PlanStateView['requirement'], string | null>
type _Assert_View_templateName = AssertExact<PlanStateView['templateName'], string | null>
// 四个扩展字段的 optional 编码精确断言：`skills?: string[]` 的字段类型是 `string[] | undefined`
//（改必填会在此 TS2344 红——旧 entry 派生的 View 无新字段，缺字段即兼容破坏）
type _Assert_View_skills_optional = AssertExact<PlanStateView['skills'], string[] | undefined>
type _Assert_View_docs_optional = AssertExact<PlanStateView['docs'], PlanDocMeta[] | undefined>
type _Assert_View_reviewState_optional = AssertExact<PlanStateView['reviewState'], 'awaiting' | 'revising' | undefined>
type _Assert_View_reviewStateSource_optional = AssertExact<PlanStateView['reviewStateSource'], 'resubmit' | undefined>
// 反向锚点：'explain' 交互已删，联合仅 'resubmit'（旧 entry 存量 'explain' 由 runtime 投影
// 归无值）——若有人把 'explain' 加回联合，下方 @ts-expect-error 无错可压即编译红
// @ts-expect-error reviewStateSource 不接受已删除的 'explain'
const _rejectExplainSource: PlanStateView['reviewStateSource'] = 'explain'
void _rejectExplainSource

// ── PlanDocMeta 四字段（与 extension-protocol core/types PlanDocMeta 同形）──
// 字面量断言是绝对锚点（防两侧同步漂移）；跨包 AssertExact 是相对断言
// （单侧改字段/改类型/改 optional 性即红——extension-protocol 侧漂移在此拦截）。
type _Assert_Doc_keys = AssertExact<keyof PlanDocMeta, 'fileName' | 'absPath' | 'sourceSkill' | 'version'>
type _Assert_Doc_fileName = AssertExact<PlanDocMeta['fileName'], string>
type _Assert_Doc_absPath = AssertExact<PlanDocMeta['absPath'], string>
type _Assert_Doc_sourceSkill = AssertExact<PlanDocMeta['sourceSkill'], string>
type _Assert_Doc_version = AssertExact<PlanDocMeta['version'], number>
// 本体 AssertExact 抓必填字段增删/类型改名；optional 字段漂移（一侧多出 `x?: T`）
// 不破坏 interface 双向 extends，须由 keyof 联合精确相等兜住
type _Assert_Doc_cross_package = AssertExact<PlanDocMeta, ProtocolPlanDocMeta>
type _Assert_Doc_cross_package_keys = AssertExact<keyof PlanDocMeta, keyof ProtocolPlanDocMeta>

// ── 编译期强制执行点（AssertExtends/AssertExact 须经泛型约束消费才被 tsc 机器强制）──
const _enforceTrue = <T extends true>(_v?: T): true => true
const _planProtocolAssertsEnforced = [
  _enforceTrue<_Assert_Frame_union>(),
  _enforceTrue<_Assert_Frame_payload_exact>(),
  _enforceTrue<_Assert_GetPlanState_union>(),
  _enforceTrue<_Assert_GetPlanState_payload_exact>(),
  _enforceTrue<_Assert_GetPlanState_reply_shape>(),
  _enforceTrue<_Assert_AbortPlan_union>(),
  _enforceTrue<_Assert_AbortPlan_payload_exact>(),
  _enforceTrue<_Assert_AbortPlan_reply_void>(),
  _enforceTrue<_Assert_View_keys>(),
  _enforceTrue<_Assert_View_isActive>(),
  _enforceTrue<_Assert_View_planFilePath>(),
  _enforceTrue<_Assert_View_requirement>(),
  _enforceTrue<_Assert_View_templateName>(),
  _enforceTrue<_Assert_View_skills_optional>(),
  _enforceTrue<_Assert_View_docs_optional>(),
  _enforceTrue<_Assert_View_reviewState_optional>(),
  _enforceTrue<_Assert_View_reviewStateSource_optional>(),
  _enforceTrue<_Assert_Doc_keys>(),
  _enforceTrue<_Assert_Doc_fileName>(),
  _enforceTrue<_Assert_Doc_absPath>(),
  _enforceTrue<_Assert_Doc_sourceSkill>(),
  _enforceTrue<_Assert_Doc_version>(),
  _enforceTrue<_Assert_Doc_cross_package>(),
  _enforceTrue<_Assert_Doc_cross_package_keys>(),
]
void _planProtocolAssertsEnforced

// ── 运行期测试（payload 可赋值 + 旧/新 schema 两种 View 形态）──────────────────

describe('session.planState 帧登记', () => {
  it('新 schema View（八字段全量）可构造广播帧', () => {
    const msg: ServerMessage<'session.planState'> = {
      type: 'session.planState',
      seq: 1,
      payload: {
        sessionId: 's1',
        planState: {
          isActive: true,
          planFilePath: '/tmp/plan.md',
          requirement: '重构 auth 模块',
          templateName: 'tech-design',
          skills: ['tech-design', 'dev-flow'],
          docs: [{ fileName: 'design.md', absPath: '/tmp/design.md', sourceSkill: 'tech-design', version: 1 }],
          reviewState: 'awaiting',
          reviewStateSource: 'resubmit',
        },
      },
    }
    expect(msg.payload.planState.isActive).toBe(true)
    expect(msg.payload.planState.skills).toEqual(['tech-design', 'dev-flow'])
    expect(msg.payload.planState.docs?.[0]?.version).toBe(1)
    expect(msg.payload.planState.reviewState).toBe('awaiting')
    expect(msg.payload.planState.reviewStateSource).toBe('resubmit')
  })

  it('旧 schema View（仅四字段，三扩展字段缺省）可构造——D4 向后兼容', () => {
    const msg: ServerMessage<'session.planState'> = {
      type: 'session.planState',
      payload: {
        sessionId: 's1',
        planState: {
          isActive: true,
          planFilePath: '/tmp/plan.md',
          requirement: '旧 session 需求',
          templateName: 'default',
        },
      },
    }
    expect(msg.payload.planState.skills).toBeUndefined()
    expect(msg.payload.planState.docs).toBeUndefined()
    expect(msg.payload.planState.reviewState).toBeUndefined()
  })

  it('ServerMessageUnion 判别联合形态含本帧且 payload 收窄', () => {
    const member: ServerMessageUnion = {
      type: 'session.planState',
      payload: {
        sessionId: 's1',
        planState: { isActive: false, planFilePath: null, requirement: null, templateName: null },
      },
    }
    if (member.type === 'session.planState') {
      expect(member.payload.planState.isActive).toBe(false)
    } else {
      expect.unreachable('判别联合收窄失败')
    }
  })
})

describe('旧 entry 重放兼容（reviewStateSource 缺省 = 消费方惰性）', () => {
  it('fixture 保真：旧 entry 含 awaiting reviewState 且无 reviewStateSource 键（升级前落盘形态）', () => {
    const data = LEGACY_AWAITING_PLAN_STATE_ENTRY.data
    expect(data.reviewState).toBe('awaiting')
    expect('reviewStateSource' in data).toBe(false)
  })

  it('旧 entry 的 View 投影可构造广播帧与 reply——缺字段可赋值（编译期）+ 读值 undefined（运行期）', () => {
    // LEGACY_AWAITING_PLAN_STATE_VIEW 字面量无 reviewStateSource 键，可赋值给
    // ServerMessage 帧 payload 与 reply payload = 「旧 View 形态兼容新契约」编译证明；
    // 消费方惰性 = 字段缺失不炸、读值 undefined（渲染通用降级文案，不猜测来源）
    const msg: ServerMessage<'session.planState'> = {
      type: 'session.planState',
      seq: 1,
      payload: { sessionId: 's1', planState: LEGACY_AWAITING_PLAN_STATE_VIEW },
    }
    const reply: ReplyPayloadMap['session.getPlanState'] = {
      sessionId: 's1',
      planState: LEGACY_AWAITING_PLAN_STATE_VIEW,
    }
    expect(msg.payload.planState.reviewState).toBe('awaiting')
    expect(msg.payload.planState.reviewStateSource).toBeUndefined()
    expect('reviewStateSource' in msg.payload.planState).toBe(false)
    expect('reviewStateSource' in reply.planState).toBe(false)
    // 旧 entry 其余字段照常透传（兼容 ≠ 丢弃）
    expect(msg.payload.planState.isActive).toBe(true)
    expect(msg.payload.planState.docs?.[0]?.fileName).toBe('plan.md')
  })
})

describe('session.getPlanState / session.abortPlan RPC 登记', () => {
  it('getPlanState request 仅含 sessionId，可作 ClientMessage 构造', () => {
    const msg: ClientMessage = {
      type: 'session.getPlanState',
      id: 'req-1',
      payload: { sessionId: 's1' },
    }
    expect(msg.type).toBe('session.getPlanState')
    expect(msg.payload.sessionId).toBe('s1')
  })

  it('getPlanState reply 与 session.planState 广播 payload 同形（payload 消费型）', () => {
    const reply: ReplyPayloadMap['session.getPlanState'] = {
      sessionId: 's1',
      planState: {
        isActive: true,
        planFilePath: '/tmp/plan.md',
        requirement: null,
        templateName: null,
        reviewState: 'awaiting',
      },
    }
    expect(reply.planState.reviewState).toBe('awaiting')
  })

  it('abortPlan request 仅含 sessionId，reply 为 ack 型 void', () => {
    const msg: ClientMessage = {
      type: 'session.abortPlan',
      id: 'req-2',
      payload: { sessionId: 's1' },
    }
    expect(msg.type).toBe('session.abortPlan')
    expect(msg.payload.sessionId).toBe('s1')
    const reply: ReplyPayloadMap['session.abortPlan'] = undefined
    expect(reply).toBeUndefined()
  })
})
