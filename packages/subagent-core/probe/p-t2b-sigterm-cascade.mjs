// probe/p-t2b-sigterm-cascade.mjs
//
// 探针 P-T2b：pi 子进程收 SIGTERM 后是否自行级联 kill 其活跃后代。
// 支撑设计 T2-②「后代级联 kill」的形态裁决：证实级联 → u-t2a 后代补杀退化为
// no-op 一致性校验；证否 → 后代补杀即主路径
//（docs/architecture/crash-forensics-and-watchdog.md 附录 E §7.2 T2-② / §7.3 P-T2b 行）。
//
// 源码假设（实装版 0.84.2，dist/modes/rpc/rpc-mode.js:276-286 SIGTERM handler
// 只调 killTrackedDetachedChildren；dist/core/tools/bash.js:71 在 bash 前台执行
// 期间 track、finally untrack）——探针实证两条形态：
//   形态 A（前台 bash 活跃，pid 在 tracked 集合）：预期级联 kill 生效（进程组 SIGKILL）
//   形态 B（bash 已返回、& 后台化的 pi 后代，untrack 后）：预期无级联（孤儿存活）
// 形态 B 是设计语境（keep-alive 层主死后活跃后代）的主裁决形态。
//
// 运行：node probe/p-t2b-sigterm-cascade.mjs
// 产出：stdout 时间线 + 同目录 p-t2b-results.json。
// 会话数据隔离在 /tmp/p-t2b-*，结束时清理并 kill 残余后代。

import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";

const MODEL = "xiaomi-token-plan-cn/mimo-v2.5-pro";
// pi 路径动态解析（后台 shell PATH 可能不含 nvm bin；禁止写死个人绝对路径）
function resolvePi() {
  try {
    return execFileSync("which", ["pi"], { encoding: "utf8" }).trim();
  } catch {
    console.error("FATAL: pi CLI not found on PATH");
    process.exit(1);
  }
}
const PI_BIN = resolvePi();
const TOTAL_BUDGET_MS = 600_000;
const STARTED = Date.now();

function log(msg) {
  process.stdout.write(`[p-t2b ${((Date.now() - STARTED) / 1000).toFixed(1)}s] ${msg}\n`);
}
function ts() {
  return new Date().toISOString();
}
function psAlive(pid) {
  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", "pid=,stat=,etime=,command="], { encoding: "utf8" });
    return out.trim() ? { alive: true, detail: out.trim().slice(0, 160) } : { alive: false };
  } catch {
    return { alive: false };
  }
}
// 递归收集 pid 的全部后代
function descendants(pid, acc = []) {
  let children = [];
  try {
    children = execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" })
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number);
  } catch {
    return acc; // pgrep 无匹配 exit 1
  }
  for (const c of children) {
    if (!acc.includes(c)) {
      acc.push(c);
      descendants(c, acc);
    }
  }
  return acc;
}

const results = {
  probe: "P-T2b",
  model: MODEL,
  startedAt: ts(),
  phases: [],
  abortedReason: null,
};

function spawnParent(label) {
  // 会话数据隔离在 /tmp（任务要求；os.tmpdir() 在 macOS 返回 /var/folders 不符）
  const dir = mkdtempSync(`/tmp/p-t2b-${label}-`);
  const child = spawn(
    PI_BIN,
    // --no-extensions：同 P-T2c 登记（本机全局 extension 加载 fatal，与探针无关）
    ["--mode", "rpc", "--no-extensions", "--session-dir", dir, "--model", MODEL, "--approve"],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  return { dir, child };
}

function waitFor(pid, predicate, timeoutMs, label) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      let v;
      try {
        v = predicate();
      } catch (e) {
        v = { error: e.message };
      }
      if (v && v.hit) {
        clearInterval(iv);
        resolve(v);
      } else if (Date.now() - t0 > timeoutMs) {
        clearInterval(iv);
        log(`TIMEOUT waiting for ${label}`);
        resolve({ hit: false, timeout: true });
      }
    }, 700);
  });
}

/**
 * 收 stdout 行，锚定 bash 命令已开始 / 抓 GRANDCHILD_PID。
 * 捕获状态（bashStarted 去重标记 / grandchildPid）挂在 state 上供后续阶段读取。
 */
function attachAnchorWatcher(child, phase, anchorText, state) {
  let buf = "";
  child.stdout.on("data", (chunk) => {
    buf += chunk.toString();
    let idx;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      if (!line.includes(anchorText)) continue;
      if (!state.bashStarted) {
        state.bashStarted = true;
        phase.timeline.push({ t: ts(), event: "bash command observed in event stream" });
        log(`bash command observed (anchor matched)`);
      }
      const m = line.match(/GRANDCHILD_PID=(\d+)/);
      if (m && !state.grandchildPid) {
        state.grandchildPid = Number(m[1]);
        log(`grandchild pid captured from bash output: ${state.grandchildPid}`);
      }
    }
  });
  child.stderr.on("data", () => {});
}

/**
 * 等 bash 命令真实开始。
 * 形态 A（前台 bash）：以「父进程后代进程树非空」为 bash 已启动的权威判据。
 * 形态 B（后台化后代）：后代是 detached 孤儿、不在父树中——以 bash 输出捕获的
 * grandchildPid 为判据（NO-CASCADE 的本质即「父树里看不到后代」）。
 */
function waitForBashStart(parentPid, opts, getGrandchildPid) {
  return waitFor(
    parentPid,
    () => {
      if (opts.waitForSettled) {
        return getGrandchildPid() ? { hit: true, via: "grandchild pid from bash output" } : { hit: false };
      }
      const desc = descendants(parentPid);
      return desc.length > 0 ? { hit: true, descendants: desc } : { hit: false };
    },
    120_000,
    "bash start",
  );
}

/** 形态 B：等 bash 返回 + agent 轮次收尾（settled 后 bash 工具已 untrack）。 */
async function waitAgentSettled(child, phase, parentPid) {
  let settled = false;
  child.stdout.on("data", (c) => {
    if (c.toString().includes('"type":"agent_settled"')) settled = true;
  });
  const s = await waitFor(parentPid, () => ({ hit: settled }), 120_000, "agent_settled");
  phase.timeline.push({
    t: ts(),
    event: s.hit ? "agent_settled observed (bash tool finished, untracked)" : "TIMEOUT waiting settled",
  });
  await new Promise((r) => setTimeout(r, 3000));
}

/** 快照后代清单并汇总本阶段的 target 后代 pid 集合。 */
function collectTargetDescendants(phase, parentPid, dir, grandchildPid, opts) {
  const descBefore = descendants(parentPid);
  phase.timeline.push({
    t: ts(),
    event: "descendant snapshot before SIGTERM",
    parentPid,
    descendants: descBefore,
    grandchildPidFromOutput: grandchildPid,
  });
  log(`descendants before SIGTERM: [${descBefore.join(", ")}]`);

  // 形态 B 需要的后代 pid：优先 bash 输出抓取，否则 pgrep 反查唯一 session-dir
  let targetDescendants = descBefore.slice();
  if (grandchildPid && !targetDescendants.includes(grandchildPid)) targetDescendants.push(grandchildPid);
  if (opts.waitForSettled && targetDescendants.length === 0) {
    try {
      const out = execFileSync("pgrep", ["-f", dir], { encoding: "utf8" });
      targetDescendants = out.split("\n").map(Number).filter(Boolean);
      log(`grandchild recovered via pgrep -f: [${targetDescendants.join(", ")}]`);
    } catch {}
  }
  phase.grandchildPids = targetDescendants;
  return targetDescendants;
}

/** SIGTERM 前验活：形态 B 的后代必须确认稳定存活（防 stdin-EOF 自退类假阳性）。 */
async function verifyGrandchildrenAlive(phase, targetDescendants) {
  await new Promise((r) => setTimeout(r, 4000)); // 启动稳定窗
  const aliveCheck = {};
  for (const pid of targetDescendants) aliveCheck[pid] = psAlive(pid);
  phase.timeline.push({ t: ts(), event: "grandchild alive verification BEFORE SIGTERM", aliveCheck });
  log(`pre-SIGTERM grandchild alive: ${JSON.stringify(Object.fromEntries(Object.entries(aliveCheck).map(([k, v]) => [k, v.alive])))}`);
  phase.grandchildAliveBeforeSigterm = Object.values(aliveCheck).some((v) => v.alive);
}

/** 发 SIGTERM 并等父退出（exit 监听已在 spawn 后前置注册）。 */
async function sigtermAndWaitExit(phase, child, parentPid, getParentExit) {
  phase.timeline.push({ t: ts(), event: "SIGTERM sent to parent" });
  log(`sending SIGTERM to parent ${parentPid}`);
  const sigtermAt = Date.now();
  try {
    process.kill(parentPid, "SIGTERM");
  } catch (e) {
    phase.timeline.push({ t: ts(), event: `SIGTERM failed: ${e.message}` });
  }

  await waitFor(parentPid, () => ({ hit: getParentExit() !== null }), 30_000, "parent exit");
  const parentExit = getParentExit();
  if (parentExit) {
    parentExit.elapsedMs = Date.now() - sigtermAt;
    phase.timeline.push({ t: ts(), event: "parent exit observed", ...parentExit });
    log(`parent exited code=${parentExit.code} signal=${parentExit.signal} after ${parentExit.elapsedMs}ms`);
  }
  if (!parentExit) {
    phase.timeline.push({ t: ts(), event: "parent did not exit within 30s (SIGKILL fallback by probe)" });
    try {
      child.kill("SIGKILL");
    } catch {}
  }
  return parentExit;
}

/** 核对后代存活：+2s 与 +8s 两轮（留进程组 kill 宽限）。 */
async function checkDescendantsAfterSigterm(phase, targetDescendants) {
  for (const waitMs of [2000, 8000]) {
    await new Promise((r) => setTimeout(r, waitMs === 2000 ? 2000 : 6000));
    const status = {};
    for (const pid of targetDescendants) {
      status[pid] = psAlive(pid);
    }
    phase.timeline.push({ t: ts(), event: `descendant check +${waitMs}ms after SIGTERM`, status });
    log(`+${waitMs}ms descendant status: ${JSON.stringify(Object.fromEntries(Object.entries(status).map(([k, v]) => [k, v.alive])))}`);
    phase[`descendantsAliveAfter${waitMs}ms`] = Object.entries(status).filter(([, v]) => v.alive).map(([k]) => Number(k));
  }
}

/** 裁决本 phase 结论（形态 B 验活失败 → invalid trial，不算 NO-CASCADE）。 */
function concludePhase(phase, opts, targetDescendants) {
  const aliveAfter8s = phase.descendantsAliveAfter8000ms ?? [];
  return (
    targetDescendants.length === 0
      ? "inconclusive: no descendants identified"
      : opts.waitForSettled && !phase.grandchildAliveBeforeSigterm
        ? "inconclusive: grandchild not stably alive before SIGTERM (invalid trial)"
        : aliveAfter8s.length === 0
          ? "CASCADE: all descendants killed after parent SIGTERM"
          : `NO-CASCADE: descendants still alive 8s after parent SIGTERM: [${aliveAfter8s.join(", ")}]`
  );
}

// 清理本阶段残余：父 pid + 其子进程树全杀（macOS 非交互 shell 后台 job 不成新组，
// 组杀对 bash -c 管道链无效；管道写端 tail 不随 pi 死亡，必须显式收集）
function killTreeDeep(pid) {
  try {
    const kids = execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" })
      .split("\n")
      .map(Number)
      .filter(Boolean);
    for (const k of kids) killTreeDeep(k);
  } catch {}
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
}

function cleanupPhaseResiduals(child, dir, targetDescendants) {
  for (const pid of targetDescendants) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
    killTreeDeep(pid);
  }
  try {
    child.kill("SIGKILL");
  } catch {}
  setTimeout(() => rmSync(dir, { recursive: true, force: true }), 1000);
}

async function runPhase(phaseLabel, bashCommand, anchorText, opts) {
  log(`=== phase ${phaseLabel} ===`);
  const phase = { phase: phaseLabel, startedAt: ts(), bashCommand, timeline: [] };
  results.phases.push(phase);
  const { dir, child } = spawnParent(phaseLabel);
  const parentPid = child.pid;
  log(`parent pi pid=${parentPid} dir=${dir}`);
  // exit 监听前置（pi 若在 SIGTERM 前自退也要捕获）
  let parentExit = null;
  child.on("exit", (code, signal) => {
    parentExit = { t: ts(), code, signal };
  });
  child.on("error", (err) => {
    phase.timeline.push({ t: ts(), event: `parent spawn error: ${err.message}` });
  });

  const anchorState = { bashStarted: false, grandchildPid: null };
  attachAnchorWatcher(child, phase, anchorText, anchorState);

  child.stdin.write(JSON.stringify({ type: "prompt", message: opts.prompt, id: `${phaseLabel}-1` }) + "\n");
  log(`prompt sent`);

  const started = await waitForBashStart(parentPid, opts, () => anchorState.grandchildPid);
  if (!started.hit) {
    phase.timeline.push({ t: ts(), event: "ERROR: bash start not observed within 120s" });
    phase.conclusion = "inconclusive: bash never started";
    try {
      child.kill("SIGKILL");
    } catch {}
    rmSync(dir, { recursive: true, force: true });
    return phase;
  }

  if (opts.waitForSettled) {
    await waitAgentSettled(child, phase, parentPid);
  } else {
    // 形态 A：bash 前台执行中，多等 3s 让 shell 树稳定
    await new Promise((r) => setTimeout(r, 3000));
  }

  const targetDescendants = collectTargetDescendants(phase, parentPid, dir, anchorState.grandchildPid, opts);

  if (opts.waitForSettled && targetDescendants.length > 0) {
    await verifyGrandchildrenAlive(phase, targetDescendants);
  }

  const parentExitResult = await sigtermAndWaitExit(phase, child, parentPid, () => parentExit);
  await checkDescendantsAfterSigterm(phase, targetDescendants);

  phase.parentExit = parentExitResult;
  phase.conclusion = concludePhase(phase, opts, targetDescendants);
  log(`phase ${phaseLabel} conclusion: ${phase.conclusion}`);
  cleanupPhaseResiduals(child, dir, targetDescendants);
  return phase;
}

const PROMPT_A =
  "Use the bash tool to run exactly this command and do nothing else (do not modify it, do not add a timeout): sleep 240";
// grandchild 的 stdin 必须 keep-open：pi rpc 遇 stdin EOF 会自行退出（已实证），
// 裸 nohup + & 形态下 stdin 继承 /dev/null → 启动即自退 → 级联误判。
// bash -c 包裹 tail|pi 管道：管道整链（bash -c / tail / pi）同进程组且组长 =
// GRANDCHILD_PID（$!），探针收尾组杀可全链覆盖（裸管道形态会泄漏 tail 写端）。
const PROMPT_B =
  "Use the bash tool to run exactly this command and do nothing else (do not modify it): " +
  `bash -c 'tail -f /dev/null | nohup ${PI_BIN} --mode rpc --no-extensions --session-dir GRANDCHILD_DIR_PLACEHOLDER >/dev/null 2>&1' & echo GRANDCHILD_PID=$!`;

// 形态 B 的 session-dir 需要 per-run 唯一——运行时替换占位符
const grandchildDir = mkdtempSync("/tmp/p-t2b-grandchild-");
const PROMPT_B_FINAL = PROMPT_B.replace("GRANDCHILD_DIR_PLACEHOLDER", grandchildDir);

const totalTimer = setTimeout(() => {
  results.abortedReason = "total budget exceeded";
  log("ABORT: total budget exceeded");
  writeResults(3);
}, TOTAL_BUDGET_MS);

function writeResults(code) {
  clearTimeout(totalTimer);
  results.finishedAt = ts();
  // 总裁决：形态 B（主裁决形态）优先
  const pb = results.phases.find((p) => p.phase === "B-background-descendant");
  const pa = results.phases.find((p) => p.phase === "A-foreground-bash");
  results.verdict = {
    phaseA: pa?.conclusion ?? "not run",
    phaseB: pb?.conclusion ?? "not run",
    ruling:
      pb && pb.conclusion?.startsWith("NO-CASCADE")
        ? "后代补杀为主路径（SIGTERM 无级联）"
        : pb && pb.conclusion?.startsWith("CASCADE")
          ? "后代补杀可退化为 no-op 一致性校验（SIGTERM 级联存在）"
          : "不可裁决（探针未获有效形态 B 结果）",
  };
  try {
    writeFileSync(new URL("./p-t2b-results.json", import.meta.url), JSON.stringify(results, null, 2));
  } catch (e) {
    log(`WARN: write results failed: ${e.message}`);
  }
  log(`verdict: ${JSON.stringify(results.verdict, null, 2)}`);
  // 全局清理
  try {
    execFileSync("pkill", ["-f", grandchildDir], { stdio: "ignore" });
  } catch {}
  setTimeout(() => {
    try {
      rmSync(grandchildDir, { recursive: true, force: true });
    } catch {}
    process.exit(code);
  }, 1000);
}

// 串行：A → B；支持 --phase B 只跑指定形态（调试用，正式运行跑全量）。
// runPhase 的裁决数据写 results.phases（writeResults 从中读取），返回值不引用
const onlyPhase = process.argv.includes("--phase") ? process.argv[process.argv.indexOf("--phase") + 1] : null;
if (!onlyPhase || onlyPhase === "A")
  await runPhase("A-foreground-bash", "sleep 240", "sleep 240", {
    prompt: PROMPT_A,
    waitForSettled: false,
  });
if (!onlyPhase || onlyPhase === "B")
  await runPhase("B-background-descendant", PROMPT_B_FINAL, "GRANDCHILD_PID", {
    prompt: PROMPT_B_FINAL,
    waitForSettled: true,
  });

log("all phases done");
writeResults(0);
