// src/execution/__tests__/helpers/subagent-service-mocks.ts
//
// SubagentService 编排层测试（execute-and-await-worktree / execute-nesting /
// nested-visibility-env-propagation / recursive-visibility-baseline 四文件）共享的
// spawn 链 mock 模块工厂。原四文件各自内联 ~85 行逐字重复的 vi.mock 工厂体（fallow
// duplication 告警），收敛到本 module 单源——桩形变更改此文件，全量消费方同步生效。
//
// 消费方式（与 __tests__/helpers/system-page-mount.ts、spawn-mock.ts 同款先例）：
// vi.mock 调用留在测试文件（mock 注册是文件作用域），import 本 module 的语句写在
// vi.mock 调用之前（工厂执行发生在被测模块链请求被 mock 模块时，届时本 module 已加载）。
//
// node:fs / ../alive-store.ts 两个工厂需要真实模块做基底（...actual 展开）：真实实现
// 经工厂的 importOriginal 参数由测试文件传入——本 module 不能顶层静态 import 它们
// （测试文件的 vi.mock 注册先于一切 import，本 module 属其依赖图，静态 import 会拿到
// mock 版自身 → 展开循环）。
//
// FakeChild 复用 ./spawn-mock.ts 的 class（结构超集：多 stdin / exitCode / signalCode
// 字段，四文件原内联 FakeChild 只访问 stdout/stderr/kill/emit，行为等价）。

import { vi } from "vitest";



import { FakeChild, emitStdoutLine, sessionHeader } from "./spawn-mock.ts";

/**
 * node:child_process mock 模块。
 * spawn → FakeChild（测试经 mockSpawn.mock.results 取回控制器）；
 * execFile → err-first 兜底（buildEnvBlock 的 git branch 调用失败 → catch → branch=""）。
 */
export function childProcessModule() {
  return {
    spawn: vi.fn(() => new FakeChild()),
    execFile: vi.fn(
      (
        _cmd: string,
        _args: readonly string[],
        _opts: unknown,
        cb: (err: Error | null, stdout?: string, stderr?: string) => void,
      ) => cb(new Error("execFile not configured in this test")),
    ),
  };
}

/**
 * node:fs mock 模块：同步方法 mock（runSpawn 用到的全部），promises 保留真实实现
 * （temp-prompt 已整体 mock，不触发真实 I/O）。default 与顶层具名是两套独立 vi.fn
 * 实例（与收敛前四文件内联形态同构）。
 */
// 显式返回类型（typeof import 表达式可命名）——否则推导的返回类型引用 fs 内部
// 未导出的 ReadStreamOptions/WriteStreamOptions，触发 TS4058 可命名性检查
export function fsSyncModule(
  actual: typeof import("node:fs"),
): {
  /** 真实 fs + 同步 mock 的合并视图（vi.mock 工厂消费面宽松） */
  default: unknown;
  promises: typeof import("node:fs")["promises"];
  mkdirSync: ReturnType<typeof vi.fn>;
  existsSync: ReturnType<typeof vi.fn>;
  appendFileSync: ReturnType<typeof vi.fn>;
  writeFileSync: ReturnType<typeof vi.fn>;
  readdirSync: ReturnType<typeof vi.fn>;
} {
  const syncMocks = () => ({
    mkdirSync: vi.fn(),
    existsSync: vi.fn(() => false),
    appendFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    readdirSync: vi.fn(() => []),
  });
  return {
    default: { ...actual, ...syncMocks() },
    ...syncMocks(),
    promises: actual.promises,
  };
}

/**
 * ../alive-store.ts mock 模块：writeAliveMarker（runSpawn 写 .alive sidecar）+
 * removeAliveMarker（finalizeRecord 收尾删 .alive）mock；其余导出保留真实实现
 * （worktree-manager / record-store 消费，本组用例不涉及但保留以避免间接报错）。
 */
export function aliveStoreModule(actual: typeof import("../../alive-store.ts")) {
  return {
    ...actual,
    writeAliveMarker: vi.fn(),
    removeAliveMarker: vi.fn(),
  };
}

/** ../state-marker.ts mock 模块（避免真实 fs 写 sidecar；读侧恒「无终态标记」，
 *  对齐原 finalized-marker mock 的 no-finalized 语义）。 */
export function stateMarkerModule() {
  return {
    writeFinalizedState: vi.fn(),
    writeCancelledState: vi.fn(),
    readStateMarker: vi.fn(() => undefined),
    statStateStamp: vi.fn(() => null),
    STATE_SIDECAR_EXT: ".state",
  };
}

/**
 * ../manifest-store.ts mock 模块。vi.fn 包裹构造器（普通 function，箭头函数不能被 new）：
 * 构造参数 recordsDir 可从 mock.calls 断言（[MF-3] 目录统一验证用）。
 * no-op 化的根因：writeManifest 真实链路的异步 console 经 worker RPC 回流，与 vitest
 * teardown 形成 race（unhandled rejection / exit 1）——本组用例测编排逻辑不测持久化。
 */
export function manifestStoreModule() {
  class FakeManifestStore {
    writeManifest = vi.fn(async () => {});
    readManifest = vi.fn(async () => null);
    listAllSync = vi.fn(() => []);
    sweepTmpFiles = vi.fn(async () => 0);
  }
  return { ManifestStore: vi.fn(function (_recordsDir: string) { return new FakeManifestStore(); }) };
}

/** temp-prompt mock 模块（固定路径，消除 fake-timers 下 flaky 竞态）。[W3] 被 mock 的 inproc temp-prompt 模块已删——本工厂仅余存量测试文件引用。 */
export function tempPromptModule() {
  return {
    writePromptToTempFile: vi.fn(async (agent: string) => {
      const safeName = agent.replace(/[^\w.-]+/g, "_");
      return { dir: `/tmp/fake-${safeName}`, filePath: `/tmp/fake-${safeName}/prompt-${safeName}.md` };
    }),
    cleanupTempPrompt: vi.fn(async () => {}),
  };
}

/**
 * 驱动 FakeChild 完成 session：写 header + 可选事件 + close(0)。
 * runSpawn 在 close 后判定 success（exitCode=0），并跑 identity 补写 + finalizeRecord
 * ——「让 runSpawn 自然 resolve」的标准收尾路径。
 */
export async function driveChildToCompletion(child: FakeChild, events: Record<string, unknown>[] = []): Promise<void> {
  emitStdoutLine(child, sessionHeader());
  for (const e of events) emitStdoutLine(child, e);
  child.stdout.end();
  child.stderr.end();
  child.emit("close", 0);
}
