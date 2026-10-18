import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { getAgentDir, SessionManager } from '@earendil-works/pi-coding-agent'
import { StringEnum } from '@earendil-works/pi-ai'
import { Type } from 'typebox'
import { setPiHandle } from '@zhushanwen/pi-extension-logger'
import type { SessionMetadataProvider } from './discovery/find.js'
import { handleSessionRead, type SessionReadParams, type SessionReadSignals } from './tool-handler.js'
import { createHashAutocompleteProvider } from './tui/hash-provider.js'
import { createSessionCommand } from './tui/session-command.js'

/**
 * pi-session-reader extension 入口（M3 工具适配层）。
 *
 * 分层（同 scheduler）：
 * - tool-handler.ts：纯逻辑 handler，agentDir 注入，零 pi 依赖，可单测
 * - index.ts（本文件）：pi 依赖层，registerTool + getAgentDir() 调用 + execute 闭包
 *   （错误直接 throw 给 pi——pi-agent-core agent-loop 对 execute throw 置 isError:true，
 *   锚点 agent-loop.js:581-588；1.0.0 起返回值 isError:true 同样被尊重（:579），
 *   本工具恒走 throw 路径两版语义等价，pi 自带 bash 工具同范式）
 */

// ---- TypeBox 参数 schema（design §3.4 14 字段）----

const SessionReadSchema = Type.Object({
  action: StringEnum(
    [
      'find',
      'family',
      'outline',
      'expand',
      'detail',
      'search',
      'export',
      'extract',
      'workflow',
      'result',
      'doctor',
    ],
    {
      // tool-declaration-slimming D1 终态：action 功能语义唯一承载点（工具 description 只留
      // 一句定位 + 边界；guidelines 只留纪律）。
      description:
        'find (locate session), family (relations; recursive=tree), outline (turn overview), expand (one turn), detail (full text), search (grep, cross-session, ≤10 ids), export (to file), extract (messages/commands/files/commits/tool results), workflow (run overview), result (subagent final text, batch ≤10), doctor (environment diagnostics).',
    },
  ),
  session: Type.Optional(
    Type.String({
      description:
        'Session id, uuid fragment (e6c96), subagent id (sa-xxx), or .jsonl path. Required by every action except find/doctor; result/search accept ≤10 comma-separated ids. # prefix auto-stripped.',
    }),
  ),
  query: Type.Optional(
    Type.String({
      description: 'find: uuid fragment / filename / name keyword / "recent" (recent N).',
    }),
  ),
  turns: Type.Optional(
    Type.String({
      description: 'detail/extract: turn range "T013-T015" or "T013".',
    }),
  ),
  turn: Type.Optional(
    Type.String({ description: 'expand: turn "T013".' }),
  ),
  pattern: Type.Optional(
    Type.String({ description: 'search: substring or regex.' }),
  ),
  scope: Type.Optional(
    StringEnum(['all', 'user', 'assistant', 'toolResult'], {
      description: 'search: filter scope. Default all.',
    }),
  ),
  format: Type.Optional(
    StringEnum(['outline', 'full', 'family'], {
      description: 'export: materialized form. Default outline.',
    }),
  ),
  includeToolResult: Type.Optional(
    Type.Boolean({
      description: 'detail/export: include toolResult text. Default false.',
    }),
  ),
  includeThinking: Type.Optional(
    Type.Boolean({
      description: 'detail: include thinking blocks. Default false.',
    }),
  ),
  allBranches: Type.Optional(
    Type.Boolean({
      description: 'outline/export: include abandoned side-branches. Default false.',
    }),
  ),
  granularity: Type.Optional(
    StringEnum(['turn', 'entry'], {
      description: 'outline: turn-level or entry-flat. Default turn.',
    }),
  ),
  cwd: Type.Optional(
    Type.String({ description: 'find: filter by cwd.' }),
  ),
  source: Type.Optional(
    StringEnum(['main', 'subagent'], {
      description: '"main" = sessions/, "subagent" = subagents/. Default both.',
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      // minimum:1 在 schema 校验层拒绝 limit:0 等退化输入（不落入 find F1 的
      // 「无匹配 session」措辞面）；result 消费侧的 resolveResultLimit 防御保留
      //（可单测绕过 schema 的调用形态）。
      minimum: 1,
      description: 'find/search: max results (default 20). result: max chars per item (default 8000, truncated with pointer).',
    }),
  ),
  what: Type.Optional(
    StringEnum(
      ['user-messages', 'commands', 'files', 'commits', 'tool-results'],
      {
        description: 'extract: what to pull (required).',
      },
    ),
  ),
  tool: Type.Optional(
    Type.String({
      description: 'extract: filter by tool name (e.g. "bash").',
    }),
  ),
  runId: Type.Optional(
    Type.String({
      description: 'workflow: focus one run (omit = all).',
    }),
  ),
  recursive: Type.Optional(
    Type.Boolean({
      description: 'family: nested execution tree. Default false (flat).',
    }),
  ),
  includeSubagents: Type.Optional(
    Type.Boolean({
      description: 'doctor: also scan the subagent session root. Default false.',
    }),
  ),
})

// ---- guidelines（注入 LLM，design §3.4）----

const guidelines = [
  // tool-declaration-slimming D1 终态：纪律单点——action 逐个复述条已删（功能语义在
  // schema action 枚举说明一处）；跨工具规则不在本工具重复（收敛点 = 注入段）。
  // 锚词保留清单：Progressive reading / Never read raw .jsonl / sa- ids route /
  // 👉 recovery hint / doctor——机器锚定唯一落点 = zcode-routing.test.ts 的锚词
  // 保留清单 describe（逐词 toContain）；doctor 另被该文件 SCHEMA_SNAPSHOT 的
  // action 枚举间接锚定。tool-prompt 契约不锚本工具 guidelines（其 A8 是 subagent
  // 工具内指向本工具的交叉引用，非本清单的锚）。
  'Progressive reading: outline (~1500 tokens) → expand (one turn) → detail; defaults omit toolResult/thinking noise.',
  'find first (uuid fragment / name); TUI #references are full uuids. Never read raw .jsonl—use this tool.',
  // zcode 路由（U9）对 LLM 的唯一可见部分：sa-id 输入自动路由，无需任何参数；首遇
  // zcode_* 错误码前先有背景预告。
  'sa- ids route transparently to pi or zcode engine sessions; sess_ prefixed ids are not accepted—use the completion-notice sa- id.',
  'Errors carry a 👉 recovery hint—follow it to retry.',
  'Unsure about host environment or session roots? Run action:"doctor".',
]

// ---- 工具 description（tool-declaration-slimming D1 终态：一句定位 + 阅读纪律指针 + 边界；
// action 一览与参数功能语义唯一承载点 = SessionReadSchema 的 action 枚举说明）----

const description = `Read pi session files (conversation history) by semantic structure, not raw bytes. Progressive reading: outline → expand → detail. Do NOT use for the current session (the host provides it) or to edit sessions (pi has /resume /fork).`

/**
 * 已注册过 TUI provider/command 的 pi 实例集合。
 *
 * **为什么用 WeakSet<ExtensionAPI> 而非模块级布尔**：resume 会重新加载 extension 并
 * 再次调用 factory（新 session = 新 pi/runner 实例）。模块级布尔跨 factory 持久，会误杀
 * resume 的新 session（跳过 addAutocompleteProvider → 新 editor 没挂 # provider → # 不弹）。
 * WeakSet 按 pi 实例去重：同一 pi 内多次 session_start 不重复注册（防 provider 堆叠），
 * 但 resume 的新 pi 实例能正常注册。
 */
const registeredPis = new WeakSet<ExtensionAPI>()
/**
 * 当前 session 的目录。每次 session_start（含 resume/fork/new）动态更新，provider/command
 * 通过 getter 读取。
 */
let currentCwdSessionDir: string | null = null

export default function sessionReaderExtension(pi: ExtensionAPI): void {
  // zcode 读链的结构化日志走「事后排查」通道（appendEntry，不进 LLM 上下文不显 TUI）：
  // 最早期注入 pi handle——tool-handler 的 getLogger('session-reader') 由此生效（U9）。
  setPiHandle(pi)
  // u11（design 2026-09-10 §6.6）：标题元数据走 pi 的 SessionManager.listAll(dir)——
  // session_info name 提取、首消息采集与并发解析由 pi 维护。注入范式同 §6.2 信号包：
  // pi 类型只在本层出现（SessionInfo 对发现层 SessionMetadataEntry 结构兼容，直接透传），
  // 发现层只见注入函数，零 pi 依赖。调用成本由三条调用策略约束（惰性/窄化/缓存，
  // 缓存在 tool-handler 注入边界包装），listAll 实装语义「扫一层平铺目录 + 每文件
  // 全量解析」决定了不得对含子目录根调用（hash-provider.ts:158 空参灾难同源教训）。
  const metadataProvider: SessionMetadataProvider = async (dir) => SessionManager.listAll(dir)
  pi.registerTool({
    name: 'session_read',
    label: 'Session Reader',
    // deferred（tool-declaration-slimming D4）：不常驻声明，tool_search 命中即激活；
    // 迁移写入的 +tool_search 条目（runtime pi-codemode-settings）承载检索入口
    exposure: 'deferred',
    description,
    parameters: SessionReadSchema,
    promptGuidelines: guidelines,
    async execute(
      _toolCallId: string,
      params: SessionReadParams,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext | undefined,
    ) {
      // 错误路径直接 throw：pi 契约 throw 置 isError:true（tool_execution_end /
      // ToolResultMessage；1.0.0 起返回值 isError:true 也被尊重，本工具恒走 throw），
      // handler 抛的 Error 文案（含 👉 恢复提示）原样成为 toolResult content，模型仍可读到。
      // signal 仅 search 消费（MF-5：长扫描可中断，Esc 不再挂死）；其余 action 有界不接
      // 信号包采集（design §7B）：可选链逐层降级——ctx===undefined（存量单测五参形态）、
      // sessionManager 缺字段、getSessionDir 方法缺失，任一层不成立即 liveSessionDir=undefined
      //（发现层走 [default]+[legacy]+[subagent] 三根降级）；方法调用抛错可选链兜不住，try/catch
      // 同样降级——宿主异常不得变成工具内部 TypeError。env/bundleUrl 由 u8 补采（doctor
      // 环境判定/发行形态需要，design §6.2/§6.4）。
      let liveSessionDir: string | undefined
      try {
        liveSessionDir = ctx?.sessionManager?.getSessionDir?.()
      } catch {
        liveSessionDir = undefined
      }
      const signals: SessionReadSignals = {
        agentDir: getAgentDir(),
        liveSessionDir,
        env: process.env,
        bundleUrl: import.meta.url,
      }
      // u11：标题元数据 provider 随信号包注入（provider 抛错由发现层单目录降级，
      // 不会变成工具错误——宿主 listAll 异常不得打断 find 的「能找到 session」底线）。
      return handleSessionRead(params, signals, signal, metadataProvider)
    },
  })

  // ── M4 TUI 层（design §1 + §3.3 D-3/D-4 + 附录 P-hash-trigger）──────────
  // # 引用补全 provider + /session-pick 命令（命令名避开 pi 内置 /session 冲突）。仅 ctx.mode === 'tui' 注册：RPC 模式
  // （taiji 子进程）不用 pi TUI editor / slash 命令，加载即跳过。
  //
  // addAutocompleteProvider 挂在 ctx.ui（非 ExtensionAPI），setup 入口无 ctx，
  // 只能在 event handler 里拿——session_start 是最早且每 session 触发的 event。
	// once-guard + ctx.mode 检查 + typeof 运行时检查三重防护。
  //
  // 2026-08-10 重构：数据源从全盘 findSessions(agentDir) 换为 SessionManager.listAll(ctx.sessionManager.getSessionDir())。
  // getSessionDir() 返回当前 session 的目录（encoded cwd），listAll 只扫该目录 →
  // 当前 cwd 化（G1）+ 白送 name/count/firstMessage（G3）+ 19ms vs 1500ms（G5）。
  pi.on('session_start', (_event, ctx) => {
    if (ctx.mode !== 'tui') return
    // 每次 session_start（resume/fork/new 都触发）更新当前 session 目录；
    // provider/command 通过 getter 动态读取，避免首个 session 闭包固定 → resume 后查错目录
    currentCwdSessionDir = ctx.sessionManager.getSessionDir()
    // 按 pi 实例去重：同一 pi 内不重复注册（防 provider 堆叠），resume 新 pi 实例可注册
    if (registeredPis.has(pi)) return
    if (typeof ctx.ui.addAutocompleteProvider !== 'function') return
    registeredPis.add(pi)
    const getCwdSessionDir = (): string => currentCwdSessionDir ?? ''
    pi.registerCommand('session-pick', createSessionCommand(getCwdSessionDir))
    ctx.ui.addAutocompleteProvider((current) =>
      createHashAutocompleteProvider(getCwdSessionDir, current),
    )
  })
}
