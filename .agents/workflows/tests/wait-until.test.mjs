// wait-until.test.mjs — 通用条件等待 workflow 行为测试：双平台产物真实执行
// （pi 产物真实子进程 + 真实文件系统 / 临时 git 仓；zcode 产物经 mock world 应答
// wait-until 的 bash 包装形态 ["-c", 'cd "$1" && shift && exec "$@"', "_", cwd, cmd, ...argv]）。
// 覆盖：立即满足（done 报告）/ 超时停回（带终态停回报告）/ git-ancestor 的 merged 与
// gone（分支已删）两形态 / file-contains / 参数 fail-fast（未知参数、非法原语、非法数字）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const WF = join(dirname(fileURLToPath(import.meta.url)), "..");
const WAIT_PI = join(WF, "wait-until.js");
const WAIT_ZCODE = join(WF, "wait-until.dwf.ts");

async function runPi(argsObj) {
  const { runProduct } = await import("./helpers/run-product.mjs");
  const logs = [];
  const ret = await runProduct(WAIT_PI, "pi", { $ARGS: argsObj, log: (m) => logs.push(String(m)) });
  return { ...ret, logs };
}

async function runZcode(argsObj) {
  const { runProduct } = await import("./helpers/run-product.mjs");
  const logs = [];
  const worldCalls = [];
  // wait-until 专属 mock：只应答其 bash 包装形态；存在性按 mockPaths 集合判定
  const mockPaths = new Set();
  const world = {
    run: async (cmd, argsArr, _opts) => {
      const res = (exitCode, stdout = "", stderr = "") => ({ exitCode, stdout, stderr });
      if (cmd !== "bash" || argsArr[0] !== "-c" || argsArr[2] !== "_") {
        return res(1, "", "selftest-mock: 非 wait-until bash 包装形态: " + cmd);
      }
      const argv = argsArr.slice(4);
      const real = String(argv[0]);
      worldCalls.push([real, ...argv.slice(1)]);
      if (real === "sleep") return res(0);
      if (real === "test") return res(mockPaths.has(String(argv[2])) ? 0 : 1);
      if (real === "grep") return res(mockPaths.has("contains:" + String(argv[4])) ? 0 : 1);
      if (real === "git") {
        // argv 形态：["git", "--git-dir=<v>", "merge-base", "--is-ancestor", branch, target]
        const mb = argv.indexOf("merge-base");
        // 分支不存在时真实 git 返回 128（非 1 = 存在但未并入）——mock 按真实退出码模拟
        if (mb !== -1) return res(argv[mb + 2] === "feat-gone" ? 128 : 0);
        if (argv.indexOf("rev-parse") !== -1) return res(1);
        return res(0);
      }
      return res(0);
    },
  };
  const ret = await runProduct(WAIT_ZCODE, "zcode", {
    args: argsObj,
    world,
    artifact: { table: () => {} },
    log: (m) => logs.push(String(m)),
  });
  return { ...ret, logs, worldCalls, mockPaths };
}

test("pi 产物：立即满足 → done 报告（file-present + dir-absent 组合，起点即完成零轮询）", async () => {
  const home = mkdtempSync(join(tmpdir(), "wf-wait-"));
  try {
    const hit = join(home, "marker.txt");
    writeFileSync(hit, "x");
    const ret = await runPi({
      targetLabel: "测试立即满足",
      checks: [
        { type: "file-present", path: hit },
        { type: "dir-absent", path: join(home, "never-exists") },
      ],
      pollSeconds: 5,
      maxRounds: 3,
    });
    assert.match(ret.conclusion, /完成/, "结论应为完成：" + ret.conclusion);
    assert.match(ret.conclusion, /测试立即满足/, "结论应含 targetLabel");
    assert.equal(ret.findings.length, 2);
    for (const f of ret.findings) {
      assert.equal(f.status, "verified");
      assert.match(f.what, /终态：满足/);
    }
    assert.ok(!ret.logs.some((l) => l.includes("超时")), "立即满足不应有超时文案");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("pi 产物：超时停回 → 结论含超时与各条件终态，不进入后续流程", async () => {
  const home = mkdtempSync(join(tmpdir(), "wf-wait-"));
  try {
    const missing = join(home, "never-appears.txt");
    const ret = await runPi({
      targetLabel: "测试超时停回",
      checks: [{ type: "file-present", path: missing }],
      pollSeconds: 5,
      maxRounds: 2,
    });
    assert.match(ret.conclusion, /超时/, "结论应为超时：" + ret.conclusion);
    assert.match(ret.conclusion, /未满足/);
    assert.equal(ret.findings.length, 1);
    assert.equal(ret.findings[0].severity, "high", "未满足条件应标 high");
    assert.match(ret.findings[0].evidence, /test -f/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("pi 产物：git-ancestor 两形态——merged（临时仓真提交）与 gone（分支已删按满足计）", async () => {
  const repo = mkdtempSync(join(tmpdir(), "wf-wait-git-"));
  try {
    const g = (...a) =>
      execFileSync("git", ["--git-dir", join(repo, ".git"), "-c", "user.name=selftest", "-c", "user.email=selftest@example.invalid", ...a], { encoding: "utf8" });
    execFileSync("git", ["init", repo], { encoding: "utf8" });
    g("commit", "--allow-empty", "-m", "init");
    g("branch", "dev-t");
    g("branch", "feat-in");
    // merged：feat-in 与 dev-t 同一 commit → 是祖先
    const merged = await runPi({
      targetLabel: "git-ancestor merged 形态",
      checks: [{ type: "git-ancestor", branch: "feat-in", target: "dev-t", gitDir: join(repo, ".git") }],
      pollSeconds: 5,
      maxRounds: 1,
    });
    assert.match(merged.conclusion, /完成/, "merged 形态应完成：" + merged.conclusion);
    assert.match(merged.findings[0].evidence, /merge-base --is-ancestor/);

    // gone：分支不存在（空仓上 feat-gone 从未创建）→ 按随收尾清理满足
    const gone = await runPi({
      targetLabel: "git-ancestor gone 形态",
      checks: [{ type: "git-ancestor", branch: "feat-gone", target: "dev-t", gitDir: join(repo, ".git") }],
      pollSeconds: 5,
      maxRounds: 1,
    });
    assert.match(gone.conclusion, /完成/, "gone 形态应按满足完成：" + gone.conclusion);
    assert.match(gone.findings[0].what, /已删除/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("pi 产物：file-contains 命中与未命中 + 未命中走超时路径", async () => {
  const home = mkdtempSync(join(tmpdir(), "wf-wait-"));
  try {
    const ledger = join(home, "queue.md");
    writeFileSync(ledger, "| dev-0.12.4 | 已并入 feat-x |\n");
    const hit = await runPi({
      targetLabel: "file-contains 命中",
      checks: [{ type: "file-contains", path: ledger, text: "feat-x" }],
      pollSeconds: 5,
      maxRounds: 1,
    });
    assert.match(hit.conclusion, /完成/);

    const miss = await runPi({
      targetLabel: "file-contains 未命中",
      checks: [{ type: "file-contains", path: ledger, text: "feat-y" }],
      pollSeconds: 5,
      maxRounds: 1,
    });
    assert.match(miss.conclusion, /超时/);
    assert.equal(miss.findings[0].severity, "high");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("pi 产物：参数 fail-fast——未知参数 / 非法原语 / 缺必填字段 / 非法数字", async () => {
  const home = mkdtempSync(join(tmpdir(), "wf-wait-"));
  try {
    // pi 壳按白名单复制 $ARGS（未知键不进 args）——未知参数被静默忽略、流程正常走完
    // （zcode 侧的未知参数 fail-fast 由公共体白名单承接）；/tmp 恒存在 → 快速完成
    const unknown = await runPi({ targetLabel: "x", checks: [{ type: "dir-present", path: "/tmp" }], bogus: 1, pollSeconds: 5, maxRounds: 1 });
    assert.match(unknown.conclusion, /完成/, "未知键应被忽略不阻塞：" + unknown.conclusion);

    const badType = await runPi({ targetLabel: "x", checks: [{ type: "no-such" }], pollSeconds: 5, maxRounds: 1 });
    assert.match(badType.conclusion, /不在原语词表/);

    const missingField = await runPi({ targetLabel: "x", checks: [{ type: "git-ancestor", branch: "a" }], pollSeconds: 5, maxRounds: 1 });
    assert.match(missingField.conclusion, /缺必填参数 target/);

    const badNumber = await runPi({ targetLabel: "x", checks: [{ type: "file-present", path: "/tmp/x" }], pollSeconds: 0, maxRounds: 1 });
    assert.match(badNumber.conclusion, /pollSeconds 非法/);

    const noLabel = await runPi({ checks: [{ type: "file-present", path: "/tmp/x" }], pollSeconds: 5, maxRounds: 1 });
    assert.match(noLabel.conclusion, /targetLabel 缺失/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("zcode 产物：mock world 应答 bash 包装——立即满足 + 超时停回 + 轮询节奏", async () => {
  const ret = await runZcode({
    targetLabel: "zcode 立即满足",
    checks: [{ type: "dir-absent", path: "/tmp/wf-wait-never" }],
    pollSeconds: 5,
    maxRounds: 2,
  });
  assert.match(ret.conclusion, /完成/, "结论应为完成：" + ret.conclusion);
  assert.ok(ret.worldCalls.some((c) => c[0] === "test" && c[1] === "-d"), "应发出 test -d 判定");
  assert.ok(!ret.worldCalls.some((c) => c[0] === "sleep"), "起点即满足不应 sleep");

  const timeout = await runZcode({
    targetLabel: "zcode 超时停回",
    checks: [{ type: "dir-present", path: "/tmp/wf-wait-never" }],
    pollSeconds: 5,
    maxRounds: 2,
  });
  assert.match(timeout.conclusion, /超时/);
  const sleeps = timeout.worldCalls.filter((c) => c[0] === "sleep");
  assert.equal(sleeps.length, 2, "两轮轮询应各 sleep 一次（实际 " + sleeps.length + "）");
  assert.equal(sleeps[0][1], "5", "sleep 时长应取 pollSeconds");
});

test("zcode 产物：git-ancestor mock 形态（merge-base 0 = merged / rev-parse 失败 = gone）", async () => {
  const ret = await runZcode({
    targetLabel: "zcode git-ancestor",
    checks: [
      { type: "git-ancestor", branch: "feat-a", target: "dev-z", gitDir: ".bare" },
      { type: "git-ancestor", branch: "feat-gone", target: "dev-z", gitDir: ".bare" },
    ],
    pollSeconds: 5,
    maxRounds: 1,
  });
  assert.match(ret.conclusion, /完成/);
  assert.match(ret.findings[0].evidence, /merge-base --is-ancestor feat-a dev-z/);
  assert.match(ret.findings[1].what, /已删除/);
  assert.ok(ret.worldCalls.some((c) => c[0] === "git" && c.includes("--git-dir=.bare")), "git 调用应带 --git-dir");
});

test("zcode 产物：未知参数 fail-fast（公共体白名单）", async () => {
  const ret = await runZcode({
    targetLabel: "x",
    checks: [{ type: "file-present", path: "/tmp" }],
    bogus: 1,
    pollSeconds: 5,
    maxRounds: 1,
  });
  assert.match(ret.conclusion, /未知参数「bogus」/);
});
