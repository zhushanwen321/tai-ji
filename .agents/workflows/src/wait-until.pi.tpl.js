/* @pi-meta
name: wait-until
description: >-
  通用条件等待 workflow：参数化确定性检查原语（git-ancestor / dir-absent / dir-present /
  file-absent / file-present / file-contains）按间隔轮询，全部满足返回结构化报告，
  超时带终态停回。零 subagent 纯机器判定。由 .agents/workflows/src/wait-until.shared.ts
  单源生成（本文件为构建产物，勿手工维护；重建入口 node .agents/workflows/scripts/build-workflows.mjs）
when: 需要等待另一个会话/进程/后台任务完成机器可判定的落盘动作（合并落盘 / 清理 / 文件出现）后再继续
notFor: 需要语义判断的等待（模型判定场景请派 subagent）；观测参数 taskId/executionId 未接入（零 agent 无阶段归属）
phases: ['确认起点状态', '按间隔轮询，等待条件全部满足', '终态复核并汇总结果']
parameters:
  type: object
  properties:
    targetLabel:
      type: string
      description: 等待目标的一句中文描述（进结论文案与进度表标题；必填）
    checks:
      type: string
      description: 检查条件的 JSON 数组（字符串或对象数组均可）。每项 = type 原语名 + 必填参数：git-ancestor 需 branch 与 target（可选 gitDir，分支头已并入目标 ref 或分支已随收尾删除均算满足）；dir-absent / dir-present / file-absent / file-present 需 path；file-contains 需 path 与 text（text 为单行固定子串）
    pollSeconds:
      type: integer
      description: 轮询间隔秒数（≥5），默认 900 = 15 分钟
    maxRounds:
      type: integer
      description: 轮询轮数上限（≥1），默认 96（与默认间隔合 = 24 小时）
    cwd:
      type: string
      description: 检查命令的工作目录（可选；建议绝对路径。缺省 = 发起进程当前目录）
usage: |
  ## 使用说明
  - 发起：workflow 工具 action=run + name=<本脚本绝对路径>（取 <available_workflows> 清单的 location），
    args 平铺传参示例：targetLabel="dev-0.12.4 两线合并落盘"
    checks='[{"type":"git-ancestor","branch":"feat-x","target":"dev-0.12.4","gitDir":".bare"},{"type":"dir-absent","path":"feat-x"}]'
    pollSeconds=900 maxRounds=96 cwd=<workspace 根绝对路径>
  - 终态 return：全部条件满足 = 完成报告（conclusion/findings/verified/notCovered，可进入后续流程）；
    超时 = 带各条件终态的停回报告（被等待方可能卡在人工裁决环节）
  - 命令词表：全部判定经 bash 包装（git / test / grep / sleep），argv 传参无注入面
*/

// ══ pi 壳（平台适配层）══
// 公共体（wait-until.shared.ts）以 zcode 原生形态书写（world.run / report / artifact /
// phase / args），构建管线对公共体做词法安全改写并剥离 TS 后在 @@STITCH@@ 处拼入本壳。
// 本壳提供宿主注入物。生成物勿手工维护。
// 本 workflow 无 agent( 调用点（构建器 NO_AGENT 显式登记），故无 wfAgent/SCHEMA_BY_KEY。

// ── $ARGS（平铺字符串）→ args 对象（zcode 形态）──
// 只做承载形态转换；白名单校验与类型 fail-fast 全部由公共体参数段接管（单一权威，
// 两平台同一套报错）。_runId 是 pi 引擎注入的内部字段，不属于业务参数，不进 args。
const fs = require("fs");
const { spawn } = require("child_process");
const strArg = (v) => (typeof v === "string" ? v.trim() : "");
const numArg = (v) =>
  typeof v === "number" && Number.isFinite(v)
    ? v
    : typeof v === "string" && /^\d+$/.test(v.trim())
      ? Number(v.trim())
      : v;
const args = {};
{
  const raw = $ARGS || {};
  if (raw.targetLabel !== undefined) args.targetLabel = strArg(raw.targetLabel);
  if (raw.checks !== undefined) args.checks = raw.checks; // 数组或 JSON 字符串原样传，公共体统一窄化
  if (raw.pollSeconds !== undefined) args.pollSeconds = numArg(raw.pollSeconds);
  if (raw.maxRounds !== undefined) args.maxRounds = numArg(raw.maxRounds);
  if (raw.cwd !== undefined) args.cwd = strArg(raw.cwd);
}

// ── 子进程包装（zcode world.run 同构返回）。async spawn + POSIX 进程组（detached）：
// 轮询命令含长 sleep，超时必须整组 kill；与 pr-lifecycle 壳 runCmd 同构（同款超时/
// 进程组/ENOENT 语义，两端 world.run 行为一致）。ENOENT 归一 exit 2 + [cmd-missing]
// stderr 标记。abort 边界：引擎 abort 只杀 worker 线程不通知本脚本，detached 子树
// （长 sleep）会跑完自然退出——sleep 有自身时长上界（pollSeconds+50s 超时），无泄漏面。
const CMD_MISSING = "[cmd-missing]";
function killGroup(child, sig) {
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, sig);
    else child.kill(sig);
  } catch {
    // 进程/组已退出
  }
}
function runCmd(cmd, argsArr, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(cmd, argsArr, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const cap = 64 * 1024 * 1024;
    const collect = (chunksRef) => {
      const chunks = chunksRef.chunks;
      return (d) => {
        chunks.push(d);
        chunksRef.len += d.length;
        while (chunksRef.len > cap) {
          chunksRef.len -= chunks[0].length;
          chunks.shift();
          chunksRef.truncated = true;
        }
      };
    };
    const outRef = { chunks: [], len: 0, truncated: false };
    const errRef = { chunks: [], len: 0, truncated: false };
    child.stdout.on("data", collect(outRef));
    child.stderr.on("data", collect(errRef));
    let timedOut = false;
    const timeoutNote = (t) => (t ? "\n[timeout] 子进程超时被终止（整进程组：" + cmd + " " + argsArr.join(" ") + "）" : "");
    const truncateNote = (ref, label) => (ref.truncated ? "\n[truncated] " + label + " 超 64MB，仅保留末段" : "");
    let timer = null;
    let killer = null;
    let forceSettle = null;
    const settle = (exitCode, extraStderr) => {
      if (timer) clearTimeout(timer);
      if (killer) clearTimeout(killer);
      if (forceSettle) clearTimeout(forceSettle);
      resolve({
        exitCode,
        stdout: Buffer.concat(outRef.chunks).toString("utf-8"),
        stderr:
          Buffer.concat(errRef.chunks).toString("utf-8") +
          truncateNote(outRef, "stdout") +
          truncateNote(errRef, "stderr") +
          (extraStderr || ""),
      });
    };
    if (typeof timeoutMs === "number") {
      timer = setTimeout(() => {
        timedOut = true;
        killGroup(child, "SIGTERM");
        killer = setTimeout(() => killGroup(child, "SIGKILL"), 10_000);
        forceSettle = setTimeout(() => {
          killGroup(child, "SIGKILL");
          settle(124, timeoutNote(true) + "\n[force-settle] 进程组回收超时强制返回");
        }, timeoutMs + 15_000);
      }, timeoutMs);
    }
    child.on("error", (err) => {
      if (err && err.code === "ENOENT") {
        settle(2, CMD_MISSING + " 命令不存在: " + cmd + "（不在 PATH）——安装该命令后重新发起\n");
      } else {
        settle(1, "[spawn-error] " + String(err && err.message ? err.message : err) + "\n");
      }
    });
    child.on("close", (code) => {
      settle(timedOut ? 124 : code === null ? 1 : code, timeoutNote(timedOut));
    });
  });
}

// ── 其余宿主注入物（zcode 通道 → pi 等价物）──
const world = {
  run: (cmd, argsArr, opts) => runCmd(cmd, argsArr, opts && Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : undefined),
};
const report = (obj) => log("[report] " + JSON.stringify(obj));
const artifact = {
  // pi 无进度表卡片通道：表声明与心跳走 log
  table: (_id, spec) => { log("[artifact-table] " + (spec && spec.title ? spec.title : "")); },
  markdown: async (_name, content) => { log(content); },
};

@@STITCH@@
