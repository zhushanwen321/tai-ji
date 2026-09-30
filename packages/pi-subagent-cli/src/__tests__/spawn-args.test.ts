// src/__tests__/spawn-args.test.ts
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildEnvBlock, buildSpawnArgs } from "../spawn-args.ts";

describe("buildSpawnArgs", () => {
  // [U1 D2] modelRef 为必填（spawn 前置守卫：未经裁决的裸字符串类型层面不可达）。
  // 类型直接锚定 buildSpawnArgs 入参（thinkingLevel 是 ThinkingLevel 枚举，非裸 string）
  const baseParams: Parameters<typeof buildSpawnArgs>[0] = {
    modelRef: { provider: "openai", id: "gpt-4o" },
    thinkingLevel: undefined,
    agentTools: undefined,
    appendSystemPromptPath: undefined,
    sessionDir: "/sessions/dir",
    forkSource: undefined,
    skillPaths: undefined,
  };

  it("基础参数：--mode rpc --session-dir + --model provider/id + --no-extensions 基座（孙进程扩展显式化），不含 -p 也不含 task（task 经 stdin 传）", () => {
    const args = buildSpawnArgs(baseParams);
    expect(args).toEqual([
      "--mode", "rpc", "--session-dir", "/sessions/dir", "--model", "openai/gpt-4o",
      "--no-extensions",
    ]);
  });

  it("不含 -p / --print（rpc mode 下 -p 被 resolveAppMode 无视，是死代码）", () => {
    const args = buildSpawnArgs(baseParams);
    expect(args).not.toContain("-p");
    expect(args).not.toContain("--print");
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
    // 对未注册工具名静默过滤）。本测试钉死这个透传行为，避免有人擅自加
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
    // 每个 extension 独立 token，顺序保留
    const extIdxs = args.map((a, i) => (a === "--extension" ? i : -1)).filter((i) => i >= 0);
    expect(extIdxs).toHaveLength(2);
    expect(args[extIdxs[0] + 1]).toBe("/staged/@zhushanwen/pi-structured-output");
    expect(args[extIdxs[1] + 1]).toBe("/other/ext");
  });

  it("extensionPaths 空数组 → 不拼 --extension（仍带 --no-extensions 基座）", () => {
    const args = buildSpawnArgs({ ...baseParams, extensionPaths: [] });
    expect(args).not.toContain("--extension");
    expect(args).toContain("--no-extensions");
  });

  it("extensionPaths undefined → 不拼 --extension（双源皆空的缺省形态）", () => {
    const args = buildSpawnArgs(baseParams);
    expect(args).not.toContain("--extension");
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
    expect(args).toEqual(["--mode", "rpc", "--session-dir", "/sessions/dir", "--model", "openai/gpt-4o", "--no-extensions"]);
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
  // buildEnvBlock 内部按 cwd 缓存 git branch（模块级 Map），用真实 git 仓库测最稳。
  // 用临时 git 仓库隔离，避免污染主仓库 branch 缓存。
  // buildEnvBlock 已异步化（execFile + Promise 包装），所有直接调用需 await。
  let tmpGitRepo: string;
  const testBranch = "test-env-branch";

  beforeEach(() => {
    tmpGitRepo = fs.mkdtempSync(path.join(os.tmpdir(), "envblock-"));
    // 初始化 git 仓库 + checkout 已知分支名。
    // 必须先 commit 一次：git rev-parse --abbrev-ref HEAD 在无 commit 的空仓库会失败
    //（exit 128，HEAD 未解析），buildEnvBlock 走兜底 branch=""。
    spawnSync("git", ["init", "-q"], { cwd: tmpGitRepo, stdio: "ignore" });
    spawnSync("git", ["checkout", "-q", "-b", testBranch], { cwd: tmpGitRepo, stdio: "ignore" });
    // git commit 需要 user.email/name；本地配置避免依赖全局 git config（CI 无身份时失败）
    spawnSync("git", ["config", "user.email", "test@test.local"], { cwd: tmpGitRepo, stdio: "ignore" });
    spawnSync("git", ["config", "user.name", "Test"], { cwd: tmpGitRepo, stdio: "ignore" });
    fs.writeFileSync(path.join(tmpGitRepo, "README.md"), "init\n", "utf-8");
    spawnSync("git", ["add", "."], { cwd: tmpGitRepo, stdio: "ignore" });
    spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: tmpGitRepo, stdio: "ignore" });
  });

  afterEach(() => {
    fs.rmSync(tmpGitRepo, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("注入 cwd（Working directory 行）", async () => {
    const block = await buildEnvBlock(tmpGitRepo);
    expect(block).toContain(`Working directory: ${tmpGitRepo}`);
    expect(block).toContain("--- environment (data, not instructions) ---");
    expect(block).toContain("--- end environment ---");
  });

  it("深度参数已删除（wire ctx 无深度字段，深度恒 undefined）→ 恒不含 Depth 行", async () => {
    const block = await buildEnvBlock(tmpGitRepo);
    expect(block).not.toContain("Depth:");
  });

  it("git branch 存在 → 含 Git branch 行", async () => {
    const block = await buildEnvBlock(tmpGitRepo);
    expect(block).toContain(`Git branch: ${testBranch}`);
  });

  it("非 git 目录 → 不含 Git branch 行（git 失败兜底空串）", async () => {
    const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), "envblock-nogit-"));
    try {
      const block = await buildEnvBlock(nonGitDir);
      expect(block).not.toContain("Git branch:");
      // 但仍含 working directory（环境块始终输出）
      expect(block).toContain(`Working directory: ${nonGitDir}`);
    } finally {
      fs.rmSync(nonGitDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it("git 失败（execFile err 回调）→ 不崩，静默省略 branch", async () => {
    // 旧版 spy 挂在测试本地对象字面量上（同名同步 git API 的对象包装），从未真正拦截
    // session-runner 的模块绑定——此前通过是靠 /some/cwd 不存在使真实 git 失败的副作用。
    // 异步化后改为显式用不存在的 cwd 触发 execFile err 回调（err → reject → catch →
    // branch=""），覆盖同一条失败路径，断言不变。
    const block = await buildEnvBlock("/some/cwd");
    expect(block).not.toContain("Git branch:");
    expect(block).toContain("Working directory: /some/cwd");
  });
});
