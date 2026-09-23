/**
 * mutation reply 生效值契约守卫测试（静态扫描 + 双向清单比对 + 编译期类型断言）。
 *
 * 锁定行为（ADR-0065 / C-pi-14，设计 state-truth-sync-architecture.md §3.3 D8）：
 * 全部 mutation 类 RPC（改状态值且 renderer 有 store 副本，覆盖域 = session 配置状态 /
 * model / preset / config 四域）必须登记在 MUTATION_RPC_REGISTRY，并按 ADR-0065 两分支归类——
 * 分支一（后端可变换请求值：pi 钳制/pattern 换模）reply 必须携带生效值字段且消费侧
 * 禁乐观写；分支二（后端原样存储）reply 携带回显字段或登记豁免理由，消费侧允许
 * 乐观写 + reply 权威覆盖 + 失败回滚。
 *
 * 守卫结构（参照 create-derived-callers.test.ts 的清单守卫模式）：
 * - 「新增 mutation 不入清单即红」：谓词扫描 protocol.ts 的 ClientMessageType 联合，
 *   域内改值动词形态的 type 全部提取为候选集合，与登记清单双向比对（漏登记红 /
 *   登记失效红）。谓词刻意宽松（宁可误红逼人显式归类），读类/生命周期类命中后
 *   以 excluded 分类显式登记排除理由。
 * - 「reply 契约逐项断言」：effective-value/echo-value 项断言 ReplyPayloadMap 登记
 *   payload 消费型（非 void）且 reply 形状含生效/回显字段（必需，非 optional）；
 *   ack-exempt 项断言 ReplyPayloadMap 现状锁定为 void + 豁免理由非空。
 * - 「生效值字段类型必需不 optional」：文件内 HasRequiredField 编译期断言——本文件
 *   位于 src/（runtime tsconfig include 覆盖），由 `pnpm typecheck`（tsc --noEmit）
 *   执行；vitest 运行时该断言是 no-op（三层防线中运行时层只覆盖前两条）。
 *
 * 断言边界：拦「漏登记 / 登记失效 / reply 契约漂移（void 化、字段 optional 化）」，
 * 不拦「归类定错」（某 mutation 该属分支一还是二属 ADR-0065 裁决标准 + review 职责）。
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ServerMessageMap, ReplyPayloadMap } from '@taiji/shared'

/**
 * 本测试文件位于 <runtime>/src/__tests__/。fileURLToPath 返回文件路径（首个 '..' 消掉
 * 文件名一段），四个 '..' 到 packages/，protocol.ts = <workspace>/packages/shared/src/protocol.ts。
 */
const PROTOCOL_TS = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', 'shared', 'src', 'protocol.ts')

// ── 登记清单（SSOT：新增 mutation 必须在此登记，漏登记测试即红）──────────────

type MutationBranch = 'transformable' | 'verbatim' | 'non-mutation'
type MutationContract = 'effective-value' | 'echo-value' | 'ack-exempt' | 'excluded'

interface MutationRegistryEntry {
  /** ClientMessageType 中的 RPC type */
  type: string
  /** ADR-0065 归类：transformable = 分支一（后端可变换）/ verbatim = 分支二（原样存储）/ non-mutation = 非配置状态 mutation */
  branch: MutationBranch
  /** reply 契约形态（effective-value/echo-value/ack-exempt/excluded 的组合约束见「条目字段完整性」用例） */
  contract: MutationContract
  /** effective-value/echo-value 必填：ReplyPayloadMap 引用的 ServerMessageMap reply key */
  replyKey?: string
  /** effective-value/echo-value 必填：reply 形状中的生效值/回显字段名（断言必需不 optional） */
  effectiveFields?: readonly string[]
  /** ack-exempt/excluded 必填：豁免/排除理由（与 ADR-0065 豁免清单条目对应） */
  rationale?: string
}

/**
 * mutation RPC 登记清单（ADR-0065「三、mutation 清单与豁免登记」的机器镜像）。
 * 归类依据的 runtime handler 行为均已实读核实，锚点见 ADR 表格。
 */
const MUTATION_RPC_REGISTRY: readonly MutationRegistryEntry[] = [
  // ── 分支一：后端可变换请求值（pi 钳制/pattern 换模），reply 生效值必需 ──
  {
    type: 'model.switch',
    branch: 'transformable',
    contract: 'effective-value',
    replyKey: 'model.switched',
    effectiveFields: ['provider', 'modelId'],
  },
  {
    type: 'session.setThinkingLevel',
    branch: 'transformable',
    contract: 'effective-value',
    replyKey: 'session.thinkingLevelSet',
    effectiveFields: ['level'],
  },
  {
    // 后端变换点 = 去重保序（Set 插入序，model-message-handler handleConfigSetScopedModels），
    // 请求数组 ≠ 生效数组；reply 携带去重后生效值。wire reply 'config.scopedModels' 无具名
    // ServerMessageMap 条目，ReplyPayloadMap 登记为内联形状（extractReplyShape 内联回退分支）。
    type: 'config.setScopedModels',
    branch: 'transformable',
    contract: 'effective-value',
    replyKey: 'config.scopedModels',
    effectiveFields: ['scopedModels'],
  },
  // ── 分支二：后端原样存储，reply 携带回显字段（echo-value）──
  {
    type: 'preset.create',
    branch: 'verbatim',
    contract: 'echo-value',
    replyKey: 'preset.create',
    effectiveFields: ['preset'],
  },
  {
    type: 'preset.update',
    branch: 'verbatim',
    contract: 'echo-value',
    replyKey: 'preset.update',
    effectiveFields: ['preset'],
  },
  {
    type: 'session.setSubagentDefaultEngine',
    branch: 'verbatim',
    contract: 'echo-value',
    replyKey: 'session.subagentDefaultEngineSet',
    effectiveFields: ['engineId'],
  },
  // ── 分支二（config 域）：偏好组 setter——set 原值落盘 + reply 读回生效值，全部亲读核实：
  // config-preferences / smart-context-config / rename-config / system-prompt-terminal /
  // retry-config 各 message handler；renameMode/retry 等的非法值归一在 helper 层拒绝或归一，
  // reply 读回的即生效值（echo 权威覆盖语义承载）。──
  {
    type: 'config.setTerminalConfig',
    branch: 'verbatim',
    contract: 'echo-value',
    replyKey: 'config.terminalConfig',
    effectiveFields: ['config'],
  },
  {
    type: 'config.setRetryConfig',
    branch: 'verbatim',
    contract: 'echo-value',
    replyKey: 'config.retryConfig',
    effectiveFields: ['config'],
  },
  {
    type: 'config.setSystemPrompt',
    branch: 'verbatim',
    contract: 'echo-value',
    replyKey: 'config.systemPrompt',
    effectiveFields: ['config'],
  },
  {
    type: 'config.setWorktreeRootDir',
    branch: 'verbatim',
    contract: 'echo-value',
    replyKey: 'config.worktreeRootDir',
    effectiveFields: ['dir'],
  },
  {
    type: 'config.setSetupScript',
    branch: 'verbatim',
    contract: 'echo-value',
    replyKey: 'config.setupScript',
    effectiveFields: ['script'],
  },
  {
    type: 'config.setBareSetupScript',
    branch: 'verbatim',
    contract: 'echo-value',
    replyKey: 'config.bareSetupScript',
    effectiveFields: ['script'],
  },
  {
    type: 'config.setTimeout',
    branch: 'verbatim',
    contract: 'echo-value',
    replyKey: 'config.worktreeTimeout',
    effectiveFields: ['timeout'],
  },
  {
    type: 'config.setDefaultBaseBranch',
    branch: 'verbatim',
    contract: 'echo-value',
    replyKey: 'config.defaultBaseBranch',
    effectiveFields: ['baseBranch'],
  },
  {
    type: 'config.setAutoRenameEnabled',
    branch: 'verbatim',
    contract: 'echo-value',
    replyKey: 'config.autoRenameEnabled',
    effectiveFields: ['enabled'],
  },
  {
    type: 'config.setRenameModel',
    branch: 'verbatim',
    contract: 'echo-value',
    replyKey: 'config.renameModel',
    effectiveFields: ['model'],
  },
  {
    type: 'config.setRenameMode',
    branch: 'verbatim',
    contract: 'echo-value',
    replyKey: 'config.renameMode',
    effectiveFields: ['mode'],
  },
  {
    type: 'config.setSmartContextEnabled',
    branch: 'verbatim',
    contract: 'echo-value',
    replyKey: 'config.smartContextEnabled',
    effectiveFields: ['enabled'],
  },
  {
    type: 'config.setSmartContextCompactModel',
    branch: 'verbatim',
    contract: 'echo-value',
    replyKey: 'config.smartContextCompactModel',
    effectiveFields: ['model'],
  },
  {
    type: 'config.setSmartContextThresholds',
    branch: 'verbatim',
    contract: 'echo-value',
    replyKey: 'config.smartContextThresholds',
    effectiveFields: ['thresholds'],
  },
  {
    type: 'config.setSmartContextExcludedModels',
    branch: 'verbatim',
    contract: 'echo-value',
    replyKey: 'config.smartContextExcludedModels',
    effectiveFields: ['models'],
  },
  // ── 分支二：ack 豁免清单（reply 无回显字段，豁免理由逐条登记）──
  {
    type: 'preset.setDefault',
    branch: 'verbatim',
    contract: 'ack-exempt',
    rationale: 'ack 占位 reply；原样存储 + 乐观写 + 失败回滚已闭环，无变换面（usePiPresets.setDefault）',
  },
  {
    type: 'preset.delete',
    branch: 'verbatim',
    contract: 'ack-exempt',
    rationale: '删除语义无生效值可回显（成功 ack 即终态：值 = 不存在，幂等）',
  },
  {
    type: 'preset.recordUsage',
    branch: 'verbatim',
    contract: 'ack-exempt',
    rationale: '记账类 fire-and-forget，无显示副本语义',
  },
  {
    type: 'session.rename',
    branch: 'verbatim',
    contract: 'ack-exempt',
    rationale: 'wire reply 实际回显 { sessionId, name } + broadcastSessionList 全量广播；类型层登记 void，权威覆盖由广播通道承担',
  },
  {
    type: 'session.setProject',
    branch: 'verbatim',
    contract: 'ack-exempt',
    rationale: '同 session.rename：wire 回显 + broadcastSessionList 全量刷新',
  },
  // ── 分支二（config 域）：ack 豁免——wire reply 多数实际携带回显 payload，但类型层登记
  // void（domain register<void> 不读 reply payload），权威覆盖由广播通道承担（session.rename
  // 同模式）；广播通道依据 ReplyPayloadMap 行注 + 各 message handler 实读。──
  {
    // u-locale-channel：renderer 是语言权威（乐观写 i18n 即生效，无 store 读回依赖），
    // 无读回 RPC；成功只回 config.uiLocaleSet 空 ack，写盘失败走 D10 错误信封——
    // reply 生效值无消费方（config-preferences-message-handler）。
    type: 'config.setUiLocale',
    branch: 'verbatim',
    contract: 'ack-exempt',
    rationale: 'renderer 是语言权威（乐观写 i18n 即生效），无读回 RPC；成功只回 config.uiLocaleSet 空 ack，reply 生效值无消费方',
  },
  {
    type: 'config.setProvider',
    branch: 'verbatim',
    contract: 'ack-exempt',
    rationale: 'wire reply 实际携带 config.providerUpdated { providerId } + broadcastProviderList 全量广播（provider-message-handler）；类型层登记 void，权威覆盖由广播通道承担',
  },
  {
    type: 'config.deleteProvider',
    branch: 'verbatim',
    contract: 'ack-exempt',
    rationale: '删除语义：wire reply config.providerUpdated { providerId, deleted } + broadcastProviderList；类型层登记 void，权威覆盖由广播通道承担',
  },
  {
    type: 'config.toggleProviderEnabled',
    branch: 'verbatim',
    contract: 'ack-exempt',
    rationale: 'wire reply config.providerUpdated { providerId } + broadcastProviderList（payload 显式携带目标 enabled，非翻转语义）；类型层登记 void，权威覆盖由广播通道承担',
  },
  {
    type: 'config.removeProviderByKind',
    branch: 'verbatim',
    contract: 'ack-exempt',
    rationale: '删除语义：wire reply config.providerUpdated { providerId, deleted } + broadcastProviderList（provider-message-handler）；类型层登记 void，权威覆盖由广播通道承担',
  },
  {
    type: 'config.setToolPermissions',
    branch: 'verbatim',
    contract: 'ack-exempt',
    rationale: 'wire reply config.providerUpdated { saved }（tool-permissions-message-handler）+ 广播；类型层登记 void，无生效值字段可回显',
  },
  {
    type: 'config.setDefaultModel',
    branch: 'verbatim',
    contract: 'ack-exempt',
    rationale: 'wire reply 实际携带 config.defaults { defaultModel }（provider/modelId 拼复合串）+ 全 panel 广播带 source（model-message-handler）；类型层登记 void，权威覆盖由广播通道承担',
  },
  {
    type: 'config.setSkill',
    branch: 'verbatim',
    contract: 'ack-exempt',
    rationale: 'wire reply config.skillUpdated { skill, success }（resources-message-handler）+ 广播；类型层登记 void，权威覆盖由广播通道承担',
  },
  {
    type: 'config.deleteSkill',
    branch: 'verbatim',
    contract: 'ack-exempt',
    rationale: '删除语义：wire reply config.skillDeleted { skillId, success }（resources-message-handler）；类型层登记 void，权威覆盖由广播通道承担',
  },
  {
    type: 'config.setAgent',
    branch: 'verbatim',
    contract: 'ack-exempt',
    rationale: 'wire reply config.agentUpdated { agent, success }（resources-message-handler）+ 广播；类型层登记 void，权威覆盖由广播通道承担',
  },
  {
    type: 'config.deleteAgent',
    branch: 'verbatim',
    contract: 'ack-exempt',
    rationale: '删除语义：wire reply config.agentDeleted { agentId, success }（resources-message-handler）；类型层登记 void，权威覆盖由广播通道承担',
  },
  {
    type: 'config.setSkillDirs',
    branch: 'verbatim',
    contract: 'ack-exempt',
    rationale: 'wire reply config.skillDirs { dirs }（resources-message-handler，目录列表整组刷新）；类型层登记 void，权威覆盖由广播通道承担',
  },
  {
    type: 'config.setAgentDirs',
    branch: 'verbatim',
    contract: 'ack-exempt',
    rationale: 'wire reply config.agentDirs { dirs }（resources-message-handler，同 setSkillDirs 模式）；类型层登记 void，权威覆盖由广播通道承担',
  },
  {
    type: 'config.setExtensionDirs',
    branch: 'verbatim',
    contract: 'ack-exempt',
    rationale: 'wire reply config.extensionDirs { dirs }（resources-message-handler，同 setSkillDirs 模式）；类型层登记 void，权威覆盖由广播通道承担',
  },
  // ── 非配置状态 mutation（excluded，排除理由登记）──
  {
    type: 'session.switch',
    branch: 'non-mutation',
    contract: 'excluded',
    rationale: '视图路由（切换活跃 session 面板），非改状态值',
  },
  {
    type: 'session.create',
    branch: 'non-mutation',
    contract: 'excluded',
    rationale: '实体生命周期，终态走 session.created 广播，无生效值概念',
  },
  {
    type: 'session.delete',
    branch: 'non-mutation',
    contract: 'excluded',
    rationale: '实体生命周期，终态走 session.deleted 广播',
  },
  {
    type: 'session.deleteByCwd',
    branch: 'non-mutation',
    contract: 'excluded',
    rationale: '实体生命周期（批量删除），reply 为 deleted/failed 聚合结果',
  },
  {
    type: 'session.import',
    branch: 'non-mutation',
    contract: 'excluded',
    rationale: '实体生命周期（导入创建），reply 是导入结果而非状态回显',
  },
  {
    type: 'session.importCandidates',
    branch: 'non-mutation',
    contract: 'excluded',
    rationale: '读类（列导入候选，不写任何状态），谓词宽松命中后显式排除',
  },
  {
    type: 'preset.import',
    branch: 'non-mutation',
    contract: 'excluded',
    rationale: '批量导入（生命周期族），reply { count } 是导入计数而非状态回显',
  },
  {
    type: 'session.fork',
    branch: 'non-mutation',
    contract: 'excluded',
    rationale: '实体生命周期（分叉创建新 session，与 session.create 同族）：reply session.created 复用实体创建形态 + forkNotice/broadcastSessionList 广播；新 session 生效配置经 D6 继承链（staging override > 源生效值 > …）+ 读回播种承接，非 mutation 回执语义',
  },
  {
    type: 'session.handoff',
    branch: 'non-mutation',
    contract: 'excluded',
    rationale: '实体生命周期（交接创建新 session，与 session.create 同族）：reply message.status ack，完成经 session.handoffComplete 独立广播；新 session 生效配置经 D6 继承链承接，非 mutation 回执语义',
  },
  {
    type: 'session.abortPlan',
    branch: 'non-mutation',
    contract: 'excluded',
    rationale: '动作类（终止运行中的 plan 审批流，非配置状态改值）：reply void ack，plan 状态经 session.planState 广播推回（投影链唯一承载，abort 前后无 mutation 生效值概念）',
  },
  {
    type: 'session.forceQuit',
    branch: 'non-mutation',
    contract: 'excluded',
    rationale: '动作类（强制退出 session 进程，与 session.abortPlan 同族）：reply void ack，状态经独立广播通道推回，无 mutation 生效值概念',
  },
  {
    type: 'session.abortHandoff',
    branch: 'non-mutation',
    contract: 'excluded',
    rationale: '动作类（取消进行中的 handoff：runtime client.abort + 清 listener/timer/inflight）：reply message.status ack（与 message.abort 同模式），无配置状态生效值概念',
  },
]

// ── protocol.ts 静态扫描（提取三个区段 + 候选 mutation 谓词）────────────────

const PROTOCOL_SOURCE = readFileSync(PROTOCOL_TS, 'utf8')

/** 提取顶层声明区段文本：自锚点行起，到首个行首 `}`（interface）或下一行首 `export`（type 联合）止 */
function extractBlock(anchor: string): string {
  const anchorIdx = PROTOCOL_SOURCE.indexOf(anchor)
  if (anchorIdx === -1) {
    throw new Error(`protocol.ts 中未找到锚点 "${anchor}"——声明位置变动，请同步更新本测试的区段提取锚点`)
  }
  const isInterface = anchor.startsWith('export interface')
  // type 联合（ClientMessageType）无 { }，区段到下一个行首 export；interface 到首个行首 }
  const endMarker = isInterface ? '\n}' : '\nexport '
  const endIdx = PROTOCOL_SOURCE.indexOf(endMarker, anchorIdx)
  if (endIdx === -1) {
    throw new Error(`protocol.ts 区段 "${anchor}" 未找到结束标记——文件格式变动，请检查`)
  }
  return PROTOCOL_SOURCE.slice(anchorIdx, endIdx)
}

const CLIENT_MESSAGE_TYPES_BLOCK = extractBlock('export type ClientMessageType =')
const REPLY_PAYLOAD_MAP_BLOCK = extractBlock('export interface ReplyPayloadMap {')
const SERVER_MESSAGE_MAP_BASE_BLOCK = extractBlock('export interface ServerMessageMapBase {')

/** 谓词覆盖域（ADR-0065 范围边界）：session 配置状态 / model / preset / config 四域 */
const MUTATION_DOMAINS = ['session', 'model', 'preset', 'config'] as const

/**
 * 改值动词形态（宽松 startsWith——宁可误红逼人显式归类，见文件头守卫取向声明）。
 *
 * 表覆盖两批动词：① 现存清单内出现过的改值动词（set 特殊处理见 isMutationCandidate）；
 * ② 常见改值动词前瞻补齐（clear/reset/toggle/enable/disable/add）——保证「新动词 mutation
 * 出现即被逼入清单」的守卫声明对常见动词命名成立，而非只对历史动词成立。新增动词前
 * 先 grep 本表避免漏配；误命中读类/动作类时以 excluded 显式登记排除理由（特性非缺陷）。
 */
const MUTATION_VERB_PREFIXES = [
  'set', 'rename', 'switch', 'create', 'update', 'delete', 'remove', 'recordUsage', 'import',
  'fork', 'handoff', 'clear', 'reset', 'toggle', 'enable', 'disable', 'add', 'abort', 'force',
] as const

/** 判断 ClientMessageType 字面量是否为候选 mutation（域内 + 改值动词形态开头） */
function isMutationCandidate(type: string): boolean {
  const dot = type.indexOf('.')
  if (dot === -1) return false
  const domain = type.slice(0, dot)
  const verb = type.slice(dot + 1)
  if (!(MUTATION_DOMAINS as readonly string[]).includes(domain)) return false
  // set 限定 setXxx 形态（'settings' 类名词不误命中）；其余动词宽松前缀
  if (verb.startsWith('set')) return /^set[A-Z]/.test(verb)
  return MUTATION_VERB_PREFIXES.some((p) => verb.startsWith(p))
}

/** ClientMessageType 联合区段内全部 '...' 字面量（去重保序） */
function listClientMessageTypes(): string[] {
  const out: string[] = []
  for (const m of CLIENT_MESSAGE_TYPES_BLOCK.matchAll(/'([a-zA-Z.]+)'/g)) {
    if (!out.includes(m[1])) out.push(m[1])
  }
  return out
}

/** 提取 map 区段内 `'key': value` 行的 value 文本（首个命中；未命中返回 undefined）。
 *  类型表达式不含字符串字面量，剥行尾 `//` 注释后 trim——ReplyPayloadMap 行普遍带注释。 */
function extractMapValue(block: string, key: string): string | undefined {
  const m = block.match(new RegExp(`^  '${key.replace(/\./g, '\\.')}':\\s*(.+)$`, 'm'))
  const raw = m?.[1]
  return raw === undefined ? undefined : raw.split('//')[0].trim()
}

/** 提取 reply 形状文本：内联 `{ ... }` 直接返回；具名 `XxxMutationReply` 引用则取该 interface 的 body。
 *  ServerMessageMapBase 无该 replyKey 时回退取 ReplyPayloadMap 映射行的内联形状——适用
 *  wire reply 无具名广播条目的 RPC（如 config.setScopedModels 的 'config.scopedModels'）。 */
function extractReplyShape(replyKey: string, requestType: string): string {
  const base = extractMapValue(SERVER_MESSAGE_MAP_BASE_BLOCK, replyKey)
  if (base !== undefined) {
    if (base.startsWith('{')) return base
    // 具名引用：取 `export interface <Name> {` 到配对 `}` 的 body（嵌套一层对象字面量内
    // 的 } 会导致提前截断——当前 mutation reply 形状均为扁平字段，无嵌套）
    const anchor = `export interface ${base} {`
    const start = PROTOCOL_SOURCE.indexOf(anchor)
    if (start === -1) {
      throw new Error(`reply '${replyKey}' 引用了具名类型 ${base}，但 protocol.ts 中未找到其 interface 声明`)
    }
    const end = PROTOCOL_SOURCE.indexOf('\n}', start)
    return PROTOCOL_SOURCE.slice(start, end)
  }
  const inline = extractMapValue(REPLY_PAYLOAD_MAP_BLOCK, requestType)
  if (inline !== undefined && inline.startsWith('{')) return inline
  throw new Error(`ServerMessageMapBase 中未找到 reply key '${replyKey}'——协议类型登记缺失`)
}

describe('MUTATION_RPC_REGISTRY 清单守卫（ADR-0065 / C-pi-14，D8 机器强制）', () => {
  it('谓词扫描 ClientMessageType 的候选 mutation 与登记清单完全相等（双向：漏登记红 / 登记失效红）', () => {
    const candidates = listClientMessageTypes().filter(isMutationCandidate)
    const registered = MUTATION_RPC_REGISTRY.map((e) => e.type)

    const unregistered = candidates.filter((t) => !registered.includes(t)).sort()
    const stale = registered.filter((t) => !candidates.includes(t)).sort()

    expect(unregistered, [
      '发现未登记的 mutation 类 RPC：',
      ...unregistered.map((t) => `  - ${t}`),
      '全部 mutation RPC 必须登记契约归类（ADR-0065 两分支裁决标准）——',
      '请到 packages/runtime/src/__tests__/mutation-reply-contract.test.ts 的 MUTATION_RPC_REGISTRY',
      '登记该条目（type / branch / contract / replyKey+effectiveFields 或 rationale），',
      '并按 ADR-0065「五、接入检查单」核对 reply 契约与消费侧写 store 模式。',
    ].join('\n')).toEqual([])

    expect(stale, [
      '以下登记项对应的 RPC 已从 ClientMessageType 消失（登记失效）：',
      ...stale.map((t) => `  - ${t}`),
      '请从 MUTATION_RPC_REGISTRY 移除失效条目，保持清单即事实。',
    ].join('\n')).toEqual([])
  })

  it('条目字段完整性：contract 与 branch / replyKey / effectiveFields / rationale 组合约束', () => {
    for (const entry of MUTATION_RPC_REGISTRY) {
      if (entry.contract === 'effective-value') {
        expect(entry.branch, `${entry.type}（effective-value）branch 必须是 transformable（分支一）`).toBe('transformable')
      } else if (entry.contract === 'echo-value' || entry.contract === 'ack-exempt') {
        expect(entry.branch, `${entry.type}（${entry.contract}）branch 必须是 verbatim（分支二）`).toBe('verbatim')
      } else {
        expect(entry.branch, `${entry.type}（excluded）branch 必须是 non-mutation`).toBe('non-mutation')
      }
      if (entry.contract === 'effective-value' || entry.contract === 'echo-value') {
        expect(entry.replyKey, `${entry.type} 的 ${entry.contract} 契约必须登记 replyKey`).toBeTruthy()
        expect(entry.effectiveFields?.length, `${entry.type} 的 ${entry.contract} 契约必须登记 effectiveFields（至少一个生效/回显字段）`).toBeTruthy()
      } else {
        expect(entry.rationale, `${entry.type} 的 ${entry.contract} 登记必须携带 rationale（豁免/排除理由，对应 ADR-0065 清单条目）`).toBeTruthy()
      }
    }
  })

  it('effective-value/echo-value 项：ReplyPayloadMap 登记 payload 消费型（禁 void）且引用登记的 replyKey', () => {
    for (const entry of MUTATION_RPC_REGISTRY) {
      if (entry.contract !== 'effective-value' && entry.contract !== 'echo-value') continue
      const value = extractMapValue(REPLY_PAYLOAD_MAP_BLOCK, entry.type)
      expect(value, [
        `ReplyPayloadMap 中未找到 '${entry.type}' 的映射行——mutation RPC 必须登记 reply 映射。`,
        `按 ADR-0065 分支${entry.contract === 'effective-value' ? '一（禁 void，引用携带生效值的 XxxMutationReply）' : '二（携带回显字段）'}补齐。`,
      ].join('')).toBeTruthy()
      expect(value, [
        `'${entry.type}' 的 ReplyPayloadMap 登记为 void（ack 型）——违反其登记契约 ${entry.contract}。`,
        entry.contract === 'effective-value'
          ? '分支一（后端可变换）禁 void：reply 生效值是显示态唯一合法来源（C-pi-13 事故 B 形态）。'
          : '分支二 echo-value 应携带回显字段；确需 ack 型须把 contract 改为 ack-exempt 并登记豁免理由（同步 ADR-0065 豁免清单）。',
      ].join('')).not.toBe('void')
      // payload 消费型两种合法形态：引用具名 ServerMessageMap 条目，或内联 payload 形状
      //（wire reply 无具名广播条目的 RPC，如 config.setScopedModels 的 { scopedModels }）
      const refForm = `ServerMessageMap['${entry.replyKey}']`
      expect(
        value === refForm || (value !== undefined && value.startsWith('{')),
        `'${entry.type}' 的 ReplyPayloadMap 须引用 ${refForm} 或内联 payload 形状（当前：${value ?? '(未登记)'}）`,
      ).toBe(true)
    }
  })

  it('effective-value/echo-value 项：reply 形状含全部登记字段且必需（非 optional）', () => {
    for (const entry of MUTATION_RPC_REGISTRY) {
      if (entry.contract !== 'effective-value' && entry.contract !== 'echo-value') continue
      const shape = extractReplyShape(entry.replyKey as string, entry.type)
      for (const field of entry.effectiveFields ?? []) {
        expect(
          // `(^|[{]|\n)`：任意行首（具名 interface body 字段）或 `{` 后（单行内联形状 `{ field: ... }`）
          new RegExp(`(^|[{]|\\n)\\s*${field}:`).test(shape),
          [
            `reply '${entry.replyKey}' 的形状中未找到必需字段 "${field}"（'${entry.type}' 的 ${entry.contract} 契约）。`,
            '生效值/回显字段缺失 = 消费侧无从取真值（C-pi-13）。请在 protocol.ts 的具名 reply 类型或内联形状中补齐（必需，不 optional）。',
          ].join(''),
        ).toBe(true)
        expect(
          shape.includes(`${field}?:`),
          `reply '${entry.replyKey}' 的字段 "${field}" 是 optional——生效值/回显字段必须必需（C-pi-14 编译期强制）。`,
        ).toBe(false)
      }
    }
  })

  it('ack-exempt 项：ReplyPayloadMap 现状锁定为 void（升级为 payload 型须重新归类并更新 ADR 豁免清单）', () => {
    for (const entry of MUTATION_RPC_REGISTRY) {
      if (entry.contract !== 'ack-exempt') continue
      const value = extractMapValue(REPLY_PAYLOAD_MAP_BLOCK, entry.type)
      expect(value, [
        `'${entry.type}' 登记为 ack-exempt，但 ReplyPayloadMap 现值为 ${value ?? '(未登记)'}（非 void）。`,
        'reply 契约已变化：若改为携带回显字段，请把 contract 升级为 echo-value 并登记 replyKey/effectiveFields',
        '（同步更新 ADR-0065 豁免清单与消费侧「reply 权威覆盖」接线）。',
      ].join('')).toBe('void')
    }
  })

  it('类型层：生效值/回显字段必需且非 optional（编译期断言，由 packages/runtime `pnpm typecheck` 执行）', () => {
    /**
     * HasRequiredField<T, K> 解析为 true 当且仅当 K 是 T 的必需字段（存在且不含 undefined）。
     * 字段缺失或 optional 时解析为 false，`const x: ... = true` 赋值在 tsc --noEmit 下报错。
     * vitest 运行时本用例只验证断言清单非空（编译期断言不依赖运行时执行）。
     */
    type HasRequiredField<T, K extends string> =
      K extends keyof T ? (undefined extends T[K] ? false : true) : false

    // 分支一（生效值）
    const modelSwitchProvider: HasRequiredField<ServerMessageMap['model.switched'], 'provider'> = true
    const modelSwitchModelId: HasRequiredField<ServerMessageMap['model.switched'], 'modelId'> = true
    const thinkingLevel: HasRequiredField<ServerMessageMap['session.thinkingLevelSet'], 'level'> = true
    // 分支二（回显值）
    const presetCreateEcho: HasRequiredField<ServerMessageMap['preset.create'], 'preset'> = true
    const presetUpdateEcho: HasRequiredField<ServerMessageMap['preset.update'], 'preset'> = true
    const engineIdEcho: HasRequiredField<ServerMessageMap['session.subagentDefaultEngineSet'], 'engineId'> = true
    // config 域代表：具名形状（smartContextEnabled）与内联形状（setScopedModels 的 ReplyPayloadMap 行）
    const smartContextEnabledEcho: HasRequiredField<ServerMessageMap['config.smartContextEnabled'], 'enabled'> = true
    const terminalConfigEcho: HasRequiredField<ServerMessageMap['config.terminalConfig'], 'config'> = true
    const scopedModelsEffective: HasRequiredField<ReplyPayloadMap['config.setScopedModels'], 'scopedModels'> = true

    const assertions = [
      modelSwitchProvider, modelSwitchModelId, thinkingLevel,
      presetCreateEcho, presetUpdateEcho, engineIdEcho,
      smartContextEnabledEcho, terminalConfigEcho, scopedModelsEffective,
    ]
    expect(assertions, '类型断言清单意外为空——本用例失效，请检查').not.toHaveLength(0)
    expect(assertions.every(Boolean)).toBe(true)
  })
})
