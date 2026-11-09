// merge.test.mjs — merge 发布 workflow 的真实产物执行测试（mock 宿主驱动，零真实对外动作）。
// 覆盖：参数白名单与窄化拒启（未知参数 / worktree 缺失·指向 main·非目录 / squashMode /
// maxRescueRounds / skipSteps 词表与 init 联动）、init 输出协议解析失败的终态形态、
// premerge 失败 → rescue 兜底 agent 全链路（路由 → agent 修复 → 重跑判定 → 后续 step 短路）、
// squash 需整理停回 / 多作者停回 / 区间重划取最新 merge、幂等预检五分支（tag 已存在跳过 /
// 版本中间态 / ls-remote 故障 / gh 故障 / 正常 bump 路径随全链）、no-runs 补验三态
//（正常通过不查询 / 真无 run 披露放行 / 查到 run 停回）、清理门禁 needs-human、
// rescue 轮次耗尽与无效返回回喂、notes 回喂、gitcode 网络类 retry、终态 released 全链。
import { test } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runProduct, makeMockWorldRun, productObsLayerHash } from "./helpers/run-product.mjs";

const WF = join(dirname(fileURLToPath(import.meta.url)), "..");
const MERGE_ZCODE = join(WF, "merge.dwf.ts");
const MERGE_HASH = productObsLayerHash(MERGE_ZCODE);
const WT = "/tmp/merge-selftest-ws/feat-x";

const okArtifact = { markdown: async () => {} };
const baseAgent = () => ({ ask: async () => ({ action: "fixed", summary: "selftest 修复", filesChanged: ["a.ts"], residualRisk: "" }) });

function inject(args, worldOpts = {}, agent = baseAgent) {
  return {
    args,
    agent,
    world: { run: makeMockWorldRun([], { obsLayerHash: MERGE_HASH, wtShape: "dir", ...worldOpts }) },
    files: { read: async () => { throw new Error("x"); } },
    artifact: okArtifact,
  };
}

// ══ 参数白名单与窄化（全部 failObs 早退 = rejects，无任何业务命令执行）══

test("未知参数 → invalid-args 拒启并列出合法键", async () => {
  await assert.rejects(
    () => runProduct(MERGE_ZCODE, "zcode", inject({ worktree: WT, bogus: 1 })),
    /未知参数: bogus（合法参数: worktree\/prNumber\/squashMode\/maxRescueRounds\/skipSteps\/taskId\/executionId\/sampleType）/,
  );
});

test("worktree 未传 → 拒启（必传 + 绝对路径）", async () => {
  await assert.rejects(
    () => runProduct(MERGE_ZCODE, "zcode", inject({})),
    /参数 worktree 必传且为 feature worktree 绝对路径/,
  );
});

test("worktree 指向 main → 拒启（阶段 7 删除保护）", async () => {
  await assert.rejects(
    () => runProduct(MERGE_ZCODE, "zcode", inject({ worktree: "/tmp/merge-selftest-ws/main" })),
    /worktree 参数不得指向 main worktree/,
  );
});

test("worktree 探针 missing → 拒启", async () => {
  await assert.rejects(
    () => runProduct(MERGE_ZCODE, "zcode", inject({ worktree: WT }, { wtShape: "missing" })),
    /worktree 参数指向的路径不是有效目录/,
  );
});

test("squashMode 非法 → 拒启", async () => {
  await assert.rejects(
    () => runProduct(MERGE_ZCODE, "zcode", inject({ worktree: WT, squashMode: "yolo" })),
    /参数 squashMode 非法：yolo/,
  );
});

test("maxRescueRounds 越界 → 拒启", async () => {
  await assert.rejects(
    () => runProduct(MERGE_ZCODE, "zcode", inject({ worktree: WT, maxRescueRounds: 9 })),
    /参数 maxRescueRounds 非法：9/,
  );
});

test("skipSteps 含非法 step id → 拒启并列出词表", async () => {
  await assert.rejects(
    () => runProduct(MERGE_ZCODE, "zcode", inject({ worktree: WT, skipSteps: ["nope"] })),
    /skipSteps 含非法 step id："nope"/,
  );
});

test("skipSteps 含 init 但未传 prNumber → 拒启（PR 号发现入口被跳过）", async () => {
  await assert.rejects(
    () => runProduct(MERGE_ZCODE, "zcode", inject({ worktree: WT, skipSteps: ["init"] })),
    /skipSteps 含 init 时必须显式传 prNumber/,
  );
});

// ══ init 输出协议（成功但未打印 PR_NUMBER → 失败终态 return，不 throw）══

test("init 成功但无 PR_NUMBER → return failed + stages/skippedSteps 结构完整", async () => {
  // 默认 mock：gh/git/sh 探针无害成功，init.sh 应答空输出（无 PR_NUMBER 行）
  const result = await runProduct(MERGE_ZCODE, "zcode", inject({ worktree: WT, squashMode: "skip" }));
  assert.equal(result.status, "failed");
  assert.equal(result.failedStep, "init");
  assert.match(result.error, /init\.sh 成功但未解析到 PR_NUMBER/);
  assert.equal(result.stages.preflight, "pass");
  assert.equal(result.stages.init, "failed");
  assert.equal(result.stages["squash-check"], undefined, "init 失败短路，squash-check 不会执行");
  assert.match(result.recovery, /ResumeWorkflowRun/);
});

// ══ rescue 全链路：premerge 首跑失败 → rescue-premerge-r1 修复 → 重跑通过 →
//    prune-devlink 失败（escalate）→ 终态 failed 且 rescue 记录完整 ══

test("premerge 失败路由 rescue：agent 修复后重跑判定，后续 step 失败正常停回", async () => {
  const agentCalls = [];
  const agent = (name) => {
    agentCalls.push(name);
    return { ask: async () => ({ action: "fixed", summary: "修复 lint 并提交推送", filesChanged: ["a.ts"], residualRisk: "" }) };
  };
  let premergeCalls = 0;
  const base = makeMockWorldRun([], { obsLayerHash: MERGE_HASH, wtShape: "dir" });
  const custom = async (cmd, argsArr, opts) => {
    // 解包 runSh 的 bash 包装后按 sh -c 脚本内容分发
    if (cmd === "bash" && argsArr[0] === "-c" && argsArr[2] === "bash") {
      const inner = String(argsArr[3] ?? "");
      const innerArgs = argsArr.slice(4);
      if (inner === "sh") {
        const script = String(innerArgs[1] ?? "");
        if (script.includes("init.sh")) {
          // 逐字复刻 init.sh 真实输出格式：三行均为两空格缩进（echo "  PR_NUMBER=…"）——
          // mock 自创格式会掩盖解析正则与脚本契约的失配
          return { exitCode: 0, stdout: "  WS_ROOT=/tmp/merge-selftest-ws\n  BRANCH_NAME=feat-x\n  PR_NUMBER=71\n", stderr: "" };
        }
        if (script.includes("pre-merge-check.sh")) {
          premergeCalls++;
          return premergeCalls === 1
            ? { exitCode: 1, stdout: "", stderr: "❌ FAIL lint" }
            : { exitCode: 0, stdout: "✅ 本地验证全部通过！", stderr: "" };
        }
        if (script.includes("prune-dev-link.sh")) {
          return { exitCode: 2, stdout: "", stderr: "worktree 不存在" };
        }
      }
    }
    return base(cmd, argsArr, opts);
  };
  const result = await runProduct(MERGE_ZCODE, "zcode", {
    args: { worktree: WT, squashMode: "skip" },
    agent,
    world: { run: custom },
    files: { read: async () => { throw new Error("x"); } },
    artifact: okArtifact,
  });
  assert.equal(premergeCalls, 2, "rescue 后必须重跑原脚本判定（不信 agent 自报成功）");
  assert.deepEqual(agentCalls, ["rescue-premerge-r1"], "rescue agent 名按白名单场景 + 轮次注册");
  assert.equal(result.status, "failed");
  assert.equal(result.failedStep, "prune-devlink");
  assert.equal(result.stages.premerge, "pass");
  assert.equal(result.rescues.length, 1);
  assert.equal(result.rescues[0].step, "premerge");
  assert.equal(result.rescues[0].action, "fixed");
  assert.equal(result.prUrl, "https://github.com/zhushanwen321/tai-ji/pull/71");
});

// ══ squash-check 需整理 → needs-squash-approval 停回（不进入后续 step）══

test("squash-check agent 判需整理 → needs-squash-approval + 计划入 error", async () => {
  const base = makeMockWorldRun([], { obsLayerHash: MERGE_HASH, wtShape: "dir" });
  const custom = async (cmd, argsArr, opts) => {
    if (cmd === "bash" && argsArr[0] === "-c" && argsArr[2] === "bash") {
      const inner = String(argsArr[3] ?? "");
      const innerArgs = argsArr.slice(4);
      if (inner === "sh") {
        const script = String(innerArgs[1] ?? "");
        if (script.includes("init.sh")) {
          return { exitCode: 0, stdout: "  PR_NUMBER=71\n", stderr: "" };
        }
        // merge 的 execCmd 统一 sh -c 包装（argv 逐项 shq）——git 子命令按脚本内容匹配
        if (script.includes("'merge-base'")) return { exitCode: 0, stdout: "fakebase0000\n", stderr: "" };
        if (script.includes("'--merges'")) return { exitCode: 0, stdout: "", stderr: "" };
        if (script.includes("'log'") && script.includes("--format=")) {
          return { exitCode: 0, stdout: "aaa1111\tdev\twip: 阶段1\nbbb2222\tdev\tfixup! 阶段1\n", stderr: "" };
        }
      }
    }
    return base(cmd, argsArr, opts);
  };
  const agent = () => ({
    ask: async () => ({ action: "needs-squash", reason: "wip/fixup 笔应折入逻辑单元", plan: "折入 bbb2222 → aaa1111（fixup 笔）" }),
  });
  const result = await runProduct(MERGE_ZCODE, "zcode", {
    args: { worktree: WT },
    agent,
    world: { run: custom },
    files: { read: async () => { throw new Error("x"); } },
    artifact: okArtifact,
  });
  assert.equal(result.status, "needs-squash-approval");
  assert.equal(result.failedStep, "squash-check");
  assert.match(result.error, /折入 bbb2222/);
  assert.match(result.error, /批准路径/);
  assert.equal(result.stages["squash-check"], "needs-approval");
  assert.equal(result.stages.premerge, undefined, "停回后后续 step 不得执行");
});

// ══ 全链 mock 分发器：execCmd 统一经 bash 包装 + sh -c 脚本体执行——按脚本内容应答。
//    overrides 先于默认命中（首条匹配生效）；st 收集可断言的调用事实 ══

const NOTES_BODY = "<!-- LANG:en -->\nEN body for selftest\n<!-- LANG:zh -->\n中文正文\n";

function makeChain(opts = {}) {
  const base = makeMockWorldRun([], { obsLayerHash: MERGE_HASH, wtShape: "dir" });
  const st = {
    version: opts.version ?? "0.12.9",
    pnpmVersionCalls: 0, pushMainCalls: 0, pushTagCalls: 0, ghRunListCalls: 0,
    stateWrites: [], verifyScripts: [], noMergesScripts: [], syncCalls: 0,
    pushRepoCalls: 0, rmWorktreeCalls: 0, premergeCalls: 0, logTails: {},
  };
  const bump = () => {
    const [a, b, c] = st.version.split(".");
    return `${a}.${b}.${Number(c) + 1}`;
  };
  const defaults = [
    // argv 形态经 execCmd 逐项 shq——首 token 也带引号（形态 'gh' 'auth' …），匹配串
    // 不得写未加引号的首 token（如 gh 'run' 'list'），否则永不命中并静默落到 base 空应答
    [(s) => s.includes("'auth' 'status'"), () => ({ exitCode: 0, stdout: "", stderr: "" })],
    [(s) => s.includes("command -v pnpm"), () => ({ exitCode: 0, stdout: "/fake/pnpm/bin/pnpm\n", stderr: "" })],
    [(s) => s.includes("'rev-parse' '--abbrev-ref'"), () => ({ exitCode: 0, stdout: "main\n", stderr: "" })],
    [(s) => s.includes("init.sh"), () => ({ exitCode: 0, stdout: "  WS_ROOT=/tmp/merge-selftest-ws\n  BRANCH_NAME=feat-x\n  PR_NUMBER=71\n", stderr: "" })],
    [(s) => s.includes("'merge-base'"), () => ({ exitCode: 0, stdout: "fakebase0000\n", stderr: "" })],
    [(s) => s.includes("'--merges'"), () => ({ exitCode: 0, stdout: "", stderr: "" })],
    // commit 清单默认单作者（squashMode=skip 的用例不会走到；走到的用例按需 override）
    [(s) => s.includes("'log'") && s.includes("'--no-merges'") && s.includes("%x09"), (s) => {
      st.noMergesScripts.push(s);
      return { exitCode: 0, stdout: "aaa1111\tdev\tfeat: x\n", stderr: "" };
    }],
    [(s) => s.includes("pre-merge-check.sh"), () => { st.premergeCalls++; return { exitCode: 0, stdout: "✅ 本地验证全部通过！", stderr: "" }; }],
    [(s) => s.includes("prune-dev-link.sh"), () => ({ exitCode: 0, stdout: "ok", stderr: "" })],
    [(s) => s.includes("pr-merge.sh"), () => ({ exitCode: 0, stdout: "已合并", stderr: "" })],
    [(s) => s.includes("'fetch' 'github'"), () => ({ exitCode: 0, stdout: "", stderr: "" })],
    [(s) => s.includes("'rev-parse' 'github/main'"), () => ({ exitCode: 0, stdout: "mergec0ffee000000000000000000000000000000\n", stderr: "" })],
    // 正常 CI 通过形态（无「未检测到 CI」标记 → 补验不触发）；带 logName 的命令
    // stdout 落日志文件、r.text 经 READ_TAIL 回读——同步登记 logTails 供回读应答
    [(s) => s.includes("wait-for-ci.sh"), () => {
      st.logTails["post-merge-ci"] = "✅ CI 通过\n";
      return { exitCode: 0, stdout: "✅ CI 通过\n", stderr: "" };
    }],
    [(s) => s.includes("readFileSync") && s.includes(".log"), (s) => {
      const m = /([\w-]+)\.log/.exec(s);
      return { exitCode: 0, stdout: st.logTails[m !== null ? m[1] : ""] ?? "", stderr: "" };
    }],
    [(s) => s.includes("'run' 'list'"), () => { st.ghRunListCalls++; return { exitCode: 0, stdout: "[]", stderr: "" }; }],
    [(s) => s.includes("check-version-bump.sh"), () => ({ exitCode: 0, stdout: "OK", stderr: "" })],
    [(s) => s.includes("select-affected-e2e.mjs"), () => ({ exitCode: 0, stdout: "（selftest：无 e2e 触发）\n", stderr: "" })],
    // readVersion（-p require(…/package.json).version）——随 pnpm version mock 联动
    [(s) => s.includes('package.json").version'), () => ({ exitCode: 0, stdout: `${st.version}\n`, stderr: "" })],
    // 幂等预检默认：远端无 v0.12.9 tag + 最新 release == 本地版本 → 走完整 bump 路径
    [(s) => s.includes("'ls-remote'"), () => ({ exitCode: 0, stdout: "", stderr: "" })],
    [(s) => s.includes("'tagName'"), () => ({ exitCode: 0, stdout: `v${st.version}\n`, stderr: "" })],
    [(s) => s.includes("'--show-current'"), () => ({ exitCode: 0, stdout: "main\n", stderr: "" })],
    [(s) => s.includes("pnpm version patch"), (s) => {
      st.pnpmVersionCalls++;
      if (!s.includes("apps/electron")) st.version = bump(); // 根包与 electron 子包各一笔，版本只前进一次
      return { exitCode: 0, stdout: "", stderr: "" };
    }],
    [(s) => s.includes("git add package.json"), () => ({ exitCode: 0, stdout: "", stderr: "" })],
    [(s) => s.includes("git commit -m 'chore: bump"), () => ({ exitCode: 0, stdout: "", stderr: "" })],
    [(s) => s.includes("git tag 'v"), () => ({ exitCode: 0, stdout: "", stderr: "" })],
    [(s) => s.includes("^{commit}"), () => ({ exitCode: 0, stdout: "", stderr: "" })],
    [(s) => s.includes("git push github HEAD") && !s.includes(":main"), () => { st.pushMainCalls++; return { exitCode: 0, stdout: "", stderr: "" }; }],
    [(s) => s.includes("git push github 'v"), () => { st.pushTagCalls++; return { exitCode: 0, stdout: "", stderr: "" }; }],
    [(s) => s.includes("git push github HEAD:main"), () => ({ exitCode: 0, stdout: "", stderr: "" })],
    [(s) => s.includes("verify-ci-release.sh"), (s) => { st.verifyScripts.push(s); return { exitCode: 0, stdout: "✅ 发布产物验证通过\n", stderr: "" }; }],
    [(s) => s.includes("'pr' 'view'"), () => ({ exitCode: 0, stdout: "deadbeefcafe1234\n", stderr: "" })],
    [(s) => s.includes("'diff' '--name-only'"), () => ({ exitCode: 0, stdout: "src/a.ts\n", stderr: "" })],
    [(s) => s.includes("readFileSync") && s.includes("release-notes-"), () => ({ exitCode: 0, stdout: NOTES_BODY, stderr: "" })],
    [(s) => s.includes("check_doc_emoji.py"), () => ({ exitCode: 0, stdout: "", stderr: "" })],
    [(s) => s.includes("'release' 'edit'"), () => ({ exitCode: 0, stdout: "", stderr: "" })],
    [(s) => s.includes("'.url'"), () => ({ exitCode: 0, stdout: `https://github.com/zhushanwen321/tai-ji/releases/tag/v${st.version}\n`, stderr: "" })],
    [(s) => s.includes("writeMergeState"), (s) => { st.stateWrites.push(s); return { exitCode: 0, stdout: "", stderr: "" }; }],
    [(s) => s.includes("sync-from-github"), () => { st.syncCalls++; return { exitCode: 0, stdout: "镜像完成", stderr: "" }; }],
    [(s) => s.includes("update-readme-install.mjs"), () => ({ exitCode: 0, stdout: "", stderr: "" })],
    [(s) => s.includes("git diff README.md"), () => ({ exitCode: 0, stdout: "", stderr: "" })],
    [(s) => s.includes("push-repo"), () => { st.pushRepoCalls++; return { exitCode: 0, stdout: "推送完成", stderr: "" }; }],
    [(s) => s.includes("%{http_code}"), () => ({ exitCode: 0, stdout: "206", stderr: "" })],
    [(s) => s.includes("for-each-ref"), () => ({ exitCode: 0, stdout: "", stderr: "" })],
    [(s) => s.includes("remove-worktree.sh"), () => { st.rmWorktreeCalls++; return { exitCode: 0, stdout: "已清理", stderr: "" }; }],
  ];
  const rules = [...(typeof opts.overrides === "function" ? opts.overrides(st) : opts.overrides ?? []), ...defaults];
  const dispatch = async (cmd, argsArr, runOpts) => {
    if (cmd === "bash" && argsArr[0] === "-c" && argsArr[2] === "bash" && String(argsArr[3] ?? "") === "sh") {
      const script = String(argsArr.slice(4)[1] ?? "");
      for (const [match, res] of rules) {
        if (match(script)) return typeof res === "function" ? res(script) : res;
      }
    }
    return base(cmd, argsArr, runOpts);
  };
  return { run: dispatch, st };
}

// 全链 agent：notes 按 prompt 内嵌路径应答、squash 判 no-need、rescue 回 fixed
const chainAgent = () => ({
  ask: async (prompt) => {
    const p = String(prompt);
    if (p.includes("Release Notes 撰写")) {
      const m = /并写入 (\S+)。/.exec(p);
      return { filePath: m !== null ? m[1] : "", summary: "selftest notes" };
    }
    if (p.includes("commit 粒度判定")) return { action: "no-need", reason: "selftest 单笔无需整理", plan: "" };
    return { action: "fixed", summary: "selftest 修复", filesChanged: ["a.ts"], residualRisk: "" };
  },
});

async function runChain(args, chainOpts = {}, agentFn = chainAgent) {
  const chain = makeChain(chainOpts);
  const result = await runProduct(MERGE_ZCODE, "zcode", {
    args,
    agent: agentFn,
    world: { run: chain.run },
    files: { read: async () => { throw new Error("x"); } },
    artifact: okArtifact,
  });
  return { result, st: chain.st };
}

// ══ 幂等预检分支 ══

test("幂等预检命中：远端 tag 已存在 → 跳过 bump/push 直达 verify，终态 released 全链", async () => {
  const { result, st } = await runChain(
    { worktree: WT, squashMode: "skip" },
    { overrides: [[(s) => s.includes("'ls-remote'"), () => ({ exitCode: 0, stdout: "abc123def\trefs/tags/v0.12.9\n", stderr: "" })]] },
  );
  assert.equal(result.status, "released");
  assert.equal(result.tag, "v0.12.9");
  assert.ok(result.releaseUrl.includes("v0.12.9"));
  assert.equal(result.prUrl, "https://github.com/zhushanwen321/tai-ji/pull/71");
  assert.equal(st.pnpmVersionCalls, 0, "幂等命中后不得再 bump");
  assert.equal(st.pushMainCalls + st.pushTagCalls, 0, "幂等命中后不得再 push");
  assert.ok(st.verifyScripts[0].includes("'v0.12.9'"), "verify 用当前版本 tag 复核");
  assert.ok(st.stateWrites.length === 1 && st.stateWrites[0].includes("'v0.12.9'") && st.stateWrites[0].includes("/tmp/merge-selftest-ws"), "verify 通过后落 released 终态");
  assert.equal(st.ghRunListCalls, 0, "正常 CI 通过（无 no-runs 标记）不得触发补验查询");
  assert.equal(st.rmWorktreeCalls, 1);
});

test("幂等预检中间态：本地版本 ≠ 最新 release 且无远端 tag → 停回且不 bump", async () => {
  const { result, st } = await runChain(
    { worktree: WT, squashMode: "skip" },
    { overrides: [[(s) => s.includes("'tagName'"), () => ({ exitCode: 0, stdout: "v0.12.8\n", stderr: "" })]] },
  );
  assert.equal(result.status, "failed");
  assert.equal(result.failedStep, "bump-release");
  assert.match(result.error, /版本中间态/);
  assert.match(result.error, /v0\.12\.8/);
  assert.equal(st.pnpmVersionCalls, 0);
});

test("幂等预检 gh 基线查询故障 → 停回（不得按无基线放行）", async () => {
  const { result, st } = await runChain(
    { worktree: WT, squashMode: "skip" },
    { overrides: [[(s) => s.includes("'tagName'"), () => ({ exitCode: 1, stdout: "", stderr: "gh: Failed to connect to api.github.com\n" })]] },
  );
  assert.equal(result.status, "failed");
  assert.equal(result.failedStep, "bump-release");
  assert.match(result.error, /基线查询失败/);
  assert.equal(st.pnpmVersionCalls, 0);
});

test("幂等预检 ls-remote 故障 → 停回（无法判定 tag 存在性）", async () => {
  const { result } = await runChain(
    { worktree: WT, squashMode: "skip" },
    { overrides: [[(s) => s.includes("'ls-remote'"), () => ({ exitCode: 1, stdout: "", stderr: "fatal: Could not read from remote repository\n" })]] },
  );
  assert.equal(result.status, "failed");
  assert.equal(result.failedStep, "bump-release");
  assert.match(result.error, /远端 tag 查询失败/);
});

// ══ no-runs 放行补验三态 ══

test("no-runs 放行标记 + gh 复核查到 run → 停回（放行判定与事实不符）", async () => {
  const { result } = await runChain(
    { worktree: WT, squashMode: "skip" },
    { overrides: (st) => [
      [(s) => s.includes("wait-for-ci.sh"), () => {
        st.logTails["post-merge-ci"] = "  ⚠️  30秒内查询成功但未检测到 CI workflow。\n";
        return { exitCode: 0, stdout: "", stderr: "" };
      }],
      [(s) => s.includes("'run' 'list'"), () => ({ exitCode: 0, stdout: '[{"databaseId":123,"status":"completed","conclusion":"failure"}]', stderr: "" })],
    ] },
  );
  assert.equal(result.status, "failed");
  assert.equal(result.failedStep, "post-merge-ci");
  assert.match(result.error, /放行判定与事实不符/);
  assert.match(result.error, /databaseId/);
});

test("no-runs 放行标记 + gh 复核真无 run → 披露放行，流程继续", async () => {
  const { result } = await runChain(
    { worktree: WT, squashMode: "skip" },
    { overrides: (st) => [
      [(s) => s.includes("wait-for-ci.sh"), () => {
        st.logTails["post-merge-ci"] = "  ⚠️  30秒内查询成功但未检测到 CI workflow。\n";
        return { exitCode: 0, stdout: "", stderr: "" };
      }],
      [(s) => s.includes("check-version-bump.sh"), () => ({ exitCode: 1, stdout: "", stderr: "SELFTEST BOOM\n" })],
    ] },
  );
  assert.equal(result.status, "failed");
  assert.equal(result.failedStep, "version-check", "用下一 step 失败终止全链，证明 post-merge-ci 已放行通过");
  assert.equal(result.stages["post-merge-ci"], "pass");
});

// ══ 清理门禁 ══

test("清理门禁：skipSteps 接管过非 squash-check 的 step → needs-human 保留现场", async () => {
  const { result, st } = await runChain({ worktree: WT, squashMode: "skip", skipSteps: ["prune-devlink"] });
  assert.equal(result.status, "needs-human");
  assert.equal(result.failedStep, "cleanup");
  assert.match(result.error, /清理门禁拦截/);
  assert.match(result.error, /prune-devlink/);
  assert.equal(result.stages.cleanup, "needs-human");
  assert.equal(st.rmWorktreeCalls, 0, "门禁拦截后不得删 worktree");
});

// ══ squash：多作者机器停回与区间重划 ══

test("squash 多作者：区间内多个作者 → 机器停回，不派判定 agent", async () => {
  const agentCalls = [];
  const { result } = await runChain(
    { worktree: WT },
    { overrides: [[(s) => s.includes("'--no-merges'") && s.includes("%x09"), () => ({ exitCode: 0, stdout: "aaa1111\tAlice\tfix: a\nbbb2222\tBob\tfix: b\n", stderr: "" })]] },
    (name) => { agentCalls.push(name); return { ask: chainAgent().ask }; },
  );
  assert.equal(result.status, "failed");
  assert.equal(result.failedStep, "squash-check");
  assert.match(result.error, /多个作者/);
  assert.deepEqual(agentCalls, [], "多作者属机器判定，不得进入 agent");
});

test("squash 区间重划：取最新一笔 merge 作整理起点（git log 新→旧首行）", async () => {
  const newer = "newmerge111000000000000000000000000000000";
  const older = "oldmerge222000000000000000000000000000000";
  const { result, st } = await runChain(
    { worktree: WT, maxRescueRounds: 0 },
    { overrides: [
      [(s) => s.includes("'--merges'"), () => ({ exitCode: 0, stdout: `${newer} m1 合并 dev\n${older} m2 合并 dev\n`, stderr: "" })],
      [(s) => s.includes("pre-merge-check.sh"), () => ({ exitCode: 1, stdout: "", stderr: "SELFTEST：终止链路\n" })],
    ] },
  );
  assert.equal(st.noMergesScripts.length, 1);
  assert.ok(st.noMergesScripts[0].includes(`'${newer}..HEAD'`), `整理起点必须是最新 merge（实际脚本：${st.noMergesScripts[0]}）`);
  assert.ok(!st.noMergesScripts[0].includes(`'${older}..HEAD'`));
  assert.equal(result.failedStep, "premerge", "用 premerge 失败终止链路（maxRescueRounds=0 直接停回）");
});

// ══ rescue：轮次耗尽与无效返回回喂 ══

test("rescue 轮次耗尽：修复后重跑仍失败 → 停回带历轮摘要", async () => {
  const agentCalls = [];
  const { result, st } = await runChain(
    { worktree: WT, squashMode: "skip", maxRescueRounds: 1 },
    { overrides: (st) => [[(s) => s.includes("pre-merge-check.sh"), () => {
      st.premergeCalls++;
      return { exitCode: 1, stdout: "", stderr: "❌ FAIL lint\n" };
    }]] },
    (name) => { agentCalls.push(name); return chainAgent(); },
  );
  assert.equal(st.premergeCalls, 2, "rescue 修复后重跑原脚本判定");
  assert.deepEqual(agentCalls, ["rescue-premerge-r1"]);
  assert.equal(result.status, "failed");
  assert.equal(result.failedStep, "premerge");
  assert.equal(result.rescues.length, 1);
  assert.equal(result.rescues[0].action, "fixed");
  assert.match(result.error, /rescue 历轮/);
});

test("rescue 无效返回 → 回喂同一 agent 重试一次后采纳有效结果", async () => {
  let asks = 0;
  const agentCalls = [];
  const { result, st } = await runChain(
    { worktree: WT, squashMode: "skip" },
    { overrides: (st) => [[(s) => s.includes("pre-merge-check.sh"), () => {
      st.premergeCalls++;
      return st.premergeCalls === 1
        ? { exitCode: 1, stdout: "", stderr: "❌ FAIL lint\n" }
        : { exitCode: 0, stdout: "✅ 本地验证全部通过！", stderr: "" };
    }]] },
    (name) => {
      agentCalls.push(name);
      return {
        ask: async (prompt) => {
          const p = String(prompt);
          if (p.includes("Release Notes 撰写")) {
            const m = /并写入 (\S+)。/.exec(p);
            return { filePath: m !== null ? m[1] : "", summary: "ok" };
          }
          asks++;
          return asks === 1
            ? { action: "yolo", summary: "", filesChanged: "not-array" }
            : { action: "fixed", summary: "修复 lint 并提交推送", filesChanged: ["a.ts"], residualRisk: "" };
        },
      };
    },
  );
  assert.equal(asks, 2, "无效返回必须回喂重试");
  assert.equal(agentCalls[0], "rescue-premerge-r1", "回喂复用同一 agent 实例（同名单建）");
  assert.equal(st.premergeCalls, 2);
  assert.equal(result.stages.premerge, "pass");
  assert.equal(result.rescues[0].action, "fixed");
});

// ══ notes 回喂 ══

test("notes 首次 filePath 不符 → 回喂重写后通过，全链 released", async () => {
  let notesAsks = 0;
  const { result } = await runChain(
    { worktree: WT, squashMode: "skip" },
    {},
    () => ({
      ask: async (prompt) => {
        const p = String(prompt);
        if (p.includes("Release Notes 撰写")) {
          notesAsks++;
          const m = /并写入 (\S+)。/.exec(p);
          return notesAsks === 1 ? { filePath: "/wrong/path.md", summary: "x" } : { filePath: m !== null ? m[1] : "", summary: "ok" };
        }
        return chainAgent().ask(p);
      },
    }),
  );
  assert.equal(notesAsks, 2, "filePath 不符必须回喂重写");
  assert.equal(result.status, "released");
  assert.equal(result.stages.notes, "pass");
});

// ══ gitcode 网络类 retry ══

test("gitcode 网络失败：sync 重试一次成功，push-repo 两连败后停回", async () => {
  const { result, st } = await runChain(
    { worktree: WT, squashMode: "skip" },
    { overrides: (st) => [
      [(s) => s.includes("sync-from-github"), () => (st.syncCalls++ === 0
        ? { exitCode: 1, stdout: "", stderr: "Error: Failed to connect to gitcode.com\n" }
        : { exitCode: 0, stdout: "镜像完成", stderr: "" })],
      [(s) => s.includes("push-repo"), () => {
        st.pushRepoCalls++;
        // logName 形态的失败文本经 READ_TAIL 回读——同步登记尾部供停回消息断言
        st.logTails["gitcode-repo"] = "Error: Failed to connect to gitcode.com\n";
        return { exitCode: 1, stdout: "", stderr: "Error: Failed to connect to gitcode.com\n" };
      }],
    ] },
  );
  assert.equal(st.syncCalls, 2, "网络类失败重试一次");
  assert.ok(st.pushRepoCalls >= 2, "push-repo 初跑 + 重试各一次");
  assert.equal(result.status, "failed");
  assert.equal(result.failedStep, "gitcode-sync");
  assert.match(result.error, /Failed to connect/);
});
