// src/execution/__tests__/manifest-store-tmp-recovery.test.ts
//
// [U4c / G3] tmp 恢复退役（D6）：sweepTmpFiles 语义 = 全部 tmp **静默删除**——
// manifest 已是可丢可重建缓存（权威 = `.state`，重建 = RecordStore.rebuildIndexes），
// promote 半写 tmp 的恢复语义失效。断言面：
//   - 合法 JSON 的 tmp（旧 promote 分支 2 形态）也删——promote 退役的核心锚点；
//   - manifest 已存在时的陈旧 tmp（旧分支 1 形态）删；
//   - 非法 JSON 的 tmp（旧分支 3 形态）删；
//   - 返回删除计数（promote 退役后无恢复形态；公开转发链 recoverManifestTmpFiles 签名不变）；
//   - [T5④ / PS-13] per-file 容错保留：单个 tmp 删除失败（ENOENT——并发回收/外部
//     清理抢先）只 warn + 跳过，不再中断整轮。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../core/logger.ts", () => ({ getLogger: () => loggerMock }));

// fs partial mock：unlinkSync 可按路径注错，其余转发真实实现。
const { unlinkSyncMock } = vi.hoisted(() => ({ unlinkSyncMock: vi.fn() }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    unlinkSync: unlinkSyncMock,
    default: { ...actual, unlinkSync: unlinkSyncMock },
  };
});

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { ManifestStore } from "../manifest-store.ts";

const VALID_MANIFEST = {
  id: "sa-good",
  rootSessionId: "root-1",
  agentName: "general-purpose",
  createdAt: 1,
  status: "running",
};

describe("[U4c/G3] sweepTmpFiles 静默删除（promote 语义失效；H4/U5 更名收口）", () => {
  let dir: string;
  let store: ManifestStore;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "manifest-tmp-recovery-"));
    store = new ManifestStore(dir);
    // 真实 unlinkSync（mock 模块对象上的 unlinkSync 已被替换，不能自引用转发）
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    unlinkSyncMock.mockReset();
    unlinkSyncMock.mockImplementation((p: fs.PathLike) => actualFs.unlinkSync(p));
    loggerMock.warn.mockClear();
    loggerMock.error.mockClear();
    loggerMock.debug.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("合法 tmp + manifest 缺失（旧 promote 形态）→ 删而非提升（promote 退役锚点）", async () => {
    fs.writeFileSync(path.join(dir, "sa-good.json.tmp.111"), JSON.stringify(VALID_MANIFEST));
    const result = await store.sweepTmpFiles();
    // 重建源 = `.state` + rebuildIndexes——半写 tmp 不再被复活成「看似权威」的索引
    expect(result).toBe(1);
    expect(fs.existsSync(path.join(dir, "sa-good.json"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "sa-good.json.tmp.111"))).toBe(false);
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });

  it("manifest 已存在 + 非法 JSON tmp → 全删，幸存 manifest 不动", async () => {
    fs.writeFileSync(path.join(dir, "sa-stale.json"), JSON.stringify(VALID_MANIFEST));
    fs.writeFileSync(path.join(dir, "sa-stale.json.tmp.222"), "{}");
    fs.writeFileSync(path.join(dir, "sa-junk.json.tmp.333"), "not json");
    const result = await store.sweepTmpFiles();
    expect(result).toBe(2);
    expect(fs.existsSync(path.join(dir, "sa-stale.json"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "sa-stale.json.tmp.222"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "sa-junk.json.tmp.333"))).toBe(false);
  });

  it("per-file 容错保留：单个 unlink ENOENT 只 warn 跳过，不中断整轮", async () => {
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    fs.writeFileSync(path.join(dir, "sa-a.json.tmp.444"), "not json");
    fs.writeFileSync(path.join(dir, "sa-doomed.json.tmp.555"), "not json");
    const doomedPath = path.join(dir, "sa-doomed.json.tmp.555");
    unlinkSyncMock.mockImplementation((p: fs.PathLike) => {
      if (String(p) === doomedPath) {
        const err = new Error("ENOENT: file vanished") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return actualFs.unlinkSync(p);
    });

    const result = await store.sweepTmpFiles();

    // 整轮不中断：doomed 之外的 tmp 处理完
    expect(result).toBe(1);
    expect(fs.existsSync(path.join(dir, "sa-a.json.tmp.444"))).toBe(false);
    // 失败留痕（warn 级，含文件名）
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.stringContaining("sa-doomed.json.tmp.555"),
      expect.objectContaining({ detail: expect.stringContaining("ENOENT") }),
    );
    expect(loggerMock.warn).toHaveBeenCalledWith(expect.stringContaining("1 of 2 tmp file(s)"));
  });

  it("无 tmp 残留 → 零副作用零告警", async () => {
    fs.writeFileSync(path.join(dir, "sa-quiescent.json"), JSON.stringify(VALID_MANIFEST));
    const result = await store.sweepTmpFiles();
    expect(result).toBe(0);
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });
});
