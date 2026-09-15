// ManifestStore — parentRecordId 落盘测试（M3a）。
//
// 验证 M3a 三条契约：
// 1. 新 record 落盘含 parentRecordId（depth>=1 subagent 读回直接父 record id）
// 2. 旧 manifest JSON（无 parentRecordId 字段）readManifest 仍有效（向后兼容）
// 3. isValidManifest 校验不改（5 必填不变，parentRecordId optional）
//
// isValidManifest 私有未 export——通过 readManifest 等价验证：readManifest 内部
// `isValidManifest(parsed) ? parsed : null`，非 null ⟺ 校验通过。不 export 私有函数
// 避免扩大公共 API 表面（M3a C1 约束：不改 isValidManifest，仅 2 行代码改动）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ManifestStore, type ManifestRecord } from "../persistence/manifest-store.ts";

/** 构造最小合法 ManifestRecord（5 必填），optional 字段按 overrides 传入。 */
function makeBaseManifest(overrides: Partial<ManifestRecord> = {}): ManifestRecord {
  return {
    id: "rec-test",
    rootSessionId: "session-main",
    agentName: "worker",
    status: "closed",
    createdAt: 1000,
    ...overrides,
  };
}

describe("ManifestStore — parentRecordId 落盘 (M3a)", () => {
  let tmpDir: string;
  let store: ManifestStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "manifest-parentid-"));
    store = new ManifestStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  // ── TC-m3a-new-record-parentid ──
  it("新 record 落盘含 parentRecordId（depth>=1 读回直接父 record id）", async () => {
    const record = makeBaseManifest({
      id: "rec-child",
      parentRecordId: "sa-parent-1",
    });
    await store.writeManifest(record);

    const readBack = await store.readManifest("rec-child");
    expect(readBack).not.toBeNull();
    expect(readBack?.parentRecordId).toBe("sa-parent-1");
  });

  it("顶层 record（parentRecordId 缺失）落盘读回仍 undefined", async () => {
    // 顶层 subagent parentRecordId=undefined（父是 main，main 无 record）
    const record = makeBaseManifest({ id: "rec-top" });
    await store.writeManifest(record);

    const readBack = await store.readManifest("rec-top");
    expect(readBack).not.toBeNull();
    expect(readBack?.parentRecordId).toBeUndefined();
  });

  // ── TC-m3a-old-manifest-compat ──
  it("旧 manifest JSON（无 parentRecordId）readManifest 返有效（isValidManifest 通过）", async () => {
    // 手写旧版本格式 manifest（无 parentRecordId 字段），模拟旧 subagent-workflow 写的磁盘文件
    const oldManifest = {
      id: "rec-old",
      rootSessionId: "session-main",
      agentName: "worker",
      status: "closed",
      createdAt: 2000,
      // 无 parentRecordId —— 旧版本写的
    };
    fs.writeFileSync(
      path.join(tmpDir, "rec-old.json"),
      JSON.stringify(oldManifest),
      "utf-8",
    );

    const readBack = await store.readManifest("rec-old");
    // readManifest 内 isValidManifest(parsed) ? parsed : null —— 非 null 即 5 必填校验通过
    expect(readBack).not.toBeNull();
    expect(readBack?.id).toBe("rec-old");
    expect(readBack?.parentRecordId).toBeUndefined();
  });

  // ── TC-m3a-isvalidmanifest-unchanged ──
  it("isValidManifest 不改：含/不含 parentRecordId 均通过（5 必填不变）", async () => {
    // isValidManifest 私有，通过 readManifest 等价验证（非 null ⟺ 校验通过）。
    // 含 parentRecordId —— 新格式
    const withParent = makeBaseManifest({
      id: "rec-with-parent",
      parentRecordId: "sa-x",
    });
    await store.writeManifest(withParent);
    expect(await store.readManifest("rec-with-parent")).not.toBeNull();

    // 不含 parentRecordId —— 仅 5 必填（旧格式 / 顶层 record）
    const minimal = {
      id: "rec-minimal",
      rootSessionId: "session-main",
      agentName: "worker",
      status: "closed",
      createdAt: 3000,
    };
    fs.writeFileSync(
      path.join(tmpDir, "rec-minimal.json"),
      JSON.stringify(minimal),
      "utf-8",
    );
    expect(await store.readManifest("rec-minimal")).not.toBeNull();
  });
});
