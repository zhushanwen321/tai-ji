// src/__tests__/path-encoding.test.ts
//
// 锁定 subagent 文件族目录公式契约（[session-store-layout-inversion D2/D3]）：
// 分区键 = rootSessionId，落点 = session 存储树 `<root>/<rootSessionId>/subagents/`。
// sessions / records / model-switch 三目录同树（同一 rootSessionId 分区），随会话删除
// 整树回收；漂移会导致同一 record 的三族文件分落两棵树（GC/重建互相找不到）。
import * as path from "node:path";

import { getSubagentModelSwitchResultsDir, getSubagentRecordsDir, getSubagentSessionDir } from "../assembly/path-encoding.ts";
import { encodeCwd, getSessionStoreDir } from "@taiji/shared/paths";
import { resolveSessionContext } from "../assembly/session-context-resolver.ts";
import { ForkDepthExceededError } from "../assembly/types.ts";
import { resolveSessionStoreBase } from "../assembly/store-base.ts";
import {
	clearPiWorkflowRootSessionId,
	resolvePiWorkflowRunsDir,
	setPiWorkflowRootSessionId,
} from "../assembly/workflow-state-root.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

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
    // 同域校验（shared assertPiSessionId）：路径分隔符 / 冒号（旧 btw vid 形态）/ .. 一律拒绝
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
// 来源段：session-context-resolver.test.ts
//
// 覆盖 resolveSessionContext 全部 5 种输入组合 + ForkDepthExceededError 边界。
const AGENT_DIR = "/home/user/.pi/agent";
const ROOT_SID = "root-sid-resolver";
const MAIN_CWD = "/home/user/project";
const SESSION_FILE = "session-abc.jsonl";

function expectedSessionDir(rootSessionId: string): string {
  // [session-store-layout-inversion D2/D3] 新布局：<root>/<rootSessionId>/subagents/sessions/
  // 分区键 = rootSessionId（cwd 不再参与）；dataDir 与生产同源（env getDataDir 兜底，
  // vitest global-setup 注入 tmp）。
  return getSubagentSessionDir(rootSessionId);
}

describe("resolveSessionContext", () => {
  // ── 边界 1: fork=false, worktree=false ──
  it("fork=false, worktree=false → shouldFork=false, effectiveCwd=mainCwd", () => {
    const result = resolveSessionContext({
      fork: false,
      mainCwd: MAIN_CWD,
      rootSessionId: ROOT_SID,
    });
    expect(result.shouldFork).toBe(false);
    expect(result.forkSource).toBeUndefined();
    expect(result.effectiveCwd).toBe(MAIN_CWD);
    expect(result.sessionDir).toBe(expectedSessionDir(ROOT_SID));
  });

  // ── 边界 2: fork=true, worktree=false ──
  it("fork=true, worktree=false → shouldFork=true, forkSource=mainSessionFile", () => {
    const result = resolveSessionContext({
      fork: true,
      mainCwd: MAIN_CWD,
      mainSessionFile: SESSION_FILE,
      rootSessionId: ROOT_SID,
    });
    expect(result.shouldFork).toBe(true);
    expect(result.forkSource).toBe(SESSION_FILE);
    expect(result.effectiveCwd).toBe(MAIN_CWD);
    expect(result.sessionDir).toBe(expectedSessionDir(ROOT_SID));
  });

  // ── 边界 3: fork=false, worktree=true ──
  it("fork=false, worktreePath 提供 → effectiveCwd=worktreePath", () => {
    const worktreePath = "/tmp/pi-sub-run-42";
    const result = resolveSessionContext({
      fork: false,
      mainCwd: MAIN_CWD,
      rootSessionId: ROOT_SID,
      worktreePath,
    });
    expect(result.shouldFork).toBe(false);
    expect(result.forkSource).toBeUndefined();
    expect(result.effectiveCwd).toBe(worktreePath);
    expect(result.sessionDir).toBe(expectedSessionDir(ROOT_SID));
  });

  // ── 边界 4: fork=true, worktree=true ──
  it("fork=true, worktreePath 提供 → shouldFork=true + effectiveCwd=worktreePath", () => {
    const worktreePath = "/tmp/pi-sub-bg-7-abc";
    const result = resolveSessionContext({
      fork: true,
      mainCwd: MAIN_CWD,
      mainSessionFile: SESSION_FILE,
      rootSessionId: ROOT_SID,
      worktreePath,
    });
    expect(result.shouldFork).toBe(true);
    expect(result.forkSource).toBe(SESSION_FILE);
    expect(result.effectiveCwd).toBe(worktreePath);
    expect(result.sessionDir).toBe(expectedSessionDir(ROOT_SID));
  });

  // ── 边界 5: fork=true + parentForkDepth>=10 → 抛错 ──
  it("fork=true + parentForkDepth=10 → throws ForkDepthExceededError", () => {
    expect(() =>
      resolveSessionContext({
        fork: true,
        mainCwd: MAIN_CWD,
        mainSessionFile: SESSION_FILE,
        parentForkDepth: 10,
        rootSessionId: ROOT_SID,
      }),
    ).toThrow(ForkDepthExceededError);
  });

  it("fork=true + parentForkDepth=15 → throws ForkDepthExceededError", () => {
    expect(() =>
      resolveSessionContext({
        fork: true,
        mainCwd: MAIN_CWD,
        parentForkDepth: 15,
        rootSessionId: ROOT_SID,
      }),
    ).toThrow(ForkDepthExceededError);
  });

  // ── depth=9 不抛 ──
  it("fork=true + parentForkDepth=9 → does NOT throw", () => {
    const result = resolveSessionContext({
      fork: true,
      mainCwd: MAIN_CWD,
      mainSessionFile: SESSION_FILE,
      parentForkDepth: 9,
      rootSessionId: ROOT_SID,
    });
    expect(result.shouldFork).toBe(true);
  });

  // ── sessionDir 只按 rootSessionId 分区（effectiveCwd / worktreePath 不影响）──
  it("sessionDir keyed by rootSessionId only, unaffected by worktreePath overriding effectiveCwd", () => {
    const mainCwd = "/Users/alice/code/my-app";
    const result = resolveSessionContext({
      fork: false,
      mainCwd,
      rootSessionId: ROOT_SID,
      worktreePath: "/tmp/pi-sub-run-1",
    });
    // effectiveCwd 是 worktree checkout，但 sessionDir 与 cwd 无关——只按 rootSessionId
    // 树内分区（旧「mainCwd 编码段」语义随 session-store-layout-inversion 消亡）
    expect(result.effectiveCwd).not.toBe(mainCwd);
    expect(result.sessionDir).toBe(expectedSessionDir(ROOT_SID));
  });

  // ── [MF#5] fork=true 但主 session 文件不可用 → 抛错（不静默降级）──
  it("fork=true + mainSessionFile 缺失 → throws（不静默降级到 from-scratch）", () => {
    expect(() =>
      resolveSessionContext({
        fork: true,
        mainCwd: MAIN_CWD,
        // mainSessionFile 故意不传
        rootSessionId: ROOT_SID,
      }),
    ).toThrow(/main session file is unavailable/);
  });

  // ── 默认值：fork/worktree 未传 → undefined → false ──
  it("fork/worktree omitted → shouldFork=false", () => {
    const result = resolveSessionContext({
      mainCwd: MAIN_CWD,
      rootSessionId: ROOT_SID,
    });
    expect(result.shouldFork).toBe(false);
    expect(result.forkSource).toBeUndefined();
    expect(result.effectiveCwd).toBe(MAIN_CWD);
  });

  // ── cwd 覆盖 mainCwd（worktree=false 时）──
  it("explicit cwd overrides mainCwd when worktree=false", () => {
    const customCwd = "/tmp/custom-cwd";
    const result = resolveSessionContext({
      mainCwd: MAIN_CWD,
      cwd: customCwd,
      rootSessionId: ROOT_SID,
    });
    expect(result.effectiveCwd).toBe(customCwd);
    // sessionDir 仍用 mainCwd
    expect(result.sessionDir).toBe(expectedSessionDir(ROOT_SID));
  });
});
// 来源段：store-base.packaged-env.test.ts
/**
 * 打包态 pi 进程 env 形态回归（C-ext-31，2026-10-19 打包版 subagent 全灭事故）。
 *
 * 事故形态：打包态 pi/引擎进程持有 TAIJI_AGENT_DATA_DIR=<homedir>/.taiji（入站白名单
 * 放行）但没有 TAIJI_AGENT_PACKAGED（C-proc-09 出站 deny 清单剥除）——shared paths.ts
 * 的 C-proc-26 准入检查在该 env 组合下必抛，session_start 装配链断裂、subagent 全灭。
 * 本用例锁定的行为：同样的 env 组合下，subagent-core 的目录推导（store-base 通道 →
 * 纯公式模块）正常返回路径而不抛错。
 *
 * 全部用例只做字符串推导断言，不触 fs（不读写任何真实数据目录）。
 */
/** 复刻打包态 pi 进程 env：prod 数据目录值在场 + 打包标志被 C-proc-09 剥除。 */
function stubPackagedPiEnv(): string {
	const prodDataDir = join(homedir(), ".taiji");
	vi.stubEnv("TAIJI_AGENT_DATA_DIR", prodDataDir);
	vi.stubEnv("TAIJI_AGENT_PACKAGED", "");
	return prodDataDir;
}

describe("打包态 pi 进程 env 形态下 store-base 通道（C-ext-31 回归）", () => {

	afterEach(() => {
		vi.unstubAllEnvs();
		clearPiWorkflowRootSessionId();
	});
	it("resolveSessionStoreBase：TAIJI_AGENT_DATA_DIR 优先于缺省通道，prod 值直接采信（无准入检查）", () => {
		const prodDataDir = stubPackagedPiEnv();
		expect(resolveSessionStoreBase()).toBe(prodDataDir);
	});

	it("显式 dataDir 入参恒优先（runtime 侧调用形态不受 env 影响）", () => {
		stubPackagedPiEnv();
		expect(resolveSessionStoreBase("/tmp/whatever-data-root")).toBe("/tmp/whatever-data-root");
	});

	it("getSubagentSessionDir / getSubagentRecordsDir：同一 env 组合下正常返回存储树路径（事故形态必抛的对照面）", () => {
		const prodDataDir = stubPackagedPiEnv();
		const sid = "01a15769-1221-70d8-b7f2-0f3d62cef993";
		expect(getSubagentSessionDir(sid)).toBe(
			join(prodDataDir, "ext-sessions", sid, "subagents", "sessions"),
		);
		expect(getSubagentRecordsDir(sid)).toBe(
			join(prodDataDir, "ext-sessions", sid, "subagents", "records"),
		);
	});

	it("resolvePiWorkflowRunsDir：显式 sid 与进程级锚两形态均正常解析（session_start 装配链入口）", () => {
		const prodDataDir = stubPackagedPiEnv();
		const sid = "01a15769-1221-70d8-b7f2-0f3d62cef993";
		expect(resolvePiWorkflowRunsDir(sid)).toBe(
			join(prodDataDir, "ext-sessions", sid, "workflow", "runs"),
		);
		setPiWorkflowRootSessionId(sid);
		expect(resolvePiWorkflowRunsDir()).toBe(
			join(prodDataDir, "ext-sessions", sid, "workflow", "runs"),
		);
	});
});

describe("对照面：shared env 缺省形态在同一 env 组合下 fail-fast（通道隔离的存在理由）", () => {

	afterEach(() => {
		vi.unstubAllEnvs();
		clearPiWorkflowRootSessionId();
	});
	it("shared getDataDir 在打包态 pi env 组合下 throw（C-proc-26 准入检查）——证明两条通道确实隔离", async () => {
		stubPackagedPiEnv();
		const { getDataDir } = await import("@taiji/shared/paths");
		expect(() => getDataDir()).toThrow(/prod-admission guard/);
	});
});
