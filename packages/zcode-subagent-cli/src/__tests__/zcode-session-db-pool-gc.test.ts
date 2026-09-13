// zcode-session-db-pool-gc.test.ts —— 池 GC 守卫（W5 迁移改写）。
//
// 原 core 版经公共 API（acquirePool / releasePoolRef / cleanupExpiredPoolRefs）+
// spy fs 断言「TTL 扫描枚举 session-db/ 伪池但不删隔离库」——pool-manager 是 core
// 模块，行为守卫留在 core 侧原文件（过渡期双轨，deviation 登记）。引擎包侧本文件
// 钉死结构前提（设计 zcode-session-db-isolation.md D1/F11）：
//   ① 隔离库与池目录的分隔是**目录级**的——session-db/ 与任何 poolKey 池目录
//      （engines/zcode/<poolKey>/，journal 落点）互不为前缀；
//   ② journal 命名（journal-<taskId>.jsonl）与 db 文件（db.sqlite*）不同名族——
//      removeOrphanJournals 的 journal-* 匹配面对 db 文件恒不命中。
// 两条件任一破坏（未来改路径契约）时 core 侧行为守卫会先红——本文件提供引擎包内
// 的早期信号，不需要 core 依赖。

import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { resolvePoolDir, SHARED_POOL_KEY } from "@zhushanwen/subagent-engine-sdk";

import { zcodeSessionDbPath } from "../db-path.ts";

describe("池 GC 结构守卫（A9 前提：隔离库与池目录目录级分离）", () => {
  it("隔离库不在任何 poolKey 池目录之内（含 'shared' 池），亦不反向包含", () => {
    const dataDir = path.join(path.sep, "data-root");
    const sessionDb = zcodeSessionDbPath(dataDir);
    for (const poolKey of [SHARED_POOL_KEY, "builtin-provider_model", "arbitrary-pool"]) {
      const poolDir = resolvePoolDir(dataDir, "zcode", poolKey);
      // 双向前缀断言：既不在池目录下，也不把池目录包进 session-db
      expect(sessionDb.startsWith(poolDir + path.sep)).toBe(false);
      expect(poolDir.startsWith(sessionDb + path.sep)).toBe(false);
    }
  });

  it("session-db 目录名固定 'session-db'（非 poolKey 形态——池 GC 把它当伪池枚举的判据面）", () => {
    const sessionDb = zcodeSessionDbPath(path.join(path.sep, "data-root"));
    expect(path.basename(path.dirname(sessionDb))).toBe("session-db");
    // 池目录父级 = engines/zcode（与 session-db 同父、不同子——目录级分离的构造形态）
    expect(path.dirname(path.dirname(sessionDb))).toBe(
      path.dirname(resolvePoolDir(path.join(path.sep, "data-root"), "zcode", SHARED_POOL_KEY)),
    );
  });

  it("db 文件名族与 journal 名族不相交（journal-*.jsonl 匹配面对 db.sqlite* 恒不命中）", () => {
    const sessionDb = zcodeSessionDbPath(path.join(path.sep, "data-root"));
    const dbNames = [path.basename(sessionDb), `${path.basename(sessionDb)}-wal`, `${path.basename(sessionDb)}-shm`];
    for (const name of dbNames) {
      expect(name.startsWith("journal-")).toBe(false);
      expect(name.endsWith(".jsonl")).toBe(false);
    }
  });
});
