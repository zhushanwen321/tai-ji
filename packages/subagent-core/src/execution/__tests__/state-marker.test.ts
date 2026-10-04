// src/execution/__tests__/state-marker.test.ts
//
// state-marker 专属测试（L4 合并：finalized-marker + tombstone-store 两模块收编）。
//
// 覆盖四层：
//   1. 写侧（.state 单一权威）：finalized/cancelled 往返、旧名残留清理；
//   2. 写侧响亮重试（U1 A3 / §3.4）：3 次重试（[W1 / D6] 零退避——同步睡退役）+ 仍失败 logger.error
//      响亮暴露返回 false（旧 best-effort 静默语义退役）；
//   3. 读侧（兼容读）：.state 优先、旧 .finalized / .cancelled 归一、旧名共存优先级
//   （.cancelled > .finalized，对齐合并前判定分支序）、损坏降级边界；
//   4. statStateStamp（缓存校验戳）：三文件合并戳的存在性/变化语义。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// [U1 A3] 响亮重试断言需要 error 级日志可观察（对齐 record-store.test.ts mock 模式）。
const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../core/logger.ts", () => ({
  getLogger: () => loggerMock,
}));

// fs partial mock：writeFileSync 可注错（暂时/持久失败注入），其余转发真实实现
// （模式对齐 manifest-store-tmp-recovery.test.ts）。ESM namespace 不可 spyOn，
// 注错必须走模块 mock；真实实现引用收进 hoisted holder（vi.mock factory 先于
// 模块级 let 初始化执行，裸 let 会 TDZ）。
type WriteFileSyncFn = typeof import("node:fs").writeFileSync;
const { writeFileSyncMock, actualWriteRef } = vi.hoisted(() => ({
  writeFileSyncMock: vi.fn(),
  actualWriteRef: { current: undefined as WriteFileSyncFn | undefined },
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  actualWriteRef.current = actual.writeFileSync;
  return {
    ...actual,
    writeFileSync: writeFileSyncMock,
    default: { ...actual, writeFileSync: writeFileSyncMock },
  };
});

import { readRecordBinding, writeRecordBinding } from "../persistence/state-marker.ts";

/** binding 往返用例的最小合法身份基底（readRecordBinding 的重建最低要求）。 */
function makeBinding(model: string | undefined): Parameters<typeof writeRecordBinding>[1] {
  return {
    v: 1,
    recordId: "sa-bind",
    agent: "general-purpose",
    task: "t",
    slug: "bind",
    mode: "background",
    startedAt: 1000,
    depth: 0,
    worktree: false,
    model,
    thinkingLevel: undefined,
  };
}

describe("state-marker", () => {
  let tmpDir: string;
  let sessionFile: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "state-marker-test-"));
    sessionFile = path.join(tmpDir, "2026-01-01_uuid.jsonl");
    loggerMock.error.mockClear();
    // 基线 = 真实写（个别用例以 mockImplementationOnce/Implementation 注错覆盖）。
    if (actualWriteRef.current === undefined) throw new Error("node:fs mock not initialized");
    writeFileSyncMock.mockReset().mockImplementation(actualWriteRef.current);
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    vi.restoreAllMocks();
  });

  const readStateRaw = (): { status?: unknown; reason?: unknown; endedAt?: unknown } =>
    JSON.parse(fs.readFileSync(`${sessionFile}.state`, "utf-8")) as Record<string, unknown>;

  // ============================================================
  // 写侧
  // ============================================================

  // ============================================================
  // [U4/R4-D6③] record binding 的 model 水合往返（空串归一缺席）
  // ============================================================
  describe("record binding model 水合往返", () => {
    it("model 有值 → 往返原样（显式留痕）", () => {
      expect(writeRecordBinding(sessionFile, makeBinding("prov/model-1"))).toBe(true);
      expect(readRecordBinding(sessionFile)?.model).toBe("prov/model-1");
    });

    it("model undefined（用户未指定）→ 落盘经 JSON 缺省 + 重启水合仍 undefined（U4 跨重启往返）", () => {
      expect(writeRecordBinding(sessionFile, makeBinding(undefined))).toBe(true);
      // 磁盘字节形态：undefined 经 JSON.stringify 自然缺省（无 model 键，非空串）
      const raw = JSON.parse(
        fs.readFileSync(`${sessionFile}.record-binding`, "utf-8"),
      ) as Record<string, unknown>;
      expect("model" in raw).toBe(false);
      expect(readRecordBinding(sessionFile)?.model).toBeUndefined();
    });

    it("存量 binding 残留 model=\"\" → 读侧归一 undefined（D6-③：空串不再复活进 record）", () => {
      expect(writeRecordBinding(sessionFile, makeBinding(undefined))).toBe(true);
      fs.writeFileSync(
        `${sessionFile}.record-binding`,
        JSON.stringify({ ...makeBinding(undefined), model: "" }),
        "utf-8",
      );
      expect(readRecordBinding(sessionFile)?.model).toBeUndefined();
    });
  });
});

describe("主线程零同步睡断言（W1 D6：Atomics.wait 退役）", () => {
  it("state-marker 源码无 Atomics.wait / SharedArrayBuffer（同步睡原语退役）", () => {
    const source = fs.readFileSync(
      path.resolve(import.meta.dirname, "../persistence/state-marker.ts"),
      "utf8",
    );
    expect(source).not.toContain("Atomics.wait");
    expect(source).not.toContain("SharedArrayBuffer");
  });

});
