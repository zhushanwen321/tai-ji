// subagent tool 路径类参数守卫测试（三通道对称审查修复 + MF-13）。
//
// 修复背景：subagent tool 的 skillPath 参数此前零校验直传 session-runner 拼
// `--skill <path>`；cwd 仅 description 声明 "Must be an absolute path" 无运行时
// 闸。schema pattern（^/）经 pi agent-loop 运行时强校验已是强制（PS-20：
// agent-loop.js:403-404 → validation.js:247-273），工具层守卫定位 = defense-in-depth
// + schema 表达力缺口——`..` 穿越语义超出 pattern 能力（^/ 放行 "/a/../b"），
// 守卫在 executeSubagent start 分支 immediate throw（与 action 枚举守卫同风格）。
//
// 本文件锁住：
//   1. skillPath / cwd 含 `..` 穿越段 → 同步 reject，service.execute 零触达
//   2. skillPath / cwd 相对路径 → 同步 reject
//   3. 合法绝对路径放行 → 参数原样透传 service.execute（守卫零误伤对照）
//
// harness（[u-5b / A-V3] 改写）：registerSubagentTool 后捕获 execute 回调直接调用。
// SubagentService 经单例访问器槽注入 fake（setSubagentService，globalThis 槽——
// executeSubagent 内 getSubagentService() 读同一槽，「守卫拒绝时 service.execute
// 零触达」的承重断言不依赖整类 mock）；pi-ai/typebox 桩改共享桩
// （src/__tests__/mocks/runtime-stubs.ts，async 工厂 + 动态 import，消费约定见
// 桩 module 头注）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 共享桩（./mocks/runtime-stubs.ts 相对本文件 = ../../__tests__/mocks/runtime-stubs.ts）：
// vi.mock 工厂提升到文件顶部，体内不能引用普通顶层变量，一律经 async 工厂 +
// 动态 import 取桩。
vi.mock("@earendil-works/pi-ai", async () => {
  const { piAiStringEnumStub } = await import("../../__tests__/mocks/runtime-stubs.ts");
  return piAiStringEnumStub();
});
vi.mock("typebox", async () => {
  const { typeboxStub } = await import("../../__tests__/mocks/runtime-stubs.ts");
  return typeboxStub;
});

import { setSubagentService } from "@zhushanwen/subagent-core";

import { registerSubagentTool } from "../../interface/subagent-tool.ts";
import { mockExtensionApi } from "@zhushanwen/subagent-core/testing/execution/__tests__/helpers/mock-extension-api.ts";

// ── 访问器槽注入 helpers ─────────────────────────────────────

/** fake service：execute 断言面（守卫拒绝 → 零触达）。 */
const { mockServiceExecute } = vi.hoisted(() => ({
  mockServiceExecute: vi.fn(),
}));

/** 重置进程级 SubagentService 单例槽（setSubagentService 不接受 null，测试清理用
 *  Symbol 直写；key 与生产 getServiceSlot 的 SERVICE_SLOT_KEY 一致）。 */
function resetServiceSlot(): void {
  const slot = Reflect.get(globalThis, Symbol.for("@zhushanwen/pi-subagents.service")) as
    | { current: unknown }
    | undefined;
  if (slot) slot.current = null;
}

// ── harness ──────────────────────────────────────────────────

type ExecuteCb = (...args: unknown[]) => Promise<unknown>;

/** 注册 tool 并捕获 execute 回调（sdk-contract 同款）。 */
function captureExecute(): ExecuteCb {
  let captured: ExecuteCb | undefined;
  const pi = mockExtensionApi({
    registerTool: (tool: unknown) => {
      captured = (tool as { execute: ExecuteCb }).execute;
    },
  });
  registerSubagentTool(pi);
  if (!captured) throw new Error("subagent tool not registered");
  return captured;
}

/** 合法 start 入参基线（守卫测试只变动 skillPath/cwd 字段）。 */
function baseParams(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { action: "start", task: "guard task", slug: "path-guard", ...over };
}

/** 合法 execute 返回值 stub（放行路径 adapter 包装用）。 */
function stubHandle() {
  return {
    mode: "background",
    subagentId: "sa-path-guard",
    sessionFile: "/tmp/session.jsonl",
    details: { slug: "path-guard", model: "test/model" },
  };
}

describe("subagent tool 路径守卫（skillPath/cwd：绝对路径 + 禁 .. 穿越）", () => {
  let execute: ExecuteCb;

  beforeEach(() => {
    vi.clearAllMocks();
    mockServiceExecute.mockResolvedValue(stubHandle());
    // 经真实单例访问器注入 fake service（executeSubagent 内 getSubagentService 读同槽）
    setSubagentService({ execute: mockServiceExecute, getCollectSyncDefault: () => "async" } as never);
    execute = captureExecute();
  });

  afterEach(() => {
    resetServiceSlot();
  });

  // ── `..` 穿越段拒绝 ──

  it("skillPath 含 .. 穿越段 → immediate reject，service.execute 零触达", async () => {
    await expect(
      execute("call-1", baseParams({ skillPath: "../../etc/passwd" }), undefined, undefined, undefined),
    ).rejects.toThrow(/skillPath must not contain '\.\.' path segments/);

    expect(mockServiceExecute).not.toHaveBeenCalled();
  });

  it("cwd 含 .. 穿越段 → immediate reject，service.execute 零触达", async () => {
    await expect(
      execute("call-2", baseParams({ cwd: "/safe/root/../../unsafe" }), undefined, undefined, undefined),
    ).rejects.toThrow(/cwd must not contain '\.\.' path segments/);

    expect(mockServiceExecute).not.toHaveBeenCalled();
  });

  // ── 相对路径拒绝（`~` 缩写不是绝对路径，一并拒）──

  it("skillPath 相对路径 → immediate reject（报错指引展开为绝对路径）", async () => {
    await expect(
      execute("call-3", baseParams({ skillPath: ".agents/skills/my-skill" }), undefined, undefined, undefined),
    ).rejects.toThrow(/skillPath must be an absolute path.*Expand '~' yourself/s);

    expect(mockServiceExecute).not.toHaveBeenCalled();
  });

  it("cwd 相对路径 → immediate reject", async () => {
    await expect(
      execute("call-4", baseParams({ cwd: "relative/dir" }), undefined, undefined, undefined),
    ).rejects.toThrow(/cwd must be an absolute path/);

    expect(mockServiceExecute).not.toHaveBeenCalled();
  });

  it("cwd `~` 缩写 → immediate reject（下游 spawn cwd 不展开 ~）", async () => {
    await expect(
      execute("call-5", baseParams({ cwd: "~/project" }), undefined, undefined, undefined),
    ).rejects.toThrow(/cwd must be an absolute path/);

    expect(mockServiceExecute).not.toHaveBeenCalled();
  });

  // ── 放行对照（守卫零误伤）──

  it("合法绝对路径 skillPath/cwd 放行，参数原样透传 service.execute", async () => {
    await execute(
      "call-ok",
      baseParams({ skillPath: "/work/project/.agents/skills/my-skill", cwd: "/work/project" }),
      undefined,
      undefined,
      undefined,
    );

    expect(mockServiceExecute).toHaveBeenCalledTimes(1);
    expect(mockServiceExecute).toHaveBeenCalledWith(
      expect.objectContaining({
        skillPath: "/work/project/.agents/skills/my-skill",
        cwd: "/work/project",
      }),
    );
  });

  it("不传 skillPath/cwd → 守卫不介入（undefined 合法缺省）", async () => {
    await execute("call-none", baseParams(), undefined, undefined, undefined);

    expect(mockServiceExecute).toHaveBeenCalledTimes(1);
  });
});
