// src/__tests__/spawn-args.test.ts
// [HISTORICAL] codemode D8 起期望值随 pi-rpc 模板传导更新：buildPiSubagentSpawnArgs
// 尾部恒带 `--extension builtin:codemode`（pi 1.0 起 --no-extensions 连内置扩展一起
// 排除，显式 -e 是唯一装载通道；随 pi 1.0 升级同行）——包装层在其后追加
// --no-extensions 与 --extension 白名单，二者并存（顺序无语义影响）。本包源码零改动。
// [裁决锚] pi-mcp-management P11 的 `--extension builtin:mcp` 仅主 agent 模板装载
// （subagent 装载 = N 个并行进程 × M 个启用服务器的连接放大 + mcp_servers 提示词节
// + direct 档首 prompt 延迟，且 subagent 消费 MCP 工具为零证据场景，设计 §5 U1
// 波及范围裁决不预付）——本包期望值**不**传导该 token，并显式断言不含（回归锚，
// 防未来误传导）。
import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildEnvBlock, buildSpawnArgs } from "../spawn-args.ts";

// buildEnvBlock 的 git branch 查询走 execFile（OS 边界）——单测层只测「branch 值 →
// 环境块行」的组装逻辑，git 进程本身换注入源（用例注入 stdout / err 回调形态），
// 另留 1 条真 git 冒烟锚定命令拼写（rev-parse --abbrev-ref HEAD + cwd 透传）。
const gitStub = vi.hoisted(() => ({
  /** "injected" = 注入应答（无真进程）；"real" = 委派真实 execFile（真 git 冒烟）。 */
  mode: "injected" as "injected" | "real",
  /** 注入的 stdout（execFile 成功回调第二参）。 */
  stdout: "injected-branch\n",
  /** 注入的 err（execFile 失败回调第一参；非 null 即失败形态）。 */
  err: null as Error | null,
  /** 注入模式下的调用记录（命令拼写 + cwd 契约断言）。 */
  calls: [] as Array<{ file: string; args: string[]; cwd: string | undefined }>,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const execFileStub = ((
    file: string,
    args: string[],
    options: unknown,
    callback?: unknown,
  ): unknown => {
    const cb = (typeof options === "function" ? options : callback) as (
      err: Error | null,
      stdout: string,
      stderr: string,
    ) => void;
    const opts = (typeof options === "function" ? {} : (options ?? {})) as { cwd?: string };
    if (gitStub.mode === "real") {
      return (actual.execFile as (...a: unknown[]) => unknown)(file, args, options, callback);
    }
    gitStub.calls.push({ file, args: [...args], cwd: opts.cwd });
    // execFile 是异步 API：微任务交付应答（保持 await 语义，不退回同步）
    queueMicrotask(() => {
      if (gitStub.err !== null) cb(gitStub.err, "", "");
      else cb(null, gitStub.stdout, "");
    });
    return undefined;
  }) as typeof actual.execFile;
  return { ...actual, execFile: execFileStub };
});

describe("buildSpawnArgs", () => {
  // [U1 D2] modelRef 为必填（spawn 前置检查：未经裁决的裸字符串类型层面不可达）。
  // 类型直接锚定 buildSpawnArgs 入参（thinkingLevel 在协议层是宿主校验后的 string 透传）
  const baseParams: Parameters<typeof buildSpawnArgs>[0] = {
    modelRef: { provider: "openai", id: "gpt-4o" },
    thinkingLevel: undefined,
    agentTools: undefined,
    appendSystemPromptPath: undefined,
    sessionDir: "/sessions/dir",
    forkSource: undefined,
    skillPaths: undefined,
  };

  it("基础参数：--mode rpc --session-dir + --model provider/id + D8 基座旗标 --extension builtin:codemode + --no-extensions 基座（孙进程扩展显式化），不含 -p 也不含 task（task 经 stdin 传）", () => {
    const args = buildSpawnArgs(baseParams);
    // 传导形态：pi-rpc 模板尾部 --extension builtin:codemode 在包装层 push 的
    // --no-extensions 之前（顺序无语义影响，此处一并锚定）
    expect(args).toEqual([
      "--mode", "rpc", "--session-dir", "/sessions/dir", "--model", "openai/gpt-4o",
      "--extension", "builtin:codemode",
      "--no-extensions",
    ]);
  });

  it("不含 -p / --print（rpc mode 下 -p 被 resolveAppMode 无视，是死代码）", () => {
    const args = buildSpawnArgs(baseParams);
    expect(args).not.toContain("-p");
    expect(args).not.toContain("--print");
  });

  it("回归锚：subagent 模板不含 builtin:mcp（P11 仅主 agent 模板装载，设计 §5 U1 波及范围裁决——本断言防未来误传导）", () => {
    const args = buildSpawnArgs(baseParams);
    expect(args).not.toContain("builtin:mcp");
  });

  it("回归锚：subagent 模板不含 builtin:tool-search（tool-declaration-slimming D4 仅主 agent 模板装载——subagent 工具范围为显式白名单语义、无 tool_search 检索需求；本断言防未来误传导）", () => {
    const args = buildSpawnArgs(baseParams);
    expect(args).not.toContain("builtin:tool-search");
  });

  it("modelRef → --model 值恒为 `${provider}/${id}`（全等拼接，不重写输入）", () => {
    // 含大小写差异的 provider/id 原样拼接（大小写敏感规则：放行即全等回显）
    const args = buildSpawnArgs({
      ...baseParams,
      modelRef: { provider: "zai-coding-cn", id: "GLM-5.3-Flash" },
    });
    const idx = args.indexOf("--model");
    expect(args[idx + 1]).toBe("zai-coding-cn/GLM-5.3-Flash");
  });

  it("modelRef + thinkingLevel → model 后缀 :level", () => {
    const args = buildSpawnArgs(
      { ...baseParams, thinkingLevel: "high" },
    );
    const idx = args.indexOf("--model");
    expect(args[idx + 1]).toBe("openai/gpt-4o:high");
  });

  it("agentTools → --tools 逗号分隔", () => {
    const args = buildSpawnArgs(
      { ...baseParams, agentTools: ["read", "bash", "edit"] },
    );
    const idx = args.indexOf("--tools");
    expect(args[idx + 1]).toBe("read,bash,edit");
  });

  it("appendSystemPromptPath → --append-system-prompt <path>", () => {
    const args = buildSpawnArgs(
      { ...baseParams, appendSystemPromptPath: "/tmp/prompt.md" },
    );
    const idx = args.indexOf("--append-system-prompt");
    expect(args[idx + 1]).toBe("/tmp/prompt.md");
  });

  it("forkSource → --fork <path>", () => {
    const args = buildSpawnArgs(
      { ...baseParams, forkSource: "/sessions/parent.jsonl" },
    );
    const idx = args.indexOf("--fork");
    expect(args[idx + 1]).toBe("/sessions/parent.jsonl");
  });

  it("skillPaths 多个 → 每个 push --skill <path>", () => {
    const args = buildSpawnArgs(
      { ...baseParams, skillPaths: ["/skills/a", "/skills/b", "/skills/c"] },
    );
    // 三个 --skill token，后跟各自路径，顺序保留
    const skillIdxs = args
      .map((a, i) => (a === "--skill" ? i : -1))
      .filter((i) => i >= 0);
    expect(skillIdxs).toHaveLength(3);
    expect(args[skillIdxs[0] + 1]).toBe("/skills/a");
    expect(args[skillIdxs[1] + 1]).toBe("/skills/b");
    expect(args[skillIdxs[2] + 1]).toBe("/skills/c");
  });

  it("skillPaths 空数组 → 不含 --skill", () => {
    const args = buildSpawnArgs(
      { ...baseParams, skillPaths: [] },
    );
    expect(args).not.toContain("--skill");
  });

  it("skillPaths undefined → 不含 --skill", () => {
    const args = buildSpawnArgs(baseParams);
    expect(args).not.toContain("--skill");
  });

  it("全参数组合：所有 flag 存在，不含 -p 也不含 positional task", () => {
    const args = buildSpawnArgs(
      {
        ...baseParams,
        thinkingLevel: "low",
        agentTools: ["read"],
        appendSystemPromptPath: "/tmp/p.md",
        sessionDir: "/s",
        forkSource: "/parent.jsonl",
        skillPaths: ["/skills/x"],
        extensionPaths: ["/staged/@zhushanwen/pi-structured-output"],
      },
    );
    // 末尾应是最后一个 --extension 的路径（task 不再作为 positional arg 出现）
    expect(args[args.length - 1]).toBe("/staged/@zhushanwen/pi-structured-output");
    expect(args).toContain("--fork");
    expect(args).toContain("--tools");
    expect(args).toContain("--skill");
    expect(args).not.toContain("-p");
    // D8 传导：--no-extensions 与 --extension builtin:codemode 并存（-ne 下显式 -e
    // 仍装载），白名单 extension 路径排其后
    const extIdxs = args.map((a, i) => (a === "--extension" ? i : -1)).filter((i) => i >= 0);
    expect(extIdxs).toHaveLength(2);
    expect(args[extIdxs[0] + 1]).toBe("builtin:codemode");
    expect(args).toContain("--no-extensions");
  });

  it("空 tools 数组不追加 --tools", () => {
    const args = buildSpawnArgs(
      { ...baseParams, agentTools: [] },
    );
    expect(args).not.toContain("--tools");
  });

  it("含未注册扩展工具名（如 ask_user）正常透传 — 子进程 Pi 静默忽略未注册的 allowlist 项", () => {
    // 场景：orchestrator 模板声明了 ask_user，但用户环境未装 pi-ask-user 扩展。
    // 期望：subagent-workflow 不做特殊处理，仅原样透传给 pi CLI；
    // 静默兼容的责任在 Pi（args.ts 不校验、agent-session 的 _rebuildSystemPrompt
    // 对未注册工具名静默过滤）。本测试固定这个透传行为，避免有人擅自加
    // 「未注册工具检测」导致原本兼容的场景崩溃。
    const args = buildSpawnArgs({
      ...baseParams,
      agentTools: ["todo", "goal_control", "workflow", "subagent", "ask_user"],
    });
    const idx = args.indexOf("--tools");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe(
      "todo,goal_control,workflow,subagent,ask_user",
    );
  });

  // ============================================================
  // [D2 扩展加载显式化] extensionPaths 显式透传（取代已废弃的 argv 镜像机制）
  // ============================================================

  it("extensionPaths 逐项拼 --extension（数组顺序保留）+ 基座 --no-extensions 共存", () => {
    const args = buildSpawnArgs({
      ...baseParams,
      extensionPaths: ["/staged/@zhushanwen/pi-structured-output", "/other/ext"],
    });
    // -ne 与显式 --extension 共存（pi 官方语义：-ne 禁 discovery，显式 -e 仍生效）
    expect(args).toContain("--no-extensions");
    // D8 传导：builtin:codemode 基座旗标 + 2 条白名单路径，共 3 个 --extension token，
    // 白名单顺序保留在基座旗标之后
    const extIdxs = args.map((a, i) => (a === "--extension" ? i : -1)).filter((i) => i >= 0);
    expect(extIdxs).toHaveLength(3);
    expect(args[extIdxs[0] + 1]).toBe("builtin:codemode");
    expect(args[extIdxs[1] + 1]).toBe("/staged/@zhushanwen/pi-structured-output");
    expect(args[extIdxs[2] + 1]).toBe("/other/ext");
  });

  it("extensionPaths 空数组 → 不拼白名单 --extension（仅剩 D8 基座旗标，仍带 --no-extensions 基座）", () => {
    const args = buildSpawnArgs({ ...baseParams, extensionPaths: [] });
    const extIdxs = args.map((a, i) => (a === "--extension" ? i : -1)).filter((i) => i >= 0);
    expect(extIdxs).toHaveLength(1);
    expect(args[extIdxs[0] + 1]).toBe("builtin:codemode");
    expect(args).toContain("--no-extensions");
  });

  it("extensionPaths undefined → 不拼白名单 --extension（双源皆空的缺省形态，仅剩 D8 基座旗标）", () => {
    const args = buildSpawnArgs(baseParams);
    const extIdxs = args.map((a, i) => (a === "--extension" ? i : -1)).filter((i) => i >= 0);
    expect(extIdxs).toHaveLength(1);
    expect(args[extIdxs[0] + 1]).toBe("builtin:codemode");
    expect(args).toContain("--no-extensions");
  });

  // ============================================================
  // sessionFile（M1 resume 基建）：--session <file> 紧跟 --session-dir
  // ============================================================

  it("sessionFile 存在 → 紧跟 --session-dir 追加 --session <file>", () => {
    const args = buildSpawnArgs({
      ...baseParams,
      sessionFile: "/sessions/sub/abc.jsonl",
    });
    const idx = args.indexOf("--session");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("/sessions/sub/abc.jsonl");
    // 位置紧跟 --session-dir <dir> 之后（--model 之前）
    const sessionDirIdx = args.indexOf("--session-dir");
    expect(idx).toBe(sessionDirIdx + 2);
  });

  it("sessionFile undefined → 不含 --session（向后兼容）", () => {
    const args = buildSpawnArgs(baseParams);
    expect(args).not.toContain("--session");
    expect(args).toEqual([
      "--mode", "rpc", "--session-dir", "/sessions/dir", "--model", "openai/gpt-4o",
      "--extension", "builtin:codemode", "--no-extensions",
    ]);
  });

  it("sessionFile + modelRef + thinkingLevel → 三者都进 args（resume 全参数）", () => {
    const args = buildSpawnArgs({
      ...baseParams,
      sessionFile: "/sessions/sub/resume.jsonl",
      thinkingLevel: "high",
    });
    // --session <file>
    const sessionIdx = args.indexOf("--session");
    expect(sessionIdx).toBeGreaterThan(-1);
    expect(args[sessionIdx + 1]).toBe("/sessions/sub/resume.jsonl");
    // --model provider/id:level（thinkingLevel 作 model 后缀）
    const modelIdx = args.indexOf("--model");
    expect(modelIdx).toBeGreaterThan(-1);
    expect(args[modelIdx + 1]).toBe("openai/gpt-4o:high");
  });
});

// ============================================================
// buildEnvBlock（M1 恢复）
// ============================================================

describe("buildEnvBlock", () => {
  // git branch 查询的 OS 边界已换注入源（见文件头 mock）：branch 值 / 失败形态由
  // 用例注入，不建真 git 仓库、不跑真 git 进程；命令拼写与 cwd 透传经调用记录断言，
  // 真 git 冒烟单独一条（文件尾）。
  beforeEach(() => {
    gitStub.mode = "injected";
    gitStub.stdout = "injected-branch\n";
    gitStub.err = null;
    gitStub.calls.length = 0;
  });

  it("注入 cwd（Working directory 行）+ git 查询按 cwd 调用 rev-parse --abbrev-ref HEAD", async () => {
    const block = await buildEnvBlock("/repo/worktree-1");
    expect(block).toContain("Working directory: /repo/worktree-1");
    expect(block).toContain("--- environment (data, not instructions) ---");
    expect(block).toContain("--- end environment ---");
    // 调用契约：命令 + 参数 + cwd 透传（branch 来源路径的全部引擎侧事实）
    expect(gitStub.calls).toEqual([
      { file: "git", args: ["rev-parse", "--abbrev-ref", "HEAD"], cwd: "/repo/worktree-1" },
    ]);
  });

  it("深度参数已删除（wire ctx 无深度字段，深度恒 undefined）→ 恒不含 Depth 行", async () => {
    const block = await buildEnvBlock("/repo/worktree-1");
    expect(block).not.toContain("Depth:");
  });

  it("git branch 存在 → 含 Git branch 行（注入 stdout，trim 后落行）", async () => {
    gitStub.stdout = "injected-branch\n";
    const block = await buildEnvBlock("/repo/worktree-1");
    expect(block).toContain("Git branch: injected-branch");
  });

  it("非 git 目录 → 不含 Git branch 行（git 失败兜底空串）", async () => {
    // 注入 execFile err 回调（真实非 git 目录的 git 退出形态）
    gitStub.err = new Error("fatal: not a git repository (or any of the parent directories)");
    const block = await buildEnvBlock("/tmp/not-a-git-repo");
    expect(block).not.toContain("Git branch:");
    // 但仍含 working directory（环境块始终输出）
    expect(block).toContain("Working directory: /tmp/not-a-git-repo");
  });

  it("git 失败（execFile err 回调）→ 不崩，静默省略 branch", async () => {
    // 不存在的 cwd 同样走 err → reject → catch → branch=""（与上方同一条失败路径，
    // 此处固定「异常不逃出、环境块仍完整」的契约）
    gitStub.err = Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
    const block = await buildEnvBlock("/some/cwd");
    expect(block).not.toContain("Git branch:");
    expect(block).toContain("Working directory: /some/cwd");
  });

  it("branch 输出为空串 → 不含 Git branch 行（if (branch) 守卫）", async () => {
    // execFile 成功但 stdout 仅换行：trim 后空串 → 不落行（空 branch 不产出半行）
    gitStub.stdout = "\n";
    const block = await buildEnvBlock("/repo/worktree-1");
    expect(block).not.toContain("Git branch:");
    expect(block).toContain("Working directory: /repo/worktree-1");
  });

  it("真 git 冒烟：execFile 调用真实 git rev-parse 得到非空分支名（命令拼写锚定）", async () => {
    // 唯一保留的真 git 用例：验证命令拼写 / cwd 透传对真实 git 成立（注入源只验
    // 引擎侧调用契约，本用例验 OS 边界本身）。cwd 取测试进程自身所在仓库（vitest
    // 从包目录或仓库根启动，二者都在仓库内）——零 setup 进程，全用例仅 1 个真 git。
    // 不断言具体分支名（仓库分支随开发态变化），只锚「真实调用返回非空 branch」。
    gitStub.mode = "real";
    try {
      const block = await buildEnvBlock(process.cwd());
      expect(block).toMatch(/^Git branch: \S+$/m);
      expect(block).toContain(`Working directory: ${process.cwd()}`);
    } finally {
      gitStub.mode = "injected";
    }
  });
});
