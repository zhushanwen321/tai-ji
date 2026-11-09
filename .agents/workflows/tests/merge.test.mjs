// merge.test.mjs — merge 发布 workflow 的真实产物执行测试（mock 宿主驱动，零真实对外动作）。
// 覆盖：参数白名单与窄化拒启（未知参数 / worktree 缺失·指向 main·非目录 / squashMode /
// maxRescueRounds / skipSteps 词表与 init 联动）、init 输出协议解析失败的终态形态、
// premerge 失败 → rescue 兜底 agent 全链路（路由 → agent 修复 → 重跑判定 → 后续 step 短路）。
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
          return { exitCode: 0, stdout: "WS_ROOT=/tmp/merge-selftest-ws\nBRANCH_NAME=feat-x\nPR_NUMBER=71\n", stderr: "" };
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
          return { exitCode: 0, stdout: "PR_NUMBER=71\n", stderr: "" };
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
