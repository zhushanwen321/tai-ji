/* zcode-workflow
description: merge skill 的九阶段合并发布单 workflow（15 step）：preflight → init（阶段 0）
  → squash-check（0.5，agent 粒度判定，需整理停回批准）→ premerge（1）→ prune-devlink（1.5）
  → pr-merge（2）→ post-merge-ci（3，no-runs 放行补验）→ version-check（3.5）→ e2e-select
  （3.7，只圈清单不跑真机）→ bump-release（4，幂等预检 + 原子 bump + tag/push + verify）
  → npm-detect（4N 检测移交主 agent）→ notes（5，agent 写双语 + 机器校验）→ verify（6）
  → gitcode-sync（6.5 四子步）→ cleanup（7，零未决失败机器门禁）。异常三层 = 脚本内韧性
  复用 + FAILURE_ROUTES 机器分类路由（retry/retry-extended/rescue/escalate）+ rescue 兜底
  agent（仅 premerge/version-check/bump-release 白名单，修复后重跑原脚本判定）。单源生成：
  本文件由 .agents/workflows/src/merge.shared.ts + 本壳经 .agents/workflows/scripts/
  build-workflows.mjs 生成（勿手工维护；pi 版同源 = .agents/workflows/merge.js）。
whenToUse: zcode 主 agent 执行 merge skill（含 pr-cr-fix-merge 第二段）的合并发布流程时发起
  本 workflow（CreateWorkflow path 指向本文件 + args.worktree）。终态 released/failed/
  needs-squash-approval/needs-human 一律 return 结构化结果，失败带恢复指引。
args:
  worktree:
    type: string
    description: feature worktree 绝对路径（必传，如 <workspace>/feat-xxx；不得为 main——阶段 7 会删除该 worktree）。全部命令经 bash -c 'cd <main 或该 worktree> && exec "$@"' 包装执行，不依赖会话 bash
  prNumber:
    type: number
    description: PR 号（可选，缺省由 init.sh 输出取；skipSteps 含 init 时必传；与 init 实测不一致会 fail-fast）
  squashMode:
    type: string
    description: commit 整理档位：auto（agent 判定，无需整理放行/需整理停回出计划）/ skip（显式跳过整理），默认 auto
    default: auto
  maxRescueRounds:
    type: number
    description: 单阶段 rescue 兜底修复轮次上限（0-5 整数；0 = 不派 rescue agent，失败直接停回），默认 2
    default: 2
  skipSteps:
    type: json
    description: 跳过的 step id 数组（人工接管逃生舱；合法值 preflight/init/squash-check/premerge/prune-devlink/pr-merge/post-merge-ci/version-check/e2e-select/bump-release/npm-detect/notes/verify/gitcode-sync/cleanup）。注意：squash-check 之外被跳过的 step 会触发清理门禁 needs-human（环节未在流程内验证，禁止带病清理）
    default: []
  taskId:
    type: string
    description: 阶段观测任务 id（可选；与 executionId 同时给出才启用观测，缺省零行为差异）
  executionId:
    type: string
    description: 阶段观测执行 id（可选；与 taskId 同时给出才启用；事件落 ~/.agents/skill-data/workflow-observability/<task-id>/<execution-id>.jsonl）
  sampleType:
    type: string
    description: 观测事件采样标记（production | selftest，默认 production；自动化验证用 selftest）
*/

// ── 阶段观测平台钩子（O 区；公共观测层 observability.shared.ts 经构建器拼入本产物，
//    业务正文只声明阶段边界）──
// 事件契约与落盘路径由公共层单一承载：{execution_id, task_id, skill, stage, step, round,
// attempt, event, timestamp, sample_type[, outcome]} →
// ~/.agents/skill-data/workflow-observability/<task-id>/<execution-id>.jsonl（append）。
// 本壳只提供两个平台钩子：obsNow（时间戳探针；world.run journal 语义，resume 重放回放
// 首次记录值）与 obsAppend（追加写；argv 传参无 shell 注入风险）。观测为辅助通道：写失败
// 由公共层统一告警（同文件一次）不改业务终态（与 pi 壳同契约）。
const OBS_APPEND_SCRIPT =
  "require('fs').mkdirSync(require('path').dirname(process.argv[1]),{recursive:true});" +
  "require('fs').appendFileSync(process.argv[1],process.argv[2]+'\n')";
async function obsNow(): Promise<string | null> {
  const r = await world.run("node", ["-e", "process.stdout.write(new Date().toISOString())"]);
  return r.exitCode === 0 && r.stdout.trim() !== "" ? r.stdout.trim() : null;
}
async function obsAppend(filePath: string, line: string): Promise<string | null> {
  const w = await world.run("node", ["-e", OBS_APPEND_SCRIPT, filePath, line]);
  return w.exitCode === 0 ? null : `exit ${w.exitCode}：${tailLines(w.stderr, 2)}`;
}

@@STITCH@@
