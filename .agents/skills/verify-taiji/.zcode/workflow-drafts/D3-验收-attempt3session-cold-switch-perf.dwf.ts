/* zcode-workflow
description: dev-flow-wf W2 通用 DAG 调度引擎（wave-executor）：读 exec-plan.json 做启动校验
  （schema/依赖环/文件存在性/工作区干净基线），依赖就绪节点流式派发（≤5 并发，wave 字段
  仅展示不参与调度），每节点确定性核验（files_changed ⊆ 声明范围 + 全量 status 粗粒度复核 +
  节点测试命令重跑）→ commit → 解锁后继；核验不过打回同名 agent 定向修（≤2 轮，超限
  blocked 且后继挂起）；acceptance 模式承载 verify/inspect 节点 + §8.7 依赖可达性熔断
  （blocked/failed 卡未终态后继即停；原 coreIds/haltOnCoreFail 静态短路已退役）；终态 completed / blocked / core-failed，全程 failed-as-return 不 throw。
whenToUse: dev-flow-wf 的 D1 开发循环与 D3 端到端验收发起本 workflow（CreateWorkflow path
  指向本文件 + args.execPlan）。exec-plan.json 由 D0 从设计包编译产出；断点恢复走
  ResumeWorkflowRun（node-<unitId> 命名保缓存）或按 status.json 人读恢复（git 为准）。
args:
  execPlan:
    type: string
    required: true
    description: exec-plan.json 绝对路径（D0 编译产出：nodes/依赖/范围声明/testCommand/promptFile/statusPath/commitTemplate/acceptance 分组）
*/

// ── 类型契约 ──

/** 节点任务书末尾定义的 JSON 契约（dev 与 inspect 节点共用） */
interface NodeResult {
  /** done = 本单元工作完成且自测通过；fail = 有未解决问题；blocked = 无法继续 */
  status: "done" | "fail" | "blocked";
  /** 改动文件路径（相对节点工作区 git 仓库根的 git 风格路径，须 ⊆ 任务书范围声明） */
  files_changed: string[];
  /** 自测证据：跑了什么命令、结果如何 */
  test_evidence: string;
  /** 与任务书的偏离说明（无偏离为空数组） */
  deviations: string[];
  /** 阻塞项（环境缺失/任务书矛盾等；非空则节点判 blocked，不进入打回） */
  blockers: string[];
  /** commit message {summary} 占位符的一句话摘要（缺省用固定短语） */
  summary?: string;
}

/** 确定性核验结论：pass=过 / retry=可打回修 / blocked=引擎层或环境问题（打回修不了） */
interface VerifyVerdict {
  outcome: "pass" | "retry" | "blocked";
  reason: string;
  detail: string;
}

/** 验收自愈归因结论（设计 §8.7）：三分类 + 证据 + 失败面文件集 */
interface HealVerdict {
  /** spec-bug=验收资产自身缺陷（可修复重验）/ product-bug=被测产品缺陷（不修，依赖判定）/ environment=超时资源类（重试一次） */
  class: "spec-bug" | "product-bug" | "environment";
  /** 一句话证据（引用失败输出原文） */
  evidence: string;
  /** 归因指向的文件（spec-bug 时为验收资产文件；product-bug 时为产品文件——只读呈报不修复） */
  failureFiles: string[];
  /** spec-bug 修复要点（可空串） */
  fixHint: string;
}

/** 验收资产修复自报（自报仅供历史记录，重验由引擎机器判定） */
interface HealFixReport {
  /** 实际修改的验收资产文件 */
  fixed: string[];
  /** 一句话修复说明 */
  summary: string;
}

interface TestCommand {
  program: string;
  args: string[];
}

/** 校验归一后的执行计划节点（路径全部绝对化；按 kind 只填对应字段） */
interface PlanNode {
  id: string;
  kind: "dev" | "verify" | "inspect";
  deps: string[];
  /** 设计章节锚（D0 从 impl-plan 章节映射提取；commit 渲染时前置于 summary——老三要素保真） */
  designRef: string;
  territory: string[];
  testCommand: TestCommand | null;
  promptFile: string;
  script: string;
  artifactsDir: string;
  artifactsRefs: string[];
  cwd: string;
}

interface ParsedPlan {
  version: number;
  mode: "dev" | "acceptance";
  projectRoot: string;
  statusPath: string;
  commitTemplate: string;
  baseline: string | null;
  nodes: PlanNode[];
}

type ValidateResult = { ok: true; plan: ParsedPlan } | { ok: false; errors: string[] };

/** status.json 单节点条目 */
interface StatusEntry {
  status: "pending" | "in-progress" | "done" | "blocked" | "failed" | "suspended";
  attempts: number;
  commit?: string;
  evidence?: string;
}

interface StatusEvent {
  seq: number;
  node: string;
  event: string;
  detail?: string;
}

interface StatusFileData {
  baseline: string | null;
  nodes: Record<string, StatusEntry>;
  events: StatusEvent[];
  /** schema 外的顶层字段（name/updated 等 D0 产物）——回写时原样保留不抹除（§4.5） */
  extra: Record<string, unknown>;
}

/** 调度器内存态（崩溃恢复事实源是 status.json + git，不是这个 Map） */
interface NodeRt {
  status: "pending" | "in-progress" | "done" | "blocked" | "failed";
  attempts: number;
  reason?: string;
  detail?: string;
  commit?: string;
}

/** workflow 终态（failed-as-return 的结构化载体） */
interface WaveExecutorOutcome {
  /** completed=全 done；blocked=存在 blocked/failed/挂起；core-failed=核心组熔断 */
  terminated: "completed" | "blocked" | "core-failed";
  done: string[];
  /** blocked（打回超限/自报 blockers/引擎层失败）与 failed（验收负结果）合记，reason 注明类型 */
  blocked: { id: string; reason: string; attempts: number }[];
  /** 因上游 blocked 或熔断而从未派发（依赖挂起）的节点 */
  skipped: string[];
  /** status.json 绝对路径（人读恢复入口；启动校验失败时为空串） */
  statusFile: string;
  /** core-failed 归因（哪个节点/什么输出）；非 core-failed 为 null */
  coreFailure: { id: string; detail: string } | null;
  /** 启动校验失败详情（terminated=blocked 且未派发任何节点时非 null） */
  validationError: string | null;
  /** 核验通过但 commit 被拒（多为仓库钩子全仓检查 × 并行半成品）转待办的节点——
   *  主 agent 收尾代提交（git commit <message> -- <files>，钩子照常执行） */
  deferredCommits: { id: string; message: string; files: string[]; err: string }[];
  /** 收尾全工作区对账后的清单外残留（不属于任何节点范围声明 ∪ 自报 files_changed 并集，
   *  含并行单元新建文件与未申报改动）——主 agent 判归属后处置（提交/清理/登记新范围声明） */
  residualFiles: string[];
}

interface RunOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
}


// ── F 区平台钩子：zcode 同名续聊天然承载打回上下文，钩子原样返回打回指令 ──
function withPrevContext(initialPrompt: string, lastResult: NodeResult | null, retryPrompt: string): string {
  void initialPrompt;
  void lastResult;
  return retryPrompt;
}

// ── host 标识（run manifest host 字段，skill-data-redesign §5.1：shared 不留 host
// 硬编码，两壳各持常量）──
const HOST_PLATFORM = "zcode";

// ── W2 wave-executor ──
// 语义权威：设计文档 §8.2（调度语义）/ §8.3（exec-plan schema）/ §6.2（D1/D3 时间线）。
// 调度只看依赖边：deps 全 done 即派发；wave 字段完全不参与调度（仅 D0 侧展示标签）。
// 并发 ≤5，逐节点 settle 即重算（设计 §8.2：单节点完成立即解锁后继补派，不等批内
//   其他节点——长尾不拖批；活跃声明范围并集随活跃集动态重建）。
// agent 会话异常 → 接替程序（新 agent 名 + 前任证据包 + 当前 diff，先核验现状再续作，
//   设计 §6.2 F15 第一等路径）；接替者再异常才 blocked。
// 一律 failed-as-return：throw 的 errored run 不可 resume 且丢结构化错误（参数校验除外
//   ——args 非法属启动期快失败，errored 形态可接受）。
// 边界声明（设计 §8.2，2026-09-29 裁决范围声明降级）：并行单元共享工作区时，单单元改动
//   归属无法由 git status 精确切分，核验采用对账语义——dev 自报 files_changed 超出
//   territory 声明范围不打回，登记对账事件随终态呈报；引擎收尾对全工作区清单外残留做
//   对账（residualFiles），启动前既有改动登记豁免集不拒启动（2026-09-26 裁决），终态
//   残留对账只对本次 run 产生的改动。territory 声明仅剩两职责：启动互斥断言（并行单元
//   防写冲突的最小机制——声明重叠且无依赖边拒绝启动）与 DAG 编排参考；运行时逐文件
//   核验与扩展通道已删（实测零命中真越权、反致扩展死锁），多开发/少开发的一致性由
//   D2 一致性审查承接。
// 边界声明（设计 §8.5）：worktree 单元的「合并回主分支才就绪」不做引擎侧自动检测——
//   由 D0 编译负责排布合并（合并节点或手工段）。

// ── args 窄化（未知键 fail-fast：拼错键静默忽略比报错危险） ──
const VALID_ARG_KEYS = new Set(["execPlan"]);
for (const key of Object.keys(args)) {
  // `_` 前缀 = 宿主运行时私有键（如 taiji/pi 宿主注入的 _runId），不属于脚本契约，跳过白名单（2026-10-03 实测缺陷修复）
  if (!VALID_ARG_KEYS.has(key) && !key.startsWith("_")) {
    throw new Error(`未知参数: ${key}（唯一合法参数: execPlan——exec-plan.json 绝对路径）`);
  }
}
if (typeof args.execPlan !== "string" || args.execPlan.trim() === "") {
  throw new Error(
    "缺少必填参数 execPlan（exec-plan.json 绝对路径，由 D0 编译产出）。" +
      "若本次经 AmendWorkflow 重发：派生 run 不继承原 run 的 args，须改用 CreateWorkflow 携 args 重新发起",
  );
}
const execPlanPath = args.execPlan.trim();

// ── 常量 ──

const MAX_CONCURRENCY = 5; // 用户指定的全局并发上限（批大小）
const MAX_REJECT_ROUNDS = 2; // 打回定向修上限（初始 1 次 + 打回 2 次 = 至多 3 次 ask）
const MAX_HEAL_ROUNDS = 10; // 验收自愈轮次上限（设计 §8.7：沿用现成 maxRounds=10；超限走依赖可达性判定）
const TAIL_LINES = 40; // 失败输出贴入打回 prompt 的行数上限
const TEST_TIMEOUT_MS = 7200000; // 节点测试命令兜底墙钟（2026-10-26 用户裁决：全部 ≥1h；world.run 默认 300s 会误杀大仓单测）
const VERIFY_SCRIPT_TIMEOUT_MS = 7200000; // 验收剧本兜底墙钟（2026-10-26 用户裁决：全部 ≥1h，任务级=小时级）
const TEST_WHITELIST = ["pnpm", "npm", "node", "git", "bash"] as const;
/** verify 剧本合法扩展名（启动 fail-fast；解释器分派判据 = .sh→bash、其余→node——
 *  调整本集合须同步核对 runVerifyScript 的分派） */
const VERIFY_SCRIPT_EXTS = new Set([".sh", ".mjs", ".js", ".cjs"]);
const VALID_ENTRY_STATUS = new Set(["pending", "in-progress", "done", "blocked", "failed", "suspended"]);

// T9（用户裁决 2026-09-26）：workflow 内无用户交互位，任何 agent 不得提问——无法自决的
// 按职责内默认规则处置 + 记录待裁决事项随终态呈报。随 persona 固化进全部 agent。
const NO_ASK_RULE =
  "禁止向用户提问（无 AskUserQuestion / ask-user / 任何等待用户输入的操作）——workflow 内没有用户交互位；" +
  "无法自决的事项按职责内默认规则处置，并在产出中记录待裁决事项（随终态呈报主 agent / 用户）。";

const DEV_PERSONA =
  "你是开发单元执行者：严格按任务书改码，优先改任务书声明范围内的文件；" +
  "确需改范围外的文件时直接做，并在 files_changed 如实申报、deviations 写明原因（引擎对账呈报不打回）；" +
  "禁止触碰其他并行单元声明范围内的文件（并行写冲突会互相覆盖丢改动）；" +
  "测试范围 = 任务书 testCommand 指定的命令及其触及的测试文件，跑通后再交付——禁止跑包级全量套件或跨包扫描" +
  "（全量回归由后续全量测试门统一承担，单元级全量是重复劳动）；testCommand 覆盖不了你的改动行为时在 " +
  "deviations 申报，不要自行扩跑；" +
  "不要自行 git add / git commit——引擎核验通过后统一提交，自行提交会破坏状态对账与并行调度；" +
  "引擎会确定性重跑测试并对改动做对账登记（范围外改动如实申报即可），伪造 files_changed 或测试证据必被抓住；" +
  "任务书与现实冲突、环境缺失时如实填报 blockers/deviations，不要硬编绕过。" +
  NO_ASK_RULE;

const INSPECT_PERSONA =
  "你是验收检查执行者：只读检查（可运行只读命令、读文件），不修改任何代码、不产生 commit；" +
  "按任务书逐项核对并如实返回结论；证据不足就如实说，不猜测、不夸大。" +
  NO_ASK_RULE;

// ── 验收自愈 persona（设计 §8.7）──

const DIAGNOSE_PERSONA =
  "你是验收失败归因员：只读分析（可读失败日志 / 产物文件，可跑只读命令），不修改任何文件；" +
  "判定失败根因类别并给证据——证据必须引用失败输出原文，不猜测；" +
  NO_ASK_RULE;

const HEAL_PERSONA =
  "你是验收资产修复者：只修改归因指定的验收资产文件（测试 spec / 验收剧本 / 断言），禁止修改任何产品代码；" +
  "修复必须以归因证据为依据（断言口径错→改对口径 / 等待时序错→改等待点 / 窗口失配→按实测校准），" +
  "禁止无证据地放宽断言、删除断言或跳过用例换绿灯；修完如实返回修改清单；" +
  NO_ASK_RULE;


// ── node -e 通道（脚本无 fs/process：写盘/读文件/git/带 cwd 的子进程全走 world.run node -e，
//    argv 传参无 shell 注入面；代码串内可 require Node 内建） ──

const WRITE_FILE =
  "require('fs').mkdirSync(require('path').dirname(process.argv[1]),{recursive:true});require('fs').writeFileSync(process.argv[1],process.argv[2])";
const READ_FILE_QUIET = "try{process.stdout.write(require('fs').readFileSync(process.argv[1],'utf8'))}catch{}";
const EXISTS = "process.exit(require('fs').existsSync(process.argv[1])?0:1)";

// skillDataDir 探针组（impl-spec §2.1：脚本无 import，路径解析走 node -e 子进程）：
// home 探针 + project-slug 探针（realpath + sha256 前 8 位十六进制小写，全域唯一算法与
// 同一组固定测试向量对账）
const NODE_PROBE_HOME = "process.stdout.write(require('os').homedir())";
const NODE_PROJECT_SLUG =
  "const p=require('fs').realpathSync(process.argv[1]);" +
  "const h=require('crypto').createHash('sha256').update(p).digest('hex').slice(0,8);" +
  "process.stdout.write(p.split('/').filter(Boolean).pop()+'-'+h)";

// run manifest 探针组（skill-data-redesign §5.1：终态在 skillDataDir 根写 run.json）：
// NODE_PROBE_NOW 取当前时刻（ISO8601）。startedAt 必须经 world.run 探针取而不能脚本内
// new Date()——脚本沙箱本就禁 Date.now（重放一致性），world.run 的 journal 回放让
// startedAt 跨 resume 构造性稳定，run.json 防覆盖判据（startedAt 相同 = 同一次 run）才成立
const NODE_PROBE_NOW = "process.stdout.write(new Date().toISOString())";
// argv: [projectRoot] → stdout = JSON {branch, head}（当前分支名 + HEAD hash）；git 失败
// 输出 null 形态——manifest 是分析契约，探针 fail-soft 置 null，不改变终态
const NODE_GIT_REV =
  "try{var g=require('child_process').execFileSync;" +
  "var b=g('git',['-C',process.argv[1],'rev-parse','--abbrev-ref','HEAD'],{encoding:'utf8'}).trim();" +
  "var h=g('git',['-C',process.argv[1],'rev-parse','HEAD'],{encoding:'utf8'}).trim();" +
  'process.stdout.write(JSON.stringify({branch:b,head:h}))}catch(e){process.stdout.write(JSON.stringify({branch:null,head:null}))}';
// argv: [runJsonPath, payloadJson, startedAt] → 写 run.json + 防覆盖轮转：已存在的
// run.json 其 startedAt 与本次不同 → 先 rename 为 run-<旧startedAt 冒号换连字符>.json
// 归档（新 run 不冲掉上一 run 的分析数据）；startedAt 相同（resume 重放）→ 直接覆写；
// 旧文件缺失/损坏/无 startedAt（无判据可归档）→ 覆盖
const NODE_WRITE_RUN_JSON =
  "var fs=require('fs'),pt=require('path');" +
  "try{fs.mkdirSync(pt.dirname(process.argv[1]),{recursive:true})}catch(e){}" +
  "try{var oldRun=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));if(oldRun&&typeof oldRun.startedAt==='string'&&oldRun.startedAt!==process.argv[3]){fs.renameSync(process.argv[1],pt.join(pt.dirname(process.argv[1]),'run-'+oldRun.startedAt.replace(/:/g,'-')+'.json'))}}catch(e){}" +
  "fs.writeFileSync(process.argv[1],process.argv[2])";

// ── run manifest（skill-data-redesign §5.1 统一 schema）：终态收尾在 skillDataDir 根写
// run.json（分析契约；D2 一致性审查同目录先后写、防覆盖轮转由 startedAt 判据归档）。
// terminated 沿用本循环终态词表，分析侧按 workflow 字段分组解读。host 由壳平台常量
// HOST_PLATFORM 注入（shared 不留 host 硬编码）；model 置 null——facade 不暴露本次 run
// 的模型标识，不为此扩 agent 调用契约
interface RunManifest {
  workflow: string;
  segment: "tech-design" | "dev-flow";
  host: string;
  projectRoot: string;
  /** 无独立 worktree 概念的循环 = projectRoot（worktree 单元是节点级 cwd，run 级无） */
  worktreePath: string;
  branch: string | null;
  baseCommit: string | null;
  headCommit: string | null;
  attempt: number;
  model: string | null;
  startedAt: string;
  endedAt: string | null;
  terminated: string;
  rounds: number;
  /** tech-review-loop = must-fix 计数序列；无审查轮的循环置 null */
  mustFixTrajectory: number[] | null;
}

// argv: [statusPath, dataDir] → 派生平铺产物族路径并确保 runlog 目录存在（<name>.runlog/
// 与 status 同前缀、落 dataDir = skill-data dev-flow 段——SKILL「运行记录」节：任务书引用
// 的 agent 过程记录落点）
const ENSURE_RUNLOG =
  "const p=require('path'),fs=require('fs');const b=p.basename(process.argv[1]).replace(/\\.status\\.json$/,'');fs.mkdirSync(p.join(process.argv[2],b+'.runlog'),{recursive:true})";

// argv: [statusPath, dataDir, title, body] → dataDir/<name>.ledger.md 追加（未决事项与裁决
// 处置档案；best-effort 语义由调用方承载——失败告警不改变终态）
const APPEND_LEDGER =
  "const p=require('path'),fs=require('fs');const b=p.basename(process.argv[1]).replace(/\\.status\\.json$/,'');const f=p.join(process.argv[2],b+'.ledger.md');fs.mkdirSync(process.argv[2],{recursive:true});fs.appendFileSync(f,'## '+process.argv[3]+'\\n'+process.argv[4]+'\\n\\n')";

// argv: [cwd] → stdout = porcelain 原文；非 git 仓库/工具错误 exit 1
const GIT_PORCELAIN =
  "try{const o=require('child_process').execFileSync('git',['status','--porcelain'],{cwd:process.argv[1],encoding:'utf8',maxBuffer:33554432});process.stdout.write(o)}catch(e){process.stderr.write(String((e&&e.stderr)||e.message));process.exit(1)}";

// argv: [cwd] → stdout = rev-parse --show-toplevel（该 cwd 所在 git 仓库根，绝对路径）；非 git 仓库/工具错误 exit 1
const GIT_TOPLEVEL =
  "try{const o=require('child_process').execFileSync('git',['rev-parse','--show-toplevel'],{cwd:process.argv[1],encoding:'utf8'});process.stdout.write(o.trim())}catch(e){process.stderr.write(String((e&&e.stderr)||e.message));process.exit(1)}";

// argv: [cwd, message, ...files] → stdout = 新 commit hash；add 用绝对路径（pathspec 相对 cwd
// 解析，cwd 非 repo 根时相对路径会指错文件）；commit 用 --only 限定路径——共享工作区并行
// 调度时暂存区可能有其他单元的 staged 内容，普通 commit 会连带提交，破坏「每单元独立成笔」
const GIT_ADD_COMMIT =
  "try{const a=process.argv.slice(1);const c=a[0],m=a[1],f=a.slice(2);const p=require('path');const x=require('child_process').execFileSync;" +
  "const abs=f.map(t=>p.resolve(c,t));" +
  // 幂等分支：目标文件零改动（如节点产物已在恢复对账时提交过）→ 直接返回当前 HEAD，
  // 不走 add/commit（git commit 对空暂存区报 nothing to commit 非零退出，曾误判 commit 失败）
  "if(abs.length>0){const st=String(x('git',['status','--porcelain','--',...abs],{cwd:c,encoding:'utf8',maxBuffer:33554432}));" +
  "if(st.trim()===''){const h0=String(x('git',['rev-parse','HEAD'],{cwd:c,encoding:'utf8',maxBuffer:33554432})).trim();process.stdout.write(h0);process.exit(0)}}" +
  "if(abs.length>0)x('git',['add','--',...abs],{cwd:c,encoding:'utf8',maxBuffer:33554432});" +
  "x('git',['commit','--only','-m',m,'--',...abs],{cwd:c,encoding:'utf8',maxBuffer:33554432,stdio:['ignore','pipe','pipe']});" +
  "const h=String(x('git',['rev-parse','HEAD'],{cwd:c,encoding:'utf8',maxBuffer:33554432})).trim();process.stdout.write(h)}" +
  "catch(e){process.stderr.write(String((e&&(e.stderr||e.stdout))||e.message));process.exit(1)}";

// argv: [program, cwd, ...args] → 在指定 cwd 内执行 program；退出码/stdout/stderr 全量透传
//（spawnSync 而非 execFileSync：后者正常退出时 stderr 被丢弃，测试输出的诊断信息会失真）
const RUN_IN_CWD =
  "try{const a=process.argv.slice(1);const p=a[0],c=a[1],r=a.slice(2);" +
  "const s=require('child_process').spawnSync(p,r,{cwd:c,encoding:'utf8',maxBuffer:33554432});" +
  "if(s.stdout)process.stdout.write(s.stdout);if(s.stderr)process.stderr.write(s.stderr);" +
  "process.exit(typeof s.status==='number'?s.status:1)}" +
  "catch(e){process.stderr.write(String((e&&e.message)||'spawn failed'));process.exit(1)}";

// argv: [cwd] → stdout = git diff --stat 原文（接替程序的前任证据包成分）；失败 exit 1 输出空
const GIT_DIFF_STAT =
  "try{const o=require('child_process').execFileSync('git',['diff','--stat'],{cwd:process.argv[1],encoding:'utf8',maxBuffer:33554432});process.stdout.write(o)}catch(e){process.stdout.write('(diff 不可用)')}";

// argv: [statusPath, projectRoot, commitTemplate, runId, ...devEntries] → 双向对账（§4.5 崩溃裁决，git 为准）：
//   devEntries 条目 = `<id>`（主仓节点）或 `<id>@<仓根绝对路径>`（跨仓节点，如子模块）——
//   commit 存在性校验与 git log 反查都必须在 commit 所在仓执行：单 projectRoot 口径曾把
//   子模块 commit 判「不在对象库」致已交付单元全部回 pending 重跑（实测 compute-asr
//   run 二次发起时 U1/U3/U6b 空重跑）。
//   ①status=done 的节点：commit 不在其仓 git 对象库 → 回 pending；
//   ②status≠done 的 dev 节点：git log 反查补写 done（commit 哈希 + 证据）。反查命中条件
//     三重锚定：a) 时间窗 = baseline..HEAD——无 baseline 时反查禁用（不回退扫 HEAD 起
//     500 条：跨 run 同模板同单元编号的历史 commit 会撞名误配，正是 431b898 修复的事故
//     形态；禁用后未记录单元保持 pending 重跑，由引擎提交的幂等分支兜住，方向安全。
//     baseline 固化（status.json 初建必写）后该分支只对旧格式 status.json 可达；
//     b) Run-Id trailer 精确匹配 = commit trailer 的 Run-Id === 本 run 标识（构造性唯一：
//     引擎渲染 message 时统一追加，AI 自由文本经单行化净化无法伪造 trailer 段）。本 run
//     的 commit 恒带 trailer，无 trailer 且前缀匹配的历史 commit 在 runId 在场时不认；
//     c) subject 前缀锚定 = commitTemplate 按 {unitId} 切出的静态前段 + <id>，且 <id> 后继
//     字符非字母数字连字符（模板缺失时退化为 <id> 前缀 + 同一边界检查）——区分 run 内
//     不同单元。status 无 runId（旧格式引擎写的）→ 兼容路径：只认无 trailer + 前缀 +
//     词边界（旧引擎 commit 恰好无 trailer，自洽）。stdout = 对账后的完整 status.json
//     （保留 schema 外顶层字段；runId 缺失时以 argv 传入值补写，保证输出恒含）
const RECONCILE_STATUS =
  "try{const fs=require('fs');const sp=process.argv[1],root=process.argv[2],tpl=process.argv[3]||'',runIdArg=process.argv[4]||'',ents=process.argv.slice(5).map(function(s){var i=s.indexOf('@');return i<0?{id:s,cwd:root}:{id:s.slice(0,i),cwd:s.slice(i+1)};});" +
  "const x=require('child_process').execFileSync;const st=JSON.parse(fs.readFileSync(sp,'utf8'));const nodes={};" +
  "for(const k of Object.keys(st.nodes||{}))nodes[k]=st.nodes[k];const events=(st.events||[]).slice();" +
  "const range=typeof st.baseline==='string'&&st.baseline?st.baseline+'..HEAD':null;" +
  "if(!range)events.push({seq:events.length+1,node:'*',event:'reconcile-warn',detail:'status 无 baseline——反查禁用，未记录单元保持 pending 重跑（幂等核验兜底）。恢复动作：旧格式 status.json，重发起后引擎初建即固化 baseline'});" +
  "const logCache={};" +
  "const logOf=function(cwd){if(logCache[cwd]!==undefined)return logCache[cwd];var v='';if(range){try{v=String(x('git',['log','--format=%H%x1f%s%x1f%(trailers:key=Run-Id,valueonly)',range],{cwd:cwd,encoding:'utf8',maxBuffer:33554432}))}catch(err){}}logCache[cwd]=v;return v;};" +
  "const runId=typeof st.runId==='string'&&st.runId?st.runId:null;" +
  "const preOf=(id)=>(tpl.split('{unitId}')[0]||'')+id;" +
  "for(const ent of ents){const id=ent.id,cwd=ent.cwd;const e=nodes[id]||{status:'pending',attempts:0};" +
  "if(e.status==='done'){let ok=false;" +
  "if(typeof e.commit==='string'&&e.commit.length>=7){try{x('git',['cat-file','-e',e.commit+'^{commit}'],{cwd:cwd,encoding:'utf8'});ok=true}catch(err){}}" +
  "if(ok)continue;nodes[id]={status:'pending',attempts:0};" +
  "events.push({seq:events.length+1,node:id,event:'reconcile-reset',detail:'status done 但 commit 不在 git 对象库，按 git 为准回 pending'})}" +
  "else{const pre=preOf(id);" +
  "const hit=logOf(cwd).split('\\n').find((l)=>{const seg=l.split('\\x1f');if(seg.length<2)return false;const s=seg[1]||'';const t=(seg[2]||'').trim();" +
  "const subj=s.startsWith(pre)&&(s.length===pre.length||!/[A-Za-z0-9-]/.test(s.charAt(pre.length)));" +
  "if(!subj)return false;" +
  "return runId!==null?(t===runId):(t==='')});" +
  "if(hit){const h=hit.slice(0,hit.indexOf('\\x1f'));nodes[id]={status:'done',attempts:1,commit:h,evidence:'恢复对账：git log 反查命中本单元 commit（Run-Id '+(runId!==null?'精确匹配':'兼容路径：前缀+词边界（status 无 runId）')+'，status 未记，按 git 为准补写 done）'};" +
  "events.push({seq:events.length+1,node:id,event:'reconcile-done',detail:'status 未记但 git log 有本单元 commit，按 git 为准补写 done'})}}}" +
  "const out={};for(const k of Object.keys(st))if(k!=='nodes'&&k!=='events')out[k]=st[k];out.baseline=st.baseline||null;out.runId=st.runId||runIdArg||null;out.nodes=nodes;out.events=events;" +
  "process.stdout.write(JSON.stringify(out))}" +
  "catch(e){process.stderr.write(String((e&&e.message)||'reconcile failed'));process.exit(1)}";

// ── 纯工具函数 ──

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 启动校验失败的 failed-as-return 载体（不 throw：errored run 不可 resume 且丢结构化错误） */
function invalidRet(message: string, statusFile: string): WaveExecutorOutcome {
  return {
    terminated: "blocked",
    done: [],
    blocked: [],
    skipped: [],
    statusFile,
    coreFailure: null,
    validationError: message,
    deferredCommits: [],
    residualFiles: [],
  };
}

function isRec(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}
function isStr(x: unknown): x is string {
  return typeof x === "string" && x.trim() !== "";
}
function isStrArr(x: unknown): x is string[] {
  return Array.isArray(x) && x.every((i) => typeof i === "string" && i.trim() !== "");
}

/** 相对路径挂在 projectRoot 下；绝对路径原样返回 */
function joinPath(base: string, rel: string): string {
  if (rel.startsWith("/")) return rel;
  const trimmed = base.endsWith("/") ? base.slice(0, -1) : base;
  return `${trimmed}/${rel}`;
}

function tailLines(text: string, n: number): string {
  const s = String(text ?? "").trimEnd();
  const lines = s.split("\n");
  return lines.length <= n ? s : lines.slice(-n).join("\n");
}

/** 文件路径是否落在声明范围内（条目=文件或目录前缀） */
function pathInTerritory(file: string, territories: string[]): boolean {
  for (const t of territories) {
    const prefix = t.endsWith("/") ? t : `${t}/`;
    if (file === t || file.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * territory 条目形态契约（启动校验唯一入口）：条目 = 相对该节点 cwd 所在 git 仓库根的
 * 纯路径（文件或目录前缀）——启动互斥断言的机器输入。绝对路径与空格/括号注释混合形态
 * （如「src/**（含测试）」）在 pathInTerritory 匹配上恒失败（口径契约：territory 与
 * files_changed/porcelain 同基准）——错误就地暴露，不做归一化宽容吸收（引擎猜作者
 * 意图比静默失效更危险）。返回错误清单，空数组 = 全部合法。
 */
function territoryFormatErrors(id: string, entries: readonly string[]): string[] {
  const errs: string[] = [];
  const abs = entries.filter((t) => t.startsWith("/"));
  if (abs.length > 0) {
    errs.push(`dev 节点 ${id} 的 territory 含绝对路径（${abs.join("、")}）——须为相对该节点 cwd 所在 git 仓库根的相对路径`);
  }
  const mixed = entries.filter((t) => /\s/.test(t) || /[()（）]/.test(t));
  if (mixed.length > 0) {
    errs.push(`dev 节点 ${id} 的 territory 含混合形态条目（空格/括号注释）：${mixed.join("、")}——territory 是启动互斥断言的机器输入，条目须为纯路径`);
  }
  return errs;
}

/** porcelain 输出 → 文件路径列表（R 行取新路径；与 pr-lifecycle 同构） */
function parsePorcelain(out: string): string[] {
  return out
    .split("\n")
    .map((l) => l.trimEnd())
    .filter(Boolean)
    .map((l) => {
      let p = l.slice(3).trim().replace(/^"|"$/g, "");
      const arrow = p.indexOf(" -> ");
      if (arrow >= 0) p = p.slice(arrow + 4).trim().replace(/^"|"$/g, "");
      return p;
    });
}

/** workflow 产物目录判定：porcelain 路径相对 cwd，projectRoot 级 .tmp/ 在 cwd=子目录时
 *  呈 ../.tmp/（或更深的 ../../.tmp/）形态——按「任意深度 ../ 前缀 + .tmp/」识别。
 *  工作流产物已迁 HOME 下 skill-data（porcelain 天然不可见），本过滤器退化为历史兼容
 *  （存量其他 .tmp 使用者仍在） */
const isTmpArtifact = (f: string): boolean => /^(\.\.\/)*\.tmp\//.test(f);

/** commitTemplate 渲染：{unitId}/{summary} 全量替换（split/join 防 replace 只换首个） */
function renderCommit(template: string, unitId: string, summary: string): string {
  return template.split("{unitId}").join(unitId).split("{summary}").join(summary);
}

/** summary 单行化（AI 自由文本进 message 的边界净化）：subject 锚定要求第一行 =
 * 静态前缀 + 单元 id 完整词，换行会把 message 撕成多段破坏锚定，且多行文本可构造
 * 伪 trailer 段伪造 Run-Id——单行化后 trailer 段只能由引擎追加，机器区构造性唯一 */
function sanitizeSummary(summary: string): string {
  return summary.replace(/[\r\n]+/g, " ").trim();
}

/** 完整 commit message = subject（模板渲染，summary 单行化）+ 空行 + Run-Id trailer。
 *  Run-Id = 引擎初建 status.json 时生成的运行唯一标识，同模板同单元编号的历史 commit
 *  没有本 run 的 Run-Id，反查（RECONCILE_STATUS）按 trailer 精确匹配构造性排除撞名。
 *  trailer 是 git 标准惯例（同 Signed-off-by 的单独成行形态），git 原生
 *  %(trailers:key=Run-Id) 可解析，读侧不依赖手写字符串匹配 */
function buildCommitMessage(template: string, unitId: string, summary: string, runId: string): string {
  return `${renderCommit(template, unitId, sanitizeSummary(summary))}\n\nRun-Id: ${runId}`;
}

/** 依赖环检测：DFS 三色标记，命中回边返回环上节点 id，无环返回 null */
function detectCycle(ids: string[], depsOf: Map<string, string[]>): string | null {
  const color = new Map<string, number>(); // 0=未访 1=在当前路径 2=完成
  for (const id of ids) color.set(id, 0);
  let hit: string | null = null;
  const visit = (id: string): void => {
    if (hit !== null) return;
    const c = color.get(id) ?? 0;
    if (c === 1) {
      hit = id;
      return;
    }
    if (c === 2) return;
    color.set(id, 1);
    for (const d of depsOf.get(id) ?? []) visit(d);
    color.set(id, 2);
  };
  for (const id of ids) {
    visit(id);
    if (hit !== null) break;
  }
  return hit;
}

// ── exec-plan schema 校验（§8.3；错误全量收集后一次 fail-fast） ──

function validatePlan(raw: unknown): ValidateResult {
  const errors: string[] = [];
  if (!isRec(raw)) return { ok: false, errors: ["exec-plan 根必须是 JSON 对象"] };
  // version 不符时整体 schema 形态不可信，单独 return（混入 errors 会污染后续
  // 「本阶段错误收集完再停」的判据，吞掉节点级错误）
  if (raw.version !== 1) return { ok: false, errors: [`version 必须为 1，实际：${JSON.stringify(raw.version)}`] };
  // 三个致命字段走直线守卫收窄（经 errors 间接 return 的写法 TS 无法收窄，unknown 会向下游传染）
  const mode = raw.mode === "dev" || raw.mode === "acceptance" ? raw.mode : null;
  if (mode === null) {
    errors.push(`mode 必须是 "dev" 或 "acceptance"，实际：${JSON.stringify(raw.mode)}`);
    return { ok: false, errors };
  }
  const projectRoot = isStr(raw.projectRoot) ? raw.projectRoot : null;
  if (projectRoot === null) {
    errors.push("projectRoot 必须是非空字符串（git/测试/commit 的缺省 cwd——引擎不从进程 cwd 推导）");
  }
  const statusPathRel = isStr(raw.statusPath) ? raw.statusPath : null;
  if (statusPathRel === null) {
    errors.push("statusPath 必须是非空字符串");
  }
  // projectRoot/statusPath 是节点构建的路径基准，缺失时节点级校验无从进行——
  // 两者错误收集齐后即返回（不带病进节点校验）；两者齐备则继续收集后续错误，
  // 一次报全（version/mode 因 schema 形态不可信保留单独 return）
  if (projectRoot === null || statusPathRel === null) return { ok: false, errors };

  // 节集：dev 模式=顶层 nodes；acceptance 模式=acceptance.nodes（两模式节点集分界）
  const rawNodes: unknown[] = [];
  let accRec: Record<string, unknown> | null = null;
  if (mode === "dev") {
    if (!Array.isArray(raw.nodes) || raw.nodes.length === 0) {
      errors.push("mode=dev 时顶层 nodes 必须是非空数组");
    } else {
      rawNodes.push(...raw.nodes);
    }
  } else {
    if (!isRec(raw.acceptance)) {
      errors.push("mode=acceptance 时必须提供 acceptance 对象（nodes/groups；core/haltOnCoreFail 已退役被忽略）");
    } else {
      accRec = raw.acceptance;
      if (!Array.isArray(accRec.nodes) || accRec.nodes.length === 0) {
        errors.push("acceptance.nodes 必须是非空数组");
      } else {
        rawNodes.push(...(accRec.nodes as unknown[]));
      }
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  const nodes: PlanNode[] = [];
  const idSet = new Set<string>();
  for (let i = 0; i < rawNodes.length; i += 1) {
    const rn = rawNodes[i];
    if (!isRec(rn)) {
      errors.push(`nodes[${i}] 必须是对象`);
      continue;
    }
    if (!isStr(rn.id)) {
      errors.push(`nodes[${i}] 缺少非空 id`);
      continue;
    }
    const id = rn.id;
    if (idSet.has(id)) errors.push(`节点 id 重复：${id}`);
    idSet.add(id);
    const kind = rn.kind;
    if (kind !== "dev" && kind !== "verify" && kind !== "inspect") {
      errors.push(`节点 ${id} 的 kind 必须是 dev/verify/inspect，实际：${JSON.stringify(kind)}`);
      continue;
    }
    if (mode === "dev" && kind === "inspect") {
      errors.push(`mode=dev 但节点 ${id} kind=inspect（inspect 任务书属验收语义；dev 模式仅允许 dev 节点与开发期 e2e 的 verify 节点）`);
    }
    if (mode === "acceptance" && kind === "dev") {
      errors.push(`mode=acceptance 但节点 ${id} kind=dev（dev 节点属 D1 实例化）`);
    }
    if (!isStrArr(rn.deps)) {
      errors.push(`节点 ${id} 的 deps 必须是字符串数组`);
      continue;
    }
    const node: PlanNode = {
      id,
      kind,
      deps: rn.deps,
      designRef: isStr(rn.designRef) ? rn.designRef : "",
      territory: [],
      testCommand: null,
      promptFile: "",
      script: "",
      artifactsDir: "",
      artifactsRefs: [],
      cwd: isStr(rn.cwd) ? joinPath(projectRoot, rn.cwd) : projectRoot,
    };
    if (kind === "dev") {
      if (!isStrArr(rn.territory) || rn.territory.length === 0) {
        errors.push(`dev 节点 ${id} 的 territory 必须是非空字符串数组（范围声明）`);
      } else {
        const terrErrs = territoryFormatErrors(id, rn.territory);
        if (terrErrs.length === 0) node.territory = rn.territory;
        else errors.push(...terrErrs);
      }
      if (!isStr(rn.promptFile)) {
        errors.push(`dev 节点 ${id} 缺少 promptFile`);
      } else {
        node.promptFile = joinPath(projectRoot, rn.promptFile);
      }
      const tc = rn.testCommand;
      if (!isRec(tc) || !isStr(tc.program) || !isStrArr(tc.args)) {
        errors.push(`dev 节点 ${id} 的 testCommand 必须是 {program, args} 形态（program 字符串 + args 字符串数组）`);
      } else {
        if (!(TEST_WHITELIST as readonly string[]).includes(tc.program)) {
          errors.push(`dev 节点 ${id} 的 testCommand.program "${tc.program}" 不在白名单（${TEST_WHITELIST.join("/")}）`);
        }
        node.testCommand = { program: tc.program, args: tc.args };
      }
    } else if (kind === "verify") {
      if (!isStr(rn.script)) {
        errors.push(`verify 节点 ${id} 缺少 script（L3 剧本路径）`);
      } else {
        node.script = joinPath(projectRoot, rn.script);
      }
      if (!isStr(rn.artifactsDir)) {
        errors.push(`verify 节点 ${id} 缺少 artifactsDir`);
      } else {
        node.artifactsDir = joinPath(projectRoot, rn.artifactsDir);
      }
    } else {
      if (!isStr(rn.promptFile)) {
        errors.push(`inspect 节点 ${id} 缺少 promptFile（L4 任务书）`);
      } else {
        node.promptFile = joinPath(projectRoot, rn.promptFile);
      }
      if (rn.artifactsRefs !== undefined) {
        if (!isStrArr(rn.artifactsRefs)) {
          errors.push(`inspect 节点 ${id} 的 artifactsRefs 必须是字符串数组`);
        } else {
          node.artifactsRefs = rn.artifactsRefs;
        }
      }
    }
    nodes.push(node);
  }
  if (errors.length > 0) return { ok: false, errors };

  // deps / artifactsRefs 引用存在性
  for (const n of nodes) {
    for (const d of n.deps) {
      if (!idSet.has(d)) errors.push(`节点 ${n.id} 的 deps 引用了不存在的节点：${d}`);
    }
    for (const r of n.artifactsRefs) {
      if (!idSet.has(r)) errors.push(`节点 ${n.id} 的 artifactsRefs 引用了不存在的节点：${r}`);
    }
  }
  // 依赖环检测（简单 DFS）
  const depsOf = new Map<string, string[]>(nodes.map((n) => [n.id, n.deps]));
  const cycleHit = detectCycle(nodes.map((n) => n.id), depsOf);
  if (cycleHit !== null) errors.push(`依赖图存在环，环上节点：${cycleHit}`);

  // 范围声明互斥启动断言（T3 DAG 自检「任意两单元范围声明交集为空」的机器下限）：重叠条目
  // 必须有依赖路径（任一方向可达）——无边重叠对会同时就绪并行派发，同文件写冲突 +
  // 级二复核按活跃声明范围并集粗判会互相污染归属；写计划纪律仍取全互斥，依赖串行是逃生通道
  const terrOwners = new Map<string, string[]>();
  for (const n of nodes) {
    if (n.kind !== "dev" || n.territory.length === 0) continue;
    for (const t of n.territory) {
      const owners = terrOwners.get(t) ?? [];
      owners.push(n.id);
      terrOwners.set(t, owners);
    }
  }
  if (terrOwners.size > 0) {
    const reaches = (from: string, to: string): boolean => {
      const stack = [...(depsOf.get(from) ?? [])];
      const visited = new Set<string>();
      while (stack.length > 0) {
        const cur = stack.pop()!;
        if (cur === to) return true;
        if (visited.has(cur)) continue;
        visited.add(cur);
        stack.push(...(depsOf.get(cur) ?? []));
      }
      return false;
    };
    for (const [t, owners] of terrOwners) {
      for (let i = 0; i < owners.length; i += 1) {
        for (let j = i + 1; j < owners.length; j += 1) {
          const a = owners[i];
          const b = owners[j];
          if (!reaches(a, b) && !reaches(b, a)) {
            errors.push(`节点 ${a} 与 ${b} 范围声明重叠（${t}）且两方向均无依赖路径——两者会同时就绪并行派发（同文件写冲突、声明核验互污）。共同文件改动须合并为同一单元或以依赖边串行后重发 exec-plan`);
          }
        }
      }
    }
  }

  // acceptance 分组：groups.core / haltOnCoreFail 已退役（2026-09-26 用户裁决——依赖可达性
  // 熔断统一判据后核心场景标注不再承载语义）。字段保留宽容解析（旧 exec-plan 不报错、直接忽略）
  if (mode === "acceptance" && accRec !== null) {
    const groups = accRec.groups;
    if (!isRec(groups)) {
      errors.push("acceptance.groups 必须是对象 {core, nonCore}（core/haltOnCoreFail 已退役，保留字段被忽略）");
    }
  }

  const commitTemplate = isStr(raw.commitTemplate) ? raw.commitTemplate : null;
  if (mode === "dev" && commitTemplate === null) {
    errors.push("mode=dev 时 commitTemplate 必须是非空字符串");
  } else if (mode === "dev" && commitTemplate !== null) {
    if (!commitTemplate.includes("{unitId}") || !commitTemplate.includes("{summary}")) {
      errors.push(`commitTemplate 须同时含 {unitId} 与 {summary} 占位符（当前：${commitTemplate}）`);
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    plan: {
      version: 1,
      mode,
      projectRoot,
      statusPath: joinPath(projectRoot, statusPathRel),
      commitTemplate: commitTemplate ?? "{unitId} — {summary}",
      baseline: typeof raw.baseline === "string" ? raw.baseline : null,
      nodes,
    },
  };
}

// ── node -e 通道 helpers ──

async function readTextViaNode(path: string): Promise<string | null> {
  const r = await world.run("node", ["-e", READ_FILE_QUIET, path]);
  if (r.exitCode !== 0 || r.stdout.trim() === "") return null;
  return r.stdout;
}

async function writeTextViaNode(path: string, body: string): Promise<void> {
  const r = await world.run("node", ["-e", WRITE_FILE, path, body]);
  if (r.exitCode !== 0) {
    throw new Error(`写盘失败（${path}，exit ${r.exitCode}）：${r.stderr.trim() || r.stdout.trim()}`);
  }
}

async function existsViaNode(path: string): Promise<boolean> {
  const r = await world.run("node", ["-e", EXISTS, path]);
  return r.exitCode === 0;
}

/** run.json 终态落盘（best-effort：失败只告警——终态数据以 status.json 与返回值为准）；
 *  防覆盖轮转判定在 NODE_WRITE_RUN_JSON 内（旧文件 startedAt 不同 → rename 归档后覆写） */
async function writeRunManifest(m: RunManifest): Promise<void> {
  const w = await world.run("node", ["-e", NODE_WRITE_RUN_JSON, `${skillDataDir}/run.json`, JSON.stringify(m, null, 2), m.startedAt]);
  if (w.exitCode !== 0) {
    log(`WARN: run.json 落盘失败（exit ${w.exitCode}：${w.stderr.trim() || w.stdout.trim()}）——终态数据以 status.json 与返回值为准`);
  }
}

/** git 探针（NODE_GIT_REV）→ {branch, head}；输出形态非法全 null（fail-soft，不改变终态） */
async function gitRevProbe(root: string): Promise<{ branch: string | null; head: string | null }> {
  const r = await world.run("node", ["-e", NODE_GIT_REV, root]);
  try {
    const v = JSON.parse(r.stdout) as { branch: unknown; head: unknown };
    return {
      branch: typeof v.branch === "string" && v.branch !== "" ? v.branch : null,
      head: typeof v.head === "string" && v.head !== "" ? v.head : null,
    };
  } catch {
    return { branch: null, head: null };
  }
}

/** null = git 命令本身失败（非 git 仓库/工具缺失），区别于「干净」 */
async function gitPorcelainViaNode(cwd: string): Promise<string | null> {
  const r = await world.run("node", ["-e", GIT_PORCELAIN, cwd]);
  if (r.exitCode !== 0) return null;
  return r.stdout;
}

/** cwd 必须等于其所在 git 仓库根（projectRoot 或 worktree 根）：porcelain 输出相对 cwd、
 * territory 相对仓库根——cwd 落在仓库子目录时两基准全链错位（声明恒判越界、提交被拒）。
 * null = git 命令失败；否则返回 toplevel 绝对路径，由调用方比对。 */
async function gitToplevelViaNode(cwd: string): Promise<string | null> {
  const r = await world.run("node", ["-e", GIT_TOPLEVEL, cwd]);
  if (r.exitCode !== 0) return null;
  return r.stdout.trim();
}

async function gitAddCommitViaNode(
  cwd: string,
  message: string,
  files: string[],
): Promise<{ ok: boolean; hash: string; err: string }> {
  const r = await world.run("node", ["-e", GIT_ADD_COMMIT, cwd, message, ...files]);
  if (r.exitCode !== 0) return { ok: false, hash: "", err: tailLines(`${r.stdout}\n${r.stderr}`, TAIL_LINES) };
  return { ok: true, hash: r.stdout.trim(), err: "" };
}

// ── 调度器内存态（崩溃恢复事实源是 status.json + git，不是这个 Map） ──

const state = new Map<string, NodeRt>();
let plan: ParsedPlan; // 赋值点在「校验执行计划」段；其后所有函数才可能被调用
let coreFail: { id: string; detail: string } | null = null;
// 顶层读取 coreFail 须过函数边界：赋值点在调度循环闭包内，顶层控制流分析会把
// 直接读取过度窄化为 null（if 收窄后成 never）——函数体内读取返回声明类型
function readCoreFail(): { id: string; detail: string } | null {
  return coreFail;
}
/** 当前 in-flight 节点的声明范围并集（按 cwd 分组）——级二粗粒度复核的基线，逐节点 settle 后重建 */
let activeTerrByCwd = new Map<string, string[]>();
/** 全部 dev 节点核验通过时自报的 files_changed 并集（终态残留对账的豁免集——静态声明范围
 *  不含运行中新建文件，自报并集补上这一段） */
const declaredFiles = new Set<string>();
/** commit 被拒（多为仓库 pre-commit 钩子全仓检查 × 并行半成品）转待办的节点——节点核验
 *  已过、编码成果有效，不 blocked（2026-09-26 用户裁决：全部做完留给主 agent 处理，
 *  钩子在主会话代提交时照常执行）；收尾统一呈报 */
const deferredCommits: { id: string; message: string; files: string[]; err: string }[] = [];

function nodeState(id: string): NodeRt["status"] {
  return state.get(id)?.status ?? "pending";
}

// status.json 读改写串行链：批内多节点并发落地时防读改写交错丢更新
let statusChain: Promise<unknown> = Promise.resolve();
function serializedStatus<T>(fn: () => Promise<T>): Promise<T> {
  const run = statusChain.then(fn, fn);
  statusChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function normalizeEntry(e: unknown): StatusEntry {
  if (typeof e !== "object" || e === null) return { status: "pending", attempts: 0 };
  const r = e as Record<string, unknown>;
  const st =
    typeof r.status === "string" && VALID_ENTRY_STATUS.has(r.status) ? (r.status as StatusEntry["status"]) : "pending";
  return {
    status: st,
    attempts: typeof r.attempts === "number" ? r.attempts : 0,
    commit: typeof r.commit === "string" ? r.commit : undefined,
    evidence: typeof r.evidence === "string" ? r.evidence : undefined,
  };
}

async function readStatusFile(): Promise<StatusFileData | null> {
  const text = await readTextViaNode(plan.statusPath);
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isRec(parsed)) return null;
    const nodes: Record<string, StatusEntry> = {};
    if (isRec(parsed.nodes)) {
      for (const k of Object.keys(parsed.nodes)) nodes[k] = normalizeEntry(parsed.nodes[k]);
    }
    const events: StatusEvent[] = Array.isArray(parsed.events)
      ? parsed.events.filter((e): e is StatusEvent => isRec(e) && typeof (e as Record<string, unknown>).node === "string")
      : [];
    const baseline = typeof parsed.baseline === "string" ? parsed.baseline : null;
    const extra: Record<string, unknown> = {};
    for (const k of Object.keys(parsed)) {
      if (k !== "baseline" && k !== "nodes" && k !== "events") extra[k] = (parsed as Record<string, unknown>)[k];
    }
    return { baseline, nodes, events, extra };
  } catch {
    return null;
  }
}

async function statusUpdate(nodeId: string, entry: StatusEntry, event: string, detail?: string): Promise<void> {
  await serializedStatus(async () => {
    const st = (await readStatusFile()) ?? { baseline: plan.baseline, nodes: {}, events: [], extra: {} };
    const nodes: Record<string, StatusEntry> = { ...st.nodes, [nodeId]: entry };
    const events: StatusEvent[] = [
      ...st.events,
      { seq: st.events.length + 1, node: nodeId, event, detail: detail ?? entry.evidence ?? "" },
    ];
    // schema 外顶层字段（name/updated 等 D0 产物）原样保留（§4.5）
    await writeTextViaNode(
      plan.statusPath,
      JSON.stringify({ ...st.extra, baseline: st.baseline, nodes, events }, null, 2),
    );
  });
}

// ── 节点状态流转 helpers（终态即时回写 status.json + 上板） ──

async function beginNode(id: string): Promise<void> {
  state.set(id, { status: "in-progress", attempts: 0 });
  await statusUpdate(id, { status: "in-progress", attempts: 0 }, "dispatch");
  report({ id, state: "in-progress", detail: "" }, "nodes");
}

async function finishNodeDone(id: string, attempts: number, commit: string | undefined, evidence: string): Promise<void> {
  state.set(id, { status: "done", attempts, commit });
  await statusUpdate(
    id,
    { status: "done", attempts, commit, evidence },
    "done",
    evidence + (commit !== undefined ? `；commit=${commit}` : ""),
  );
  report({ id, state: "done", detail: commit !== undefined ? commit.slice(0, 8) : evidence.slice(0, 40) }, "nodes");
}

async function markNodeBlockedOrFailed(
  id: string,
  st: "blocked" | "failed",
  reason: string,
  detail: string,
  attempts: number,
): Promise<void> {
  state.set(id, { status: st, attempts, reason, detail });
  const evidence = detail !== "" ? `${reason}；输出：${tailLines(detail, TAIL_LINES)}` : reason;
  await statusUpdate(id, { status: st, attempts, evidence }, st);
  report({ id, state: "failed", detail: reason }, "nodes");
  log(`节点 ${id} ${st === "failed" ? "验收失败" : "blocked"}：${reason}`);
}

// ── 验收自愈（设计 §8.7）：verify fail → 归因 → 分流 → 修资产重验 / 依赖可达性判定 ──

// ── 结构化返回校验回喂（用户裁决 2026-09-26：全部 agent 结构化返回必备，回喂重试上限 3 次）──
// rawAsk 由调用方闭包提供（用各自具体类型调 ask——pi 构建管线按泛型名查 SCHEMA_BY_KEY，
// 帮手内不能出现平台 ask 的泛型调用）；回喂 prompt 自包含重发原指令（pi 侧每次新 agent）。
const STRUCTURED_RETRY_MAX = 3;

type Validated<T> = { ok: true; value: T } | { ok: false; errors: string[] };

async function askValidated<T>(
  validate: (v: unknown) => Validated<T>,
  rawAsk: (prompt: string) => PromiseLike<T>,
  prompt: string,
): Promise<T | null> {
  let last = await rawAsk(prompt);
  for (let i = 1; i <= STRUCTURED_RETRY_MAX; i++) {
    const v = validate(last);
    if (v.ok) return v.value;
    last = await rawAsk(
      [
        `你上一轮的结构化返回未通过机器校验，错误清单：`,
        ...v.errors.map((e) => `- ${e}`),
        ``,
        `重新返回完整 JSON（全量重新给出，不是增量补丁；除该 JSON 外不要改任何已落盘产物）。`,
        ``,
        `（同一子代理续写——完整任务上下文见前文对话，无需重述任务。你的任务开头摘录：${prompt.slice(0, 160)}${prompt.length > 160 ? "…" : ""}）`,
      ].join("\n"),
    );
  }
  const fin = validate(last);
  return fin.ok ? fin.value : null;
}

function validateNodeResult(v: unknown): Validated<NodeResult> {
  const o = typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  const errors: string[] = [];
  if (o["status"] !== "done" && o["status"] !== "fail" && o["status"] !== "blocked") errors.push("status 须为 done|fail|blocked");
  if (!isStrArr(o["files_changed"])) errors.push("files_changed 须为字符串数组");
  if (typeof o["test_evidence"] !== "string") errors.push("test_evidence 须为字符串");
  if (!isStrArr(o["deviations"])) errors.push("deviations 须为字符串数组");
  if (!isStrArr(o["blockers"])) errors.push("blockers 须为字符串数组");
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: v as NodeResult };
}

/**
 * inspect 节点专用契约（验收语义，与 dev/verify 执行语义的 NodeResult.status 解耦）：
 * verdict 用验收结论词（pass|fail|degraded）。不新增此契约时引擎复用 NodeResult——
 * status 一个字段双承载「执行完成与否」与「验收结论通不通过」，验收任务书契约
 * （PASS|FAIL|DEGRADED）与引擎词表（done|fail|blocked）打架时，inspect agent 按
 * 「执行完成」报 done 会把 FAIL 结论吞成检查通过（2026-10-04 taiji D3 A10 实证：
 * 判定书 verdict.json=FAIL + 结构化 status=done → 引擎记检查通过、增量跳过继承假状态）。
 */
interface InspectResult {
  verdict: "pass" | "fail" | "degraded";
  test_evidence: string;
  deviations: string[];
  blockers: string[];
}

function validateInspectResult(v: unknown): Validated<InspectResult> {
  const o = typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  const errors: string[] = [];
  if (o["verdict"] !== "pass" && o["verdict"] !== "fail" && o["verdict"] !== "degraded")
    errors.push('verdict 须为 "pass"|"fail"|"degraded"');
  if (typeof o["test_evidence"] !== "string") errors.push("test_evidence 须为字符串");
  if (!isStrArr(o["deviations"])) errors.push("deviations 须为字符串数组");
  if (!isStrArr(o["blockers"])) errors.push("blockers 须为字符串数组");
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: v as InspectResult };
}

/**
 * inspect done 的事实锚（等价 dev 节点的 commit 锚）：判定书固定落
 * `<artifactsDir>/verdict.json`，结论词（verdict|status 字段任一）与结构化返回一致才
 * 认通过——单靠结构化自报无第二证据时，「执行完成」语义会再次遮蔽「验收结论」
 * （本次修复的根因形态）。文件缺失 / 不可解析 / 结论不一致 = 锚不成立。
 * artifactsDir 为空按锚通过（exec-plan 校验已要求 inspect 带 artifactsDir，防御性宽容）。
 */
async function inspectVerdictAnchorOk(node: PlanNode, expected: "pass" | "degraded"): Promise<boolean> {
  if (node.artifactsDir === "") return true;
  const raw = await readTextViaNode(`${node.artifactsDir}/verdict.json`);
  if (raw === null) return false;
  const m = raw.match(/"(?:verdict|status)"\s*:\s*"([^"]+)"/i);
  return m !== null && m[1].toLowerCase() === expected;
}

function validateHealVerdict(v: unknown): Validated<HealVerdict> {
  const o = typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  const errors: string[] = [];
  if (o["class"] !== "spec-bug" && o["class"] !== "product-bug" && o["class"] !== "environment")
    errors.push('class 须为 "spec-bug"|"product-bug"|"environment"');
  if (typeof o["evidence"] !== "string") errors.push("evidence 须为字符串");
  if (!isStrArr(o["failureFiles"])) errors.push("failureFiles 须为字符串数组");
  if (typeof o["fixHint"] !== "string") errors.push("fixHint 须为字符串（可空串）");
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: v as HealVerdict };
}

function validateHealFixReport(v: unknown): Validated<HealFixReport> {
  const o = typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  const errors: string[] = [];
  if (!isStrArr(o["fixed"])) errors.push("fixed 须为字符串数组");
  if (typeof o["summary"] !== "string") errors.push("summary 须为字符串");
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: v as HealFixReport };
}

/** 修复自报摘要（自报仅供历史记录，重验由引擎机器判定；null = 3 次回喂重试仍不合规）。 */
function summarizeHealFix(v: HealFixReport | null): string {
  if (v === null) return `自报 ${STRUCTURED_RETRY_MAX} 次回喂重试仍不合规（引擎仍会机器重验）`;
  return `${v.fixed.join("、") || "（无自报文件）"}${v.summary !== "" ? `——${v.summary}` : ""}`;
}

/** DAG 后继闭包（直接或传递依赖本节点的全部节点）——依赖可达性熔断的机器判据。 */
function successorsOf(id: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>([id]);
  const queue = [id];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const n of plan.nodes) {
      if (n.deps.includes(cur) && !seen.has(n.id)) {
        seen.add(n.id);
        out.push(n.id);
        queue.push(n.id);
      }
    }
  }
  return out;
}

async function runVerifyScript(node: PlanNode): Promise<{ exitCode: number; output: string }> {
  // 解释器按扩展名分派：.sh → bash，其余（.mjs/.js/.cjs）→ node——node 剧本走 bash 必炸
  // （import 语句报 command not found，2026-09-26 W1 验收实测）
  const interpreter = node.script.endsWith(".sh") ? "bash" : "node";
  const r = await world.run("node", ["-e", RUN_IN_CWD, interpreter, node.cwd, node.script], {
    timeoutMs: VERIFY_SCRIPT_TIMEOUT_MS,
  });
  return { exitCode: r.exitCode, output: `${r.stdout}\n${r.stderr}` };
}

/** 归因 agent（§8.7 ①）：三分类 + 证据 + 失败面文件集；自愈历史回喂（跨轮记忆）。
 *  返回 3 次回喂重试仍不合规时保守按 product-bug（不修验收资产，直接依赖判定）。 */
async function diagnoseVerifyFailure(
  node: PlanNode,
  run: { exitCode: number; output: string },
  history: string[],
  round: number,
): Promise<HealVerdict> {
  // 名字带轮次：自愈循环每轮调用本函数，run 内 agent 名唯一——同名二建直接杀 run；
  // 每轮新 agent + history 显式回喂，与 pi 侧（每次新 agent）行为对齐
  const diag = agent(`诊断-${node.id}-r${round}`, DIAGNOSE_PERSONA);
  const prompt = [
    `验收节点 ${node.id} 的剧本执行失败，请归因（只读分析）。`,
    `- 剧本：${node.script}（cwd ${node.cwd}）；本次退出码 ${run.exitCode}`,
    `- 失败输出（tail）：\n${tailLines(run.output, TAIL_LINES)}`,
    `- 完整日志与产物在剧本同目录（*.log / RESULT* / diag JSON）与产物目录 ${node.artifactsDir}`,
    history.length > 0
      ? `- 本节点自愈历史（前几轮归因与修复，均已重验仍红——本轮归因必须解释为何未收敛）：\n${history.join("\n")}`
      : "",
    "",
    "归类三选一（class 字段）：",
    '- spec-bug：验收资产自身缺陷（断言口径错 / 等待时序错 / 窗口失配 / 剧本 bug）——failureFiles 填验收资产文件，fixHint 给修复要点',
    '- product-bug：被测产品实现缺陷——failureFiles 填产品文件（只读呈报，不会被修复）',
    "- environment：超时 / 资源 / 环境类失败（非断言红）",
    "",
    '返回 JSON：{ "class": "spec-bug"|"product-bug"|"environment", "evidence": "一句话证据（引用失败输出原文）", "failureFiles": ["文件路径"], "fixHint": "修复要点（可空串）" }',
  ]
    .filter((s) => s !== "")
    .join("\n");
  const validated = await askValidated(validateHealVerdict, (p) => diag.ask<HealVerdict>(p), prompt);
  if (validated !== null) return validated;
  log(`WARN: 节点 ${node.id} 归因返回 ${STRUCTURED_RETRY_MAX} 次回喂重试仍不合规——保守按 product-bug 处理`);
  return {
    class: "product-bug",
    evidence: `归因返回 ${STRUCTURED_RETRY_MAX} 次回喂重试仍不合规——保守按产品缺陷处理（不修验收资产）`,
    failureFiles: [],
    fixHint: "",
  };
}


// ── 测试命令白名单通道（program 字面量分支——编译期命令集可见；cwd 经 node -e 参数传入） ──

async function runTestCommand(cmd: TestCommand, cwd: string): Promise<RunOutcome | null> {
  switch (cmd.program) {
    case "pnpm":
      return world.run("node", ["-e", RUN_IN_CWD, "pnpm", cwd, ...cmd.args], { timeoutMs: TEST_TIMEOUT_MS });
    case "npm":
      return world.run("node", ["-e", RUN_IN_CWD, "npm", cwd, ...cmd.args], { timeoutMs: TEST_TIMEOUT_MS });
    case "node":
      return world.run("node", ["-e", RUN_IN_CWD, "node", cwd, ...cmd.args], { timeoutMs: TEST_TIMEOUT_MS });
    case "git":
      return world.run("node", ["-e", RUN_IN_CWD, "git", cwd, ...cmd.args], { timeoutMs: TEST_TIMEOUT_MS });
    case "bash":
      return world.run("node", ["-e", RUN_IN_CWD, "bash", cwd, ...cmd.args], { timeoutMs: TEST_TIMEOUT_MS });
    default:
      return null;
  }
}

// ── dev 节点确定性核验（三查） ──

async function verifyDevNode(node: PlanNode, result: NodeResult, attempts: number): Promise<VerifyVerdict> {
  // 查三：blockers 自报非空 → blocked（环境/任务书问题，定向修不可解，不进打回）
  if (result.blockers.length > 0) {
    return { outcome: "blocked", reason: "任务书自报 blockers", detail: result.blockers.join("；") };
  }
  if (result.status !== "done") {
    return { outcome: "retry", reason: `自报 status=${result.status}`, detail: result.test_evidence || "（无自测证据）" };
  }
  // 查一级（对账语义，2026-09-29 裁决范围声明降级）：自报 files_changed 超出声明范围的
  // 路径不再打回——运行时逐文件拦截实测零命中真越权、反造成扩展死锁等损耗（u3 声明范围
  // 扩展死等 35.9min）；多开发/少开发的一致性由 D2 一致性审查与终态残留对账承接。
  // commit 照常按自报精确路径执行（与声明范围无关），此处只登记对账事件
  const outside = result.files_changed.filter((f) => !pathInTerritory(f, node.territory));
  if (outside.length > 0) {
    log(
      `WARN: 节点 ${node.id} 自报改动含声明范围外路径 ${outside.length} 项（${outside.slice(0, 5).join("、")}${outside.length > 5 ? " 等" : ""}）——不打回，登记对账随终态呈报`,
    );
    await statusUpdate(
      node.id,
      { status: "in-progress", attempts },
      "territory-outside",
      `第 ${attempts} 轮自报声明范围外改动（对账呈报，不打回；多轮重验按轮各登记一笔）：${outside.join("、")}`,
    );
  }
  // 查二级（粗粒度）：引擎另跑全量 status，观察清单外残留——只登记不拦截（2026-09-26
  // 用户裁决：并行单元运行中新建的文件天然不在启动时载入的静态声明范围里，把「别人的
  // 改动」判为当前单元越界是连坐——曾致 d3 被兄弟单元 7 个残留文件卡死、u5/u2a 互卡
  // 成对 blocked。本节点只对自己的纪律负责（查一改动对账登记 + 查二测试绿）；全工作
  // 区残留统一由收尾对账呈报主 agent 处理，防漏报价值由终态呈报承接）
  const porcelain = await gitPorcelainViaNode(node.cwd);
  if (porcelain === null) {
    return { outcome: "blocked", reason: "git status --porcelain 执行失败（引擎层）", detail: `cwd=${node.cwd}` };
  }
  const activeTerr = activeTerrByCwd.get(node.cwd) ?? [];
  const strays = parsePorcelain(porcelain).filter(
    (f) => !isTmpArtifact(f) && !pathInTerritory(f, activeTerr) && !declaredFiles.has(f),
  );
  if (strays.length > 0) {
    log(
      `WARN: 工作区存在清单外未提交改动 ${strays.length} 项（${strays.slice(0, 5).join("、")}${strays.length > 5 ? " 等" : ""}）——多为并行单元新建文件，不阻塞本节点，收尾统一呈报`,
    );
  }
  // 查二：节点测试命令重跑（program+args，cwd=节点 cwd），断言退出码 0
  const tr = node.testCommand === null ? null : await runTestCommand(node.testCommand, node.cwd);
  if (tr === null) {
    return {
      outcome: "blocked",
      reason: `测试命令 program 不在白名单（${TEST_WHITELIST.join("/")}）：${node.testCommand?.program ?? "(无)"}`,
      detail: "exec-plan 编译错误——启动校验已拦截，此处为防御分支",
    };
  }
  if (tr.exitCode !== 0) {
    return {
      outcome: "retry",
      reason: `节点测试命令退出码 ${tr.exitCode}`,
      detail: tailLines(`${tr.stdout}\n${tr.stderr}`, TAIL_LINES),
    };
  }
  return { outcome: "pass", reason: "核验通过", detail: "" };
}

// ── 三类节点执行体 ──

/** agent ask 的接替包装（设计 §6.2 F15 第一等路径）：结构化返回不合规（3 次回喂重试后）
 *  或会话异常 → 接替 actor + 前任证据包 + 当前 git diff --stat，令其先核验现状再续作，禁止
 *  盲目重做；接替者仍不合规 / 再异常才返回 null（调用方 blocked）。注意 actor 引用在
 *  executeDevNode 开头一次性创建——同名续聊 = 单 actor 多次 ask，每次 ask 都调 agent(name)
 *  会创建同名新 actor，run 直接炸（冒烟实测） */
async function askWithSuccession(
  primary: Agent,
  successor: Agent,
  prompt: string,
  node: PlanNode,
  lastResult: NodeResult | null,
): Promise<NodeResult | null> {
  let failReason = "";
  try {
    const r = await askValidated(validateNodeResult, (p) => primary.ask<NodeResult>(p), prompt);
    if (r !== null) return r;
    failReason = `结构化返回 ${STRUCTURED_RETRY_MAX} 次回喂重试仍不合规`;
  } catch (e) {
    failReason = errText(e);
  }
  const diff = await world.run("node", ["-e", GIT_DIFF_STAT, node.cwd]);
  const pack = [
    `前任 agent 会话异常或返回不合规（${failReason}）——你是接替者，先核验现状再续作，禁止盲目重做已完成的改动：`,
    `- 前任最后自报：files_changed = ${lastResult?.files_changed.join("、") ?? "（无）"}`,
    `  test_evidence = ${lastResult?.test_evidence ?? "（无）"}；deviations = ${lastResult?.deviations.join("；") || "无"}`,
    `- 当前 git diff --stat（工作区现状）：`,
    diff.stdout.trim() === "" ? "  （工作区无未提交改动——前任可能尚未落盘任何文件）" : diff.stdout.trim(),
    `- 任务书：${node.promptFile}`,
    ``,
    `先 read 任务书，再核对上述现状，判断前任已完成什么/缺什么，续作完成后返回任务书末尾定义的同一 JSON 契约。`,
    ``,
    `（前任本次收到的原始指令如下——含打回场景的核验失败原因与失败输出，按需定向处理：）`,
    prompt,
  ].join("\n");
  log(`节点 ${node.id} agent 会话异常或返回不合规（${failReason}），启动接替程序`);
  return await askValidated(validateNodeResult, (p) => successor.ask<NodeResult>(p), pack);
}

async function executeDevNode(node: PlanNode): Promise<void> {
  await beginNode(node.id);
  // 同名续聊承载打回：actor 一次性创建、多次 ask（同一 subagent 队列天然保持会话上下文）；
  // 接替 actor 预创建（仅异常时使用——创建即占名，名字唯一性由节点 id 保证）
  const primaryAgent = agent(`node-${node.id}`, DEV_PERSONA);
  const succAgent = agent(`接替-${node.id}`, DEV_PERSONA);
  // 首轮指令提为变量，供打回轮前情拼接（pi 侧 withPrevContext 消费——zcode 同名续聊天然承载）
  const initialPrompt = `读取任务书 ${node.promptFile}（绝对路径）并按其完整执行，返回该文件末尾定义的 JSON 契约（status / files_changed / test_evidence / deviations / blockers，可含 summary）。files_changed 用相对工作区 git 仓库根的路径（git status 风格）。`;
  let result = await askWithSuccession(
    primaryAgent,
    succAgent,
    initialPrompt,
    node,
    null,
  );
  if (result === null) {
    await markNodeBlockedOrFailed(
      node.id,
      "blocked",
      `结构化返回经接替仍不合规（${STRUCTURED_RETRY_MAX} 次回喂重试 × 主/接替两路径）`,
      "任务书可读，接管前先核对 git status 盘点前任落盘",
      1,
    );
    return;
  }
  let attempts = 1;
  let verdict = await verifyDevNode(node, result, attempts);
  while (verdict.outcome === "retry" && attempts <= MAX_REJECT_ROUNDS) {
    log(`节点 ${node.id} 核验未过（${verdict.reason}），打回定向修`);
    result = await askWithSuccession(
      primaryAgent,
      succAgent,
      withPrevContext(
        initialPrompt,
        result,
        `引擎确定性核验未通过（原因：${verdict.reason}）。按以下失败输出定向修复；修复调试期只重跑失败的测试文件定位问题（禁止每轮全套复跑），全套复跑仅在最终交付前执行一次。完成并自证通过后重新返回同一 JSON 契约：\n${verdict.detail}`,
      ),
      node,
      result,
    );
    if (result === null) {
      await markNodeBlockedOrFailed(
        node.id,
        "blocked",
        `打回轮结构化返回经接替仍不合规（${STRUCTURED_RETRY_MAX} 次回喂重试 × 主/接替两路径）`,
        `上一轮核验未过原因：${verdict.reason}`,
        attempts,
      );
      return;
    }
    attempts += 1;
    await statusUpdate(node.id, { status: "in-progress", attempts }, "reject-round", verdict.reason);
    verdict = await verifyDevNode(node, result, attempts);
  }
  if (verdict.outcome === "pass") {
    // commit 三要素保真（§8.3）：unitId（模板）+ designRef（章节锚前置，summary 已含则不重复
    // 前置——冒烟实测 dev 常在 summary 自带章节号）+ summary（promptFile 契约要求末行含「测试：<命令> 绿」）
    const summary = result.summary ?? "dev 单元交付";
    const summaryWithRef =
      node.designRef !== "" && !summary.includes(node.designRef) ? `${node.designRef} ${summary}` : summary;
    const message = buildCommitMessage(plan.commitTemplate, node.id, summaryWithRef, activeRunId);
    const cr = await gitAddCommitViaNode(node.cwd, message, result.files_changed);
    for (const f of result.files_changed) declaredFiles.add(f);
    if (!cr.ok) {
      // commit 被拒不 blocked：核验已过、编码成果有效；拒因多为仓库 pre-commit 钩子的
      // 全仓检查看到并行兄弟单元的半成品（钩子要求「当场修复」，而修那些文件超出本
      // 节点范围声明纪律——节点内无解）。转待办，收尾呈报主 agent 代提交（钩子照常执行）
      deferredCommits.push({ id: node.id, message, files: result.files_changed, err: cr.err });
      const evidence = `${result.test_evidence}；deviations: ${result.deviations.join("；") || "无"}；commit 待主 agent 代提交（被拒输出见 event）`;
      state.set(node.id, { status: "done", attempts });
      await statusUpdate(
        node.id,
        { status: "done", attempts, evidence },
        "commit-deferred",
        `核验通过但 commit 被拒（多为仓库钩子全仓检查 × 并行半成品，节点内无解）：${message}`,
      );
      report({ id: node.id, state: "done", detail: "commit-deferred" }, "nodes");
      log(`节点 ${node.id} 核验通过，commit 被拒转待办（收尾由主 agent 代提交）`);
      return;
    }
    const evidence = `${result.test_evidence}；deviations: ${result.deviations.join("；") || "无"}`;
    await finishNodeDone(node.id, attempts, cr.hash, evidence);
    log(`节点 ${node.id} 核验通过，已提交（${cr.hash.slice(0, 8)}）`);
    return;
  }
  if (verdict.outcome === "blocked") {
    await markNodeBlockedOrFailed(node.id, "blocked", verdict.reason, verdict.detail, attempts);
    return;
  }
  await markNodeBlockedOrFailed(node.id, "blocked", `打回超限仍未通过：${verdict.reason}`, verdict.detail, attempts);
  log(`节点 ${node.id} 打回超限（共 ${attempts} 次尝试），标记 blocked，后继挂起`);
}

async function executeVerifyNode(node: PlanNode): Promise<void> {
  await beginNode(node.id);
  // 剧本由 D0 预编译，引擎只执行断言退出码；bash 白名单分支 + cwd 参数化。
  // fail → run 内自愈循环（§8.7）：归因 → spec-bug 修验收资产重验 / product-bug 不修 /
  // environment 重试一次；不收敛按依赖可达性判定（卡后继 = 熔断上报；不卡 = 跳过跑完上报）
  let run = await runVerifyScript(node);
  let attempt = 1;
  const healHistory: string[] = [];
  const healer = agent(`修复-${node.id}`, HEAL_PERSONA); // 同名续聊承载多轮修复上下文（pi 侧靠 healHistory 回喂）
  while (run.exitCode !== 0) {
    const verdict = await diagnoseVerifyFailure(node, run, healHistory, attempt);
    healHistory.push(`第 ${attempt} 轮归因 ${verdict.class}：${verdict.evidence}`);
    if (verdict.class === "spec-bug" && attempt < MAX_HEAL_ROUNDS) {
      const fix = await askValidated(
        validateHealFixReport,
        (p) => healer.ask<HealFixReport>(p),
        [
          `验收节点 ${node.id} 的失败归因为 spec-bug（验收资产自身缺陷），请修复验收资产。`,
          `- 归因证据：${verdict.evidence}`,
          `- 归因指向的验收资产文件：${verdict.failureFiles.join("、") || node.script}`,
          `- 修复要点：${verdict.fixHint !== "" ? verdict.fixHint : "（归因未给——按证据自行判定）"}`,
          `- 失败输出（tail）：\n${tailLines(run.output, TAIL_LINES)}`,
          healHistory.length > 1 ? `- 历史修复（均已重验仍红——不要重复无效修复，换思路或修正归因未覆盖的口径）：\n${healHistory.join("\n")}` : "",
          `只改上述验收资产文件（禁止产品代码）；修复后引擎会原样重跑剧本（${node.script}）机器判定，不采信自报。`,
          '返回 JSON：{ "fixed": ["实际修改的文件"], "summary": "一句话修复说明" }',
        ]
          .filter((s) => s !== "")
          .join("\n"),
      );
      healHistory.push(`  修复：${summarizeHealFix(fix)}`);
      attempt += 1;
      await statusUpdate(
        node.id,
        { status: "in-progress", attempts: attempt },
        "heal-round",
        `spec-bug 修复后重验（第 ${attempt - 1} 轮自愈）：${verdict.evidence}`,
      );
      run = await runVerifyScript(node);
      continue;
    }
    if (verdict.class === "environment" && attempt === 1) {
      attempt += 1;
      await statusUpdate(
        node.id,
        { status: "in-progress", attempts: attempt },
        "heal-retry",
        `environment 类失败重试一次：${verdict.evidence}`,
      );
      run = await runVerifyScript(node);
      continue;
    }
    // product-bug（用户裁决 2026-09-26：验收 fixer 不碰产品代码）或 spec-bug 自愈不收敛 /
    // environment 重试仍红 → 依赖可达性判定（调度循环据此熔断或继续）
    const stuck = successorsOf(node.id).filter((s) => {
      const st = nodeState(s);
      return st === "pending" || st === "in-progress";
    });
    const mode =
      stuck.length > 0
        ? `卡住后继（${stuck.join("、")}）——立即熔断上报，由主 agent / 用户裁决`
        : "不卡后续——记录跳过，其余节点照常执行，终态统一上报";
    await markNodeBlockedOrFailed(
      node.id,
      "failed",
      `验收失败（${verdict.class}，${attempt} 次尝试；${mode}）：${verdict.evidence}`,
      [
        tailLines(run.output, TAIL_LINES),
        verdict.failureFiles.length > 0 ? `归因指向：${verdict.failureFiles.join("、")}` : "",
        `自愈历史：\n${healHistory.join("\n")}`,
      ]
        .filter((s) => s !== "")
        .join("\n"),
      attempt,
    );
    return;
  }
  if (healHistory.length > 0) log(`Verify 节点 ${node.id} 经 ${attempt - 1} 轮自愈后收敛`);
  const artOk = await existsViaNode(node.artifactsDir);
  if (!artOk) {
    await markNodeBlockedOrFailed(
      node.id,
      "failed",
      `产物目录不存在：${node.artifactsDir}`,
      "脚本 exit 0 但 artifactsDir 缺失",
      Math.max(attempt, 1),
    );
    return;
  }
  await finishNodeDone(node.id, Math.max(attempt, 1), undefined, `verify exit 0；产物目录 ${node.artifactsDir}`);
  log(`Verify 节点 ${node.id} 脚本退出 0，产物目录存在，通过`);
}

async function executeInspectNode(node: PlanNode): Promise<void> {
  await beginNode(node.id);
  const nodeAgent = agent(`验收-${node.id}`, INSPECT_PERSONA);
  // artifactsRefs 校验过后必须进任务书——否则存在性校验成纯摆设，agent 不知可读哪些上游产物
  const refLines =
    node.artifactsRefs.length > 0
      ? [
          "",
          "上游产物引用（校验已就绪，可直接读取）：",
          ...node.artifactsRefs.flatMap((r) => {
            const vn = plan.nodes.find((x) => x.id === r);
            return vn !== undefined && vn.kind === "verify" && vn.artifactsDir !== "" ? [`- ${r} → ${vn.artifactsDir}`] : [];
          }),
        ]
      : [];
  const result = await askValidated(
    validateInspectResult,
    (p) => nodeAgent.ask<InspectResult>(p),
    `读取验收任务书 ${node.promptFile}（绝对路径）并按其完整执行（只检查，不修改代码、不产生 commit），返回该文件末尾定义的 JSON 契约（verdict: "pass"|"fail"|"degraded" / test_evidence / deviations / blockers），并把判定书 JSON 写入 ${node.artifactsDir}/verdict.json（文件内 verdict 字段必须与结构化返回一致——引擎以此文件为 done 的事实锚）。${refLines.join("\n")}`,
  );
  if (result === null) {
    await markNodeBlockedOrFailed(
      node.id,
      "blocked",
      `inspect 结构化返回 ${STRUCTURED_RETRY_MAX} 次回喂重试仍不合规`,
      "任务书可读，接管前先核对上游产物",
      1,
    );
    return;
  }
  if (result.blockers.length > 0) {
    await markNodeBlockedOrFailed(node.id, "blocked", "任务书自报 blockers", result.blockers.join("；"), 1);
    return;
  }
  if (result.verdict === "fail") {
    await markNodeBlockedOrFailed(node.id, "failed", `inspect 验收结论 fail`, result.test_evidence, 1);
    return;
  }
  // pass/degraded 收 done 前核判定书锚：结构化自报与落盘判定文件一致才算数——
  // verdict 词表已与执行语义解耦，此锚再挡「agent 口头 pass、文件 FAIL」的残余假绿通道
  if (!(await inspectVerdictAnchorOk(node, result.verdict))) {
    await markNodeBlockedOrFailed(
      node.id,
      "failed",
      `inspect 结构化 verdict=${result.verdict} 但 ${node.artifactsDir}/verdict.json 缺失或结论不一致——事实锚不成立，按失败处理`,
      result.test_evidence,
      1,
    );
    return;
  }
  await finishNodeDone(node.id, 1, undefined, (result.verdict === "degraded" ? "[DEGRADED] " : "") + result.test_evidence);
  log(`Inspect 节点 ${node.id} 验收结论 ${result.verdict}${result.verdict === "degraded" ? "（降级通过，evidence 已标注）" : "（判定书锚核对一致）"}`);
}

async function executeNode(node: PlanNode): Promise<void> {
  if (node.kind === "dev") return executeDevNode(node);
  if (node.kind === "verify") return executeVerifyNode(node);
  return executeInspectNode(node);
}

// ── 调度主循环（设计 §8.2 流式）：逐节点 settle 即重算——单节点完成立即解锁后继
//    在并发余量内补派，不等批内其他节点（长尾不拖批）；活跃声明范围并集随活跃集动态重建 ──

async function runSchedulingLoop(): Promise<void> {
  // id → 完成后 resolve 回自身 id（race 的返回值即完成节点）
  const active = new Map<string, Promise<string>>();
  const launch = (n: PlanNode): void => {
    const p = (async (): Promise<string> => {
      try {
        await executeNode(n);
      } catch (e) {
        // rejected（接替程序也失败/写盘失败等引擎层异常）→ 节点 blocked，其他节点照常推进；
        // 兜底写 status 失败时只 log（内存态已置 blocked，调度不受影响）——二次异常不得击穿
        // race 造成顶层 throw（违反 failed-as-return）。attempts 取内存态当前值（曾恒传 0，
        // 恢复者无法从 status 判断已烧几轮）
        const burned = state.get(n.id)?.attempts ?? 0;
        try {
          await markNodeBlockedOrFailed(n.id, "blocked", `节点执行异常：${errText(e)}`, "", burned);
        } catch (e2) {
          state.set(n.id, { status: "blocked", attempts: burned, reason: `节点执行异常：${errText(e)}（status 回写失败：${errText(e2)}）` });
          log(`WARN: 节点 ${n.id} 异常后的 status 回写失败（${errText(e2)}）——内存态已置 blocked`);
        }
      }
      return n.id;
    })();
    active.set(n.id, p);
  };
  while (true) {
    if (coreFail !== null) break;
    // （执行期授权连带生效通道已删，2026-09-29 裁决范围声明降级：运行时不再逐文件核验，
    // territory 无运行中扩容需求——原「每轮重读 exec-plan 吸收扩展」依赖节点落定触发，
    // parked 等扩展 + 长跑单元在场时扩展永不可达（实测 u3 死等 35.9min 后被手动停）。
    // 声明范围外的必要改动由 agent 直接做 + 自报 deviations，核验对账不打回）
    const ready = plan.nodes.filter(
      (n) =>
        nodeState(n.id) === "pending" &&
        n.deps.every((d) => nodeState(d) === "done"),
    );
    // 游标防同轮重复派发（launch 后 state 同步变 in-progress，游标是双保险）
    let dispatched = 0;
    while (active.size < MAX_CONCURRENCY && dispatched < ready.length) {
      launch(ready[dispatched]);
      dispatched += 1;
    }
    if (active.size === 0) break; // 无可调度且无活跃 → 依赖挂起或全终态 → 终态判定
    // 级二粗粒度复核的基线：**单调累积**（launch 时并入该节点范围声明，settle 后不移除）——
    // 粗粒度复核「只松不严」原则下，移除已落定节点的范围声明只会收紧：兄弟节点带残留改动
    // 落定（blocked/commit 失败）后，在飞节点的核验会把残留判为越界 stray 而被误伤打回
    //（审查 P1 修正；launch 后并入保证新派发节点自身必在并集内）
    for (const id of active.keys()) {
      const n = plan.nodes.find((x) => x.id === id);
      if (!n) continue;
      const list = activeTerrByCwd.get(n.cwd) ?? [];
      for (const t of n.territory) if (!list.includes(t)) list.push(t);
      activeTerrByCwd.set(n.cwd, list);
    }
    const finishedId = await Promise.race(active.values());
    active.delete(finishedId);
    log(`节点 ${finishedId} 落定（活跃 ${active.size}），重算就绪集`);
    // 核心组熔断判定：任一核心节点 blocked/failed 且 haltOnCoreFail → 记归因、停止新派发。
    // 在飞节点收尾不放弃（await allSettled——熔断只是不派新，已派节点的落盘/commit 照常完成）
    // §8.7 依赖可达性熔断（2026-09-26 用户裁决，统一判据）：任一节点 blocked/failed 且
    // 卡住未终态后继（verify 自愈不收敛 / product-bug / dev 打回超限 / 自报 blockers）→
    // 立即停止派发（在飞收尾不放弃）；不卡的失败已被记录跳过，其余节点照常调度。原静态
    // coreIds/haltOnCoreFail 短路已退役（核心场景标注不再承载熔断语义——依赖闭包是唯一判据）
    {
      const stuckBad = plan.nodes.find((n) => {
        const st = nodeState(n.id);
        if (st !== "failed" && st !== "blocked") return false;
        return successorsOf(n.id).some((s) => {
          const sst = nodeState(s);
          return sst === "pending" || sst === "in-progress";
        });
      });
      if (stuckBad !== undefined) {
        const rt = state.get(stuckBad.id);
        coreFail = {
          id: stuckBad.id,
          detail: `${rt?.reason ?? "节点失败卡住后继"}\n${rt?.detail ?? ""}`.trim(),
        };
        log(`节点 ${stuckBad.id} 失败/受阻且卡住后继（依赖可达性熔断 §8.7）：未派发节点不再派发，等待在飞节点收尾`);
        await Promise.allSettled([...active.values()]);
        break;
      }
    }
  }
}

// ── 看板（运行观察面：节点状态流转实时上板，终态也可从 status.json 人读） ──
artifact.board("nodes", {
  title: "执行节点状态",
  key: "id",
  status: "state",
  columns: ["pending", "in-progress", "done", "failed"],
  cardTitle: "id",
  detail: [{ field: "detail", label: "说明" }],
});

// ══════════════ 阶段 1：校验执行计划 ══════════════

phase("校验执行计划");

const rawPlanText = await readTextViaNode(execPlanPath);
if (rawPlanText === null) {
  return invalidRet(`exec-plan 文件不存在或不可读：${execPlanPath}`, "");
}
let rawPlan: unknown;
try {
  rawPlan = JSON.parse(rawPlanText);
} catch (e) {
  return invalidRet(`exec-plan 不是合法 JSON：${errText(e)}`, "");
}
const validated = validatePlan(rawPlan);
if (!validated.ok) {
  return invalidRet(`exec-plan schema 校验失败（共 ${validated.errors.length} 条）：\n- ${validated.errors.join("\n- ")}`, "");
}
plan = validated.plan;

if (!(await existsViaNode(plan.projectRoot))) {
  return invalidRet(`projectRoot 不存在：${plan.projectRoot}`, plan.statusPath);
}

// skillDataDir 组装（失败走 invalidRet，与其他启动校验同型）：runlog/ledger 等过程记录
// 落 ~/.agents/skill-data/dev-flow/<project-slug>/（status.json 本身落点由 exec-plan 决定）
const homeRes = await world.run("node", ["-e", NODE_PROBE_HOME]);
if (homeRes.exitCode !== 0 || homeRes.stdout.trim() === "") {
  return invalidRet(
    `无法解析用户 home 目录（node 探针失败，exit ${homeRes.exitCode}）：${homeRes.stderr.trim()}`,
    plan.statusPath,
  );
}
const slugRes = await world.run("node", ["-e", NODE_PROJECT_SLUG, plan.projectRoot]);
if (slugRes.exitCode !== 0 || slugRes.stdout.trim() === "") {
  return invalidRet(
    `projectRoot 无法解析为项目 slug（realpath + sha256 探针失败，exit ${slugRes.exitCode}）：${slugRes.stderr.trim()}`,
    plan.statusPath,
  );
}
const skillDataDir = `${homeRes.stdout.trim()}/.agents/skill-data/dev-flow/${slugRes.stdout.trim()}`;

// run manifest startedAt（循环启动时记录；探针失败 = 防覆盖判据不可用，终态时放弃写
// run.json 只告警——终态数据以 status.json 与返回值为准）
const startedAtRes = await world.run("node", ["-e", NODE_PROBE_NOW]);
const runStartedAt =
  startedAtRes.exitCode === 0 && startedAtRes.stdout.trim() !== "" ? startedAtRes.stdout.trim() : null;
for (const n of plan.nodes) {
  if (n.promptFile !== "" && !(await existsViaNode(n.promptFile))) {
    return invalidRet(`节点 ${n.id} 的 promptFile 不存在：${n.promptFile}`, plan.statusPath);
  }
  if (n.kind === "verify" && !(await existsViaNode(n.script))) {
    return invalidRet(`verify 节点 ${n.id} 的 script 不存在：${n.script}`, plan.statusPath);
  }
  if (n.kind === "verify" && !VERIFY_SCRIPT_EXTS.has(n.script.slice(n.script.lastIndexOf(".")))) {
    return invalidRet(
      `verify 节点 ${n.id} 的 script 扩展名不受支持：${n.script}（合法：${[...VERIFY_SCRIPT_EXTS].join(" / ")}；解释器分派 = .sh→bash、其余→node）`,
      plan.statusPath,
    );
  }
}

// 启动基线扫描（全部去重 cwd；工作流产物已迁 HOME 下 skill-data、porcelain 天然不可见，
// .tmp/ 过滤退化为历史兼容）——记录启动前既有改动
// 为豁免集，不拒绝启动（2026-09-26 用户裁决：启动前的工作区改动与本次节点无关，不该
// 卡死发起——续跑/恢复场景工作区常有上次残留，拒启动 = 强迫人工先清理再重发）。
// 该豁免集只服务终态对账口径：residualFiles 排除启动前既有项（它们不是本次 run 产生的，
// 是否处置由主 agent 按自身语境判断）
const preExistingByCwd = new Map<string, Set<string>>();
const allCwds = [...new Set(plan.nodes.map((n) => n.cwd))];
for (const c of allCwds) {
  // 口径断言：cwd 须为其所在 git 仓库根（projectRoot / worktree 根均满足；仓库子目录拒绝）
  const top = await gitToplevelViaNode(c);
  if (top === null) {
    return invalidRet(`git rev-parse 无法在 ${c} 执行（须为有效 git 仓库根）`, plan.statusPath);
  }
  if (top !== c) {
    const ids = plan.nodes.filter((n) => n.cwd === c).map((n) => n.id).join("、");
    return invalidRet(
      `节点 ${ids} 的 cwd ${c} 不是其所在 git 仓库根（rev-parse --show-toplevel = ${top}）——cwd 只能为 projectRoot 或 worktree 绝对路径：porcelain 输出相对 cwd、territory 相对仓库根，子目录会使两基准全链错位（声明恒判越界、提交被拒）。恢复动作：exec-plan 中该节点 cwd 改为仓库根后重发`,
      plan.statusPath,
    );
  }
  const st = await gitPorcelainViaNode(c);
  if (st === null) {
    return invalidRet(`git status 无法在 ${c} 执行（须为有效 git 仓库）`, plan.statusPath);
  }
  const dirty = parsePorcelain(st).filter((f) => !isTmpArtifact(f));
  if (dirty.length > 0) {
    preExistingByCwd.set(c, new Set(dirty));
    log(
      `WARN: 启动时 ${c} 工作区已有 ${dirty.length} 项未提交改动（${dirty.slice(0, 5).join("、")}${dirty.length > 5 ? " 等" : ""}）——不阻塞启动，终态对账单独列示（启动前既有，非本次节点产生）`,
    );
  }
}

// status.json：不存在 → 创建初始态（全 pending）；存在 → 只保留 done（dev done 须 commit 在 git，
// 不在则回 pending——§4.5 崩溃裁决以 git 为准），其余一律回 pending 重执行
const existingStatus = await readStatusFile();
// 运行唯一标识（commit trailer Run-Id 的反查锚）：初建时生成；恢复时沿用磁盘值（旧格式
// 无 runId → 生成新值，旧 commit 因 trailer 不匹配不再被反查认领，重跑由幂等核验兜住）
const genRunId = async (): Promise<string> => {
  // workflow 沙箱禁 Date.now/Math.random（重放一致性——每次执行值不同会对不上账），
  // 随机量须经 world.run 在沙箱外的 node 子进程产生，结果作为值拿回
  const r = await world.run("node", ["-e", "process.stdout.write(Date.now().toString(16) + Math.random().toString(16).slice(2, 6))"]);
  const id = r.stdout.trim();
  if (id === "") throw new Error(`Run-Id 生成失败（node 子进程无输出，exit ${r.exitCode}）`);
  return id;
};
let activeRunId: string;
// 跨仓对账条目：cwd 非空（worktree/子模块仓根）的节点以 `<id>@<仓根>` 传递——
// RECONCILE 按条目仓根做 cat-file 与 log 反查（单 projectRoot 口径会误判子模块 commit）
const devEntry = (id: string) => {
  const n = plan.nodes.find((x) => x.id === id);
  return n && n.cwd ? `${id}@${n.cwd}` : id;
};
if (existingStatus === null) {
  // baseline 固化：优先 exec-plan 的 baseline（编译时点 HEAD，早于本 run 全部 commit——
  // status 被删但本 run commit 已在 git 的恢复场景，窗口完整覆盖），但 AI 抄写的值不可
  // 全信，git 对象库验证（rev-parse --verify）失败/缺失时弃用、当场取 HEAD 固化（此时
  // 历史 commit 无法归账，单元重跑由幂等核验兜住）。「无 baseline」态构造性消灭，
  // RECONCILE 的无窗口分支随之只对旧格式 status.json 可达
  let baselineVal: string | null = null;
  if (typeof plan.baseline === "string" && plan.baseline.trim() !== "") {
    const v = await world.run("git", ["-C", plan.projectRoot, "rev-parse", "--verify", `${plan.baseline}^{commit}`]);
    if (v.exitCode === 0 && v.stdout.trim() !== "") baselineVal = v.stdout.trim();
    else log(`WARN: exec-plan baseline「${plan.baseline}」不是仓库中的真实提交（rev-parse --verify exit ${v.exitCode}）——弃用，当场取 HEAD 固化`);
  }
  if (baselineVal === null) {
    const h = await world.run("git", ["-C", plan.projectRoot, "rev-parse", "HEAD"]);
    if (h.exitCode === 0 && h.stdout.trim() !== "") baselineVal = h.stdout.trim();
  }
  activeRunId = await genRunId();
  const initialNodes: Record<string, StatusEntry> = {};
  for (const n of plan.nodes) initialNodes[n.id] = { status: "pending", attempts: 0 };
  try {
    await writeTextViaNode(
      plan.statusPath,
      JSON.stringify({ baseline: baselineVal, runId: activeRunId, nodes: initialNodes, events: [] }, null, 2),
    );
  } catch (e) {
    return invalidRet(`status.json 初始态创建失败（${plan.statusPath}）：${errText(e)}`, plan.statusPath);
  }
  log(`status.json 不存在，已创建初始态（${plan.nodes.length} 个节点全 pending，baseline 固化 ${baselineVal ?? "(HEAD 获取失败——反查将被禁用)"}，runId ${activeRunId}）：${plan.statusPath}`);
  for (const n of plan.nodes) state.set(n.id, { status: "pending", attempts: 0 });
  // 初始态同样走双向对账（§4.5 崩溃裁决不留人工方向）：status.json 曾被删但 commit 在 git——
  // 非 done 的 dev 节点按 git log 反查补写 done，避免重跑已交付单元
  const freshDevIds = plan.nodes.filter((n) => n.kind === "dev").map((n) => n.id);
  if (freshDevIds.length > 0) {
    const rec = await world.run("node", ["-e", RECONCILE_STATUS, plan.statusPath, plan.projectRoot, plan.commitTemplate, activeRunId, ...freshDevIds.map(devEntry)]);
    if (rec.exitCode === 0 && rec.stdout.trim() !== "") {
      try {
        const parsed = JSON.parse(rec.stdout) as unknown;
        if (isRec(parsed) && isRec(parsed.nodes)) {
          for (const id of freshDevIds) {
            const e = normalizeEntry(parsed.nodes[id]);
            if (e.status === "done") state.set(id, { status: "done", attempts: e.attempts });
          }
          const recovered = freshDevIds.filter((id) => nodeState(id) === "done").length;
          if (recovered > 0) {
            // 对账结果写回磁盘（RECONCILE stdout 即完整 status.json）——只更新内存会造成
            // 磁盘全 pending 与内存 done 漂移，重启后对账重复跑（曾实测：补 done 蒸发）
            await writeTextViaNode(plan.statusPath, rec.stdout.trim());
            log(`初始态对账：git log 反查补写 ${recovered} 个已提交单元为 done 并写回 status.json（status.json 曾缺失）`);
          }
        }
      } catch {
        // 对账输出解析失败：保持全 pending 重跑（安全方向——重复执行有幂等核验兜底）
      }
    }
  }
} else {
  // 双向对账（§4.5 崩溃裁决，git 为准）：done 验证 commit 存在性（不在回 pending）；
  // 非 done 的 dev 节点反查 git log（commitTemplate 渲染的单元锚）——有 commit 未记 → 补写 done
  const allDevIds = plan.nodes.filter((n) => n.kind === "dev").map((n) => n.id);
  let aligned: Record<string, StatusEntry> = {};
  for (const n of plan.nodes) aligned[n.id] = existingStatus.nodes[n.id] ?? { status: "pending", attempts: 0 };
  // runId 恢复：沿用磁盘值保证跨重启 trailer 锚一致；旧格式无 runId → 换新值（本 run
  // 新 commit 带新 trailer，旧 commit 不被认领，兼容路径不再适用——重跑由幂等核验兜住）
  const prevRunId = existingStatus.extra["runId"];
  activeRunId = typeof prevRunId === "string" && prevRunId !== "" ? prevRunId : await genRunId();
  if (allDevIds.length > 0) {
    const rec = await world.run("node", ["-e", RECONCILE_STATUS, plan.statusPath, plan.projectRoot, plan.commitTemplate, activeRunId, ...allDevIds.map(devEntry)]);
    if (rec.exitCode === 0 && rec.stdout.trim() !== "") {
      try {
        const parsed = JSON.parse(rec.stdout) as unknown;
        if (isRec(parsed) && isRec(parsed.nodes)) {
          for (const id of allDevIds) aligned[id] = normalizeEntry(parsed.nodes[id]);
          log(`status.json 已存在，双向对账完成（dev 节点 ${allDevIds.length} 个：done 核验 commit 存在性 + git log 反查补写）`);
        }
      } catch {
        // 对账输出解析失败：保留原始记录，终态核验仍有 commit 证据可查
      }
    }
  }
  // 级联失效：dev 节点被对账回 pending（commit 不在 git 对象库）时，其已 done 的后继
  //（直接/传递依赖它的节点，含 verify/inspect）一并回 pending——后继的验证结论基于已
  // 消失的 commit，属陈旧验证（曾保持 done 被增量跳过，信任了不存在的历史）
  const resetIds = new Set<string>();
  for (const n of plan.nodes) {
    if (
      n.kind === "dev" &&
      (existingStatus.nodes[n.id]?.status ?? "pending") === "done" &&
      aligned[n.id]?.status !== "done"
    ) {
      resetIds.add(n.id);
    }
  }
  if (resetIds.size > 0) {
    let grew = true;
    while (grew) {
      grew = false;
      for (const n of plan.nodes) {
        if (aligned[n.id]?.status === "done" && n.deps.some((d) => resetIds.has(d)) && !resetIds.has(n.id)) {
          resetIds.add(n.id);
          grew = true;
        }
      }
    }
    for (const id of resetIds) {
      if (aligned[id] !== undefined && aligned[id].status === "done") {
        aligned[id] = { status: "pending", attempts: 0 };
        log(`级联失效：${id} 依赖的单元被对账回 pending，其 done 结论基于已消失的 commit——一并回 pending`);
      }
    }
  }
  // inspect 节点的 done 无 commit 锚（上面的对账只核 dev 节点 git 存在性），单独核
  // verdict 判定文件——防上一 run 的假 done（结构化自报 pass、判定书实际 FAIL，或干脆
  // 未经真实检查）被「按 status.json 增量跳过」继承（2026-10-04 taiji D3 A10 实证形态）
  for (const n of plan.nodes) {
    if (n.kind !== "inspect" || n.artifactsDir === "") continue;
    if (aligned[n.id]?.status !== "done") continue;
    const raw = await readTextViaNode(`${n.artifactsDir}/verdict.json`);
    const m = raw !== null ? raw.match(/"(?:verdict|status)"\s*:\s*"([^"]+)"/i) : null;
    const v = m?.[1]?.toLowerCase();
    if (v !== "pass" && v !== "degraded") {
      aligned[n.id] = { status: "pending", attempts: 0 };
      log(`inspect 锚核对：${n.id} 的 status.json 记 done，但 ${n.artifactsDir}/verdict.json 缺失或结论非 pass/degraded——回 pending 重跑`);
    }
  }
  for (const n of plan.nodes) {
    const e = aligned[n.id] ?? { status: "pending", attempts: 0 };
    const st: NodeRt["status"] = e.status === "done" ? "done" : "pending";
    state.set(n.id, { status: st, attempts: e.attempts });
  }
  // 对账结果写回磁盘（含反查补 done 与级联失效的最终态）——只更新内存会在重启后
  // 重复对账且补 done 不落盘（RECONCILE 输出含 reconcile-done 事件，直接整文写回）。
  // nodes 必须以既有条目为底、aligned 只覆盖当前 plan 节点：dev/acceptance 两 plan 可共用
  // 同一 statusPath，aligned 只含当前 plan 节点集，整文替换会抹掉其他 plan 的条目
  // （2026-09-26 W1 实测：u8 dev run 启动抹掉验收 v-* 条目；增量/终局回写均保留外部条目）
  const alignedAny =
    allDevIds.some((id) => (aligned[id]?.status ?? "pending") !== (existingStatus.nodes[id]?.status ?? "pending")) ||
    resetIds.size > 0;
  if (alignedAny) {
    await writeTextViaNode(
      plan.statusPath,
      JSON.stringify(
        {
          ...existingStatus.extra,
          baseline: existingStatus.baseline,
          nodes: { ...existingStatus.nodes, ...aligned },
          events: existingStatus.events,
        },
        null,
        2,
      ),
    );
    log(`对账结果已写回 ${plan.statusPath}（补 done / 级联失效条目落盘，重启不再重复对账）`);
  }
}

const depEdgeCount = plan.nodes.reduce((s, n) => s + n.deps.length, 0);
const resumedDone = plan.nodes.filter((n) => nodeState(n.id) === "done").length;
log(
  `执行计划校验通过：${plan.nodes.length} 个节点（mode=${plan.mode}），依赖边 ${depEdgeCount} 条无环` +
    (resumedDone > 0 ? `，${resumedDone} 个节点按 status.json 增量跳过` : ""),
);
// runlog 目录确保（幂等；任务书引用的过程记录落点——skill-data dev-flow 段）
{
  const rl = await world.run("node", ["-e", ENSURE_RUNLOG, plan.statusPath, skillDataDir]);
  if (rl.exitCode !== 0) log(`WARN: runlog 目录创建失败（exit ${rl.exitCode}）——agent 过程记录将自行建目录`);
}
for (const n of plan.nodes) {
  report({ id: n.id, state: nodeState(n.id) === "done" ? "done" : "pending", detail: "" }, "nodes");
}

// ══════════════ 阶段 2：并行执行（循环体单 phase，不按轮拆） ══════════════

if (plan.mode === "dev") {
  phase("并行执行开发节点");
  await runSchedulingLoop();
} else {
  phase("并行执行验收节点");
  await runSchedulingLoop();
}

// ══════════════ 阶段 3：收尾汇总 ══════════════

phase("收尾汇总");

const doneIds = plan.nodes.filter((n) => nodeState(n.id) === "done").map((n) => n.id);
const badNodes = plan.nodes.filter((n) => nodeState(n.id) === "blocked" || nodeState(n.id) === "failed");
const blockedOut = badNodes.map((n) => {
  const rt = state.get(n.id);
  const kindLabel = nodeState(n.id) === "failed" ? "验收失败" : "blocked";
  return { id: n.id, reason: `${kindLabel}：${rt?.reason ?? "未知"}`, attempts: rt?.attempts ?? 0 };
});
const skippedIds = plan.nodes.filter((n) => nodeState(n.id) === "pending").map((n) => n.id);
const terminated: WaveExecutorOutcome["terminated"] =
  coreFail !== null ? "core-failed" : badNodes.length === 0 && skippedIds.length === 0 ? "completed" : "blocked";

// 收尾残留对账（2026-09-26 用户裁决的承接面）：核验不再拦截清单外残留（多为并行单元
// 运行中新建的文件——静态声明范围天然不含），全部节点 settle 后统一盘点一次全工作区，
// 残留 = 全部改动 −（所有 dev 节点声明范围并集 ∪ 已核验节点自报 files_changed 并集）——
// 既呈报并行新文件，也承接原查二级的防漏报价值（漏报越界的文件会出现在这里被看见）
const allTerr: string[] = [];
for (const n of plan.nodes) if (n.kind === "dev") for (const t of n.territory) if (!allTerr.includes(t)) allTerr.push(t);
const finalPorcelain = await gitPorcelainViaNode(plan.projectRoot);
const preExisting = preExistingByCwd.get(plan.projectRoot) ?? new Set<string>();
const residualAll =
  finalPorcelain === null
    ? []
    : parsePorcelain(finalPorcelain).filter((f) => !isTmpArtifact(f) && !pathInTerritory(f, allTerr) && !declaredFiles.has(f));
const residualFiles = residualAll.filter((f) => !preExisting.has(f));
const preExistingLeft = residualAll.filter((f) => preExisting.has(f));

// 终局回写：挂起节点落 suspended + run-terminal 事件（status.json 即人读恢复入口）
// runManifestBase：顺带捕获固化 baseline（exec-plan 声明或初建时点 HEAD，经 rev-parse
// 验证）——run manifest 的 baseCommit 数据源（本 run 全部 commit 的基线分界）
let runManifestBase: string | null = null;
await serializedStatus(async () => {
  const st = (await readStatusFile()) ?? { baseline: plan.baseline, nodes: {}, events: [], extra: {} };
  runManifestBase = st.baseline;
  const nodes: Record<string, StatusEntry> = { ...st.nodes };
  for (const n of plan.nodes) {
    if (nodeState(n.id) === "pending") nodes[n.id] = { status: "suspended", attempts: 0 };
  }
  const residualNote =
    residualFiles.length > 0
      ? `; residual=${residualFiles.length}（清单外残留，判归属后处置：${residualFiles.slice(0, 5).join("、")}${residualFiles.length > 5 ? " 等" : ""}）`
      : "";
  const deferredNote =
    deferredCommits.length > 0 ? `; commit-deferred=${deferredCommits.map((d) => d.id).join("、")}（主 agent 代提交）` : "";
  const events: StatusEvent[] = [
    ...st.events,
    {
      seq: st.events.length + 1,
      node: "-",
      event: "run-terminal",
      detail: `terminated=${terminated}; done=${doneIds.length}; blocked=${blockedOut.length}; skipped=${skippedIds.length}${deferredNote}${residualNote}`,
    },
  ];
  if (deferredCommits.length > 0) {
    events.push({
      seq: events.length + 1,
      node: "-",
      event: "commit-deferred-list",
      detail: deferredCommits.map((d) => `${d.id}：${d.message}`).join("\n"),
    });
  }
  if (residualFiles.length > 0) {
    events.push({
      seq: events.length + 1,
      node: "-",
      event: "residual-files",
      detail: residualFiles.join("\n"),
    });
  }
  if (preExistingLeft.length > 0) {
    events.push({
      seq: events.length + 1,
      node: "-",
      event: "pre-existing-files",
      detail: `启动前既有未提交改动 ${preExistingLeft.length} 项（非本次 run 产生，是否处置按主 agent 语境判断）：\n${preExistingLeft.join("\n")}`,
    });
  }
  await writeTextViaNode(plan.statusPath, JSON.stringify({ ...st.extra, baseline: st.baseline, nodes, events }, null, 2));
});

log(
  `调度终态：${terminated}（done ${doneIds.length} / 未竟 ${blockedOut.length} / 挂起 ${skippedIds.length}${deferredCommits.length > 0 ? ` / commit 待办 ${deferredCommits.length}` : ""}${residualFiles.length > 0 ? ` / 清单外残留 ${residualFiles.length}` : ""}）——状态文件 ${plan.statusPath}`,
);

// 终态写入 ledger（未决事项与裁决处置档案——SKILL「运行记录」节）：主会话中断后
// 未决事项与终局计数仍可从盘上恢复；converged 形态同样入账（复盘轨迹）。best-effort。
try {
  const lgLines: string[] = [
    `终态 ${terminated}（runId ${activeRunId}）：done ${doneIds.length} / blocked ${blockedOut.length} / skipped ${skippedIds.length}`,
  ];
  const coreFailureInfo = readCoreFail();
  if (coreFailureInfo) lgLines.push(`- [裁决] coreFailure：${coreFailureInfo.id}——${coreFailureInfo.detail.replace(/\n+/g, " ")}`);
  for (const b of blockedOut) lgLines.push(`- [裁决] ${b.id}（${b.reason}，attempts ${b.attempts}）——升级用户：采纳修复方案 / 放弃该单元`);
  for (const dc of deferredCommits) lgLines.push(`- [待办] 代提交 ${dc.id}：${dc.message}`);
  if (residualFiles.length > 0) lgLines.push(`- [待办] 清单外残留 ${residualFiles.length} 项（判归属后处置，禁静默丢弃）：${residualFiles.join("、")}`);
  lgLines.push(`状态指针：${plan.statusPath}（nodes/events 全量）`);
  const lgw = await world.run("node", ["-e", APPEND_LEDGER, plan.statusPath, skillDataDir, `W2 wave-executor 终态 ${terminated}（mode=${plan.mode}）`, lgLines.join("\n")]);
  if (lgw.exitCode !== 0) log(`WARN: ledger 终态追加失败（exit ${lgw.exitCode}）——终态数据以 status.json 与本次返回值为准`);
} catch (e) {
  log(`WARN: ledger 终态追加异常：${errText(e)}`);
}

// run.json（分析契约，skill-data-redesign §5.1）：落 skillDataDir 根（D2 一致性审查
// 同目录先后写，防覆盖轮转由 startedAt 判据归档）。mustFixTrajectory = null（无审查轮）
if (runStartedAt !== null) {
  const endRes = await world.run("node", ["-e", NODE_PROBE_NOW]);
  const gitRev = await gitRevProbe(plan.projectRoot);
  await writeRunManifest({
    workflow: "wave-executor",
    segment: "dev-flow",
    host: HOST_PLATFORM,
    projectRoot: plan.projectRoot,
    worktreePath: plan.projectRoot,
    branch: gitRev.branch,
    baseCommit: runManifestBase,
    headCommit: gitRev.head,
    attempt: 1,
    model: null,
    startedAt: runStartedAt,
    endedAt: endRes.exitCode === 0 && endRes.stdout.trim() !== "" ? endRes.stdout.trim() : null,
    terminated,
    rounds: 1, // 单轮流式并行调度（打回/自愈是节点内重试，不产生新调度轮）
    mustFixTrajectory: null,
  });
} else {
  log("WARN: run.json 未落盘（startedAt 探针失败，防覆盖判据不可用）——终态数据以 status.json 与返回值为准");
}

return {
  terminated,
  done: doneIds,
  blocked: blockedOut,
  skipped: skippedIds,
  statusFile: plan.statusPath,
  coreFailure: coreFail,
  validationError: null,
  deferredCommits,
  residualFiles,
};

