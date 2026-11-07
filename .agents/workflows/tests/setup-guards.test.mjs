// setup-guards.test.mjs — setup 段守卫行为测试（B-1 观测层产物过期防线 + D-1 worktree
// 参数校验前移 + git 根失败归因拆分）。对抗式审查 P2-1/P2-2 补的失败分支覆盖：
// ① B-1 hash 不一致 → 终止并披露恢复动作（zcode mock 驱动 + pi 真实子进程装异内容
//    副本双路径；一致正控由 observability.test.mjs 全部产物执行用例承载——它们都必须
//    先过该守卫才能走到断言点）
// ② D-1 worktree 探针三态：missing/file 两类拒启文案（zcode mock 三态驱动 + pi 真实
//    bash 真实判定）
// ③ git 根 not a git repository 归因拆分：未传 worktree → 新归因文案；传 worktree →
//    现行通用文案（拆分条件 wt === "" 两向都钉住）
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { installObsScripts } from "./helpers/obs-home.mjs";
import { runProduct, makeMockWorldRun, productObsLayerHash } from "./helpers/run-product.mjs";

const WF = join(dirname(fileURLToPath(import.meta.url)), "..");
const PRL_ZCODE = join(WF, "..", "skills", "pr-cr-fix", "workflows", "pr-lifecycle.dwf.ts");
const PRL_PI = join(WF, "pr-lifecycle.js");
const DMG_ZCODE = join(WF, "dev-merge-gates.dwf.ts");

const PRL_HASH = productObsLayerHash(PRL_ZCODE);
const DMG_HASH = productObsLayerHash(DMG_ZCODE);
// 64 位 hex 的非内嵌值（驱动 B-1 不一致终止分支——格式合法但内容必不匹配）
const DRIFT_HASH = "deadbeef".repeat(8);
const NOT_A_REPO_STDERR = "fatal: not a git repository (or any of the parent directories): .git";

// ══ B-1：hash 不一致终止分支（zcode mock 驱动）══

test("B-1 观测层 hash 不一致 → setup-failure 终止 + 恢复动作披露（zcode mock 驱动）", async () => {
  const { runProduct } = await import("./helpers/run-product.mjs");
  await assert.rejects(
    () => runProduct(PRL_ZCODE, "zcode", {
      args: {},
      agent: async () => ({ error: "selftest-mock" }),
      world: { run: makeMockWorldRun([], { obsLayerHash: DRIFT_HASH }) },
      files: { read: async () => { throw new Error("x"); } },
    }),
    (e) => {
      const m = e instanceof Error ? e.message : String(e);
      assert.match(m, /观测层源现算 sha256=deadbeefdead…/);
      assert.match(m, /≠ 产物内嵌/);
      assert.match(m, /恢复：node \.agents\/workflows\/scripts\/build-workflows\.mjs 后重新发起/);
      return true;
    },
  );
});

// ══ D-1：worktree 探针三态（zcode mock 驱动）══

test("D-1 worktree 探针 missing → 拒启并给核对指引（zcode mock 驱动）", async () => {
  const { runProduct } = await import("./helpers/run-product.mjs");
  await assert.rejects(
    () => runProduct(PRL_ZCODE, "zcode", {
      args: { worktree: "/tmp/wf-guards-no-such" },
      agent: async () => ({ error: "selftest-mock" }),
      world: { run: makeMockWorldRun([], { obsLayerHash: PRL_HASH, wtShape: "missing" }) },
      files: { read: async () => { throw new Error("x"); } },
    }),
    /worktree 参数指向不存在的路径：\/tmp\/wf-guards-no-such（常见成因：路径写错 \/ 该 worktree 已被 cleanup）。恢复：ls <workspace 根> 核对后重新发起/,
  );
});

test("D-1 worktree 探针 file（非目录）→ 拒启（zcode mock 驱动）", async () => {
  const { runProduct } = await import("./helpers/run-product.mjs");
  await assert.rejects(
    () => runProduct(PRL_ZCODE, "zcode", {
      args: { worktree: "/tmp/wf-guards-a-file" },
      agent: async () => ({ error: "selftest-mock" }),
      world: { run: makeMockWorldRun([], { obsLayerHash: PRL_HASH, wtShape: "file" }) },
      files: { read: async () => { throw new Error("x"); } },
    }),
    /参数 worktree 指向的路径不是目录：\/tmp\/wf-guards-a-file/,
  );
});

test("D-1 dev-merge-gates worktree 探针 missing → 同款拒启（zcode mock 驱动）", async () => {
  const { runProduct } = await import("./helpers/run-product.mjs");
  await assert.rejects(
    () => runProduct(DMG_ZCODE, "zcode", {
      args: { worktree: "/tmp/wf-guards-dmg-no-such" },
      agent: async () => ({ error: "selftest-mock" }),
      world: { run: makeMockWorldRun([], { obsLayerHash: DMG_HASH, wtShape: "missing" }) },
      files: { read: async () => { throw new Error("x"); } },
    }),
    /worktree 参数指向不存在的路径：\/tmp\/wf-guards-dmg-no-such/,
  );
});

// ══ D-1：git 根失败归因拆分（zcode mock 驱动，拆分条件两向钉住）══

test("git 根解析失败 + 未传 worktree → 新归因文案（宿主目录非 git 仓库）", async () => {
  const { runProduct } = await import("./helpers/run-product.mjs");
  await assert.rejects(
    () => runProduct(PRL_ZCODE, "zcode", {
      args: {},
      agent: async () => ({ error: "selftest-mock" }),
      world: { run: makeMockWorldRun([], { obsLayerHash: PRL_HASH, gitTopLevelStderr: NOT_A_REPO_STDERR }) },
      files: { read: async () => { throw new Error("x"); } },
    }),
    /宿主会话目录不是 git 仓库（workspace 根形态）且未传 worktree 参数。恢复：CreateWorkflow args\.worktree = <feature worktree 绝对路径> 后重新发起/,
  );
});

test("git 根解析失败 + 已传 worktree → 现行通用文案（拆分条件 wt === '' 边界）", async () => {
  const { runProduct } = await import("./helpers/run-product.mjs");
  await assert.rejects(
    () => runProduct(PRL_ZCODE, "zcode", {
      args: { worktree: "/tmp/wf-guards-wt" },
      agent: async () => ({ error: "selftest-mock" }),
      world: { run: makeMockWorldRun([], { obsLayerHash: PRL_HASH, wtShape: "dir", gitTopLevelStderr: NOT_A_REPO_STDERR }) },
      files: { read: async () => { throw new Error("x"); } },
    }),
    /无法解析项目根（git rev-parse --show-toplevel 失败，exit 128）/,
  );
});

// ══ pi 真实子进程路径（bash 探针真实判定 / 异内容副本真实 hash）══

// 最小 pi runner：真 HOME 夹具（装观测层副本，可选改篡）+ 真实子进程。守卫失败路径
// 都在任何 git 调用之前，无需假 bin。
function runPiReal(productPath, { argsObj = {}, mutateLayer = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), "wf-guards-home-"));
  installObsScripts(home);
  if (mutateLayer) {
    const layer = join(home, ".agents", "scripts", "workflow-observability.shared.ts");
    writeFileSync(layer, readFileSync(layer, "utf8") + "\n// guards-test: drift line\n");
  }
  const workDir = mkdtempSync(join(tmpdir(), "wf-guards-wd-"));
  try {
    const runner = [
      'import { readFileSync } from "node:fs";',
      'import { createRequire } from "node:module";',
      `const code = readFileSync(${JSON.stringify(productPath)}, "utf8");`,
      "const logs = [];",
      `globalThis.$ARGS = ${JSON.stringify(argsObj)};`,
      'globalThis.$MODEL = "selftest-mock-model";',
      'globalThis.agent = async () => ({ error: "selftest-mock: agent 不应被走到（守卫失败在任何 agent 调用前）" });',
      "globalThis.log = (m) => logs.push(String(m));",
      "globalThis.phase = () => {};",
      "globalThis.require = createRequire(import.meta.url);",
      "let ret = null, err = null;",
      'try { ret = await eval("(async () => {\\n" + code + "\\n})()"); } catch (e) { err = String(e && e.message ? e.message : e); }',
      'console.log("@@RESULT@@" + JSON.stringify({ ret, err, logs }));',
    ].join("\n");
    const runnerPath = join(workDir, "runner.mjs");
    writeFileSync(runnerPath, runner);
    const r = spawnSync(process.execPath, [runnerPath], {
      encoding: "utf8",
      timeout: 120_000,
      cwd: workDir,
      env: { ...process.env, HOME: home },
    });
    const outLine = (r.stdout ?? "").split("\n").find((l) => l.startsWith("@@RESULT@@"));
    assert.ok(outLine, `runner 应输出结果行（stderr: ${(r.stderr ?? "").slice(0, 300)}）`);
    return JSON.parse(outLine.slice("@@RESULT@@".length));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  }
}

test("B-1 观测层 hash 不一致（pi 真实子进程装异内容副本）→ 终止 + 恢复动作", () => {
  const { err } = runPiReal(PRL_PI, { mutateLayer: true });
  assert.ok(err, "hash 不一致应 errored run");
  assert.match(err, /观测层源现算 sha256=/);
  assert.match(err, /≠ 产物内嵌/);
  assert.match(err, /恢复：node \.agents\/workflows\/scripts\/build-workflows\.mjs 后重新发起/);
});

test("D-1 worktree 探针 missing（pi 真实 bash 判定）→ 拒启文案", () => {
  const { err } = runPiReal(PRL_PI, { argsObj: { worktree: "/tmp/wf-guards-pi-no-such" } });
  assert.ok(err, "不存在路径应 errored run");
  assert.match(err, /worktree 参数指向不存在的路径：\/tmp\/wf-guards-pi-no-such/);
  assert.match(err, /恢复：ls <workspace 根> 核对后重新发起/);
});
