/**
 * mock 流式回复的 tool_call + widget 分支序列 —— 从 run-send-stream.ts 抽出
 * （同该文件从 index.ts 抽出的拆分先例：降低行数，行为零改变）。
 * 按 detectBranch 分发：默认 read / todo / goal，各分支产出 tool_call start/end
 * （[w21] entry 形态 payload，协议同步 event-adapter 重构载体）+ 分支专属 widget 帧。
 */
import { guiResult, guiComponent } from "@taiji/extension-protocol";
import type { PiMessageEntry, PiToolCallEntryForm } from "@taiji/shared";
import type { SendStreamDeps } from "./run-send-stream";

// 导出：三个 emit*Branch 导出函数的签名引用（private_type_leak 修复——签名占有的类型须随导出可达）
export type BranchDeps = Pick<
  SendStreamDeps,
  "nextId" | "emit" | "sleep" | "isCancelled" | "TIMING"
>;
export type BranchDepsWithPush = BranchDeps & Pick<SendStreamDeps, "pushSession">;

/** 按 text 关键词判分支：todo / goal / 默认（read） */
export function detectBranch(text: string): "todo" | "goal" | "read" {
  const lower = text.toLowerCase();
  if (/\btodo\b|任务/.test(lower)) return "todo";
  if (/\bgoal\b|目标/.test(lower)) return "goal";
  return "read";
}

/** [w21] entry 形态 payload 的固定时间戳（确定性，消 magic number） */
const MOCK_ENTRY_TS_MS = 1_700_000_000_000;
const MOCK_ENTRY_TS = new Date(MOCK_ENTRY_TS_MS).toISOString();

/** [w21] toolCall entry 形态（协议同步：event-adapter 翻译时重构的实时 feed 载体） */
function toolCallEntry(
  toolCallId: string,
  toolName: string,
  args: Record<string, unknown>
): PiToolCallEntryForm {
  return {
    type: "toolCall",
    toolCallId,
    toolName,
    arguments: args,
    timestamp: MOCK_ENTRY_TS,
  };
}

/** [w21] toolResult message entry（content 是 text block 数组，pi 持久化形态） */
function toolResultEntry(
  toolCallId: string,
  toolName: string,
  details: Record<string, unknown>,
  content: Array<Record<string, unknown>> = [{ type: "text", text: "done" }]
): PiMessageEntry {
  return {
    type: "message",
    parentId: null,
    timestamp: MOCK_ENTRY_TS,
    message: {
      role: "toolResult",
      toolCallId,
      toolName,
      content,
      isError: false,
      timestamp: MOCK_ENTRY_TS_MS,
      details,
    },
  };
}

/** 默认分支（read tool + extension widget × 3 + status；gui-components.spec 路径 A/B 零回归） */
export async function emitReadBranch(
  sessionId: string,
  deps: BranchDepsWithPush
): Promise<void> {
  const { nextId, emit, sleep, pushSession, isCancelled, TIMING } = deps;
  const toolCallId = nextId("tc");
  emit(sessionId, {
    type: "message.tool_call_start",
    // [w21] entry 形态 payload（协议同步：event-adapter 重构 toolCall entry）
    payload: {
      sessionId,
      entry: toolCallEntry(toolCallId, "read", { path: "/mock/file.ts" }),
    },
  });
  await sleep(TIMING.toolGap);
  if (isCancelled(sessionId)) return;
  emit(sessionId, {
    type: "message.tool_call_update",
    payload: { sessionId, toolCallId, detail: "读取 42 行" },
  });
  await sleep(TIMING.toolGap);
  if (isCancelled(sessionId)) return;
  emit(sessionId, {
    type: "message.tool_call_end",
    payload: {
      sessionId,
      // [w21] toolResult entry；路径 B：details.__gui__ 让 Block.vue extractGui 提取并路由到
      // GuiComponentRenderer（card 嵌套 progress-bar + stats-line，覆盖递归嵌套 + 3 种 type）。
      entry: toolResultEntry(
        toolCallId,
        "read",
        {
          __gui__: guiResult(
            guiComponent("card", {
              variant: "elevated",
              header: "CI Pipeline",
              body: [
                guiComponent("progress-bar", {
                  label: "build",
                  current: 7,
                  total: 8,
                  severity: "ok",
                }),
                guiComponent("stats-line", {
                  items: [
                    { label: "turns", value: "15" },
                    { label: "tokens", value: "2.1k" },
                  ],
                }),
              ],
            })
          ),
        },
        // content 是 text block 数组（pi 持久化形态，W21 契约）
        [{ type: "text", text: "…文件内容（mock）…" }]
      ),
    },
  });

  // 任务3：extension widget + status 推送（走 session 通道，对齐 SideDrawer useSessionEvents.onMessage）。
  // 在 tool_call 后推，模拟扩展输出（terminal widget 行 + 状态栏文本），让 SideDrawer 在 mock 下可验。
  if (isCancelled(sessionId)) return;
  await sleep(TIMING.toolGap);
  pushSession(sessionId, {
    type: "extension:widget",
    id: nextId("w"),
    payload: {
      sessionId,
      widgetKey: "terminal",
      lines: ["$ npm run build", "✓ built in 1.42s", "（mock widget 输出）"],
    },
  });
  // 结构化 GUI widget（extension:widgetGui）：解包后的 GuiComponent 形状（{ type, props }），
  // 对齐 event-adapter 解码 NUL marker 后发出的 gui（非 GuiRenderResult 的 { v, component } 包装）。
  // 让 SideDrawer / GuiComponentRenderer 在 mock 下可验证 GUI widget 渲染。
  pushSession(sessionId, {
    type: "extension:widgetGui",
    id: nextId("wg"),
    payload: {
      sessionId,
      widgetKey: "gui-demo",
      gui: {
        type: "stats-line",
        props: {
          items: [
            { value: "3", label: "turns" },
            { value: "2.1k", label: "tokens" },
            { value: "4.5s", label: "duration" },
          ],
        },
      },
    },
  });
  // 第二个 GUI widget：list-tree，widgetKey 含 'browser' → 落到 SideDrawer browser tab，
  // 与 terminal tab 的 stats-line 互不覆盖。让 E2E 可切 tab 验证不同 type 渲染。
  pushSession(sessionId, {
    type: "extension:widgetGui",
    id: nextId("wg2"),
    payload: {
      sessionId,
      widgetKey: "gui-browser-demo",
      gui: {
        type: "list-tree",
        props: {
          items: [
            {
              label: "Deploy",
              icon: "arrow",
              children: [
                { label: "VPC", status: "done" },
                { label: "RDS", status: "running" },
                { label: "Redis", status: "failed" },
              ],
            },
          ],
        },
      },
    },
  });
  pushSession(sessionId, {
    type: "extension:status",
    id: nextId("ws"),
    payload: {
      sessionId,
      statusKey: "mock-status",
      text: "Mock: Running",
      textRaw: "\x1b[32m● Mock: Running\x1b[0m",
    },
  });
}

/** todo 分支：todo tool_call start/end（details.todos + __gui__ list-tree，不走 widget 通道） */
export async function emitTodoBranch(
  sessionId: string,
  deps: BranchDeps
): Promise<void> {
  const { nextId, emit, sleep, isCancelled, TIMING } = deps;
  const toolCallId = nextId("tc");
  emit(sessionId, {
    type: "message.tool_call_start",
    // [w21] entry 形态 payload（toolCall entry，arguments 对齐 pi args）
    payload: {
      sessionId,
      entry: toolCallEntry(toolCallId, "todo", {
        action: "add",
        texts: [
          "复现 token 过期场景",
          "定位 refreshToken 循环点",
          "添加 maxRetry 守卫",
          "编写单元测试覆盖边界",
          "更新 auth 模块文档",
        ],
      }),
    },
  });
  await sleep(TIMING.toolGap);
  if (isCancelled(sessionId)) return;
  // 5 项任务，覆盖三态 + 2 个 isVerification（#3 #4）
  // todos 数组供渲染层结构化展示（isVerification 标签依据）：id:number / text:string / status 枚举
  const todos = [
    { id: 1, text: "复现 token 过期场景", status: "completed" as const },
    { id: 2, text: "定位 refreshToken 循环点", status: "completed" as const },
    {
      id: 3,
      text: "添加 maxRetry 守卫",
      status: "completed" as const,
      isVerification: true,
    },
    {
      id: 4,
      text: "编写单元测试覆盖边界",
      status: "in_progress" as const,
      isVerification: true,
    },
    { id: 5, text: "更新 auth 模块文档", status: "pending" as const },
  ];
  emit(sessionId, {
    type: "message.tool_call_end",
    // [w21] toolResult message entry 形态（无 content：output 保留 running 期间旧值）
    payload: {
      sessionId,
      // details.todos（含 isVerification）+ details.__gui__.component（list-tree）
      entry: toolResultEntry(toolCallId, "todo", {
        action: "add",
        nextId: 6,
        todos,
        // list-tree 对齐 todo extension buildGui 映射：completed→done, in_progress→running, pending→无 status
        __gui__: guiResult(
          guiComponent("list-tree", {
            items: [
              {
                icon: "check",
                label: "#1: 复现 token 过期场景",
                status: "done",
                depth: 0,
              },
              {
                icon: "check",
                label: "#2: 定位 refreshToken 循环点",
                status: "done",
                depth: 0,
              },
              {
                icon: "check",
                label: "#3: 添加 maxRetry 守卫",
                status: "done",
                depth: 0,
              },
              {
                icon: "circle",
                label: "#4: 编写单元测试覆盖边界",
                status: "running",
                depth: 0,
              },
              { icon: "dot", label: "#5: 更新 auth 模块文档", depth: 0 },
            ],
          })
        ),
      }),
    },
  });
}

/** goal 分支：goal_control start/end（objective/slug + __gui__ card）+ goal ANSI widget */
export async function emitGoalBranch(
  sessionId: string,
  deps: BranchDepsWithPush
): Promise<void> {
  const { nextId, emit, sleep, pushSession, isCancelled, TIMING } = deps;
  const toolCallId = nextId("tc");
  // tool_call_start：entry.arguments.objective 是 Case 3 断言的目标文本
  emit(sessionId, {
    type: "message.tool_call_start",
    // [w21] entry 形态 payload（toolCall entry，arguments 对齐 pi args）
    payload: {
      sessionId,
      entry: toolCallEntry(toolCallId, "goal_control", {
        action: "create",
        objective: "修复登录模块 token 过期无限重定向问题",
        slug: "fix-auth-bug",
      }),
    },
  });
  await sleep(TIMING.toolGap);
  if (isCancelled(sessionId)) return;
  emit(sessionId, {
    type: "message.tool_call_end",
    // [w21] toolResult message entry 形态（无 content：output 保留 running 期间旧值）
    payload: {
      sessionId,
      // details.slug + details.__gui__.component（card）
      entry: toolResultEntry(toolCallId, "goal_control", {
        action: "create",
        goalId: "g-mock",
        status: "active",
        slug: "fix-auth-bug",
        // card body 含 progress-bar，severity 控制填充色（warn→warning）
        // 不传 unit：value 显示 '71/200'（避免 '71000k/200000k' 的单位错配）
        __gui__: guiResult(
          guiComponent("card", {
            variant: "default",
            header: "fix-auth-bug",
            body: [
              guiComponent("progress-bar", {
                label: "tokens",
                current: 71,
                total: 200,
                severity: "warn",
              }),
              guiComponent("progress-bar", {
                label: "time",
                current: 720,
                total: 1800,
                severity: "ok",
              }),
              guiComponent("stats-line", {
                items: [
                  { label: "status", value: "active", severity: "ok" },
                  { label: "turn", value: "3" },
                ],
              }),
            ],
          })
        ),
      }),
    },
  });

  // goal ANSI widget：走 session 通道，widgetKey='goal'。
  // header 行格式：`◆ <slug> Turn N | NN% tokens | NN% time`
  if (isCancelled(sessionId)) return;
  await sleep(TIMING.toolGap);
  pushSession(sessionId, {
    type: "extension:widget",
    id: nextId("gw"),
    payload: {
      sessionId,
      widgetKey: "goal",
      lines: [
        "\x1b[36m◆ fix-auth-bug\x1b[0m\x1b[90m Turn 3\x1b[0m\x1b[33m | 36% tokens\x1b[0m\x1b[33m | 40% time\x1b[0m",
      ],
    },
  });
}
