// check-rfl-parity.mjs 行为测试（机器锁步守卫的自测：守卫本身退化为恒绿 = 无守卫）。
//
// 方法：脚本以子进程形态跑（node scripts/check-rfl-parity.mjs），用 PI_RFL / ZCODE_RFL
// 环境变量指向 tmp 夹具，验证四种判定：
//   ① 一致 → exit 0
//   ② zcode 侧调度算法退化（去重丢失，pi 已修的 claimed 不变量在 zcode 缺失）→ exit 1
//   ③ zcode 侧池常量漂移（关键词漏改）→ exit 1
//   ④ pi 侧文件缺失 → exit 1（结构前提缺失不得静默通过）
// 夹具直接从仓库内真实文件派生（读取后改写），因此断言的是「守卫能否抓住真实形态的漂移」，
// 而不是「守卫能否处理人造玩具输入」。

import { execFile } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes as stripTs } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

/** Node 内置 TS 类型擦除（.dwf.ts 是 TS，不能直接 import）：包一层便于统一改写。 */
function stripTypeScriptTypesForTest(code: string): string {
  return stripTs(code, { mode: "strip" });
}

const run = promisify(execFile);
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const GUARD = join(REPO_ROOT, "scripts", "check-rfl-parity.mjs");
const PI_UTILS = join(REPO_ROOT, "packages", "subagent-core", "workflows", "review-fix-loop-utils.cjs");
const ZCODE_DWF = join(process.env.HOME ?? "", ".zcode", "workflows", "review-fix-loop.dwf.ts");

interface GuardResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** 跑守卫（永不 reject：退出码是断言对象）。 */
async function runGuard(env: Record<string, string>): Promise<GuardResult> {
  try {
    const res = await run("node", [GUARD], {
      env: { ...process.env, ...env },
    });
    return { code: 0, stdout: res.stdout, stderr: res.stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof err.code === "number" ? err.code : -1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

/**
 * zcode 夹具：从真实 .dwf.ts 截取调度相关片段（评审本机可能没有 zcode 安装——夹具缺失时
 * 用仓库内 pi 侧源码形态合成一个等价片段，保证守卫自测在任何机器上都可跑）。
 * @param mutate 对片段文本做改写（注入漂移）
 */
function buildZcodeFixture(dir: string, mutate?: (src: string) => string): string {
  const snippet = [
    "const REVIEWER_BATCH = 4;",
    "const FIXER_CONCURRENCY = 3;",
    "const SLOW_POOL = ['extension-api', 'data-governance', 'arch-boundary'];",
    "const FAST_POOL = ['electron-build', 'type-safety', 'test-coverage'];",
    "const DRIFTER_POOL = ['business-logic', 'monorepo-impact'];",
    "const SLOW_PKG_THRESHOLD = 5;",
    "const SLOW_CHURN_THRESHOLD = 3000;",
    "interface DiffStats { files: string[]; churnLines: number; pkgCount: number }",
    "function drifterSlowScore(name: string, diffStats: DiffStats | null): number {",
    "  if (!diffStats) return 0;",
    "  if (name.includes('monorepo-impact')) return diffStats.pkgCount / SLOW_PKG_THRESHOLD;",
    "  if (name.includes('business-logic')) return diffStats.churnLines / SLOW_CHURN_THRESHOLD;",
    "  return 0;",
    "}",
    "function planReviewerOrder<T extends { name: string }>(items: T[], diffStats: DiffStats | null): { order: T[]; slowBatch: T[]; fastBatch: T[]; note: string } {",
    "  const claimed = new Set<number>();",
    "  const inPool = (keys: string[]) => {",
    "    const pool: T[] = [];",
    "    for (const k of keys) {",
    "      for (let i = 0; i < items.length; i++) {",
    "        if (claimed.has(i)) continue;",
    "        if (typeof items[i]!.name === 'string' && items[i]!.name.includes(k)) { claimed.add(i); pool.push(items[i]!); }",
    "      }",
    "    }",
    "    return pool;",
    "  };",
    "  const slow = inPool(SLOW_POOL);",
    "  const fast = inPool(FAST_POOL);",
    "  const drifters = inPool(DRIFTER_POOL);",
    "  const sortedDrifters = [...drifters].sort((a, b) => drifterSlowScore(b.name, diffStats) - drifterSlowScore(a.name, diffStats));",
    "  const batch1 = slow.slice(0, 3);",
    "  const batch2 = fast.slice(0, 3);",
    "  const tail = [...sortedDrifters, ...items.filter((_, i) => !claimed.has(i)), ...slow.slice(3), ...fast.slice(3)];",
    "  batch1.push(...tail.splice(0, Math.max(0, REVIEWER_BATCH - batch1.length)));",
    "  batch2.push(...tail.splice(0, Math.max(0, REVIEWER_BATCH - batch2.length)));",
    "  const slowDrifter = batch1.find((it) => DRIFTER_POOL.some((k) => it.name.includes(k))) ?? null;",
    "  const note = diffStats ? `pkg=${diffStats.pkgCount}/${SLOW_PKG_THRESHOLD} churn=${diffStats.churnLines}/${SLOW_CHURN_THRESHOLD} → ${slowDrifter ? slowDrifter.name + ' 进慢批动态位' : '无漂移者在场'}` : '无 diff 形态数据（探测失败），漂移者按默认池序';",
    "  return { order: [...batch1, ...batch2, ...tail], slowBatch: [...batch1], fastBatch: [...batch2], note };",
    "}",
    "void FIXER_CONCURRENCY;",
  ].join("\n");
  const src = mutate ? mutate(snippet) : snippet;
  const p = join(dir, "review-fix-loop.dwf.ts");
  writeFileSync(p, src, "utf8");
  return p;
}

let dir = "";
let piCopy = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rfl-parity-guard-"));
  piCopy = join(dir, "pi-utils.cjs");
  copyFileSync(PI_UTILS, piCopy);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

describe("check-rfl-parity.mjs（双实现锁步守卫行为）", () => {
  it("两侧一致 → exit 0（夹具即真实 pi 源码，验证守卫对真实形态恒绿）", async () => {
    const zcode = buildZcodeFixture(dir);
    const res = await runGuard({ PI_RFL: piCopy, ZCODE_RFL: zcode, RFL_REQUIRE_ZCODE: "1" });
    expect(res.stderr).not.toContain("DRIFT"); // 上限断言：不得报漂移
    expect(res.code, "一致应通过，实际输出：\n" + res.stdout + res.stderr).toBe(0);
    expect(res.stdout).toContain("OK");
  });

  it("zcode 侧去重不变量退化（claimed 缺失 → 同一 reviewer 双跑）→ exit 1", async () => {
    // 复刻 2026-09-20 实测的漂移形态：flatMap 归类 + matched 只用于尾部过滤
    const zcode = buildZcodeFixture(dir, (src) => {
      const broken = src
        .replace("const claimed = new Set<number>();", "const matched = new Set<T>();")
        .replace(
          /  const inPool = \(keys: string\[\]\) => \{[\s\S]*?\n  \};\n/,
          "  const inPool = (keys: string[]) => keys.flatMap((k) => items.filter((it) => it.name.includes(k)));\n",
        )
        .replace("const slow = inPool(SLOW_POOL);", "const slow = inPool(SLOW_POOL); for (const it of slow) matched.add(it);")
        .replace("const fast = inPool(FAST_POOL);", "const fast = inPool(FAST_POOL); for (const it of fast) matched.add(it);")
        .replace("const drifters = inPool(DRIFTER_POOL);", "const drifters = inPool(DRIFTER_POOL); for (const it of drifters) matched.add(it);")
        .replace("...items.filter((_, i) => !claimed.has(i))", "...items.filter((it) => !matched.has(it))");
      return broken;
    });
    const res = await runGuard({ PI_RFL: piCopy, ZCODE_RFL: zcode, RFL_REQUIRE_ZCODE: "1" });
    expect(res.code, "漂移必须被拦截；实际输出：\n" + res.stdout + res.stderr).toBe(1);
    expect(res.stderr + res.stdout).toContain("FAIL");
  });

  it("zcode 侧池常量漂移（SLOW_POOL 漏一个关键词）→ exit 1（行为 + 常量双通道命中）", async () => {
    const zcode = buildZcodeFixture(dir, (src) =>
      src.replace("const SLOW_POOL = ['extension-api', 'data-governance', 'arch-boundary'];", "const SLOW_POOL = ['extension-api', 'data-governance'];"),
    );
    const res = await runGuard({ PI_RFL: piCopy, ZCODE_RFL: zcode, RFL_REQUIRE_ZCODE: "1" });
    expect(res.code).toBe(1);
    const out = res.stderr + res.stdout;
    expect(out).toContain("SLOW_POOL");
  });

  it("zcode 侧阈值漂移（SLOW_CHURN_THRESHOLD 3000→5000）→ exit 1", async () => {
    const zcode = buildZcodeFixture(dir, (src) =>
      src.replace("const SLOW_CHURN_THRESHOLD = 3000;", "const SLOW_CHURN_THRESHOLD = 5000;"),
    );
    const res = await runGuard({ PI_RFL: piCopy, ZCODE_RFL: zcode, RFL_REQUIRE_ZCODE: "1" });
    expect(res.code).toBe(1);
    expect(res.stderr + res.stdout).toContain("SLOW_CHURN_THRESHOLD");
  });

  it("pi 侧文件缺失 → exit 1（结构前提缺失不得静默通过）", async () => {
    const zcode = buildZcodeFixture(dir);
    const res = await runGuard({ PI_RFL: join(dir, "does-not-exist.cjs"), ZCODE_RFL: zcode });
    expect(res.code).toBe(1);
    expect(res.stderr + res.stdout).toContain("pi 侧镜像文件缺失");
  });

  it("zcode 侧文件缺失且未强制 → SKIP + exit 0（非 zcode 环境不阻塞开发者）", async () => {
    const res = await runGuard({ PI_RFL: piCopy, ZCODE_RFL: join(dir, "absent-dwf.ts"), RFL_REQUIRE_ZCODE: "" });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("SKIP");
  });

  it("zcode 侧文件缺失且强制 → exit 1（本地强制口径）", async () => {
    const res = await runGuard({ PI_RFL: piCopy, ZCODE_RFL: join(dir, "absent-dwf.ts"), RFL_REQUIRE_ZCODE: "1" });
    expect(res.code).toBe(1);
  });

  it("本机真实 zcode 副本（若存在）与 pi 一致：作为集成断言，防夹具与真实形态脱节", async () => {
    const hasReal = (() => {
      try {
        readFileSync(ZCODE_DWF, "utf8");
        return true;
      } catch {
        return false;
      }
    })();
    if (!hasReal) return; // 无 zcode 安装：跳过（夹具路径已覆盖判定逻辑）
    const res = await runGuard({ PI_RFL: piCopy, ZCODE_RFL: ZCODE_DWF, RFL_REQUIRE_ZCODE: "1" });
    expect(res.code, "真实 zcode 副本与 pi 已漂移：\n" + res.stdout + res.stderr).toBe(0);
  });
});

// ── A14 身份对齐（zcode 侧）：L1 标题守卫 + L2 归一算法与 pi 对齐 ──
// 调度有 parity 守卫护住，身份对齐目前没有对等物；此组用「从 .dwf.ts 抽片段求值」的方式
// 把它钉住：① 不剥标点（归一越激进误合并越高）；② 短标题不参与（TITLE_MATCH_MIN）；
// ③ 前缀互含在「两边都够长」时兼容——用于 L1 编号撞车守卫（防新问题排到旧号被静默销账）。
// 真实 zcode 副本缺失时整组跳过（非 zcode 环境无第二实现可校准）。
describe("zcode 身份对齐算法（A14：标题归一 + 兼容判定）", () => {
  interface IdentityApi {
    TITLE_MATCH_MIN: number;
    titleUnits: (t: string) => number;
    normalizeTitle: (t: string) => string;
    titlesCompatible: (a: string, b: string) => boolean;
  }

  async function loadIdentityApi(): Promise<IdentityApi | null> {
    let src: string;
    try {
      src = readFileSync(ZCODE_DWF, "utf8");
    } catch {
      return null; // 无 zcode 安装：跳过
    }
    const start = src.indexOf("const TITLE_MATCH_MIN");
    if (start < 0) throw new Error("A14 抽取失败：找不到 TITLE_MATCH_MIN 声明（函数改名/移动？）");
    const fnMarker = "const titlesCompatible";
    const fnStart = src.indexOf(fnMarker, start);
    if (fnStart < 0) throw new Error("A14 抽取失败：找不到 titlesCompatible");
    // 花括号配平截完整函数（含返回类型标注的形态由配平自行跳过多层）
    const open = src.indexOf("{", src.indexOf(")", fnStart));
    let depth = 0;
    let close = -1;
    for (let i = open; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") {
        depth--;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    if (close < 0) throw new Error("A14 抽取失败：titlesCompatible 花括号不配平");
    const block = src.slice(start, close + 1).replace("void isCjk;", "");
    const js = stripTypeScriptTypesForTest(block)
      + "\nexport const api = { TITLE_MATCH_MIN, titleUnits, normalizeTitle, titlesCompatible };\n";
    const mod = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
    return mod.api as IdentityApi;
  }

  it("L2 归一只折叠空白与大小写，不剥标点（剥标点会把不同问题误合并）", async () => {
    const api = await loadIdentityApi();
    if (!api) return;
    expect(api.normalizeTitle("Fix:  Coverage-Gate Fails!")).toBe("fix: coverage-gate fails!");
  });

  it("短标题不参与匹配（TITLE_MATCH_MIN=5，CJK 计 2 单位）", async () => {
    const api = await loadIdentityApi();
    if (!api) return;
    expect(api.TITLE_MATCH_MIN).toBe(5);
    expect(api.titleUnits("评审循环")).toBe(8); // 4 CJK × 2
    expect(api.titlesCompatible("a b", "c d")).toBe(false);
  });

  it("L1 安全网：同前缀但确属不同问题时不得判为兼容（防新问题被当作旧条目的延续而静默销账）", async () => {
    const api = await loadIdentityApi();
    if (!api) return;
    // 两边都够长、前缀相同但尾段不同——必须是 false（这是 A14 修的核心风险点）
    expect(api.titlesCompatible(
      "renderer scroll resets on session switch",
      "renderer scroll resets on window resize",
    )).toBe(false);
  });

  it("对照：完全相等（含大小写/空白差异）判兼容", async () => {
    const api = await loadIdentityApi();
    if (!api) return;
    expect(api.titlesCompatible("Fix:  Coverage Gate Fails", "fix: coverage gate fails")).toBe(true);
  });
});
