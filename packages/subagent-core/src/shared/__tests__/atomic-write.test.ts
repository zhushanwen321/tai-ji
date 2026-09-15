/**
 * atomic-write 原语测试（sink 设计 U6a / B6，验收 §4 S6 的确定性子集）。
 *
 * 断言面：
 * - 正常写（sync/async、string/Uint8Array、encoding、父目录自动创建）
 * - 半截目标文件恢复语义：torn 目标被整体替换，读者只见旧版或完整新版
 * - 失败路径残留 tmp 清理语义：原错误上抛 + 自身 tmp 清除
 * - 陈旧 tmp 扫描/清理：约定形态识别、maxAgeMs 在途保护窗、幂等
 * - 并发写同目标不串写：rename 原子性下并发读永不见混合/半截内容
 *
 * 观察口径：全部经真实文件系统（临时目录），无 fs mock（对齐 TEST-STRATEGY 红线）。
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  atomicTmpPathFor,
  cleanupStaleTmpFiles,
  listStaleTmpFiles,
  parseAtomicTmpPath,
  writeAtomicFile,
  writeAtomicFileSync,
} from "../atomic-write.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "atomic-write-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

/** 目录内约定形态 tmp 残留计数（断言「无残留」用）。 */
function tmpResidue(targetDir: string): string[] {
  return readdirSync(targetDir).filter((n) => n.includes(".tmp."));
}

describe("writeAtomicFileSync 正常写", () => {
  it("字符串内容落盘，父目录缺失时自动创建（ensureDir 缺省 true）", () => {
    const target = join(dir, "nested/deep/target.json");
    writeAtomicFileSync(target, '{"a":1}');
    expect(readFileSync(target, "utf8")).toBe('{"a":1}');
  });

  it("Uint8Array 内容逐字节落盘（encoding 不适用）", () => {
    const target = join(dir, "bin/blob");
    const bytes = Uint8Array.from([0x00, 0x01, 0xff, 0xfe, 0xe6, 0xb1, 0x89]);
    writeAtomicFileSync(target, bytes);
    expect(readFileSync(target)).toEqual(Buffer.from(bytes));
  });

  it("encoding 选项生效（latin1 单字节）", () => {
    const target = join(dir, "enc.txt");
    writeAtomicFileSync(target, "é", { encoding: "latin1" });
    expect(readFileSync(target)).toEqual(Buffer.from([0xe9]));
  });

  it("ensureDir:false 且父目录缺失 → ENOENT 原样上抛", () => {
    const target = join(dir, "missing/target.txt");
    expect(() => writeAtomicFileSync(target, "x", { ensureDir: false })).toThrow(/ENOENT/);
  });

  it("写入后目录无 tmp 残留", () => {
    const target = join(dir, "t.txt");
    writeAtomicFileSync(target, "ok");
    expect(tmpResidue(dir)).toEqual([]);
  });
});

describe("writeAtomicFile 正常写（fsync 生产模式）", () => {
  it("字符串内容落盘 + 父目录自动创建", async () => {
    const target = join(dir, "a/b/c.json");
    await writeAtomicFile(target, '{"n":1}');
    expect(readFileSync(target, "utf8")).toBe('{"n":1}');
    expect(tmpResidue(dir)).toEqual([]);
  });

  it("fsyncDir:false 可关目录 fsync（弱耐久场景）", async () => {
    const target = join(dir, "fast.json");
    await writeAtomicFile(target, "fast", { fsyncDir: false });
    expect(readFileSync(target, "utf8")).toBe("fast");
  });
});

describe("半截目标文件恢复语义（S6 确定性场景）", () => {
  it("torn 目标被原子写整体替换：内容与长度精确等于新版本", () => {
    const target = join(dir, "state.json");
    writeFileSync(target, '{"half":tru', "utf8"); // 模拟非原子写半截产物
    const full = JSON.stringify({ version: 2, entries: { a: 1, b: 2 } }, null, 2);
    writeAtomicFileSync(target, full);
    const after = readFileSync(target, "utf8");
    expect(after).toBe(full);
    expect(after.length).toBe(full.length);
    expect(tmpResidue(dir)).toEqual([]);
  });

  it("async 写同样整体替换 torn 目标", async () => {
    const target = join(dir, "state2.json");
    writeFileSync(target, "{trun", "utf8");
    await writeAtomicFile(target, '{"complete":true}');
    expect(readFileSync(target, "utf8")).toBe('{"complete":true}');
  });

  it("崩溃残留 tmp 不影响新写入正确性，残留可被统一扫描+清理（恢复闭环）", () => {
    const target = join(dir, "wf-state.json");
    writeFileSync(target, "{old", "utf8");
    // 模拟上次进程死在 tmp 阶段的残留（约定形态）
    const staleTmp = atomicTmpPathFor(target);
    writeFileSync(staleTmp, '{"pid-was":9,"entries":', "utf8");

    // 新写入不受残留干扰：目标精确等于新内容
    writeAtomicFileSync(target, '{"v":3}');
    expect(readFileSync(target, "utf8")).toBe('{"v":3}');

    // 残留仍可按约定反查目标路径 → 统一入口清理
    const refs = listStaleTmpFiles(dir);
    expect(refs).toHaveLength(1);
    expect(refs[0].targetPath).toBe(target);
    expect(refs[0].tmpPath).toBe(staleTmp);
    const result = cleanupStaleTmpFiles(dir);
    expect(result.removed).toEqual([staleTmp]);
    expect(existsSync(staleTmp)).toBe(false);
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, "utf8")).toBe('{"v":3}');
  });
});

describe("写入失败残留 tmp 清理语义", () => {
  it("sync：rename 失败（目标是目录）→ 原错误上抛 + 自身 tmp 清除", () => {
    const target = join(dir, "occupied");
    mkdirSync(target);
    writeFileSync(join(target, "child.txt"), "block", "utf8"); // 非空目录确保 rename 失败
    expect(() => writeAtomicFileSync(target, "x", { ensureDir: false })).toThrow();
    expect(tmpResidue(dir)).toEqual([]);
  });

  it("async：rename 失败（目标是目录）→ 原错误 reject + 自身 tmp 清除", async () => {
    const target = join(dir, "occupied-async");
    mkdirSync(target);
    writeFileSync(join(target, "child.txt"), "block", "utf8");
    await expect(writeAtomicFile(target, "x", { ensureDir: false })).rejects.toThrow();
    expect(tmpResidue(dir)).toEqual([]);
  });
});

describe("统一 tmp 命名与扫描（B6 约定）", () => {
  it("atomicTmpPathFor 命中约定标记且同进程内唯一", () => {
    const target = join(dir, "x.json");
    const a = atomicTmpPathFor(target);
    const b = atomicTmpPathFor(target);
    expect(a).toMatch(/\.tmp\.\d+\.[0-9a-z-]+$/);
    expect(a.startsWith(`${target}.tmp.${process.pid}.`)).toBe(true);
    expect(a).not.toBe(b);
  });

  it("parseAtomicTmpPath 往返解析；目标名含 .tmp. 时前缀正确还原", () => {
    const ref = parseAtomicTmpPath("/data/x.json.tmp.4242.7-abc");
    expect(ref).toEqual({
      tmpPath: "/data/x.json.tmp.4242.7-abc",
      targetPath: "/data/x.json",
      pid: 4242,
    });
    // 目标名自身含 .tmp.：贪婪前缀还原到最近的 .tmp.<pid>.<uniq> 结构
    const tricky = parseAtomicTmpPath("/data/foo.tmp.json.tmp.42.7-abc");
    expect(tricky?.targetPath).toBe("/data/foo.tmp.json");
    // 不合约定形态（uniq 段缺 pid 后的第二段 / pid 非数字）一律不认
    expect(parseAtomicTmpPath("/data/foo.tmp.json.tmp.1-9")).toBeNull();
    expect(parseAtomicTmpPath("/data/plain.json")).toBeNull();
    expect(parseAtomicTmpPath("/data/x.tmp.notpid.txt")).toBeNull();
  });

  it("listStaleTmpFiles 只认约定形态；目录不存在返回空（宽容扫描）", () => {
    const target = join(dir, "m.json");
    writeFileSync(atomicTmpPathFor(target), "1", "utf8");
    writeFileSync(join(dir, "unrelated.txt"), "keep", "utf8");
    writeFileSync(join(dir, "m.json.tmp.notpid"), "old-format", "utf8");
    const refs = listStaleTmpFiles(dir);
    expect(refs).toHaveLength(1);
    expect(refs[0].targetPath).toBe(target);
    expect(refs[0].pid).toBe(process.pid);
    expect(listStaleTmpFiles(join(dir, "no-such-dir"))).toEqual([]);
  });

  it("cleanupStaleTmpFiles：maxAgeMs 窗口内保留（在途保护）、窗口外清除、幂等", () => {
    const now = Date.now();
    const oldTmp = atomicTmpPathFor(join(dir, "old.json"));
    const freshTmp = atomicTmpPathFor(join(dir, "fresh.json"));
    writeFileSync(oldTmp, "old", "utf8");
    writeFileSync(freshTmp, "fresh", "utf8");
    // mtime 全部确定性注入（文件系统真实 mtime 不可控）
    const oldPast = new Date(now - 60_000);
    const freshPast = new Date(now - 1_000);
    utimesSync(oldTmp, oldPast, oldPast);
    utimesSync(freshTmp, freshPast, freshPast);

    const first = cleanupStaleTmpFiles(dir, { maxAgeMs: 10_000, now });
    expect(first.removed).toEqual([oldTmp]);
    expect(first.kept).toEqual([freshTmp]);
    expect(existsSync(oldTmp)).toBe(false);
    expect(existsSync(freshTmp)).toBe(true);

    // 第二轮：fresh 已过窗 → 清除；无 maxAgeMs = 全清
    const agedPast = new Date(now - 60_000);
    utimesSync(freshTmp, agedPast, agedPast);
    const second = cleanupStaleTmpFiles(dir, { maxAgeMs: 10_000, now });
    expect(second.removed).toEqual([freshTmp]);
    const third = cleanupStaleTmpFiles(dir);
    expect(third).toEqual({ removed: [], kept: [], failed: [] });
  });
});

describe("并发写同目标不串写", () => {
  it("24 路并发 async 写 + 并发读：每次读要么旧版完整要么新版完整，绝不混合", async () => {
    const target = join(dir, "contended.json");
    const baseline = '{"i":-1,"blob":""}';
    writeFileSync(target, baseline, "utf8"); // 旧版基线
    const payloads = Array.from({ length: 24 }, (_, i) =>
      JSON.stringify({ i, blob: `x${i}`.repeat(700), tag: `payload-${i}` }),
    );

    // 读循环与写并发：每次让出 macrotask 让 async 写推进；快照只收集不判断
    const snapshots: string[] = [];
    const reader = (async () => {
      for (let k = 0; k < 120; k++) {
        try {
          snapshots.push(readFileSync(target, "utf8"));
        } catch {
          // ENOENT 理论不可达（基线先于并发段存在）；快照缺失由计数断言兜底
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    })();

    await Promise.all([...payloads.map((p) => writeAtomicFile(target, p)), reader]);
    expect(snapshots.length).toBeGreaterThan(0);

    // 每个快照字节级恰等于某一份完整版本（基线或 24 份 payload 之一）——串写/半截必产生集合外内容
    const validFulls = new Set([baseline, ...payloads]);
    for (const snap of snapshots) {
      expect(validFulls.has(snap)).toBe(true);
    }

    const final = readFileSync(target, "utf8");
    expect(payloads).toContain(final); // 终态恰为其中一份完整 payload
    expect(tmpResidue(dir)).toEqual([]); // 全部 tmp 已被各自 rename 消费
  });

  it("sync 原语串发写：终态为最后一次写入的完整内容", () => {
    const target = join(dir, "serial.json");
    const payloads = Array.from({ length: 8 }, (_, i) => JSON.stringify({ seq: i }));
    for (const p of payloads) writeAtomicFileSync(target, p);
    expect(readFileSync(target, "utf8")).toBe(payloads[payloads.length - 1]);
  });
});
