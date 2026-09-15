/**
 * gen-stats.test.ts — composer-gen-stats 协议登记契约校验
 *
 * docs/design/composer-gen-stats.md §3.4（接口与数据模型）/ §3.3 D4（帧/RPC 协议决策）
 * 的类型一致性测试，验证：
 *  - 新帧 session.stats_update 在 ServerMessageType 联合 + ServerMessageMapBase 有精确登记
 *    （防 payload 漂移——漏登记会落 Record<string, unknown> 占位，消费侧被迫 as）
 *  - 新 RPC session.getGenStats 在 ClientMessageType 联合 + ClientMessageMap + ReplyPayloadMap
 *    三处登记，reply = session.stats_update payload 同形（payload 消费型）
 *  - GenStatsSpeed / GenStatsCacheRatio / GenStatsFrame 字段与设计 §3.4 逐字一致
 *    （speed 4 字段、cacheRatio 2 字段均 number|null；sessionId 必填、model 可选）
 *  - null 编码纪律（D4）：null = 无数据，0 = 真实测量值，两者运行时可区分
 *
 * 模式与 protocol-seq.test.ts 一致（本目录在 tsconfig include:["src"] 内——编译期断言
 * 经 `pnpm --filter @taiji/shared typecheck` 机器强制，非仅编辑器期提示）：
 * 编译期 AssertHasKey/AssertExtends/AssertExact（tsc --noEmit 保证）+ 运行期对象字面量
 * 可赋值断言（vitest）。纯类型层，零运行时依赖，无 fs 操作。
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
} from '../protocol'
import type { GenStatsSpeed, GenStatsCacheRatio, GenStatsFrame } from '../gen-stats'

// ── 编译期类型断言辅助（同 protocol.test.ts / protocol-seq.test.ts 模式）──
// AssertHasKey/AssertExtends：条件类型求值为 true，仅在编译期校验「key 存在 / 子类型关系成立」；
// 若断言不成立，tsc --noEmit（pnpm --filter @taiji/shared typecheck）报错。
// AssertExact：双向子类型断言（精确相等）——单向 extends 抓不住「字段丢了 null」（number 仍
// extends number|null），双向才能保证与设计 §3.4 逐字一致。

type AssertHasKey<T, K extends keyof T> = true
type AssertExtends<A, B> = A extends B ? true : ['ERROR: A does not extend B', A, B]
type AssertExact<A, B> = [A] extends [B]
  ? ([B] extends [A] ? true : ['ERROR: B does not extend A', B, A])
  : ['ERROR: A does not extend B', A, B]

// ── 帧登记：ServerMessageType 联合 + ServerMessageMapBase 精确 payload ──
type _Assert_Frame_union = AssertExtends<'session.stats_update', ServerMessageType>
type _Assert_Frame_map_key = AssertHasKey<ServerMessageMapBase, 'session.stats_update'>
type _Assert_Frame_payload_exact = AssertExact<ServerMessageMapBase['session.stats_update'], GenStatsFrame>

// ── RPC 登记：ClientMessageType 联合 + ClientMessageMap + ReplyPayloadMap 三处 ──
type _Assert_Rpc_union = AssertExtends<'session.getGenStats', ClientMessageType>
type _Assert_Rpc_map_key = AssertHasKey<ClientMessageMap, 'session.getGenStats'>
type _Assert_Rpc_payload_exact = AssertExact<ClientMessageMap['session.getGenStats'], { sessionId: string }>
type _Assert_Rpc_reply_key = AssertHasKey<ReplyPayloadMap, 'session.getGenStats'>
// reply = session.stats_update payload 同形（D4：恢复腿，无任何数据时 speed/cacheRatio 全 null + model 缺省）
type _Assert_Rpc_reply_shape = AssertExtends<ReplyPayloadMap['session.getGenStats'], GenStatsFrame>

// ── 类型字段与设计 §3.4 逐字一致（键集合 + 字段类型均精确断言）──
type _Assert_Speed_keys = AssertExact<keyof GenStatsSpeed, 'current' | 'day' | 'd7' | 'd30'>
type _Assert_Speed_current = AssertExact<GenStatsSpeed['current'], number | null>
type _Assert_Speed_day = AssertExact<GenStatsSpeed['day'], number | null>
type _Assert_Speed_d7 = AssertExact<GenStatsSpeed['d7'], number | null>
type _Assert_Speed_d30 = AssertExact<GenStatsSpeed['d30'], number | null>

type _Assert_Cache_keys = AssertExact<keyof GenStatsCacheRatio, 'current' | 'day'>
type _Assert_Cache_current = AssertExact<GenStatsCacheRatio['current'], number | null>
type _Assert_Cache_day = AssertExact<GenStatsCacheRatio['day'], number | null>

type _Assert_Frame_keys = AssertExact<keyof GenStatsFrame, 'sessionId' | 'speed' | 'cacheRatio' | 'model'>
type _Assert_Frame_sessionId = AssertExact<GenStatsFrame['sessionId'], string>
type _Assert_Frame_speed = AssertExact<GenStatsFrame['speed'], GenStatsSpeed>
type _Assert_Frame_cacheRatio = AssertExact<GenStatsFrame['cacheRatio'], GenStatsCacheRatio>
type _Assert_Frame_model_optional = AssertExact<GenStatsFrame['model'], string | undefined>

// ── 编译期强制执行点 ──
// TS 对未被消费的类型别名不做诊断（false 条件类型静默通过，实验证实：约束违反 TS2344 会拦，
// 而 AssertExact 失败不拦）——AssertExtends/AssertExact 断言必须经泛型约束消费才被 tsc
// 机器强制。任一断言不成立 → 该行 TS2344（exact 断言的 ERROR tuple 会带出双方类型，可读）。
// 运行期仅返回常量 true，零成本。（AssertHasKey 类断言由类型参数约束在声明处自强制，无需消费。）
const _enforceTrue = <T extends true>(_v?: T): true => true
const _genStatsProtocolAssertsEnforced = [
  _enforceTrue<_Assert_Frame_union>(),
  _enforceTrue<_Assert_Frame_payload_exact>(),
  _enforceTrue<_Assert_Rpc_union>(),
  _enforceTrue<_Assert_Rpc_payload_exact>(),
  _enforceTrue<_Assert_Rpc_reply_shape>(),
  _enforceTrue<_Assert_Speed_keys>(),
  _enforceTrue<_Assert_Speed_current>(),
  _enforceTrue<_Assert_Speed_day>(),
  _enforceTrue<_Assert_Speed_d7>(),
  _enforceTrue<_Assert_Speed_d30>(),
  _enforceTrue<_Assert_Cache_keys>(),
  _enforceTrue<_Assert_Cache_current>(),
  _enforceTrue<_Assert_Cache_day>(),
  _enforceTrue<_Assert_Frame_keys>(),
  _enforceTrue<_Assert_Frame_sessionId>(),
  _enforceTrue<_Assert_Frame_speed>(),
  _enforceTrue<_Assert_Frame_cacheRatio>(),
  _enforceTrue<_Assert_Frame_model_optional>(),
]
void _genStatsProtocolAssertsEnforced

// ── 运行期测试（payload 可赋值 + null/0 语义可区分）──────────────────

describe('session.stats_update 帧登记', () => {
  it('全 null 帧（无任何数据恢复腿形态）可构造，model 缺省', () => {
    const msg: ServerMessage<'session.stats_update'> = {
      type: 'session.stats_update',
      id: 'rpc-1',
      payload: {
        sessionId: 's1',
        speed: { current: null, day: null, d7: null, d30: null },
        cacheRatio: { current: null, day: null },
      },
    }
    expect(msg.type).toBe('session.stats_update')
    expect(msg.payload.sessionId).toBe('s1')
    expect(msg.payload.speed.current).toBeNull()
    expect(msg.payload.speed.d30).toBeNull()
    expect(msg.payload.cacheRatio.day).toBeNull()
    expect(msg.payload.model).toBeUndefined()
  })

  it('有数据帧可构造：0 = 真实测量值（非 null 占位），model 回填', () => {
    const msg: ServerMessage<'session.stats_update'> = {
      type: 'session.stats_update',
      seq: 7,
      payload: {
        sessionId: 's1',
        speed: { current: 0, day: 28.4, d7: 22, d30: 19 },
        cacheRatio: { current: 0, day: 87 },
        model: 'zai-coding-cn/glm-5.3',
      },
    }
    expect(msg.payload.speed.current).toBe(0)
    expect(msg.payload.cacheRatio.current).toBe(0)
    expect(msg.payload.speed.day).toBe(28.4)
    expect(msg.payload.model).toBe('zai-coding-cn/glm-5.3')
  })

  it('null 与 0 运行时可区分（无值编码纪律：禁止把无数据伪装成测得 0）', () => {
    const noData: GenStatsSpeed = { current: null, day: null, d7: null, d30: null }
    const measuredZero: GenStatsSpeed = { current: 0, day: null, d7: null, d30: null }
    expect(noData.current === null).toBe(true)
    expect(measuredZero.current === null).toBe(false)
    expect(measuredZero.current === 0).toBe(true)
  })

  it('ServerMessageUnion 判别联合形态含本帧且 payload 收窄', () => {
    const member: ServerMessageUnion = {
      type: 'session.stats_update',
      payload: {
        sessionId: 's1',
        speed: { current: 35, day: null, d7: null, d30: null },
        cacheRatio: { current: 91, day: 87 },
        model: 'm',
      },
    }
    expect(member.type).toBe('session.stats_update')
    if (member.type === 'session.stats_update') {
      expect(member.payload.speed.current).toBe(35)
    }
  })
})

describe('session.getGenStats RPC 登记', () => {
  it('request payload 仅含 sessionId，可作 ClientMessage 构造', () => {
    const msg: ClientMessage = {
      type: 'session.getGenStats',
      id: 'req-1',
      payload: { sessionId: 's1' },
    }
    expect(msg.type).toBe('session.getGenStats')
    expect(msg.payload.sessionId).toBe('s1')
  })

  it('reply 与 session.stats_update payload 同形（payload 消费型）', () => {
    const reply: ReplyPayloadMap['session.getGenStats'] = {
      sessionId: 's1',
      speed: { current: 35, day: 28, d7: 22, d30: 19 },
      cacheRatio: { current: 91, day: 87 },
      model: 'xiaomi-token-plan-cn/mimo-v2.5-pro',
    }
    expect(reply.model).toBe('xiaomi-token-plan-cn/mimo-v2.5-pro')
    // 无任何数据时：全 null + model 缺省（D4 恢复腿兜底形态）
    const empty: ReplyPayloadMap['session.getGenStats'] = {
      sessionId: 's1',
      speed: { current: null, day: null, d7: null, d30: null },
      cacheRatio: { current: null, day: null },
    }
    expect(empty.model).toBeUndefined()
    expect(empty.speed.current).toBeNull()
  })
})
