/**
 * PiMcpServers — IMcpServers port 的 infra 实现（pi-mcp-management 装配波 u2b）。
 *
 * 组合两个既有 infra 原语，自身只做协议投影与信封编排，不新增第二条读写路径：
 *   - pi-mcp-store（u1）：mcp.json 唯一读写层（D2 跨进程磁盘锁 + 锁内 RMW + D4 校验
 *     复刻 + D7 编辑写回契约）。装配本类后 taiji 内不存在第二写入口（设计 D2）——
 *     全部写操作（add/update/remove）都落在 store 的锁内 RMW 单点上。
 *   - pi-mcp-probe（u4）：连接测试通道（D3 spawn `pi mcp list --json`）。本类承担
 *     D3 墙钟公式（probe 注释定死的装配层职责）：timeoutMs = max(默认 150 秒,
 *     2 × 条目显式 timeout 最大值 + 30 秒余量)。
 *
 * WS entry → store 输入映射（ADR-0065 登记语义的实现落点）：
 *   - add：恒走 store code 路径（条目包装成 { [name]: entry } 单键形态）——ADR 登记
 *     verbatim（校验通过原样写入，不重组）；显式 type 在此路径进闭集校验（D4 例外
 *     条款生效，§4 断言② streamable-http 旧称放行由此保证）；重名/归并拦截在 store
 *     锁内对最新注册表执行（D4 不采用替换语义）。
 *   - update：按 entry 是否携带表单外键（type/timeout/toolExposure/auth/oauth 任一）
 *     分叉两种写死语义——
 *     ① 携带外键 = 代码模式解析产物（编辑弹层代码 tab / 表单 → 代码序列化，文件投影
 *     含外键）：走 code 路径整体作为条目值（外键与显式 type 以 entry 为准，不合并
 *     不剥离）。包装单键形态键名恒等于被编辑条目名，store 编辑态名称锁定校验恒通过；
 *     不包装的裸形态会踩 store 的病态重合歧义（单键 record 条目被误读为包装形态 →
 *     rename 误拦）。
 *     ② 无外键 = 表单模式产物（u3 formToEntry 只填表单映射键）：走 form 路径（D7
 *     编辑写回契约——底外键原样保留、type 无条件剥离、切换传输类型键级清理、清空
 *     即删键），ADR 登记 transformable（请求 entry ≠ 落盘终态）。
 *     两语义的判别边界：代码模式粘贴「无任何外键的裸条目」与表单产物在 WS 单一
 *     entry 形状下结构性不可区分，按 form 语义处理（底外键保留）——误保留可见可修
 *     （清单/代码模式可再编辑），误删除（丢 oauth 登录参数）静默不可恢复，宁保留。
 *   - setEnabled（u3 清单行启停专用，§3.1「写入 enabled 字段」最小语义）：不经 update——
 *     清单投影为底的条目值回写会把「清单打开至切换之间」的外部并发改动静默覆盖（丢失
 *     窗口从 D2 的锁内亚秒级放大到 UI 会话级），且混填条目会被 form 路径规范化改写；
 *     专用操作直落 store setMcpServerEnabled（锁内仅翻转 enabled 键）。
 *
 * 错误信封（S6/D4，协议定死错误数据在 reply 信封内不走 error envelope）：
 *   - store 校验/拦截类 McpStoreError → { ok:false, error }（error = store 的
 *     「错误 → 原因 → 修复动作」文案原样，corruption 缺省）；
 *   - store_corrupted（锁内损坏拒入）→ { ok:false, error, corruption }——corruption
 *     的 corruptCopyPath 恒 null：mcp store 是 fail-fast 拒入不落盘（S6 不覆盖外部
 *     手编内容），无隔离副本形态（与 settings.json 的读时隔离副本不同，codemode 域
 *     的副本提示字段在此无对应物）。
 *
 * 🔒 三层架构：本模块属 infra，services 经 port 访问（type import，无 value 依赖）；
 * transport handler 不直接触碰本类与 store/probe。
 */

import type {
  McpListResult,
  McpMutationResult,
  McpServerEntry,
  McpServerEntryValue,
  McpServerStatusBadge,
  McpTestHandle,
  McpTestResultEvent,
} from '@taiji/shared'
import type { IMcpServers } from '../../services/ports/mcp-servers.js'
import {
  DEFAULT_PROBE_TIMEOUT_MS,
  runMcpProbe,
  type McpProbeOptions,
  type McpProbeResult,
} from './pi-mcp-probe.js'
import { getPiAgentDir } from './pi-paths.js'
import {
  McpStoreError,
  addMcpServer,
  readMcpServers,
  removeMcpServer,
  setMcpServerEnabled,
  updateMcpServer,
  type McpFormFields,
  type McpSaveInput,
  type McpServerEntryView,
} from './pi-mcp-store.js'

/** D3 墙钟公式余量（设计写死：2 × 最大显式 timeout + 30 秒）。 */
const PROBE_TIMEOUT_MARGIN_MS = 30_000
/** D3 单条目最坏耗时倍数：initialize 与 tools/list 两个各计超时的请求段（≈ 2 × timeout）。 */
const PROBE_WORST_CASE_TIMEOUT_MULTIPLIER = 2
/** timeout 字段单位换算（pi 逐请求超时以秒计，墙钟以毫秒计）。 */
const SECONDS_TO_MS = 1000

/** 损坏拒入信封的错误文案（与 store store_corrupted 文案同构，写侧指引一致）。 */
function corruptedEnvelopeError(reason: string, filePath: string): string {
  return `mcp.json 无法解析（${reason}）：请先修复文件后再操作，以免覆盖手工修改的内容（文件路径：${filePath}）`
}

/**
 * 表单外键判别（D7 外键清单：type/timeout/toolExposure/auth/oauth——表单序列化不产
 * 这些键，携带即代码模式解析产物或含外键的文件投影回写）。
 */
const FORM_FOREIGN_KEYS = ['type', 'timeout', 'toolExposure', 'auth', 'oauth'] as const

function carriesForeignKey(entry: McpServerEntryValue): boolean {
  return FORM_FOREIGN_KEYS.some((key) => entry[key] !== undefined)
}

/** WS entry → store 表单字段集（传输类型由 command/url 有无表达，D7 映射表）。 */
function entryToFormFields(entry: McpServerEntryValue): McpFormFields {
  return {
    transport: entry.url !== undefined ? 'http' : 'stdio',
    command: entry.command,
    args: entry.args,
    env: entry.env,
    cwd: entry.cwd,
    url: entry.url,
    headers: entry.headers,
    description: entry.description,
    exposure: entry.exposure,
    enabled: entry.enabled,
  }
}

/** update 的 store 输入（外键判别分叉，语义见模块头「WS entry → store 输入映射」）。 */
function toStoreUpdateInput(name: string, entry: McpServerEntryValue): McpSaveInput {
  if (carriesForeignKey(entry)) {
    return { mode: 'code', parsed: { [name]: entry } }
  }
  return { mode: 'form', fields: entryToFormFields(entry) }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 文件原样值 → 协议条目值投影。非对象坏条目（读侧已标「配置必须是对象」）无法以
 * 对象类型承载，投影空对象——清单以 configError 标注为准（D8③，坏条目不阻塞其余
 * 条目管理）；对象条目照原样投影（外键/坏值原样，清单以文件为准，ADR-0075）。
 */
function asEntryValue(config: unknown): McpServerEntryValue {
  return isRecord(config) ? (config as McpServerEntryValue) : {}
}

/** store 条目视图 → WS 协议条目投影（读侧错误标注映射 configError，合法条目缺省）。 */
function toProtocolEntry(view: McpServerEntryView): McpServerEntry {
  return {
    name: view.name,
    value: asEntryValue(view.config),
    ...(view.error !== null ? { configError: view.error } : {}),
  }
}

/** 条目显式 timeout 秒数（坏值/缺失 = 0，不参与墙钟放大——pi 加载期是值域权威）。 */
function readTimeoutSeconds(config: unknown): number {
  if (!isRecord(config)) return 0
  const t = config.timeout
  return typeof t === 'number' && Number.isFinite(t) && t > 0 ? t : 0
}

/**
 * D3 墙钟（probe 注释定死的装配层职责）：max(默认 150 秒, 2 × 最大显式 timeout +
 * 30 秒余量)。显式大 timeout 是合法慢服务器配置（逐请求超时，单条目最坏 ≈ 2×timeout
 * ——initialize 与 tools/list 两个各计超时的请求段），上限随其放大而非误杀；文件损坏
 * / 不存在时快照空 = 默认下限。
 */
function computeProbeTimeoutMs(): number {
  const snapshot = readMcpServers()
  let maxTimeoutSec = 0
  for (const view of snapshot.servers) {
    const t = readTimeoutSeconds(view.config)
    if (t > maxTimeoutSec) maxTimeoutSec = t
  }
  return Math.max(
    DEFAULT_PROBE_TIMEOUT_MS,
    maxTimeoutSec * PROBE_WORST_CASE_TIMEOUT_MULTIPLIER * SECONDS_TO_MS + PROBE_TIMEOUT_MARGIN_MS,
  )
}

/** probe 运行函数缝（缺省真实 runMcpProbe；u2b 单测注入 fake 防真进程 spawn）。 */
export type McpProbeRunner = (options: McpProbeOptions) => Promise<McpProbeResult>

/** 仅本文件装配参数（constructor 注入，无外部消费——type alias 形态）。 */
export type PiMcpServersOptions = {
  /** findPiExecutable 入参（组合根传 effectiveRoot，同 ProcessManager 锚点）；缺省 cwd。 */
  projectRoot?: string
  /** probe 运行函数注入（测试缝；缺省 runMcpProbe）。 */
  probeRunner?: McpProbeRunner
  /**
   * probe 终态回调（u5b 打回接线）：`mcp.test` 异步任务的完成侧通道——executeProbe 完成
   * （含整体降级形态）后以此回调向 transport 层交付 `mcp:testResult` 广播素材。本类不依赖
   * transport（infra 无向上依赖），广播帧的组装与发送归组合根（index.ts 经 server 暴露的
   * broadcastServerMessage 接线）；缺省无回调 = 行为退回「仅日志留痕」（存量测试装配零感知）。
   */
  onTestResult?: (event: McpTestResultEvent) => void
}

export class PiMcpServers implements IMcpServers {
  private readonly probeRunner: McpProbeRunner
  private testSeq = 0
  /** 进行中的连接测试（testId → 取消函数；D3「取消」按钮按 testId 杀 probe 子进程）。 */
  private readonly activeProbes = new Map<string, () => boolean>()

  constructor(private readonly options: PiMcpServersOptions = {}) {
    this.probeRunner = options.probeRunner ?? runMcpProbe
  }

  list(): McpListResult {
    const snapshot = readMcpServers()
    return {
      servers: snapshot.servers.map((view) => toProtocolEntry(view)),
      // mcp store 是 fail-fast 拒入不落盘（S6），无隔离副本形态 → corruptCopyPath 恒 null
      corruption: snapshot.corrupted
        ? { filePath: snapshot.filePath, corruptCopyPath: null }
        : null,
      // I3 登录引导数据源：needs-auth 条目的可复制登录命令 PI_CODING_AGENT_DIR 值
      agentDir: getPiAgentDir(),
    }
  }

  add(name: string, entry: McpServerEntryValue): McpMutationResult {
    return this.mutationEnvelope(name, () => {
      // ADR-0065 verbatim（D4）：原样写入——包装单键形态走 store code 路径（不重组条目）
      addMcpServer({ mode: 'code', parsed: { [name]: entry } })
    })
  }

  update(name: string, entry: McpServerEntryValue): McpMutationResult {
    return this.mutationEnvelope(name, () => {
      updateMcpServer(name, toStoreUpdateInput(name, entry))
    })
  }

  setEnabled(name: string, enabled: boolean): McpMutationResult {
    // §3.1「写入 enabled 字段」最小语义：专用操作直落 store（锁内仅翻转 enabled 键，
    // 不带清单投影回写），reply entry = 写后落盘终态（mutationEnvelope 回读）。
    return this.mutationEnvelope(name, () => {
      setMcpServerEnabled(name, enabled)
    })
  }

  remove(name: string): McpMutationResult {
    // 删除前值回显（port 契约「entry = 被删条目的删除前落盘值」）+ 损坏拒入：先读快照，
    // 损坏直接信封拒入（不触发写路径）；读与删两步之间外部并发改条目的窄窗口下回显值
    // 可能略旧（删除动作本身在 store 锁内原子），登记接受。
    const before = readMcpServers()
    if (before.corrupted) {
      return {
        ok: false,
        error: corruptedEnvelopeError(before.corruptedReason ?? '未知原因', before.filePath),
        corruption: { filePath: before.filePath, corruptCopyPath: null },
      }
    }
    const deletedView = before.servers.find((view) => view.name === name)
    if (!removeMcpServer(name)) {
      return { ok: false, error: `服务器 "${name}" 不存在：可能已被删除，请刷新清单后重试` }
    }
    // 回读兜底（理论不可达：刚从快照确认存在且删除成功）；外部并发删除窗口下 value 空投影
    return { ok: true, entry: deletedView ? toProtocolEntry(deletedView) : { name, value: {} } }
  }

  test(name: string): McpTestHandle {
    // D3/前提 A4 异步任务形态：立即回句柄，真实连接测试后台执行（秒级以上，不占
    // request/reply 往返）。probe 终态经 onTestResult 回调交付组合根（→ mcp:testResult
    // 广播帧 → renderer McpSection.applyProbeResult 回填 D8① 徽标）；未注入回调时退回
    // 仅日志留痕（连接测试是辅助功能，失败/无出口不阻塞清单读写主流程）。
    const testId = `mcp-test-${++this.testSeq}`
    void this.executeProbe(name, testId)
    return { testId }
  }

  testCancel(testId: string): boolean {
    // D3「取消」按钮（等价于超时到点杀进程的主动形态）：按 testId 杀 probe 子进程。
    // 返回 false = 无进行中任务（fake runner 未触发 onStarted / 已收敛 / testId 不存在）
    // 或进程已自行退出——两种形态结果徽标都照常经 mcp:testResult 广播回填。
    const cancel = this.activeProbes.get(testId)
    if (cancel === undefined) return false
    return cancel()
  }

  private async executeProbe(name: string, testId: string): Promise<void> {
    let badge: McpServerStatusBadge | null = null
    try {
      const result = await this.probeRunner({
        timeoutMs: computeProbeTimeoutMs(),
        ...(this.options.projectRoot !== undefined ? { projectRoot: this.options.projectRoot } : {}),
        // onStarted 在 probeRunner 内部同步触发（spawn 成功即调）：test() 返回句柄前
        // 取消函数已登记（真 runner 形态；fake runner 未触发则 testCancel 恒 false）
        onStarted: (cancel) => {
          this.activeProbes.set(testId, cancel)
        },
      })
      if (result.kind === 'cancelled') {
        // D3 主动取消：本次无任何结果（与超时同源语义），不回填徽标——renderer 侧已在
        // testCancel reply cancelled:true 分支恢复取消前徽标，广播补发会覆盖它。
        console.log(`[pi-mcp-servers] probe ${testId}（${name}）已取消（D3 主动取消，无本次结果）`)
        return
      }
      if (result.kind === 'ok') {
        const failed = result.servers.filter((s) => s.status.kind === 'failed').length
        console.log(
          `[pi-mcp-servers] probe ${testId}（${name}）完成: exit=${result.exitCode} servers=${result.servers.length} failed=${failed} configErrors=${result.configErrors.length}`,
        )
        badge = this.probeResultBadge(name, result)
      } else {
        console.warn(`[pi-mcp-servers] probe ${testId}（${name}）降级: kind=${result.kind}`)
        badge = this.degradedProbeBadge(result)
      }
    } catch (error) {
      // runMcpProbe 契约不抛（全部降级为结果态）；此 catch 为纵深防御，留痕不打断主流程
      console.warn(`[pi-mcp-servers] probe ${testId}（${name}）异常（辅助功能降级）:`, error)
      badge = {
        source: 'probe',
        state: 'failed',
        errorDetail: error instanceof Error ? error.message : String(error),
        testedAt: Date.now(),
      }
    } finally {
      this.activeProbes.delete(testId)
    }
    if (badge) this.options.onTestResult?.({ name, testId, badge })
  }

  /**
   * probe 全量结果 → 触发条目的 D8① 徽标投影（D8「pi 实测」来源；CLI 全量测试中投影
   * 触发条目的报告，其余条目徽标由后续各自的测试触发交付）。条目名按 CLI 原名精确匹配
   *（CLI 输出的 name = mcp.json 条目键原值，无归并改写）；未命中（触发行不在结果内，
   * 如测试期间被外部删除）回退 ui-local timeout 徽标——「本次无该条目结果」，renderer
   * 按 D3 语义保留上次成功结果。
   */
  private probeResultBadge(name: string, result: Extract<McpProbeResult, { kind: 'ok' }>): McpServerStatusBadge {
    const report = result.servers.find((s) => s.name === name)
    if (!report) return { source: 'ui-local', state: 'timeout' }
    const status = report.status
    if (status.kind === 'connected') {
      return { source: 'probe', state: 'connected', toolCount: status.toolsCount, testedAt: Date.now() }
    }
    if (status.kind === 'needs-auth') return { source: 'probe', state: 'needs-auth', testedAt: Date.now() }
    if (status.kind === 'disabled') return { source: 'probe', state: 'disabled', testedAt: Date.now() }
    return {
      source: 'probe',
      state: status.state,
      ...(status.errorDetail !== undefined ? { errorDetail: status.errorDetail } : {}),
      testedAt: Date.now(),
    }
  }

  /**
   * probe 整体降级 → 徽标投影：timeout = ui-local timeout（D3「整体无本次结果」，renderer
   * 保留上次成功结果展示）；spawn-failed / invalid-output / 异常 = failed 徽标携带降级原因
   *（用户点测试连接的最小可见反馈——「为什么连测试本身都没跑成」，详情入口展开全文）。
   * cancelled 不进此函数（executeProbe 已提前返回，不回填徽标）。
   */
  private degradedProbeBadge(result: Exclude<McpProbeResult, { kind: 'ok' | 'cancelled' }>): McpServerStatusBadge {
    if (result.kind === 'timeout') return { source: 'ui-local', state: 'timeout' }
    const detail =
      result.kind === 'spawn-failed'
        ? result.message
        : result.kind === 'invalid-output'
          ? `pi mcp list 输出非法（${result.rawExcerpt}）`
          : '未知降级形态'
    return { source: 'probe', state: 'failed', errorDetail: detail, testedAt: Date.now() }
  }

  /**
   * 写操作统一信封编排（ADR-0065 三条 reply 形状的实现落点）：store 校验/拦截类
   * McpStoreError → ok:false 信封（error 原样透传，损坏类附 corruption）；成功 →
   * 写后落盘终态回读（renderer 以服务端终态校准清单）。
   */
  private mutationEnvelope(name: string, write: () => void): McpMutationResult {
    try {
      write()
    } catch (error) {
      if (error instanceof McpStoreError) return this.storeErrorEnvelope(error)
      throw error
    }
    const after = readMcpServers()
    const written = after.servers.find((view) => view.name === name)
    // 回读兜底（理论不可达：写成功后条目必在）；外部并发删除的窄窗口下 value 空投影
    return { ok: true, entry: written ? toProtocolEntry(written) : { name, value: {} } }
  }

  private storeErrorEnvelope(error: McpStoreError): McpMutationResult {
    if (error.code === 'store_corrupted') {
      // 锁内损坏拒入（S6）：文件路径从读路径取（store 的 activePath，测试重定向同源），
      // 保证 corruption.filePath 与用户实际修复入口一致
      const { filePath, corruptedReason } = readMcpServers()
      return {
        ok: false,
        error: corruptedEnvelopeError(corruptedReason ?? '未知原因', filePath),
        corruption: { filePath, corruptCopyPath: null },
      }
    }
    return { ok: false, error: error.message }
  }
}
