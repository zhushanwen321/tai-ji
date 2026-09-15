// src/interface/subagent-tool-schema.ts
//
// `subagent` 工具的参数 schema 纯常量叶子（零运行时依赖）。
//
// 抽取自 subagent-tool.ts（跨包契约另一半）：subagent-tool 依赖树沉重（pi SDK /
// handler / render 链），structured-output 侧的跨包契约测试若从它 import schema
// 会把整条依赖树拖进测试进程。本模块只含 schema 常量，运行时 import 仅
// typebox（Type 构造）与 pi-ai（StringEnum helper），为 structured-output 侧
//（及任何消费者）的跨包契约测试提供稳定 import 点。
//
// [跨包契约] structured-output 的 cross-package-contract.test.ts 经真实 typebox
// 编译本 schema 并断言 required/description/enum/pattern 存活——SW 自身测试环境
// 把 typebox alias 到 mock（丢 options），SO 侧测试以真实构造为对照基准。
//
// 层归属：Interface（工具 schema 的家）。SLUG_MAX_LENGTH 权威定义在 core 侧
// orchestration/models/types.ts（[D6 合流迁址] 原 execution/execute-options-mapper.ts
// 已随 mapper 删除，常量迁至 AgentCallOpts.description 字段同文件；core 切面不得
// 反向 import 壳侧 interface 的约束不变）——此处 re-export 保持既有 import 路径。

import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

import { THINKING_ORDER } from "@zhushanwen/subagent-core";

import { SLUG_MAX_LENGTH } from "@zhushanwen/subagent-core";

export { SLUG_MAX_LENGTH };

// Params schema（跨包契约测试的真实 typebox 校验入口）。
//
// action:"start" 的 16 字段（task/slug/agent/model/...）拍平在顶层，不再用 startParam
// 嵌套容器包。原因：弱模型（GLM/DeepSeek）信任 schema 结构信号 > 文本信号，经常省略
// startParam 嵌套层把 task/slug 直接平铺到顶层导致调用失败。拍平后 schema 结构与模型
// 的自然倾向一致，消除这层误用。task/slug 必填性由 startHandler runtime 校验（flat
// JSON Schema 无法表达「action 条件必填」）。
//
// TODO(long-term, option-A): listParam/cancelParam 仍标 Optional 也是 flat JSON Schema
// 表达「action 分发条件必填」的妥协——长期方案是拆成 3 个独立 tool
// （subagent_start / subagent_list / subagent_cancel），让每个 tool 的 schema 真实
// 反映必填性。勿在此基础上继续堆 action 条件逻辑——要加就拆 tool。
export const SubagentParams = Type.Object({
  action: StringEnum(["start", "list", "cancel", "message", "close", "fork-from"], {
    description: "Operation: 'start' runs a subagent, 'list' shows subagents, 'cancel' stops a background subagent, 'message' sends a follow-up to any of your subagents (running or idle — an idle one transparently revives and continues on its original session file), 'close' archives a subagent (immediately when idle; after the current round, or immediately with force:true, when running), 'fork-from' spawns a NEW subagent inheriting an older one's history (recovery for restart-disconnected subagents; the old record is untouched).",
  }),
  // ── action:"start" fields (flattened to top level). task/slug REQUIRED for start. ──
  // Missing/empty task or slug throws at runtime (startHandler).
  // (flat JSON Schema can't express conditional requirement — see file-level TODO.)
  task: Type.Optional(Type.String({
    description: "REQUIRED for action:'start'. The task for the subagent to execute. Throws if missing or whitespace-only.",
  })),
  slug: Type.Optional(Type.String({
    description:
      "REQUIRED for action:'start'. Short label (≤35 chars) for this subagent, e.g. 'fix-login', 'extract-urls'. " +
      "Shown in TUI to distinguish concurrent subagents.",
    maxLength: SLUG_MAX_LENGTH,
  })),
  agent: Type.Optional(Type.String({
    description: 'Agent ref: absolute path to the agent .md file (use <location> from <available_subagents>). If omitted, defaults to "general-purpose" — a generic agent that inherits the main agent\'s model and project context. Do not invent names — only use paths from the injected list.',
  })),
  model: Type.Optional(Type.String({
    description: 'Model override in "provider/modelId" format. CASE-SENSITIVE: the string must equal a registry entry exactly, including letter case (e.g. "zai-coding-cn/GLM-5.3-Flash", NOT "zai-coding-cn/glm-5.3-flash"). A non-exact match is rejected immediately with "Did you mean" suggestions — retry with the exact suggested string; the system never auto-corrects your input. Resolution order (top wins): (1) this param, (2) agent .md frontmatter model, (3) the main agent\'s current model (zero-config default). An explicit model (param or frontmatter) that is missing or unauthorized THROWS — there is no silent fallback to the main model. Omit this param to inherit the main model.',
  })),
  thinkingLevel: Type.Optional(StringEnum(THINKING_ORDER, {
    description: "Thinking depth override (derived from THINKING_ORDER SSOT, includes 'max'). Omit to default to the model's highest available level (not the main agent's level).",
  })),
  skillPath: Type.Optional(Type.String({
    description:
      "Absolute path to a skill directory, injected into the subagent's pi process via --skill " +
      "(e.g. a path under .agents/skills/ already resolved for the caller). Must be an absolute path; " +
      "'..' traversal segments are rejected.",
    pattern: "^/",
  })),
  appendSystemPrompt: Type.Optional(Type.Array(Type.String())),
  schema: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  maxTurns: Type.Optional(Type.Number({
    description: "Turn limit. The subagent is terminated via SIGTERM after maxTurns turn_end events + graceTurns of slack. There is no graceful wrap-up message — the process is killed. 0 or omitted = unlimited.",
  })),
  graceTurns: Type.Optional(Type.Number({
    description: "Extra turns allowed after maxTurns is reached before SIGTERM (default 2). Only meaningful when maxTurns is set.",
  })),
  fork: Type.Optional(Type.Boolean({
    description: "Fork mode: inherit the parent's conversation context. When true, the subagent receives the parent's session file via --fork and builds a branched conversation (it sees prior turns/messages). The subagent still runs in a separate spawned child process (process isolation) — fork is about context inheritance, not process sharing; independent of worktree (file-system isolation, see worktree param). When to use: only when the task extends from the parent and genuinely needs key information from the parent's conversation history that a self-contained task prompt cannot carry — most tasks a plain prompt can describe do NOT need fork, so keep false by default and enable only when the user explicitly asks or the task truly depends on seeing prior turns. Caveat: fork drags in the parent's dispatch records and unrelated task context, polluting the subagent (it cannot tell 'context meant for me' from 'parent dispatching me'); when state lives in an external store the subagent can query (e.g., cw handoff), prefer that over fork.",
  })),
  worktree: Type.Optional(Type.Boolean({
    description: "Worktree isolation: run the subagent in a dedicated git worktree, providing file-system level isolation from the parent session (prevents concurrent file-write conflicts). Independent of fork — worktree may be combined with fork:false (file isolation does not require context inheritance). When to use: parallel development scenarios where multiple agents write files concurrently and need isolated working directories (each gets its own checkout; merge later); leave false for single-agent or read-only tasks.",
  })),
  cwd: Type.Optional(Type.String({
    description: 'Override the working directory for the subagent execution. Must be an absolute path (no "~" shorthand, no relative paths); ".." segments are rejected. Defaults to the parent session\'s cwd.',
    pattern: "^/",
  })),
  // [modeless 波5] conversation 参数已删除：chatMode 字段消亡后「模式」不存在——
  // 一切 record 永续可续聊（idle 后 message 即续、fork-from 可继承），无模式开关可表达。
  idleTimeoutMs: Type.Optional(Type.Number({
    description:
      "Idle-recycle cadence for ALL subagents (modeless: every subagent stays continuable — this is NOT a mode switch). Controls how long an idle subagent (between rounds, no activity) stays before being automatically archived. " +
      "Default: 300000 (5min). Raise it for long-interval collaboration where your next message may arrive more than 5min after a round ends. " +
      "Pass 0 or a negative value to DISABLE idle recycling entirely (subagent stays available until you close it). " +
      "Priority: this param > env XYZ_SUBAGENT_IDLE_TIMEOUT_MS > default.",
  })),
  engine: Type.Optional(StringEnum(["pi", "zcode"], {
    description:
      "Execution engine for this subagent. Omit to inherit the global config. " +
      "Three-layer priority: this parameter > agent .md frontmatter engine > config.json defaultEngine. " +
      "Non-pi engines do not support fork/worktree (rejected before the subagent is created).",
  })),
  collect: Type.Optional(StringEnum(["async", "sync"], {
    description:
      "Completion-notification routing (NOT a record mode — batch membership is routing bookkeeping only). " +
      "Omit to use the config default (currently async). " +
      "'async' = each subagent's completion notifies immediately. " +
      "'sync' = batch wake-up: when you dispatch >=2 independent subagents whose results you will " +
      "combine, their completions are held until ALL pending sync members finish, then delivered as " +
      "ONE batch notification (single wake-up, results inline); when the batch closes, its members " +
      "are automatically archived. Batch members cannot be messaged — use action:'fork-from' to " +
      "continue from one instead. You may keep dispatching more sync subagents in later turns — " +
      "they join the same pending batch. Independent means no member's prompt or work depends on " +
      "another member's output — dependent tasks must be chained across messages (one start after " +
      "the prior completes), never batched.",
  })),
  // action:"list" → listParam OPTIONAL (all fields optional, defaults apply). Ignored by other actions.
  listParam: Type.Optional(Type.Object({
    includeFinished: Type.Optional(Type.Boolean({
      description: "Include finished (done/failed/cancelled) records. Default false (running only).",
    })),
    includeWorkflow: Type.Optional(Type.Boolean({
      description:
        "Include records dispatched by workflow scripts (agent() calls). Default false — subagents " +
        "spawned inside workflows are hidden from list output. Set true only when troubleshooting a " +
        "workflow run's subagents (e.g. a workflow step failed and you need to inspect its records). " +
        "Pair with includeFinished:true — finished workflow records stay hidden unless both flags are set.",
    })),
    limit: Type.Optional(Type.Number({
      description: "Max items to return. Default 20, clamped to [1, 100].",
    })),
  })),
  // action:"cancel" → cancelParam.subagentId REQUIRED. Throws if missing. Ignored by other actions.
  cancelParam: Type.Optional(Type.Object({
    subagentId: Type.String({
      description: "REQUIRED for action:'cancel'. The subagentId to cancel. Throws if missing. Only background subagents can be cancelled.",
    }),
  })),
  // action:"message" → messageParam.subagentId + text REQUIRED. Any reachable subagent works —
  // running joins the in-flight round (D2 打断入队)；idle transparently revives on the same
  // session file（[U4 §3.2.3] 万物可续——形态枚举 gate 与 SP-5 升级路径均消亡，message 直接
  // 续聊任何 idle record）。引擎续聊能力轴 gate 保留（core messageHandler 入口）。
  // description 与实现锚点见 messageHandler。
  messageParam: Type.Optional(Type.Object({
    subagentId: Type.String({
      description: "REQUIRED for action:'message'. The subagentId to message. Any subagent reachable in this session tree works, running or idle: an idle subagent transparently revives on the same id and continues writing its original session file; a running subagent has your message interrupt-and-join its in-flight round. Rejections: unknown id, session file held by another live process, a record from a different session tree, workflow-origin records (their results belong to the workflow run), and records on engines that do not support continuation (fork-from or re-dispatch instead).",
    }),
    text: Type.String({
      description: "REQUIRED for action:'message'. The message to send. Whitespace-only throws.",
    }),
    interrupt: Type.Optional(Type.Boolean({
      // [H1 U6 / D2] 参数已退役（messageHandler 零消费）：在途轮存在即打断入队，
      // 不区分抢占/排队——字段保留防存量调用 schema 报错，description 据实声明 no-op。
      description: "Deprecated, no effect: a message to a running subagent always interrupts its in-flight round (the round aborts and your message is processed next) regardless of this flag; an idle subagent always starts a new round.",
    })),
  })),
  // action:"close" → closeParam.subagentId REQUIRED. 归档（archived）：列表隐藏、可寻回、
  // 非终态化（[U5 §3.2.5]）。idle 立即归档收口；running 默认等当前轮收口后归档，
  // force:true 立即终止随即归档（closeHandler 头注行为分流）。
  closeParam: Type.Optional(Type.Object({
    subagentId: Type.String({
      description: "REQUIRED for action:'close'. The subagentId to close (any reachable subagent — running or idle). Close archives the record: hidden from list, recoverable, not a terminal state. Idle subagents close immediately; running ones finish the current round first, or terminate immediately when force:true.",
    }),
    force: Type.Optional(Type.Boolean({
      description: "If true, terminate immediately even if mid-round (in-progress work is lost). If false (default), let the current round finish, then close. When idle, the subagent closes immediately regardless.",
    })),
  })),
  // action:"fork-from" → forkFromParam.sourceSubagentId REQUIRED ([v8.5 B] 断联恢复通道).
  // 从旧 subagent 的会话历史 spawn 新 id：新进程 --fork 指向旧 session 文件（copy-on-write，
  // 源文件只读不续写）；旧记录/状态机不动。pi 引擎限定（非 pi 在 execute 层拒绝）。
  forkFromParam: Type.Optional(Type.Object({
    sourceSubagentId: Type.String({
      description: "REQUIRED for action:'fork-from'. The OLD subagentId whose conversation history becomes the inherited context of the new subagent. Works for any idle record — disconnected by a session restart, already finished, or previously closed/cancelled. Rejections: still-running sources (message them instead), sources held by another live process, worktree-bound sources, and unknown ids; an unparseable history anchor is guided to action:'message' (same-id reopen) instead.",
    }),
    prompt: Type.Optional(Type.String({
      description: "Continuation instruction for the new subagent (what to do next on top of the inherited history). When omitted, a standard handover frame is injected: reconstruct done/decided/remaining from the inherited history, then continue to completion. Whitespace-only treated as omitted.",
    })),
  })),
});
