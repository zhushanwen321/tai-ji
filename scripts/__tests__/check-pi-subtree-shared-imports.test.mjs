// scripts/__tests__/check-pi-subtree-shared-imports.test.mjs
//
// [C-ext-31] pi 子树源码级 shared import 边界检查的自测（dmg-r1-4）。
//
// 门禁自身退化的风险形态：注释里的合法路径引用被误拦（现树 3 处注释即此形态，
// 误拦 = 每次提交恒红）/ 只认静态 from 漏掉动态 import() / 测试文件排除失效
// （存量 8 个测试文件 import @taiji/shared/paths，排除失效即恒红）/ 违规不列行号。
// 用临时目录 + --root 注入逐形态锁定，另跑一遍真仓锁定「当前源码干净」这条
// 回归基线（真仓被引入越界 import 时本用例转红）。
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = join(process.cwd(), "scripts/check-pi-subtree-shared-imports.mjs");
let dirs = [];

/** 造一棵 pi 子树 fixture：<root>/packages/subagent-core/src/... + <root>/extensions/...
 *  两个扫描根都先落盘（检查对扫描根缺失是 fail-fast，fixture 必须两者齐备）。 */
function makeTree(files) {
  const root = mkdtempSync(join(tmpdir(), "pi-subtree-imports-"));
  dirs.push(root);
  mkdirSync(join(root, "packages/subagent-core/src"), { recursive: true });
  mkdirSync(join(root, "extensions"), { recursive: true });
  for (const [relPath, content] of Object.entries(files)) {
    const abs = join(root, relPath);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

function run(root) {
  try {
    return { code: 0, out: execFileSync("node", [SCRIPT, "--root", root], { encoding: "utf8" }) };
  } catch (err) {
    return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  dirs = [];
});

describe("check-pi-subtree-shared-imports", () => {
  it("干净树：合法纯公式 import（session-store-paths）→ 放行", () => {
    const r = run(
      makeTree({
        "packages/subagent-core/src/execution/worktree/worktree-manager.ts":
          'import { encodeCwd, getSessionStoreDir } from "@taiji/shared/session-store-paths";\nexport const x = encodeCwd("a");\n',
      }),
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain("OK");
  });

  it("静态 import '@taiji/shared/paths' → 拦，列相对路径:行号与恢复动作", () => {
    const r = run(
      makeTree({
        "packages/subagent-core/src/execution/worktree/worktree-manager.ts":
          '// 注释先占一行\nimport { encodeCwd } from "@taiji/shared/paths";\nexport const x = encodeCwd("a");\n',
      }),
    );
    expect(r.code).toBe(1);
    expect(r.out).toContain("packages/subagent-core/src/execution/worktree/worktree-manager.ts:2");
    expect(r.out).toContain("session-store-paths");
    expect(r.out).toContain("resolveSessionStoreBase");
  });

  it("裸根 import '@taiji/shared' → 拦（包边界 + barrel 不导出 paths）", () => {
    const r = run(
      makeTree({
        "extensions/universal/plan/src/index.ts": 'import { MSG_ID_TAG_BARE_RE } from "@taiji/shared";\n',
      }),
    );
    expect(r.code).toBe(1);
    expect(r.out).toContain("extensions/universal/plan/src/index.ts:1");
    expect(r.out).toContain("@taiji/shared");
  });

  it("动态 import('@taiji/shared/paths') → 拦（与静态 from 同口径）", () => {
    const r = run(
      makeTree({
        "packages/subagent-core/src/execution/assembly/store-base.ts":
          'export async function load() {\n  const { getDataDir } = await import("@taiji/shared/paths");\n  return getDataDir();\n}\n',
      }),
    );
    expect(r.code).toBe(1);
    expect(r.out).toContain("packages/subagent-core/src/execution/assembly/store-base.ts:2");
  });

  it("多行 import 的 from 行（说明符不在 import 行）→ 拦", () => {
    const r = run(
      makeTree({
        "packages/subagent-core/src/execution/persistence/engine-journal-gc.ts":
          'import {\n  encodeCwd,\n  getSessionStoreDir,\n} from "@taiji/shared/paths";\n',
      }),
    );
    expect(r.code).toBe(1);
    expect(r.out).toContain("packages/subagent-core/src/execution/persistence/engine-journal-gc.ts:4");
  });

  it("注释里引用 '@taiji/shared/paths'（现树合法文档形态）→ 不误拦", () => {
    const r = run(
      makeTree({
        "packages/subagent-core/src/execution/assembly/store-base.ts":
          "// 为什么不能经 @taiji/shared/paths 的 env 缺省函数（getDataDir 族）：\n// 公式本体 import 自纯公式模块 '@taiji/shared/session-store-paths'。\nexport const base = 1;\n",
      }),
    );
    expect(r.code).toBe(0);
  });

  it("__tests__/*.test.ts 内的越界 import → 排除（存量测试造 packaged env 场景）", () => {
    const r = run(
      makeTree({
        "packages/subagent-core/src/execution/__tests__/path-encoding.test.ts":
          'import { encodeCwd } from "@taiji/shared/paths";\n',
      }),
    );
    expect(r.code).toBe(0);
  });

  it("真仓当前干净（无越界 import）→ 放行（回归基线，默认仓库根推导）", () => {
    let out;
    try {
      out = execFileSync("node", [SCRIPT], { encoding: "utf8" });
    } catch (err) {
      out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
      throw new Error(`真仓检出越界 shared import（C-ext-31 边界回归？）：\n${out}`);
    }
    expect(out).toContain("OK");
  });
});
