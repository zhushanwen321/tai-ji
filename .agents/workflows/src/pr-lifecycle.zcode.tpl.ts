/* zcode-workflow
description: pr-cr-fix 的 PR 全生命周期单 workflow（9 step）：发起前检查 → 静态门禁
  （typecheck+lint，含条件 skill-yaml 校验）→ PR 标题/描述起草 + changeset 复核（缺失时按
  Gate-1a.5 原逻辑补起草兜底）→ 开 PR → 约束加载 → 覆盖率+度量聚合门禁（含 PR 规模披露）→
  条件评审修复循环（cr-fix 代码审查维度默认不派；显式 reviewers 参数是唯一开启方式，
  流程不读分支名做决策；循环本体 = 内联 review-fix-loop：并行
  review → 聚合 → 分组修复 → 对账重审）→ code-simplify → 终局三道门禁 → 停在 awaiting-push 等
  push 授权。单源生成：本文件由 .agents/workflows/src/pr-lifecycle.shared.ts + 本壳经
  .agents/workflows/scripts/build-workflows.mjs 生成（勿手工维护；pi 版同源 =
  .agents/workflows/pr-lifecycle.js）。
whenToUse: zcode 主 agent 执行 pr-cr-fix skill 的完整 PR 生命周期时发起本 workflow（CreateWorkflow
  path 指向本文件 + args）。只跑 review+fix 循环不进门禁时用全局 saved workflow review-fix-loop。
args:
  base:
    type: string
    description: 审查/门禁基线 ref 名（git diff base...HEAD；gate 脚本对该值做文本比对，传 ref 名不传 hash）
    default: main
  maxRounds:
    type: number
    description: cr-fix review→fix 循环轮次上限
    default: 10
  worktree:
    type: string
    description: feature worktree 绝对路径（可选）。宿主会话目录即该 worktree 时可省（命令按环境 cwd 执行）；zcode 会话目录绑 workspace 根（bare 容器，非 git 仓库）时必须传——全部命令经 bash -c 'cd <worktree> && exec "$@"' 包装执行
  reviewers:
    type: json
    description: review 维度白名单（字符串数组，对 .agents/skills/dev-merge/agents/review-*.md 按路径子串匹配裁剪；资产所有权归 dev-merge，本流程仅经此显式逃生舱引用）；缺省不传 = cr-fix 代码审查维度不派（默认，与分支无关）；显式传入 = 按白名单派发审查
  simplifyMode:
    type: string
    description: code-simplify 档位：apply（A 档高置信项自动改码并独立 commit）/ report（只产报告不改码）
    default: apply
  skipSteps:
    type: json
    description: 跳过的 step id 数组（人工接管逃生舱；合法值 preflight/static-gate/pr-meta/pr-submit/constraints/gate-suite/cr-fix/simplify/final-gates，终态逐项披露）
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
// 首次记录值）与 obsAppend（追加写；argv 传参无 shell 注入面）。观测为辅助通道：写失败
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
