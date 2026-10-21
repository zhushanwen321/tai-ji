// src/interface/tool/subagent-tool-schema.ts
//
// subagent 工具组的参数 schema 纯常量叶子（零运行时依赖）。
//
// tool-declaration-slimming D3 拆分终态：按动作拆为三个工具（拆分前是 6 action 拍平 21 参数的单一工具）
// 拆为三工具，schema 各自真实反映必填性：
//   - `subagent_start`  → SubagentStartParams（task/slug 必填 + 13 个 start 场景可选字段）
//   - `subagent_manage` → SubagentManageParams（action: list/cancel/close）
//   - `subagent_message`→ SubagentMessageParams（action: message/fork-from）
// manage/message 内部保留小 action 枚举是 D3 范围裁决（参数同构、条件必填失真可忽略）。
// 另含批量派发 `subagents` → SubagentsParams（成员对象形状，自 tool-subagents.ts 移入；
// 设计 §3.4：schema 类型与 start/manage/message 同文件，供跨包契约测试直接 import）。
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

import { MAX_TIMER_DELAY_MS, THINKING_ORDER } from "@zhushanwen/subagent-core";

import { SLUG_MAX_LENGTH } from "@zhushanwen/subagent-core";

export { SLUG_MAX_LENGTH };

// ── subagent_start：task/slug 必填由 schema 表达（拆分收益本体，D3）──

export const SubagentStartParams = Type.Object({
  task: Type.String({
    description: "The task to execute. Throws if missing or whitespace-only.",
  }),
  slug: Type.String({
    description:
      "Short label (≤35 chars), e.g. 'fix-login'. " +
      "Shown in TUI to distinguish concurrent subagents.",
    maxLength: SLUG_MAX_LENGTH,
  }),
  agent: Type.Optional(Type.String({
    description: 'Agent ref: absolute path to an agent .md file — usually a <location> from <available_subagents>, but ANY absolute .md path works. Relative paths and bare names are rejected. Omit for the default general-purpose agent.',
  })),
  model: Type.Optional(Type.String({
    // 缺省继承主 agent 的纪律句已删（tool-declaration-slimming D1 单源化：缺省继承
    // 属跨工具通用纪律，收敛到 <available_subagents> 注入段（subagent-list-injector.ts
    // SUBAGENT_DISPATCH_SHARED_RULES）说一次，原文见 git 历史。Resolution order
    // 是本参数的功能语义（三层优先级链），保留。
    description: 'Model override in "provider/modelId" format. CASE-SENSITIVE — must equal a registry entry exactly; mismatches are rejected with "Did you mean" suggestions (retry with the exact string). Resolution order (top wins): this param > agent .md frontmatter > the main agent\'s current model. A missing or unauthorized explicit model THROWS — no silent fallback.',
  })),
  thinkingLevel: Type.Optional(StringEnum(THINKING_ORDER, {
    description: "Thinking depth override (THINKING_ORDER SSOT, includes 'max'). Omit for the model's highest available level.",
  })),
  skillPath: Type.Optional(Type.String({
    description:
      "Absolute path to a skill directory, injected via --skill. Must be absolute; '..' segments rejected.",
    pattern: "^/",
  })),
  appendSystemPrompt: Type.Optional(Type.Array(Type.String())),
  schema: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  maxTurns: Type.Optional(Type.Number({
    description: "Turn limit: SIGTERM after maxTurns turn_end events + graceTurns slack (no graceful wrap-up). 0/omitted = unlimited.",
  })),
  graceTurns: Type.Optional(Type.Number({
    description: "Extra turns after maxTurns before SIGTERM (default 2). Only with maxTurns.",
  })),
  fork: Type.Optional(Type.Boolean({
    description: "Fork mode: inherit the parent's conversation via --fork (the subagent sees prior turns). Still a separate process — context inheritance, not process sharing; independent of worktree. Only for tasks that genuinely extend prior turns; keep false by default (fork drags in unrelated parent context).",
  })),
  worktree: Type.Optional(Type.Boolean({
    description: "Worktree isolation: run in a dedicated git worktree (file-system isolation — prevents write conflicts). Independent of fork. For parallel multi-agent writes; false for single-agent or read-only tasks.",
  })),
  cwd: Type.Optional(Type.String({
    description: "Working directory override. Absolute path only (no '~', no '..'). Defaults to the parent session's cwd.",
    pattern: "^/",
  })),
  // [modeless 波5] conversation 参数已删除：chatMode 字段消亡后「模式」不存在——
  // 一切 record 永续可续聊（idle 后 message 即续、fork-from 可继承），无模式开关可表达。
  idleTimeoutMs: Type.Optional(Type.Number({
    description:
      "Idle-recycle cadence for ALL subagents (modeless, not a mode switch): idle subagent auto-archives after this long. Default 300000 (5min); 0/negative disables. Priority: this param > env TAIJI_SUBAGENT_IDLE_TIMEOUT_MS > default.",
  })),
  engine: Type.Optional(StringEnum(["pi", "zcode"], {
    description:
      "Execution engine. Omit to inherit config. Priority: this param > agent .md frontmatter > config.json defaultEngine. Non-pi engines reject fork/worktree.",
  })),
  // [collect 退役] collect 参数已删除——批量编排的唯一入口是 `subagents` tool（fan-out run
  // 管道），单数 start 不再有通知路由选项。旧调用形态（显式带 collect）不会被 pi 参数校验
  // 拒绝（typebox Object 不产 additionalProperties → 未知字段静默放行），通知路由不再生效；
  // 声明层无迁移期提示（原 description 的退役说明已随声明压缩删除，未在其他层重新承载）。
});

// ── subagents：批量派发（成员对象形状，subagent-tool-interface-refactor §3.1.2 终态）──
//
// 与 fan-out 模板共用同一形状（§3.1.2）：tasks 元素 = 成员对象（task/agent/model/
// thinkingLevel），不再接受字符串元素；旧 `agents`（逗号串位置映射）与 `aggregate`
// 从工具 schema 移除——「一个执行者用于全员」用运行级 agent 表达、「每个成员不同」
// 用成员级 agent 表达、归约由主 agent 自行完成。成员未指定 model/thinkingLevel 时
// 留空给 $MODEL/$THINKING_LEVEL 继承（运行级值经 workerData 流动，handler 不复制
// 进成员）；成员未指定 agent 时由 handler 填入运行级 agent。
// 迁移检查在 tool-subagents.ts 适配器（typebox Object 不产 additionalProperties，
// 未知字段静默放行——schema 拒不了旧字段，见文件尾 [collect 退役] 同款先例）。

/** 批量成员对象（SubagentsParams.tasks 元素）：task 必填非空白 + 成员级覆盖三件。 */
export const SubagentsMember = Type.Object({
  task: Type.String({
    description:
      "REQUIRED. The member's complete self-contained task prompt. One-shot members do NOT see your " +
      "conversation — each task must carry its own context and acceptance criteria. Whitespace-only throws.",
    minLength: 1,
  }),
  agent: Type.Optional(Type.String({
    description:
      "Member-level executor: absolute path to an agent .md file (usually a <location> value from " +
      "<available_subagents>). Omit to use the run-level 'agent' (or the default general-purpose executor).",
    pattern: "^/",
  })),
  model: Type.Optional(Type.String({
    description:
      "Member-level model in 'provider/modelId' format. Overrides the run-level 'model' — set it to " +
      "isolate this member from a failing provider. Omit to inherit.",
  })),
  thinkingLevel: Type.Optional(StringEnum(THINKING_ORDER, {
    description:
      "Member-level thinking depth; overrides the run-level 'thinkingLevel'. Omit to inherit.",
  })),
});

export const SubagentsParams = Type.Object({
  tasks: Type.Array(SubagentsMember, {
    description:
      "One or more batch members; each element = one dispatch (object: {task, agent?, model?, thinkingLevel?}). " +
      "All members run in parallel as independent one-shot subagents.",
    minItems: 1,
  }),
  agent: Type.Optional(Type.String({
    description:
      "Run-level default executor: absolute path to an agent .md file (usually a <location> value from " +
      "<available_subagents>). Fills members that do not set their own 'agent'. Omit for the default general-purpose executor.",
    pattern: "^/",
  })),
  model: Type.Optional(Type.String({
    // 缺省继承主 agent 的纪律句已删（tool-declaration-slimming D1 单源化→注入段，
    // 见 subagent-list-injector.ts SUBAGENT_DISPATCH_SHARED_RULES）；成员未指定时
    // 批内继承 run 级值（$MODEL）是本参数的功能语义，保留。
    description:
      "Run-level default model in 'provider/modelId' format — members WITHOUT their own 'model' inherit it. " +
      "To isolate a member from a failing provider, set that member's own 'model' instead.",
  })),
  thinkingLevel: Type.Optional(StringEnum(THINKING_ORDER, {
    description:
      "Run-level default thinking depth — members WITHOUT their own 'thinkingLevel' inherit it. " +
      "Omit to default each agent to its model's highest available level.",
  })),
  slug: Type.Optional(Type.String({
    description: "Batch label (max 35 chars, kebab-case) shown on the conversation block and run list. Omit to auto-generate.",
    maxLength: SLUG_MAX_LENGTH,
  })),
  tokens: Type.Optional(Type.Number({
    // 预算纪律句已删（tool-declaration-slimming D1 单源化→注入段）：跨工具预算纪律说一次，原文见 git 历史。
    description: "Max token budget for the whole batch.",
  })),
  time: Type.Optional(Type.Number({
    description: `Max time budget in ms for the whole batch (hard ceiling ${MAX_TIMER_DELAY_MS} ms — larger values fail fast at entry).`,
  })),
});

// ── subagent_manage：list / cancel / close 三管理动作 ──

export const SubagentManageParams = Type.Object({
  action: StringEnum(["list", "cancel", "close"], {
    description: "Operation: 'list' shows subagents, 'cancel' stops a background one, 'close' archives (recoverable).",
  }),
  // action:"list" → listParam OPTIONAL (all fields optional, defaults apply). Ignored by other actions.
  listParam: Type.Optional(Type.Object({
    includeFinished: Type.Optional(Type.Boolean({
      description: "Include finished (done/failed/cancelled) records. Default false (running only).",
    })),
    includeWorkflow: Type.Optional(Type.Boolean({
      description:
        "Include workflow-dispatched records. Default false; pair with includeFinished:true for finished ones.",
    })),
    limit: Type.Optional(Type.Number({
      description: "Max items to return. Default 20, clamped to [1, 100].",
    })),
  })),
  // action:"cancel" → cancelParam.subagentId REQUIRED (handler throws if missing).
  cancelParam: Type.Optional(Type.Object({
    subagentId: Type.String({
      description: "REQUIRED for action:'cancel'. The subagentId to cancel. Only background subagents are cancellable.",
    }),
  })),
  // action:"close" → closeParam.subagentId REQUIRED. 归档（archived）：列表隐藏、可寻回、
  // 非终态化（[U5 §3.2.5]）。idle 立即归档；running 默认等当前轮收尾后归档（closeHandler 分流）。
  closeParam: Type.Optional(Type.Object({
    subagentId: Type.String({
      description: "REQUIRED for action:'close'. The subagentId to close (running or idle). Archives the record: hidden from list, recoverable, not terminal.",
    }),
    force: Type.Optional(Type.Boolean({
      description: "true = terminate immediately even mid-round (work lost). false (default) = let the round finish; idle closes immediately regardless.",
    })),
  })),
});

// ── subagent_message：message / fork-from 两续聊动作 ──

export const SubagentMessageParams = Type.Object({
  action: StringEnum(["message", "fork-from"], {
    description: "Operation: 'message' sends a follow-up to a subagent, 'fork-from' spawns a new subagent from older history (restart recovery).",
  }),
  // action:"message" → messageParam.subagentId + text REQUIRED. Any reachable subagent works —
  // running joins the in-flight round（D2 打断入队）；idle transparently revives on the same
  // session file（[U4 §3.2.3] 万物可续）。engine 能力轴 gate 保留（core messageHandler 入口）。
  // 拒绝条件与恢复动作（unknown id / 异进程占用 / 跨 session 树 / workflow-origin / 引擎
  // 不支持续聊）由 core messageHandler 的运行时错误文案承载（tool-declaration-slimming D1：
  // 拒绝清单不进 schema 说明——运行时错误本就带恢复动作），此处不重复。
  messageParam: Type.Optional(Type.Object({
    subagentId: Type.String({
      // message 的打断/复活副作用在此承载：必填字段的说明是模型填参的必读内容，
      // 不依赖模型去翻 deprecated interrupt 字段（D1 单源化——interrupt 只声明 no-op）。
      description:
        "REQUIRED for action:'message'. The subagentId to message — any subagent in this session tree, running or idle. " +
        "A message to a running subagent interrupts its in-flight round; an idle one revives on the same id and starts a new round.",
    }),
    text: Type.String({
      description: "REQUIRED for action:'message'. The message to send. Whitespace-only throws.",
    }),
    interrupt: Type.Optional(Type.Boolean({
      // [H1 U6 / D2] 参数已退役（messageHandler 零消费）：在途轮存在即打断入队，
      // 不区分抢占/排队——字段保留防存量调用 schema 报错，description 据实声明 no-op。
      description:
        "Deprecated, no effect — kept only so legacy calls pass schema validation. " +
        "Interrupt/revive semantics live on subagentId above.",
    })),
  })),
  // action:"fork-from" → forkFromParam.sourceSubagentId REQUIRED ([v8.5 B] 断联恢复通道).
  // 从旧 subagent 的会话历史 spawn 新 id：新进程 --fork 指向旧 session 文件（copy-on-write，
  // 源文件只读不续写）；旧记录/状态机不动。pi 引擎限定（非 pi 在 execute 层拒绝）。
  // 拒绝条件与恢复指引（still-running / 异进程活跃 / worktree-bound / 锚不可解析 → message
  // reopen）由 core forkFromHandler 检查链文案承载（D1，同 messageParam），此处不重复。
  forkFromParam: Type.Optional(Type.Object({
    sourceSubagentId: Type.String({
      description: "REQUIRED for action:'fork-from'. The OLD subagentId whose history the new subagent inherits (pi engines only). Works for any idle record (disconnected, finished, or closed).",
    }),
    prompt: Type.Optional(Type.String({
      description: "Continuation instruction. Omitted = standard handover frame (reconstruct done/remaining, continue). Whitespace-only treated as omitted.",
    })),
  })),
});
