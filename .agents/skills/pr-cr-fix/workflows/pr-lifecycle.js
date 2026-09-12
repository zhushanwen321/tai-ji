// pr-lifecycle — PR 全生命周期 workflow 入口（zsw 1.2.0 core 契约）
//
// 设计：docs/design/pr-lifecycle-workflow.md（含 impl-plan，均已删除，git 可追溯）
// 结构：本入口只做 io 适配层组装（引擎注入 → 纯逻辑库），全部状态机/守卫/walker
// 在 ./pr-lifecycle/lib.cjs（依赖注入，node 直测：test/run-tests.js）。
// lib.createPrSteps 产出 §3.3 完整十二 step 注册表
// （preflight → static-gate → changeset → pr-meta → skill-yaml → pr-submit →
//   constraints → coverage-1 → metrics-1 → cr-fix → simplify → final-gates）。
//
// 恢复通道：终态 scriptResult 必含 runId；暴毙时 cat .review/pr-workflow/latest。

/* @pi-meta
name: pr-lifecycle
description: >-
  PR 全生命周期单脚本编排：开 PR、静态与覆盖率与度量门禁、review-fix 循环、code-simplify 到待 push 终态，任意环节失败后带 runId 重新发起即从断点续跑
when: 需要执行 pr-cr-fix 全流程（从开 PR 到终局门禁、最终 push 之前）时
notFor: 只做最终 push、单跑某道门禁、或 merge 与 release 流程时
phases: []
parameters:
  type: object
  additionalProperties: false
  properties:
    task: { type: string, description: 任务描述（zsw CLI 必填 flag，引擎存入 run spec 供通知与查询展示；脚本不消费其语义，normalizeParams 白名单不收——值不进 state.params） }
    runId: { type: string, description: 断点恢复键；缺失 = 从头执行，存在 = 从未完成的第一个 step 续跑 }
    repo: { type: string, minLength: 1, description: 目标仓库根绝对路径（workdir 是引擎保留键不进脚本参数；缺省回落宿主 cwd 并在日志注明回落事实，目标仓库非宿主 cwd 时必传；非仓库根会 fail-fast） }
    base: { type: string, default: main, description: PR 目标基线分支，全流程 review 与 diff 口径锁定为发起时该 ref 指向的 commit }
    reviewers:
      anyOf:
        - { type: array, items: { type: string } }
        - { type: string, description: 逗号分隔维度名 }
      description: cr-fix 审查维度裁剪（默认全量 8 维）；值为 agent 名或路径关键词
    maxRounds: { type: integer, default: 10, minimum: 1, description: cr-fix 循环轮次上限透传给嵌套 loop }
    aggregatorModel: { type: string, description: 聚合阶段模型（provider/model 全名，如 zai-coding-cn/glm-5.3-flash——须为当前引擎侧存在的 provider）；缺省跟随 run 模型，仅当聚合需降档/升档时设置 }
    simplifyMode: { type: string, enum: [apply, report], default: apply, description: apply = 自动落地高置信 A 档简化并独立 commit；report = 只出报告不改码 }
    skipSteps:
      anyOf:
        - { type: array, items: { type: string } }
        - { type: string, description: 逗号分隔 step 名（CLI 直参形态） }
      default: []
      description: 人工接管逃生舱——列出未完成 step 标记为用户确认跳过，终态逐项披露
    allowExternalChanges: { type: boolean, default: false, description: resume 时 HEAD 存在非本 run 产生的外部 commit 时显式放行重跑检查 }
usage: |
  ## 发起（主 agent 一次调用；workdir 传 repo 绝对路径）
  zsw workflow --workflow pr-lifecycle --workdir <repo 绝对路径> --timeout-ms 21600000
  ## 断点恢复
  带 runId=<state 里或 .review/pr-workflow/latest 的 prw-* id> 重新发起同一 workflow
  ## 终态
  awaiting-push（待用户授权 push）/ failed（error 含 resumeCommand，可直接复制执行）
*/

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

// 入口脚本被引擎内联执行（__dirname 无效），lib 锚定 workerData.scriptPath（入口绝对路径）。
// lib 位于入口同级的 pr-lifecycle/ 子目录（impl-plan 偏差 1：子目录不进 workflow 顶层 *.js 扫描）
const libDir = path.join(path.dirname(workerData.scriptPath), 'pr-lifecycle');
const lib = require(path.join(libDir, 'lib.cjs'));

// repoRoot 解析（Gate B S1）：workdir 是引擎 RUN_ENVELOPE_KEYS 保留键，不进 $ARGS——
// 脚本读不到发起方传的 workdir。优先 --repo 显式传入；缺省回落 $WORKSPACE（宿主 cwd），
// 回落事实记入日志首行。是否为 git 仓库根由 lib.runPipeline 开头守卫校验（非根 fail-fast）。
const repoRoot = lib.resolveRepoRoot((typeof $ARGS === 'object' && $ARGS !== null) ? $ARGS : {}, $WORKSPACE); // 直读引擎全局——io 在下方才定义（TDZ）

const engineStateDir = path.join(os.homedir(), '.zcode', 'zsw', 'workflow-state'); // 活性守卫主通道：引擎 run state 文件目录

// 活性守卫主通道：读引擎 run state 文件末行 state.status（P5 实证 JSONL 形态）。
// 未知/缺失状态值返回 ok:false 由 lib 按 fail-closed 处理（降级 pid 探测）。
function readEngineState(engineRunId) {
  if (!engineRunId) return { ok: false, reason: 'no engineRunId' };
  const file = path.join(engineStateDir, `${engineRunId}.jsonl`);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const lastLine = raw.trim().split('\n').pop() || '';
    const entry = JSON.parse(lastLine);
    const lastStatus = entry && entry.state && entry.state.status;
    if (typeof lastStatus === 'string') return { ok: true, status: lastStatus };
    return { ok: false, reason: `last line has no state.status (${file})` };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
}

// 降级通道：信号 0 探测（不杀进程）；EPERM 等异常按存活处理（fail-closed）
function probePid(pid) {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (e) {
    return e && e.code === 'ESRCH' ? 'dead' : 'alive';
  }
}

// agent 适配层：强制 returnMeta:true（引擎 agent 失败不 reject，错误只能经 meta
// 观测）；steps 执行体的 agent 调用统一经 ctx.io.agent 走此适配层。
async function agentAdapter(params) {
  const meta = await agent({
    description: params.description || 'pr-lifecycle-agent',
    ...params,
    returnMeta: true,
  });
  const err = meta && meta.error;
  if (err) {
    log(`[agent] 调用失败（${params.description || 'unnamed'}）：${err}`);
  }
  return { value: meta && meta.value, error: err || null, meta: meta || null };
}

// 嵌套 workflow 适配层（cr-fix step 使用；引擎契约：返回 {content, parsedOutput}）
async function workflowAdapter(name, params) {
  return workflow(name, params);
}

function log(...msg) {
  console.error('[pr-lifecycle]', ...msg);
}

const io = {
  args: (typeof $ARGS === 'object' && $ARGS !== null) ? $ARGS : {},
  repoRoot,
  pid: process.pid,
  fs,
  sh: lib.createSh({ execFileSync, defaultCwd: repoRoot }),
  env: process.env,
  homedir: () => os.homedir(),
  agent: agentAdapter,
  workflow: workflowAdapter,
  log,
  readEngineState,
  probePid,
  now: () => new Date(),
  randomToken: () => crypto.randomBytes(2).toString('hex'),
  steps: lib.createPrSteps({ repoRoot }), // 十二 step 完整注册表（§3.3 全序）
};

if (!io.args.repo) {
  log(`repoRoot 回落：$ARGS.repo 未传，取宿主 cwd（$WORKSPACE）=${repoRoot}——目标仓库非宿主 cwd 时必须用 --repo 传仓库根绝对路径`);
}

// 顶层 return Promise：worker 将本脚本内联进 async IIFE，async 函数的 return
// 语义自动展开 Promise（等价 await 后 return）；同时保持 node --check（CJS）语法合法。
return lib.runPipeline(io);
