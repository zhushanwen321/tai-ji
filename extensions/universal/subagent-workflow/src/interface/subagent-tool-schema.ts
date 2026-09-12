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
// action:"start" 的 17 字段（task/slug/agent/model/...）拍平在顶层，不再用 startParam
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
    description: "Operation: 'start' runs a subagent, 'list' shows subagents, 'cancel' stops a background subagent, 'message' sends a follow-up to a running subagent (one-shot subagents are auto-upgraded to conversation mode on first message), 'close' ends a running subagent (conversation-mode or one-shot), 'fork-from' spawns a NEW subagent inheriting an older one's history (recovery for restart-disconnected subagents; the old record is untouched).",
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
  conversation: Type.Optional(Type.Boolean({
    description:
      "Enable continuous chat with this subagent. When true, the subagent stays available after each reply — you can send follow-up messages (action:'message') and it keeps the full conversation context across rounds, with no need to re-spawn or re-explain. " +
      "\nUse conversation:true for: multi-round collaboration (iterative review-fix loops, back-and-forth refinement), any task where you expect to send follow-up messages after the initial result. " +
      "\nOmit (or false) for: one-shot tasks — single exploration, lookup, file read, code generation that needs no follow-up. The subagent runs once, notifies on completion, and is cleaned up automatically (default). " +
      "\nFor long-interval collaboration (each round spaced >5min apart), set conversation:true AND increase idleTimeoutMs to avoid premature timeout. " +
      "Cost: a conversation-mode subagent holds resources (memory, and a worktree if enabled) until you explicitly end it with action:'close'. Always close when done.",
  })),
  idleTimeoutMs: Type.Optional(Type.Number({
    description:
      "Idle timeout in milliseconds for conversation-mode subagents. Controls how long an idle subagent (between rounds) stays alive before automatic cleanup. " +
      "Default: 300000 (5min). Override for long-interval collaboration where each round is spaced >5min apart. " +
      "Pass 0 or a negative value to DISABLE idle cleanup entirely (subagent stays alive until explicitly closed). " +
      "Only meaningful with conversation:true; ignored for one-shot subagents.",
  })),
  engine: Type.Optional(StringEnum(["pi", "zcode"], {
    description:
      "Execution engine for this subagent. Omit to inherit the global config. " +
      "Three-layer priority: this parameter > agent .md frontmatter engine > config.json defaultEngine. " +
      "Non-pi engines do not support conversation/fork/worktree (rejected before the subagent is created).",
  })),
  collect: Type.Optional(StringEnum(["async", "sync"], {
    description:
      "Completion-notification collection mode for one-shot subagents (subagent-sync-collect). " +
      "Omit to use the config default (currently async). " +
      "Use 'sync' when you dispatch >=2 independent one-shot subagents whose results you will combine: " +
      "their completions are held until ALL pending sync subagents finish, then delivered as ONE batch " +
      "notification (single wake-up, results inline). You may keep dispatching more sync subagents in " +
      "later turns — they join the same pending batch. " +
      "Independent means no member's prompt or work depends on another member's output — dependent " +
      "tasks must be chained across messages (one start after the prior completes), never batched. " +
      "Use 'async' (or omit) for immediate per-subagent completion notifications. " +
      "Incompatible with conversation:true — that combination is rejected immediately before start; " +
      "remove either conversation or collect.",
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
  // action:"message" → messageParam.subagentId + text REQUIRED. Any RUNNING subagent works —
  // one-shot subagents are auto-upgraded to conversation mode on first message (SP-5); ended ones throw.
  messageParam: Type.Optional(Type.Object({
    subagentId: Type.String({
      description: "REQUIRED for action:'message'. The subagentId to message (any running subagent; a one-shot subagent is auto-upgraded to conversation mode on first message, so you may also message one-shot subagents that are still running).",
    }),
    text: Type.String({
      description: "REQUIRED for action:'message'. The message to send. Whitespace-only throws.",
    }),
    interrupt: Type.Optional(Type.Boolean({
      description: "If true, interrupt the subagent's current work immediately (in-progress output stops, it switches to your new message). If false (default), the message is queued and processed after the current round completes. When the subagent is idle (between rounds), interrupt has no effect — the message always starts a new round.",
    })),
  })),
  // action:"close" → closeParam.subagentId REQUIRED. Ends a running subagent (conversation-mode
  // or one-shot — closeSubagent behavior split covers both).
  closeParam: Type.Optional(Type.Object({
    subagentId: Type.String({
      description: "REQUIRED for action:'close'. The subagentId to close (any running subagent, conversation-mode or one-shot).",
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
      description: "REQUIRED for action:'fork-from'. The OLD subagentId whose conversation history becomes the inherited context of the new subagent. Works for records disconnected by a session restart or already finished; cancelled/worktree-bound/still-running ones are rejected with guidance.",
    }),
    prompt: Type.Optional(Type.String({
      description: "Continuation instruction for the new subagent (what to do next on top of the inherited history). When omitted, a standard handover frame is injected: reconstruct done/decided/remaining from the inherited history, then continue to completion. Whitespace-only treated as omitted.",
    })),
  })),
});
