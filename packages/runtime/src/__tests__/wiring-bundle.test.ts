import { SNAPSHOT_TMP_PREFIX } from '../../../zcode-session-source/src/recovery.ts';
import { flushDelivery } from '../../test/helpers/flush-delivery.js';
import { closeCrashJournal, getCrashJournal, initCrashJournal } from '../infra/crash-journal.js';
import { closeLogger, createPiSessionLog, initLogger } from '../infra/logger.js';
import { getPiGlobalAgentDir } from '../infra/pi/pi-maintenance.js';
import { encodeCwd, getSessionsDir } from '../infra/pi/pi-paths.js';
import { cleanLeakedPackages, isInvalidProvider, isLeakedPackage, sanitizeInvalidProviders, setModelsPath, setSettingsPath, type PiProviderConfig } from '../infra/pi/pi-provider-store.js';
import { ProcessManager } from '../infra/pi/process-manager.js';
import { BINDING_FIELDS, CREATE_DERIVED_CALLERS, hydrateBindingMeta, type BindingEntryKind, type BindingFieldKey } from '../infra/pi/session-binding-fields.js';
import { invalidateScanDirCache, scanPiSessions } from '../infra/pi/session-file-utils.js';
import { ensureDeclaredStartupConfigs, readDeclaredStartupConfigs } from '../services/extension-startup-config.js';
import type { IMessageBus } from '../services/message-bus/message-bus.js';
import { SessionDataStore, isSessionDataCleared } from '../services/plugin-service/session-data-store.js';
import { IProcessManager, PiBashResult, type IPiEngine } from '../services/ports/pi-engine.js';
import type { ScannedSessionMeta } from '../services/ports/session.js';
import { ProjectStore } from '../services/project/project-store.js';
import { ENGINE_NODE_ENV, ENGINE_ROOTS_ENV, ensureRuntimeEngineRootsEnv, getEngineRootsSpawnEnv, getStagedEnginesDir } from '../services/session/engine-roots.js';
import { ImportService, ImportServiceError } from '../services/session/import-service.js';
import { ExternalFileImportSource } from '../services/session/import-source-external-file.js';
import { ZcodeImportSource } from '../services/session/import-source-zcode.js';
import { ImportServiceError as ImportServiceError_z2, type SessionImportSource } from '../services/session/import-source.js';
import { MessageDispatcher } from '../services/session/message-dispatcher.js';
import { createSessionDeliveryRegistry } from '../services/session/session-delivery-registry.js';
import type { IDispatcherSessionOps } from '../services/session/session-internal.js';
import type { IManagedSessionView } from '../services/session/types.js';
import type { WorkspaceService } from '../services/workspace/workspace-service.js';
import { extractCallWindows } from './helpers/bracket-call-window.js';
import { Project, ReplyPayloadMap, type ImportSourceKind, type ProjectStoreState, type ServerMessage, type ServerMessageMap } from '@taiji/shared';
import { normalizeZcodeSessionId, openZcodeSessionDb, zcodeCandidateKey } from '@zhushanwen/zcode-session-source';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← src/__tests__/index-composition-root-wiring.test.ts
// ======================================================================

const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')


// ======================================================================
// ← src/__tests__/crash-journal-composition-root-wiring.test.ts
// ======================================================================

const createdDirs: string[] = []


function makeDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crash-journal-root-wiring-'))
  createdDirs.push(dir)
  return dir
}


// ======================================================================
// ← src/__tests__/binding-registry-hydrate.test.ts
// ======================================================================

// 本文件另为 session-binding-fields 合并载体（create-derived-callers 折叠为分节）。
/**
 * sidecar-binding-sync 检查测试——「入口回填断言」（设计文档 §3.3 决策 3 第 ① 类）。
 *
 * 两部分分工：
 * - Part 1：hydrateBindingMeta 纯函数契约。期望值全部硬编码自设计文档 §3.3 决策 1
 *   矩阵（外部事实）——禁止运行时读 BINDING_FIELDS 算期望，否则测试与实现共用同一
 *   表源，表语义定错时双向自证「空绿」。注册表键清单仅用作遍历骨架（coverage 从表
 *   读）：新增绑定字段漏更本测试 = 键集一致性断言红。
 * - Part 2：入口接线锁定（源码结构断言）。create/restore/fork 真实入口依赖 pi 子进程
 *   spawn + switch_session RPC（session-lifecycle-options.test.ts 前言已裁定 mock 成本
 *   过高），降级为 fs 读源码文本断言调用形态；handoff 承接通道走 sessionService.create
 *   派生调用（通道独立性由 CREATE_DERIVED_CALLERS 清单承诺），对 handoff-service 的
 *   create options 做同样静态断言。
 *
 * 运行：cd packages/runtime && npx vitest run src/__tests__/binding-registry-hydrate.test.ts
 */

// ── 公共夹具 ─────────────────────────────────────────────────────────

/** 七字段样例值集合（值本身无语义，仅需非 undefined 且可区分键名）；类型对齐 hydrate 形参，spawnSource 字面量经上下文收窄进枚举 */
const SAMPLE_META: Partial<Pick<ScannedSessionMeta, BindingFieldKey>> = {
  launchPresetId: 'preset-x',
  projectId: 'proj-x',
  spawnSource: 'agent',
  parentAgentSessionId: 'pa-x',
  handedOffTo: 'next-x',
  modelId: 'model-x',
  thinkingLevel: 'high',
}


function freshSession(): Record<string, unknown> {
  return {}
}


// ── Part 2：入口接线锁定（源码结构断言） ─────────────────────────────

/**
 * 提取源码中 callee( 开始到圆括号平衡结束的完整调用块文本（T11 收敛：
 * 括号平衡 + 字符串感知语义在共享 helper bracket-call-window.ts，此处仅绑定锚点取 text）。
 */
function extractCallBlocks(source: string, callee: RegExp): string[] {
  return extractCallWindows(source, callee).map((w) => w.text)
}


/** 测试文件位于 src/__tests__/，../ 即 src/ 根 */
const lifecycleSrc = readFileSync(new URL('../services/session/session-lifecycle.ts', import.meta.url), 'utf8')


const handoffSrc = readFileSync(new URL('../services/handoff-service.ts', import.meta.url), 'utf8')


// ======================================================================
// ← src/__tests__/mutation-reply-contract.test.ts
// ======================================================================

/**
 * 本测试文件位于 <runtime>/src/__tests__/。fileURLToPath 返回文件路径（首个 '..' 消掉
 * 文件名一段），四个 '..' 到 packages/，protocol.ts = <workspace>/packages/shared/src/protocol.ts。
 */
const PROTOCOL_TS = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', 'shared', 'src', 'protocol.ts')


// codemode 域形状 SSOT（protocol.ts 头部登记约定：payload/reply 形状在 ./codemode）
const CODEMODE_DOMAIN_SOURCE = readFileSync(resolve(PROTOCOL_TS, '..', 'codemode.ts'), 'utf8')


// mcp 域形状 SSOT（protocol.ts 头部登记约定：mcp 域 payload/reply 形状在 ./mcp——清单变更
// 无 server→client 广播帧（reply 经 :result 帧承载、payload 直引 ./mcp 具名类型）；唯一广播 =
// 连接测试终态 mcp:testResult，probe 完成侧推送帧，不在 mutation 登记范围）
const MCP_DOMAIN_SOURCE = readFileSync(resolve(PROTOCOL_TS, '..', 'mcp.ts'), 'utf8')


// ── 登记清单（SSOT：新增 mutation 必须在此登记，漏登记测试即红）──────────────

type MutationBranch = 'transformable' | 'verbatim' | 'non-mutation'


type MutationContract = 'effective-value' | 'echo-value' | 'ack-exempt' | 'excluded'


interface MutationRegistryEntry {  // oe-exempt:20261027:test:
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
  {
    // subagent.setModel（subagent-model-switch §7.1）：chat 域按 kind 分两型 + run 级聚合
    // 三组件（reply 'subagent.modelSet' → SubagentSetModelReply 判别联合）。后端可变换请求
    // 值：引擎命令成功且回读到手的 effective 型才携带生效模型 ref + 生效 thinking 档位；
    // recorded 记账型（无活进程）不回读、生效值由下次执行推导（协议注释「预告值必然是
    // 猜测」），消费侧禁乐观写请求值（协议注释「照 model.switch 回执修型（U6）」）。
    // 生效值断言锚 effective 分支（extractReplyShape 穿透具名引用联合展开后命中字段层）；
    // recorded / 聚合非 switched 成员无生效值属设计内合法产出（错误信封语义同
    // config.setCodemodeEnabled / mcp.* ok:false），不在 effectiveFields 断言范围。
    type: 'subagent.setModel',
    branch: 'transformable',
    contract: 'effective-value',
    replyKey: 'subagent.modelSet',
    effectiveFields: ['effectiveModel', 'effectiveThinkingLevel'],
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
  {
    // per-engine 默认模型偏好写入（config.json
    // engineDefaults 键）。原样存储（写入校验只拒绝非法 ref，不变换合法值）；
    // reply 回显 engineId/modelRef——setSubagentDefaultEngine 同款先例。
    type: 'session.setSubagentEngineDefaultModel',
    branch: 'verbatim',
    contract: 'echo-value',
    replyKey: 'session.subagentEngineDefaultModelSet',
    effectiveFields: ['engineId', 'modelRef'],
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
    // llm-network-proxy：set 校验失败走错误信封不落盘；成功写入 RMW——写侧 dedupeHostList
    // 归一化去重是确定性变换（请求值 ≠ 落盘终态），归分支一；reply/broadcast 读回落盘终态
    // （getNetworkProxyConfig()），config 即生效值（消费侧禁乐观写请求值）。
    type: 'config.setNetworkProxy',
    branch: 'transformable',
    contract: 'effective-value',
    replyKey: 'config.networkProxy',
    effectiveFields: ['config'],
  },
  {
    // llm-network-proxy：reset 追加重置水位行后 reply 清零后统计（读聚合 all 档），
    // 消费侧直接刷新视图——stats 非配置副本而是读侧投影，echo 即清零生效值。
    type: 'config.resetNetworkProxyStats',
    branch: 'verbatim',
    contract: 'echo-value',
    replyKey: 'config.networkProxyStats',
    effectiveFields: ['stats'],
  },
  {
    type: 'config.setRetryConfig',
    branch: 'verbatim',
    contract: 'echo-value',
    replyKey: 'config.retryConfig',
    effectiveFields: ['config'],
  },
  {
    // 重试规则域（subagent-observability §3.3.12）：set 校验失败走错误信封不落盘；成功写
    // ext-config（写侧 source 归一 custom + effectiveRules 合并持久段重算，确定性变换）——
    // 归分支一；reply/broadcast 读回服务端组装视图（getBuiltinRetryRules + customRules 读回），
    // customRules 即生效值（消费侧以服务端终态校准，network-proxy 同款）。
    type: 'config.setRetryRules',
    branch: 'transformable',
    contract: 'effective-value',
    replyKey: 'config.retryRules',
    effectiveFields: ['customRules'],
  },
  {
    // codemode 开关写（codemode 设计 D1/A1/D2）：后端按 D2 语义表规范化落盘（幂等不动 /
    // 负条目占位），reply ok 分支 enabled = 写后落盘终态（生效值）；ok:false 为损坏拒入
    // 信封（error+corruption，A1 写点拒入），错误态不走 effectiveFields
    type: 'config.setCodemodeEnabled',
    branch: 'transformable',
    contract: 'effective-value',
    replyKey: 'config.codemodeSetEnabled',
    effectiveFields: ['enabled'],
  },
  // ── 分支二 + 一（mcp 域）：mcp.json 条目 mutation（pi-mcp-management 设计 D4/D7/S6）。
  // 三条共用 McpMutationResult 判别联合 reply（:result 帧承载）：ok 分支 entry = 服务端
  // 落盘终态条目（renderer 以服务端终态校准清单）；ok:false 为拒入信封（error 含
  // 「错误 → 原因 → 修复动作」结构文案 + corruption 仅损坏拒入携带），错误态不走
  // effectiveFields（config.setCodemodeEnabled 同款信封语义）。清单变更无广播帧——§3.1
  // 打开时拉取一次 + D8 快照语义（ADR-0097 拉为主），变更可见性由 reply 终态校准承担
  //（唯一广播 = 连接测试终态 mcp:testResult，非 mutation）。──
  {
    // mcp.add（D4）：校验通过原样写入（fail-fast 拒入不走变换，分支二），reply entry =
    // 写后落盘终态条目（echo 回显）。
    type: 'mcp.add',
    branch: 'verbatim',
    contract: 'echo-value',
    replyKey: 'mcp.add:result',
    effectiveFields: ['entry'],
  },
  {
    // mcp.update（D7 编辑写回契约）：请求 entry 经合并变换后落盘——表单外键原样保留 +
    // 清空即删键 + type 键剥离 + 切换传输类型键级清理，请求值 ≠ 落盘终态（分支一），
    // reply entry = 合并后落盘终态（生效值）。
    type: 'mcp.update',
    branch: 'transformable',
    contract: 'effective-value',
    replyKey: 'mcp.update:result',
    effectiveFields: ['entry'],
  },
  {
    // mcp.setEnabled（§3.1 启停最小语义）：store 锁内仅翻转 enabled 键——请求布尔值映射
    // 为落盘形态（false 落 enabled:false 键 / true 删键，缺省启用），请求值 ≠ 落盘终态
    //（分支一）；reply entry = 写后落盘终态条目（生效值）。专用操作不带清单派生视图回写，
    // D2 丢失窗口保持锁内亚秒级（pi-mcp-store setMcpServerEnabled）。
    type: 'mcp.setEnabled',
    branch: 'transformable',
    contract: 'effective-value',
    replyKey: 'mcp.setEnabled:result',
    effectiveFields: ['entry'],
  },
  {
    // mcp.remove：删除语义（分支二），reply entry = 被删条目的删除前落盘值（回显
    // 「删掉的是这个」；renderer 按 ok 分支从清单移除该 name，不渲染 entry 本体）。
    type: 'mcp.remove',
    branch: 'verbatim',
    contract: 'echo-value',
    replyKey: 'mcp.remove:result',
    effectiveFields: ['entry'],
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
    // rename-prompt-config：style 非法归一 slug / instruction 超长截断（helper 层），reply 读回归一生效值
    type: 'config.setRenamePrompt',
    branch: 'verbatim',
    contract: 'echo-value',
    replyKey: 'config.renamePrompt',
    effectiveFields: ['style', 'instruction'],
  },
  {
    // rename-prompt-config：正整数归一（非法回默认 50），reply 读回生效值
    type: 'config.setRenameMaxLength',
    branch: 'verbatim',
    contract: 'echo-value',
    replyKey: 'config.renameMaxLength',
    effectiveFields: ['maxLength'],
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
  {
    // provider CRUD 的 set 通道：set 原值落盘 + reply 回显 providerId + broadcastProviderList
    // 全量广播（provider-message-handler handleSetProvider）。quotaAutoEnabled（optional，仅新建
    // 分支携带）供 renderer toast（provider-edit-form save 消费 → ProviderPage
    // notifyQuotaAutoEnabled），非回显字段不登记；不做乐观写回退（权威覆盖由广播承担）。
    type: 'config.setProvider',
    branch: 'verbatim',
    contract: 'echo-value',
    replyKey: 'config.providerUpdated',
    effectiveFields: ['providerId'],
  },
  // ── 分支二（workspace 域）：最近工作区列表 mutation——两条共用 reply
  // 'workspace.recentList' { records, degraded? }，写入 recent-workspaces.json 后回读
  // list() 终态列表，前端据 reply 直接更新 store（workspace-message-handler 一次往返
  // 热更新，无 reload 时序竞争）。degraded 是降级信封标记（入参非法 / 超 pin 上限拒绝），
  // optional 不入 effectiveFields（同 mcp ok:false 错误信封先例）。──
  {
    // record：使用记账写（lastUsedAt/label 刷新 + LRU 淘汰），请求 cwd 原样存储（分支二），
    // reply records = 写入 + 淘汰后的落盘终态列表。
    type: 'workspace.record',
    branch: 'verbatim',
    contract: 'echo-value',
    replyKey: 'workspace.recentList',
    effectiveFields: ['records'],
  },
  {
    // setPinned：pin/unpin 原样写 pinned 键（INV-6）；超 MAX_PINNED 拒绝（service 层
    // 返回 false）→ 列表不变 + degraded 标记，拒绝可见性由 reply 终态列表承担（无变换面）。
    type: 'workspace.setPinned',
    branch: 'verbatim',
    contract: 'echo-value',
    replyKey: 'workspace.recentList',
    effectiveFields: ['records'],
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
    rationale: 'wire reply config.toolPermissionsSaved { saved }（tool-permissions-message-handler，app 级配置与 provider 无关）；类型层登记 void，无生效值字段可回显',
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
    rationale: '动作类（终止运行中的 plan 审批流，非配置状态改值）：reply void ack，plan 状态经 session.planState 广播推回（派生视图链唯一承载，abort 前后无 mutation 生效值概念）',
  },
  {
    type: 'config.setProviderCatalogWatch',
    branch: 'non-mutation',
    contract: 'excluded',
    rationale: '动作类（页签可见期 models-store.json 轮询开关，runtime 会话内状态不持久化、renderer 无 store 副本）：reply message.status ack，变化结果经 config.providers 广播推回',
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


const REPLY_PAYLOAD_MAP_BLOCK = extractBlock('export interface ReplyPayloadMap {')  // oe-exempt:20261027:test:


const SERVER_MESSAGE_MAP_BASE_BLOCK = extractBlock('export interface ServerMessageMapBase {')  // oe-exempt:20261027:test:


/** 谓词覆盖域（ADR-0065 范围边界）：session 配置状态 / model / preset / config / mcp /
 * subagent / workspace 七域（mcp 为 pi-mcp-management 设计纳入——add/update/remove 是 mcp.json 配置
 * 状态 mutation；subagent 为 subagent-model-switch 设计纳入——setModel 是执行模型配置
 * mutation，renderer 持显示副本、回执含生效值字段；workspace 为最近工作区列表纳入——
 * record/setPinned 改 recent-workspaces.json 持久化状态，renderer 持列表副本、reply
 * 回写后终态列表） */
const MUTATION_DOMAINS = ['session', 'model', 'preset', 'config', 'mcp', 'subagent', 'workspace'] as const


/**
 * 改值动词形态（宽松 startsWith——宁可误红逼人显式归类，见文件头检查取向声明）。
 *
 * 表覆盖两批动词：① 现存清单内出现过的改值动词（set 特殊处理见 isMutationCandidate）；
 * ② 常见改值动词前瞻补齐（clear/reset/toggle/enable/disable/add）——保证「新动词 mutation
 * 出现即被逼入清单」的检查声明对常见动词命名成立，而非只对历史动词成立。新增动词前
 * 先 grep 本表避免漏配；误命中读类/动作类时以 excluded 显式登记排除理由（特性非缺陷）。
 */
const MUTATION_VERB_PREFIXES = [
  'set', 'rename', 'switch', 'create', 'update', 'delete', 'remove', 'record', 'import',
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


/** 提取 reply 形状文本：内联 `{ ... }` 直接返回；具名引用则取该声明的 body。
 *  具名查找次序：protocol.ts → ./codemode 域文件 → ./mcp 域文件（protocol.ts 头部登记约定：
 *  codemode / mcp 域 payload/reply 形状 SSOT 在各自域文件，本文件仅登记命令对）；interface
 *  与 type 联合两种声明形态均支持。
 *  ServerMessageMapBase 无该 replyKey 时回退取 ReplyPayloadMap 映射行的内联形状——适用
 *  wire reply 无具名广播条目的 RPC（如 config.setScopedModels 的 'config.scopedModels'）。 */
function extractNamedDeclarationBody(source: string, base: string): string | null {
  const iface = source.indexOf(`export interface ${base} {`)
  if (iface !== -1) {
    const end = source.indexOf('\n}', iface)
    return source.slice(iface, end)
  }
  const typeAnchor = `export type ${base} =`
  const t = source.indexOf(typeAnchor)
  if (t !== -1) {
    let end = source.indexOf('\nexport ', t)
    if (end === -1) end = source.length
    return source.slice(t, end)
  }
  return null
}


/** type alias 右侧为纯具名引用（`A` 或 `A | B | ...`，无内联形状）时返回成员名清单，否则 null。
 *  声明体尾随的下一条声明的注释块（extractNamedDeclarationBody type 分支的提取边界）先剥除再解析。 */
function typeAliasRefMembers(body: string): string[] | null {
  const eq = body.indexOf('=')
  if (eq === -1) return null
  const rhs = body
    .slice(eq + 1)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .trim()
  if (rhs === '' || rhs.includes('{')) return null
  const members = rhs.split('|').map((m) => m.trim()).filter((m) => m !== '')
  if (members.length === 0 || !members.every((m) => /^[A-Z][A-Za-z0-9]*$/.test(m))) return null
  return members
}


/** 具名引用穿透展开：type alias 右侧为纯具名引用联合时（如 SubagentSetModelReply =
 *  SubagentChatSetModelReply | SubagentSetModelAggregateReply，chat 两型再指向各自 interface），
 *  字段声明在成员类型内，单层 body 提取取不到——递归展开各成员声明体拼接进 shape，
 *  使 effective-value 断言能锚到真实字段层。右侧含内联形状（mcp 两态信封 /
 *  CodemodeSetEnabledResult）或 interface body 的不再展开（字段已在本层，既有条目提取  // oe-exempt:20261027:test:
 *  语义不变）；seen 防循环引用，深度上限防御异常嵌套。 */
function expandAliasUnionMembers(body: string, seen: Set<string>, depth = 0): string {
  const MAX_EXPAND_DEPTH = 5
  const members = depth < MAX_EXPAND_DEPTH ? typeAliasRefMembers(body) : null
  if (members === null) return body
  const parts = [body]
  for (const member of members) {
    if (seen.has(member)) continue
    seen.add(member)
    const memberBody = extractNamedDeclarationBody(PROTOCOL_SOURCE, member)
      ?? extractNamedDeclarationBody(CODEMODE_DOMAIN_SOURCE, member)
      ?? extractNamedDeclarationBody(MCP_DOMAIN_SOURCE, member)
    if (memberBody === null) continue
    parts.push(expandAliasUnionMembers(memberBody, seen, depth + 1))
  }
  return parts.join('\n')
}


function extractReplyShape(replyKey: string, requestType: string): string {
  const base = extractMapValue(SERVER_MESSAGE_MAP_BASE_BLOCK, replyKey)
  if (base !== undefined) {
    if (base.startsWith('{')) return base
    const body = extractNamedDeclarationBody(PROTOCOL_SOURCE, base)
      ?? extractNamedDeclarationBody(CODEMODE_DOMAIN_SOURCE, base)
      ?? extractNamedDeclarationBody(MCP_DOMAIN_SOURCE, base)
    if (body === null) {
      throw new Error(`reply '${replyKey}' 引用了具名类型 ${base}，但 protocol.ts / codemode / mcp 域文件中均未找到其声明`)
    }
    return expandAliasUnionMembers(body, new Set([base]))
  }
  const inline = extractMapValue(REPLY_PAYLOAD_MAP_BLOCK, requestType)
  if (inline !== undefined && inline.startsWith('{')) return inline
  throw new Error(`ServerMessageMapBase 中未找到 reply key '${replyKey}'——协议类型登记缺失`)
}


// ======================================================================
// ← src/__tests__/extension-startup-config.test.ts
// ======================================================================

let root: string


let agentDir: string


/** 造一个 fixture extension 目录（package.json 含给定 taiji 字段），返回目录路径。 */
function makeExtDir(name: string, taijiPlugin: Record<string, unknown> | null): string {
  const dir = join(root, 'ext', name)
  mkdirSync(dir, { recursive: true })
  const pkg: Record<string, unknown> = { name: `fixture-${name}`, version: '0.0.0' }
  if (taijiPlugin !== null) pkg['taiji'] = taijiPlugin
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2))
  return dir
}


// ======================================================================
// ← src/__tests__/import-service.test.ts
// ======================================================================

// getPiGlobalAgentDir 定向覆盖（缺省 rootDir 用例）：真实推导在 TAIJI_AGENT_DATA_DIR 指向
// dev/真实数据目录时会解析到 ~/.pi/agent（用户 pi CLI 目录）——fs-guard 会正确拦截。
// 用例改由 mock 定向指到 tmp fixture，精确测「缺省 rootDir = getPiGlobalAgentDir()/sessions」
// 的接线逻辑，不依赖运行时 env 巧合（vi.hoisted 同上）。
const piGlobalDirState = vi.hoisted(() => ({ dir: '' }))


vi.mock('../infra/pi/pi-maintenance.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../infra/pi/pi-maintenance.js')>()
  return {
    ...actual,
    getPiGlobalAgentDir: () => piGlobalDirState.dir,
  }
})

let fixturesRoot: string


/** 手写真实形态 session JSONL：首行 header（type/version/id/cwd/timestamp）+ session_info + message。 */
function writeSessionJsonl(filePath: string, id: string, cwd: string, name: string): void {
  const lines = [
    JSON.stringify({ type: 'session', version: 1, id, cwd, timestamp: '2026-01-01T00:00:00.000Z' }),
    JSON.stringify({ type: 'session_info', name }),
    JSON.stringify({
      type: 'message', id: `m-${id}`, parentId: null, timestamp: '2026-01-01T00:00:01.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    }),
    '',
  ]
  writeFileSync(filePath, lines.join('\n'))
}


/** 与组合根装配同构（index.ts）：pi source 的 rootDir 缺省 = pi 全局 sessions 动态推导（惰性求值）。 */
function makePiSources(): Map<ImportSourceKind, SessionImportSource> {
  return new Map<ImportSourceKind, SessionImportSource>([
    ['pi', new ExternalFileImportSource({ getRootDir: () => join(getPiGlobalAgentDir(), 'sessions') })],
  ])
}


function makeImportService(sources: ReadonlyMap<ImportSourceKind, SessionImportSource> = makePiSources()): ImportService {
  return new ImportService({
    projects: { load: () => ({ projects: [{ id: 'proj-1' }], activeProjectId: '' }) },
    sources,
  })
}


function codeOf(e: unknown): string {
  return (e as ImportServiceError).code
}


async function catchCode_z2(work: () => Promise<unknown>): Promise<string> {
  try {
    await work()
  } catch (e) {
    return codeOf(e)
  }
  return expect.unreachable('expected ImportServiceError but import succeeded')
}


// ======================================================================
// ← src/__tests__/import-source-zcode.test.ts
// ======================================================================

// C1 回归锚基建：openZcodeSessionDb 以 vi.fn 包装（默认透传真实现，既有用例行为
// 不变）——dispose 契约用例以 mockImplementation 模拟 L3 命中形态（见该 describe 说明）。
vi.mock('@zhushanwen/zcode-session-source', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@zhushanwen/zcode-session-source')>()
  return { ...actual, openZcodeSessionDb: vi.fn((dbPath: string) => actual.openZcodeSessionDb(dbPath)) }
})

let fixturesRoot_m2: string


/** fixture 库 session 行种子。 */
interface SessionSeed {  // oe-exempt:20261027:test:
  id: string
  title: string
  directory: string
  taskType: string
  timeCreated: number
  timeUpdated: number
}


/** fixture 库 message 行种子（id 需与 parts 的隐式 message_id `m-${i}` 形态对齐）。 */
interface MessageSeed {  // oe-exempt:20261027:test:
  id: string
  sessionId: string
  sequence: number
  /** message.data 列 JSON 字符串（converter 消费 role/time 字段）。 */
  data: string
}


/**
 * 建最小列集 fixture 库（宿主 schema 0.16.5 的消费方子集：session 六列 + message/part
 * 存在性 + schema_migration）。parts 直挂 session_id（本单元的字节聚合只消费
 * part.session_id/part.data）；messages 缺省不插（getSessionTranscript LEFT JOIN 从
 * message 侧起查，空表 = 空会话）；需要转换器消费行集时（compaction 降级明细）插入。
 */
function buildFixtureDb(
  dbPath: string,
  sessions: SessionSeed[],
  parts: Array<{ sessionId: string; data: string }>,
  messages: MessageSeed[] = [],
  opts?: { omitSessionTable?: boolean; schemaVersion?: string },
): void {
  const db = new DatabaseSync(dbPath)
  try {
    db.exec('BEGIN')
    db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, sequence INTEGER, data TEXT NOT NULL)')
    db.exec(
      'CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, sequence INTEGER, data TEXT NOT NULL)',
    )
    if (!opts?.omitSessionTable) {
      db.exec(
        'CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL, title TEXT NOT NULL, ' +
          "task_type TEXT NOT NULL DEFAULT 'interactive', time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL)",
      )
      const ins = db.prepare('INSERT INTO session (id, directory, title, task_type, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)')
      for (const s of sessions) ins.run(s.id, s.directory, s.title, s.taskType, s.timeCreated, s.timeUpdated)
    }
    const insPart = db.prepare('INSERT INTO part (id, message_id, session_id, sequence, data) VALUES (?, ?, ?, ?, ?)')
    parts.forEach((p, i) => insPart.run(`p-${i}`, `m-${i}`, p.sessionId, i, p.data))
    const insMsg = db.prepare('INSERT INTO message (id, session_id, sequence, data) VALUES (?, ?, ?, ?)')
    for (const m of messages) insMsg.run(m.id, m.sessionId, m.sequence, m.data)
    db.exec(
      'CREATE TABLE schema_migration (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, app_version TEXT, time_applied INTEGER NOT NULL)',
    )
    db.prepare('INSERT INTO schema_migration (id, checksum, app_version, time_applied) VALUES (?, ?, ?, ?)').run(
      '0001_seed',
      'x',
      opts?.schemaVersion ?? '0.16.5',
      1,
    )
    db.exec('COMMIT')
  } finally {
    db.close()
  }
}


/** 预置一个太极扫描集 session 文件（header.id = 归一化形态打标域断言用）。 */
function seedTaijiSession(id: string): void {
  const fileName = `2026-01-01T00.00.00.000Z_${id}.jsonl`
  const filePath = join(getSessionsDir(), fileName)
  mkdirSync(getSessionsDir(), { recursive: true })
  writeFileSync(
    filePath,
    `${JSON.stringify({ type: 'session', version: 3, id, cwd: '/tmp/zc-seed-cwd', timestamp: '2026-01-01T00:00:00.000Z' })}\n`,
  )
}


function makeSource(dbPath: string): ZcodeImportSource {
  return new ZcodeImportSource({ getHostDbPath: () => dbPath })
}


function codeOf_m2(e: unknown): string {
  return (e as ImportServiceError_z2).code
}


async function catchCode_z3(work: () => Promise<unknown>): Promise<string> {
  try {
    await work()
  } catch (e) {
    return codeOf_m2(e)
  }
  return expect.unreachable('expected ImportServiceError but call succeeded')
}


// ======================================================================
// ← src/__tests__/project-store.test.ts
// ======================================================================

function mkProject(id: string, name: string, lastUsedAt = 0): Project {
  return { id, name, lastUsedAt }
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('wiring-bundle', () => {
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('index-composition-root-wiring', () => {
describe('组合根 watchdog / rolling-restart 接线（源码级检查）', () => {
  it('看门狗：import startWatchdog 且 main() 内启动；broadcast 出口双投递（renderer + 滚动重启编排）', () => {
    expect(source).toMatch(/import\s*\{[^}]*startWatchdog[^}]*\}\s*from\s*'\.\/infra\/watchdog\.js'/)
    expect(source).toContain('watchdogHandle = startWatchdog({')
    // renderer 通知出口（useMemoryPressure 通道）
    expect(source).toContain("type: 'watchdog:memoryPressure'")
    // 同拍喂滚动重启编排（critical 档 = D5 决策输入；warn 档编排侧忽略）
    expect(source).toContain('rollingRestartHandleLocal.onMemoryPressure(payload)')
  })

  it('滚动重启：import startRollingRestart 且启动；status provider 注入 server（只读 RPC 拉取）', () => {
    expect(source).toMatch(
      /import\s*\{[^}]*startRollingRestart[^}]*\}\s*from\s*'\.\/services\/session\/rolling-restart\.js'/,
    )
    expect(source).toContain('startRollingRestart({')
    expect(source).toContain('server.setRollingRestartStatusProvider(')
  })

  it('armed 门共用：滚动重启 armed 取自 resolveWatchdogConfig 结果（Gate W 单一开关）', () => {
    expect(source).toContain('const watchdogConfig = resolveWatchdogConfig(process.env)')
    expect(source).toContain('armed: watchdogConfig.armed,')
  })

  it('水位定时器：startMemoryWatermarkTimer 以 session 数 + pi 进程数为采样源启动', () => {
    expect(source).toContain('startMemoryWatermarkTimer(')
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('crash-journal-composition-root-wiring', () => {
afterEach(async () => {
  await closeCrashJournal() // 单例复位（??= 幂等语义；下个用例可指向新 tmpdir）
})
afterAll(() => {
  // maxRetries+retryDelay（crash-journal.test.ts 同款）：teardown 与在途异步写竞争吞瞬态
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})
describe('runtime 组合根初始化 journal 单例（u-init）', () => {
  it('index.ts import 并在 main() 内调用 initCrashJournal(getDataDir(), logger)（对齐 initLogger 时序 + 留痕出口注入）', () => {
    const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')

    // 接线存在性：import 单例 init + 在组合根调用（唯一生产调用点；main 侧另有双胞胎）。
    // import 行随 #31 扩为多导出（closeCrashJournal 进 shutdown 序）——断言改为对 init
    // 符号的 import 存在性（防字面量与导出清单耦合），close 接线由 shutdown 序测试检查。
    expect(source).toMatch(/import\s*\{[^}]*initCrashJournal[^}]*\}\s*from\s*'\.\/infra\/crash-journal\.js'/)
    expect(source).toContain('initCrashJournal(getDataDir(), logger)')

    // 时序：initLogger 之后（initLogger 已验证 getDataDir() 可用）、token 解析 / service
    // 构造之前（任何一个 service 都可能 append journal，晚于其构造 = 早期事件静默丢）
    const initLoggerIdx = source.indexOf('initLogger(getDataDir())')
    const initJournalIdx = source.indexOf('initCrashJournal(getDataDir(), logger)')
    const tokenIdx = source.indexOf('const runtimeToken = resolveRuntimeToken()')
    const serviceIdx = source.indexOf('const pm = new ProcessManager(')
    expect(initLoggerIdx).toBeGreaterThan(-1)
    expect(tokenIdx).toBeGreaterThan(-1)
    expect(serviceIdx).toBeGreaterThan(-1)
    expect(initJournalIdx).toBeGreaterThan(initLoggerIdx)
    expect(initJournalIdx).toBeLessThan(tokenIdx)
    expect(initJournalIdx).toBeLessThan(serviceIdx)
  })

  it('init 前 getCrashJournal() 为 no-op：append 不落盘、crashes 目录不创建（未初始化契约）', () => {
    const dir = makeDataDir()
    expect(() =>
      getCrashJournal().append({ layer: 'runtime', event: 'crash', detailDigest: 'pre-init' }),
    ).not.toThrow()
    expect(existsSync(join(dir, 'logs', 'crashes'))).toBe(false)
  })

  it('init 后 getCrashJournal() 非 no-op：事件真实落 <dataDir>/logs/crashes/runtime.jsonl（生产链路接通）', async () => {
    const dir = makeDataDir()
    initCrashJournal(dir)

    // 组合根初始化后，runtime 侧事件经同一单例可见（pi-respawn / watchdog 防线 / 生命周期共用）
    getCrashJournal().append({
      layer: 'pi',
      event: 'auto-respawn',
      reason: 'scheduled',
      sessionId: 's1',
      detailDigest: 'attempt=1 delayMs=5000',
    })
    await closeCrashJournal()

    const journal = join(dir, 'logs', 'crashes', 'runtime.jsonl')
    expect(existsSync(journal)).toBe(true)
    const rows = readFileSync(journal, 'utf8').split('\n').filter((l) => l !== '')
    expect(rows).toHaveLength(1)
    expect(JSON.parse(rows[0]!)).toMatchObject({
      layer: 'pi',
      event: 'auto-respawn',
      reason: 'scheduled',
      sessionId: 's1',
    })
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('binding-registry-hydrate', () => {
// ── Part 1：hydrateBindingMeta 纯函数契约 ────────────────────────────

describe('hydrateBindingMeta · 设计文档 §3.3 决策 1 矩阵（期望硬编码）', () => {
  it('A-1/A4: restore 入口五字段全量回填', () => {
    const s = freshSession()
    hydrateBindingMeta(
      s,
      {
        projectId: 'proj-a1',
        spawnSource: 'agent',
        parentAgentSessionId: 'pa-1',
        handedOffTo: 'next-1',
        launchPresetId: 'preset-r',
      },
      'restore',
    )
    expect(s.projectId).toBe('proj-a1')
    expect(s.spawnSource).toBe('agent')
    expect(s.parentAgentSessionId).toBe('pa-1')
    expect(s.handedOffTo).toBe('next-1')
    expect(s.launchPresetId).toBe('preset-r')
  })

  it('A-8: fork 选择性继承——launchPresetId/projectId 生效，spawnSource/parentAgentSessionId/handedOffTo 刻意不继承（多传也不落对象）', () => {
    const s = freshSession()
    // 同一次调用把 none 字段的值也喂进去——hydrate 必须按矩阵 fork 列排斥
    hydrateBindingMeta(
      s,
      {
        launchPresetId: 'pk',
        projectId: 'proj-a2',
        spawnSource: 'agent',
        parentAgentSessionId: 'leak-pa',
        handedOffTo: 'leak-next',
      },
      'fork',
    )
    // 生效的两字段（inherit-source）
    expect(s.launchPresetId).toBe('pk')
    expect(s.projectId).toBe('proj-a2')
    // 刻意不继承的三字段：键都不存在（in 检查而非 ===undefined，防「写了 undefined」假绿）
    expect(Object.hasOwn(s, 'spawnSource')).toBe(false)
    expect(Object.hasOwn(s, 'parentAgentSessionId')).toBe(false)
    expect(Object.hasOwn(s, 'handedOffTo')).toBe(false)
  })

  it('fork 无归属：projectId 不传或 undefined → 对象上无该键（现状等价语义，缺 A-2 内存量）', () => {
    const sNone = freshSession()
    hydrateBindingMeta(sNone, {}, 'fork')
    const sUndef = freshSession()
    hydrateBindingMeta(sUndef, { launchPresetId: 'pk-fallback', projectId: undefined }, 'fork')
    expect(Object.hasOwn(sNone, 'projectId')).toBe(false)
    expect(Object.hasOwn(sUndef, 'projectId')).toBe(false)
    // 对照组：fork 的另一字段正常生效，证明不是整体没跑
    expect(sUndef.launchPresetId).toBe('pk-fallback')
  })

  it('create 入口：六个 options 字段传入即生效；handedOffTo 为 create=none 不落对象', () => {
    const s = freshSession()
    hydrateBindingMeta(
      s,
      {
        launchPresetId: 'preset-c',
        projectId: 'proj-c',
        spawnSource: 'user',
        parentAgentSessionId: 'pa-c',
        handedOffTo: 'must-not-leak',
        modelId: 'model-c',
        thinkingLevel: 'high',
      },
      'create',
    )
    expect(s.launchPresetId).toBe('preset-c')
    expect(s.projectId).toBe('proj-c')
    expect(s.spawnSource).toBe('user')
    expect(s.parentAgentSessionId).toBe('pa-c')
    expect(s.modelId).toBe('model-c')
    expect(s.thinkingLevel).toBe('high')
    expect(Object.hasOwn(s, 'handedOffTo')).toBe(false)
  })

  it('handoff 承接通道说明性用例：实现上承接复用 entry=\'create\' 调用 hydrate（通道独立性由 CREATE_DERIVED_CALLERS 清单静态检查承诺，见 Part 2 handoff-service 断言），故此处按 create 入口断言承接值注入生效', () => {
    const s = freshSession()
    hydrateBindingMeta(s, { projectId: 'src-p' }, 'create')
    expect(s.projectId).toBe('src-p')
  })

  it('undefined 值跳过语义：任何 entry 下 meta 值为 undefined 都不产生键', () => {
    const entries: BindingEntryKind[] = ['create', 'handoff', 'restore', 'fork']
    for (const entry of entries) {
      const s = freshSession()
      hydrateBindingMeta(
        s,
        {
          launchPresetId: undefined,
          projectId: undefined,
          spawnSource: undefined,
          parentAgentSessionId: undefined,
          handedOffTo: undefined,
          modelId: undefined,
          thinkingLevel: undefined,
        },
        entry,
      )
      for (const field of Object.keys(SAMPLE_META) as BindingFieldKey[]) {
        expect(Object.hasOwn(s, field), `${entry}/${field}: undefined 值不得产生键`).toBe(false)
      }
    }
  })

  it('遍历矩阵：注册表每键 × 四入口的 patch/skip 行为与硬编码矩阵一致（骨架从表读、期望不读表）', () => {
    /**
     * hydrate 行为派生视图矩阵——设计文档 §3.3 决策 1 的手工誊写：
     * patch = 该格语义为 options / inherit-source / meta / resolved-in-entry（hydrate 一律回填）
     * skip  = 该格语义为 'none'（刻意不回填）。
     * 本表是外部事实锚点；BINDING_FIELDS 改行而本表未跟 → 此处红，逼 review 表语义决策。
     */
    const EXPECTED_PATCH: Record<BindingFieldKey, Record<BindingEntryKind, boolean>> = {
      launchPresetId:       { create: true,  handoff: false, restore: true,  fork: true  },
      projectId:            { create: true,  handoff: true,  restore: true,  fork: true  },
      spawnSource:          { create: true,  handoff: false, restore: true,  fork: false },
      parentAgentSessionId: { create: true,  handoff: false, restore: true,  fork: false },
      handedOffTo:          { create: false, handoff: false, restore: true,  fork: false },
      modelId:              { create: true,  handoff: true,  restore: false, fork: true  },
      thinkingLevel:        { create: true,  handoff: true,  restore: false, fork: true  },
    }

    const entries: BindingEntryKind[] = ['create', 'handoff', 'restore', 'fork']
    for (const field of Object.keys(BINDING_FIELDS) as BindingFieldKey[]) {
      for (const entry of entries) {
        const s = freshSession()
        hydrateBindingMeta(s, SAMPLE_META, entry)
        if (EXPECTED_PATCH[field][entry]) {
          expect(
            s[field],
            `${entry}/${field}: 应回填为传入值`,
          ).toBe(SAMPLE_META[field])
        } else {
          expect(
            Object.hasOwn(s, field),
            `${entry}/${field}: none 格刻意不继承，不得出现该键`,
          ).toBe(false)
        }
      }
    }
  })

  it('骨架防护：本测试硬编码矩阵与 BINDING_FIELDS 注册表键集一致（新增绑定字段必须同步更新期望矩阵）', () => {
    const registryKeys = (Object.keys(BINDING_FIELDS) as BindingFieldKey[]).sort()
    const matrixKeys = (Object.keys({
      launchPresetId: true,
      projectId: true,
      spawnSource: true,
      parentAgentSessionId: true,
      handedOffTo: true,
      modelId: true,
      thinkingLevel: true,
    }) as BindingFieldKey[]).sort()
    expect(matrixKeys).toEqual(registryKeys)
  })
})
describe('入口接线锁定 · session-lifecycle.ts 三处 hydrateBindingMeta 调用', () => {
  const callBlocks = extractCallBlocks(lifecycleSrc, /hydrateBindingMeta\s*\(/g)

  it('恰好 3 处调用（import/注释提及不含 "(" 形态不计入），尾参依序 create → restore → fork', () => {
    expect(callBlocks.length).toBe(3)
    const endings = callBlocks.map((b) => {
      const m = b.match(/,\s*'(\w+)'\s*\)\s*$/)
      expect(m, `调用块缺少 ', 'entry')' 尾参形态:\n${b}`).not.toBeNull()
      return m![1]
    })
    expect(endings).toEqual(['create', 'restore', 'fork'])
  })

  it("restore 调用块全量接线：projectId/spawnSource/parentAgentSessionId/handedOffTo 四字段均取自 target.*（缺陷 A-1 锁定）", () => {
    const block = callBlocks.find((b) => /,\s*'restore'\s*\)\s*$/.test(b))
    expect(block).toBeDefined()
    expect(block!).toMatch(/\bprojectId\s*:\s*target\./)
    expect(block!).toMatch(/\bspawnSource\s*:\s*target\./)
    expect(block!).toMatch(/\bparentAgentSessionId\s*:\s*target\./)
    expect(block!).toMatch(/\bhandedOffTo\s*:\s*target\./)
  })

  it('fork 调用块选择性继承：含 launchPresetId/projectId 接线，且块内无 spawnSource/handedOffTo 字样（A-8「刻意不继承」接线级锁定）', () => {
    const block = callBlocks.find((b) => /,\s*'fork'\s*\)\s*$/.test(b))
    expect(block).toBeDefined()
    expect(block!).toMatch(/\blaunchPresetId\s*:/)
    expect(block!).toMatch(/\bprojectId\s*:/)
    expect(block!).not.toMatch(/spawnSource/)
    expect(block!).not.toMatch(/handedOffTo/)
  })

  it('create 调用块接线四 options 字段（handoff 承接通道复用此入口）', () => {
    const block = callBlocks.find((b) => /,\s*'create'\s*\)\s*$/.test(b))
    expect(block).toBeDefined()
    expect(block!).toMatch(/\blaunchPresetId\s*:/)
    expect(block!).toMatch(/\bprojectId\s*:/)
    expect(block!).toMatch(/\bspawnSource\s*:/)
    expect(block!).toMatch(/\bparentAgentSessionId\s*:/)
  })
})
describe('入口接线锁定 · handoff-service.ts 承接通道（CREATE_DERIVED_CALLERS 承诺核对）', () => {
  it('sessionService.create options 含 projectId:（缺陷 C 继承源归属），且不含 spawnSource（防顺手继承漂移）', () => {
    const blocks = extractCallBlocks(handoffSrc, /sessionService\.create\s*\(/g)
    expect(blocks.length).toBe(1)
    expect(blocks[0]).toMatch(/\bprojectId\s*:/)
    expect(blocks[0]).not.toMatch(/spawnSource/)
    expect(blocks[0]).not.toMatch(/parentAgentSessionId/)
  })
})
// ════════════════ 来源: create-derived-callers.test.ts ════════════════

describe('create-derived-callers', () => {
  /** 本测试文件位于 <src>/__tests__/，上两级即扫描根 packages/runtime/src */
  const SRC_DIR = resolve(fileURLToPath(import.meta.url), '..', '..')

  /** 决策 1b 主流程排除集：create 定义处 + 生命周期直连处（posix 相对路径） */
  const SCAN_EXCLUDED_FILES = new Set([
    'services/session/session-service.ts',
    'services/session/session-lifecycle.ts',
  ])

  /**
   * 绑定字段名 → create options 实参形参名的别名表。
   *
   * launchPresetId 绑定字段经 session-lifecycle.create 的 options.presetId 形参传入
   *（见该文件 create 签名 docstring「Launch preset id」，内部落盘为 launchPresetId），
   * 文本断言需接受两种拼写；其余字段实参名与字段名一致，无需别名。
   */
  const FIELD_ALIASES: Partial<Record<BindingFieldKey, readonly string[]>> = {
    launchPresetId: ['presetId'],
  }

  /** 字段名 + 别名的全部可接受文本拼写（别名字符串天然不同于长名，无子串吞噬问题） */
  function acceptedNames(field: BindingFieldKey): readonly string[] {
    return [field, ...(FIELD_ALIASES[field] ?? [])]
  }

  /** 按 semantic 通道的禁传绑定字段（防顺手继承漂移；handoff 刻意全 none 的字段在此落地） */
  const FORBIDDEN_FIELDS_BY_SEMANTIC: Record<CreateDerivedCaller['semantic'], readonly BindingFieldKey[]> = {
    'user-facing': ['spawnSource', 'parentAgentSessionId'],
    // agent-managed（D8，2026-09 裁决）：projectId 已从禁传清单移除——该通道经服务端
    // 从父会话 summary 派生 projectId（不读 params.projectId，见 session-binding-fields.ts
    // 的登记注释与 session-manager-handler 单测的伪造参数断言）。
    // 本通道其余写入字段（spawnSource / parentAgentSessionId）不属本清单：它们由服务端
    // 从路由上下文注入、同样不读请求参数，属「允许透传的绑定字段」（登记 passedBindingFields
    // 承诺 + handler 的 params 信任边界检查），列入禁传会与本通道实际传参自相矛盾。
    // 「不得由请求参数携带」的精神由 handler 侧单测（伪造 spawnSource/parentAgentSessionId
    // 被忽略）与登记注释共同保全。
    'agent-managed': [],
    handoff: ['spawnSource', 'parentAgentSessionId', 'launchPresetId'],
  }

  type CreateDerivedCaller = (typeof CREATE_DERIVED_CALLERS)[number]

  const LEGAL_SEMANTICS: readonly CreateDerivedCaller['semantic'][] = ['user-facing', 'agent-managed', 'handoff']

  /** 递归收集 src 下全部 .ts 文件绝对路径（跳过 __tests__ 目录） */
  function listSourceFiles(dir: string): string[] {
    const out: string[] = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__') out.push(...listSourceFiles(fullPath))
      } else if (entry.isFile() && entry.name.endsWith('.ts')) {
        out.push(fullPath)
      }
    }
    return out
  }

  /** 提取每处 sessionService.create( 调用窗（括号平衡 + 字符串感知语义在共享 helper，T11 收敛）。 */
  function extractSessionCreateWindows(content: string) {
    return extractCallWindows(content, /sessionService\.create\(/g)
  }

  describe('CREATE_DERIVED_CALLERS 入口清单检查（sidecar-binding-sync §3.3 决策 1b）', () => {
    it('静态扫描 sessionService.create( 命中文件集合与登记清单完全相等（双向：漏登记红 / 失效登记红）', () => {
      const hitFiles = new Set<string>()
      for (const absPath of listSourceFiles(SRC_DIR)) {
        const relPosix = relative(SRC_DIR, absPath).split(sep).join('/')
        if (SCAN_EXCLUDED_FILES.has(relPosix)) continue
        if (/sessionService\.create\(/.test(readFileSync(absPath, 'utf8'))) hitFiles.add(relPosix)
      }
      const registeredFiles = new Set(CREATE_DERIVED_CALLERS.map((caller) => caller.file))

      const unregistered = [...hitFiles].filter((f) => !registeredFiles.has(f)).sort()
      const stale = [...registeredFiles].filter((f) => !hitFiles.has(f)).sort()

      expect(unregistered, [
        '发现未登记的 sessionService.create 派生调用点：',
        ...unregistered.map((f) => `  - ${f}`),
        '新调用点的绑定字段传参必须受检查约束——请到 infra/pi/session-binding-fields.ts 的',
        'CREATE_DERIVED_CALLERS 登记该文件（file / semantic / passedBindingFields），见设计文档 §3.3 决策 1b 与 G2。',
      ].join('\n')).toEqual([])

      expect(stale, [
        '以下登记项对应的 sessionService.create 调用点已从源码消失（登记失效）：',
        ...stale.map((f) => `  - ${f}`),
        '请从 infra/pi/session-binding-fields.ts 的 CREATE_DERIVED_CALLERS 移除失效条目，保持清单即事实。',
      ].join('\n')).toEqual([])
    })

    it('每个登记项的 file 相对路径都指向实际存在的源码文件', () => {
      for (const caller of CREATE_DERIVED_CALLERS) {
        expect(existsSync(resolve(SRC_DIR, caller.file)), `登记项文件不存在：${caller.file}`).toBe(true)
      }
    })

    it('每个登记项的实际传参窗口包含其 passedBindingFields 全部字段（锚定传参承诺，防漏传）', () => {
      for (const caller of CREATE_DERIVED_CALLERS) {
        const content = readFileSync(resolve(SRC_DIR, caller.file), 'utf8')
        const windows = extractSessionCreateWindows(content)
        expect(windows.length, `${caller.file} 中提取到 0 处 sessionService.create 调用窗口，无法校验传参承诺`).toBeGreaterThan(0)

        for (const window of windows) {
          for (const field of caller.passedBindingFields) {
            const names = acceptedNames(field)
            expect(
              names.some((name) => window.text.includes(name)),
              `${caller.file}:${window.line} 的 create 调用登记承诺透传绑定字段 "${field}"，` +
              `但调用窗口内未出现任何可接受拼写（${names.join(' | ')}）——漏传承诺字段，违反决策 1b。\n` +
              `窗口文本：\n${window.text}`,
            ).toBe(true)
          }
        }
      }
    })

    it('各 semantic 通道的实际传参窗口不含禁传绑定字段（防顺手继承漂移）', () => {
      for (const caller of CREATE_DERIVED_CALLERS) {
        const content = readFileSync(resolve(SRC_DIR, caller.file), 'utf8')
        for (const window of extractSessionCreateWindows(content)) {
          for (const field of FORBIDDEN_FIELDS_BY_SEMANTIC[caller.semantic]) {
            const names = acceptedNames(field)
            expect(
              names.some((name) => window.text.includes(name)),
              `${caller.file}:${window.line}（${caller.semantic} 通道）的 create 调用出现了禁传绑定字段 "${field}"` +
              `（注册表矩阵该通道列为 none，防顺手继承漂移）——请删除该传参或修订通道语义。\n` +
              `窗口文本：\n${window.text}`,
            ).toBe(false)
          }
        }
      }
    })

    it('登记项 semantic 取值合法（user-facing | agent-managed | handoff）', () => {
      for (const caller of CREATE_DERIVED_CALLERS) {
        expect(
          LEGAL_SEMANTICS,
          `${caller.file} 的 semantic "${String(caller.semantic)}" 不合法，合法值：${LEGAL_SEMANTICS.join(' | ')}`,
        ).toContain(caller.semantic)
      }
    })
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('mutation-reply-contract', () => {
describe('MUTATION_RPC_REGISTRY 清单检查（ADR-0065 / C-pi-14，D8 机器强制）', () => {
  it('谓词扫描 ClientMessageType 的候选 mutation 与登记清单完全相等（双向：漏登记红 / 登记失效红）', () => {
    const candidates = listClientMessageTypes().filter(isMutationCandidate)
    const registered = MUTATION_RPC_REGISTRY.map((e) => e.type)

    const unregistered = candidates.filter((t) => !registered.includes(t)).sort()
    const stale = registered.filter((t) => !candidates.includes(t)).sort()

    expect(unregistered, [
      '发现未登记的 mutation 类 RPC：',
      ...unregistered.map((t) => `  - ${t}`),
      '全部 mutation RPC 必须登记契约归类（ADR-0065 两分支裁决标准）——',
      '请到 packages/runtime/src/__tests__/wiring-bundle.test.ts 的 MUTATION_RPC_REGISTRY',
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
    // setProvider echo-value：providerId 必需回显（quotaAutoEnabled optional 供 toast，不入契约）
    const providerUpdatedEcho: HasRequiredField<ServerMessageMap['config.providerUpdated'], 'providerId'> = true
    // mcp 域（pi-mcp-management）：McpMutationResult 判别联合的 ok 分支 entry 必需——
    // Extract 收窄到成功分支再断言（'entry' 非全联合公共键，keyof 交集只含判别字段）
    const mcpMutationEntry: HasRequiredField<Extract<ServerMessageMap['mcp.add:result'], { ok: true }>, 'entry'> = true
    // subagent.setModel（subagent-model-switch）：判别联合按 kind 收窄到 effective 分支——
    // 生效模型 ref 与生效 thinking 档位必需（recorded / 聚合非 switched 成员无生效值属
    // 设计内合法产出，同 mcp ok:false 错误信封不在断言范围）
    const subagentSetModelEffectiveModel: HasRequiredField<Extract<ServerMessageMap['subagent.modelSet'], { kind: 'effective' }>, 'effectiveModel'> = true
    const subagentSetModelEffectiveThinking: HasRequiredField<Extract<ServerMessageMap['subagent.modelSet'], { kind: 'effective' }>, 'effectiveThinkingLevel'> = true
    // workspace 域（最近工作区列表）：echo-value 的 records 必需回显（degraded optional
    // 是降级信封标记，不入契约）
    const workspaceRecentListRecords: HasRequiredField<ServerMessageMap['workspace.recentList'], 'records'> = true

    const assertions = [
      modelSwitchProvider, modelSwitchModelId, thinkingLevel,
      presetCreateEcho, presetUpdateEcho, engineIdEcho,
      smartContextEnabledEcho, terminalConfigEcho, scopedModelsEffective,
      providerUpdatedEcho, mcpMutationEntry,
      subagentSetModelEffectiveModel, subagentSetModelEffectiveThinking,
      workspaceRecentListRecords,
    ]
    expect(assertions, '类型断言清单意外为空——本用例失效，请检查').not.toHaveLength(0)
    expect(assertions.every(Boolean)).toBe(true)
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('extension-startup-config', () => {
// [round6 慢用例治理] 删除推迟 afterAll：每例 mkdtempSync 独占目录（隔离不变）。
const extStartupRoots: string[] = []
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ext-startup-config-'))
  extStartupRoots.push(root)
  agentDir = join(root, 'agent')
  mkdirSync(agentDir, { recursive: true })
})
afterAll(() => {
  for (const d of extStartupRoots) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})
describe('readDeclaredStartupConfigs', () => {
  it('收集合法声明并保留 content 深结构', () => {
    const dir = makeExtDir('ok', {
      startupConfig: [{ path: 'config/a-ext-config.json', content: { x: { y: [1, 2] } } }],
    })
    const entries = readDeclaredStartupConfigs([dir])
    expect(entries).toHaveLength(1)
    expect(entries[0]!.path).toBe('config/a-ext-config.json')
    expect(entries[0]!.content).toEqual({ x: { y: [1, 2] } })
    expect(entries[0]!.source).toBe('ok')
  })

  it('目录无 package.json → 静默跳过（discovery 噪音非错误）', () => {
    const dir = join(root, 'ext', 'no-pkg')
    mkdirSync(dir, { recursive: true })
    expect(readDeclaredStartupConfigs([dir])).toEqual([])
  })

  it('坏 JSON package.json / startupConfig 非数组 / 无 taiji 字段 → 跳过', () => {
    const badJson = join(root, 'ext', 'bad-json')
    mkdirSync(badJson, { recursive: true })
    writeFileSync(join(badJson, 'package.json'), '{not json')
    const notArray = makeExtDir('not-array', { startupConfig: 'nope' })
    const noField = makeExtDir('no-field', { role: 'universal' })

    expect(readDeclaredStartupConfigs([badJson, notArray, noField])).toEqual([])
  })

  it('非法条目形状逐条拒绝：绝对路径 / `..` 段 / content 非 object', () => {
    const dir = makeExtDir('mixed', {
      startupConfig: [
        { path: '/etc/passwd', content: { a: 1 } },
        { path: 'config/../../escape.json', content: { a: 1 } },
        { path: 'config/b.json', content: [1, 2] },
        { path: 'config/b.json', content: 'str' },
        { path: '', content: { a: 1 } },
        { path: 'config/ok.json', content: { a: 1 } },
      ],
    })
    const entries = readDeclaredStartupConfigs([dir])
    expect(entries).toHaveLength(1)
    expect(entries[0]!.path).toBe('config/ok.json')
  })
})
describe('ensureDeclaredStartupConfigs', () => {
  it('缺失 → 首建：内容 2 空格缩进 + 尾换行 + 0600 + 递归建父目录', () => {
    const dir = makeExtDir('creator', {
      startupConfig: [{ path: 'config/deep/nested/x-ext-config.json', content: { enabled: true, list: [] } }],
    })
    const report = ensureDeclaredStartupConfigs([dir], agentDir)
    expect(report).toEqual({ ensured: 1, skipped: 0, failed: 0 })

    const target = join(agentDir, 'config/deep/nested/x-ext-config.json')
    expect(readFileSync(target, 'utf-8')).toBe(`${JSON.stringify({ enabled: true, list: [] }, null, 2)}\n`)
    const mode = statSync(target).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('已存在 → 一律跳过，绝不覆盖（含用户改过的内容）', () => {
    const dir = makeExtDir('keeper', {
      startupConfig: [{ path: 'config/x-ext-config.json', content: { enabled: true } }],
    })
    const target = join(agentDir, 'config/x-ext-config.json')
    mkdirSync(join(agentDir, 'config'), { recursive: true })
    writeFileSync(target, '{"user":"edited"}\n', 'utf-8')

    const report = ensureDeclaredStartupConfigs([dir], agentDir)
    expect(report).toEqual({ ensured: 0, skipped: 1, failed: 0 })
    expect(readFileSync(target, 'utf-8')).toBe('{"user":"edited"}\n')
  })

  it('read 阶段被拒的条目不进 ensure（不影响其余条目）', () => {
    const dir = makeExtDir('mixed', {
      startupConfig: [
        { path: '/abs/path.json', content: { a: 1 } }, // read 阶段形状校验被拒
        { path: 'config/ok.json', content: { a: 1 } },
      ],
    })
    const report = ensureDeclaredStartupConfigs([dir], agentDir)
    expect(report).toEqual({ ensured: 1, skipped: 0, failed: 0 })
    expect(existsSync(join(agentDir, 'config/ok.json'))).toBe(true)
  })

  it('ensure 阶段 IO 失败计入 failed：父路径被同名普通文件占住（mkdir EEXIST）不炸不误计 skipped', () => {
    const dir = makeExtDir('blocked', {
      startupConfig: [{ path: 'config/x.json', content: { a: 1 } }],
    })
    const dirOk = makeExtDir('after', {
      startupConfig: [{ path: 'other/ok.json', content: { a: 1 } }],
    })
    // agentDir/config 是普通文件（非目录）→ mkdirSync(dirname) 抛错 → failed；
    // 同批其余条目（other/ok.json）不受影响
    writeFileSync(join(agentDir, 'config'), 'not a dir', 'utf-8')
    const report = ensureDeclaredStartupConfigs([dir, dirOk], agentDir)
    expect(report).toEqual({ ensured: 1, skipped: 0, failed: 1 })
    expect(existsSync(join(agentDir, 'other/ok.json'))).toBe(true)
  })

  it('病态竞态：broken symlink 占位 → O_EXCL 拒写穿，EEXIST 落 failed 且指向处无泄漏', { skip: process.platform === 'win32' }, () => {
    const dir = makeExtDir('symlinked', {
      startupConfig: [{ path: 'config/linked.json', content: { a: 1 } }],
    })
    const target = join(agentDir, 'config/linked.json')
    mkdirSync(join(agentDir, 'config'), { recursive: true })
    // broken symlink：existsSync 沿链接解析为 false，但 O_EXCL 对符号链接恒 EEXIST（POSIX）
    symlinkSync(join(agentDir, 'nowhere.json'), target)
    const report = ensureDeclaredStartupConfigs([dir], agentDir)
    expect(report).toEqual({ ensured: 0, skipped: 0, failed: 1 })
    // 未写穿链接：指向处不产生文件，占位仍是符号链接本身
    expect(existsSync(join(agentDir, 'nowhere.json'))).toBe(false)
    expect(lstatSync(target).isSymbolicLink()).toBe(true)
  })

  it('跨包重复 path 声明：仅首个生效（先到者 ensured），后续不覆盖', () => {
    const dirA = makeExtDir('first', {
      startupConfig: [{ path: 'config/dup.json', content: { who: 'first' } }],
    })
    const dirB = makeExtDir('second', {
      startupConfig: [{ path: 'config/dup.json', content: { who: 'second' } }],
    })
    const report = ensureDeclaredStartupConfigs([dirA, dirB], agentDir)
    expect(report).toEqual({ ensured: 1, skipped: 0, failed: 0 })
    expect(JSON.parse(readFileSync(join(agentDir, 'config/dup.json'), 'utf-8'))).toEqual({ who: 'first' })
  })

  it('多 extension 多条目全部处理，幂等二次跑全 skipped', () => {
    const dirA = makeExtDir('a', {
      startupConfig: [{ path: 'config/a.json', content: { from: 'a' } }],
    })
    const dirB = makeExtDir('b', {
      startupConfig: [
        { path: 'config/b.json', content: { from: 'b' } },
        { path: 'subagents/config.json', content: { version: 1 } },
      ],
    })
    const first = ensureDeclaredStartupConfigs([dirA, dirB], agentDir)
    expect(first).toEqual({ ensured: 3, skipped: 0, failed: 0 })
    const second = ensureDeclaredStartupConfigs([dirA, dirB], agentDir)
    expect(second).toEqual({ ensured: 0, skipped: 3, failed: 0 })
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('import-service', () => {
beforeAll(() => {
  fixturesRoot = mkdtempSync(join(tmpdir(), 'import-service-'))
})
afterAll(() => {
  rmSync(fixturesRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  // [HISTORICAL] 2026-09-02 会话丢失事故修复：此处原有 rmSync(getSessionsDir(), { recursive: true })——
  // 删除共享推导路径（落在哪个 dataDir 由 env 决定，env 异常时等于删用户真实会话目录，
  // 当日即删光当时 sessions 推导路径（旧布局 pi/ 子层）致三个 pi 进程 ENOENT 崩溃）。ImportService 的
  // 落盘目标在 globalSetup 注入的 tmp dataDir 下，由 global-setup teardown 统一回收。
})
describe('ImportService.listCandidates', () => {
  it('字段侧 / lastModified 降序 / total / dirs 聚合 / cwdExists / dirLabel', async () => {
    const root = join(fixturesRoot, 'cand-root')
    const sub = join(root, 'proj-alpha')
    mkdirSync(sub, { recursive: true })
    const existingCwd = join(fixturesRoot, 'cwd-alpha')
    mkdirSync(existingCwd, { recursive: true })
    writeSessionJsonl(join(sub, 'a1.jsonl'), 'cand-a1-000001', existingCwd, 'Alpha One')
    writeSessionJsonl(join(root, 'a2.jsonl'), 'cand-a2-000002', join(fixturesRoot, 'no-such-cwd'), 'Alpha Two')

    const svc = makeImportService()
    const reply = await svc.listCandidates({ rootDir: root })
    expect(reply.total).toBe(2)
    expect(reply.items).toHaveLength(2)
    // a2 后写 → lastModified 更新 → 降序在前
    expect(reply.items[0].sessionId).toBe('cand-a2-000002')

    const a1 = reply.items.find((i) => i.sessionId === 'cand-a1-000001')!
    expect(a1.name).toBe('Alpha One')
    expect(a1.cwd).toBe(existingCwd)
    expect(a1.sourcePath).toBe(join(sub, 'a1.jsonl'))
    expect(a1.dirLabel).toBe('proj-alpha')
    expect(a1.cwdExists).toBe(true)
    expect(a1.alreadyImported).toBe(false)
    expect(typeof a1.lastModified).toBe('number')
    expect(a1.size).toBeGreaterThan(0)

    const a2 = reply.items.find((i) => i.sessionId === 'cand-a2-000002')!
    expect(a2.dirLabel).toBe('')
    expect(a2.cwdExists).toBe(false)

    // dirs 只聚合一层子目录（顶层条目不入 dirs），计数为过滤前候选数
    expect(reply.dirs).toEqual([{ label: 'proj-alpha', count: 1 }])
  })

  it('query 匹配：name / 短 ID / dirLabel / sourcePath，全部 case-insensitive', async () => {
    const root = join(fixturesRoot, 'query-root')
    mkdirSync(join(root, 'ProjX'), { recursive: true })
    writeSessionJsonl(join(root, 'ProjX', 'f1.jsonl'), 'query-winter1', '/tmp/query-cwd', 'Winter Report')
    writeSessionJsonl(join(root, 'q2.jsonl'), 'query-other2', '/tmp/query-cwd', 'Summer Report')
    const svc = makeImportService()

    // name case-insensitive
    expect((await svc.listCandidates({ rootDir: root, query: 'WINTER' })).items.map((i) => i.sessionId))
      .toEqual(['query-winter1'])
    // uuid 前 6 位短 ID（query-other2 的 slice(0,6)）
    expect((await svc.listCandidates({ rootDir: root, query: 'query-o' })).items.map((i) => i.sessionId))
      .toEqual(['query-other2'])
    // dirLabel case-insensitive（只 ProjX 子目录下的条目命中）
    const byDir = await svc.listCandidates({ rootDir: root, query: 'projx' })
    expect(byDir.items).toHaveLength(1)
    expect(byDir.items[0].sessionId).toBe('query-winter1')
    // sourcePath
    expect((await svc.listCandidates({ rootDir: root, query: 'f1.jsonl' })).items).toHaveLength(1)
    // total 恒为过滤前总数
    expect((await svc.listCandidates({ rootDir: root, query: 'WINTER' })).total).toBe(2)
    // limit 截断
    expect((await svc.listCandidates({ rootDir: root, limit: 1 })).items).toHaveLength(1)
  })

  it('候选含 header 缺 id 的 jsonl 时 query 搜索不崩、结果不含该文件（宽松收录回归）', async () => {
    // 回归锚：修复前 external-scan 宽松收录缺 id header（ExternalSessionMeta.id===undefined），
    // matchesQuery 的 item.sessionId.slice(0, SHORT_ID_LENGTH) TypeError → 任意 query 下
    // listCandidates 整体崩溃（RPC 兜底 import_failed，搜索功能不可用）；无 query 打开
    // 列表不崩，故本用例必须带 query 触发崩溃路径
    const root = join(fixturesRoot, 'no-id-query-root')
    mkdirSync(root, { recursive: true })
    writeSessionJsonl(join(root, 'good.jsonl'), 'noidq-good-0001', '/tmp/noidq-cwd', 'GoodSession')
    writeFileSync(join(root, 'no-id.jsonl'), [
      JSON.stringify({ type: 'session', version: 1, cwd: '/tmp/noidq-cwd', timestamp: '2026-01-01T00:00:00.000Z' }),
      '',
    ].join('\n'))

    const svc = makeImportService()
    // 任意搜索词：不抛错（修复前在此 TypeError）。搜索词用长哨兵串而非短词——
    // [HISTORICAL 2026-09-15] 曾用 query 'xx'，CI 上 mkdtemp 随机后缀恰好为
    // 'bWC4Xx'（含大小写不敏感的 'xx'），sourcePath 子串匹配意外命中 good 会话
    // → 断言「结果为空」偶发红；短查询词会撞随机路径，哨兵串（含连字符 +
    // 4 连字符外字符）在 mkdtemp 字母表与 fixture 字段中不可能出现。
    const reply = await svc.listCandidates({ rootDir: root, query: 'zzzz-no-match' })
    expect(reply.items).toEqual([])
    // 无 query 的全集同样不含该文件（候选侧前置拒收，与导入侧 import_invalid_session 同清单）
    const full = await svc.listCandidates({ rootDir: root })
    expect(full.total).toBe(1)
    expect(full.items.some((i) => i.sourcePath.endsWith('no-id.jsonl'))).toBe(false)
    expect(full.items[0].sessionId).toBe('noidq-good-0001')
  })

  it('alreadyImported：导入后立即翻转（invalidateScanDirCache 生效）', async () => {
    const root = join(fixturesRoot, 'mark-root')
    mkdirSync(root, { recursive: true })
    const src = join(root, 'm1.jsonl')
    writeSessionJsonl(src, 'mark-id-000001', '/tmp/mark-cwd', 'MarkMe')
    const svc = makeImportService()

    const before = await svc.listCandidates({ rootDir: root })
    expect(before.items[0].alreadyImported).toBe(false)

    const imported = await svc.importSession({ sourcePath: src, projectId: 'proj-1' })
    expect(imported.sessionId).toBe('mark-id-000001')
    expect(imported.warning).toBeUndefined()
    // targetPath = getSessionsDir()/encodeCwd(resolve(cwd))/原文件名
    expect(imported.targetPath).toBe(join(getSessionsDir(), encodeCwd('/tmp/mark-cwd'), 'm1.jsonl'))
    expect(existsSync(imported.targetPath)).toBe(true)
    expect(existsSync(src)).toBe(true) // 复制语义：源文件不动（P-isolation 结构侧）

    const after = await svc.listCandidates({ rootDir: root })
    expect(after.items[0].alreadyImported).toBe(true)
  })

  it('rootDir 缺省 = pi 全局 sessions（getPiGlobalAgentDir 动态推导）', async () => {
    piGlobalDirState.dir = join(fixturesRoot, 'pi-global-agent')
    const defaultRoot = join(piGlobalDirState.dir, 'sessions')
    mkdirSync(defaultRoot, { recursive: true })
    writeSessionJsonl(join(defaultRoot, 'def.jsonl'), 'def-id-0000001', '/tmp/def-cwd', 'DefaultRoot')
    const svc = makeImportService()
    const reply = await svc.listCandidates({})
    expect(reply.items.some((i) => i.sessionId === 'def-id-0000001')).toBe(true)
    // 显式传其他 root 不被默认根内容污染（扫描按 rootDir 参数化）
    const other = join(fixturesRoot, 'other-root')
    mkdirSync(other, { recursive: true })
    expect((await svc.listCandidates({ rootDir: other })).items).toEqual([])
  })

  it('rootDir 存在但不可读 → import_dir_unreadable；不存在 → 空列表不抛错', async () => {
    const svc = makeImportService()
    // 不存在：scanExternalSessions 容错语义
    expect((await svc.listCandidates({ rootDir: join(fixturesRoot, 'no-such-root') })).items).toEqual([])

    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      // root 下权限位失效，权限型用例无法构造（跳过，与 repo 内 chmod 类先例同口径）
      return
    }
    const unreadable = join(fixturesRoot, 'unreadable-root')
    mkdirSync(unreadable)
    writeSessionJsonl(join(unreadable, 'u.jsonl'), 'unreadable-id-1', '/tmp/ur-cwd', 'U')
    const { chmodSync } = await import('node:fs')
    try {
      // 目录置 0o000 后 readdir 必失败（EACCES）→ import_dir_unreadable
      chmodSync(unreadable, 0o000)
      await expect(catchCode_z2(() => svc.listCandidates({ rootDir: unreadable }))).resolves.toBe('import_dir_unreadable')
    } finally {
      chmodSync(unreadable, 0o755)
    }
  })
})
describe('ImportService.importSession', () => {
  it('幂等：同 id 二次导入 → import_already_imported；并发双击 → 一成一拒（全局互斥）', async () => {
    const root = join(fixturesRoot, 'idem-root')
    mkdirSync(root, { recursive: true })
    const src = join(root, 'idem.jsonl')
    writeSessionJsonl(src, 'idem-id-000001', '/tmp/idem-cwd', 'Idem')
    const svc = makeImportService()

    await svc.importSession({ sourcePath: src, projectId: 'proj-1' })
    await expect(catchCode_z2(() => svc.importSession({ sourcePath: src, projectId: 'proj-1' })))
      .resolves.toBe('import_already_imported')

    // 并发（双击连点）：互斥串行化，同一请求一成一拒，无 duplicate/覆盖
    const src2 = join(root, 'idem2.jsonl')
    writeSessionJsonl(src2, 'idem2-id-00002', '/tmp/idem-cwd', 'Idem2')
    const settled = await Promise.allSettled([
      svc.importSession({ sourcePath: src2, projectId: 'proj-1' }),
      svc.importSession({ sourcePath: src2, projectId: 'proj-1' }),
    ])
    expect(settled.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
    const rejected = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected')!
    expect((rejected.reason as ImportServiceError).code).toBe('import_already_imported')
  })

  it('同 target 异 id：第二跳 → import_target_conflict（并发型同样拒绝）', async () => {
    const root = join(fixturesRoot, 'conflict-root')
    const cwd = '/tmp/conflict-cwd'
    mkdirSync(root, { recursive: true })
    const s1 = join(root, 'same-name.jsonl')
    writeSessionJsonl(s1, 'conf-id-0000001', cwd, 'First')
    const svc = makeImportService()
    await svc.importSession({ sourcePath: s1, projectId: 'proj-1' })

    // 异 id、同 basename、同 cwd → 同 targetPath
    const sub = join(root, 'alt')
    mkdirSync(sub, { recursive: true })
    const s2 = join(sub, 'same-name.jsonl')
    writeSessionJsonl(s2, 'conf-id-0000002', cwd, 'Second')
    const targetPath = join(getSessionsDir(), encodeCwd(cwd), 'same-name.jsonl')

    // 顺序型：明确 target_conflict，先落者不被静默覆盖
    await expect(catchCode_z2(() => svc.importSession({ sourcePath: s2, projectId: 'proj-1' })))
      .resolves.toBe('import_target_conflict')
    expect(existsSync(targetPath)).toBe(true)

    // 并发型（r3 镜像漏斗）：两源异 id、同 basename、同 cwd → 同 targetPath 并发导入，
    // 全局互斥串行 + 第二跳 existsSync 双检 → 一成一拒（不再 rename-over 静默覆盖先落者）
    const concCwd = '/tmp/conflict-conc-cwd'
    const dirA = join(root, 'conc-a')
    const dirB = join(root, 'conc-b')
    mkdirSync(dirA, { recursive: true })
    mkdirSync(dirB, { recursive: true })
    writeSessionJsonl(join(dirA, 'conc.jsonl'), 'conf-id-0000003', concCwd, 'ConcA')
    writeSessionJsonl(join(dirB, 'conc.jsonl'), 'conf-id-0000004', concCwd, 'ConcB')
    const settled = await Promise.allSettled([
      svc.importSession({ sourcePath: join(dirA, 'conc.jsonl'), projectId: 'proj-1' }),
      svc.importSession({ sourcePath: join(dirB, 'conc.jsonl'), projectId: 'proj-1' }),
    ])
    expect(settled.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
    const rejectedC = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected')!
    expect((rejectedC.reason as ImportServiceError).code).toBe('import_target_conflict')
    // 先落者不被静默覆盖：正式名落地且内容仍是先落者（两源 id 不同，包含即证明）
    const fulfilledC = settled.find(
      (r): r is PromiseFulfilledResult<{ sessionId: string; targetPath: string }> => r.status === 'fulfilled',
    )!
    expect(fulfilledC.value.targetPath).toBe(join(getSessionsDir(), encodeCwd(concCwd), 'conc.jsonl'))
    expect(readFileSync(fulfilledC.value.targetPath, 'utf-8')).toContain(fulfilledC.value.sessionId)
  })

  it('write 相位环境故障（非领域错误）：import_copy_failed 重包装 + 无残留 + 正式名未落地 + 互斥链异常安全第二跳成功', async () => {
    // 故障注入走 stub source 的 write 闭包（failFirst 单次翻转）而非文件级 fs mock——
    // 见文件头「禁止文件级 vi.mock('node:fs/promises')」注。真实 copyFile 链路已由
    // 其余导入用例全量覆盖，本用例锁编排层对 write 相位环境故障的语义：catch 重包装
    // import_copy_failed（磁盘满等非领域错误）+ tmp 主动清理 + 互斥链可复用。
    const cwd = '/tmp/copyfail-cwd'
    let failFirst = true
    const stub: SessionImportSource = {
      kind: 'pi',
      listCandidates: async () => ({ total: 0, items: [], dirs: [] }),
      prepareImport: async () => ({
        header: { id: 'copyfail-id-0001', timestamp: '2026-01-01T00:00:00.000Z', cwd },
        fileName: 'cf.jsonl',
        write: async (tmpPath) => {
          if (failFirst) {
            failFirst = false
            throw new Error('simulated write failure (disk full)')
          }
          writeFileSync(tmpPath, `${JSON.stringify({ type: 'session', version: 1, id: 'copyfail-id-0001', cwd, timestamp: '2026-01-01T00:00:00.000Z' })}\n`)
        },
        degradations: [],
      }),
    }
    const svc = makeImportService(new Map<ImportSourceKind, SessionImportSource>([['pi', stub]]))

    await expect(catchCode_z2(() => svc.importSession({ sourcePath: '/stub/source-not-read-by-stub', projectId: 'proj-1' })))
      .resolves.toBe('import_copy_failed')

    // 无残留：目标目录无 .tmp-import- 临时名，正式名从未落地（重试不被去重拦截，D1 原子性）
    const targetDir = join(getSessionsDir(), encodeCwd(cwd))
    const residue = existsSync(targetDir) ? readdirSync(targetDir).filter((n) => n.includes('.tmp-import-')) : []
    expect(residue).toEqual([])
    expect(existsSync(join(targetDir, 'cf.jsonl'))).toBe(false)

    // 第二跳：互斥链未被前序失败污染（r4-S1 异常安全）
    const second = await svc.importSession({ sourcePath: '/stub/source-not-read-by-stub', projectId: 'proj-1' })
    expect(second.sessionId).toBe('copyfail-id-0001')
    expect(existsSync(second.targetPath)).toBe(true)
  })

  it('marker 文件名拒绝：.tmp-import- / .tmp-migrate- → import_marker_filename，不落盘', async () => {
    const root = join(fixturesRoot, 'marker-root')
    mkdirSync(root, { recursive: true })
    const cwd = '/tmp/marker-cwd'
    const svc = makeImportService()
    const cases = [
      ['x.jsonl.tmp-import-111.jsonl', 'marker-id-00001'],
      ['y.jsonl.tmp-migrate-222.jsonl', 'marker-id-00002'],
    ] as const
    for (const [file, id] of cases) {
      const src = join(root, file)
      writeSessionJsonl(src, id, cwd, 'Marker')
      await expect(catchCode_z2(() => svc.importSession({ sourcePath: src, projectId: 'proj-1' })))
        .resolves.toBe('import_marker_filename')
      expect(existsSync(join(getSessionsDir(), encodeCwd(cwd), file))).toBe(false)
    }
  })

  it('projectId 空串/不存在 → import_project_invalid，未落盘', async () => {
    const root = join(fixturesRoot, 'proj-root')
    mkdirSync(root, { recursive: true })
    const src = join(root, 'p.jsonl')
    writeSessionJsonl(src, 'proj-id-0000001', '/tmp/proj-check-cwd', 'P')
    const svc = makeImportService()
    for (const projectId of ['', 'proj-no-such']) {
      await expect(catchCode_z2(() => svc.importSession({ sourcePath: src, projectId })))
        .resolves.toBe('import_project_invalid')
    }
    expect(existsSync(join(getSessionsDir(), encodeCwd('/tmp/proj-check-cwd'), 'p.jsonl'))).toBe(false)
  })

  it('sidecar readback 不符 → 成功 + warning sidecar_failed（文件不回滚）', async () => {
    const root = join(fixturesRoot, 'sidecar-root')
    const cwd = '/tmp/sidecar-cwd'
    mkdirSync(root, { recursive: true })
    const src = join(root, 'sc.jsonl')
    writeSessionJsonl(src, 'sidecar-id-00001', cwd, 'Sidecar')
    const targetPath = join(getSessionsDir(), encodeCwd(cwd), 'sc.jsonl')
    // 预置 sidecar 路径为目录：persistBindingSidecar 原子写吞错（best-effort），
    // readProjectBinding 读失败返回 undefined → readback 不符 → warning 通道
    mkdirSync(join(getSessionsDir(), encodeCwd(cwd)), { recursive: true })
    mkdirSync(`${targetPath}.project.json`)
    const svc = makeImportService()

    const reply = await svc.importSession({ sourcePath: src, projectId: 'proj-1' })
    expect(reply.warning).toBe('sidecar_failed')
    expect(reply.sessionId).toBe('sidecar-id-00001')
    expect(reply.targetPath).toBe(targetPath)
    expect(existsSync(targetPath)).toBe(true) // 文件已落地不回滚（r2-S2）
  })

  it('源文件不存在 → import_source_missing；首行非 header / 缺 cwd → import_invalid_session', async () => {
    const root = join(fixturesRoot, 'invalid-root')
    mkdirSync(root, { recursive: true })
    const svc = makeImportService()

    await expect(catchCode_z2(() => svc.importSession({ sourcePath: join(root, 'no-such.jsonl'), projectId: 'proj-1' })))
      .resolves.toBe('import_source_missing')

    writeFileSync(join(root, 'bad.jsonl'), 'not a header line\n')
    await expect(catchCode_z2(() => svc.importSession({ sourcePath: join(root, 'bad.jsonl'), projectId: 'proj-1' })))
      .resolves.toBe('import_invalid_session')

    // D1 字段清单：type==='session' 但 cwd 缺失 → 不容忍（encodeCwd(undefined) 会 TypeError）
    writeFileSync(join(root, 'no-cwd.jsonl'), `${JSON.stringify({ type: 'session', version: 1, id: 'invalid-id-0001', timestamp: '2026-01-01T00:00:00.000Z' })}\n`)
    await expect(catchCode_z2(() => svc.importSession({ sourcePath: join(root, 'no-cwd.jsonl'), projectId: 'proj-1' })))
      .resolves.toBe('import_invalid_session')

    // 首行为字面量 null（r5-MF1）：parse 产物非 object 须被运行时检查拦下转
    // import_invalid_session，不得逃逸原始 TypeError 被 handler 兜底成 import_failed
    writeFileSync(join(root, 'null-first.jsonl'), 'null\n')
    await expect(catchCode_z2(() => svc.importSession({ sourcePath: join(root, 'null-first.jsonl'), projectId: 'proj-1' })))
      .resolves.toBe('import_invalid_session')
  })

  it('readFirstLineAsync 跨块多字节解码（r1-S2）：CJK cwd 跨 4KB 块边界无损，targetPath 按真实 cwd 构造', async () => {
    const root = join(fixturesRoot, 'cjk-import-root')
    mkdirSync(root, { recursive: true })
    // 构造首行 > 4KB 且首 CJK 字符（3 字节）恰跨 4096 边界：逐块 toString 会拆出 U+FFFD。
    // padding 放在 cwd 之外的旁路 JSON 字段——若塞进 cwd，encodeCwd 目标目录名会超
    // macOS NAME_MAX(255) 抛 ENAMETOOLONG，注入点跑不到断言。
    const CHUNK = 4096
    const head = '{"type":"session","version":1,"id":"cjk-import-0001","pad":"'
    const mid = '","cwd":"/tmp/'
    const cjk = '极长的中文路径目录名用于跨块解码回归'
    const tail = '","timestamp":"2026-01-01T00:00:00.000Z"}'
    // ASCII 前缀字节长 = 字符长；padLen 使 CJK 首字符起于字节 4095、跨 4096 边界
    const padLen = CHUNK - 1 - head.length - mid.length
    const cwd = '/tmp/' + cjk
    const firstLine = head + 'a'.repeat(padLen) + mid + cjk + tail
    expect(firstLine.length).toBeGreaterThan(CHUNK) // 前提：首行跨块
    const src = join(root, 'cjk.jsonl')
    writeFileSync(src, firstLine + '\n')

    const svc = makeImportService()
    const reply = await svc.importSession({ sourcePath: src, projectId: 'proj-1' })
    expect(reply.sessionId).toBe('cjk-import-0001')
    expect(reply.warning).toBeUndefined()
    // cwd 解码无损 → targetPath 按真实（无 U+FFFD）cwd 构造
    expect(reply.targetPath).toBe(join(getSessionsDir(), encodeCwd(cwd), 'cjk.jsonl'))
  })
})
describe('ImportService × B5 摘碑（memory-leak-remediation §3.2-B5 双路径②：doImport 尾部）', () => {
  /** 预置 tombstone 的最小装置：注入 mock trash port（同步移除文件模拟 trash 语义） */
  function makeTombstonedStore(storeDir: string, sid: string): SessionDataStore {
    const store = new SessionDataStore(storeDir, undefined, undefined, async (p) => {
      rmSync(p, { force: true })
    })
    store.set(sid, 'k1', 'v1')
    store.flushSession(sid)
    return store
  }

  it('import 同 id 复活成功 → tombstone 摘除（import 后未打开窗口内插件合法写不被误杀）', async () => {
    const root = join(fixturesRoot, 'tomb-root')
    mkdirSync(root, { recursive: true })
    const sid = 'imp-tomb-00001'
    const src = join(root, 'tomb.jsonl')
    writeSessionJsonl(src, sid, '/tmp/tomb-cwd', 'Tomb')

    // 预置 tombstone（模拟该 id session 先前被删除：clearSession 登记）
    const store = makeTombstonedStore(join(fixturesRoot, 'tomb-store'), sid)
    await store.clearSession(sid)
    expect(isSessionDataCleared(sid)).toBe(true)
    store.dispose()

    const svc = makeImportService()
    const reply = await svc.importSession({ sourcePath: src, projectId: 'proj-1' })
    expect(reply.sessionId).toBe(sid)

    // doImport 尾部显式摘碑（纯文件级导入不投 didCreate，主线程无创建收敛点可依赖）
    expect(isSessionDataCleared(sid)).toBe(false)
  })

  it('import 失败（marker 文件名拒绝，不达尾部）→ tombstone 保留（碑只随成功复活摘）', async () => {
    const root = join(fixturesRoot, 'tomb-fail-root')
    mkdirSync(root, { recursive: true })
    const sid = 'imp-tomb-00002'
    // RT-3#10：marker 拒绝改精确后缀形态（标记+纯数字 ts+.jsonl），fixture 用真实残留形态
    //（import-service 编排层 tmp 名 = targetPath + '.tmp-import-' + Date.now()）
    const src = join(root, 'x.jsonl.tmp-import-1770000000000.jsonl')
    writeSessionJsonl(src, sid, '/tmp/tomb-fail-cwd', 'TombFail')

    const store = makeTombstonedStore(join(fixturesRoot, 'tomb-fail-store'), sid)
    await store.clearSession(sid)

    const svc = makeImportService()
    await expect(catchCode_z2(() => svc.importSession({ sourcePath: src, projectId: 'proj-1' })))
      .resolves.toBe('import_marker_filename')

    expect(isSessionDataCleared(sid)).toBe(true) // 未摘
    store.dispose()
  })
})
describe('ImportService source 路由（SPI 编排层，设计 §3.3/§3.7）', () => {
  it('缺省不传 source = 显式 source:"pi"（向后兼容：存量调用路径行为不变）', async () => {
    const root = join(fixturesRoot, 'route-default-root')
    mkdirSync(root, { recursive: true })
    writeSessionJsonl(join(root, 'r1.jsonl'), 'route-def-00001', '/tmp/route-def-cwd', 'RouteDefault')
    writeSessionJsonl(join(root, 'r2.jsonl'), 'route-exp-00001', '/tmp/route-exp-cwd', 'RouteExplicit')
    const svc = makeImportService()

    // listCandidates：不传 source 与显式 'pi' 结果一致（同一 fixture 集合）
    const implicit = await svc.listCandidates({ rootDir: root })
    const explicit = await svc.listCandidates({ rootDir: root, source: 'pi' })
    expect(explicit).toEqual(implicit)
    expect(explicit.total).toBe(2)

    // importSession：不传 source 走 pi 落地链（readFirstLine + copyFile），产物/语义与存量一致
    const reply = await svc.importSession({ sourcePath: join(root, 'r1.jsonl'), projectId: 'proj-1' })
    expect(reply.sessionId).toBe('route-def-00001')
    expect(reply.warning).toBeUndefined()
    expect(reply.targetPath).toBe(join(getSessionsDir(), encodeCwd('/tmp/route-def-cwd'), 'r1.jsonl'))
    expect(existsSync(reply.targetPath)).toBe(true)
  })

  it('degradations 非空 → reply.warning = conversion_degraded（stub source 注入，pi 不受影响）', async () => {
    // stub 占 'pi' 槽（独立 service 实例 + 专用 id/cwd/fileName，不污染其他用例的 pi 全链路）
    const stub: SessionImportSource = {
      kind: 'pi',
      listCandidates: async () => ({ total: 0, items: [], dirs: [] }),
      prepareImport: async () => ({
        header: { id: 'stub-deg-00001', timestamp: '2026-01-01T00:00:00.000Z', cwd: '/tmp/stub-deg-cwd' },
        fileName: 'stub-deg.jsonl',
        write: async (tmpPath) => {
          writeFileSync(tmpPath, `${JSON.stringify({ type: 'session', version: 1, id: 'stub-deg-00001', cwd: '/tmp/stub-deg-cwd', timestamp: '2026-01-01T00:00:00.000Z' })}\n`)
        },
        degradations: [{ code: 'dropped_transient', count: 1 }],
      }),
    }
    const svc = makeImportService(new Map<ImportSourceKind, SessionImportSource>([['pi', stub]]))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const reply = await svc.importSession({ sourcePath: '/stub/source-not-read-by-stub', projectId: 'proj-1', source: 'pi' })
    // warning 聚合（§3.6）：degradations 非空 → conversion_degraded；明细不进契约范围、日志留痕（D6）
    expect(reply.warning).toBe('conversion_degraded')
    expect(reply.sessionId).toBe('stub-deg-00001')
    expect(reply.targetPath).toBe(join(getSessionsDir(), encodeCwd('/tmp/stub-deg-cwd'), 'stub-deg.jsonl'))
    expect(existsSync(reply.targetPath)).toBe(true) // 落地成功（降级是知情提示，非失败）
    // 降级摘要（§7.4）：L2 计 1 进 droppedCount；无 unclassified → null
    expect(reply.degradationSummary).toEqual({ droppedCount: 1, unclassified: null })
    // degradations 日志留痕（D6）：只断言存在性——sidecar 等 best-effort 路径的 warn 与
    // 本日志共用 console 通道，次数/顺序不是契约
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('conversion degraded'))).toBe(true)
    warnSpy.mockRestore()
  })

  it('sidecar 不符 + degradations 非空并存 → warning 单字段取 sidecar_failed（需动作警示优先），degradations 仍日志留痕', async () => {
    const cwd = '/tmp/stub-both-cwd'
    const targetPath = join(getSessionsDir(), encodeCwd(cwd), 'stub-both.jsonl')
    // 预置 sidecar 路径为目录：readback 不符 → sidecar_failed（同 sidecar 用例注入手法）
    mkdirSync(join(getSessionsDir(), encodeCwd(cwd)), { recursive: true })
    mkdirSync(`${targetPath}.project.json`)
    const stub: SessionImportSource = {
      kind: 'pi',
      listCandidates: async () => ({ total: 0, items: [], dirs: [] }),
      prepareImport: async () => ({
        header: { id: 'stub-both-0001', timestamp: '2026-01-01T00:00:00.000Z', cwd },
        fileName: 'stub-both.jsonl',
        write: async (tmpPath) => {
          writeFileSync(tmpPath, 'line\n')
        },
        degradations: [{ code: 'dropped_transient', count: 1 }],
      }),
    }
    const svc = makeImportService(new Map<ImportSourceKind, SessionImportSource>([['pi', stub]]))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const reply = await svc.importSession({ sourcePath: '/stub/unused', projectId: 'proj-1', source: 'pi' })
    // ImportReply.warning 是单字段（r4-INFO）：sidecar_failed 引导手动归类（需动作）优先于
    // conversion_degraded（知情提示，无需动作）；degradations 明细经日志通道不丢失
    //（sidecar 写失败的 warn 同走 console，只断言 conversion degraded 调用存在）
    expect(reply.warning).toBe('sidecar_failed')
    // summary 仅 warning 含 conversion_* 时携带（§7.4）：sidecar 胜出轮降级计数不入 wire
    expect(reply.degradationSummary).toBeUndefined()
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('conversion degraded'))).toBe(true)
    warnSpy.mockRestore()
  })

  it('unclassified 与 conversion_degraded 并存 → conversion_unclassified 胜出（优先序），summary 按档聚合', async () => {
    const stub: SessionImportSource = {
      kind: 'pi',
      listCandidates: async () => ({ total: 0, items: [], dirs: [] }),
      prepareImport: async () => ({
        header: { id: 'stub-unc-00001', timestamp: '2026-01-01T00:00:00.000Z', cwd: '/tmp/stub-unc-cwd' },
        fileName: 'stub-unc.jsonl',
        write: async (tmpPath) => {
          writeFileSync(tmpPath, `${JSON.stringify({ type: 'session', version: 1, id: 'stub-unc-00001', cwd: '/tmp/stub-unc-cwd', timestamp: '2026-01-01T00:00:00.000Z' })}\n`)
        },
        degradations: [
          { code: 'dropped_redundant', count: 2 },
          { code: 'dropped_transient', count: 3 },
          { code: 'truncated_output', count: 1 },
          { code: 'compaction_unlinked', count: 1 },
          { code: 'unclassified', count: 4, sample: { messageId: 'm-unk', preview: '未知消息原文前 80 字' } },
          { code: 'unclassified', count: 1, sample: { messageId: 'm-unk-2', preview: '第二条' } },
        ],
      }),
    }
    const svc = makeImportService(new Map<ImportSourceKind, SessionImportSource>([['pi', stub]]))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const reply = await svc.importSession({ sourcePath: '/stub/unused', projectId: 'proj-1', source: 'pi' })
    // 优先序（§7.4）：unclassified（L4 未知需上报/重导）> conversion_degraded（知情提示）
    expect(reply.warning).toBe('conversion_unclassified')
    // summary 聚合：droppedCount = L1+L2（2+3=5）；unclassified.count 跨记录求和（4+1=5）、
    // firstSample = 首条 unclassified 的 sample；truncated_output / compaction_unlinked（L3）
    // 不进 summary（toast 无对应分句，§7.4 不设 truncatedCount）
    expect(reply.degradationSummary).toEqual({
      droppedCount: 5,
      unclassified: { count: 5, firstSample: { messageId: 'm-unk', preview: '未知消息原文前 80 字' } },
    })
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('conversion degraded'))).toBe(true)
    warnSpy.mockRestore()
  })

  it('unclassified 与 sidecar_failed 并存 → sidecar_failed 胜出（需动作警示最高优先），summary 不携带', async () => {
    const cwd = '/tmp/stub-unc-sidecar-cwd'
    const targetPath = join(getSessionsDir(), encodeCwd(cwd), 'stub-unc-sc.jsonl')
    // 预置 sidecar 路径为目录：readback 不符 → sidecar_failed（同 sidecar 用例注入手法）
    mkdirSync(join(getSessionsDir(), encodeCwd(cwd)), { recursive: true })
    mkdirSync(`${targetPath}.project.json`)
    const stub: SessionImportSource = {
      kind: 'pi',
      listCandidates: async () => ({ total: 0, items: [], dirs: [] }),
      prepareImport: async () => ({
        header: { id: 'stub-unsc-0001', timestamp: '2026-01-01T00:00:00.000Z', cwd },
        fileName: 'stub-unc-sc.jsonl',
        write: async (tmpPath) => {
          writeFileSync(tmpPath, 'line\n')
        },
        degradations: [{ code: 'unclassified', count: 2, sample: { messageId: 'm-u', preview: '未知' } }],
      }),
    }
    const svc = makeImportService(new Map<ImportSourceKind, SessionImportSource>([['pi', stub]]))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const reply = await svc.importSession({ sourcePath: '/stub/unused', projectId: 'proj-1', source: 'pi' })
    // 优先序顶端：sidecar_failed 需用户手动归类（动作不可延迟）；代价 = 该轮 L4 计数
    // 不进 wire（summary 仅 conversion_* 携带），仅 runtime 日志可见（§7.4 已接受）
    expect(reply.warning).toBe('sidecar_failed')
    expect(reply.degradationSummary).toBeUndefined()
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('conversion degraded'))).toBe(true)
    warnSpy.mockRestore()
  })

  it('仅 L3 降级（truncated_output/compaction_unlinked）→ conversion_degraded，summary 两字段空档（L3 不进 summary）', async () => {
    const stub: SessionImportSource = {
      kind: 'pi',
      listCandidates: async () => ({ total: 0, items: [], dirs: [] }),
      prepareImport: async () => ({
        header: { id: 'stub-l3-000001', timestamp: '2026-01-01T00:00:00.000Z', cwd: '/tmp/stub-l3-cwd' },
        fileName: 'stub-l3.jsonl',
        write: async (tmpPath) => {
          writeFileSync(tmpPath, `${JSON.stringify({ type: 'session', version: 1, id: 'stub-l3-000001', cwd: '/tmp/stub-l3-cwd', timestamp: '2026-01-01T00:00:00.000Z' })}\n`)
        },
        degradations: [
          { code: 'truncated_output', count: 2 },
          { code: 'compaction_unlinked', count: 1 },
        ],
      }),
    }
    const svc = makeImportService(new Map<ImportSourceKind, SessionImportSource>([['pi', stub]]))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const reply = await svc.importSession({ sourcePath: '/stub/unused', projectId: 'proj-1', source: 'pi' })
    // L3 保真损失族仍属知情降级（conversion_degraded），但 droppedCount 只聚合 L1+L2、
    // unclassified 无则 null——L3 显形走 runtime 日志明细通道（§7.4）
    expect(reply.warning).toBe('conversion_degraded')
    expect(reply.degradationSummary).toEqual({ droppedCount: 0, unclassified: null })
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('conversion degraded'))).toBe(true)
    warnSpy.mockRestore()
  })

  it('write 相位抛领域错误 → 错误码原样透传，不重包装 import_copy_failed（§3.6 相位分离）', async () => {
    // zcode 源的 write 闭包在 write 相位抛领域错误（转换相位 db 消失 →
    // import_source_missing；会话消失/查询失败 → import_invalid_session）——编排层
    // catch 若无条件重包装 import_copy_failed，错误码承载的恢复指引（刷新列表重选/
    // 升级太极）会被降格成「写入目标目录出错」。stub source 锁编排层透传语义。
    const stub: SessionImportSource = {
      kind: 'pi',
      listCandidates: async () => ({ total: 0, items: [], dirs: [] }),
      prepareImport: async () => ({
        header: { id: 'stub-dom-00001', timestamp: '2026-01-01T00:00:00.000Z', cwd: '/tmp/stub-dom-cwd' },
        fileName: 'stub-dom.jsonl',
        write: async () => {
          throw new ImportServiceError('import_invalid_session', '该会话已不在 zcode 库中（sessionId=sess_x），请刷新列表后重选')
        },
        degradations: [],
      }),
    }
    const svc = makeImportService(new Map<ImportSourceKind, SessionImportSource>([['pi', stub]]))

    await expect(catchCode_z2(() => svc.importSession({ sourcePath: '/stub/unused', projectId: 'proj-1', source: 'pi' })))
      .resolves.toBe('import_invalid_session')
    // 领域错误透传同样走 tmp 清理路径：无 .tmp-import- 残留、正式名未落地（重试不被去重拦截）
    const targetDir = join(getSessionsDir(), encodeCwd('/tmp/stub-dom-cwd'))
    const residue = existsSync(targetDir) ? readdirSync(targetDir).filter((n) => n.includes('.tmp-import-')) : []
    expect(residue).toEqual([])
    expect(existsSync(join(targetDir, 'stub-dom.jsonl'))).toBe(false)
  })

  it('注册表缺项 → import_source_missing（防御分支：封闭联合 + 组合根全注册下仅版本不匹配可达）', async () => {
    // U2 阶段 zcode 尚未注册（U3 加入）——空表构造即可触达；同时锁「未知源字面量不静默走 pi」
    const svc = makeImportService(new Map<ImportSourceKind, SessionImportSource>())
    await expect(catchCode_z2(() => svc.importSession({ sourcePath: '/any.jsonl', projectId: 'proj-1', source: 'zcode' })))
      .resolves.toBe('import_source_missing')
    await expect(catchCode_z2(() => svc.listCandidates({ source: 'zcode' }))).resolves.toBe('import_source_missing')
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('import-source-zcode', () => {
beforeAll(() => {
  fixturesRoot_m2 = mkdtempSync(join(tmpdir(), 'import-source-zcode-'))
})
afterAll(() => {
  rmSync(fixturesRoot_m2, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  // alreadyImported 用例预置进 tmp dataDir sessions 根的种子文件随 globalSetup teardown 回收
})
describe('normalizeZcodeSessionId（T1 三步骤 + 后置条件 fail-fast）', () => {
  it('步骤①：sess_ 前缀剥一次；双前缀只剥一次', () => {
    expect(normalizeZcodeSessionId('sess_0198f7c4-5b21-7abc-8912-3def456789ab')).toBe('0198f7c4-5b21-7abc-8912-3def456789ab')
    // sess_sess_ab → 剥一次 → sess_ab → _→- → sess-ab（幂等：再 normalize 不变）
    expect(normalizeZcodeSessionId('sess_sess_ab')).toBe('sess-ab')
    expect(normalizeZcodeSessionId(normalizeZcodeSessionId('sess_sess_ab'))).toBe('sess-ab')
  })

  it('步骤①：无前缀不剥；步骤②：_ 全部 → -', () => {
    expect(normalizeZcodeSessionId('0198f7c4-5b21-7abc-8912-3def456789ab')).toBe('0198f7c4-5b21-7abc-8912-3def456789ab')
    expect(normalizeZcodeSessionId('sess_ab_cd')).toBe('ab-cd')
    expect(normalizeZcodeSessionId('a_b_c')).toBe('a-b-c')
    // subagent_child 形态（当前被 D8 排除，未来放开时由步骤②封闭处理）
    expect(normalizeZcodeSessionId('sess_subagent_agent_0198abcd')).toBe('subagent-agent-0198abcd')
  })

  it('步骤③ 后置条件 fail-fast（message 带原 id；错误码 import_invalid_session 映射由薄包装承接——下方 prepareImport 用例锁定）', () => {
    for (const raw of ['', 'sess_', '_', '-']) {
      // eslint 参数循环内断言 message：空串/纯 sess_（剥后空）、'_'/'-'（字符集或首尾非法）。
      // source 包错误范围归消费侧（设计 §1.5 契约④）：normalize 抛普通 Error，本组只断言
      // fail-fast + message；「后置条件不满足 → import_invalid_session」的映射断言在
      // prepareImport describe（'sess_' 归一化为空 / 'sess_-badid-0001' 首字符非法两组）。
      try {
        normalizeZcodeSessionId(raw)
        expect.unreachable(`expected normalizeZcodeSessionId(${JSON.stringify(raw)}) to throw`)
      } catch (e) {
        expect(e).toBeInstanceOf(Error)
        expect((e as Error).message).toContain(raw)
      }
    }
    // 首字符非法（- 开头）/ 尾字符非法（- 结尾）
    expect(() => normalizeZcodeSessionId('sess_-abc')).toThrow()
    expect(() => normalizeZcodeSessionId('sess_abc-')).toThrow()
    expect(() => normalizeZcodeSessionId('sess_ab.c')).toThrow()
  })

  it('单字符合法（首尾即唯一字符，字母数字均可）', () => {
    expect(normalizeZcodeSessionId('sess_a')).toBe('a')
    expect(normalizeZcodeSessionId('7')).toBe('7')
  })

  it('zcodeCandidateKey 与 normalizeZcodeSessionId 同一函数（打标域 = 转换域）', () => {
    expect(zcodeCandidateKey).toBe(normalizeZcodeSessionId)
    expect(zcodeCandidateKey('sess_ab')).toBe('ab')
  })
})
describe('ZcodeImportSource.listCandidates', () => {
  let dbPath: string
  let existingDir: string

  beforeAll(() => {
    existingDir = join(fixturesRoot_m2, 'proj-exists')
    mkdirSync(existingDir, { recursive: true })
    dbPath = join(fixturesRoot_m2, 'zc-candidates.sqlite')
    buildFixtureDb(
      dbPath,
      [
        // time_updated 降序断言：newest → interactive-b → subagent（排除）→ fork → oldest
        { id: 'sess_0198old0-0000-0000-0000-000000000001', title: 'Oldest interactive', directory: '/tmp/zc-proj-alpha', taskType: 'interactive', timeCreated: 1000, timeUpdated: 1000 },
        { id: 'sess_0198frk0-0000-0000-0000-000000000002', title: 'A fork session', directory: '/tmp/zc-proj-alpha', taskType: 'fork', timeCreated: 2000, timeUpdated: 3000 },
        { id: 'sess_0198sub0-0000-0000-0000-000000000003', title: 'Subagent child noise', directory: '/tmp/zc-proj-alpha', taskType: 'subagent_child', timeCreated: 3000, timeUpdated: 4000 },
        { id: 'sess_0198sid0-0000-0000-0000-000000000004', title: 'Side chat session', directory: existingDir, taskType: 'selection_side_chat', timeCreated: 4000, timeUpdated: 5000 },
        { id: 'sess_0198new0-0000-0000-0000-000000000005', title: 'Newest interactive', directory: existingDir, taskType: 'interactive', timeCreated: 5000, timeUpdated: 6000 },
      ],
      [
        // 字节口径：'中文'=6B + 'abc'=3B → sid005 共 9B；sid004 无 part → 0
        { sessionId: 'sess_0198new0-0000-0000-0000-000000000005', data: '中文' },
        { sessionId: 'sess_0198new0-0000-0000-0000-000000000005', data: 'abc' },
      ],
    )
  })

  it('D8：排除 subagent_child，interactive/fork/selection_side_chat 全在列；字段映射/降序/total/dirs/cwdExists/size 字节口径', async () => {
    const reply = await makeSource(dbPath).listCandidates({})

    // D8 负面断言（A8 单测化）：subagent_child 行不出现在 items，也不计入 total
    expect(reply.total).toBe(4)
    expect(reply.items.map((i) => i.sessionId)).toEqual([
      'sess_0198new0-0000-0000-0000-000000000005',
      'sess_0198sid0-0000-0000-0000-000000000004',
      'sess_0198frk0-0000-0000-0000-000000000002',
      'sess_0198old0-0000-0000-0000-000000000001',
    ])

    const newest = reply.items[0]
    expect(newest.name).toBe('Newest interactive')
    expect(newest.cwd).toBe(existingDir)
    expect(newest.sourcePath).toBe(dbPath)
    expect(newest.lastModified).toBe(6000)
    expect(newest.dirLabel).toBe(basename(existingDir))
    expect(newest.cwdExists).toBe(true)
    expect(newest.alreadyImported).toBe(false)
    // 真字节口径：'中文' UTF-8 6B + 'abc' 3B = 9（字符数口径会是 3+3=6——CAST BLOB 断言区分）
    expect(newest.size).toBe(9)

    const side = reply.items[1]
    expect(side.cwdExists).toBe(true) // existingDir 真实存在
    expect(side.size).toBe(null) // 无 part 会话大小未知（null ≠ 0 假数据，RT-5#10）
    const oldest = reply.items[3]
    expect(oldest.cwd).toBe('/tmp/zc-proj-alpha')
    expect(oldest.cwdExists).toBe(false)
    expect(oldest.dirLabel).toBe('zc-proj-alpha')

    // dirs：按 dirLabel 聚合自过滤前全集（label 排序），与搜索独立
    expect(reply.dirs).toEqual([
      { label: basename(existingDir), count: 2 },
      { label: 'zc-proj-alpha', count: 2 },
    ])
  })

  it('RT-5#10：bytes 非 number（part.data 全 NULL 的组 SUM=NULL）→ warn 留痕 + size 保持 null（不显示 0 B）', async () => {
    // 手搓可空 data 列的最小库（fixture builder 的 part.data NOT NULL，造不出 SUM=NULL）
    const nullDataDb = join(fixturesRoot_m2, 'zc-null-bytes.sqlite')
    const db = new DatabaseSync(nullDataDb)
    try {
      db.exec('BEGIN')
      db.exec(
        'CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL, title TEXT NOT NULL, ' +
          "task_type TEXT NOT NULL DEFAULT 'interactive', time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL)",
      )
      db.prepare('INSERT INTO session (id, directory, title, task_type, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)')
        .run('sess_0198nul0-0000-0000-0000-000000000009', '/tmp/zc-null-cwd', 'Null bytes', 'interactive', 1000, 2000)
      db.exec('CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, sequence INTEGER, data TEXT)')
      db.prepare('INSERT INTO part (id, message_id, session_id, sequence, data) VALUES (?, ?, ?, ?, ?)')
        .run('p-null', 'm-1', 'sess_0198nul0-0000-0000-0000-000000000009', 0, null)
      db.exec('CREATE TABLE schema_migration (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, app_version TEXT, time_applied INTEGER NOT NULL)')
      db.prepare('INSERT INTO schema_migration (id, checksum, app_version, time_applied) VALUES (?, ?, ?, ?)').run('0001_seed', 'x', '0.16.5', 1)
      db.exec('COMMIT')
    } finally {
      db.close()
    }

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const reply = await makeSource(nullDataDb).listCandidates({})
      expect(reply.items).toHaveLength(1)
      expect(reply.items[0]!.size).toBe(null) // null = 大小未知，非 0 B 假数据
      const warnMsg = warnSpy.mock.calls.map((c) => String(c[0])).find((m) => m.includes('bytes 非 number'))
      expect(warnMsg).toBeDefined()
      expect(warnMsg).toContain('sess_0198nul0-0000-0000-0000-000000000009')
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('query 匹配：name / sessionId / directory / dirLabel，case-insensitive；sourcePath（db 路径占位）不参与', async () => {
    const source = makeSource(dbPath)
    // name（title）case-insensitive
    expect((await source.listCandidates({ query: 'NEWEST' })).items.map((i) => i.name))
      .toEqual(['Newest interactive'])
    // sessionId 整串（sess_ 前缀形态）
    expect((await source.listCandidates({ query: 'sess_0198frk0' })).items).toHaveLength(1)
    // directory
    expect((await source.listCandidates({ query: 'zc-proj-alpha' })).total).toBe(4) // total 过滤前
    expect((await source.listCandidates({ query: 'zc-proj-alpha' })).items).toHaveLength(2)
    // dirLabel case-insensitive（basename 形态命中同 directory 的全部候选）
    const byLabel = await source.listCandidates({ query: basename(existingDir).toUpperCase() })
    expect(byLabel.items).toHaveLength(2)
    // sourcePath 不参与匹配（db 文件名片段只存在于 dbPath，任何候选字段不含）
    expect((await source.listCandidates({ query: '.sqlite' })).items).toEqual([])
    // 无命中
    expect((await source.listCandidates({ query: 'zzzz-no-match' })).items).toEqual([])
  })

  it('limit 截断：items 截 N、total 恒为过滤前总数', async () => {
    const reply = await makeSource(dbPath).listCandidates({ limit: 2 })
    expect(reply.items).toHaveLength(2)
    expect(reply.total).toBe(4)
  })

  it('alreadyImported 归一化域：扫描集含归一化 id → 命中；含原始 sess_ 形态 → 不命中（失配对照）', async () => {
    const dbPath2 = join(fixturesRoot_m2, 'zc-marked.sqlite')
    // sess_marked_0001 → 归一化 'marked-0001'；sess_plain_0002 → 'plain-0002'
    buildFixtureDb(
      dbPath2,
      [
        { id: 'sess_marked_0001', title: 'Marked', directory: '/tmp/zc-mark-cwd', taskType: 'interactive', timeCreated: 1000, timeUpdated: 1000 },
        { id: 'sess_plain_0002', title: 'Plain', directory: '/tmp/zc-plain-cwd', taskType: 'interactive', timeCreated: 2000, timeUpdated: 2000 },
      ],
      [],
    )
    // 预置太极扫描集：一个用归一化形态 id（应命中）、一个用原始 sess_ 形态 id（不应命中——
    // 扫描集是 header.id 域，原始形态直接比对失配即本断言的对照组）
    seedTaijiSession('marked-0001')
    seedTaijiSession('sess_plain_0002')
    invalidateScanDirCache()
    const scanned = new Set(scanPiSessions().map((s) => s.id))
    expect(scanned.has('marked-0001')).toBe(true)
    expect(scanned.has('sess_plain_0002')).toBe(true)

    const reply = await makeSource(dbPath2).listCandidates({})
    const marked = reply.items.find((i) => i.sessionId === 'sess_marked_0001')!
    const plain = reply.items.find((i) => i.sessionId === 'sess_plain_0002')!
    expect(marked.alreadyImported).toBe(true)
    expect(plain.alreadyImported).toBe(false)
  })

  it('alreadyImported 打标：单行 id 形态漂移 → 该行降级 false、列表不崩（导入侧 fail-fast 不受影响）', async () => {
    // 回归锚：打标输入 zcodeCandidateKey（=normalizeZcodeSessionId）后置条件不满足会抛，
    // 修复前单行坏 id 让整表崩溃（listCandidates 整体 import_invalid_session → 前端列表 404）；
    // 同条件在导入侧（prepareImport T1 校验）仍 fail-fast（下方 prepareImport describe 已锁定）
    const dbPath3 = join(fixturesRoot_m2, 'zc-badid-list.sqlite')
    buildFixtureDb(
      dbPath3,
      [
        // 'sess_-badid-0001' 剥前缀后首字符 '-'，超出后置条件字符集（首尾必须字母数字）
        { id: 'sess_-badid-0001', title: 'Drifted id row', directory: '/tmp/zc-drift-cwd', taskType: 'interactive', timeCreated: 1000, timeUpdated: 1000 },
        { id: 'sess_goodid-0002', title: 'Good id row', directory: '/tmp/zc-drift-cwd', taskType: 'interactive', timeCreated: 2000, timeUpdated: 2000 },
      ],
      [],
    )
    const reply = await makeSource(dbPath3).listCandidates({})
    // 列表仍完整返回：坏 id 行不缺失、不拖垮其余行（warn 留痕不强制断言——降级 ≠ 吞错，
    // 日志通道与 conversion degraded 留痕共用 console，次数/顺序不是契约）
    expect(reply.total).toBe(2)
    const drifted = reply.items.find((i) => i.sessionId === 'sess_-badid-0001')!
    expect(drifted.alreadyImported).toBe(false)
    expect(reply.items.find((i) => i.sessionId === 'sess_goodid-0002')!.alreadyImported).toBe(false)
    // 导入侧同条件保持 fail-fast（降级只在列表展示侧，幂等防线不放松）
    await expect(catchCode_z3(() => makeSource(dbPath3).prepareImport({ sourcePath: '', projectId: 'p', source: 'zcode', sessionId: 'sess_-badid-0001', dbPath: dbPath3 })))
      .resolves.toBe('import_invalid_session')
  })

  it('db 不存在 → import_source_missing（listCandidates 与 prepareImport 同映射）', async () => {
    const missing = join(fixturesRoot_m2, 'no-such.sqlite')
    expect(existsSync(missing)).toBe(false)
    const source = makeSource(missing)
    await expect(catchCode_z3(() => source.listCandidates({}))).resolves.toBe('import_source_missing')
    await expect(catchCode_z3(() => source.prepareImport({ sourcePath: '', projectId: 'p', source: 'zcode', sessionId: 'sess_x', dbPath: missing })))
      .resolves.toBe('import_source_missing')
  })

  it('schema 漂移（session 表缺失）→ import_invalid_session，message 带 schema_migration 版本', async () => {
    const drifted = join(fixturesRoot_m2, 'zc-drifted.sqlite')
    buildFixtureDb(drifted, [], [], [], { omitSessionTable: true, schemaVersion: '9.9.9' })
    const source = makeSource(drifted)
    await expect(catchCode_z3(() => source.listCandidates({}))).resolves.toBe('import_invalid_session')
    try {
      await source.prepareImport({ sourcePath: '', projectId: 'p', source: 'zcode', sessionId: 'sess_x', dbPath: drifted })
      expect.unreachable('expected prepareImport to throw')
    } catch (e) {
      expect(codeOf_m2(e)).toBe('import_invalid_session')
      expect((e as Error).message).toContain('9.9.9')
    }
  })
})
describe('ZcodeImportSource.prepareImport（T1 header/fileName 全量）', () => {
  let dbPath: string

  beforeAll(() => {
    dbPath = join(fixturesRoot_m2, 'zc-prepare.sqlite')
    buildFixtureDb(
      dbPath,
      [
        { id: 'sess_0198prep0-0000-0000-0000-00000000000a', title: 'Prepare me', directory: '/tmp/zc-prep-cwd', taskType: 'interactive', timeCreated: 1767225600000, timeUpdated: 1767225700000 },
      ],
      [],
    )
  })

  it('header = {归一化 id, ISO(time_created), directory}；fileName 尾段 === header.id（不变量）', async () => {
    const artifact = await makeSource(dbPath).prepareImport({
      sourcePath: '',
      projectId: 'p',
      source: 'zcode',
      sessionId: 'sess_0198prep0-0000-0000-0000-00000000000a',
      dbPath,
    })
    const normalized = '0198prep0-0000-0000-0000-00000000000a'
    expect(artifact.header).toEqual({ id: normalized, timestamp: '2026-01-01T00:00:00.000Z', cwd: '/tmp/zc-prep-cwd' })
    // ISO 段 ：→. 后与归一化 id 均不含 '_'，文件名唯一 '_' 即分隔符
    expect(artifact.fileName).toBe(`2026-01-01T00.00.00.000Z_${normalized}.jsonl`)
    expect(artifact.fileName.replace(/\.jsonl$/, '').split('_').pop()).toBe(normalized)
    // prepareImport 时点 degradations 恒空（转换在 write 闭包内发生，明细 write 后才可见）
    expect(artifact.degradations).toEqual([])
    // write 落地产物（U4 转换器）：空会话（无 message 行）= 首行 header + 第 2 行 session_info
    const tmpPath = join(fixturesRoot_m2, 'zc-tmp.jsonl')
    await artifact.write(tmpPath)
    const outLines = readFileSync(tmpPath, 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(outLines).toHaveLength(2)
    expect(outLines[0]).toEqual({ type: 'session', version: 3, id: normalized, timestamp: '2026-01-01T00:00:00.000Z', cwd: '/tmp/zc-prep-cwd' })
    expect(outLines[1]?.type).toBe('session_info')
    expect((outLines[1] as { name?: unknown }).name).toBe('Prepare me')
    expect(artifact.degradations).toEqual([])
  })

  it('含悬空 compaction 指针的会话：write 后 degradations 恰 1 条 compaction_unlinked——降级明细导入侧不丢失', async () => {
    // C3 锁定（D2 语义适配）：converter 降级明细经 artifact.degradations 承载，编排层
    // write 后聚合 warning='conversion_degraded'（import-service 步骤 8；该聚合通道已由
    // import-service.test.ts stub 注入用例锁定，此处补 converter→artifact 段）。
    // D2 孤儿二分：正常孤儿（无 summaryMessageId）走 custom 通道零降级；悬空指针
    //（summaryMessageId 指向不在行集的消息）计 compaction_unlinked——取悬空形态验证
    // 非空明细不丢失（宿主 user 消息可发射，part 流经 part 级通道）。
    const dbPath3 = join(fixturesRoot_m2, 'zc-compaction.sqlite')
    const sid = 'sess_0198cmp0-0000-0000-0000-00000000000c'
    buildFixtureDb(
      dbPath3,
      [{ id: sid, title: 'Compacted', directory: '/tmp/zc-cmp-cwd', taskType: 'interactive', timeCreated: 1000, timeUpdated: 2000 }],
      [
        // part i=0 → 隐式 message_id 'm-0'（与下方 message 行 id 对齐）；悬空指针形态
        { sessionId: sid, data: JSON.stringify({ type: 'compaction', summaryMessageId: 'm-nowhere', auto: true, trigger: 'auto', preCompactTokenCount: 160000, time: { start: 3000, end: 3100 } }) },
      ],
      // 宿主带 real_user semantics → 分类器②分支 b 判 realUserInput（part 级通道可达）；
      // 无 semantics 时 compaction part 的 summaryMessageId 会被 isTimelineOnlyMessage 命中、宿主整条丢弃（dev U4 悬空用例同款 fixture 口径）
      [{ id: 'm-0', sessionId: sid, sequence: 0, data: JSON.stringify({ role: 'user', time: { created: 1000 }, semantics: { kind: 'user_prompt', origin: 'real_user', uiVisibility: 'visible', transcriptVisibility: 'visible' } }) }],
    )
    const artifact = await makeSource(dbPath3).prepareImport({ sourcePath: '', projectId: 'p', source: 'zcode', sessionId: sid, dbPath: dbPath3 })
    expect(artifact.degradations).toEqual([]) // prepareImport 时点恒空（转换在 write 闭包内）
    await artifact.write(join(fixturesRoot_m2, 'zc-compaction-tmp.jsonl'))
    expect(artifact.degradations).toEqual([{ code: 'compaction_unlinked', kind: 'user_prompt', count: 1 }])
  })

  it('sessionId 缺失 / 不在库中 → import_invalid_session', async () => {
    const source = makeSource(dbPath)
    await expect(catchCode_z3(() => source.prepareImport({ sourcePath: '', projectId: 'p', source: 'zcode', dbPath })))
      .resolves.toBe('import_invalid_session')
    await expect(catchCode_z3(() => source.prepareImport({ sourcePath: '', projectId: 'p', source: 'zcode', sessionId: 'sess_no_such', dbPath })))
      .resolves.toBe('import_invalid_session')
  })

  it('归一化后置条件不满足在此 fail-fast（不进 write 阶段）：id 剥前缀后为空', async () => {
    // 库中放一行 id='sess_' 的会话（超出已验证域 sess_<uuid>，模拟 id 值形态漂移）
    const dbPath2 = join(fixturesRoot_m2, 'zc-badid.sqlite')
    buildFixtureDb(
      dbPath2,
      [{ id: 'sess_', title: 'Bad id', directory: '/tmp/zc-bad-cwd', taskType: 'interactive', timeCreated: 1000, timeUpdated: 1000 }],
      [],
    )
    await expect(catchCode_z3(() => makeSource(dbPath2).prepareImport({ sourcePath: '', projectId: 'p', source: 'zcode', sessionId: 'sess_', dbPath: dbPath2 })))
      .resolves.toBe('import_invalid_session')
  })

  it('RT-5#8：timeCreated 为 finite 但超出 Date 范围（越界大数）→ import_invalid_session 单条失败（不产 1970 / 不裸抛 RangeError）', async () => {
    // asNumber 只拦非 finite；1e300 finite 但 getTime()=NaN——此前 new Date(NaN).toISOString()
    // 裸抛 RangeError，现在收敛为带字段名的 B 类错误，其余会话导入不受影响
    const dbPath3 = join(fixturesRoot_m2, 'zc-huge-ts.sqlite')
    buildFixtureDb(
      dbPath3,
      [{ id: 'sess_0198huge0-0000-0000-0000-00000000000b', title: 'Huge ts', directory: '/tmp/zc-huge-cwd', taskType: 'interactive', timeCreated: 1e300, timeUpdated: 1000 }],
      [],
    )
    const source = makeSource(dbPath3)
    const code = await catchCode_z3(() =>
      source.prepareImport({ sourcePath: '', projectId: 'p', source: 'zcode', sessionId: 'sess_0198huge0-0000-0000-0000-00000000000b', dbPath: dbPath3 }),
    )
    expect(code).toBe('import_invalid_session')
  })
})
describe('恢复阶梯 dispose 契约（L3 快照清理回归锚）', () => {
  // 快照计数域 = 测试私有扫描根（fixturesRoot_m2 下 mkdtemp 自建，目录内条目恒个位数，
  // readdir 恒快）。生产快照根是用户 tmpdir——长期跑测的机器上 mkdtemp 残留可堆积到
  // 十万条目级（实测 readdir 单次 >3s）；「dispose 后前缀目录清零」的判定语义只依赖
  // 计数根内的相对差分，扫描根私有化后语义不变且免受环境退化拖累。前缀 SSOT =
  // zcode-session-source recovery.ts 的 SNAPSHOT_TMP_PREFIX（上方包内相对路径 import
  // 绑定；兼崩溃残留人工识别面）——源内漂移时 mkdtemp 建目与计数判据同源漂移、断言显式红。
  let scanRoot: string
  const countSnapshotDirs = () =>
    readdirSync(scanRoot).filter((n) => n.startsWith(SNAPSHOT_TMP_PREFIX)).length

  let dbPath: string

  beforeAll(() => {
    scanRoot = mkdtempSync(join(fixturesRoot_m2, 'snapshot-scan-'))
    dbPath = join(fixturesRoot_m2, 'zc-dispose.sqlite')
    buildFixtureDb(
      dbPath,
      [{ id: 'sess_0198disp0-0000-0000-0000-00000000000d', title: 'Dispose me', directory: '/tmp/zc-dispose-cwd', taskType: 'interactive', timeCreated: 1000, timeUpdated: 2000 }],
      [],
    )
  })

  it('各调用点 finally 走 handle.dispose 而非仅 db.close：L3 命中形态下快照目录清零', async () => {
    // node 宿主 L1 直开恒成功（runtime 侧 F24），L3 全链无法自然命中——zcode-session-source
    // recovery.test.ts 的 L3 成功用例也只能单级直调 openViaSnapshot。故以 stub handle 模拟
    // L3 命中形态（via='L3-snapshot' + 真实快照目录，dispose = close + 删目录），锁定
    // runtime 调用点「finally 必调 handle.dispose」契约（ZcodeSessionDbHandle.dispose =
    // close + L3 快照目录清理）。修复前 openDb 只回传 handle.db、finally 只 db.close()，
    // dispose 永不被调 → 快照目录残留 → 本用例红。
    const actual = await vi.importActual<typeof import('@zhushanwen/zcode-session-source')>('@zhushanwen/zcode-session-source')
    // 私有扫描根内基线恒 0（不依赖环境干净）；建目后计数 = 1 先钉住计数器本身可见该目录
    expect(countSnapshotDirs()).toBe(0)
    const snapshotDir = mkdtempSync(join(scanRoot, SNAPSHOT_TMP_PREFIX))
    expect(existsSync(snapshotDir)).toBe(true)
    expect(countSnapshotDirs()).toBe(1)
    vi.mocked(openZcodeSessionDb).mockImplementation(async () => {
      // 真连接保真（fixture 库真实可查），仅收尾替换为 L3 形态；快照目录只删一次
      //（首调 dispose 即删，后续 rmSync force=true 幂等）
      const real = await actual.openZcodeSessionDb(dbPath)
      return {
        db: real.db,
        via: 'L3-snapshot',
        dispose() {
          real.dispose()
          rmSync(snapshotDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
        },
      }
    })
    try {
      const source = makeSource(dbPath)
      await source.listCandidates({}) // 调用点①候选行查询 + ②字节聚合（独立短连接）
      const artifact = await source.prepareImport({
        sourcePath: '',
        projectId: 'p',
        source: 'zcode',
        sessionId: 'sess_0198disp0-0000-0000-0000-00000000000d',
        dbPath,
      }) // 调用点③导入定位
      await artifact.write(join(fixturesRoot_m2, 'zc-dispose-tmp.jsonl')) // 调用点④write 转换
    } finally {
      // 恢复透传实现（既有用例不感知 L3 stub）
      vi.mocked(openZcodeSessionDb).mockImplementation((p: string) => actual.openZcodeSessionDb(p))
    }
    expect(existsSync(snapshotDir)).toBe(false)
    expect(countSnapshotDirs()).toBe(0)
  })
})
});
// ======================================================================
// ← src/__tests__/message-dispatcher-bus.test.ts
// ======================================================================

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('message-dispatcher-bus', () => {
describe('message-dispatcher-bash', () => {
/**
 * MessageDispatcher bash 执行链路测试（composer-bash-execute W1 + W2 并发放宽）。
 *
 * 锁定：
 * - T4: sendBash busy 时（isBashRunning=true）→ 广播 send.rejected{reason:'busy'} + 不调 client.bash + 返回回执 rejected
 * - T4c: sendBash isCompacting=true → 同样 reject（bash↔compact 互斥仍保留）
 * - T4b(w2+W1): sendBash isGenerating=true → 允许并发（不 reject）+ 双分支延迟：bashStart 即时，
 *           bashResult 压入 per-session 待落列（镜像 pi _pendingBashMessages），flush 时按序发布。
 *           W2 放宽：bash 与 AI streaming 并发（对齐 pi-tui）；W1 fix-chat-flow-order D2：
 *           live 入流位置对齐 pi 落盘位置（级联末）。仅保留 bash↔bash（T4）/ bash↔compacting（T4c）互斥。
 * - T4b-flush / T4b-flush-noop / T4b-error-immediate：待落列 flush 顺序 / no-op / 错误帧不延迟。
 * - T5: sendBash 正常 → 广播 message.bashStart → client.bash resolve → 广播 message.bashResult（完整字段）+ finally isBashRunning 复位 false
 * - T6: sendBash client.bash reject → 广播 message.error + finally isBashRunning 复位 + 返回回执 settled+error
 * - T7: sendMessage 互斥（isBashRunning=true 时 sendMessage → 广播 send.rejected + 不调 client.prompt）—— G1 修复
 *       注意：sendMessage 预检本期不放宽（spec OQ-1），isGenerating/isBashRunning/isCompacting 三者仍互斥。
 * - T8: abortBash → client.abortBash() 调用 + 广播 message.bashAborted 兜底终态（D4-3 独立帧，
 *       原 bashResult{command:''} 哨兵退役）+ isBashRunning 复位
 *
 * mock 模式参考 test/message-dispatcher-precheck.test.ts（makeMocks_m3_m3_m3_m3/makeMockSession_m3_m3_m3_m3），
 * 扩展：client 加 bash/abortBash，session.isBashRunning 需可设。
 *
 * 运行：npx vitest run src/__tests__/message-dispatcher-bash.test.ts
 */
/** bash 相关广播消息的类型收窄（ServerMessage 是泛型 interface 非 union，find 无法自动收窄 payload） */
type BashStartMsg = ServerMessage<'message.bashStart'>
type BashResultMsg = ServerMessage<'message.bashResult'>
type BashAbortedMsg = ServerMessage<'message.bashAborted'>
function findBashStart(b: ServerMessage[]): BashStartMsg | undefined {
  return b.find((m) => m.type === 'message.bashStart') as BashStartMsg | undefined
}
function findBashResult(b: ServerMessage[]): BashResultMsg | undefined {
  return b.find((m) => m.type === 'message.bashResult') as BashResultMsg | undefined
}
function findBashAborted(b: ServerMessage[]): BashAbortedMsg | undefined {
  return b.find((m) => m.type === 'message.bashAborted') as BashAbortedMsg | undefined
}

function makeMockSession_m3_m3_m3_m3(overrides: Partial<IManagedSessionView> = {}): IManagedSessionView {
  return {
    id: 's1',
    cwd: '/test',
    label: 'test',
    modelId: 'm1',
    createdAt: 1,
    lastActiveAt: 1,
    tokenCount: 0,
    inputTokens: 0,
        bashRunToken: undefined,
    ...overrides,
  }
}

interface MockOpts_m2_m2_m2_m2 { // oe-exempt:20261027:test:测试夹具接口（合并产物内多节共用的 mock 形状契约）
  isBashRunning?: boolean
  isGenerating?: boolean
  isCompacting?: boolean
  bashResult?: PiBashResult
  bashError?: Error
  promptError?: Error
  abortBashError?: Error
}

function makeMocks_m3_m3_m3_m3(opts: MockOpts_m2_m2_m2_m2 = {}) {
  const isBashRunning = opts.isBashRunning ?? false
  const isGenerating = opts.isGenerating ?? false
  const isCompacting = opts.isCompacting ?? false
  // [u3b 预检改读 occupancy → D1 全量迁移] 预检读口统一 = occupancy 派生（fixture 直写四维）。
  const session = makeMockSession_m3_m3_m3_m3({
    occupancy: { turn: isGenerating ? 'generating' : 'idle', compacting: isCompacting, bash: isBashRunning, handingOff: false },
  })

  const bashFn = opts.bashResult
    ? vi.fn(async () => opts.bashResult!)
    : opts.bashError
      ? vi.fn(async () => { throw opts.bashError! })
      : vi.fn(async () => ({
          output: 'ok',
          exitCode: 0,
          cancelled: false,
          truncated: false,
        }) as PiBashResult)

  const abortBashFn = opts.abortBashError
    ? vi.fn(async () => { throw opts.abortBashError! })
    : vi.fn(async () => ({}) as Awaited<ReturnType<IPiEngine['abortBash']>>)

  const promptFn = opts.promptError
    ? vi.fn(async () => { throw opts.promptError! })
    : vi.fn(async () => ({}) as unknown as Awaited<ReturnType<IPiEngine['prompt']>>)

  // touchActivity：sendPrompt 入口同步 touch（idle-pi-reclamation D6-1）经 pm.getClient
  // 到达 fake client——fake 须补齐该接口成员
  const client = { prompt: promptFn, bash: bashFn, abortBash: abortBashFn, touchActivity: vi.fn() } as unknown as IPiEngine

  // wave:perf-w09（D1-2）：dispatcher 只依赖 publish 抽象（broker 双写路径已删），mock bus 收集发布消息
  const broadcasts: ServerMessage[] = []
  const bus = { publish: vi.fn((_sid: string, m: ServerMessage) => { broadcasts.push(m) }) } as unknown as IMessageBus

  // S2 ISP 化：结构性满足 dispatcher 窄接口（6 方法 = 消费方实际用到的全部），无强转
  const svc: IDispatcherSessionOps = {
    ensureActive: vi.fn(async () => client),
    getSessionByClient: vi.fn(() => session),
    getSession: vi.fn(() => session),
    persistSessionOutcome: vi.fn(),
    clearSessionOutcome: vi.fn(),
    removeSessionEntry: vi.fn(),
    detachSession: vi.fn(),
  }

  const pm = {
    getClient: vi.fn(() => client),
  } as unknown as IProcessManager
  const workspace = { record: vi.fn() } as unknown as WorkspaceService

  const dispatcher = new MessageDispatcher(svc, pm, workspace, bus)
  return { dispatcher, session, bashFn, abortBashFn, promptFn, broadcasts, bus }
}

describe('MessageDispatcher sendBash —— busy 预检（T4）', () => {
  beforeEach(() => vi.clearAllMocks())

  it('T4: isBashRunning=true → 广播 send.rejected{reason:"busy"} + 不调 client.bash + 返回回执 rejected', async () => {
    const { dispatcher, bashFn, broadcasts } = makeMocks_m3_m3_m3_m3({ isBashRunning: true })
    const result = await dispatcher.sendBash('s1', 'git status', false)

    // 不调 client.bash
    expect(bashFn).not.toHaveBeenCalled()
    // 广播 send.rejected{reason:'busy'}
    const rejected = broadcasts.find((m) => m.type === 'send.rejected')
    expect(rejected).toBeDefined()
    expect(rejected!.payload).toMatchObject({ sessionId: 's1', reason: 'busy' })
    // 返回值
    expect(result).toEqual({ status: 'rejected' }) // 回执 rejected（未执行）
  })

  // 注意：原 T4b（isGenerating → reject）已反转 → 移至下方
  // describe('MessageDispatcher sendBash —— 并发放宽（w2, 对齐 pi-tui）') 块（W2 放宽 bash↔streaming 并发）。

  it('T4c: isCompacting=true → 广播 send.rejected{reason:"busy"} + 不调 client.bash + 返回回执 rejected', async () => {
    const { dispatcher, bashFn, broadcasts } = makeMocks_m3_m3_m3_m3({ isCompacting: true })
    const result = await dispatcher.sendBash('s1', 'echo hi', false)

    expect(bashFn).not.toHaveBeenCalled()
    const rejected = broadcasts.find((m) => m.type === 'send.rejected')
    expect(rejected).toBeDefined()
    expect(rejected!.payload).toMatchObject({ sessionId: 's1', reason: 'busy' })
    expect(result).toEqual({ status: 'rejected' }) // 回执 rejected（未执行）
  })
})

describe('MessageDispatcher sendBash —— 并发放宽 + 双分支延迟（w2 / W1 fix-chat-flow-order）', () => {
  beforeEach(() => vi.clearAllMocks())

  // W2 起放宽 bash↔streaming 并发：sendBash 预检移除 isGenerating。
  // 原因（spec C1）：pi 把 bash RPC 排入 _pendingBashMessages，待当前 turn 结束后按 JSONL 顺序回放，
  // 对 RPC 透明——runtime 侧无需排队等待。对齐 pi-tui（允许 streaming 时发 bash）。
  // [W1 fix-chat-flow-order D2] isGenerating（活跃 run）时结果进 per-session 待落列（镜像 pi
  // _pendingBashMessages），agent_settled 到达（flushPendingBashResults）才按序以帧发布——
  // live 入流位置构造性对齐 pi 落盘位置（级联末）。
  it('T4b(w2+W1): isGenerating=true → 允许并发（不 reject）→ bashStart 即时广播，bashResult 压入待落列（不即时广播），flush 时按序发布', async () => {
    const bashResult: PiBashResult = { output: 'ok', exitCode: 0, cancelled: false, truncated: false }
    const { dispatcher, bashFn, broadcasts, session } = makeMocks_m3_m3_m3_m3({ isGenerating: true, bashResult })

    const result = await dispatcher.sendBash('s1', 'echo hi', false)

    // 不广播 send.rejected（W2 放宽：isGenerating 不再阻塞 bash）
    const rejected = broadcasts.find((m) => m.type === 'send.rejected')
    expect(rejected).toBeUndefined()
    // 调 client.bash（与 T5 正常路径一致）
    expect(bashFn).toHaveBeenCalledWith('echo hi', false)
    // 广播 message.bashStart（执行中反馈即时）
    const start = findBashStart(broadcasts)
    expect(start).toBeDefined()
    expect(start!.payload).toMatchObject({ sessionId: 's1', command: 'echo hi', excludeFromContext: false })
    // [W1 D2] streaming 中：bashResult 不即时广播，压入待落列（timestamp = RPC 完成时刻）
    expect(findBashResult(broadcasts)).toBeUndefined()
    expect(session.pendingBashResults).toHaveLength(1)
    expect(session.pendingBashResults![0]).toMatchObject({
      command: 'echo hi',
      output: 'ok',
      exitCode: 0,
      cancelled: false,
      truncated: false,
      excludeFromContext: false,
    })
    // finally bash 维复位（[D1] 读口迁移）
    expect(session.occupancy?.bash).toBe(false)
    // 正常返回
    expect(result).toEqual({ status: 'settled' }) // 回执 settled（已执行并收尾）

    // 级联结束（agent_settled → flushPendingBashResults）→ 按序以帧发布 + 清空待落列
    dispatcher.flushPendingBashResults('s1')
    const end = findBashResult(broadcasts)
    expect(end).toBeDefined()
    expect(end!.payload).toMatchObject({
      sessionId: 's1',
      command: 'echo hi',
      output: 'ok',
      exitCode: 0,
      cancelled: false,
      truncated: false,
      excludeFromContext: false,
    })
    expect(session.pendingBashResults).toHaveLength(0)
  })

  it('T4b-flush: 同级联两条 bash → 待落列按 RPC 完成序，flush 一次按序发布两条', async () => {
    // 顺序两次 sendBash（bash↔bash 互斥天然串行：第一次 finally 复位 isBashRunning 后第二次才可发）
    const mocks = makeMocks_m3_m3_m3_m3({ isGenerating: true })
    mocks.bashFn.mockImplementation(async () => ({ output: 'first-out', exitCode: 0, cancelled: false, truncated: false }) as PiBashResult)
    await mocks.dispatcher.sendBash('s1', 'cmd-1', false)
    mocks.bashFn.mockImplementation(async () => ({ output: 'second-out', exitCode: 0, cancelled: false, truncated: false }) as PiBashResult)
    await mocks.dispatcher.sendBash('s1', 'cmd-2', false)

    // 两条都待落列（按完成序）
    expect(mocks.session.pendingBashResults?.map((d) => d.command)).toEqual(['cmd-1', 'cmd-2'])

    mocks.dispatcher.flushPendingBashResults('s1')
    const results = mocks.broadcasts.filter((m) => m.type === 'message.bashResult')
    expect(results).toHaveLength(2)
    expect(results[0].payload).toMatchObject({ command: 'cmd-1', output: 'first-out' })
    expect(results[1].payload).toMatchObject({ command: 'cmd-2', output: 'second-out' })
    expect(mocks.session.pendingBashResults).toHaveLength(0)
  })

  it('T4b-flush-noop: 无待落列 / session 不存在 → no-op 不抛、不广播', () => {
    const { dispatcher, broadcasts } = makeMocks_m3_m3_m3_m3()
    expect(() => dispatcher.flushPendingBashResults('s1')).not.toThrow()
    expect(broadcasts.filter((m) => m.type === 'message.bashResult')).toHaveLength(0)
  })

  it('T4b-error-immediate: streaming 中 RPC 失败 → 错误兜底帧立即广播（不进待落列）', async () => {
    const { dispatcher, broadcasts, session } = makeMocks_m3_m3_m3_m3({ isGenerating: true, bashError: new Error('pi boom') })
    await dispatcher.sendBash('s1', 'git status')

    // [S2] 错误兜底 bashResult 立即发布（taiji 合成帧无 pi 落盘时序语义，不延迟）
    const end = findBashResult(broadcasts)
    expect(end).toBeDefined()
    expect(end!.payload.output).toContain('pi boom')
    // 不进待落列
    expect(session.pendingBashResults).toBeUndefined()
  })
})

describe('MessageDispatcher sendBash —— 正常路径（T5）', () => {
  beforeEach(() => vi.clearAllMocks())

  it('T5: 正常 → 广播 message.bashStart → client.bash resolve → 广播 message.bashResult(完整字段) → finally isBashRunning 复位', async () => {
    const bashResult: PiBashResult = { output: 'out', exitCode: 2, cancelled: false, truncated: true }
    const { dispatcher, bashFn, broadcasts, session } = makeMocks_m3_m3_m3_m3({ bashResult })

    const result = await dispatcher.sendBash('s1', 'ls -la', false)

    // client.bash 被调，参数透传（excludeFromContext=false）
    expect(bashFn).toHaveBeenCalledWith('ls -la', false)

    // bashStart 广播
    const start = findBashStart(broadcasts)
    expect(start).toBeDefined()
    expect(start!.payload).toMatchObject({
      sessionId: 's1',
      command: 'ls -la',
      excludeFromContext: false,
    })
    expect(typeof start!.payload.timestamp).toBe('number')

    // bashResult 广播（完整字段）
    const end = findBashResult(broadcasts)
    expect(end).toBeDefined()
    expect(end!.payload).toMatchObject({
      sessionId: 's1',
      command: 'ls -la',
      output: 'out',
      exitCode: 2,
      cancelled: false,
      truncated: true,
      excludeFromContext: false,
    })
    expect(typeof end!.payload.timestamp).toBe('number')

    // isBashRunning 复位 false（finally 兜底）
    expect(session.occupancy?.bash).toBe(false)
    // 正常返回
    expect(result).toEqual({ status: 'settled' }) // 回执 settled（已执行并收尾）
  })

  it('T5b: excludeFromContext=true 透传到 bashStart/bashResult', async () => {
    const { dispatcher, broadcasts } = makeMocks_m3_m3_m3_m3()
    await dispatcher.sendBash('s1', 'pwd', true)
    const start = findBashStart(broadcasts)
    const end = findBashResult(broadcasts)
    expect(start!.payload.excludeFromContext).toBe(true)
    expect(end!.payload.excludeFromContext).toBe(true)
  })

  it('T5c: pi 返回 exitCode undefined → bashResult.exitCode 归一为 null', async () => {
    const bashResult: PiBashResult = { output: '', exitCode: undefined, cancelled: false, truncated: false }
    const { dispatcher, broadcasts } = makeMocks_m3_m3_m3_m3({ bashResult })
    await dispatcher.sendBash('s1', 'x')
    const end = findBashResult(broadcasts)
    expect(end!.payload.exitCode).toBeNull()
  })
})

describe('MessageDispatcher sendBash —— 错误路径（T6, S2 对称兜底）', () => {
  beforeEach(() => vi.clearAllMocks())

  it('T6: client.bash reject → 广播 message.error{message} + 补发 bashResult 终态（S2 对称兜底）+ finally isBashRunning 复位 + 返回回执 settled+error', async () => {
    const { dispatcher, broadcasts, session } = makeMocks_m3_m3_m3_m3({ bashError: new Error('pi boom') })
    const result = await dispatcher.sendBash('s1', 'git status')

    // 广播了 message.error
    const errMsg = broadcasts.find((m) => m.type === 'message.error')
    expect(errMsg).toBeDefined()
    expect(errMsg!.payload).toMatchObject({ sessionId: 's1', message: 'pi boom' })
    // [S2] 与 abortBash 对称兜底：前端 message.error handler 只收尾 streaming assistant
    // （不收尾 role:'system' 的 streaming bash），故补发 bashResult 终态让 bash 收尾。
    const end = findBashResult(broadcasts)
    expect(end).toBeDefined()
    expect(end!.payload).toMatchObject({
      sessionId: 's1',
      command: 'git status',
      cancelled: false,
      exitCode: null,
      truncated: false,
      excludeFromContext: false,
    })
    expect(typeof end!.payload.output).toBe('string')
    expect(end!.payload.output).toContain('pi boom')
    // finally isBashRunning 复位
    expect(session.occupancy?.bash).toBe(false)
    // 回执 settled+error（已执行并收尾——执行失败非预检拒绝，消费方不得恢复草稿）
    expect(result).toEqual({ status: 'settled', error: 'pi boom' })
  })
})

describe('MessageDispatcher —— bash/message 双向互斥（T7 迁移：内核持有承接，u2）', () => {
  beforeEach(() => vi.clearAllMocks())

  it('T7: isBashRunning=true 时 sendMessage → 零 send.rejected + 不调 client.prompt（内核持有等 bash 结束）', async () => {
    const { dispatcher, promptFn, broadcasts } = makeMocks_m3_m3_m3_m3({ isBashRunning: true })
    const result = await dispatcher.sendMessage('s1', 'hello')

    // client.prompt 未被调用（bash 进行中不允许发消息——语义保持，实现从「拒绝」改为「内核持有」）
    expect(promptFn).not.toHaveBeenCalled()
    // send.rejected 退役（D5 排队取代拒绝）：busy 度不再产生拒绝广播
    expect(broadcasts.find((m) => m.type === 'send.rejected')).toBeUndefined()
    // 受理口径：RPC 不再收到 rejected ack（消息由内核 FIFO 承接，bash 结束后投递）
    expect(result.blocked).toBe(false)
    expect(result.rejected).toBeUndefined()
  })
})

describe('MessageDispatcher abortBash（T8 + P6 断言④孤儿形态）', () => {
  beforeEach(() => vi.clearAllMocks())

  it('T8: abortBash → client.abortBash() 调用 + 广播 message.bashAborted 兜底终态 + isBashRunning 复位 + sent:true', async () => {
    const { dispatcher, abortBashFn, broadcasts, session } = makeMocks_m3_m3_m3_m3({ isBashRunning: true })

    const result = await dispatcher.abortBash('s1')

    // client.abortBash 被调
    expect(abortBashFn).toHaveBeenCalledTimes(1)
    // abort_bash 发出且 pi 确认 → sent:true（回执真实化，调用方可据此回 aborted）
    expect(result).toEqual({ sent: true })
    // 兜底广播 message.bashAborted（wire 形态 = shared ServerMessageMap['message.bashAborted']，
    // 消费侧契约锁在 core bash-effects.test.ts bashAbortedEffect 用例）
    const aborted = findBashAborted(broadcasts)
    expect(aborted).toBeDefined()
    expect(aborted!.payload).toMatchObject({ sessionId: 's1' })
    expect(typeof aborted!.payload.timestamp).toBe('number')
    // isBashRunning 复位（finally 兜底）
    expect(session.occupancy?.bash).toBe(false)
  })

  it('T8b: client.abortBash 抛异常 → 不向上抛 + sent:false（回执真实化：不得据此回 aborted）+ 兜底广播', async () => {
    const { dispatcher, broadcasts, session } = makeMocks_m3_m3_m3_m3({ isBashRunning: true, abortBashError: new Error('rpc dead') })

    // 不该 throw，且 sent=false（abort_bash 未被 pi 确认）
    await expect(dispatcher.abortBash('s1')).resolves.toEqual({ sent: false })

    // 兜底终态仍广播（message.bashAborted 独立帧，与 pi 确认与否无关）
    const aborted = findBashAborted(broadcasts)
    expect(aborted).toBeDefined()
    expect(aborted!.payload.sessionId).toBe('s1')
    // isBashRunning 仍复位
    expect(session.occupancy?.bash).toBe(false)
  })

  it('T8c: 无 bash 在跑 → 检查短路 { sent:false } + 不调 client.abortBash（回执真实化：不得回 aborted）', async () => {
    const { dispatcher, abortBashFn, broadcasts, session } = makeMocks_m3_m3_m3_m3({})

    const result = await dispatcher.abortBash('s1')

    expect(abortBashFn).not.toHaveBeenCalled()
    expect(result).toEqual({ sent: false })
    // 短路不广播 bashAborted 兜底终态（既有行为：无条件广播会污染无 bash 场景）
    expect(findBashAborted(broadcasts)).toBeUndefined()
    expect(session.occupancy?.bash).toBe(false)
  })

})

describe('MessageDispatcher sendBash 空命令（D4-3 哨兵不变式检查删除）', () => {
  beforeEach(() => vi.clearAllMocks())

  it("D4-3: 空命令不再哨兵早退——sendBash('') 正常走执行链（哨兵帧退役为独立 message.bashAborted 后，空命令检查的「保哨兵形态不变式」职责消灭）", async () => {
    const { dispatcher, bashFn, broadcasts, session } = makeMocks_m3_m3_m3_m3({})

    // 旧检查：console.warn + 拒绝回执早退——它存在的唯一理由是保证 bashResult 帧
    // command 恒非空、与 command:'' 哨兵帧永不混淆。哨兵帧退役为独立帧类型后不变式不再需要。
    const result = await dispatcher.sendBash('s1', '', false)

    expect(bashFn).toHaveBeenCalledWith('', false)
    expect(findBashStart(broadcasts)).toBeDefined()
    expect(findBashResult(broadcasts)).toBeDefined()
    expect(session.occupancy?.bash).toBe(false)
    expect(result).toEqual({ status: 'settled' })
  })
})
})
describe('message-dispatcher-force-quit', () => {
/**
 * MessageDispatcher.forceQuit / 强杀收敛编排测试（sidebar 强制退出入口）。
 *
 * 锁定：
 * - FQ1: forceQuit 活跃 session → 按序 detach → destroy → persist stopped('User forced quit') →
 *        广播 session.exited{code:null, reason:用户指引文案} → removeEntry（与 abort 超时路径同构）
 * - FQ2: forceQuit 不在活跃进程表（pm.getClient 返回 undefined）→ 幂等成功：
 *        不调 destroy/persist/removeEntry、不广播（竞态兜底，菜单渲染后 session 恰好退出）
 * - FQ3: [ADR-0122 退役] abort RPC 超时三级阶梯（W7，含真冻结判据）已随 RPC 墙钟整体
 *        删除，对应用例退役
 * - FQ4（code-harden RT-4#1）: 编排中段抛错 → 终态三步（full-reset / session.exited /
 *        removeEntry）finally 必达，异常不上抛
 * - FQ5/FQ6（code-harden RT-4#1）: 无活跃进程分支按 occupancy 分型——≠idle 继续完整
 *        收敛（不再「幂等成功」假成功）；=idle 保持幂等成功竞态兜底
 *
 * mock 模式参考 message-dispatcher-bash.test.ts 的 makeMocks_m3_m3_m3_m3。
 *
 * 运行：cd packages/runtime && npx vitest run src/__tests__/message-dispatcher-force-quit.test.ts
 */
type SessionExitedMsg = ServerMessage<'session.exited'>
function findSessionExited(b: ServerMessage[]): SessionExitedMsg | undefined {
  return b.find((m) => m.type === 'session.exited') as SessionExitedMsg | undefined
}

function makeMockSession_m3_m3_m3_m3(): IManagedSessionView {
  return {
    id: 's1',
    cwd: '/test',
    label: 'test',
    modelId: 'm1',
    createdAt: 1,
    lastActiveAt: 1,
    tokenCount: 0,
    inputTokens: 0,
        bashRunToken: undefined,
  }
}

interface MockOpts_m2_m2_m2_m2 { // oe-exempt:20261027:test:测试夹具接口（合并产物内多节共用的 mock 形状契约）
  /** pm.getClient 返回值；undefined 模拟 session 不在活跃进程表 */
  active?: boolean
}

interface ForceQuitMocks { // oe-exempt:20261027:test:测试夹具接口（合并产物内多节共用的 mock 形状契约）
  dispatcher: MessageDispatcher
  destroySessionFn: ReturnType<typeof vi.fn>
  detachSessionFn: ReturnType<typeof vi.fn>
  persistOutcomeFn: ReturnType<typeof vi.fn>
  removeEntryFn: ReturnType<typeof vi.fn>
  /** svc.getSession（FQ5/FQ6 注入 occupancy 用） */
  svcGetSession: ReturnType<typeof vi.fn>
  broadcasts: ServerMessage[]
  callOrder: string[]
}

function makeMocks_m3_m3_m3_m3(opts: MockOpts_m2_m2_m2_m2 = {}): ForceQuitMocks {
  const client = { abort: vi.fn(async () => ({}) as Awaited<ReturnType<IPiEngine['abort']>>) }

  const broadcasts: ServerMessage[] = []
  const bus = { publish: vi.fn((_sid: string, m: ServerMessage) => { broadcasts.push(m) }) } as unknown as IMessageBus

  // 编排顺序断言：detach → destroy → persist → removeEntry 必须按此相对顺序
  const callOrder: string[] = []
  const detachSessionFn = vi.fn(() => { callOrder.push('detach') })
  const destroySessionFn = vi.fn(async () => { callOrder.push('destroy') })
  const persistOutcomeFn = vi.fn(() => { callOrder.push('persist') })
  const removeEntryFn = vi.fn(() => { callOrder.push('remove') })

  // S2 ISP 化：结构性满足 dispatcher 窄接口（7 方法 = 消费方实际用到的全部），无强转。
  // ensureActive/getSession 不在 forceQuit/abort 收敛路径上，空 mock 即可。
  const svcGetSession = vi.fn()
  const svc: IDispatcherSessionOps = {
    getSessionByClient: vi.fn(() => makeMockSession_m3_m3_m3_m3()),
    detachSession: detachSessionFn,
    persistSessionOutcome: persistOutcomeFn,
    clearSessionOutcome: vi.fn(),
    removeSessionEntry: removeEntryFn,
    ensureActive: vi.fn(),
    getSession: svcGetSession,
  }

  const pm = {
    getClient: vi.fn(() => (opts.active === false ? undefined : client)),
    destroySession: destroySessionFn,
  } as unknown as IProcessManager

  const workspace = { record: vi.fn() } as unknown as WorkspaceService
  const dispatcher = new MessageDispatcher(svc, pm, workspace, bus)
  return { dispatcher, destroySessionFn, detachSessionFn, persistOutcomeFn, removeEntryFn, svcGetSession, broadcasts, callOrder }
}

describe('MessageDispatcher forceQuit —— sidebar 强制退出', () => {
  it('FQ1: 活跃 session → detach→destroy→persist(stopped,User forced quit)→广播 session.exited(code:null)→removeEntry，按序执行', async () => {
    const m = makeMocks_m3_m3_m3_m3({ active: true })

    await m.dispatcher.forceQuit('s1')

    // 编排顺序：destroy 是 async 但必须在 detach 之后、persist 之前完成
    expect(m.callOrder).toEqual(['detach', 'destroy', 'persist', 'remove'])
    expect(m.persistOutcomeFn).toHaveBeenCalledWith('s1', 'stopped', 'User forced quit')
    const exited = findSessionExited(m.broadcasts)
    expect(exited).toBeDefined()
    expect(exited!.payload).toMatchObject({ sessionId: 's1', code: null })
    // exitReason 面向用户可操作：含恢复指引（重开/历史完整）
    expect(exited!.payload.reason).toContain('强制退出')
    expect(exited!.payload.reason).toContain('恢复')
  })

  it('FQ2: 不在活跃进程表 → 幂等成功：不 destroy/persist/remove、不广播', async () => {
    const m = makeMocks_m3_m3_m3_m3({ active: false })

    await expect(m.dispatcher.forceQuit('s1')).resolves.toBeUndefined()

    expect(m.destroySessionFn).not.toHaveBeenCalled()
    expect(m.persistOutcomeFn).not.toHaveBeenCalled()
    expect(m.removeEntryFn).not.toHaveBeenCalled()
    expect(m.broadcasts).toHaveLength(0)
  })

  it('FQ4: 编排中段抛错（destroy throw）→ 终态三步仍完成（full-reset + session.exited + removeEntry），不沿调用链上抛', async () => {
    const m = makeMocks_m3_m3_m3_m3({ active: true })
    ;(m.destroySessionFn as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('kill exploded'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      // [code-harden RT-4#1] destroy 失败只降级日志：full-reset / session.exited / removeEntry
      // 在 finally 中必达，异常不再上抛成 uncaughtException 连坐全 runtime。
      await expect(m.dispatcher.forceQuit('s1')).resolves.toBeUndefined()

      expect(m.removeEntryFn).toHaveBeenCalledTimes(1)
      const exited = findSessionExited(m.broadcasts)
      expect(exited).toBeDefined()
      expect(exited!.payload).toMatchObject({ sessionId: 's1', code: null })
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('forceQuitSession pre-terminal steps failed'), expect.any(Error))
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('FQ5: 无活跃进程但 occupancy≠idle（条目还在、turn 卡 generating）→ 继续完整收敛而非「幂等成功」假成功', async () => {
    // [code-harden RT-4#1] 旧行为：无 client 一律「幂等成功」返回——占用态卡死且事件源
    // 已断（无进程可产生 agent_settled）时，isGenerating/turn 派生视图永久滞留。改为继续收敛。
    const m = makeMocks_m3_m3_m3_m3({ active: false })
    const stuckSession = { ...makeMockSession_m3_m3_m3_m3(), occupancy: { turn: 'generating', compacting: false, bash: false, handingOff: false } }
    ;(m.svcGetSession as ReturnType<typeof vi.fn>).mockReturnValue(stuckSession)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      await m.dispatcher.forceQuit('s1')

      // 完整收敛链：stopped 终态 + session.exited 广播 + removeEntry。
      //（destroySession 仍被调用——生产侧对无进程条目幂等 no-op，编排统一走同一条链。）
      expect(m.detachSessionFn).toHaveBeenCalledTimes(1)
      expect(m.persistOutcomeFn).toHaveBeenCalledWith('s1', 'stopped', 'User forced quit')
      expect(m.removeEntryFn).toHaveBeenCalledTimes(1)
      expect(findSessionExited(m.broadcasts)).toBeDefined()
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('occupancy not idle'))
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('FQ6: 无活跃进程且占用已复位（occupancy=idle）→ 保持幂等成功（真实竞态兜底不受影响）', async () => {
    const m = makeMocks_m3_m3_m3_m3({ active: false })
    const idleSession = { ...makeMockSession_m3_m3_m3_m3(), occupancy: { turn: 'idle', compacting: false, bash: false, handingOff: false } }
    ;(m.svcGetSession as ReturnType<typeof vi.fn>).mockReturnValue(idleSession)

    await expect(m.dispatcher.forceQuit('s1')).resolves.toBeUndefined()

    expect(m.persistOutcomeFn).not.toHaveBeenCalled()
    expect(m.removeEntryFn).not.toHaveBeenCalled()
    expect(m.broadcasts).toHaveLength(0)
  })
})
})
describe('dispatcher-bus', () => {
/**
 * MessageDispatcher × MessageBus 单通道集成测试（wave:perf-w09，02 文档 D1-2）。
 *
 * 删双写后 dispatcher 只依赖 publish 抽象（broker 依赖已删除）——锁定全部 session 级
 * 命令编排消息（message.error / send.rejected / message.bashStart / message.bashResult /
 * message.complete）经 bus.publish 定向发布且恰好发布一次（无双发）；compaction 生命周期
 * 消息零发布（M4：归 interpreter 唯一编排）。
 *
 * 覆盖：
 * - sendMessage error path → bus.publish(message.error)
 * - sendMessage busy → bus.publish(send.rejected)
 * - hook blocked → bus.publish(message.error)
 * - hook error → bus.publish(message.error)
 * - abort failure → bus.publish(message.error)
 * - abort success（三分型型1: 有回合可中止）→ bus.publish(message.complete)；
 *   idle 入口（型3）/ 用户压缩取消（型2）→ no-op 零广播
 * - abort convergence（型1）→ 终态 reason 'Convergence abort (auto)'
 * - sendBash ensureActive fail → bus.publish(message.error)
 * - sendBash busy → bus.publish(send.rejected)
 * - sendBash start → bus.publish(message.bashStart)
 * - sendBash success → bus.publish(message.bashResult)
 * - sendBash error → bus.publish(message.bashResult + message.error)
 * - abortBash → bus.publish(message.bashAborted)（D4-3 兜底终态独立帧）
 * - compact（M4 事件驱动）→ 零 compaction 广播（busy/start/fail/summary/success 各路径，生命周期归 interpreter）
 * - messageBus undefined → no crash（null-safety）
 *
 * mock 策略：全部依赖 mock，不 spawn pi。
 *
 * 运行：npx vitest run test/dispatcher-bus.test.ts
 */
function makeMockSession_m3_m3_m3_m3(overrides: Partial<IManagedSessionView> = {}): IManagedSessionView {
  return {
    id: 's1',
    cwd: '/test',
    label: 'test',
    modelId: 'm1',
    createdAt: 1,
    lastActiveAt: 1,
    tokenCount: 0,
    inputTokens: 0,
        bashRunToken: undefined,
    ...overrides,
  }
}

function makeMocks_m3_m3_m3_m3(opts: {
  isGenerating?: boolean
  isCompacting?: boolean
  isBashRunning?: boolean
  promptError?: Error
  session?: IManagedSessionView
  messageBus?: { publish: ReturnType<typeof vi.fn> }
} = {}) {
  const isGenerating = opts.isGenerating ?? false
  const isCompacting = opts.isCompacting ?? false
  const isBashRunning = opts.isBashRunning ?? false
  // [u3b 预检改读 occupancy] sendPrompt 预检输入源改为 occupancy 派生视图。fixture 镜像真实
  // 链路的原子同步（原语「合并 + 派生」双写合一）。
  const session = opts.session ?? makeMockSession_m3_m3_m3_m3({
    occupancy: { turn: isGenerating ? 'generating' : 'idle', compacting: isCompacting, bash: isBashRunning, handingOff: false },
  })
  const promptFn = opts.promptError
    ? vi.fn(async () => { throw opts.promptError! })
    : vi.fn(async () => ({}) as unknown as Awaited<ReturnType<IPiEngine['prompt']>>)
  const bashFn = vi.fn(async () => ({ output: 'ok', exitCode: 0, cancelled: false, truncated: false }))
  const abortFn = vi.fn(async () => {})
  const abortBashFn = vi.fn(async () => {})
  const steerFn = vi.fn(async () => {})
  const followUpFn = vi.fn(async () => {})
  const compactFn = vi.fn(async () => ({ summary: 'compacted summary', tokensBefore: 100, estimatedTokensAfter: 50 }))
  const client = {
    prompt: promptFn,
    bash: bashFn,
    abort: abortFn,
    abortBash: abortBashFn,
    steer: steerFn,
    followUp: followUpFn,
    compact: compactFn,
    // touchActivity：sendPrompt 入口同步 touch（idle-pi-reclamation D6-1）经 pm.getClient
    // 到达 fake client——fake 须补齐该接口成员
    touchActivity: vi.fn(),
  } as unknown as IPiEngine

  // S2 ISP 化：结构性满足 dispatcher 窄接口（7 方法 = 消费方实际用到的全部），无强转；
  // applyContextUpdate 不在窄接口（event-interpreter 组合根回调消费），随迁移移除
  const svc: IDispatcherSessionOps = {
    ensureActive: vi.fn(async () => client),
    getSessionByClient: vi.fn(() => session),
    persistSessionOutcome: vi.fn(),
    clearSessionOutcome: vi.fn(),
    getSession: vi.fn(),
    removeSessionEntry: vi.fn(),
    detachSession: vi.fn(),
  }

  const pm = {
    getClient: vi.fn(() => client),
  } as unknown as IProcessManager

  const workspace = { record: vi.fn() } as unknown as WorkspaceService

  const messageBus = opts.messageBus ?? { publish: vi.fn() }

  // [u2 投递所有权内核] 出站交接经内核适配层（dispatcher 只提交；交接异步）——fixture 按真实
  // 装配接内核（recordWorkspace 走 workspace.record，消息总线走同一 messageBus）
  const registry = createSessionDeliveryRegistry({
    getSession: (sid) => svc.getSession(sid),
    ensureActive: svc.ensureActive,
    subscribeAgentSettled: () => () => {},
    recordWorkspace: (cwd) => workspace.record(cwd),
    getMessageBus: () => messageBus as unknown as IMessageBus,
  })

  // wave:perf-w09（D1-2）：broker 双写路径已删，dispatcher 只依赖 publish 抽象（4 参构造）；
  // [MF-1-7] 注册表经 setDeliveryRegistry 后置注入（审计候选 12：构造期注入参已删）
  const dispatcher = new MessageDispatcher(svc, pm, workspace, messageBus as unknown as IMessageBus)
  dispatcher.setDeliveryRegistry(registry)
  return { dispatcher, session, promptFn, bashFn, abortFn, abortBashFn, compactFn, svc, pm, messageBus }
}

describe('message-dispatcher bus integration', () => {
  beforeEach(() => vi.clearAllMocks())

  // ── sendMessage paths ──

  it('sendMessage error path → bus.publish(message.error)', async () => {
    const { dispatcher, messageBus } = makeMocks_m3_m3_m3_m3({
      promptError: new Error('pi crashed'),
    })
    await dispatcher.sendMessage('s1', 'hello')
    await flushDelivery(30)
    expect(messageBus.publish).toHaveBeenCalledWith('s1', expect.objectContaining({ type: 'message.error' }))
    // occupancy 帧（u5a-p3）先于 message.error 入列，按 type 定位（原 calls[0] 断言失真同步）
    const errCall = messageBus.publish.mock.calls.map((c: any[]) => c[1]).find((m: ServerMessage) => m.type === 'message.error')
    expect(errCall).toBeDefined()
    expect(errCall!.payload.message).toContain('pi crashed')
  })

  it('sendMessage busy → 零 send.rejected（u2 退役：排队取代拒绝，改由内核按 steer 承接）', async () => {
    const { dispatcher, messageBus } = makeMocks_m3_m3_m3_m3({ isGenerating: true })
    await dispatcher.sendMessage('s1', 'hello')
    await flushDelivery(30)
    // 退役路径显式断言（原 send.rejected 广播）：bus 上不再出现拒绝帧
    const types = messageBus.publish.mock.calls.map((c: unknown[]) => (c[1] as ServerMessage).type)
    expect(types).not.toContain('send.rejected')
  })

  it('hook blocked → bus.publish(message.error)', async () => {
    const { dispatcher, messageBus } = makeMocks_m3_m3_m3_m3()
    dispatcher.setSendMessageHook(vi.fn().mockResolvedValue({ blocked: true, reason: 'blocked by hook' }))
    await dispatcher.sendMessage('s1', 'hello')
    expect(messageBus.publish).toHaveBeenCalledWith('s1', expect.objectContaining({
      type: 'message.error',
      payload: expect.objectContaining({ message: 'blocked by hook' }),
    }))
  })

  it('hook error → bus.publish(message.error)', async () => {
    const { dispatcher, messageBus } = makeMocks_m3_m3_m3_m3()
    dispatcher.setSendMessageHook(vi.fn().mockRejectedValue(new Error('hook exploded')))
    await dispatcher.sendMessage('s1', 'hello')
    expect(messageBus.publish).toHaveBeenCalledWith('s1', expect.objectContaining({
      type: 'message.error',
      payload: expect.objectContaining({ message: expect.stringContaining('hook exploded') }),
    }))
  })

  // ── abort paths ──

  it('abort failure → bus.publish(message.error)', async () => {
    const { dispatcher, messageBus, abortFn } = makeMocks_m3_m3_m3_m3()
    abortFn.mockRejectedValue(new Error('abort timeout'))
    await dispatcher.abort('s1')
    expect(messageBus.publish).toHaveBeenCalledWith('s1', expect.objectContaining({
      type: 'message.error',
      payload: expect.objectContaining({ message: expect.stringContaining('abort timeout') }),
    }))
  })

  it('abort success（型1: turn=generating 有回合可中止）→ bus.publish(message.complete{stopReason:aborted})', async () => {
    // [chat-flow-consistency abort 入口三分型] 成功路径收尾只在型 1（入口快照 turn ∈
    // {dispatching, generating}）发生：stopped 终态 + complete{aborted} 广播。
    // 旧用例在 idle 入口断言广播——三分型后 idle/settling 入口为型 3 no-op（见下一条）。
    const { dispatcher, messageBus, svc } = makeMocks_m3_m3_m3_m3({ isGenerating: true })
    await dispatcher.abort('s1')
    expect(svc.persistSessionOutcome).toHaveBeenCalledWith('s1', 'stopped', 'User aborted')
    expect(messageBus.publish).toHaveBeenCalledWith('s1', expect.objectContaining({
      type: 'message.complete',
      payload: expect.objectContaining({ sessionId: 's1', stopReason: 'aborted' }),
    }))
  })

  it('abort 已空闲（型3: turn=idle 无回合可中止）→ no-op：零 stopped 终态 + 零 message.complete', async () => {
    // 三分型：idle/settling 入口 pi 侧 abort 幂等 no-op——done 终态已写不覆盖（覆盖即谎报
    // 「回合被中止」）、无流式实体可收尾不广播 complete、occupancy 不动；队列对账照跑。
    const { dispatcher, svc, messageBus } = makeMocks_m3_m3_m3_m3()
    await dispatcher.abort('s1')
    expect(svc.persistSessionOutcome).not.toHaveBeenCalled()
    const types = messageBus.publish.mock.calls.map(([, m]) => (m as { type: string }).type)
    expect(types).not.toContain('message.complete')
    expect(types).not.toContain('message.error')
  })

  // ── [compaction-cancel] 压缩期中止（composer 发送位「终止压缩」钮，2026-10 用户裁决）──

  it('abort 压缩期（isCompacting ∧ ¬isGenerating）→ 压缩取消语义：零 stopped 终态 + 零 message.complete', async () => {
    // 用户中止的是压缩流程而非回合：会话仍存活且空闲，写 stopped 会在重启/重扫后误标 +
    // 骗出 restore 入口；无流式实体可收尾，message.complete{aborted} 帧语义谎报。
    const { dispatcher, svc, messageBus, abortFn } = makeMocks_m3_m3_m3_m3({ isCompacting: true })
    await dispatcher.abort('s1')
    expect(abortFn).toHaveBeenCalled() // pi 侧 abortCompaction 仍经 session.abort 执行
    expect(svc.persistSessionOutcome).not.toHaveBeenCalled()
    const types = messageBus.publish.mock.calls.map(([, m]) => (m as { type: string }).type)
    expect(types).not.toContain('message.complete')
    expect(types).not.toContain('message.error')
  })

  it('abort generating∧compacting（turn 在跑）→ 保持既有 turn abort 语义（stopped + message.complete）', async () => {
    // 阈值自动压缩与 turn 并存时点击停止 = 中止回合（pi compact 自身已 abort 过回合），
    // 终态与收尾帧必须照旧——压缩取消语义只覆盖「无 turn 在跑」形态。
    const { dispatcher, svc, messageBus } = makeMocks_m3_m3_m3_m3({ isGenerating: true, isCompacting: true })
    await dispatcher.abort('s1')
    expect(svc.persistSessionOutcome).toHaveBeenCalledWith('s1', 'stopped', 'User aborted')
    expect(messageBus.publish).toHaveBeenCalledWith('s1', expect.objectContaining({
      type: 'message.complete',
      payload: expect.objectContaining({ sessionId: 's1', stopReason: 'aborted' }),
    }))
  })

  it('abort source=convergence（型1: turn=generating）→ 终态 reason 写 Convergence abort (auto)', async () => {
    // [U2 + abort 三分型] 收敛环掐的是 runtime 自动收敛的补发 turn，终态 reason 不得谎报
    // 用户操作语义（'Convergence abort (auto)' ≠ 'User aborted'）。压缩取消语义仅限
    // source='user'——收敛环在压缩期（无回合可中止）落型 3 no-op，可观测行为与用户停止
    // 同型（零终态零广播），旧用例锁的「压缩期 convergence 写 stopped」已随三分型退役。
    const { dispatcher, svc } = makeMocks_m3_m3_m3_m3({ isGenerating: true })
    await dispatcher.abort('s1', 'convergence')
    expect(svc.persistSessionOutcome).toHaveBeenCalledWith('s1', 'stopped', 'Convergence abort (auto)')
  })

  // ── sendBash paths ──

  it('sendBash ensureActive fail → bus.publish(message.error) + 回执 rejected（未执行，不 throw）', async () => {
    const { dispatcher, messageBus, svc } = makeMocks_m3_m3_m3_m3()
    svc.ensureActive = vi.fn(async () => { throw new Error('restore failed') })
    // dmg-r1-2：restore 失败 = 未执行 → rejected 回执（不再 throw——throw 走 error envelope
    // 会丢执行状态，消费方只能保守丢草稿）
    const result = await dispatcher.sendBash('s1', 'ls')
    expect(result).toEqual({ status: 'rejected', error: 'Failed to restore session: restore failed' })
    expect(messageBus.publish).toHaveBeenCalledWith('s1', expect.objectContaining({ type: 'message.error' }))
  })

  it('sendBash busy → bus.publish(send.rejected)', async () => {
    const { dispatcher, messageBus } = makeMocks_m3_m3_m3_m3({ isBashRunning: true })
    const result = await dispatcher.sendBash('s1', 'ls')
    expect(result.status).toBe('rejected') // 未执行（busy 预检）
    expect(messageBus.publish).toHaveBeenCalledWith('s1', expect.objectContaining({ type: 'send.rejected' }))
  })

  it('sendBash start → bus.publish(message.bashStart)', async () => {
    const { dispatcher, messageBus, bashFn } = makeMocks_m3_m3_m3_m3()
    bashFn.mockResolvedValue({ output: 'file.txt', exitCode: 0, cancelled: false, truncated: false })
    await dispatcher.sendBash('s1', 'ls')
    // bashStart should be published
    const bashStartCall = messageBus.publish.mock.calls.find(
      (c: any[]) => c[1].type === 'message.bashStart',
    )
    expect(bashStartCall).toBeDefined()
    expect(bashStartCall![1].payload.command).toBe('ls')
  })

  it('sendBash success → bus.publish(message.bashResult)', async () => {
    const { dispatcher, messageBus, bashFn } = makeMocks_m3_m3_m3_m3()
    bashFn.mockResolvedValue({ output: 'file.txt', exitCode: 0, cancelled: false, truncated: false })
    await dispatcher.sendBash('s1', 'ls')
    const bashResultCall = messageBus.publish.mock.calls.find(
      (c: any[]) => c[1].type === 'message.bashResult',
    )
    expect(bashResultCall).toBeDefined()
    expect(bashResultCall![1].payload.output).toBe('file.txt')
    expect(bashResultCall![1].payload.exitCode).toBe(0)
  })

  it('sendBash error → bus.publish(message.bashResult + message.error)', async () => {
    const { dispatcher, messageBus, bashFn } = makeMocks_m3_m3_m3_m3()
    bashFn.mockRejectedValue(new Error('bash failed'))
    const result = await dispatcher.sendBash('s1', 'bad-cmd')
    expect(result.status).toBe('settled') // 已执行并收尾（失败终态已广播）
    expect(result.error).toContain('bash failed')
    // Should have both bashResult and message.error
    const types = messageBus.publish.mock.calls.map((c: any[]) => c[1].type)
    expect(types).toContain('message.bashResult')
    expect(types).toContain('message.error')
  })

  // ── abortBash path ──

  it('abortBash → bus.publish(message.bashAborted)（D4-3 兜底终态独立帧）', async () => {
    const session = makeMockSession_m3_m3_m3_m3({ bashRunToken: 'bash_123_abc', occupancy: { turn: 'idle', compacting: false, bash: true, handingOff: false } })
    const { dispatcher, messageBus } = makeMocks_m3_m3_m3_m3({ session })
    await dispatcher.abortBash('s1')
    const bashAbortedCall = messageBus.publish.mock.calls.find(
      (c: any[]) => c[1].type === 'message.bashAborted',
    )
    expect(bashAbortedCall).toBeDefined()
    expect(bashAbortedCall![1].payload).toMatchObject({ sessionId: 's1' })
  })

  // ── compact paths ──

  it('compact busy reject → 零 compaction 广播（M4：错误归 interpreter）', async () => {
    const { dispatcher, messageBus } = makeMocks_m3_m3_m3_m3({ isGenerating: true })
    await expect(dispatcher.compact('s1')).rejects.toThrow()
    // 零 compaction bus.publish（dispatcher 退化为预检+RPC+复位，生命周期由 interpreter 唯一编排）
    const compactionCalls = messageBus.publish.mock.calls.filter(
      (c: unknown[]) => ['session.compacting', 'session.compacted', 'message.compactionSummary'].includes((c[1] as ServerMessage).type),
    )
    expect(compactionCalls).toHaveLength(0)
  })

  it('compact start → 零 compaction 广播（compacting 由 interpreter 从 compaction_start 驱动）', async () => {
    const { dispatcher, messageBus, compactFn } = makeMocks_m3_m3_m3_m3()
    compactFn.mockResolvedValue({ summary: '', tokensBefore: 0, estimatedTokensAfter: 0 })
    await dispatcher.compact('s1')
    expect(compactFn).toHaveBeenCalled()
    const compactionCalls = messageBus.publish.mock.calls.filter(
      (c: unknown[]) => ['session.compacting', 'session.compacted', 'message.compactionSummary'].includes((c[1] as ServerMessage).type),
    )
    expect(compactionCalls).toHaveLength(0)
  })

  it('compact fail → 零 compaction 广播（失败提示归 interpreter 的 compaction_end{errorMessage}）', async () => {
    const { dispatcher, messageBus, compactFn } = makeMocks_m3_m3_m3_m3()
    compactFn.mockRejectedValue(new Error('compact exploded'))
    await expect(dispatcher.compact('s1')).rejects.toThrow('compact exploded')
    const compactionCalls = messageBus.publish.mock.calls.filter(
      (c: unknown[]) => ['session.compacting', 'session.compacted', 'message.compactionSummary'].includes((c[1] as ServerMessage).type),
    )
    expect(compactionCalls).toHaveLength(0)
  })

  it('compact summary → 零 compaction 广播（compactionSummary 由 interpreter 从 compaction_end 驱动）', async () => {
    const { dispatcher, messageBus, compactFn } = makeMocks_m3_m3_m3_m3()
    compactFn.mockResolvedValue({ summary: 'Did stuff', tokensBefore: 200, estimatedTokensAfter: 100 })
    await dispatcher.compact('s1')
    const compactionCalls = messageBus.publish.mock.calls.filter(
      (c: unknown[]) => ['session.compacting', 'session.compacted', 'message.compactionSummary'].includes((c[1] as ServerMessage).type),
    )
    expect(compactionCalls).toHaveLength(0)
  })

  it('compact success → 零 compaction 广播（compacted 由 interpreter 从 compaction_end 驱动）', async () => {
    const { dispatcher, messageBus, compactFn } = makeMocks_m3_m3_m3_m3()
    compactFn.mockResolvedValue({ summary: 'ok', tokensBefore: 100, estimatedTokensAfter: 50 })
    await dispatcher.compact('s1')
    expect(compactFn).toHaveBeenCalled()
    const compactionCalls = messageBus.publish.mock.calls.filter(
      (c: unknown[]) => ['session.compacting', 'session.compacted', 'message.compactionSummary'].includes((c[1] as ServerMessage).type),
    )
    expect(compactionCalls).toHaveLength(0)
  })

  it('[RT-4#10] compact 两连发：预检通过即置位（先于 RPC），第二发在事件回流前已被预检拦截', async () => {
    // 第一发 RPC 挂起（模拟压缩进行中、pi compaction_start 事件未回流的窗口——
    // 旧实现此窗口 isCompacting 恒 false，第二发预检照样通过 → 双 compaction 事件流）
    let releaseFirst!: (v: { summary: string; tokensBefore: number; estimatedTokensAfter: number }) => void
    const firstGate = new Promise<{ summary: string; tokensBefore: number; estimatedTokensAfter: number }>((resolve) => { releaseFirst = resolve })
    const { dispatcher, compactFn, session } = makeMocks_m3_m3_m3_m3()
    compactFn.mockImplementation(() => firstGate)

    const first = dispatcher.compact('s1')
    // async 函数体同步执行到第一个 await（client.compact）：置位（compacting-start）已落 session 视图
    expect(session.occupancy?.compacting).toBe(true)

    // 第二发：预检读 compacting=true → 拒绝（不发出第二个 RPC）
    const second = dispatcher.compact('s1')
    await expect(second).rejects.toThrow('Cannot compact while compaction already running')
    // 锁定 error envelope code 属性（产生点 = message-dispatcher compact 预检的
    // Object.assign(new Error(errMsg), { code: 'compact_busy' })）
    await expect(second).rejects.toMatchObject({ code: 'compact_busy' })
    expect(compactFn).toHaveBeenCalledTimes(1)

    // 第一发完成：finally 复位（compacting-end）
    releaseFirst({ summary: 'ok', tokensBefore: 100, estimatedTokensAfter: 50 })
    await first
    expect(session.occupancy?.compacting).toBe(false)
  })

  it('[RT-4#10] compact RPC 失败：finally 复位置位（transport 级失败不卡 compacting）', async () => {
    const { dispatcher, compactFn, session } = makeMocks_m3_m3_m3_m3()
    compactFn.mockRejectedValue(new Error('transport gone'))
    await expect(dispatcher.compact('s1')).rejects.toThrow('transport gone')
    expect(session.occupancy?.compacting).toBe(false)
  })

  // ── null safety ──

  it('messageBus undefined → no crash on sendMessage', async () => {
    const session = makeMockSession_m3_m3_m3_m3()
    const promptFn = vi.fn(async () => ({}) as unknown as Awaited<ReturnType<IPiEngine['prompt']>>)
    const client = { prompt: promptFn } as unknown as IPiEngine
    const svc: IDispatcherSessionOps = {
      ensureActive: vi.fn(async () => client),
      getSessionByClient: vi.fn(() => session),
      persistSessionOutcome: vi.fn(),
      clearSessionOutcome: vi.fn(),
      getSession: vi.fn(),
      removeSessionEntry: vi.fn(),
      detachSession: vi.fn(),
    }
    // getClient → undefined：无附着 client 形态（sendPrompt 入口 touch 的空检查分支）
    const pm = { getClient: vi.fn(() => undefined) } as unknown as IProcessManager
    const workspace = { record: vi.fn() } as unknown as WorkspaceService
    const dispatcher = new MessageDispatcher(svc, pm, workspace)
    // Should not throw
    const result = await dispatcher.sendMessage('s1', 'hello')
    expect(result.blocked).toBe(false)
  })

  it('messageBus undefined → no crash on abort', async () => {
    const session = makeMockSession_m3_m3_m3_m3()
    const client = { abort: vi.fn(async () => {}) } as unknown as IPiEngine
    const svc: IDispatcherSessionOps = {
      getSessionByClient: vi.fn(() => session),
      persistSessionOutcome: vi.fn(),
      clearSessionOutcome: vi.fn(),
      ensureActive: vi.fn(),
      getSession: vi.fn(),
      removeSessionEntry: vi.fn(),
      detachSession: vi.fn(),
    }
    const pm = { getClient: vi.fn(() => client) } as unknown as IProcessManager
    const workspace = { record: vi.fn() } as unknown as WorkspaceService
    const dispatcher = new MessageDispatcher(svc, pm, workspace)
    await dispatcher.abort('s1')
    // wave:perf-w09：messageBus 未注入时 abort 的 complete 终态静默丢失（旧 broadcast 路径已删），
    // 但不得 throw——组合根恒注入 bus，此处只锁 null-safety
  })

  it('messageBus undefined → no crash on compact（零广播，null-safety）', async () => {
    const session = makeMockSession_m3_m3_m3_m3()
    const compactFn = vi.fn(async () => ({ summary: 'done', tokensBefore: 100, estimatedTokensAfter: 50 }))
    const client = { compact: compactFn } as unknown as IPiEngine
    const messageBus = { publish: vi.fn() }
    const svc: IDispatcherSessionOps = {
      getSessionByClient: vi.fn(() => session),
      ensureActive: vi.fn(),
      persistSessionOutcome: vi.fn(),
      clearSessionOutcome: vi.fn(),
      getSession: vi.fn(),
      removeSessionEntry: vi.fn(),
      detachSession: vi.fn(),
    }
    const pm = { getClient: vi.fn(() => client) } as unknown as IProcessManager
    const workspace = { record: vi.fn() } as unknown as WorkspaceService
    const dispatcher = new MessageDispatcher(svc, pm, workspace, messageBus as unknown as IMessageBus)
    await dispatcher.compact('s1')
    // M4：零 compaction 发布（no crash + 无 compaction 消息）
    const compactionCalls = messageBus.publish.mock.calls.filter(
      (c: unknown[]) => ['session.compacting', 'session.compacted', 'message.compactionSummary'].includes((c[1] as ServerMessage).type),
    )
    expect(compactionCalls).toHaveLength(0)
  })

  // ── 单通道语义（wave:perf-w09 D1-2）──

  it('sendMessage error path → messageBus.publish 恰好 1 次（单通道，无双发）', async () => {
    const { dispatcher, messageBus } = makeMocks_m3_m3_m3_m3({
      promptError: new Error('test'),
    })
    await dispatcher.sendMessage('s1', 'hello')
    await flushDelivery(30)
    // occupancy 帧（u5a-p3：dispatching + catch 复位 idle）与 message.error 并存，
    // 本用例锁的是 message.error 单通道无双发——按 type 过滤后计数（原全量计数失真同步）。
    const errCalls = messageBus.publish.mock.calls.filter(
      (c: any[]) => c[1].type === 'message.error',
    )
    expect(errCalls).toHaveLength(1)
    expect(errCalls[0][1].type).toBe('message.error')
  })

  // ── sessionId passes through correctly ──

  it('bus.publish receives correct sessionId from sendMessage', async () => {
    const { dispatcher, messageBus } = makeMocks_m3_m3_m3_m3({
      promptError: new Error('test'),
    })
    await dispatcher.sendMessage('my-session-123', 'hello')
    await flushDelivery(30)
    expect(messageBus.publish).toHaveBeenCalledWith('my-session-123', expect.any(Object))
  })
})
})
});
// ======================================================================
// ← src/__tests__/pi-provider-store.test.ts
// ======================================================================

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('pi-provider-store', () => {
describe('clean-leaked-packages', () => {
// 测试用临时 settings.json 目录
let tmpDir_m2_m2_m2: string
let settingsPath: string

beforeEach(() => {
  tmpDir_m2_m2_m2 = mkdtempSync(join(tmpdir(), 'clean-leaked-'))
  settingsPath = join(tmpDir_m2_m2_m2, 'settings.json')
  setSettingsPath(settingsPath)
})

afterEach(() => {
  rmSync(tmpDir_m2_m2_m2, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

// 辅助：写 settings.json
function writeSettings(packages: string[] | undefined): void {
  writeFileSync(settingsPath, JSON.stringify({ packages }))
}

// 辅助：读 settings.json packages
function readSettingsPackages(): string[] | undefined {
  try {
    return (JSON.parse(readFileSync(settingsPath, 'utf-8'))).packages
  } catch {
    return undefined
  }
}

// 说明：isLeakedPackage 相对 getPiAgentDir()（<dataDir>/agent）解析。
// pi 全局目录 = getPiGlobalAgentDir() = resolve(getDataDir(), '..', '.pi', 'agent')
//（dataDir 的兄弟 .pi/agent），故需 ../../（向上 2 层到 dataDir 父目录，再下 .pi/agent）。
describe('isLeakedPackage', () => {
  it('TC1: 合法路径不误杀', () => {
    expect(isLeakedPackage('npm:@zhushanwen/pi-todo')).toBe(false)
    expect(isLeakedPackage('extensions/subagents-workflow')).toBe(false)
    expect(isLeakedPackage('./local-ext')).toBe(false)
  })

  it('TC2: 泄漏路径正确识别', () => {
    expect(isLeakedPackage('../../.pi/agent/extensions/universal/pending-notifications')).toBe(true)
    expect(isLeakedPackage('../../.pi/agent/extensions/universal/goal')).toBe(true)
  })

  it('TC3: 指向非 pi 全局的相对路径不误杀', () => {
    expect(isLeakedPackage('../../some-other-dir/ext')).toBe(false)
    expect(isLeakedPackage('../sibling-project/ext')).toBe(false)
  })
})

describe('cleanLeakedPackages', () => {
  it('TC4: 有泄漏时删除并返回 removed', () => {
    writeSettings(['npm:@a/b', '../../.pi/agent/extensions/x', 'extensions/y', '../../.pi/agent/extensions/z'])
    const result = cleanLeakedPackages()
    expect(result.removed).toEqual(['../../.pi/agent/extensions/x', '../../.pi/agent/extensions/z'])
    expect(readSettingsPackages()).toEqual(['npm:@a/b', 'extensions/y'])
  })

  it('TC5: 无泄漏时幂等不触发写', () => {
    writeSettings(['npm:@a/b', 'extensions/c'])
    const result = cleanLeakedPackages()
    expect(result.removed).toEqual([])
    expect(readSettingsPackages()).toEqual(['npm:@a/b', 'extensions/c'])
  })

  it('TC6: 空/undefined packages 无副作用', () => {
    writeSettings([])
    expect(cleanLeakedPackages().removed).toEqual([])
    writeSettings(undefined)
    expect(cleanLeakedPackages().removed).toEqual([])
  })
})
})
describe('sanitize-invalid-providers', () => {
let tmpDir_m2_m2_m2: string
let modelsPath: string

beforeEach(() => {
  tmpDir_m2_m2_m2 = mkdtempSync(join(tmpdir(), 'sanitize-providers-'))
  modelsPath = join(tmpDir_m2_m2_m2, 'models.json')
  setModelsPath(modelsPath)
})

afterEach(() => {
  rmSync(tmpDir_m2_m2_m2, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

function writeModelsFixture(providers: Record<string, unknown>): void {
  writeFileSync(modelsPath, JSON.stringify({ providers }))
}

function readModelsProviders(): Record<string, unknown> {
  return (JSON.parse(readFileSync(modelsPath, 'utf-8'))).providers
}

describe('isInvalidProvider', () => {
  // [W1b 语义变更] 判定对齐 pi 0.84.1 applyModelsJson 八字段抛错条件
  // （provider-composer.js:86-93）：models/baseUrl/headers/compat/modelOverrides/
  //  apiKey/oauth/authHeader 任一在场即合法，全空才算无效。

  it('W1b-T1 [W1b 语义变更]: 只配 apiKey 的 provider 合法（旧五字段判定误判无效 → 误删数据丢失 bug）', () => {
    // 旧判定（0.80.3 五字段）把 {apiKey, name} 判为空壳 → sanitize 物理删除
    expect(isInvalidProvider({ apiKey: 'sk-x', name: 'Verify A' })).toBe(false)
  })

  it('W1b-T2 [W1b 语义变更]: 只配 oauth 的 provider 合法（pi 端字段，宽松键检查不遗漏）', () => {
    // oauth 是 pi 端 provider 级字段（zod Type.Literal("radius")），taiji
    // PiProviderConfig 未声明。模拟脏数据：Object.assign 绕过 excess property check
    const provider: PiProviderConfig = { name: 'Radius' }
    Object.assign(provider, { oauth: 'radius' })
    expect(isInvalidProvider(provider)).toBe(false)
  })

  it('W1b-T3 [W1b 语义变更]: 只配 authHeader 的 provider 合法（显式 false 也算在场）', () => {
    // pi 检查 `config.authHeader === undefined`（非 falsiness）——false 是"在场"即不触发
    // must specify 抛错。同构用 === undefined，禁改 falsiness。
    expect(isInvalidProvider({ authHeader: true, name: 'X' })).toBe(false)
    expect(isInvalidProvider({ authHeader: false, name: 'X' })).toBe(false)
  })

  it('W1b-T4: 八字段全缺的真空壳判定无效', () => {
    // concurrency-verify-A 场景：外部脚本写入的 fixture 空壳（无任何八字段）
    expect(isInvalidProvider({ name: 'Verify A' })).toBe(true)
    expect(isInvalidProvider({})).toBe(true)
  })

  it('W1b-T5: apiKey 空串视同未 specify（pi falsiness 同构），八字段全缺判定无效', () => {
    expect(isInvalidProvider({ apiKey: '', name: 'X' })).toBe(true)
  })

  it('WTC2: 有 baseUrl 的 provider 合法', () => {
    expect(isInvalidProvider({ baseUrl: 'https://api.x.com', apiKey: 'sk' })).toBe(false)
  })

  it('WTC3: models 非空的 provider 合法', () => {
    expect(isInvalidProvider({ models: [{ id: 'm1', name: 'M1' }] })).toBe(false)
  })

  it('WTC4: models 空数组视为未 specify，判定无效', () => {
    // 空数组无法提供任何模型，与 undefined 等效（pi `!config.models?.length`）
    expect(isInvalidProvider({ models: [] })).toBe(true)
  })

  it('WTC5: 有 headers 的 provider 合法（cookie provider 不误杀）', () => {
    expect(isInvalidProvider({ headers: { Cookie: 'session=x' } })).toBe(false)
  })

  it('WTC6: 有 modelOverrides 的 provider 合法', () => {
    expect(isInvalidProvider({ modelOverrides: { 'gpt-4': { contextWindow: 8192 } } })).toBe(false)
  })

  it('WTC7: 有 compat（pi 端脏数据 raw 键）的 provider 合法', () => {
    // compat 是 pi 端 provider 级字段，taiji PiProviderConfig 未声明但运行时脏数据可能含。
    // 模拟脏数据：构造合法对象后注入未声明字段（Object.assign 绕过 excess property check，无类型断言）
    const provider: PiProviderConfig = { apiKey: 'sk' }
    Object.assign(provider, { compat: { foo: 1 } })
    expect(isInvalidProvider(provider)).toBe(false)
  })

  it('WTC13 [W1b 语义变更]: baseUrl 空串 + apiKey 在场 → 合法（apiKey 满足八字字段任一）', () => {
    // 旧判定：baseUrl 空串（falsiness）+ 五字段全缺 → 无效。0.84.1：apiKey 在场即不触发
    // must specify 抛错（baseUrl 空串被 zod minLength:1 拒绝是 schema 层，不归 sanitize 管）
    expect(isInvalidProvider({ baseUrl: '', apiKey: 'sk' })).toBe(false)
  })

  it('WTC14: modelOverrides 空对象判定无效（pi applyModelsJson 要求 Object.keys().length>0）', () => {
    expect(isInvalidProvider({ modelOverrides: {} })).toBe(true)
  })

  it('WTC15: provider 值为 null 判定无效（zod ProviderConfigSchema 拒绝非对象值）', () => {
    expect(isInvalidProvider(null as unknown as PiProviderConfig)).toBe(true)
  })
})

describe('sanitizeInvalidProviders', () => {
  it('W1b-V2 [W1b 语义变更]: 只配 apiKey / oauth / authHeader 的合法 provider 全部完好，真空壳被清', () => {
    // W1b 主验收（V2「provider 零丢失」）：真实文件系统 round-trip。旧五字段判定会把
    // key-only 判为空壳物理删除（数据丢失）；oauth / authHeader-only 同理是 0.84.1 新合法态。
    writeModelsFixture({
      'key-only': { apiKey: 'sk-key-only', name: 'Key Only' },
      'oauth-only': { name: 'OAuth Only', oauth: 'radius' },
      'authheader-only': { name: 'AuthHeader Only', authHeader: true },
      'empty-shell': { name: 'Shell' },
    })
    const result = sanitizeInvalidProviders()
    expect(result.removed).toEqual(['empty-shell'])
    expect(result.repaired).toEqual([])
    const remaining = readModelsProviders()
    expect(Object.keys(remaining).sort())
      .toEqual(['authheader-only', 'key-only', 'oauth-only'])
    // 三个合法条目逐字段原样保留（未被触碰/重写丢失字段）
    expect(remaining['key-only']).toEqual({ apiKey: 'sk-key-only', name: 'Key Only' })
    expect(remaining['oauth-only']).toEqual({ name: 'OAuth Only', oauth: 'radius' })
    expect(remaining['authheader-only']).toEqual({ name: 'AuthHeader Only', authHeader: true })
  })

  it('WTC8: 剔除空壳 provider，保留合法 provider', () => {
    // [W1b 语义变更] 空壳 fixture 从 {apiKey, name} 改为无 apiKey 纯空壳（旧形态已合法）
    writeModelsFixture({
      legal1: { baseUrl: 'x' },
      legal2: { models: [{ id: 'm1' }] },
      'concurrency-verify-A': { name: 'Verify A' },
    })
    const result = sanitizeInvalidProviders()
    expect(result.removed).toEqual(['concurrency-verify-A'])
    const remaining = readModelsProviders()
    expect(Object.keys(remaining).sort()).toEqual(['legal1', 'legal2'])
  })

  it('WTC9: 无无效 provider 时幂等不触发写（mtime 不变 + 内容不变）', () => {
    writeModelsFixture({
      legal1: { baseUrl: 'x' },
      legal2: { models: [{ id: 'm' }] },
    })
    const mtimeBefore = statSync(modelsPath).mtimeMs
    const result = sanitizeInvalidProviders()
    expect(result.removed).toEqual([])
    // 主断言：mtime 不变（未触发写）。内容断言作为 mtime 精度不足（旧 HFS+ 1s）的兜底。
    expect(statSync(modelsPath).mtimeMs).toBe(mtimeBefore)
    expect(readModelsProviders()).toEqual({
      legal1: { baseUrl: 'x' },
      legal2: { models: [{ id: 'm' }] },
    })
  })

  it('WTC10: models.json 不存在时不创建文件', () => {
    // tmp 目录空，不写 models.json
    expect(existsSync(modelsPath)).toBe(false)
    const result = sanitizeInvalidProviders()
    expect(result.removed).toEqual([])
    expect(existsSync(modelsPath)).toBe(false)
  })

  it('WTC11: 全部无效时全部剔除，文件保留为空 providers 对象', () => {
    // [W1b 语义变更] bad1 旧为 {apiKey:'sk'}（现合法），改为八字段全缺纯空壳
    writeModelsFixture({
      bad1: { name: 'B1' },
      bad2: { name: 'X' },
    })
    const result = sanitizeInvalidProviders()
    expect(result.removed.sort()).toEqual(['bad1', 'bad2'])
    // providers 空对象，文件仍存在（非删除）
    expect(readModelsProviders()).toEqual({})
    expect(existsSync(modelsPath)).toBe(true)
  })

  it('WTC12: 连续调用幂等（第二次 removed 为空，缓存未污染）', () => {
    // [W1b 语义变更] bad 旧为 {apiKey:'sk'}（现合法），改为纯空壳
    writeModelsFixture({
      bad: { name: 'bad' },
      legal: { baseUrl: 'x' },
    })
    const first = sanitizeInvalidProviders()
    expect(first.removed).toEqual(['bad'])
    const second = sanitizeInvalidProviders()
    expect(second.removed).toEqual([])
    // 第二次后文件状态与第一次后一致
    expect(Object.keys(readModelsProviders()).sort()).toEqual(['legal'])
  })

  it('WTC16: 脏数据含 null provider 不崩溃，null 被剔除且合法 provider 保留', () => {
    // M2 回归：provider 值为 null 时旧实现整个 sanitize 崩溃 → 外层 catch 吞掉 → {removed:[]}
    // 同文件后续合法空壳 provider 不被剔除，"Model not found" 复发。
    // [W1b 语义变更] 空壳 fixture 从 {apiKey, name} 改为无 apiKey 纯空壳
    writeModelsFixture({
      'p-null': null,
      'concurrency-verify-A': { name: 'Verify A' },
      legal1: { baseUrl: 'x' },
    })
    const result = sanitizeInvalidProviders()
    expect(result.removed.sort()).toEqual(['concurrency-verify-A', 'p-null'])
    expect(readModelsProviders()).toEqual({ legal1: { baseUrl: 'x' } })
  })

  it('WTC17a [W1b 语义变更]: 只配 apiKey 的 catalog provider（opencode）原样保留，不修复不删除', () => {
    // W1b 主验收核心：QuickSetup 保存的 {apiKey, name, authMethod} 条目（无 baseUrl/models）
    // 直接合法——0.84.1 八字段判定 apiKey 在场即不触发 must specify 抛错。
    // 旧五字段判定把它判为空壳（MF-5 时代走 catalog 修复救回），更早版本直接删除。
    const fixture = { apiKey: 'sk-opencode', name: 'OpenCode Zen', authMethod: 'api_key' }
    writeModelsFixture({ opencode: fixture })
    const result = sanitizeInvalidProviders()
    expect(result.removed).toEqual([])
    expect(result.repaired).toEqual([])
    // 逐字段原样保留（未被 catalog models 合并改写，apiKey 未丢）
    expect(readModelsProviders()).toEqual({ opencode: fixture })
  })

  it('WTC17b (MF-5 回归，[W1b 语义变更]): 无 apiKey 的 catalog 空壳被修复而非删除（models 合并，authMethod 保留）', () => {
    // 修复路径现仅覆盖八字段全缺（连 apiKey 都无）的 catalog 空壳——含 apiKey 条目已直接
    // 合法（见 WTC17a），不再进此路径。
    writeModelsFixture({
      opencode: { name: 'OpenCode Zen', authMethod: 'api_key' },
      'concurrency-verify-A': { name: 'Verify A' },
    })
    const result = sanitizeInvalidProviders()
    // 非 catalog 空壳仍删除，catalog 已知空壳修复
    expect(result.removed).toEqual(['concurrency-verify-A'])
    expect(result.repaired).toEqual(['opencode'])
    const remaining = readModelsProviders()
    expect(Object.keys(remaining).sort()).toEqual(['opencode'])
    const repaired = remaining.opencode as Record<string, unknown>
    // authMethod 保留（不丢用户字段）
    expect(repaired.authMethod).toBe('api_key')
    // models 从 catalog 合并（模型级 baseUrl 由 catalog 提供）
    expect(Array.isArray(repaired.models)).toBe(true)
    const models = repaired.models as Array<{ id: string; baseUrl?: string }>
    expect(models.length).toBeGreaterThan(0)
    expect(models[0].id).toBe('claude-fable-5')
    expect(models[0].baseUrl).toBe('https://opencode.ai/zen')
    // 修复后不再无效（pi 0.84.1 组合层可通过）
    expect(isInvalidProvider(repaired as PiProviderConfig)).toBe(false)
    // 幂等：第二次调用不再修复/删除（修复结果已是合法条目）
    const second = sanitizeInvalidProviders()
    expect(second.removed).toEqual([])
    expect(second.repaired).toEqual([])
  })

  it('WTC18 (MF-6 回归，[W1b 语义变更]): catalog models 全空 baseUrl 的 provider（azure-openai-responses）维持删除而非修复', () => {
    // MF-6 回归：azure-openai-responses 的 38 个 catalog models 全为空串 baseUrl 且无
    // provider 级 baseUrl——合并后 pi modelFromJson 对每个自定义模型强制非空 baseUrl
    // （空串非 nullish）直接 throw，pi 回退 builtin base，apiKey 静默失效，
    // 且毒化条目 isInvalidProvider===false 无自愈路径。此类 provider 排除出修复名单（删除）。
    // [W1b 语义变更] fixture 去掉 apiKey（含 apiKey 条目已直接合法，见 WTC17a）。
    writeModelsFixture({
      'azure-openai-responses': { name: 'Azure OpenAI', authMethod: 'api_key' },
      opencode: { name: 'OpenCode Zen', authMethod: 'api_key' },
    })
    const result = sanitizeInvalidProviders()
    // azure 删除（catalog 无可用 baseUrl 数据），opencode 仍修复（模型级 baseUrl 齐全）
    expect(result.removed).toEqual(['azure-openai-responses'])
    expect(result.repaired).toEqual(['opencode'])
    const remaining = readModelsProviders()
    expect(Object.keys(remaining).sort()).toEqual(['opencode'])
    // 修复条目不存在任何空 baseUrl 模型（pi 组合层不抛错）
    const models = (remaining.opencode as { models: Array<{ baseUrl?: string }> }).models
    expect(models.length).toBeGreaterThan(0)
    expect(models.every(m => !!m.baseUrl)).toBe(true)
    // 幂等：第二次调用不再修复/删除
    const second = sanitizeInvalidProviders()
    expect(second.removed).toEqual([])
    expect(second.repaired).toEqual([])
  })
})

describe('U6③ 存量自愈：id 缺失/non-string 模型项（写侧同口径）', () => {
  it('id 缺失（undefined）的模型项被清洗剔除，provider 其余模型保留（pi 可加载）', () => {
    writeModelsFixture({
      keep: {
        baseUrl: 'https://api.example.com',
        models: [{ id: 'good-1' }, { name: 'no-id-model' }],
      },
    })
    sanitizeInvalidProviders()
    // outcome 形状 = { removed, repaired, staleGatewayMarkers }（无 changed 字段）；
    // 变更效果以盘上内容为准（U6③ 的判别位：id 缺失项被剔除）
    const models = (readModelsProviders().keep as { models: Array<Record<string, unknown>> }).models
    expect(models.map((m) => m.id)).toEqual(['good-1'])
  })

  it('可强转 id（number）被就地写回字符串形式（不丢条目，与写侧同口径）', () => {
    writeModelsFixture({
      keep: {
        baseUrl: 'https://api.example.com',
        models: [{ id: 456 }],
      },
    })
    sanitizeInvalidProviders()
    const models = (readModelsProviders().keep as { models: Array<Record<string, unknown>> }).models
    expect(models).toEqual([{ id: '456' }])
  })
})
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('project-store', () => {
describe('ProjectStore', () => {
  let dir: string
  let store: ProjectStore
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'projects-'))
    store = new ProjectStore(dir)
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('save → load 往返：projects + activeProjectId 都持久化', () => {
    const state: ProjectStoreState = {
      projects: [mkProject('proj-a', 'Alpha'), mkProject('proj-default', '', 0)],
      activeProjectId: 'proj-a',
    }
    store.save(state)
    store.flushAll()

    const reloaded = new ProjectStore(dir)
    const loaded = reloaded.load()
    expect(loaded.projects.map((p) => p.id)).toEqual(['proj-a', 'proj-default'])
    expect(loaded.projects[0]!.name).toBe('Alpha')
    expect(loaded.activeProjectId).toBe('proj-a')
  })

  it('文件内容为 ProjectStoreState 结构（{ projects, activeProjectId }）', () => {
    const state: ProjectStoreState = {
      projects: [mkProject('proj-a', 'Alpha')],
      activeProjectId: 'proj-a',
    }
    store.save(state)
    store.flushAll()

    const raw = JSON.parse(readFileSync(join(dir, 'projects.json'), 'utf-8'))
    expect(Array.isArray(raw.projects)).toBe(true)
    expect(raw.activeProjectId).toBe('proj-a')
    expect(raw.projects[0].id).toBe('proj-a')
  })

  it('全量替换语义：save 后删除的 project 从文件消失', () => {
    store.save({ projects: [mkProject('a', 'A'), mkProject('b', 'B')], activeProjectId: 'a' })
    store.flushAll()
    // 第二次 save 只保留 a（b 被删）
    store.save({ projects: [mkProject('a', 'A')], activeProjectId: 'a' })
    store.flushAll()

    const raw = JSON.parse(readFileSync(join(dir, 'projects.json'), 'utf-8'))
    expect(raw.projects.map((p: Project) => p.id)).toEqual(['a'])
  })

  it('首启无文件 → 空态（不抛）', () => {
    const loaded = store.load()
    expect(loaded.projects).toEqual([])
    expect(loaded.activeProjectId).toBe('')
  })

  it('文件损坏 → 空态不抛（INV-1）', () => {
    writeFileSync(join(dir, 'projects.json'), '{broken json', 'utf-8')
    const loaded = store.load()
    expect(loaded.projects).toEqual([])
  })

  it('非法结构（非 ProjectStoreState）→ 空态不抛', () => {
    writeFileSync(join(dir, 'projects.json'), JSON.stringify([{ id: 'a' }]), 'utf-8')
    const loaded = store.load()
    expect(loaded.projects).toEqual([])
  })

  it('load 触发 WriteBackCache 懒加载（save 后新实例能读到已落盘数据）', () => {
    store.save({ projects: [mkProject('p1', 'One')], activeProjectId: 'p1' })
    store.flushAll()
    const s2 = new ProjectStore(dir)
    const loaded = s2.load()
    expect(loaded.projects).toHaveLength(1)
    expect(loaded.projects[0]!.name).toBe('One')
  })

  it('existsSync 确认文件确实落盘', () => {
    store.save({ projects: [mkProject('p1', 'One')], activeProjectId: 'p1' })
    store.flushAll()
    expect(existsSync(join(dir, 'projects.json'))).toBe(true)
  })
})
});
});

// ======================================================================
// ← process-manager-bundle.test.ts
// ======================================================================

// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← src/__tests__/process-manager-ephemeral.test.ts
// ======================================================================

// rpc-client 模块 mock：FakeRpcClient 记录 start/kill/exit 注册，switchSession/setSessionName 为 vi.fn
const rpcMock = vi.hoisted(() => {
  const instances: Array<{
    started: boolean
    killed: boolean
    options: Record<string, unknown>
    switchSession: ReturnType<typeof vi.fn>
    setSessionName: ReturnType<typeof vi.fn>
  }> = []
  /**
   * 真实 logger 的 createPiSessionLog 挂点（族③用例经它驱动真实 tee 建树；logger 未
   * 初始化时生产实现自带 no-op，其余用例零副作用）。经对象间接引用而非工厂内静态
   * import——mock 工厂先于模块顶层语句求值，直接 import 会形成求值环。
   */
  const tee: { create: ((sessionId: string) => { write: (line: string) => void; end: () => void }) | null } = {
    create: null,
  }
  class FakeRpcClient {
    started = false
    killed = false
    exitCb: ((code: number | null, stderr: string) => void) | null = null
    constructor(public options: Record<string, unknown>) {
      instances.push(this)
    }
    async start(): Promise<void> {
      this.started = true
      // 复现真实 RpcClient.start 的 tee 接线（rpc-client.ts:344-345）：spawn 后为
      // 本 session 建 tee 树——族③用例的残留树由此产出（生产路径，非测试摆盘）
      tee.create?.(String(this.options.sessionId))
    }
    onExit(cb: (code: number | null, stderr: string) => void): void { this.exitCb = cb }
    async kill(): Promise<void> { this.killed = true }
    get exited(): boolean { return this.killed }
    switchSession = vi.fn(async (_p: string): Promise<void> => {})
    setSessionName = vi.fn(async (_n: string): Promise<unknown> => ({ success: true }))
  }
  return { FakeRpcClient, instances, tee }
})


vi.mock('../infra/pi/rpc-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../infra/pi/rpc-client.js')>()
  return { ...actual, RpcClient: rpcMock.FakeRpcClient }
})


// 真实 logger（本文件不 mock）：tee 建树与 ephemeral 树回收的同模块闭环
const SESSION_FILE = '/data/data/agent/sessions/abc/scan-target.jsonl'


// ======================================================================
// ← src/__tests__/engine-roots.test.ts
// ======================================================================

let tmpRoot: string


let savedEnv: Record<string, string | undefined>

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('process-manager-bundle', () => {
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('process-manager-ephemeral', () => {
describe('ProcessManager.withEphemeralPi（W11 短命 pi 附着）', () => {
  let pm: ProcessManager

  beforeEach(() => {
    // R3 隔离：打包版太极 agent 会话内执行时 TAIJI_AGENT_PACKAGED 泄入测试进程，
    // ProcessManager/依赖链内 isPackaged() 判真改道 findPackagedPi throw（P1 同款机制）。
    // 本测试 hermetic 前提是非打包态，显式压平。
    vi.stubEnv('TAIJI_AGENT_PACKAGED', '')
    rpcMock.instances.length = 0
    // tee 挂点指向真实 logger（族③用例经它建真实残留树；未初始化时 no-op）
    rpcMock.tee.create = createPiSessionLog
    // projectRoot 指向 tmpdir：dev 模式 resources/pi 不存在 → PATH fallback（RpcClient 已
    // mock，路径解析只影响日志，不真 spawn）
    pm = new ProcessManager(tmpdir())
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    vi.useRealTimers()
    rpcMock.tee.create = null
    await closeLogger().catch(() => {})
  })

  it('成功：switchSession 附着目标文件 → fn 收到 client → 返回值透传 → 进程销毁', async () => {
    const result = await pm.withEphemeralPi(SESSION_FILE, async (c) => {
      await c.setSessionName('新名')
      return 42
    })

    expect(result).toBe(42)
    // 附着原语 = switchSession(sessionFile)（非 --session CLI flag，rpc-client 参数侧未扩）
    const client = rpcMock.instances[0]
    expect(client).toBeDefined()
    expect(client.switchSession).toHaveBeenCalledTimes(1)
    expect(client.switchSession).toHaveBeenCalledWith(SESSION_FILE)
    expect(client.setSessionName).toHaveBeenCalledWith('新名')
    // 用后即毁：进程被 kill，且不残留在 process map
    expect(client.killed).toBe(true)
    expect(pm.size).toBe(0)
  })

  it('附着失败（switchSession reject，如文件不存在 pi 报错）→ rethrow + 进程销毁', async () => {
    const origCreate = pm.createSession.bind(pm)
    vi.spyOn(pm, 'createSession').mockImplementation(async (id, cwd, opts) => {
      const c = await origCreate(id, cwd, opts)
      ;(c as unknown as { switchSession: ReturnType<typeof vi.fn> }).switchSession
        = vi.fn(async () => { throw new Error('switch_session failed: file not found') })
      return c
    })

    await expect(pm.withEphemeralPi(SESSION_FILE, async () => 'unreachable'))
      .rejects.toThrow('switch_session failed')

    // fn 未执行（rejects 已证不可达）；进程仍被销毁
    expect(rpcMock.instances[0].killed).toBe(true)
    expect(pm.size).toBe(0)
  })

  it('fn 抛错 → rethrow + 进程销毁（失败路径不泄漏）', async () => {
    await expect(pm.withEphemeralPi(SESSION_FILE, async () => {
      throw new Error('RPC command "set_session_name" failed')
    })).rejects.toThrow('set_session_name')

    expect(rpcMock.instances[0].killed).toBe(true)
    expect(pm.size).toBe(0)
  })

  it('spawn 失败（createSession 抛错）→ rethrow，无进程残留', async () => {
    vi.spyOn(pm, 'createSession').mockRejectedValueOnce(new Error('Failed to start pi process'))
    await expect(pm.withEphemeralPi(SESSION_FILE, async () => 'unreachable'))
      .rejects.toThrow('Failed to start pi process')
    expect(pm.size).toBe(0)
  })

  it('族③（W3.5）：finally 在 destroySession 之后回收 ephemeral tee 树（非空残留形态）', async () => {
    // 真实 logger：tee 建树（createPiSessionLog）与树回收（removeEphemeralSessionTree）
    // 同模块闭环；残留树由 FakeRpcClient.start 驱动的生产 tee 路径产出（开工前实证①
    // 同款形态：<root>/<ephemeralId>/logs/pi-<date>.jsonl 非空树）。
    const dataDir = mkdtempSync(join(tmpdir(), 'pm-ephemeral-tree-'))
    initLogger(dataDir)
    try {
      let treeExistedWhenFnRan = false
      const result = await pm.withEphemeralPi(SESSION_FILE, async () => {
        // fn 在 finally 之前：此刻 tee 树已由生产 createPiSessionLog 建好
        const id = String(rpcMock.instances[0].options.sessionId)
        treeExistedWhenFnRan = existsSync(join(dataDir, 'ext-sessions', id, 'logs'))
        return 'ok'
      })
      expect(result).toBe('ok')

      // 非虚测前提：残留树确曾存在（非空树——「只删空目录」的清理会漏掉它）
      expect(treeExistedWhenFnRan).toBe(true)
      const ephemeralId = String(rpcMock.instances[0].options.sessionId)
      expect(ephemeralId.startsWith('ephemeral-')).toBe(true)
      // finally 回收：ephemeral 树不复存在，树根无 ephemeral-* 残留
      expect(existsSync(join(dataDir, 'ext-sessions', ephemeralId))).toBe(false)
      expect(readdirSync(join(dataDir, 'ext-sessions'))).toEqual([])
    } finally {
      await closeLogger()
    }
  })
})
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('engine-roots', () => {
beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'engine-roots-test-'))
  savedEnv = {
    TAIJI_AGENT_PACKAGED: process.env.TAIJI_AGENT_PACKAGED,
    [ENGINE_ROOTS_ENV]: process.env[ENGINE_ROOTS_ENV],
  }
  delete process.env.TAIJI_AGENT_PACKAGED
  delete process.env[ENGINE_ROOTS_ENV]
})
afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})
describe('getStagedEnginesDir（dev/打包双形态）', () => {
  it('dev：projectRoot/resources/engines 存在 → 返回绝对路径', () => {
    const staged = join(tmpRoot, 'resources', 'engines')
    mkdirSync(staged, { recursive: true })
    expect(getStagedEnginesDir(tmpRoot)).toBe(staged)
  })

  it('dev：目录不存在 → undefined（不注入，发现回落 L2/L3）', () => {
    expect(getStagedEnginesDir(tmpRoot)).toBeUndefined()
  })

  it('打包：<cwd>/engines 推导与 projectRoot 无关（不真实创建 cwd 目录——fs-guard 纪律）', () => {
    process.env.TAIJI_AGENT_PACKAGED = '1'
    // cwd = packages/runtime（vitest 运行处），不含 engines → undefined；
    // 关键断言：打包态不再回退 dev 形态路径（projectRoot/resources/engines 恒不返回）
    expect(getStagedEnginesDir(tmpRoot)).not.toBe(join(tmpRoot, 'resources', 'engines'))
  })
})
describe('getEngineRootsSpawnEnv（注入点矩阵）', () => {
  it('dev：staged 存在 → 只注入 ROOTS，不注入执行器两键', () => {
    const staged = join(tmpRoot, 'resources', 'engines')
    mkdirSync(staged, { recursive: true })
    expect(getEngineRootsSpawnEnv(tmpRoot)).toEqual({ [ENGINE_ROOTS_ENV]: staged })
  })

  it('dev：staged 不存在 → 空对象', () => {
    expect(getEngineRootsSpawnEnv(tmpRoot)).toEqual({})
  })

  it('打包：执行器两键恒注入（TAIJI_AGENT_ENGINE_NODE=process.execPath + RUN_AS_NODE），ROOTS 仅在 staged 存在时', () => {
    process.env.TAIJI_AGENT_PACKAGED = '1'
    // staged（<cwd>/engines）不存在：ROOTS 缺席、执行器两键仍在
    const env = getEngineRootsSpawnEnv(tmpRoot)
    expect(env[ENGINE_ROOTS_ENV]).toBeUndefined()
    expect(env[ENGINE_NODE_ENV]).toBe(process.execPath)
    expect(env.ELECTRON_RUN_AS_NODE).toBe('1')
  })
})
describe('ensureRuntimeEngineRootsEnv（幂等补齐）', () => {
  it('staged 存在 + env 未设 → 写入并返回 true；二次调用幂等 false', () => {
    const staged = join(tmpRoot, 'resources', 'engines')
    mkdirSync(staged, { recursive: true })
    writeFileSync(join(staged, '.keep'), '')
    expect(ensureRuntimeEngineRootsEnv(tmpRoot)).toBe(true)
    expect(process.env[ENGINE_ROOTS_ENV]).toBe(staged)
    expect(ensureRuntimeEngineRootsEnv(tmpRoot)).toBe(false)
  })

  it('已有显式值 → 不覆盖（返回 false）', () => {
    const staged = join(tmpRoot, 'resources', 'engines')
    mkdirSync(staged, { recursive: true })
    process.env[ENGINE_ROOTS_ENV] = '/explicit/user/value'
    expect(ensureRuntimeEngineRootsEnv(tmpRoot)).toBe(false)
    expect(process.env[ENGINE_ROOTS_ENV]).toBe('/explicit/user/value')
  })

  it('staged 不存在 → 不写 env', () => {
    expect(ensureRuntimeEngineRootsEnv(tmpRoot)).toBe(false)
    expect(process.env[ENGINE_ROOTS_ENV]).toBeUndefined()
  })
})
});
});
