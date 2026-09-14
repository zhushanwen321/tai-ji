/**
 * RPC 类型配对契约测试（方案 C 精简版）。
 *
 * 验证 ReplyPayloadMap + command() 类型化的正确性。结合三种手段：
 * - assignment compile checks（赋值给类型化变量证明 shape conformance）
 * - @ts-expect-error 负向用例（证明类型约束生效）
 * - grep 结构断言（证明 domain 零手写 register）
 *
 * 类型断言靠 vue-tsc --noEmit（typecheck）验证，非 vitest run。
 * grep 断言靠 vitest run 验证。
 *
 * 与 pi-protocol-contract.test.ts 同模式（assignment + @ts-expect-error + grep）。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ClientMessageMap, ReplyPayloadMap, ServerMessageMap } from '@xyz-agent/shared'
import { command, RPC_BACKSTOP_TIMEOUT_MS } from '@xyz-agent/core/transport/api'

const __dirname = dirname(fileURLToPath(import.meta.url))
// [tc-transport-consolidation u5] domain 真源已迁 core（壳 api/domains 仅剩 settings IPC 门面），
// 扫描目标跟随真源，守卫强度不变。
const domainsDir = resolve(__dirname, '../../../../core/src/transport/api/domains')

/**
 * 类型用例的运行时调用统一包装：测试环境无 WS 连接，transport.send 必然 fast-fail
 * reject（code='disconnected'）。本文件只验证编译期类型契约，挂 catch 消化 rejection
 * 防 unhandled rejection。泛型签名与 command 一致，返回类型推导（Awaited<typeof p>）不受影响。
 * 注意：用例内挂在 p 上的 .then 链仍需自带 .catch——then 产生的派生 promise 在 p reject
 * 时同样 reject，无人处理仍会报 unhandled。
 */
function silentCommand<K extends keyof ReplyPayloadMap>(
  type: K,
  payload: ClientMessageMap[K],
): Promise<ReplyPayloadMap[K]> {
  // timeoutMs 必传化（D5/G5）后本文件只验证编译期类型契约，超时值不参与断言——统一传 backstop
  const p = command(type, payload, RPC_BACKSTOP_TIMEOUT_MS)
  void p.catch(() => {})
  return p
}

// ════════════════════════════════════════════════════════════════════════
// U1: ReplyPayloadMap key 完整性（覆盖所有 RPC request type）
// ════════════════════════════════════════════════════════════════════════

describe('U1: ReplyPayloadMap — key 覆盖 RPC request type', () => {
  it('session.switch 映射存在且为 session.switched（R-11 瘦身：无 messages，前端不读 payload）', () => {
    // wave:perf-w20（R-11）：session.switch 的 reply 拆分为 session.switched
    // （{ sessionId, session }，不再全量 getHistory 塞 messages——历史消费路径是
    // selectSession 内显式 session.history RPC）。前端 switchSession 返回 void 不读 payload。
    type SwitchReply = ReplyPayloadMap['session.switch']
    // 编译期形状断言：含 session、不含 messages/historyTruncated（瘦身锁定）
    const hasSession: 'session' extends keyof SwitchReply ? true : false = true
    const hasMessages: 'messages' extends keyof SwitchReply ? true : false = false
    const hasTruncated: 'historyTruncated' extends keyof SwitchReply ? true : false = false
    expect(hasSession).toBe(true)
    expect(hasMessages).toBe(false)
    expect(hasTruncated).toBe(false)
  })

  it('session.history 映射存在且含窗口契约（[u6] legacy historyTruncated 退役，truncated 唯一标志）', () => {
    type HistoryReply = ReplyPayloadMap['session.history']
    const sample: HistoryReply = {
      sessionId: 's1',
      messages: [],
      truncated: false,
      loadedTurns: 0,
      totalTurnsEstimate: 0,
    }
    // session 字段 optional（switch 路径有，history 路径无）；legacy 字段编译期锁定已删
    const hasLegacyTruncated: 'historyTruncated' extends keyof HistoryReply ? true : false = false
    expect(hasLegacyTruncated).toBe(false)
    expect(sample.messages).toEqual([])
    expect(sample.truncated).toBe(false)
  })

  it('git.stage 映射为 void（ack 型）', () => {
    type StageReply = ReplyPayloadMap['git.stage']
    const _check: StageReply = undefined as void
    expect(_check).toBeUndefined()
  })

  it('file.read 映射含 content + truncated（payload 消费型）', () => {
    type ReadReply = ReplyPayloadMap['file.read']
    const sample: ReadReply = {
      sessionId: 's1',
      content: 'hello',
      truncated: false,
      path: '/x',
    }
    expect(sample.content).toBe('hello')
  })

  it('plugin.* 9 个 RPC key 全部映射存在（W20：ReplyPayloadMap SSOT 完整性）', () => {
    // plugin-message-handler.ts 对 9 个 plugin.* 请求都发了 reply，ReplyPayloadMap 必须全部登记。
    // 此处只断言「key 存在且类型可赋值」——具体 shape 由 ServerMessageMap['config.plugins']/
    // ['plugin:config']/['pong'] 定义，下面三个 it 分别精确校验。
    type PluginKeys =
      | 'plugin.list' | 'plugin.toggle' | 'plugin.uninstall' | 'plugin.install'
      | 'plugin.approvePermissions' | 'plugin.revokePermissions'
      | 'plugin.executeCommand' | 'plugin.config.get' | 'plugin.config.set'
    // 把 ReplyPayloadMap 收窄到这 9 个 key，若任一缺失编译报错（编译期防御）。
    type PluginSubset = Pick<ReplyPayloadMap, PluginKeys>
    const _check: PluginSubset = {
      'plugin.list': undefined as unknown as ReplyPayloadMap['plugin.list'],
      'plugin.toggle': undefined as unknown as ReplyPayloadMap['plugin.toggle'],
      'plugin.uninstall': undefined as unknown as ReplyPayloadMap['plugin.uninstall'],
      'plugin.install': undefined as unknown as ReplyPayloadMap['plugin.install'],
      'plugin.approvePermissions': undefined as unknown as ReplyPayloadMap['plugin.approvePermissions'],
      'plugin.revokePermissions': undefined as unknown as ReplyPayloadMap['plugin.revokePermissions'],
      'plugin.executeCommand': undefined as unknown as ReplyPayloadMap['plugin.executeCommand'],
      'plugin.config.get': undefined as unknown as ReplyPayloadMap['plugin.config.get'],
      'plugin.config.set': undefined as unknown as ReplyPayloadMap['plugin.config.set'],
    }
    expect(Object.keys(_check)).toHaveLength(9)
  })

  it('plugin.list/toggle/uninstall/install/approve/revoke 映射到 config.plugins（含 plugins 字段）', () => {
    // 6 个变更型请求都 reply 'config.plugins' { plugins }（plugin-message-handler.ts:31/35/39/43/47/71）
    type PluginsReply = ReplyPayloadMap['plugin.list']
    const sample: PluginsReply = { plugins: [] }
    expect(sample.plugins).toEqual([])
    // 同类型引用一致性（任取其一即可代表其余 5 个）
    const _t1: ReplyPayloadMap['plugin.toggle'] = sample
    const _t2: ReplyPayloadMap['plugin.uninstall'] = sample
    const _t3: ReplyPayloadMap['plugin.install'] = sample
    const _t4: ReplyPayloadMap['plugin.approvePermissions'] = sample
    const _t5: ReplyPayloadMap['plugin.revokePermissions'] = sample
    void [_t1, _t2, _t3, _t4, _t5]
  })

  it('plugin.executeCommand 映射到 pong（ack 型，无 payload 字段）', () => {
    type PongReply = ReplyPayloadMap['plugin.executeCommand']
    const sample: PongReply = {}
    expect(sample).toEqual({})
  })

  it('plugin.config.get/set 映射到 plugin:config（含 pluginId + config）', () => {
    // plugin-message-handler.ts:56/61 reply { pluginId, config }
    type ConfigReply = ReplyPayloadMap['plugin.config.get']
    const sample: ConfigReply = { pluginId: 'demo', config: { enabled: true } }
    expect(sample.pluginId).toBe('demo')
    expect(sample.config).toEqual({ enabled: true })
    const _setCheck: ReplyPayloadMap['plugin.config.set'] = sample
    void _setCheck
  })
})

// ════════════════════════════════════════════════════════════════════════
// U2: command() payload 类型约束（负向：传错字段编译期报错）
// ════════════════════════════════════════════════════════════════════════

describe('U2: command() — payload 受 ClientMessageMap[K] 约束', () => {
  it('session.history 接受 { sessionId }', () => {
    // 正向：合法 payload
    const p = silentCommand('session.history', { sessionId: 's1' })
    expect(p).toBeInstanceOf(Promise)
  })

  it('session.history 拒绝 { content }（字段不存在）', () => {
    // 负向：session.history 的 payload 是 { sessionId }，不接受 content
    // @ts-expect-error — content 不在 ClientMessageMap['session.history'] 的 payload 里
    silentCommand('session.history', { content: 'x' })
    expect.assertions(0) // 类型级用例：@ts-expect-error 由 typecheck:test 兜住，运行时仅验证不抛
  })

  it('message.send 接受 { sessionId, content }', () => {
    const p = silentCommand('message.send', { sessionId: 's1', content: 'hi' })
    expect(p).toBeInstanceOf(Promise)
  })

  it('message.send 拒绝缺 content', () => {
    // @ts-expect-error — message.send payload 必须含 content
    silentCommand('message.send', { sessionId: 's1' })
    expect.assertions(0) // 类型级用例：@ts-expect-error 由 typecheck:test 兜住，运行时仅验证不抛
  })
})

// ════════════════════════════════════════════════════════════════════════
// U3: command() 返回类型推导（ack 型 void / payload 型具体字段）
// ════════════════════════════════════════════════════════════════════════

describe('U3: command() — 返回类型从 ReplyPayloadMap[K] 推导', () => {
  it('git.stage 返回 Promise<void>（ack 型）', () => {
    const p = silentCommand('git.stage', { sessionId: 's1', filePaths: ['/x'] })
    // ack 型返回 void，不能读 .status
    type Ret = Awaited<typeof p>
    const _check: Ret = undefined as void
    expect(_check).toBeUndefined()
  })

  it('git.stage 返回值读 .status 编译报错（void 无 status）', () => {
    const p = silentCommand('git.stage', { sessionId: 's1', filePaths: ['/x'] })
    // @ts-expect-error — void 类型无 status 属性
    void p.then((r) => r.status).catch(() => {})
    expect.assertions(0) // 类型级用例：@ts-expect-error 由 typecheck:test 兜住，运行时仅验证不抛
  })

  it('session.history 返回 Promise<含 messages>', () => {
    const p = silentCommand('session.history', { sessionId: 's1' })
    void p.then((r) => {
      // r 是 ReplyPayloadMap['session.history']，可读 messages
      expect(Array.isArray(r.messages)).toBe(true)
    }).catch(() => {})
  })
})

// ════════════════════════════════════════════════════════════════════════
// U4: ServerMessageMap 补条目让 reply() 泛型生效
// ════════════════════════════════════════════════════════════════════════

describe('U4: ServerMessageMap — RPC reply 条目已收紧（非兜底 Record<string,unknown>）', () => {
  it('session.history 的 payload 含窗口契约字段（非兜底；[u6] legacy historyTruncated 退役）', () => {
    // 若走兜底 Record<string,unknown>，赋值给具体类型变量会报错（unknown 不可赋值）
    type HistoryPayload = ServerMessageMap['session.history']
    const sample: HistoryPayload = {
      sessionId: 's1',
      messages: [],
      truncated: false,
      loadedTurns: 0,
      totalTurnsEstimate: 0,
    }
    expect(sample.truncated).toBe(false)
    expect(sample.loadedTurns).toBe(0)
  })
})

// ════════════════════════════════════════════════════════════════════════
// U5: domain 零手写 pending.register（grep 结构断言）
// ════════════════════════════════════════════════════════════════════════

describe('U5: domain 层零手写 pending.register 泛型', () => {
  it('所有 domain 文件不含 pending.register 调用（改用 command）', () => {
    const files = readdirSync(domainsDir).filter((f) => f.endsWith('.ts'))
    const offenders: string[] = []
    for (const f of files) {
      const content = readFileSync(resolve(domainsDir, f), 'utf-8')
      // 允许 pending.register 出现在 request.ts 内部，但 domain 层不应有
      if (/pending\.register</.test(content)) {
        offenders.push(f)
      }
    }
    expect(offenders).toEqual([])
  })

  it('domain 层使用 command() 而非 request()（W2 改名后）', () => {
    const files = readdirSync(domainsDir).filter((f) => f.endsWith('.ts'))
    const offenders: string[] = []
    for (const f of files) {
      const content = readFileSync(resolve(domainsDir, f), 'utf-8')
      // 不应再有裸 request( 调用（已改名 command）
      if (/\brequest\s*\(/.test(content)) {
        // 排除注释和类型定义里的 request 字样
        const lines = content.split('\n').filter(
          (l) => /\brequest\s*\(/.test(l) && !l.trim().startsWith('//') && !l.trim().startsWith('*'),
        )
        if (lines.length > 0) offenders.push(`${f}: ${lines.length}处`)
      }
    }
    expect(offenders).toEqual([])
  })
})
