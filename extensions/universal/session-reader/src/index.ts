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
 * 分层（同 scheduler/cw-tool）：
 * - tool-handler.ts：纯逻辑 handler，agentDir 注入，零 pi 依赖，可单测
 * - index.ts（本文件）：pi 依赖层，registerTool + getAgentDir() 调用 + execute 闭包
 *   （错误直接 throw 给 pi——pi-agent-core agent-loop 只对 execute throw 置
 *   isError:true，返回值里的 isError 字段被丢弃；W4 修复，锚点
 *   agent-loop.js:453-483/525-547，pi 自带 bash 工具同范式）
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
      description:
        'Action to perform: find (locate session), family (fork/subagent/workflow relations; recursive=true returns nested execution tree), outline (turn-level overview), expand (single-turn entries), detail (full text of turns), search (full-text grep, single session or cross-session over a comma-separated id list), export (materialize to file), extract (pull user messages / commands / files / commits / tool results by type), workflow (workflow run overview: status/budget/steps; requires session, optional runId focuses one run; step call sessionId jumps to outline/detail), result (fetch a subagent session final result text — same content as its completion notice; session = single id or comma-separated batch of at most 10, optional limit caps chars per item), doctor (show detected host environment and session-root diagnostics).',
    },
  ),
  session: Type.Optional(
    Type.String({
      description:
        'Session id, uuid fragment (e.g. e6c96), subagent record id (sa-xxx, precise lookup), or absolute .jsonl path (~ or ~/ allowed). Required for family/outline/expand/detail/search/export/extract/workflow/result. result also accepts a comma-separated list of up to 10 ids. search also accepts a comma-separated list of up to 10 full ids (from find output) for cross-session search. # prefix auto-stripped.',
    }),
  ),
  query: Type.Optional(
    Type.String({
      description:
        'find action: uuid fragment / filename / name keyword / "recent" (returns most recent N).',
    }),
  ),
  turns: Type.Optional(
    Type.String({
      description: 'detail/extract action: turn range, "T013-T015" or "T013".',
    }),
  ),
  turn: Type.Optional(
    Type.String({ description: 'expand action: single turn, "T013".' }),
  ),
  pattern: Type.Optional(
    Type.String({ description: 'search action: substring or regex.' }),
  ),
  scope: Type.Optional(
    StringEnum(['all', 'user', 'assistant', 'toolResult'], {
      description: 'search action: scope filter. Default all.',
    }),
  ),
  format: Type.Optional(
    StringEnum(['outline', 'full', 'family'], {
      description: 'export action: materialized form. Default outline.',
    }),
  ),
  includeToolResult: Type.Optional(
    Type.Boolean({
      description: 'detail/export: include toolResult full text. Default false (omitted as noise).',
    }),
  ),
  includeThinking: Type.Optional(
    Type.Boolean({
      description: 'detail: include thinking blocks. Default false (omitted as noise).',
    }),
  ),
  allBranches: Type.Optional(
    Type.Boolean({
      description:
        "outline (and export's outline section): include abandoned side-branches. Not supported by family. Default false.",
    }),
  ),
  granularity: Type.Optional(
    StringEnum(['turn', 'entry'], {
      description: 'outline: turn-level or entry-flat. Default turn.',
    }),
  ),
  cwd: Type.Optional(
    Type.String({ description: 'find: filter by cwd. Optional.' }),
  ),
  source: Type.Optional(
    StringEnum(['main', 'subagent'], {
      description:
        'find and session-resolving actions: filter by source. "main" = sessions/, "subagent" = subagents/. Default both (merged).',
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      // minimum:1 在 schema 校验层拒绝 limit:0 等退化输入（不落入 find F1 的
      // 「无匹配 session」措辞面）；result 消费侧的 resolveResultLimit 防御保留
      //（可单测绕过 schema 的调用形态）。
      minimum: 1,
      description:
        'find/search: max results. Default 20. result: max chars per item, default 8000 (overlong text truncated with a pointer to the full file).',
    }),
  ),
  what: Type.Optional(
    StringEnum(
      ['user-messages', 'commands', 'files', 'commits', 'tool-results'],
      {
        description: 'extract action: what to extract (required for extract).',
      },
    ),
  ),
  tool: Type.Optional(
    Type.String({
      description: 'extract action: filter commands/tool-results by tool name (e.g. "bash").',
    }),
  ),
  runId: Type.Optional(
    Type.String({
      description:
        'workflow action: focus a single run by runId (disambiguate multiple runs). Omit to see all run overviews.',
    }),
  ),
  recursive: Type.Optional(
    Type.Boolean({
      description:
        'family action: return nested execution tree (arbitrary-depth subagent↔workflow-call nesting, precise parentRecordId chain with flat-fallback for legacy records). Default false (flat family).',
    }),
  ),
  includeSubagents: Type.Optional(
    Type.Boolean({
      description:
        'doctor action: also scan the subagent session root (adds its file count). Default false (path and existence only).',
    }),
  ),
})

// ---- guidelines（注入 LLM，design §3.4）----

const guidelines = [
  'Progressive reading: outline (~1500 token overview) → expand (one turn) → detail (full text). Default omits toolResult/thinking noise.',
  'find first to locate a session by uuid fragment or name. TUI #references are full uuids.',
  'outline before detail. Never read raw .jsonl files—use this tool.',
  'family traces fork parents/children, subagent sessions, and workflow runs.',
  'extract what=<type> to pull user messages / commands / files / commits / tool results across turns (optional tool= filter for commands/tool-results).',
  "workflow action to see workflow run overviews (status/budget/steps). Each step's call sessionId can jump to outline/detail for deep reading.",
  "result action to fetch a subagent's final result text (same content as its completion notice): session takes a single sa-id/uuid/path or a comma-separated batch of at most 10; optional limit caps chars per item (default 8000, truncated items carry a pointer to the full file).",
  'Errors carry a 👉 recovery hint—follow it to retry in one step.',
  'Unsure about the host environment (pure pi vs taiji) or where session roots live? Run action:"doctor" first—it prints the detected environment and every candidate session root.',
]

// ---- 工具 description（design §3.4，照搬措辞）----

const description = `Read pi session files (conversation history) by semantic structure instead of raw bytes. Use when you need to review another session, trace a fork/subagent/workflow family, or locate a past decision. Eleven actions: find (locate by name/uuid fragment), family (fork/subagent/workflow relations), outline (turn-level overview, ~1500 token), expand (single-turn entry list), detail (full text of turns), search (full-text grep across a session, or cross-session over a comma-separated id list ≤10 from find output), export (materialize to file), extract (pull user messages / commands / files / commits / tool results by type), workflow (workflow run overview: status/budget/steps, step call sessionId jumps to outline/detail), result (fetch a subagent session final result text, same content as its completion notice; single id or comma-separated batch ≤10, optional limit chars per item default 8000), doctor (show detected host environment and session-root diagnostics). Progressive reading: outline → expand → detail. Do NOT use for the current session (the host provides current-session access) or to edit sessions (pi has /resume /fork).`

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
      // 错误路径直接 throw：pi 契约只有 throw 才置 isError:true（tool_execution_end /
      // ToolResultMessage），handler 抛的 Error 文案（含 👉 恢复提示）原样成为
      // toolResult content，模型仍可读到。曾用 return {isError:true}——被 agent-loop
      // 丢弃，错误轮被标成功（W4 修复）。
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
  // once-guard + ctx.mode 守卫 + typeof 运行时守卫三重防护。
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
