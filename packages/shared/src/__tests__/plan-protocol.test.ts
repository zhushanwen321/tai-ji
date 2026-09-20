/**
 * plan-protocol.test.ts — plan 模式重设计协议登记契约校验
 *
 * 验证 plan 模式投影面（D1-⑥ 冷启动首拉 + D5 退出命令）三面登记完整：
 *  - 新帧 session.planState 在 ServerMessageType 联合 + ServerMessageMapBase 有精确登记
 *    （防 payload 漂移——漏登记会落 Record<string, unknown> 占位，消费侧被迫 as）
 *  - 新 RPC session.getPlanState / session.abortPlan 在 ClientMessageType 联合 +
 *    ClientMessageMap + ReplyPayloadMap 三处登记；getPlanState reply 复用
 *    session.planState 广播 payload（getSubagents 先例），abortPlan 为 ack 型
 *  - PlanStateView 字段与 plan-state entry schema 一致：四必填 + 三 optional——
 *    optional 性是 D4 向后兼容契约（旧 entry 无新字段，前端逐字段判存在降级），
 *    optional 改必填 = 旧 session 重开派生 View 缺字段编译红，本测试机器拦截
 *  - PlanDocMeta 四字段（与 @zhushanwen/extension-protocol core/types 同形，
 *    shared 最底层包不能反向依赖，漂移由本测试 + 双端注释互指守卫）
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

// ── PlanStateView 字段契约：四必填 + 三 optional（optional 性 = D4 向后兼容契约）──
type _Assert_View_keys = AssertExact<keyof PlanStateView, 'isActive' | 'planFilePath' | 'requirement' | 'templateName' | 'skills' | 'docs' | 'reviewState'>
type _Assert_View_isActive = AssertExact<PlanStateView['isActive'], boolean>
type _Assert_View_planFilePath = AssertExact<PlanStateView['planFilePath'], string | null>
type _Assert_View_requirement = AssertExact<PlanStateView['requirement'], string | null>
type _Assert_View_templateName = AssertExact<PlanStateView['templateName'], string | null>
// 三个扩展字段的 optional 编码精确断言：`skills?: string[]` 的字段类型是 `string[] | undefined`
//（改必填会在此 TS2344 红——旧 entry 派生的 View 无新字段，缺字段即兼容破坏）
type _Assert_View_skills_optional = AssertExact<PlanStateView['skills'], string[] | undefined>
type _Assert_View_docs_optional = AssertExact<PlanStateView['docs'], PlanDocMeta[] | undefined>
type _Assert_View_reviewState_optional = AssertExact<PlanStateView['reviewState'], 'awaiting' | 'revising' | undefined>

// ── PlanDocMeta 四字段（与 extension-protocol core/types PlanDocMeta 同形）──
type _Assert_Doc_keys = AssertExact<keyof PlanDocMeta, 'fileName' | 'absPath' | 'sourceSkill' | 'version'>
type _Assert_Doc_fileName = AssertExact<PlanDocMeta['fileName'], string>
type _Assert_Doc_absPath = AssertExact<PlanDocMeta['absPath'], string>
type _Assert_Doc_sourceSkill = AssertExact<PlanDocMeta['sourceSkill'], string>
type _Assert_Doc_version = AssertExact<PlanDocMeta['version'], number>

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
  _enforceTrue<_Assert_Doc_keys>(),
  _enforceTrue<_Assert_Doc_fileName>(),
  _enforceTrue<_Assert_Doc_absPath>(),
  _enforceTrue<_Assert_Doc_sourceSkill>(),
  _enforceTrue<_Assert_Doc_version>(),
]
void _planProtocolAssertsEnforced

// ── 运行期测试（payload 可赋值 + 旧/新 schema 两种 View 形态）──────────────────

describe('session.planState 帧登记', () => {
  it('新 schema View（七字段全量）可构造广播帧', () => {
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
        },
      },
    }
    expect(msg.payload.planState.isActive).toBe(true)
    expect(msg.payload.planState.skills).toEqual(['tech-design', 'dev-flow'])
    expect(msg.payload.planState.docs?.[0]?.version).toBe(1)
    expect(msg.payload.planState.reviewState).toBe('awaiting')
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
