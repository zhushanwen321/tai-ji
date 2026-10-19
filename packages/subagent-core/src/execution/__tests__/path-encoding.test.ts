// src/__tests__/path-encoding.test.ts
//
// 锁定 subagent 文件族目录公式契约（[session-store-layout-inversion D2/D3]）：
// 分区键 = rootSessionId，落点 = session 存储树 `<root>/<rootSessionId>/subagents/`。
// sessions / records / model-switch 三目录同树（同一 rootSessionId 分区），随会话删除
// 整树回收；漂移会导致同一 record 的三族文件分落两棵树（GC/重建互相找不到）。
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { getSubagentModelSwitchResultsDir, getSubagentRecordsDir, getSubagentSessionDir } from "../assembly/path-encoding.ts";
import { encodeCwd, getSessionStoreDir } from "@taiji/shared/paths";

// encodeCwd 编码契约（shared 单源；runtime pi-paths re-export 同源）——编码逻辑本身
// 仍是 pi 主会话树（sessions/<encodeCwd>/）的布局规则，subagent 族不再消费它。
describe("encodeCwd", () => {
  it("encodes a normal unix absolute path", () => {
    expect(encodeCwd("/Users/x/proj")).toBe("--Users-x-proj--");
  });

  it("strips a single leading backslash", () => {
    expect(encodeCwd("\\foo")).toBe("--foo--");
  });

  it("encodes Windows drive letter (colon + backslash)", () => {
    // C:\proj → 去掉无前导分隔符 → C:\proj → : 和 \ 都替换为 - → C--proj
    expect(encodeCwd("C:\\proj")).toBe("--C--proj--");
  });

  it("encodes empty string to bare delimiter pair", () => {
    expect(encodeCwd("")).toBe("----");
  });

  it("encodes relative path with no leading separator", () => {
    expect(encodeCwd("relative/path")).toBe("--relative-path--");
  });

  it("collapses consecutive separators (forward slash)", () => {
    expect(encodeCwd("/a//b")).toBe("--a--b--");
  });

  it("collapses consecutive separators (backslash)", () => {
    expect(encodeCwd("a\\b\\c")).toBe("--a-b-c--");
  });

  it("encodes mixed separators and colon", () => {
    // /x:y\\z → 去前导 / → x:y\z → : \ → - - → x-y-z
    expect(encodeCwd("/x:y\\z")).toBe("--x-y-z--");
  });
});

const SID = "root-sid-abc123";
const DATA_DIR = "/tmp/fake-data";

describe("getSubagentSessionDir", () => {
  it("returns <root>/<rootSessionId>/subagents/sessions", () => {
    // 新布局：rootSessionId 树内分区（随会话整树回收）
    const result = getSubagentSessionDir(SID, DATA_DIR);
    expect(result).toBe(path.join(getSessionStoreDir(DATA_DIR), SID, "subagents", "sessions"));
  });

  it("partitions by rootSessionId (same sid for whole nested tree)", () => {
    // 分区键 = rootSessionId：同一根会话的所有 subagent（嵌套全层）落同一棵会话树
    const result = getSubagentSessionDir(SID, DATA_DIR);
    expect(result).toBe(getSubagentSessionDir(SID, DATA_DIR));
    const other = getSubagentSessionDir("root-sid-other999", DATA_DIR);
    expect(result).not.toBe(other);
  });

  it("rejects invalid sessionId (path traversal blocked)", () => {
    // 同域校验（shared assertPiSessionId）：路径分隔符 / 冒号（btw vid）/ .. 一律拒绝
    expect(() => getSubagentSessionDir("../escape", DATA_DIR)).toThrow();
    expect(() => getSubagentSessionDir("btw:sid", DATA_DIR)).toThrow();
    expect(() => getSubagentSessionDir("", DATA_DIR)).toThrow();
  });
});

describe("getSubagentRecordsDir", () => {
  it("returns <root>/<rootSessionId>/subagents/records", () => {
    const result = getSubagentRecordsDir(SID, DATA_DIR);
    expect(result).toBe(path.join(getSessionStoreDir(DATA_DIR), SID, "subagents", "records"));
  });

  it("shares the same session tree with getSubagentSessionDir for same sid", () => {
    // records 与 sessions 在同一棵根会话树内，仅尾段不同（records vs sessions）。
    // worktree 场景三者恒等的前提就靠这个共享分区。
    const sessions = getSubagentSessionDir(SID, DATA_DIR);
    const records = getSubagentRecordsDir(SID, DATA_DIR);
    // 共享 subagents 段：去掉尾段后剩同一路径前缀
    expect(path.dirname(sessions)).toBe(path.dirname(records));
    // 尾段不同
    expect(path.basename(sessions)).toBe("sessions");
    expect(path.basename(records)).toBe("records");
  });

  it("produces different path for different rootSessionId", () => {
    const a = getSubagentRecordsDir("root-sid-aaa111", DATA_DIR);
    const b = getSubagentRecordsDir("root-sid-bbb222", DATA_DIR);
    expect(a).not.toBe(b);
  });
});

describe("getSubagentModelSwitchResultsDir", () => {
  it("returns <root>/<rootSessionId>/subagents/model-switch（与 records 同树，§7.1.1 同源同族）", () => {
    const result = getSubagentModelSwitchResultsDir(SID, DATA_DIR);
    expect(result).toBe(path.join(getSessionStoreDir(DATA_DIR), SID, "subagents", "model-switch"));
  });

  it("shares the same session tree with getSubagentRecordsDir for same sid", () => {
    // §7.1.1 要素 3：结果目录与 records 目录同树——extension 写入侧与 runtime 读取侧
    // 共用本 helper，同源性由结构保证（两侧不同源 = 通道回执永不命中）。
    expect(path.dirname(getSubagentModelSwitchResultsDir(SID, DATA_DIR))).toBe(
      path.dirname(getSubagentRecordsDir(SID, DATA_DIR))
    );
  });
});
