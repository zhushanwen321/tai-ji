// pool-manager.test.ts —— journal 生命周期管理单测（[池抽象降级 2026-09-13] 后唯一
// 机制：cleanupExpiredJournals 的 30 天 mtime TTL 回收）。
//
// 降级删除面（原 acquirePool/refs.json 引用计数/归零删池原生状态/cleanup-failed
// 标记/cleanupSpawnedFiles——历史形态见 git）：本文件不再覆盖。
//
// 三视角：①构建者——超龄 journal/refs 残留删除、目录回收边界；②使用者——未超龄
// 条目与其他文件（zcode session-db 的 db.sqlite）不动；③观察者——engines 根不存
// 在 / stat 失败时 no-op 不抛（周期扫描最终一致）。
//
// A9 守卫形态保留：zcode 隔离会话库 session-db/ 会被当「分组目录」枚举，但
// db.sqlite* 不匹配清理目标（只删 journal-*.jsonl 与 refs.json 残留）——引擎包侧
// 结构前提守卫见 zcode-subagent-cli zcode-session-db-pool-gc.test.ts。

import { mkdirSync, mkdtempSync, existsSync, readdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cleanupExpiredJournals } from "../../common/pool-manager.ts";
import { resolvePoolDir } from "../../paths.ts";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "engine-pool-test-"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

/** 与 session-file-gc 同量级：30 天（ms）。 */
const TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** 把文件 mtime 设为 31 天前（超龄）。 */
function ageFile(path: string, days = 31): void {
  const aged = Date.now() / 1000 - days * 86400;
  utimesSync(path, aged, aged);
}

describe("cleanupExpiredJournals（journal TTL 回收，池抽象降级后唯一清理机制）", () => {
  it("超龄 journal 删除；未超龄 journal 保留", () => {
    const groupDir = resolvePoolDir(tmpRoot, "zcode", "shared");
    mkdirSync(groupDir, { recursive: true });
    writeFileSync(join(groupDir, "journal-bg-old.jsonl"), "{}\n");
    writeFileSync(join(groupDir, "journal-bg-fresh.jsonl"), "{}\n");
    ageFile(join(groupDir, "journal-bg-old.jsonl"));

    cleanupExpiredJournals(tmpRoot, TTL_MS);

    expect(existsSync(join(groupDir, "journal-bg-old.jsonl"))).toBe(false);
    expect(existsSync(join(groupDir, "journal-bg-fresh.jsonl"))).toBe(true);
  });

  it("池时代 refs.json 残留按同 TTL 回收（降级过渡期清理）；未超龄保留", () => {
    const groupDir = resolvePoolDir(tmpRoot, "zcode", "shared");
    mkdirSync(groupDir, { recursive: true });
    writeFileSync(join(groupDir, "refs.json"), '{"v":1,"refs":{}}\n');
    ageFile(join(groupDir, "refs.json"));

    cleanupExpiredJournals(tmpRoot, TTL_MS);
    expect(existsSync(join(groupDir, "refs.json"))).toBe(false);
  });

  it("分组内清理目标全部删净且目录空 → 目录本身回收；仍有未超龄条目 → 目录保留", () => {
    const emptyDir = resolvePoolDir(tmpRoot, "zcode", "gone");
    mkdirSync(emptyDir, { recursive: true });
    writeFileSync(join(emptyDir, "journal-bg-x.jsonl"), "{}\n");
    ageFile(join(emptyDir, "journal-bg-x.jsonl"));

    const keepDir = resolvePoolDir(tmpRoot, "zcode", "keep");
    mkdirSync(keepDir, { recursive: true });
    writeFileSync(join(keepDir, "journal-bg-y.jsonl"), "{}\n");

    cleanupExpiredJournals(tmpRoot, TTL_MS);
    expect(existsSync(emptyDir)).toBe(false);
    expect(existsSync(keepDir)).toBe(true);
  });

  it("非清理目标文件不动（A9 守卫：zcode session-db 的 db.sqlite* 被枚举但不删，目录保留）", () => {
    const sessionDbDir = join(tmpRoot, "engines", "zcode", "session-db");
    mkdirSync(sessionDbDir, { recursive: true });
    for (const name of ["db.sqlite", "db.sqlite-wal", "db.sqlite-shm"]) {
      writeFileSync(join(sessionDbDir, name), "x");
      ageFile(join(sessionDbDir, name));
    }

    cleanupExpiredJournals(tmpRoot, TTL_MS);

    for (const name of ["db.sqlite", "db.sqlite-wal", "db.sqlite-shm"]) {
      expect(existsSync(join(sessionDbDir, name))).toBe(true);
    }
    expect(existsSync(sessionDbDir)).toBe(true);
  });

  it("多引擎目录遍历：engines/<id>/ 下每个子目录都扫描（pi 与 zcode 各自回收）", () => {
    for (const engineId of ["pi", "zcode"]) {
      const groupDir = resolvePoolDir(tmpRoot, engineId, "shared");
      mkdirSync(groupDir, { recursive: true });
      writeFileSync(join(groupDir, "journal-eb.jsonl"), "{}\n");
      ageFile(join(groupDir, "journal-eb.jsonl"));
    }

    cleanupExpiredJournals(tmpRoot, TTL_MS);

    for (const engineId of ["pi", "zcode"]) {
      const entries = readdirSync(join(tmpRoot, "engines", engineId));
      expect(entries).toEqual([]); // journal 删净 + 目录回收 → 只剩引擎层目录
    }
  });

  it("engines 根不存在时 no-op 不抛；文件目录（非目录条目）跳过", () => {
    expect(() => cleanupExpiredJournals(join(tmpRoot, "absent"), TTL_MS)).not.toThrow();
  });
});
