// @vitest-environment node
import { chat } from '@/api';
import { useChat, resetChatModuleState } from '@/composables/features/chat/useChat';
import { useLoadMoreHistory } from '@/composables/panel/useLoadMoreHistory';
import { isAbsolutePath, resolvePreviewPath } from '@/lib/path-utils';
import { useChatStore } from '@/stores/chat';
import { COMPAT_PRESETS, getPresetsForApi } from '@taiji/core';
import { command, RPC_BACKSTOP_TIMEOUT_MS } from '@taiji/core/transport/api';
import type { ClientMessageMap, ReplyPayloadMap, ServerMessageMap, Message } from '@taiji/shared';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPinia, setActivePinia } from 'pinia';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { nextTick, ref } from 'vue';

// wave3 簇 [renderer/node] 2 文件
/**
 * 合并产物（round6 Wave3 机械合并，环境/簇信息见来源横幅）。
 * 重名顶层标识符已加 _mN 后缀；相对 import 已按产物位置改写。
 * 来源文件：
 * - __tests__/api/transport-node-bundle.test.ts
 * - __tests__/composables/load-more-history.test.ts
 */

// ======================================================================
// ← __tests__/api/transport-node-bundle.test.ts
// ======================================================================

// ═══ 来源：api/rpc-type-pairing.test.ts ═══
const __dirname = dirname(fileURLToPath(import.meta.url))
// [tc-transport-consolidation u5] domain 真源已迁 core（壳 api/domains 仅剩 settings IPC 门面），
// 扫描目标跟随真源，检查强度不变。
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

  it('plugin.* 10 个 RPC key 全部映射存在（W20：ReplyPayloadMap SSOT 完整性）', () => {
    // plugin-message-handler.ts 对 10 个 plugin.* 请求都发了 reply，ReplyPayloadMap 必须全部登记。
    // 此处只断言「key 存在且类型可赋值」——具体 shape 由 ServerMessageMap['config.plugins']/
    // ['plugin:config']/['pong'] 定义，下面三个 it 分别精确校验。
    type PluginKeys =
      | 'plugin.list' | 'plugin.toggle' | 'plugin.uninstall' | 'plugin.install'
      | 'plugin.approvePermissions' | 'plugin.revokePermissions' | 'plugin.denyPermissions'
      | 'plugin.executeCommand' | 'plugin.config.get' | 'plugin.config.set'
    // 把 ReplyPayloadMap 收窄到这 10 个 key，若任一缺失编译报错（编译期防御）。
    type PluginSubset = Pick<ReplyPayloadMap, PluginKeys>
    const _check: PluginSubset = {
      'plugin.list': undefined as unknown as ReplyPayloadMap['plugin.list'],
      'plugin.toggle': undefined as unknown as ReplyPayloadMap['plugin.toggle'],
      'plugin.uninstall': undefined as unknown as ReplyPayloadMap['plugin.uninstall'],
      'plugin.install': undefined as unknown as ReplyPayloadMap['plugin.install'],
      'plugin.approvePermissions': undefined as unknown as ReplyPayloadMap['plugin.approvePermissions'],
      'plugin.revokePermissions': undefined as unknown as ReplyPayloadMap['plugin.revokePermissions'],
      'plugin.denyPermissions': undefined as unknown as ReplyPayloadMap['plugin.denyPermissions'],
      'plugin.executeCommand': undefined as unknown as ReplyPayloadMap['plugin.executeCommand'],
      'plugin.config.get': undefined as unknown as ReplyPayloadMap['plugin.config.get'],
      'plugin.config.set': undefined as unknown as ReplyPayloadMap['plugin.config.set'],
    }
    expect(Object.keys(_check)).toHaveLength(10)
  })

  it('plugin.list/toggle/uninstall/install 映射到 config.plugins（含 plugins 字段）', () => {
    // 4 个列表查询/变更型请求 reply 'config.plugins' { plugins }（plugin-message-handler.ts 分发表）
    type PluginsReply = ReplyPayloadMap['plugin.list']
    const sample: PluginsReply = { plugins: [] }
    expect(sample.plugins).toEqual([])
    // 同类型引用一致性（任取其一即可代表其余 3 个）
    const _t1: ReplyPayloadMap['plugin.toggle'] = sample
    const _t2: ReplyPayloadMap['plugin.uninstall'] = sample
    const _t3: ReplyPayloadMap['plugin.install'] = sample
    void [_t1, _t2, _t3]
  })

  it('plugin 权限三命令（approve/revoke/deny）映射到 pong（ack 型，列表刷新经广播）', () => {
    // 权限命令 reply pong {}（对齐 plugin.executeCommand 先例）；插件列表刷新经
    // config.plugins 广播（approve 触发 activate 状态变化时由 plugin-service 广播）
    const sample: ReplyPayloadMap['plugin.approvePermissions'] = {}
    expect(sample).toEqual({})
    const _t1: ReplyPayloadMap['plugin.revokePermissions'] = sample
    const _t2: ReplyPayloadMap['plugin.denyPermissions'] = sample
    void [_t1, _t2]
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

// ═══ 来源：settings/compat-presets.test.ts ═══
describe('compat 预设配置（COMPAT_PRESETS）', () => {
  describe('getPresetsForApi 按 api 类型过滤', () => {
    it('openai-completions 返回 5 个预设（DeepSeek/GLM/Kimi-K2/Kimi-K3/MiMo）', () => {
      const presets = getPresetsForApi('openai-completions')
      expect(presets).toHaveLength(5)
      const ids = presets.map(p => p.id)
      expect(ids).toEqual(['deepseek', 'glm', 'kimiK2', 'kimiK3', 'mimo'])
    })

    it('anthropic-messages 返回 1 个预设（MiniMax）', () => {
      const presets = getPresetsForApi('anthropic-messages')
      expect(presets).toHaveLength(1)
      expect(presets[0]!.id).toBe('minimax')
    })

    it('openai-responses 无预设（返回空数组）', () => {
      expect(getPresetsForApi('openai-responses')).toEqual([])
    })

    it('api 为 undefined/未知时返回空数组', () => {
      expect(getPresetsForApi(undefined)).toEqual([])
      expect(getPresetsForApi('unknown-api')).toEqual([])
    })
  })

  describe('各预设的 compat 配置正确性（调研结论固化）', () => {
    // 不用非空断言 `!`：preset id 被删/改名时，find 返回 undefined，后续 `.compat` 会抛晦涩的
    // "Cannot read properties of undefined"。这里显式 expect，失败时给出可定位的诊断信息。
    const findPreset = (id: string) => {
      const p = COMPAT_PRESETS.find(p => p.id === id)
      expect(p, `preset "${id}" not found in COMPAT_PRESETS`).toBeDefined()
      return p!
    }

    it('DeepSeek: thinkingFormat=deepseek + 支持 reasoning_effort + 需回传 reasoning_content', () => {
      const compat = findPreset('deepseek').compat
      expect(compat.thinkingFormat).toBe('deepseek')
      expect(compat.supportsDeveloperRole).toBe(false)
      expect(compat.supportsReasoningEffort).toBe(true)
      // 国产 reasoning 模型共性：多轮工具调用需回传 reasoning_content，否则 400
      expect(compat.requiresReasoningContentOnAssistantMessages).toBe(true)
    })

    it('GLM (z.ai): thinkingFormat=zai + 不支持 reasoning_effort', () => {
      const compat = findPreset('glm').compat
      expect(compat.thinkingFormat).toBe('zai')
      expect(compat.supportsDeveloperRole).toBe(false)
      expect(compat.supportsReasoningEffort).toBe(false)
    })

    it('Kimi K2.x: thinkingFormat=deepseek + 不支持 reasoning_effort', () => {
      // K2.x 与 DeepSeek 同形（thinking:{type}），但不支持 effort
      const compat = findPreset('kimiK2').compat
      expect(compat.thinkingFormat).toBe('deepseek')
      expect(compat.supportsDeveloperRole).toBe(false)
      expect(compat.supportsReasoningEffort).toBe(false)
    })

    it('Kimi K3: thinkingFormat=openai + 支持 reasoning_effort（与 K2.x 必须区分）', () => {
      // K3 走纯 reasoning_effort（openai 格式），不能发 thinking 参数
      const compat = findPreset('kimiK3').compat
      expect(compat.thinkingFormat).toBe('openai')
      expect(compat.supportsDeveloperRole).toBe(false)
      expect(compat.supportsReasoningEffort).toBe(true)
    })

    it('MiMo: thinkingFormat=qwen-chat-template（chat_template_kwargs.enable_thinking）', () => {
      const compat = findPreset('mimo').compat
      expect(compat.thinkingFormat).toBe('qwen-chat-template')
      expect(compat.supportsDeveloperRole).toBe(false)
      expect(compat.supportsReasoningEffort).toBe(false)
    })

    it('MiniMax: 走 anthropic-messages API + forceAdaptiveThinking', () => {
      const preset = findPreset('minimax')
      expect(preset.api).toBe('anthropic-messages')
      expect(preset.compat.forceAdaptiveThinking).toBe(true)
    })
  })

  describe('国产模型共性约束', () => {
    it('所有 openai-completions 预设都设 supportsDeveloperRole=false（国产 API 不认 developer 角色）', () => {
      const presets = getPresetsForApi('openai-completions')
      for (const p of presets) {
        expect(p.compat.supportsDeveloperRole).toBe(false)
      }
    })

    it('所有预设的 api 字段与 COMPAT_PRESETS 声明一致', () => {
      for (const p of COMPAT_PRESETS) {
        expect(['openai-completions', 'anthropic-messages', 'openai-responses']).toContain(p.api)
      }
    })
  })

  /**
   * COMPAT_PRESETS 是静态数据，被 CompatEditor 读取并通过 i18n key（settings.compat.preset.<id>）
   * 渲染 label/hint。任一字段缺失会导致运行时 undefined 或 i18n 回退到 key 原文。这里固化数据形状契约，
   * 防止后续手改时静默破坏（如删 id、空 compat、api 写错枚举值）。
   */
  describe('COMPAT_PRESETS 数据形状契约', () => {
    it('每个 preset 有非空字符串 id、合法 api 枚举、且 compat 为非空对象', () => {
      expect(COMPAT_PRESETS.length, 'COMPAT_PRESETS 不应为空').toBeGreaterThan(0)
      const seenIds: string[] = []
      for (const p of COMPAT_PRESETS) {
        expect(typeof p.id, `preset id 应为字符串，实际为 ${typeof p.id}`).toBe('string')
        expect(p.id.length, 'preset id 不应为空字符串').toBeGreaterThan(0)
        expect(seenIds, `preset id "${p.id}" 重复`).not.toContain(p.id)
        seenIds.push(p.id)

        expect(p.api, `preset "${p.id}" 的 api 必须是合法枚举值`).toBeOneOf([
          'openai-completions',
          'anthropic-messages',
          'openai-responses',
        ])

        expect(p.compat, `preset "${p.id}" 的 compat 应为对象`).toBeTypeOf('object')
        expect(p.compat, `preset "${p.id}" 的 compat 不应为 null`).not.toBeNull()
        expect(Object.keys(p.compat).length, `preset "${p.id}" 的 compat 不应为空对象`).toBeGreaterThan(0)
      }
    })
  })
})

// ═══ 来源：lib/path-utils.test.ts ═══
describe('isAbsolutePath', () => {
  it('U1: 识别 Unix 绝对路径', () => {
    expect(isAbsolutePath('/var/tmp/x.md')).toBe(true)
  })

  it('U2: 识别 Windows 盘符路径', () => {
    expect(isAbsolutePath('C:\\Users\\x.md')).toBe(true)
  })

  it('U3: 识别家目录路径', () => {
    expect(isAbsolutePath('~/x.md')).toBe(true)
  })

  it('U4: 相对路径返回 false', () => {
    expect(isAbsolutePath('src/x.md')).toBe(false)
  })
})

describe('resolvePreviewPath', () => {
  it('U5: 绝对路径在 cwd 内时返回相对路径', () => {
    const result = resolvePreviewPath('/project', '/project/src/main.ts')
    expect(result.absolute).toBe('/project/src/main.ts')
    expect(result.relative).toBe('src/main.ts')
  })

  it('U6: 相对路径解析为绝对路径并返回相对路径', () => {
    const result = resolvePreviewPath('/project', 'src/main.ts')
    expect(result.absolute).toBe('/project/src/main.ts')
    expect(result.relative).toBe('src/main.ts')
  })

  it('U7: 绝对路径在 cwd 外时 relative 为 null', () => {
    const result = resolvePreviewPath('/project', '/var/tmp/x.md')
    expect(result.absolute).toBe('/var/tmp/x.md')
    expect(result.relative).toBeNull()
  })
})

describe('Windows / ~ 路径补充（原 path-utils-improve.test.ts 并入）', () => {
  it('U-imp-1: C:\\project\\src\\main.ts under C:\\project → relative src/main.ts', () => {
    const result = resolvePreviewPath('C:\\project', 'C:\\project\\src\\main.ts')
    expect(result.absolute).toBe('C:\\project\\src\\main.ts')
    expect(result.relative).toBe('src/main.ts')
  })

  it('U-imp-1b: Windows path with mixed separators → 归一化正斜杠', () => {
    const result = resolvePreviewPath('C:/project', 'C:\\project\\src\\main.ts')
    expect(result.relative).toBe('src/main.ts')
  })

  it('U-imp-2: ~ path is absolute and relative is null', () => {
    expect(isAbsolutePath('~/Code/foo.md')).toBe(true)
    const result = resolvePreviewPath('/Users/me/project', '~/Code/foo.md')
    expect(result.absolute).toBe('~/Code/foo.md')
    expect(result.relative).toBeNull()
  })
})

// ======================================================================
// ← __tests__/composables/load-more-history.test.ts
// ======================================================================

// mock @/api 的 chat domain（getHistory 游标参数是 [u6] 新增）
vi.mock('@/api', async () => {
  const actual = await vi.importActual<typeof import('@/api')>('@/api')
  return {
    ...actual,
    chat: {
      ...actual.chat,
      getHistory: vi.fn(),
    },
  }
})

function makeMessage(id: string, content: string, piEntryId?: string): Message {
  return piEntryId !== undefined
    ? { id, piEntryId, role: 'user', content, status: 'complete', timestamp: Date.now() }
    : { id, role: 'user', content, status: 'complete', timestamp: Date.now() }
}

function windowReply(messages: Message[], opts?: { truncated?: boolean; loadedTurns?: number; totalTurnsEstimate?: number }) {
  return {
    messages,
    truncated: opts?.truncated ?? false,
    loadedTurns: opts?.loadedTurns ?? messages.length,
    totalTurnsEstimate: opts?.totalTurnsEstimate ?? messages.length,
  }
}

describe('「加载更早」游标翻页（[u6] D4 中期）', () => {
  let loadMoreHistory: (sessionId: string) => Promise<void>

  beforeEach(() => {
    setActivePinia(createPinia())
    resetChatModuleState()
    loadMoreHistory = useChat().loadMoreHistory
    vi.mocked(chat.getHistory).mockReset()
  })

  it('游标 = 分区最旧消息的 piEntryId；页消息前插且顺序正确（P-paging）', async () => {
    const store = useChatStore()
    const sid = 's1'

    // 当前分区 = 最近窗口（hydrate 注入，最旧 m8 带 piEntryId）
    store.hydrate(sid, [
      makeMessage('m8', 'msg-8', 'entry-8'),
      makeMessage('m9', 'msg-9', 'entry-9'),
      makeMessage('m10', 'msg-10', 'entry-10'),
    ], { truncated: true, loadedTurns: 3, totalTurnsEstimate: 6 })

    // 游标页（runtime 返回锚点 entry-8 之前的最近窗口）
    vi.mocked(chat.getHistory).mockResolvedValue(windowReply([
      makeMessage('m6', 'msg-6', 'entry-6'),
      makeMessage('m7', 'msg-7', 'entry-7'),
    ], { truncated: false, loadedTurns: 2, totalTurnsEstimate: 6 }))

    await loadMoreHistory(sid)

    // session.history 带 cursor（分区最旧消息的 piEntryId）
    expect(chat.getHistory).toHaveBeenCalledWith(sid, { cursor: 'entry-8' })

    // P-paging：页前插在头部，分区顺序正确（页 + 原窗口），无重复
    const messages = store.getMessages(sid)
    expect(messages.map((m) => m.id)).toEqual(['m6', 'm7', 'm8', 'm9', 'm10'])
    const ids = messages.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)

    // 窗口状态：翻页到头收敛（truncated=false → 顶部条消失）+ loadedTurns 累计
    expect(store.getHistoryWindow(sid)).toEqual({ truncated: false, loadedTurns: 5, totalTurnsEstimate: 6 })
  })

  it('游标回落 id（消息无 piEntryId 时取 id——对称取值 piEntryId ?? id）', async () => {
    const store = useChatStore()
    const sid = 's2'
    store.hydrate(sid, [makeMessage('m1', 'msg-1')], { truncated: true, loadedTurns: 1, totalTurnsEstimate: 2 })

    vi.mocked(chat.getHistory).mockResolvedValue(windowReply([]))
    await loadMoreHistory(sid)

    expect(chat.getHistory).toHaveBeenCalledWith(sid, { cursor: 'm1' })
  })

  it('空页（cursor 未命中 / 翻页到头）：分区不变 + 窗口收敛，不报错', async () => {
    const store = useChatStore()
    const sid = 's3'
    store.hydrate(sid, [makeMessage('m1', 'msg-1', 'entry-1')], { truncated: true, loadedTurns: 1, totalTurnsEstimate: 1 })

    vi.mocked(chat.getHistory).mockResolvedValue(windowReply([], { truncated: false, loadedTurns: 0, totalTurnsEstimate: 0 }))
    await loadMoreHistory(sid)

    expect(store.getMessages(sid)).toHaveLength(1)
    expect(store.getMessages(sid)[0]!.id).toBe('m1')
    expect(store.getHistoryWindow(sid)?.truncated).toBe(false)
  })

  it('RPC 失败时不破坏现有消息', async () => {
    const store = useChatStore()
    const sid = 's4'
    store.hydrate(sid, [makeMessage('m1', 'msg-1', 'entry-1')], { truncated: true, loadedTurns: 1, totalTurnsEstimate: 1 })

    vi.mocked(chat.getHistory).mockRejectedValue(new Error('network error'))

    await expect(loadMoreHistory(sid)).resolves.not.toThrow()

    // 现有消息不受影响
    expect(store.getMessages(sid)).toHaveLength(1)
    expect(store.getMessages(sid)[0]!.id).toBe('m1')
  })

  it('[RD-1#4] loadMoreHistory 返回布尔：成功 true / RPC 失败 false（失败显形的调用契约）', async () => {
    const store = useChatStore()
    const okSid = 's4b-ok'
    store.hydrate(okSid, [makeMessage('m1', 'msg-1', 'entry-1')], { truncated: true, loadedTurns: 1, totalTurnsEstimate: 2 })
    vi.mocked(chat.getHistory).mockResolvedValue(windowReply([makeMessage('m0', 'msg-0', 'entry-0')], { truncated: false, loadedTurns: 1, totalTurnsEstimate: 2 }))
    await expect(loadMoreHistory(okSid)).resolves.toBe(true)

    const failSid = 's4b-fail'
    store.hydrate(failSid, [makeMessage('m1', 'msg-1', 'entry-1')], { truncated: true, loadedTurns: 1, totalTurnsEstimate: 1 })
    vi.mocked(chat.getHistory).mockRejectedValue(new Error('network error'))
    await expect(loadMoreHistory(failSid)).resolves.toBe(false)
  })
})

describe('useLoadMoreHistory 交互态（P-paging 视口锚定信号）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    resetChatModuleState()
    vi.mocked(chat.getHistory).mockReset()
  })

  it('handleLoadMore 期间 isPrepend=true（Virtualizer :shift 保位窗口），完成后翻 false', async () => {
    const store = useChatStore()
    const sid = 's5'
    store.hydrate(sid, [makeMessage('m2', 'msg-2', 'entry-2')], { truncated: true, loadedTurns: 1, totalTurnsEstimate: 2 })

    let resolvePage!: (v: unknown) => void
    vi.mocked(chat.getHistory).mockImplementation(() => new Promise((resolve) => { resolvePage = resolve }))

    const { loadingMore, showLoadMore, handleLoadMore, isPrepend } = useLoadMoreHistory(() => sid)
    expect(showLoadMore.value).toBe(true)

    const pending = handleLoadMore()
    // 加载中：isPrepend 前置 true（virtua shift 保位窗口开启）+ 按钮态
    expect(isPrepend.value).toBe(true)
    expect(loadingMore.value).toBe(true)

    resolvePage(windowReply([makeMessage('m1', 'msg-1', 'entry-1')], { truncated: false, loadedTurns: 1, totalTurnsEstimate: 2 }))
    await pending

    // 完成后信号复位（virtua 已按 shift=true 处理 data length change）
    expect(isPrepend.value).toBe(false)
    expect(loadingMore.value).toBe(false)
    // 翻页到头 → showLoadMore 收敛
    expect(showLoadMore.value).toBe(false)
  })

  it('showLoadMore=false（truncated=false）时 handleLoadMore 短路（不发请求）', async () => {
    const store = useChatStore()
    const sid = 's6'
    store.hydrate(sid, [makeMessage('m1', 'msg-1', 'entry-1')], { truncated: false, loadedTurns: 1, totalTurnsEstimate: 1 })

    const { handleLoadMore, isPrepend } = useLoadMoreHistory(() => sid)
    await handleLoadMore()
    expect(chat.getHistory).not.toHaveBeenCalled()
    expect(isPrepend.value).toBe(false)
  })

  it('[RD-1#4] RPC 失败 → loadMoreError=true + truncated 窗口不变（显形可重试，非「已到头」）', async () => {
    const store = useChatStore()
    const sid = 's7'
    store.hydrate(sid, [makeMessage('m1', 'msg-1', 'entry-1')], { truncated: true, loadedTurns: 1, totalTurnsEstimate: 2 })
    vi.mocked(chat.getHistory).mockRejectedValue(new Error('network error'))

    const { loadingMore, showLoadMore, handleLoadMore, loadMoreError } = useLoadMoreHistory(() => sid)
    expect(loadMoreError.value).toBe(false)

    await handleLoadMore()

    // 失败态显形（顶部条据此渲染可重试错误行）
    expect(loadMoreError.value).toBe(true)
    // loading 复位（按钮可再点 = 可重试）
    expect(loadingMore.value).toBe(false)
    // 关键：truncated 窗口不变——失败不得被 UI 误读成「已到头」
    expect(showLoadMore.value).toBe(true)
    expect(store.getHistoryWindow(sid)).toEqual({ truncated: true, loadedTurns: 1, totalTurnsEstimate: 2 })
    // 分区未被破坏
    expect(store.getMessages(sid)).toHaveLength(1)
  })

  it('[RD-1#4] 重试成功 → loadMoreError 清除', async () => {
    const store = useChatStore()
    const sid = 's8'
    store.hydrate(sid, [makeMessage('m1', 'msg-1', 'entry-1')], { truncated: true, loadedTurns: 1, totalTurnsEstimate: 2 })
    vi.mocked(chat.getHistory).mockRejectedValueOnce(new Error('network error'))

    const { handleLoadMore, loadMoreError } = useLoadMoreHistory(() => sid)
    await handleLoadMore()
    expect(loadMoreError.value).toBe(true)

    vi.mocked(chat.getHistory).mockResolvedValue(
      windowReply([makeMessage('m0', 'msg-0', 'entry-0')], { truncated: false, loadedTurns: 1, totalTurnsEstimate: 2 }),
    )
    await handleLoadMore()
    expect(loadMoreError.value).toBe(false)
    expect(store.getMessages(sid).map((m) => m.id)).toEqual(['m0', 'm1'])
  })

  it('[RD-1#4] 切换 session → loadMoreError 复位（失败态不跨 session 残留）', async () => {
    const store = useChatStore()
    const sid = ref('s9')
    store.hydrate(sid.value, [makeMessage('m1', 'msg-1', 'entry-1')], { truncated: true, loadedTurns: 1, totalTurnsEstimate: 2 })
    vi.mocked(chat.getHistory).mockRejectedValue(new Error('network error'))

    const { handleLoadMore, loadMoreError } = useLoadMoreHistory(() => sid.value)
    await handleLoadMore()
    expect(loadMoreError.value).toBe(true)

    sid.value = 's10'
    await nextTick()
    expect(loadMoreError.value).toBe(false)
  })
})
