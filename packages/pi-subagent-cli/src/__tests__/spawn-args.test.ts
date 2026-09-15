// src/__tests__/spawn-args.test.ts
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { mirrorMainProcessFlags } from "../argv-mirror.ts";
import { MAX_FORK_DEPTH } from "../spawn-args.ts";
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

  it("基础参数：--mode rpc --session-dir + --model provider/id，不含 -p 也不含 task（task 经 stdin 传）", () => {
    const args = buildSpawnArgs(baseParams);
    expect(args).toEqual([
      "--mode", "rpc", "--session-dir", "/sessions/dir", "--model", "openai/gpt-4o",
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
      },
    );
    // 末尾应是最后一个 --skill 的路径（task 不再作为 positional arg 出现）
    expect(args[args.length - 1]).toBe("/skills/x");
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
  // mirrorFlags 透传：子进程镜像主进程 extension/approve flag
  // ============================================================

  it("mirrorFlags 透传：noExtensions+approve+noContextFiles+extensionPaths 全量 push（TC5）", () => {
    const args = buildSpawnArgs({
      ...baseParams,
      mirrorFlags: { noExtensions: true, approve: true, noContextFiles: true, extensionPaths: ["/e1", "/e2"] },
    });
    expect(args).toContain("--no-extensions");
    expect(args).toContain("--approve");
    expect(args).toContain("--no-context-files");
    // 每个 extension 独立 token，顺序保留
    const extIdxs = args.map((a, i) => (a === "--extension" ? i : -1)).filter((i) => i >= 0);
    expect(extIdxs).toHaveLength(2);
    expect(args[extIdxs[0] + 1]).toBe("/e1");
    expect(args[extIdxs[1] + 1]).toBe("/e2");
  });

  it("mirrorFlags 全 false/空 → 不追加任何目标 flag（TC6）", () => {
    const args = buildSpawnArgs({
      ...baseParams,
      mirrorFlags: { noExtensions: false, approve: false, noContextFiles: false, extensionPaths: [] },
    });
    expect(args).not.toContain("--no-extensions");
    expect(args).not.toContain("--approve");
    expect(args).not.toContain("--extension");
    expect(args).not.toContain("--no-context-files");
    // 仅基础参数
    expect(args).toEqual(["--mode", "rpc", "--session-dir", "/sessions/dir", "--model", "openai/gpt-4o"]);
  });

  it("mirrorFlags undefined → 行为等同旧版（TC7）", () => {
    const args = buildSpawnArgs(baseParams);
    expect(args).toEqual(["--mode", "rpc", "--session-dir", "/sessions/dir", "--model", "openai/gpt-4o"]);
    expect(args).not.toContain("--extension");
    expect(args).not.toContain("--no-extensions");
    expect(args).not.toContain("--approve");
    expect(args).not.toContain("--no-context-files");
  });

  it("noContextFiles 镜像：主进程 argv 含 --no-context-files → 子进程 args 含该 flag", () => {
    // 端到端链路断言：主 pi 进程以 --no-context-files 启动（用户 opt-out context files）
    // → mirrorMainProcessFlags 解析 → buildSpawnArgs 产出同 flag 给每个 subagent。
    // 缺此镜像时，--extension 镜像带入的 @zhushanwen/pi-system-prompt 检查子进程
    // 自己的 argv（无 flag）→ 全局 AGENTS.md 注入在 subagent system prompt 照常生效，
    // 用户 opt-out 被绕过。
    const mainArgv = [
      "bun", "/pi", "--mode", "rpc", "--no-context-files",
      "--extension", "/staged/@zhushanwen/pi-system-prompt/index.js",
    ];
    const args = buildSpawnArgs({ ...baseParams, mirrorFlags: mirrorMainProcessFlags(mainArgv) });
    expect(args).toContain("--no-context-files");
    // extension 镜像照常（两者共存才构成完整契约）
    const extIdx = args.indexOf("--extension");
    expect(args[extIdx + 1]).toBe("/staged/@zhushanwen/pi-system-prompt/index.js");
  });

  it("noContextFiles 不镜像：主进程 argv 不含 flag → 子进程 args 不含（默认行为不变）", () => {
    const mainArgv = ["bun", "/pi", "--mode", "rpc"];
    const args = buildSpawnArgs({ ...baseParams, mirrorFlags: mirrorMainProcessFlags(mainArgv) });
    expect(args).not.toContain("--no-context-files");
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
    expect(args).toEqual(["--mode", "rpc", "--session-dir", "/sessions/dir", "--model", "openai/gpt-4o"]);
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
// mirrorMainProcessFlags：从主进程 argv 解析可镜像的 flag
// ============================================================

describe("mirrorMainProcessFlags", () => {
  it("--extension 多次出现（空格分隔）+ 布尔 flag（TC1）", () => {
    const r = mirrorMainProcessFlags([
      "bun", "/pi", "--mode", "rpc", "--no-extensions", "--approve",
      "--extension", "/a", "--extension", "/b",
    ]);
    expect(r).toEqual({ noExtensions: true, approve: true, extensionPaths: ["/a", "/b"], noContextFiles: false });
  });

  it("--extension=path 等号形式 + 短形式 -e/-ne/-a（TC2）", () => {
    const r = mirrorMainProcessFlags([
      "bun", "/pi", "--extension=/x", "-ne", "-a",
    ]);
    expect(r).toEqual({ noExtensions: true, approve: true, extensionPaths: ["/x"], noContextFiles: false });
  });

  it("混合形式（空格 + 等号），顺序保留（TC3）", () => {
    const r = mirrorMainProcessFlags([
      "bun", "/pi", "--extension", "/a", "--extension=/b", "--extension", "/c",
    ]);
    expect(r.extensionPaths).toEqual(["/a", "/b", "/c"]);
    expect(r.noExtensions).toBe(false);
    expect(r.approve).toBe(false);
    expect(r.noContextFiles).toBe(false);
  });

  it("无目标 flag → 全空/全 false（向后兼容，TC4）", () => {
    const r = mirrorMainProcessFlags(["bun", "/pi", "--mode", "rpc"]);
    expect(r).toEqual({ noExtensions: false, approve: false, extensionPaths: [], noContextFiles: false });
  });

  it("--no-context-files 长形式解析 → noContextFiles: true", () => {
    const r = mirrorMainProcessFlags([
      "bun", "/pi", "--mode", "rpc", "--no-context-files",
      "--extension", "/staged/@zhushanwen/pi-system-prompt/index.js",
    ]);
    expect(r.noContextFiles).toBe(true);
    // 与 extension 镜像共存（实际 taiji 启动形态：两 flag 同时出现）
    expect(r.extensionPaths).toEqual(["/staged/@zhushanwen/pi-system-prompt/index.js"]);
    expect(r.noExtensions).toBe(false);
    expect(r.approve).toBe(false);
  });

  it("-nc 短形式解析 → noContextFiles: true（pi CLI 等价短形式）", () => {
    const r = mirrorMainProcessFlags(["bun", "/pi", "--mode", "rpc", "-nc"]);
    expect(r.noContextFiles).toBe(true);
  });

  it("不误吃其他 flag 值与 positional 参数（TC8）", () => {
    const r = mirrorMainProcessFlags([
      "bun", "/pi", "--no-extensions", "--skill", "/sk", "some prompt text",
    ]);
    expect(r.noExtensions).toBe(true);
    expect(r.extensionPaths).toEqual([]);
    // --skill 的 /sk 不混入 extensionPaths；positional prompt 被忽略
  });

  it("空 argv / 仅前导两项 → 全空", () => {
    expect(mirrorMainProcessFlags([])).toEqual({ noExtensions: false, approve: false, extensionPaths: [], noContextFiles: false });
    expect(mirrorMainProcessFlags(["bun", "/pi"])).toEqual({
      noExtensions: false, approve: false, extensionPaths: [], noContextFiles: false,
    });
  });

  it("--extension 末尾无值 → 跳过（不越界、不误吃下一个 token）", () => {
    const r = mirrorMainProcessFlags(["bun", "/pi", "--extension"]);
    expect(r.extensionPaths).toEqual([]);
  });

  it("-e 短形式多次 + 等号混用", () => {
    const r = mirrorMainProcessFlags(["bun", "/pi", "-e", "/a", "-e=/b", "-e", "/c"]);
    expect(r.extensionPaths).toEqual(["/a", "/b", "/c"]);
  });

  // [MF-7a] flag 判定收窄为 startsWith("--")：单 - 开头的合法路径不被误判为 flag。
  it("[MF-7a] - 开头的路径被当值镜像（不误判 flag）", () => {
    const r = mirrorMainProcessFlags(["bun", "/pi", "--extension", "-weird-dir/ext.js"]);
    expect(r.extensionPaths).toEqual(["-weird-dir/ext.js"]);
  });

  // [MF-7a] -- 开头的真 flag 仍正确跳过：--extension 后跟 --flag 时不吃值、不越界。
  it("[MF-7a] --extension 后跟 -- 开头真 flag → 不吃值", () => {
    const r = mirrorMainProcessFlags([
      "bun", "/pi", "--extension", "--approve", "--extension", "/real.js",
    ]);
    expect(r.extensionPaths).toEqual(["/real.js"]);
    expect(r.approve).toBe(true);
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

  it("forkDepth > 0 → 含 Depth: N/<MAX>", async () => {
    const block = await buildEnvBlock(tmpGitRepo, 3);
    expect(block).toContain(`Depth: 3/${MAX_FORK_DEPTH}`);
  });

  it("forkDepth === 0 → 不含 depth 行", async () => {
    const block = await buildEnvBlock(tmpGitRepo, 0);
    expect(block).not.toContain("Depth:");
  });

  it("forkDepth undefined → 不含 depth 行", async () => {
    const block = await buildEnvBlock(tmpGitRepo);
    expect(block).not.toContain("Depth:");
  });

  // [M9] nestingDepth：取 max(forkDepth, nestingDepth) 展示更严约束。
  it("forkDepth < nestingDepth → 展示 max（nestingDepth 更严）", async () => {
    // forkDepth=1（最内 fork），nestingDepth=5（通用嵌套已深）→ 展示 5
    const block = await buildEnvBlock(tmpGitRepo, 1, 5);
    expect(block).toContain(`Depth: 5/${MAX_FORK_DEPTH}`);
    expect(block).not.toContain(`Depth: 1/${MAX_FORK_DEPTH}`);
  });

  it("forkDepth > nestingDepth → 展示 max（forkDepth 更严）", async () => {
    const block = await buildEnvBlock(tmpGitRepo, 7, 2);
    expect(block).toContain(`Depth: 7/${MAX_FORK_DEPTH}`);
  });

  it("forkDepth=0 + nestingDepth>0 → 展示 nestingDepth（非 fork 嵌套也计入）", async () => {
    // 非 fork 但有嵌套（如顶层 → 子 → 孙），nestingDepth=2 应展示
    const block = await buildEnvBlock(tmpGitRepo, undefined, 2);
    expect(block).toContain(`Depth: 2/${MAX_FORK_DEPTH}`);
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
