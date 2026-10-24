/* zcode-workflow
description: dev-flow-wf 技能 W4 终态同步循环（design-code-sync 的 workflow 化 + 升级语义）：
  两级审查拓扑（R1 framework-scan planner 单 agent → 模块 fan-out 并行 reviewer；R2+ 同
  agent 聚焦复审只审上轮修复影响面）→ 矩阵脚本 concat（无 LLM 聚合层，跨模块不去重）→
  must-fix 级 contested 拦截停回用户 → reconcileGroups 机器分组并行双向修复（doc-right
  修代码跑增量测试 / code-right 修文档过联动自检五处，组级一笔 commit）→ 聚焦复审收敛 →
  伴生产物退役判定（agent 只判定清单，引擎执行移动 + 引用验证）。矩阵 + 收敛轨迹落盘
  <projectRoot>/.tmp/dev-flow/<设计文档名>.sync/（round-N[.attemptM]/ 子目录），终态档案
  final.json。终态 converged / contested / stuck / *-failure
whenToUse: dev-flow-wf 技能 D5 终态同步段——交付后把「代码实现 vs 设计文档」差距双向校准
  到 0 must-fix 时调用（审查对象 = 当前 HEAD 终态全量，不是 diff 区间）；必传 designDoc /
  implPlan / projectRoot。不用于 diff 区间代码评审（用 saved review-fix-loop）或设计文档
  审查（用 saved tech-review-loop）
args:
  designDoc:
    type: string
    description: 设计文档绝对路径（.tmp/tech-design/<name>.md，code-right 条目的修复对象之一）
    required: true
  implPlan:
    type: string
    description: 实施计划 JSON 路径（.tmp/tech-design/<name>.impl-plan.json，planner ②③职责对照对象）
    required: true
  projectRoot:
    type: string
    description: 目标项目根绝对路径（git 操作基准 + .tmp/dev-flow 产物目录落点）
    required: true
  statusPath:
    type: string
    description: status.json 绝对路径（可选；planner 职责②「现实↔impl-plan 进度核对」的数据源——
      D1/D2 终态事实；未传时②的进度核对降级为 impl-plan.json 单侧并在轨迹注明）
    default: ""
  maxRounds:
    type: number
    description: 审查→修复循环轮次上限（含 R1 首轮全量审）
    default: 10
  plannerTemplate:
    type: string
    description: framework-scan planner agent 模板路径（默认 ~/.agents/skills/dev-flow-wf/agents/sync-planner.md）
    default: ~/.agents/skills/dev-flow-wf/agents/sync-planner.md
  reviewerTemplate:
    type: string
    description: 模块 reviewer agent 模板路径（默认 ~/.agents/skills/dev-flow-wf/agents/sync-reviewer.md）
    default: ~/.agents/skills/dev-flow-wf/agents/sync-reviewer.md
  attempt:
    type: number
    description: 重发起序号（大于 1 时轮次目录命名 round-N.attemptM，不覆盖历史产物）；
      缺省时自动检测：runDir 已有任何轮次产物（含无后缀 round-* 或 final.json）→ 取
      已有最大 attempt+1（首次重发起即 attempt2，防覆盖首轮产物）
    default: 1
*/

// ── 结果与中间类型（JSDoc 作为字段描述注入子 agent） ──

/** 三向功能对照矩阵行（模板输出 schema 对齐 sync-reviewer/sync-planner） */
interface MatrixRowLite {
  /** 设计声明锚点（§N） */
  claim: string;
  /** 代码实现锚点（file:line 或 未找到） */
  impl: string;
  /** 一致 / 漏实现 / 越权实现 */
  verdict: string;
  /** 一句话说明 */
  note: string;
  /** 越权实现三问初评档位（合理/过度/存疑），仅越权行有 */
  overdesign?: string;
}

/** planner 框架级发现（矩阵顶层行 + 台账条目） */
interface PlannerFrameworkFinding {
  /** 展示用 id（FF1 形态；台账以脚本重编 id 为准） */
  id: string;
  matrixRow: MatrixRowLite;
  /** must-fix / suggestion / info */
  severity: "must-fix" | "suggestion" | "info";
}

/** 模块计划（planner 产出，phase 2 fan-out 派发依据） */
interface ModulePlanRec {
  /** 模块 id（m1 形态；agent 命名与条目归属键） */
  id: string;
  /** 模块名/路径 */
  module: string;
  /** 核对文件集（projectRoot 绝对路径，供确定性分组校验） */
  files: string[];
  /** 对照设计章节锚点 + 审查重点 */
  focus: string;
}

/** planner 结构化返回（sync-planner 模板输出节） */
interface PlannerResult {
  frameworkFindings: PlannerFrameworkFinding[];
  modules: ModulePlanRec[];
}

/** findings 八字段 schema（sync-reviewer 模板第 4 条，W4 台账载体） */
interface Finding8 {
  id: string;
  /** file:line 或 文档§章节 */
  location: string;
  /** 现实与文档各自怎么说 */
  gap: string;
  /** doc-right（文档更合理→修代码）/ code-right（代码更合理→修文档）/ contested（不得自行裁决） */
  direction: "doc-right" | "code-right" | "contested";
  /** must-fix = 过时登记/悬空符号/行为与文档矛盾；suggestion = 不同步但不误导；info = 知晓级 */
  severity: "must-fix" | "suggestion" | "info";
  /** 误导了什么交付判断——写不出 = 不立项或降 info */
  impact: string;
  /** 方向裁决理由 */
  rationale: string;
  /** 修复建议（执行方须重演验证） */
  fixHint: string;
}

/** 模块 reviewer 结构化返回（sync-reviewer 模板输出节） */
interface ModuleReview {
  matrixRows: MatrixRowLite[];
  findings: Finding8[];
  /** 本模块无发现时的显式声明（如「在 X 未发现」） */
  moduleNoFinding?: string;
  /** R2+ 聚焦复审对账（R1 恒空数组） */
  reconciliation?: ReconEntry[];
}

/** R2+ 聚焦复审对账条目 */
interface ReconEntry {
  /** 上轮条目 id（与注入清单一致原样引用） */
  prevId: string;
  /** fixed = 亲自核实已修复；not-fixed = 仍存在；regressed = 复发或修复引入新问题 */
  status: "fixed" | "not-fixed" | "regressed";
  /** 读了什么、确认了什么（file + 改动事实）；修复方声称不算证据 */
  evidence: string;
}

/** 修复组条目级记录 */
interface FixRecord {
  /** 条目 id（与任务条目一致原样引用） */
  issueId: string;
  /** 一句修复描述（含组外波及标注） */
  description: string;
  /** 自检：一条可复跑命令 + 预期结果 */
  selfCheck: string;
}

/** 修复组 agent 结构化返回 */
interface FixOutcome {
  fixes: FixRecord[];
  /** 实际改动文件（含新增文件与组外正当扩展——引擎据此做范围声明核验与组级 commit） */
  affectedFiles: string[];
  /** 越权候选 defer 申报（§7.3 机器落点）：条目的修复动作将是删码而条目非 must-fix 级 →
   *  fixer 不执行删除，申报转呈报；引擎放行（不算漏修）并随终态 overdesignCandidates 呈报 */
  deferred: { issueId: string; reason: string }[];
  /** 符号豁免申报（2026-09-27 用户裁决）：fixer 核实某机械条目指向的词不该被扫描（典型 =
   *  外部/上游包符号）→ 申报豁免；引擎转 exempt 终态、落豁免登记、随终态 exemptList 呈报
   *  主 agent 终审——豁免是 fixer 的语义判断，主 agent 可推翻 */
  exempt: { issueId: string; reason: string }[];
  /** 职责外申报（2026-09-29 裁决，F8-1 类死锁防线）：条目属实但修复动作属其他职责域
   *  （如 e2e 测试资产修复落在生产代码组）→ 申报转交；引擎置 delegated 终态不再计活跃，
   *  随终态 delegatedList 呈报主 agent 重派或立项——禁止留在本组空转到 stuck */
  delegated: { issueId: string; reason: string }[];
}

/** 修复分组（reconcileGroups 输出） */
interface FixGroup {
  /** 组标识（G1、G2…） */
  id: string;
  /** 组内条目 id */
  issueIds: string[];
  /** 组涉及文件（组间不相交，闭包合并保证） */
  files: string[];
  /** 一句话分组依据 */
  note: string;
}

/** 退役判定 agent 结构化返回（只判定，不执行） */
interface RetirementVerdict {
  /** 退役候选清单（引擎执行引用验证 + 移动；零候选时显式返回空数组） */
  candidates: { path: string; reason: string }[];
  /** 保留项及依据（含 .tmp 合规放置类） */
  kept: { path: string; reason: string }[];
}

/** 台账条目（脚本侧全生命周期状态） */
interface FindingRecord {
  id: string;
  /** 归属（"planner" | 模块 id）——R2+ 聚焦复审的续聊对象键 */
  owner: string;
  location: string;
  gap: string;
  direction: "doc-right" | "code-right" | "contested";
  severity: "must-fix" | "suggestion" | "info";
  impact: string;
  rationale: string;
  fixHint: string;
  firstSeen: number;
  /** open=待修 / fixed=已清（复审实证）/ deferred=越权候选（用户裁决前不删码）/ frozen=must-fix 级方向争议冻结（待用户裁决方向，不修不计数，随终态 contestedList 呈报）/ exempt=符号豁免（fixer 核实不该扫的词，主 agent 终审，随终态 exemptList 呈报）/ delegated=职责外（修复动作属其他职责域，不计活跃，随终态 delegatedList 呈报主 agent 重派） */
  status: "open" | "fixed" | "deferred" | "frozen" | "exempt" | "delegated";
  fixedRound?: number;
}

/** 矩阵行台账（拼接历史） */
interface MatrixRowRecord extends MatrixRowLite {
  source: string;
  round: number;
}

/** 每轮收敛轨迹点 */
interface RoundStat {
  round: number;
  rowsNew: number;
  findingsNew: number;
  mustActive: number;
  sugActive: number;
  infoActive: number;
  contestedActive: number;
  fixGroups: number;
}

/** 终态返回（引擎→主 agent 契约） */
interface SyncResult {
  /** converged = 收敛；contested = must-fix 级方向争议停回用户；stuck = 停机线（含轮次耗尽）；
   *  setup/planner/review/fix/retire/io-failure = 环节失败（恢复动作见 message） */
  terminated: "converged" | "contested" | "stuck" | "setup-failure" | "planner-failure" | "review-failure" | "fix-failure" | "retire-failure" | "io-failure";
  rounds: number;
  /** 同步产物根（矩阵/轨迹/各轮留档所在） */
  runDir: string;
  designDoc: string;
  /** 全量三向功能对照矩阵（markdown，含 findings 台账与方向分布） */
  matrixFile: string;
  /** findings 方向分布（按台账全量计） */
  directionStats: { docRight: number; codeRight: number; contested: number };
  /** 退役执行结果（仅 converged 填实；其余终态为空） */
  retirement: { retired: { from: string; to: string }[]; kept: { path: string; reason: string }[] };
  /** 方向争议记录（contested 终态 = 待用户裁决清单；converged = 非 must-fix 级默认 doc-right 的已处理记录） */
  contestedList: { id: string; location: string; gap: string; severity: string; rationale: string }[];
  /** 符号豁免清单（fixer 申报「不该被扫描的词」的机械条目——豁免登记文件 + 本清单双落点，
   *  交主 agent 终审：认可则无动作，推翻则改词表后 attempt 递增重发） */
  exemptList: { id: string; word: string; reason: string }[];
  /** 越权候选卡清单（§7.3「过度/存疑只报告不删码，用户裁决后才动」的结构化呈报——
   *  矩阵 overdesign 行 + fixer defer 申报条目；用户裁决前不产生任何删码动作） */
  overdesignCandidates: { id: string; location: string; gap: string; reason: string }[];
  /** 职责外申报条目（fixer delegated 申报累积；status=delegated 不计活跃，随终态呈报
   *  主 agent 重派或立项——F8-1 类跨职责条目空转死锁的防线，2026-09-29） */
  delegatedList: { id: string; location: string; reason: string }[];
  /** 残余活跃条目（stuck / *-failure 随终态呈报；设计 §7 停机线：清单随终态） */
  remaining: { id: string; severity: string; direction: string; location: string; gap: string }[];
  /** 工作区无人认领/多组冲突的残留改动（各组只对自己的改动负责，无人认领的不提交
   *  不作废留盘）——主 agent 判归属后处置（补提交/人工合并/清理/呈报用户，禁静默丢弃） */
  residualFiles: string[];
  /** 一句话终态说明（含恢复动作） */
  message: string;
}

// ── 参数窄化（纯函数，便于片段级验证） ──

interface NarrowedInputs {
  designDoc: string;
  implPlan: string;
  projectRoot: string;
  /** 可选：status.json 绝对路径（planner 职责②进度核对数据源；空串 = 未传，降级单侧核对） */
  statusPath: string;
  /** 可选：符号词表绝对路径（<basename>.symbol-watchlist.json，tech-design-wf T3 产出）；
   *  空串 = 未传，机械信号步跳过（不回退文档反引号抓取——抓取依赖「反引号 = 本项目符号」
   *  的隐式约定，2026-09-27 起词表是唯一扫描词源） */
  watchlist: string;
  maxRounds: number;
  plannerTemplate: string;
  reviewerTemplate: string;
  attempt: number | null;
  /** 非空 = 参数非法（fail-fast，含恢复指引素材） */
  problems: string[];
}

// ── 平台恢复指引（G 区：机制词两侧平台化，公共体经常量引用） ──
const HINT_RELAUNCH_WITH_ARGS = "修正参数后经 CreateWorkflow 重新发起（注意 AmendWorkflow 不透传 args——修订脚本时参数值需写进脚本常量后 amend）";
const HINT_PLANNER_INVALID = "AmendWorkflow 修订 prompt 后重跑";
const HINT_RETIRE_INVALID = "AmendWorkflow 修订退役 prompt 后重跑";

// ── host 标识（run manifest host 字段，skill-data-redesign §5.1：shared 不留 host
// 硬编码，两壳各持常量）──
const HOST_PLATFORM = "zcode";

// ── F 区平台钩子：R2+ 聚焦复审的 R1 上下文——zcode 同名续聊天然承载，返回空 ──
function r2PrevContextBlock(
  owner: string,
  mm: ModulePlanRec | undefined,
  projectRoot: string,
  designDoc: string,
  implPlan: string,
  headHash: string,
  plannerTplAbs: string,
  reviewerTplAbs: string,
  rel: (p: string) => string,
): string {
  void owner; void mm; void projectRoot; void designDoc; void implPlan; void headHash; void plannerTplAbs; void reviewerTplAbs; void rel;
  return "";
}

// ============================================================================
// design-code-sync-loop — dev-flow-wf 技能 W4 终态同步循环（zcode 动态工作流）
// 骨架镜像自 saved review-fix-loop.dwf.ts 与 tech-review-loop.dwf.ts（多脚本循环骨架
// = 镜像 + 头部差异登记，改动任一侧循环骨架时评估另一侧是否需要同步）。语义权威源 =
// dev-flow 流程优化设计文档 §7（两级拓扑 / 方向语义权威表 / 三向矩阵 / 越权三问三档 /
// 审查关系五条 / 修复纪律 / 退役判定 / 停机线），落点参照 dev-flow-wf/flow/sync.md。
// 与 rfl 的结构差异：
//  - 无 LLM 聚合层：矩阵行 = 脚本 concat（planner 框架行 + 各模块 reviewer 行结构化
//    返回），跨模块 findings 不去重（文件锚点唯一归属）
//  - 审查对象 = HEAD 终态全量（非 diff 区间）；两级拓扑 R1 一次，R2+ 同 agent 续聊聚焦复审
//  - 修复分组输入 = 模块 files 并集（脚本确定性构造候选组）+ reconcileGroups 机器校验
//    （照搬 rfl：无效组过滤 / 覆盖兜底 / 组间 files 相交传递闭包合并 / 重编 G1..Gn——
//    modules[].files 是 LLM 自报字段，并行 fixer 同文件冲突风险与分组来源无关）
//  - 双向修复（方向语义权威，勿反）：doc-right = 文档更合理 → 修代码（增量测试必须绿）；
//    code-right = 代码更合理 → 修文档（联动自检五处）；contested = must-fix 级停回用户，
//    suggestion/info 级默认 doc-right 并随终态汇报列出
//  - 机械信号步（R1，world.run 无 agent）：反引号标识符批量 git grep，悬空直接立项
//    （owner=mechanical；R2+ 引擎重跑机械步对账，不走 LLM 复审）
//  - 越权候选防线（§7.3 三档机器落点）：框架行 overdesign 过度/存疑入账即转候选卡；
//    fixer 遇删码类修复无论等级（含 must-fix）可申报 defer 不执行——两者都随终态
//    overdesignCandidates 呈报，用户裁决前不产生删码动作
//  - 职责外申报（2026-09-29 裁决）：fixer 判定条目修复动作属其他职责域（如 e2e 资产
//    修复落在生产代码组）→ delegated 申报置终态不计活跃，随终态 delegatedList 呈报
//    主 agent 重派——防跨职责条目在本组空转到 stuck（实测 F8-1 单条空转 6 轮）
//  - 修复全等级当轮修完不留尾巴（must-fix/suggestion/info）；组核验（改动 ⊆ 组文件并集
//    ∪ 如实申报的 affectedFiles，批改动检测 = 内容指纹差分——批前已改文件被 fixer 再改
//    后状态码不变，指纹直读内容无盲区）→ 引擎组级一笔 commit（gitignore 产物留盘不提交）
//  - 退役闭环（收敛点，2026-09-27 裁决：决定权 = 判定 agent 的内容判断，机器引用扫描
//    不否决）：agent 判定清单（零候选也显式返回）→ 引擎词干全仓扫描（含未跟踪文件）→
//    有命中转清理条目（owner=retire-cleanup）回修复循环先修引用，清零后执行 git mv /
//    文件移动 + 反向复验；fixer 裁决引用须原样保留 → deferred 呈报，候选照常移动
//  - 一切失败 failed-as-return（沿 W1 T8 收紧：throw 的 errored run 不可 resume）——
//    含未知参数键白名单 fail-fast
// 数据传递 = 结构化返回总线（无聚合层故不落重型报告文件）：matrixRows / findings /
// reconciliation / fixes 经 ask<T> 返回，脚本侧归一入台账；每轮原始返回留档
// round-N[.attemptM]/ 下供断点恢复人读。agent 模板默认路径 = 本 skill 安装位
// （~/.agents/skills/dev-flow-wf/agents/，args 可覆盖），~ 前缀经 node -e 通道运行时展开。
// ============================================================================

// ── 常量（控制流专用，不内插进任何 ask 文本） ──
const DEFAULT_MAX_ROUNDS = 10;
const REVIEWER_BATCH = 4; // 模块 fan-out 分批（全局 subagent 并发 ≤5 约束）
const FIXER_CONCURRENCY = 3; // 修复组并行批大小（rfl 同款；范围声明互斥由闭包合并保证）
const STUCK_STALL_ROUNDS = 3; // 停机线：must-fix 连续 N 轮不降判 stuck（2026-09-26 用户裁决三 loop 统一 3 轮；原设计 §7 为 4）
const STUCK_PER_FINDING_ROUNDS = 2; // 停机线：单条活跃存活超过 N 轮判 stuck（设计 §7：单条超 2 轮）
const VALID_ARG_KEYS = new Set([
  "designDoc",
  "implPlan",
  "projectRoot",
  "statusPath",
  "watchlist",
  "maxRounds",
  "plannerTemplate",
  "reviewerTemplate",
  "attempt",
]);
const TILDE_PLANNER_TEMPLATE = "~/.agents/skills/dev-flow-wf/agents/sync-planner.md";
const TILDE_REVIEWER_TEMPLATE = "~/.agents/skills/dev-flow-wf/agents/sync-reviewer.md";
const RETIREMENT_DIR = ".tmp/design-doc-retirement"; // 退役候选移动目标（projectRoot 相对，gitignore 产物）

// 机械信号步（§7.1 符号词表 grep——[HISTORICAL] 悬空引用防线，机器产确定性信号）：
// argv: [projectRoot, watchlistPath, ...docPaths] → 读 T3 产出的符号词表（scan/skip 两桶，
// skip 带理由——语义甄别在 tech-design 写词表时完成，扫描器不做任何词源猜测）→ 复验词表
// 与文档反引号集等集（文档改动 = 词表过期，脚本层直接判不通过）→ scan 词分批单进程多
// pattern 验证（git grep -oh -F -e s1 -e s2… 一次查批内全部，-o 输出实际命中，与 scan 差集
// = 零命中清单）→ stdout = JSON { ok, missing } 或 { ok: false, reason, ...差异 }。
// 2026-09-27 重建：旧版自行抓取文档反引号并假设「反引号 = 本项目符号」——上游符号
// （如 pi dist 内部函数）零命中被误立项且修复闭环死锁（正确处置 = 文档保留词 + 解释，
// 与「报警消失」判据永不同时成立，10 轮耗尽）。词表把「该不该扫」的裁决前移到 T3 语义
// 分析，扫描器回归纯机械定位。批 git 错误（exit 128）保守跳过不立项（机器信号只报
// 确定性悬空）。
const NODE_BACKTICK_GREP = [
  "var fs=require('fs'),cp=require('child_process');",
  "var root=process.argv[1],wl=process.argv[2];",
  "var out=function(o){console.log(JSON.stringify(o))};",
  "var wlRaw=null;try{wlRaw=JSON.parse(fs.readFileSync(wl,'utf8'))}catch(e){out({ok:false,reason:'词表不可读或非合法 JSON：'+wl});process.exit(0)}",
  "var scan=Array.isArray(wlRaw.scan)?wlRaw.scan.filter(function(s){return typeof s==='string'&&s!==''}):null;",
  "var skip=Array.isArray(wlRaw.skip)?wlRaw.skip:null;",
  "if(scan===null||skip===null){out({ok:false,reason:'词表缺 scan 数组或 skip 数组：'+wl});process.exit(0)}",
  "var badSkip=skip.filter(function(s){return !s||typeof s.word!=='string'||s.word===''||typeof s.reason!=='string'||s.reason.trim()===''});",
  "if(badSkip.length>0){out({ok:false,reason:'词表 skip 元素畸形（须 {word, reason 非空}）'+badSkip.length+' 条'});process.exit(0)}",
  "var words=new Set();",
  "for (var pi=3; pi<process.argv.length; pi++){",
  "  try{ var t=fs.readFileSync(process.argv[pi],'utf8');",
  "    var m=t.match(/`([^`\\n]{2,60})`/g)||[];",
  "    for (var s of m){ var v=s.slice(1,-1).trim();",
  "      if(!v||!/^[\\x20-\\x7e]+$/.test(v))continue;",
  "      if(v.indexOf('/')>=0||v.indexOf(' ')>=0)continue;",
  "      if(v.split(/[^A-Za-z0-9_.\\-]+/).length>4)continue;",
  "      if(/v?\\d+(\\.\\d+)+/i.test(v))continue;",
  "      words.add(v); }",
  "  }catch(e){}",
  "}",
  "var declared=new Set(scan);for (var s2 of skip)declared.add(s2.word);",
  "var under=[...words].filter(function(w){return !declared.has(w)});",
  "var over=scan.filter(function(w){return !words.has(w)}).concat(skip.filter(function(s){return !words.has(s.word)}).map(function(s){return s.word}));",
  "if(under.length>0||over.length>0){out({ok:false,reason:'词表与文档反引号集不一致（词表过期——回 tech-design-wf T3 重产）',inDocNotInWatchlist:under,inWatchlistNotInDoc:over});process.exit(0)}",
  "if(scan.length===0){out({ok:true,missing:[]});process.exit(0)}",
  "var hit=new Set();",
  "for (var b=0; b<scan.length; b+=100){",
  "  var pat=[];",
  "  for (var k=b; k<b+100 && k<scan.length; k++){ pat.push('-e'); pat.push(scan[k]); }",
  "  var r=cp.spawnSync('git',['grep','-oh','-F'].concat(pat),{cwd:root,encoding:'utf8',maxBuffer:67108864});",
  "  if (r.status === 128) { console.error('WARN: 批 '+b+' git 错误，该批符号保守跳过不立项'); continue; }",
  "  if (r.stdout) { for (var ln of r.stdout.split('\\n')) { var tt=ln.trim(); if (tt) hit.add(tt); } }",
  "}",
  "out({ok:true,missing:scan.filter(function(s){return !hit.has(s)})});",
].join("\n");

// node -e 通道（argv 传参，无 shell 注入面；node 代码不受脚本 facade 限制）
const NODE_WRITE_FILE =
  "require('fs').mkdirSync(require('path').dirname(process.argv[1]),{recursive:true});require('fs').writeFileSync(process.argv[1],process.argv[2])";
const NODE_CHECK_EXISTS =
  "const fs=require('fs');const missing=process.argv.slice(1).filter(p=>!fs.existsSync(p));if(missing.length>0){process.stdout.write(missing.join(' | '));process.exit(1)}";
const NODE_EXISTS_ONE = "process.exit(require('fs').existsSync(process.argv[1])?0:1)";
const NODE_RENAME_FILE =
  "require('fs').mkdirSync(require('path').dirname(process.argv[2]),{recursive:true});require('fs').renameSync(process.argv[1],process.argv[2])";
const NODE_PROBE_HOME = "process.stdout.write(require('os').homedir())";
// project-slug 探针：输出 basename-realhash8（realpath + sha256 前 8 位十六进制小写；
// impl-spec §1 全域唯一算法，与 skill-data-dir.mjs / 各循环实现对同一组固定向量一致）
const NODE_PROJECT_SLUG =
  "const p=require('fs').realpathSync(process.argv[1]);" +
  "const h=require('crypto').createHash('sha256').update(p).digest('hex').slice(0,8);" +
  "process.stdout.write(p.split('/').filter(Boolean).pop()+'-'+h)";

// run manifest 探针组（skill-data-redesign §5.1：终态在 runDir 根写 run.json）：
// NODE_PROBE_NOW 取当前时刻（ISO8601）。startedAt 必须经 world.run 探针取而不能脚本内
// new Date()——world.run 是 journal 语义（resume 重放回放首次记录值），startedAt 因此跨
// resume 构造性稳定，run.json 防覆盖判据（startedAt 相同 = 同一次 run）才成立
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
// 归档（attempt 后缀目录内的 run.json 不覆盖历史产物，此轮转防的是同 runDir 重放）；
// startedAt 相同（resume 重放）→ 直接覆写；旧文件缺失/损坏/无 startedAt（无判据可归档）
// → 覆盖
const NODE_WRITE_RUN_JSON =
  "var fs=require('fs'),pt=require('path');" +
  "try{fs.mkdirSync(pt.dirname(process.argv[1]),{recursive:true})}catch(e){}" +
  "try{var oldRun=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));if(oldRun&&typeof oldRun.startedAt==='string'&&oldRun.startedAt!==process.argv[3]){fs.renameSync(process.argv[1],pt.join(pt.dirname(process.argv[1]),'run-'+oldRun.startedAt.replace(/:/g,'-')+'.json'))}}catch(e){}" +
  "fs.writeFileSync(process.argv[1],process.argv[2])";

// ── run manifest（skill-data-redesign §5.1 统一 schema）：终态收尾在 runDir 根写
// run.json（分析契约）；terminated 沿用本循环终态词表，分析侧按 workflow 字段分组解读。
// host 由壳平台常量 HOST_PLATFORM 注入（shared 不留 host 硬编码）；model 置 null——
// facade 不暴露本次 run 的模型标识，不为此扩 agent 调用契约
interface RunManifest {
  workflow: string;
  segment: "tech-design" | "dev-flow";
  host: string;
  projectRoot: string;
  /** 无独立 worktree 概念的循环 = projectRoot */
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
  /** tech-review-loop = must-fix 计数序列；本循环 = 逐轮活跃 must-fix 计数
   *  （roundsHist.mustActive 序列，终态同步语义）；无审查轮的循环置 null */
  mustFixTrajectory: number[] | null;
}

// argv: [...绝对路径] → stdout JSON 同序数组 [{f, h}]（h = sha256(工作区内容)，文件不
// 存在 = null）。批改动检测的内容指纹快照用：porcelain 状态码是「工作区相对 index/HEAD
// 的状态分类」，不是内容身份——批前已改文件（如用户未提交的修改）被 fixer 再改后分类
// 不变（M→M），状态码差分永远看不见；指纹差分直读内容本身，一套判据覆盖全部文件
const NODE_FILE_FINGERPRINTS =
  "var fs=require('fs'),crypto=require('crypto');var out=[];for(var i=1;i<process.argv.length;i++){var f=process.argv[i];var h=null;try{h=crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')}catch(e){}out.push({f:f,h:h})}process.stdout.write(JSON.stringify(out))";

/** 文件集 → 内容指纹 Map（一次 node -e 批量算）；文件不存在 = null 哨兵（删除也是改动） */
async function fingerprintFiles(absFiles: string[]): Promise<Map<string, string | null>> {
  const m = new Map<string, string | null>();
  if (absFiles.length === 0) return m;
  const r = await world.run("node", ["-e", NODE_FILE_FINGERPRINTS, ...absFiles]);
  if (r.exitCode !== 0) throw new Error(`内容指纹计算失败（exit ${r.exitCode}）：${r.stderr.trim()}`);
  try {
    const arr: unknown = JSON.parse(r.stdout);
    if (!Array.isArray(arr)) throw new Error("输出非数组");
    for (const it of arr) {
      if (it !== null && typeof it === "object" && typeof (it as Record<string, unknown>).f === "string") {
        const o = it as { f: string; h: string | null };
        m.set(o.f, typeof o.h === "string" ? o.h : null);
      }
    }
  } catch (e) {
    throw new Error(`内容指纹输出解析失败：${String(e)}`);
  }
  return m;
}

// ── 参数窄化（纯函数，便于片段级验证） ──


function deriveInputs(raw: Record<string, unknown>): NarrowedInputs {
  const problems: string[] = [];
  for (const key of Object.keys(raw)) {
    // `_` 前缀 = 宿主运行时私有键（如 taiji/pi 宿主注入的 _runId），不属于脚本契约，跳过白名单（2026-10-03 实测缺陷修复）
    if (!VALID_ARG_KEYS.has(key) && !key.startsWith("_")) {
      problems.push(
        `未知参数: ${key}（合法参数: ${[...VALID_ARG_KEYS].join("/")}）——拼错的参数会被静默忽略并回落默认值，故 fail-fast`,
      );
    }
  }
  const isAbs = (v: unknown): v is string => typeof v === "string" && v.trim().startsWith("/");
  const designDoc = isAbs(raw.designDoc) ? raw.designDoc.trim() : "";
  const implPlan = isAbs(raw.implPlan) ? raw.implPlan.trim() : "";
  const projectRoot = isAbs(raw.projectRoot) ? raw.projectRoot.trim() : "";
  if (designDoc === "") {
    problems.push("designDoc 缺失或非绝对路径：须传入设计文档绝对路径（tech-design-wf 设计包产出的 .md 文件）");
  }
  if (implPlan === "") {
    problems.push("implPlan 缺失或非绝对路径：须传入实施计划 JSON 路径（tech-design-wf 产出的 .impl-plan.json）");
  }
  if (projectRoot === "") {
    problems.push("projectRoot 缺失或非绝对路径：须传入项目根绝对路径（git 操作基准 + skill-data 产物段 project-slug 计算输入）");
  }
  const maxRounds =
    typeof raw.maxRounds === "number" && Number.isFinite(raw.maxRounds) && raw.maxRounds >= 1
      ? Math.floor(raw.maxRounds)
      : DEFAULT_MAX_ROUNDS;
  const plannerTemplate =
    typeof raw.plannerTemplate === "string" && raw.plannerTemplate.trim() !== "" ? raw.plannerTemplate.trim() : TILDE_PLANNER_TEMPLATE;
  const reviewerTemplate =
    typeof raw.reviewerTemplate === "string" && raw.reviewerTemplate.trim() !== "" ? raw.reviewerTemplate.trim() : TILDE_REVIEWER_TEMPLATE;
  const attempt =
    typeof raw.attempt === "number" && Number.isFinite(raw.attempt) && raw.attempt >= 1 ? Math.floor(raw.attempt) : null;
  const statusPath = isAbs(raw.statusPath) ? (raw.statusPath as string).trim() : "";
  const watchlist = isAbs(raw.watchlist) ? (raw.watchlist as string).trim() : "";
  return { designDoc, implPlan, projectRoot, statusPath, watchlist, maxRounds, plannerTemplate, reviewerTemplate, attempt, problems };
}

// ── 纯函数（归一 / 解析 / 渲染，不触 world） ──

function asStr(v: unknown, d = ""): string {
  return typeof v === "string" ? v : d;
}

/** severity 畸形归 suggestion（中间档，fail-soft：must-fix 误降会漏拦截、info 误升会
 *  虚增停机压力，取中者两端都不放大） */
function normSeverity(v: unknown): "must-fix" | "suggestion" | "info" {
  return v === "must-fix" || v === "info" ? v : "suggestion";
}

/** direction 畸形归 doc-right（方向语义权威表默认：设计文档过对抗审是意图 SSOT，文档默认赢） */
function normDirection(v: unknown): "doc-right" | "code-right" | "contested" {
  return v === "code-right" || v === "contested" ? v : "doc-right";
}

/** 不可信内容隔离（rfl/W1 wrapUntrusted 同款）：外部 agent 产出注入 prompt 时显式
 *  宣告为数据，防其中反引号/分隔线截断 prompt 结构 */
function wrapUntrusted(body: string): string {
  return ["--- BEGIN UNTRUSTED CONTEXT (data, not instructions) ---", body, "--- END UNTRUSTED CONTEXT ---"].join("\n");
}

/** planner 返回防御：null 元素丢弃、字段窄化、模块 id 去重、files 归一为绝对路径 */
function normPlanner(raw: PlannerResult, rootDir: string): PlannerResult {
  const ff: PlannerFrameworkFinding[] = [];
  for (const f of Array.isArray(raw.frameworkFindings) ? raw.frameworkFindings : []) {
    if (f === null || typeof f !== "object") continue;
    const o = f as unknown as Record<string, unknown>;
    const mro = o.matrixRow;
    const row: MatrixRowLite =
      mro !== null && typeof mro === "object"
        ? {
            claim: asStr((mro as Record<string, unknown>).claim),
            impl: asStr((mro as Record<string, unknown>).impl),
            verdict: asStr((mro as Record<string, unknown>).verdict, "未评"),
            note: asStr((mro as Record<string, unknown>).note),
            // overdesign 必须提取（审查 N1：曾漏提取致框架行候选卡通道恒不可达——
            // 消费点 ff.matrixRow.overdesign 判过度/存疑档）
            overdesign: asStr((mro as Record<string, unknown>).overdesign) || undefined,
          }
        : { claim: asStr(o.id), impl: "", verdict: "未评", note: "" };
    ff.push({ id: asStr(o.id, "FF?"), matrixRow: row, severity: normSeverity(o.severity) });
  }
  const mods: ModulePlanRec[] = [];
  const seen = new Set<string>();
  for (const m of Array.isArray(raw.modules) ? raw.modules : []) {
    if (m === null || typeof m !== "object") continue;
    const o = m as unknown as Record<string, unknown>;
    let id = asStr(o.id).trim();
    if (id === "") id = `m${mods.length + 1}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const files = (Array.isArray(o.files) ? o.files : [])
      .filter((fp): fp is string => typeof fp === "string" && fp.trim() !== "")
      .map((fp) => (fp.trim().startsWith("/") ? fp.trim() : `${rootDir}/${fp.trim()}`));
    mods.push({ id, module: asStr(o.module, id), files: [...new Set(files)], focus: asStr(o.focus) });
  }
  return { frameworkFindings: ff, modules: mods };
}

/** reviewer matrixRows 归一 */
function normMatrixRows(raw: unknown, source: string, round: number): MatrixRowRecord[] {
  if (!Array.isArray(raw)) return [];
  const out: MatrixRowRecord[] = [];
  for (const r of raw) {
    if (r === null || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const od = asStr(o.overdesign);
    out.push({
      claim: asStr(o.claim),
      impl: asStr(o.impl),
      verdict: asStr(o.verdict, "未评"),
      note: asStr(o.note),
      overdesign: od !== "" ? od : undefined,
      source,
      round,
    });
  }
  return out;
}

/** reviewer findings 归一为台账条目（脚本重编 id：F<轮>-<序>，跨模块不去重） */
function normFindings(raw: unknown, owner: string, round: number, seqStart: number): { findings: FindingRecord[]; next: number } {
  if (!Array.isArray(raw)) return { findings: [], next: seqStart };
  const out: FindingRecord[] = [];
  let seq = seqStart;
  for (const f of raw) {
    if (f === null || typeof f !== "object") continue;
    const o = f as Record<string, unknown>;
    out.push({
      id: `F${round}-${seq}`,
      owner,
      location: asStr(o.location),
      gap: asStr(o.gap),
      direction: normDirection(o.direction),
      severity: normSeverity(o.severity),
      impact: asStr(o.impact),
      rationale: asStr(o.rationale),
      fixHint: asStr(o.fixHint ?? o["fix-hint"]), // 双键兼容：模板 schema 的人类可读形态是连字符 fix-hint
      firstSeen: round,
      status: "open",
    });
    seq += 1;
  }
  return { findings: out, next: seq };
}

/** reconciliation 防御：null 元素丢弃、字段窄化；status 畸形归 not-fixed
 *  （fail-closed：畸形当未修复，下轮对账重核，不会假清账） */
function normRecon(raw: unknown): ReconEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: ReconEntry[] = [];
  for (const r of raw) {
    if (r === null || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const st = o.status;
    out.push({
      prevId: asStr(o.prevId).trim(),
      status: st === "fixed" || st === "regressed" ? st : "not-fixed",
      evidence: asStr(o.evidence),
    });
  }
  return out;
}

/** fixer 返回防御：fixes 元素窄化、affectedFiles 取首个空白分隔 token（防「path.md
 *  （中文说明）」形态进 pathspec）并归一绝对路径、去重 */
function normFixOutcome(raw: FixOutcome, rootDir: string): FixOutcome {
  const fixes: FixRecord[] = [];
  for (const f of Array.isArray(raw.fixes) ? raw.fixes : []) {
    if (f === null || typeof f !== "object") continue;
    const o = f as unknown as Record<string, unknown>;
    fixes.push({ issueId: asStr(o.issueId).trim(), description: asStr(o.description), selfCheck: asStr(o.selfCheck) });
  }
  const deferred: { issueId: string; reason: string }[] = [];
  for (const d of Array.isArray(raw.deferred) ? raw.deferred : []) {
    if (d === null || typeof d !== "object") continue;
    const o = d as unknown as Record<string, unknown>;
    const id = asStr(o.issueId).trim();
    if (id === "") continue;
    deferred.push({ issueId: id, reason: asStr(o.reason) });
  }
  const exempt: { issueId: string; reason: string }[] = [];
  for (const d of Array.isArray(raw.exempt) ? raw.exempt : []) {
    if (d === null || typeof d !== "object") continue;
    const o = d as unknown as Record<string, unknown>;
    const id = asStr(o.issueId).trim();
    if (id === "") continue;
    exempt.push({ issueId: id, reason: asStr(o.reason) });
  }
  const delegated: { issueId: string; reason: string }[] = [];
  for (const d of Array.isArray(raw.delegated) ? raw.delegated : []) {
    if (d === null || typeof d !== "object") continue;
    const o = d as unknown as Record<string, unknown>;
    const id = asStr(o.issueId).trim();
    if (id === "") continue;
    delegated.push({ issueId: id, reason: asStr(o.reason) });
  }
  const affected: string[] = [];
  for (const p of Array.isArray(raw.affectedFiles) ? raw.affectedFiles : []) {
    if (typeof p !== "string") continue;
    const tok = p.trim().split(/\s+/)[0] ?? "";
    if (tok === "") continue;
    const abs = tok.startsWith("/") ? tok : `${rootDir}/${tok}`;
    if (!affected.includes(abs)) affected.push(abs);
  }
  return { fixes, deferred, exempt, delegated, affectedFiles: affected };
}

/** 退役判定返回防御：数组/字段窄化 */
function normRetirement(raw: RetirementVerdict): RetirementVerdict {
  const norm = (arr: unknown): { path: string; reason: string }[] => {
    if (!Array.isArray(arr)) return [];
    const out: { path: string; reason: string }[] = [];
    for (const c of arr) {
      if (c === null || typeof c !== "object") continue;
      const o = c as Record<string, unknown>;
      const p = asStr(o.path).trim();
      if (p === "") continue;
      out.push({ path: p, reason: asStr(o.reason) });
    }
    return out;
  };
  return { candidates: norm(raw.candidates), kept: norm(raw.kept) };
}

/** 修复分组确定性校验（照搬 review-fix-loop reconcileGroups 语义，不信任分组来源自觉——
 *  W4 的候选组虽由脚本确定性构造，仍过同一机器校验）：
 *  ① 过滤无效组（issueIds 非活跃 id 的剔除，剔空的组丢弃）
 *  ② 覆盖性兜底——未被认领的活跃条目独立成组（漏分 ≠ 漏修）
 *  ③ 组间文件相交 → 传递闭包合并（保证并行修复不冲突）
 *  ④ 组 files 以组内条目的编辑目标文件聚合为准（候选组自报 files 仅参考）
 *  ⑤ 重编 G1..Gn；输入缺失/空时全部活跃条目归一组（退化 = 单 fixer 行为） */
function reconcileGroups(raw: FixGroup[] | undefined, active: { id: string; files: string[] }[]): FixGroup[] {
  if (active.length === 0) return [];
  const activeIds = new Set(active.map((i) => i.id));
  const filesOf = new Map(active.map((i) => [i.id, i.files]));
  let groups: { note: string; issueIds: string[] }[];
  if (!raw || raw.length === 0) {
    // 缺失/空分组 → 单组全包（退化 = 单 fixer 行为；单组无组对，合并循环天然 no-op）
    groups = [{ note: "", issueIds: [...activeIds] }];
  } else {
    groups = ((raw ?? []) as (FixGroup | null)[])
      .map((g) => (g && Array.isArray(g.issueIds) ? g : null))
      .filter((g): g is FixGroup => g !== null)
      .map((g) => ({
        note: g.note || "",
        issueIds: [...new Set(g.issueIds.filter((id) => activeIds.has(id)))],
      }))
      .filter((g) => g.issueIds.length > 0);
    const claimed = new Set(groups.flatMap((g) => g.issueIds));
    for (const id of activeIds) {
      if (!claimed.has(id)) {
        groups.push({ note: "候选分组漏分，兜底独立组", issueIds: [id] });
      }
    }
  }
  const groupFiles = (ids: string[]) => [...new Set(ids.flatMap((id) => filesOf.get(id) ?? []))];
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        const fi = groupFiles(groups[i].issueIds);
        const fj = groupFiles(groups[j].issueIds);
        if (fi.some((f) => fj.includes(f))) {
          groups[i] = {
            note: [groups[i].note, groups[j].note].filter(Boolean).join("；") + "（文件相交，防御性合并）",
            issueIds: [...new Set([...groups[i].issueIds, ...groups[j].issueIds])],
          };
          groups.splice(j, 1);
          merged = true;
          break outer;
        }
      }
    }
  }
  return groups.map((g, idx) => ({ id: `G${idx + 1}`, issueIds: g.issueIds, files: groupFiles(g.issueIds), note: g.note }));
}

/** git status --porcelain 解析 → path→状态 Map；rename 形态（R  old -> new）两侧都记 */
function parsePorcelain(out: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of out.split("\n")) {
    if (line.length < 4) continue;
    const st = line.slice(0, 2);
    let rest = line.slice(3);
    if (rest.startsWith("\"") && rest.endsWith("\"") && rest.length >= 2) rest = rest.slice(1, -1);
    if (rest.includes(" -> ")) {
      const parts = rest.split(" -> ");
      const oldP = parts[0] ?? "";
      const newP = parts[1] ?? "";
      if (oldP !== "") m.set(oldP, st);
      if (newP !== "") m.set(newP, st);
      continue;
    }
    if (rest !== "") m.set(rest, st);
  }
  return m;
}

/** location 锚点提取代码文件路径（形如 packages/x/y.ts:88 的首 token；判据 = 含路径
 *  分隔符 + 扩展名后缀——不限定 ASCII，中文文件名路径同样成立；非路径形态返回空） */
function anchorPath(location: string): string {
  const token = location.trim().split(/[\s:（(，,]/)[0] ?? "";
  if (token.length < 3 || !token.includes("/")) return "";
  return /\.[A-Za-z0-9]+$/.test(token) ? token : "";
}

function mdEscape(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

// ── 参数窄化执行 + 早期失败（failed-as-return，不 throw） ──

const inputs = deriveInputs(args);
if (inputs.problems.length > 0) {
  return {
    terminated: "setup-failure",
    rounds: 0,
    runDir: "",
    designDoc: inputs.designDoc,
    matrixFile: "",
    directionStats: { docRight: 0, codeRight: 0, contested: 0 },
    retirement: { retired: [], kept: [] },
    contestedList: [],
    overdesignCandidates: [],
    remaining: [],
    message: `参数校验失败：${inputs.problems.join("；")}。${HINT_RELAUNCH_WITH_ARGS}`,
  };
}
const { designDoc, implPlan, projectRoot, statusPath: statusPathArg, watchlist, maxRounds } = inputs;

// ── 环境准备（home 展开 / runDir / attempt / 模板探针 / 基线 HEAD） ──

phase("框架对照与模块规划");

// home 展开：模板 ~ 前缀运行时解析（脚本无 node API，经 node -e 通道）
const homeRes = await world.run("node", ["-e", NODE_PROBE_HOME]);
if (homeRes.exitCode !== 0 || homeRes.stdout.trim() === "") {
  return {
    terminated: "setup-failure",
    rounds: 0,
    runDir: "",
    designDoc,
    matrixFile: "",
    directionStats: { docRight: 0, codeRight: 0, contested: 0 },
    retirement: { retired: [], kept: [] },
    contestedList: [],
    overdesignCandidates: [],
    remaining: [],
    message: `无法解析用户 home 目录（node 探针失败，exit ${homeRes.exitCode}）：${homeRes.stderr.trim()}。恢复动作：确认 node 可执行后重新发起`,
  };
}
const homeDir = homeRes.stdout.trim();
const expandTilde = (p: string): string => (p.startsWith("~/") ? `${homeDir}/${p.slice(2)}` : p);
const plannerTplAbs = expandTilde(inputs.plannerTemplate);
const reviewerTplAbs = expandTilde(inputs.reviewerTemplate);

// 必读文件存在性探针：设计文档 / impl-plan / 两模板
const probe = await world.run("node", ["-e", NODE_CHECK_EXISTS, designDoc, implPlan, plannerTplAbs, reviewerTplAbs]);
if (probe.exitCode !== 0) {
  return {
    terminated: "setup-failure",
    rounds: 0,
    runDir: "",
    designDoc,
    matrixFile: "",
    directionStats: { docRight: 0, codeRight: 0, contested: 0 },
    retirement: { retired: [], kept: [] },
    contestedList: [],
    overdesignCandidates: [],
    remaining: [],
    message: `必读文件缺失：${probe.stdout.trim()}。恢复动作：核对 designDoc/implPlan/agent 模板路径（模板默认 ~/.agents/skills/dev-flow-wf/agents/，可经 args.plannerTemplate/reviewerTemplate 覆盖）后重新发起`,
  };
}

// impl-plan 必须是合法 JSON（设计包入口门在 skill 侧已查存在性，此处补内容合法性）
const planParse = await world.run(
  "node",
  ["-e", "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))", implPlan],
);
if (planParse.exitCode !== 0) {
  return {
    terminated: "setup-failure",
    rounds: 0,
    runDir: "",
    designDoc,
    matrixFile: "",
    directionStats: { docRight: 0, codeRight: 0, contested: 0 },
    retirement: { retired: [], kept: [] },
    contestedList: [],
    overdesignCandidates: [],
    remaining: [],
    message: `impl-plan 不是合法 JSON（${implPlan}）：${planParse.stderr.trim()}。恢复动作：回 tech-design-wf T3 重产双格式 impl-plan 后重新发起`,
  };
}

// 产物目录组装：~/.agents/skill-data/dev-flow/<project-slug>/（<name>.sync/、<name>.runlog/、
// <name>.ledger.md 平铺同基准）。project-slug 探针（realpath + sha256 前 8 位）：realpath 失败 =
// projectRoot 不存在，setup-failure
const slugRes = await world.run("node", ["-e", NODE_PROJECT_SLUG, projectRoot]);
if (slugRes.exitCode !== 0 || slugRes.stdout.trim() === "") {
  return {
    terminated: "setup-failure",
    rounds: 0,
    runDir: "",
    designDoc,
    matrixFile: "",
    directionStats: { docRight: 0, codeRight: 0, contested: 0 },
    retirement: { retired: [], kept: [] },
    contestedList: [],
    overdesignCandidates: [],
    remaining: [],
    message: `projectRoot 无法解析为项目 slug（realpath + sha256 探针失败，exit ${slugRes.exitCode}）：${slugRes.stderr.trim()}。恢复动作：确认 projectRoot 目录存在后重新发起`,
  };
}
const projectSlug = slugRes.stdout.trim();
const skillDataDir = `${homeDir}/.agents/skill-data/dev-flow/${projectSlug}`;

// runDir 命名：<skillDataDir>/<设计文档 basename 去扩展名>.sync/
const docBase = designDoc.split("/").pop() ?? designDoc;
const docName = docBase.replace(/\.[^.]+$/, "");
const runDir = `${skillDataDir}/${docName !== "" ? docName : "design"}.sync`;
const matrixFile = `${runDir}/matrix.md`;
const trajectoryFile = `${runDir}/trajectory.md`;
const finalJsonPath = `${runDir}/final.json`;
const retirementDestDir = `${projectRoot}/${RETIREMENT_DIR}`;
// 过程记录目录与未决/裁决档案（与 <name>.sync/ 同一 skillDataDir 平铺——SKILL「运行记录」节；
// 不按 attempt 分目录，重发起的过程记录靠文件内条目时间线自然累积）
const runlogDir = `${skillDataDir}/${docName !== "" ? docName : "design"}.runlog`;
const ledgerPath = `${skillDataDir}/${docName !== "" ? docName : "design"}.ledger.md`;

// run manifest startedAt（循环启动时记录；探针失败 = 防覆盖判据不可用，终态时放弃写
// run.json 只告警——终态数据以 final.json 与返回值为准）
const startedAtRes = await world.run("node", ["-e", NODE_PROBE_NOW]);
const runStartedAt =
  startedAtRes.exitCode === 0 && startedAtRes.stdout.trim() !== "" ? startedAtRes.stdout.trim() : null;

/** run.json 终态落盘（best-effort：失败只告警——终态数据以返回值为准）；防覆盖轮转
 *  判定在 NODE_WRITE_RUN_JSON 内（旧文件 startedAt 不同 → rename 归档后覆写） */
async function writeRunManifest(m: RunManifest): Promise<void> {
  const w = await world.run("node", ["-e", NODE_WRITE_RUN_JSON, `${runDir}/run.json`, JSON.stringify(m, null, 2), m.startedAt]);
  if (w.exitCode !== 0) {
    log(`WARN: run.json 落盘失败（exit ${w.exitCode}：${w.stderr.trim() || w.stdout.trim()}）——终态数据以 final.json 与返回值为准`);
  }
}

/** git 探针（NODE_GIT_REV）→ {branch, head}；输出形态非法全 null（fail-soft，不改变终态） */
async function gitRevProbe(): Promise<{ branch: string | null; head: string | null }> {
  const r = await world.run("node", ["-e", NODE_GIT_REV, projectRoot]);
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

// 重发起检测（沿 W1 惯例）：扫描 runDir 内已有 attempt 后缀最大序号，未显式传 → max+1
//（固定取 2 会覆盖第三次及以后重发起的 attempt2 产物）；无 attempt 后缀时，runDir 已有
// 任何轮次产物（无后缀 round-* 或 final.json）→ 取 1（缺省 attempt=2），防首次重发起覆盖首轮
const ATTEMPT_SCAN =
  "try{var fs=require('fs');var names=[];try{names=fs.readdirSync(process.argv[1])}catch(e){}var mx=0;" +
  "for(var n of names){var m=/^round-\\d+\\.attempt(\\d+)$/.exec(n);if(m){var v=Number(m[1]);if(v>mx)mx=v}}" +
  "if(mx===0&&(names.some(n=>/^round-\\d+$/.test(n))||names.indexOf('final.json')>=0))mx=1;" +
  "if(mx>0)process.stdout.write(String(mx))}catch(e){}";
const attemptProbe = await world.run("node", ["-e", ATTEMPT_SCAN, runDir]);
const prevAttemptMax =
  attemptProbe.exitCode === 0 && /^\d+$/.test(attemptProbe.stdout.trim()) ? Number(attemptProbe.stdout.trim()) : 0;
const attempt = inputs.attempt !== null ? inputs.attempt : prevAttemptMax > 0 ? prevAttemptMax + 1 : 1;
const roundDirName = (n: number): string => (attempt > 1 ? `round-${n}.attempt${attempt}` : `round-${n}`);

// runlog 目录确保（幂等；prompt 注入的过程记录落点——手工路径 D0 已建，此处覆盖引擎直发形态）
const NODE_ENSURE_DIR =
  "try{require('fs').mkdirSync(process.argv[1],{recursive:true})}catch(e){process.stderr.write(String(e.message||e));process.exit(1)}";
{
  const mk = await world.run("node", ["-e", NODE_ENSURE_DIR, runlogDir]);
  if (mk.exitCode !== 0) log(`WARN: runlog 目录创建失败（exit ${mk.exitCode}）——agent 过程记录将自行建目录`);
}

// 基线 HEAD 锁定（审查对象 = HEAD 终态全量；记录进矩阵供事后核对）
const headRes = await world.run("git", ["-C", projectRoot, "rev-parse", "HEAD"]);
if (headRes.exitCode !== 0 || headRes.stdout.trim() === "") {
  return {
    terminated: "setup-failure",
    rounds: 0,
    runDir: "",
    designDoc,
    matrixFile: "",
    directionStats: { docRight: 0, codeRight: 0, contested: 0 },
    retirement: { retired: [], kept: [] },
    contestedList: [],
    overdesignCandidates: [],
    remaining: [],
    message: `git 仓库探测失败（git -C ${projectRoot} rev-parse HEAD，exit ${headRes.exitCode}）：${headRes.stderr.trim()}。恢复动作：确认 projectRoot 是 git 仓库后重新发起`,
  };
}
const headHash = headRes.stdout.trim();

// 工作区预检：W4 审 HEAD 终态全量，脏工作区属边界情况——告警不阻断（组级 commit 只
// stage 认领文件，脏文件不会被误提交）
const preStatus = await world.run("git", ["-C", projectRoot, "status", "--porcelain"]);
if (preStatus.exitCode === 0) {
  const dirty = parsePorcelain(preStatus.stdout);
  if (dirty.size > 0) {
    log(`WARN: 工作区已有 ${dirty.size} 个未提交改动文件——审查以工作区实物为准，引擎 commit 只 stage 各组认领文件，预存改动不受影响`);
  }
}

const rel = (p: string): string => (p.startsWith(`${projectRoot}/`) ? p.slice(projectRoot.length + 1) : p);
const pathUnderRoot = (p: string): string => (p.startsWith("/") ? p : `${projectRoot}/${p}`);
async function pathExists(p: string): Promise<boolean> {
  const r = await world.run("node", ["-e", NODE_EXISTS_ONE, p]);
  return r.exitCode === 0;
}
async function writeArtifact(path: string, content: string): Promise<boolean> {
  const r = await world.run("node", ["-e", NODE_WRITE_FILE, path, content]);
  return r.exitCode === 0;
}

/** 审计留档写盘（best-effort：失败只告警不炸轮——留档是断点恢复的辅助面，
 *  矩阵/轨迹才是权威落盘） */
async function auditJson(path: string, content: string): Promise<void> {
  try {
    if (!(await writeArtifact(path, content))) log(`WARN: 审计留档写盘失败（${path}）——不影响本轮，矩阵/轨迹仍权威落盘`);
  } catch (e) {
    log(`WARN: 审计留档写盘异常（${path}）：${String(e)}`);
  }
}

// ledger 追加（未决事项与裁决处置档案——SKILL「运行记录」节；与 W2/W3 同语义：
// best-effort，失败只告警不改变终态）
const NODE_APPEND_TEXT = [
  "var fs = require('fs'), path = require('path');",
  "var file = process.argv[1], title = process.argv[2], body = process.argv[3];",
  "try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, '## ' + title + '\\n' + body + '\\n\\n'); }",
  "catch (e) { process.stderr.write(String(e.message || e)); process.exit(1); }",
].join("\n");

async function appendLedger(title: string, body: string): Promise<void> {
  try {
    const r = await world.run("node", ["-e", NODE_APPEND_TEXT, ledgerPath, title, body]);
    if (r.exitCode !== 0) log(`WARN: ledger 追加失败（${title}，exit ${r.exitCode}）——终态数据以 final.json 为准`);
  } catch (e) {
    log(`WARN: ledger 追加异常（${title}）：${String(e)}`);
  }
}

// ── 状态 ──

const ledger: FindingRecord[] = [];
const matrixRowsRec: MatrixRowRecord[] = [];
const roundsHist: RoundStat[] = [];
// 模块 reviewer 跨轮复用容器：值类型用 facade 自带 interface 名（Agent）做注解——
// ReturnType<typeof agent> 属取值引用、自定义结构类型属 retyping 逃逸，均被编译器拦
const moduleAgents = new Map<string, Agent>();
let moduleById = new Map<string, ModulePlanRec>();
let finalNote = "";
let lastDispatchedIds: string[] = [];
let lastFixRecords: FixRecord[] = [];
/** 越权候选卡收集（§7.3：矩阵过度/存疑行 + fixer defer 申报——用户裁决前不删码） */
const overdesignCandidates: { id: string; location: string; gap: string; reason: string }[] = [];

// 模块行 overdesign 提取（与框架行入账对称——模板 sync-reviewer 输出契约承诺「越权
// 过度/存疑行只进 matrixRows」，引擎必须兑现转候选卡；2026-10-06 实测模块行携带存疑
// 标记但终态数组为空：此前提取只接了 planner 框架行与 fixer defer 两条通道）。按
// location 去重：R2+ 状态复查会重复报同一越权行，候选卡只呈报一次
const moduleOdSeen = new Set<string>();
let moduleOdSeq = 0;
function collectModuleOverdesign(rows: MatrixRowRecord[], round: number): void {
  for (const r of rows) {
    const od = r.overdesign ?? "";
    if (!od.includes("过度") && !od.includes("存疑")) continue;
    const key = r.impl !== "" ? r.impl : r.claim;
    if (moduleOdSeen.has(key)) continue;
    moduleOdSeen.add(key);
    moduleOdSeq += 1;
    overdesignCandidates.push({
      id: `M${round}-${moduleOdSeq}`,
      location: key,
      gap: `${r.claim} ↔ ${r.impl}`,
      reason: `模块三问初评「${od}」——候选卡：${r.note}`,
    });
    log(`模块行初评「${od}」→ 候选卡呈报（不进修复循环，用户裁决后才动）：${key}`);
  }
}
/** 符号豁免清单（fixer exempt 申报累积；双落点 = runDir/exempted.json + finish.exemptList，
 *  交主 agent 终审——fixer 的豁免是语义判断，主 agent 可推翻：改词表后 attempt 递增重发） */
const exemptList: { id: string; word: string; reason: string }[] = [];
// 职责外申报清单（fixer delegated 申报累积）：条目属实但修复动作属其他职责域——
// 置 delegated 终态不计活跃（防复审空转到 stuck，实测 F8-1 单条空转 6 轮），随终态
// delegatedList 呈报主 agent 重派或立项（2026-09-29 裁决）
const delegatedList: { id: string; location: string; reason: string }[] = [];
// 工作区残留登记（无人认领 + 多组冲突的改动）：不提交不作废留盘，随终态 residualFiles
// 呈报主 agent 判归属处置（2026-09-26 用户裁决——各组只对自己的改动负责）
const residualFiles = new Set<string>();

const ledgerById = (id: string): FindingRecord | undefined => ledger.find((f) => f.id === id);

/** 条目编辑目标集（范围声明/闭包判交用）：code-right → 文档侧；doc-right → location 锚点
 *  ∪ 所属模块 files（模块 files 并集语义：波及扫描的合法声明范围）；planner 域 doc-right
 *  无模块可回退时 → impl-plan（②③ 类修 impl-plan）；contested 非 must-fix 级按
 *  doc-right 处理（方向语义权威表默认） */
function findingEditFiles(f: FindingRecord): string[] {
  if (f.direction === "code-right") {
    // planner 域 code-right 的修复对象含 impl-plan（②③ 现实性/一致性差异修计划侧）；
    // mechanical 域（反引号悬空）修复面 = 文档侧（含 impl-plan.md 人读版——它也可能含悬空引用）
    if (f.owner === "planner") return [designDoc, implPlan];
    if (f.owner === "mechanical") return [designDoc, implPlan.replace(/\.impl-plan\.json$/, ".impl-plan.md")];
    return [designDoc];
  }
  const base: string[] = [];
  const anchor = anchorPath(f.location);
  if (anchor !== "") base.push(pathUnderRoot(anchor));
  if (f.owner !== "planner" && f.owner !== "mechanical") {
    const m = moduleById.get(f.owner);
    if (m) for (const fp of m.files) if (!base.includes(fp)) base.push(fp);
  }
  // 空 base = 漏实现条目（doc-right 应补代码，锚点未知）——声明范围为空集：不回退 impl-plan
  //（与「修代码」方向矛盾，§7.1 回写裁决）；组构造归单席串行组，fixer 按 fix-hint 定位
  // 补码位置、affectedFiles 如实申报，引擎按申报核验 + reconcileGroups 闭包兜底
  return base;
}

/** 候选组构造（脚本确定性，非 LLM）：每模块一候选组（组 = 模块 files 并集语义，条目 =
 *  该模块活跃条目）+ planner 域单候选组（框架级条目修复面横跨设计文档/登记文档，保守
 *  串行）。候选组仍过 reconcileGroups 机器校验（无效组过滤/覆盖兜底/闭包合并/重编组号） */
function buildCandidateGroups(active: FindingRecord[]): FixGroup[] {
  const raw: FixGroup[] = [];
  for (const m of moduleById.values()) {
    const ids = active.filter((f) => f.owner === m.id).map((f) => f.id);
    if (ids.length > 0) {
      raw.push({ id: `M-${m.id}`, issueIds: ids, files: [...m.files], note: `模块 ${m.id}（${m.module}）files 并集` });
    }
  }
  const mechIds = active.filter((f) => f.owner === "mechanical").map((f) => f.id);
  if (mechIds.length > 0) {
    raw.push({
      id: "M-mech",
      issueIds: mechIds,
      files: [designDoc, implPlan.replace(/\.impl-plan\.json$/, ".impl-plan.md")],
      note: "机械信号（反引号悬空引用）——修复面 = 文档侧引用清理",
    });
  }
  // 退役引用清理条目（引擎在收敛点生成，owner=retire-cleanup）：修复面 = location 锚点
  // （引用方文件）；锚点缺失（命中行无路径形态）→ 声明范围空集，按 fix-hint 定位 +
  // affectedFiles 申报核验——与漏实现条目同款降级路径
  const retireIds = active.filter((f) => f.owner === "retire-cleanup");
  if (retireIds.length > 0) {
    const files = [...new Set(retireIds.flatMap((f) => {
      const a = anchorPath(f.location);
      return a !== "" ? [pathUnderRoot(a)] : [];
    }))];
    raw.push({ id: "M-retire", issueIds: retireIds.map((f) => f.id), files, note: "退役引用清理——先修引用后执行退役移动（决定权在判定 agent，扫描命中只产清理素材）" });
  }
  // planner 域拆两组（§7.1 回写）：文档侧条目（code-right：架构漂移/②③/登记面/越权回写）
  // 单组串行；漏实现与 contested-suggestion（doc-right 修复面，代码锚点未知）单独成组
  // 且声明范围 = 空集（按 fix-hint 定位，affectedFiles 申报核验）
  const plannerDoc = active.filter((f) => f.owner === "planner" && f.direction === "code-right");
  const plannerImpl = active.filter((f) => f.owner === "planner" && f.direction !== "code-right");
  if (plannerDoc.length > 0) {
    raw.push({ id: "M-plan", issueIds: plannerDoc.map((f) => f.id), files: [designDoc, implPlan], note: "框架级条目（架构漂移 / impl-plan 现实性与内部一致性 / 关联登记面）——修复面横跨文档侧，保守单组" });
  }
  if (plannerImpl.length > 0) {
    raw.push({ id: "M-plan-impl", issueIds: plannerImpl.map((f) => f.id), files: [], note: "框架级漏实现 / contested-suggestion（应补代码，锚点未知）——声明范围空集：按 fix-hint 定位补码位置，affectedFiles 如实申报（引擎核验），串行单组" });
  }
  return raw;
}

function renderMatrix(): string {
  const ds = {
    docRight: ledger.filter((f) => f.direction === "doc-right").length,
    codeRight: ledger.filter((f) => f.direction === "code-right").length,
    contested: ledger.filter((f) => f.direction === "contested").length,
  };
  const L: string[] = [];
  L.push(`# design-code-sync 矩阵 — ${docBase}`);
  L.push("");
  L.push(`- 仓库：${projectRoot}`);
  L.push(`- 设计文档：${designDoc}`);
  L.push(`- impl-plan：${implPlan}`);
  L.push(`- 基线 HEAD：${headHash}`);
  L.push(`- 矩阵行 ${matrixRowsRec.length} / findings ${ledger.length}（open ${ledger.filter((f) => f.status === "open").length}）`);
  L.push(`- 方向分布：doc-right ${ds.docRight} / code-right ${ds.codeRight} / contested ${ds.contested}`);
  if (finalNote !== "") L.push(`- 终态：${finalNote}`);
  L.push("");
  L.push("## 三向功能对照矩阵（框架行在前，模块行按轮拼接；跨模块不去重——文件锚点唯一归属）");
  L.push("");
  L.push("| # | 轮 | 来源 | 设计声明（§N 锚点） | 代码实现（file:line） | 判向 | 说明 |");
  L.push("|---|---|------|--------------------|----------------------|------|------|");
  if (matrixRowsRec.length === 0) {
    L.push("| - | - | - | （空） | （空） | - | - |");
  } else {
    matrixRowsRec.forEach((r, i) => {
      const note = [r.note, r.overdesign ? `三问初评：${r.overdesign}` : ""].filter(Boolean).join("；");
      L.push(`| ${i + 1} | R${r.round} | ${mdEscape(r.source)} | ${mdEscape(r.claim)} | ${mdEscape(r.impl)} | ${mdEscape(r.verdict)} | ${mdEscape(note)} |`);
    });
  }
  L.push("");
  L.push("## Findings 台账（八字段 + 状态）");
  if (ledger.length === 0) {
    L.push("");
    L.push("（无 findings）");
  }
  // 台账状态显示（终态各档带去向说明，防止终态条目误显示为 open：delegated = 职责外申报
  // 随终态呈报主 agent 重派；exempt = 符号豁免待主 agent 终审；frozen = 方向争议冻结待用户裁决）
  const statusLabel: Record<FindingRecord["status"], string> = {
    open: "open",
    fixed: "fixed",
    deferred: "deferred（越权候选，待用户裁决）",
    frozen: "frozen（方向争议冻结，待用户裁决）",
    exempt: "exempt（符号豁免，待主 agent 终审）",
    delegated: "delegated（职责外，待主 agent 重派）",
  };
  for (const f of ledger) {
    L.push("");
    const st = f.status === "fixed" ? `fixed@R${f.fixedRound ?? "?"}` : statusLabel[f.status];
    L.push(`### ${f.id} [${f.severity}] [${f.direction}] — ${st}（R${f.firstSeen} 立项，owner=${f.owner}）`);
    L.push(`- location: ${f.location}`);
    L.push(`- gap: ${f.gap}`);
    L.push(`- impact: ${f.impact}`);
    L.push(`- rationale: ${f.rationale}`);
    L.push(`- fix-hint: ${f.fixHint}`);
  }
  L.push("");
  return L.join("\n");
}

function renderTrajectory(): string {
  const L: string[] = [];
  L.push(`# 收敛轨迹 — ${docBase}`);
  L.push("");
  L.push("| 轮 | 新矩阵行 | 新 findings | 活跃 must | 活跃 sug | 活跃 info | 活跃 contested | 修复组 |");
  L.push("|----|---------|------------|----------|----------|----------|---------------|--------|");
  for (const r of roundsHist) {
    L.push(`| R${r.round} | ${r.rowsNew} | ${r.findingsNew} | ${r.mustActive} | ${r.sugActive} | ${r.infoActive} | ${r.contestedActive} | ${r.fixGroups} |`);
  }
  L.push("");
  return L.join("\n");
}

async function persistArtifacts(): Promise<void> {
  const okM = await writeArtifact(matrixFile, renderMatrix());
  const okT = await writeArtifact(trajectoryFile, renderTrajectory());
  if (!okM || !okT) {
    throw new Error(`矩阵/轨迹写盘失败（matrix ok=${okM}，trajectory ok=${okT}）。恢复动作：检查 ${runDir} 可写性后 attempt 递增重新发起`);
  }
}

// 初始落盘（保证任一终态返回时 matrixFile 都真实存在）
await persistArtifacts();

// ── 终态构造 ──

function finish(terminated: SyncResult["terminated"], round: number, message: string): SyncResult {
  return {
    terminated,
    rounds: round,
    runDir,
    designDoc,
    matrixFile,
    directionStats: {
      docRight: ledger.filter((f) => f.direction === "doc-right").length,
      codeRight: ledger.filter((f) => f.direction === "code-right").length,
      contested: ledger.filter((f) => f.direction === "contested").length,
    },
    retirement: { retired: [], kept: [] },
    contestedList: ledger
      .filter((f) => f.direction === "contested")
      .map((f) => ({ id: f.id, location: f.location, gap: f.gap, severity: f.severity, rationale: f.rationale })),
    exemptList,
    delegatedList,
    overdesignCandidates,
    remaining: ledger
      .filter((f) => f.status === "open")
      .map((f) => ({ id: f.id, severity: f.severity, direction: f.direction, location: f.location, gap: f.gap })),
    residualFiles: [...residualFiles],
    message,
  };
}

// ── 主循环：R1 两级审查全量 → 修复 → R2+ 聚焦复审 → 修复 → … → 全清/停机 ──

// T9（用户裁决 2026-09-26）：workflow 内无用户交互位，任何 agent 不得提问——随 persona 固化
const NO_ASK_RULE =
  "禁止向用户提问（无 AskUserQuestion / ask-user / 任何等待用户输入的操作）——workflow 内没有用户交互位；" +
  "无法自决的事项按职责内默认规则处置，并在产出中记录待裁决事项（随终态呈报主 agent / 用户）。";

const PLANNER_PERSONA =
  "你是终态同步的两级审查第一级（framework-scan planner）：框架级对照与模块分解；只报告与产出计划，不修改任何文件；声称事实前核实到行级。" +
  NO_ASK_RULE;
const REVIEWER_PERSONA =
  "你是终态同步的模块审查者：只报告，绝不改代码改文档；每个发现都有你亲自读到的代码证据。" +
  NO_ASK_RULE;
const FIXER_PERSONA =
  "你是终态同步修复工程师：先重演验证再动手、修完全量自检、如实申报改动面；做不完的如实说明，不静默跳过。" +
  NO_ASK_RULE;
const RETIRE_PERSONA =
  "你是交付收尾判定者：按规则产退役/保留清单，只判定不执行；拿不准的列保留并说明理由。" +
  NO_ASK_RULE;

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
        `重新返回完整 JSON（全量重新给出，不是增量补丁；空数组须显式返回 []；除该 JSON 外不要改任何已落盘产物）。`,
        ``,
        `（同一子代理续写——完整任务上下文见前文对话，无需重述任务。你的任务开头摘录：${prompt.slice(0, 160)}${prompt.length > 160 ? "…" : ""}）`,
      ].join("\n"),
    );
  }
  const fin = validate(last);
  return fin.ok ? fin.value : null;
}

function isStrArr(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function isObjArr(v: unknown): v is Record<string, unknown>[] {
  return Array.isArray(v) && v.every((x) => typeof x === "object" && x !== null && !Array.isArray(x));
}

/** planner 返回校验：两数组结构 + normPlanner 归一后 modules 非空（归一结果即返回值） */
function validatePlannerResult(v: unknown): Validated<PlannerResult> {
  const o = typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  const errors: string[] = [];
  if (!isObjArr(o["frameworkFindings"])) errors.push("frameworkFindings 须为对象数组（无发现时显式 []）");
  if (!isObjArr(o["modules"])) errors.push("modules 须为对象数组（至少 1 个模块，规模小返回单模块）");
  if (errors.length > 0) return { ok: false, errors };
  const norm = normPlanner(v as PlannerResult, projectRoot);
  if (norm.modules.length === 0) return { ok: false, errors: ["modules 为空（至少 1 个模块，规模小返回单模块）"] };
  return { ok: true, value: norm };
}

// planner 模块计划 files 落地校验器（node -e 通道）：argv = projectRoot + JSON [{id, files[]}]
// （files 已由 normPlanner 归一为绝对路径）。每条双检：path.resolve 后落在 projectRoot 内
// （仓库外绝对路径 / 相对路径 ../ 越界同拦）+ 磁盘存在；stdout 输出违规明细 JSON 数组
// （空数组 = 全过；exit 恒 0，执行/解析故障由调用方按 exitCode 与 JSON 可判别）。
const NODE_MODULE_PLAN_CHECK =
  "const path=require('path'),fs=require('fs');" +
  "const root=path.resolve(process.argv[1]);" +
  "const mods=JSON.parse(process.argv[2]);" +
  "const out=[];" +
  "for(const m of mods){for(const f of (m.files||[])){const r=path.resolve(f);" +
  "if(r!==root&&!r.startsWith(root+path.sep))out.push(`模块 ${m.id} 文件 ${f}：解析后不在 projectRoot（${root}）内`);" +
  "else if(!fs.existsSync(r))out.push(`模块 ${m.id} 文件 ${f}：磁盘不存在（相对仓库路径 ${path.relative(root,r)||'.'}）`);}}" +
  "process.stdout.write(JSON.stringify(out));";

/** planner 模块计划落地校验（机器闸门，派发 reviewer 前拦截幻觉路径）：每条 files 必须
 *  ①解析后落在 projectRoot 内 ②磁盘存在。不过则违规明细回喂 planner 重产一次（同 agent
 *  续聊，回喂口径同 askValidated），仍不过按 planner-failure 现有失败通道上报——不派发、
 *  不静默吞。实测 planner 曾幻觉输出 module=probe / files=/tmp/x（仓库外空目录），第二级
 *  reviewer 收到悬空计划如实上报 must-fix，终态 contested 停回 = 一次误熔断 + 一轮重跑。 */
type ModulePlanGate = { ok: true; plan: PlannerResult } | { ok: false; error: string };
async function gateModulePlanFiles(first: PlannerResult): Promise<ModulePlanGate> {
  let plan = first;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = await world.run(
      "node",
      ["-e", NODE_MODULE_PLAN_CHECK, projectRoot, JSON.stringify(plan.modules.map((m) => ({ id: m.id, files: m.files })))],
    );
    let violations: string[] | null = null;
    if (r.exitCode === 0) {
      try {
        const parsed = JSON.parse(r.stdout) as unknown;
        if (Array.isArray(parsed)) violations = parsed.filter((x): x is string => typeof x === "string");
      } catch {
        // violations 保持 null → 按校验器自身故障处理
      }
    }
    if (violations === null) {
      return { ok: false, error: `路径校验器执行失败（exit ${r.exitCode}）：${r.stderr.trim().slice(0, 200)}——人工核对 planner 输出的 modules.files` };
    }
    if (violations.length === 0) return { ok: true, plan };
    log(`WARN: 模块计划路径校验不过（第 ${attempt}/2 次，机器闸门，不过不派发）：\n${violations.map((v) => `  - ${v}`).join("\n")}`);
    if (attempt === 2) return { ok: false, error: `模块计划含仓库外/不存在的文件路径，回喂重产一次后仍不过：${violations.join("；")}` };
    const rePlan = await askValidated(
      validatePlannerResult,
      (q) => plannerAgent.ask<PlannerResult>(q),
      [
        "你上一轮的 modules 计划未通过路径机器校验（files 必须是仓库内既有文件），违规明细：",
        ...violations.map((v) => `- ${v}`),
        "",
        `projectRoot = ${projectRoot}。modules 的 files 只允许该仓库内的既有文件：绝对路径须以 projectRoot 为前缀；相对路径须落在仓库内且磁盘已存在——禁止仓库外路径与计划性待建文件（impl-plan 声明但不存在的文件应作为 frameworkFindings 立项，不塞进 files）。`,
        "",
        "重新返回完整 JSON（全量重新给出，不是增量补丁；frameworkFindings 不变可原样带回；除该 JSON 外不要改任何已落盘产物）。",
      ].join("\n"),
    );
    if (rePlan === null) return { ok: false, error: "路径校验回喂重产后 planner 结构化返回仍不合规" };
    plan = rePlan;
  }
  return { ok: false, error: "unreachable" };
}

/** 模块审查返回校验：两数组结构 + findings 元素方向/严重度枚举合法 */
function validateModuleReview(v: unknown): Validated<ModuleReview> {
  const o = typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  const errors: string[] = [];
  if (!isObjArr(o["matrixRows"])) errors.push("matrixRows 须为对象数组");
  if (!isObjArr(o["findings"])) errors.push("findings 须为对象数组（无发现时显式 []）");
  else {
    const bad: string[] = [];
    (o["findings"] as Record<string, unknown>[]).forEach((f, i) => {
      const d = f["direction"];
      const s = f["severity"];
      if (d !== "doc-right" && d !== "code-right" && d !== "contested") bad.push(String(i + 1));
      else if (s !== "must-fix" && s !== "suggestion" && s !== "info") bad.push(String(i + 1));
    });
    if (bad.length > 0) errors.push(`findings 第 ${bad.join("、")} 条畸形（direction 须 doc-right|code-right|contested，severity 须 must-fix|suggestion|info）`);
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: v as ModuleReview };
}

/** 修复组返回校验：fixes 对象数组 + affectedFiles 字符串数组 + deferred/exempt/delegated 对象数组 */
function validateFixOutcome(v: unknown): Validated<FixOutcome> {
  const o = typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  const errors: string[] = [];
  if (!isObjArr(o["fixes"])) errors.push("fixes 须为对象数组（每条 { issueId, description, selfCheck }）");
  if (!isStrArr(o["affectedFiles"])) errors.push("affectedFiles 须为字符串数组");
  if (!isObjArr(o["deferred"])) errors.push("deferred 须为对象数组（无申报时显式 []）");
  if (!isObjArr(o["exempt"])) errors.push("exempt 须为对象数组（无申报时显式 []）");
  if (!isObjArr(o["delegated"])) errors.push("delegated 须为对象数组（职责外申报，无申报时显式 []）");
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: v as FixOutcome };
}

// 文件名安全化（模块/组名可含路径分隔符与空白——runlog 文件名不能展开成子目录）
const fileSafe = (s: string): string => s.replace(/[^a-zA-Z0-9._\-\u4e00-\u9fa5]+/g, "-");

// 过程记录义务行（SKILL「运行记录」节）：注入每个 agent prompt——临时待办/需裁决/
// 复盘观察的防丢失落点；模板侧只写义务内容，路径由本行注入（模板静态无路径）
function runlogDutyLine(who: string): string {
  return `过程记录（防丢失，不替代 JSON 返回契约）：执行中的临时待办、需主 agent/用户裁决的事项、对复盘有价值的观察（踩坑根因/方案取舍/环境异常），随时用一行 append 到 ${runlogDir}/${who}.md（目录已存在，文件不存在则新建），格式 [HH:MM] 类型: 一句话事实（类型 ∈ 待办/裁决/观察）。不影响正常执行与返回。`;
}

const plannerPromptText = [
  "终态同步 framework-scan（两级拓扑第一级，首轮全量）。",
  `第一步：Read planner 模板 ${plannerTplAbs}——按其中任务契约执行全部职责（框架级对照 / impl-plan 现实性与内部一致性 / 关联登记面核对 / 模块分解）。`,
  runlogDutyLine("sync-planner"),
  `仓库 ${projectRoot}；设计文档 ${designDoc}；impl-plan ${implPlan}；审查基线 = 当前 HEAD（${headHash}）——审查对象是 HEAD 终态全量，不是 diff 区间。`,
  statusPathArg !== ""
    ? `职责②「现实↔impl-plan 进度核对」的数据源 = status.json（${statusPathArg}，D1/D2 各节点终态事实）——进度核对以它为准，impl-plan.json 只有单元面/依赖/范围声明。`
    : "职责②注意：本次未提供 status.json——进度核对降级为 impl-plan.json 单侧（单元面/依赖/范围声明），无法核对节点终态事实，请在 frameworkFindings 的 note 注明该降级。",
  "只报告与产出计划，不修改任何文件。",
  "完成后返回 JSON：frameworkFindings（元素 {id, matrixRow: {claim, impl, verdict, note, overdesign?}, severity}）+ modules（元素 {id, module, files, focus}）——结构按模板输出节；无某类发现时显式说明；modules 至少 1 个。模块分解前先按模板职责 4 枚举对照范围（设计文档头部/正文指针指向的子设计文档 + impl-plan 单元表声明全部文件），枚举后确认对照范围只有单一文件域时才允许单模块。",
].join("\n");

function reviewPrompt(m: ModulePlanRec): string {
  return [
    "终态同步模块审查（两级拓扑第二级）。",
    `第一步：Read 审查模板 ${reviewerTplAbs}——按其中任务契约执行全部职责（三向矩阵行填充 + 越权三问三档初评 + 注释口径核对 + 反引号机械信号 + findings 八字段）。`,
    runlogDutyLine(`sync-${fileSafe(m.id)}`),
    `仓库 ${projectRoot}；设计文档 ${designDoc}。`,
    `本模块计划（planner 原文）：module=${m.module}；files=${m.files.map((p) => rel(p)).join("、")}；focus=${m.focus}。`,
    "只报告，绝不改代码改文档；只审本模块，禁止引用其他模块结论。",
    "完成后返回 JSON：matrixRows（元素 {claim, impl, verdict, note, overdesign?}）+ findings（八字段 {id, location, gap, direction, severity, impact, rationale, fixHint}）+ moduleNoFinding（本模块无发现时显式声明，如「在 X 未发现」）。",
  ].join("\n");
}

function reReviewPrompt(round: number, scopeFindings: FindingRecord[]): string {
  const payload = scopeFindings.map((f) => ({
    id: f.id,
    location: f.location,
    gap: f.gap,
    direction: f.direction,
    severity: f.severity,
    fixHint: f.fixHint,
    fixes: lastFixRecords
      .filter((fx) => fx.issueId === f.id)
      .map((fx) => ({ description: fx.description, selfCheck: fx.selfCheck })),
  }));
  return [
    `终态同步聚焦复审（第 ${round} 轮）：只审上轮修复影响面，不重查已确认项。`,
    "",
    runlogDutyLine(`sync-re-r${round}`),
    "",
    "上轮你范围内条目及其修复记录（修复方声称，不算证据，必须亲自读文件核实到行级）：",
    wrapUntrusted(JSON.stringify(payload)),
    "",
    "对账规则（reconciliation 每条必填，prevId 原样引用上方 id）：",
    "- 确认修复成立（附你读到的事实）→ fixed",
    "- 仍存在 → not-fixed",
    "- 复发或修复引入新问题 → regressed",
    "",
    "同时检查：",
    "- 上轮修复是否引入新差距——新差距立项为新 findings（八字段）并补矩阵行（matrixRows）。",
    "- 修复记录 description 中标注的「组外波及」若经你核实成立 → 立项为新 finding（location 指向实际文件）。",
    "",
    "完成后返回 JSON：matrixRows + findings + reconciliation。无发现时 findings/matrixRows 为空数组并显式说明。",
  ].join("\n");
}

function fixerPrompt(g: FixGroup, byId: Map<string, FindingRecord>): string {
  const L: string[] = [];
  L.push(`终态同步修复（组 ${g.id}${g.note ? ` — ${g.note}` : ""}）：本组条目全部当轮修完（所有等级，不留尾巴）。`);
  L.push("");
  L.push("本组条目：");
  for (const fid of g.issueIds) {
    const f = byId.get(fid);
    if (!f) continue;
    L.push(`- ${f.id} [${f.severity}] [${f.direction}] ${f.location}`);
    L.push(`  gap: ${f.gap}`);
    if (f.impact !== "") L.push(`  impact: ${f.impact}`);
    if (f.rationale !== "") L.push(`  rationale: ${f.rationale}`);
    if (f.fixHint !== "") L.push(`  fix-hint: ${f.fixHint}`);
  }
  L.push("");
  L.push("方向语义（权威，勿反）：");
  L.push("- doc-right（文档更合理）→ 修代码：改实现使其符合设计声明，跑与改动直接相关的增量测试并确认通过。");
  L.push("- code-right（代码更合理）→ 修文档：改设计文档/登记文档使其反映实现现实，过联动自检五处（正文/数据流图/错误规格/拆分清单/验收场景）。");
  L.push("- 改 impl-plan.json 的条目：同步 .impl-plan.md 对应行（双格式一致性——下次 D0 编译会逐项校验，单侧改动即 fail-fast）。");
  L.push("- 标记 contested 的条目按 doc-right 执行（must-fix 级方向争议已在派发前拦截，不会进入本组）。");
  L.push("- 同组混合方向时逐条按各自 direction 执行。");
  L.push("");
  L.push("修复纪律：");
  L.push("1. 修复前重演每条 fix-hint：建议站不住就换更稳方案并在该条 description 里说明。");
  L.push("2. 波及扫描：每修一处 grep 同模式实例（同类注释/测试文件头/其他文档引用点）一并修——漂移从来不是单点；组外文件里的同模式实例不改（并行冲突），在对应条目 description 标注「组外波及：<位置>」留给聚焦复审立项。");
  L.push(`3. 范围声明互斥：优先只改本组文件（${g.files.map((p) => rel(p)).join("、")}）；确需触碰组外文件或新增文件（如增量测试文件），必须列入 affectedFiles 如实申报——未申报的改动不会被提交（留盘随终态呈报主 agent 处置，本组条目可能因修复未落盘而复检重派）。`);
  L.push("4. git 禁令：禁止一切 git 写操作（add/commit/push 等）——改动留工作区，引擎统一核验后按组 commit。");
  L.push("5. 每条修复给 selfCheck：一条可复跑命令 + 预期结果（改文档类可用 grep 断言；聚焦复审会复核它）。");
  L.push("6. 越权候选防线：若某条的修复动作将是「删除/移除一段现有实现」而其指控仅是「设计文档没写」（无行为矛盾/悬空引用等实质缺陷证据），**无论等级（含 must-fix）**都不要执行删除——放入 deferred（reason 写候选卡论证：小取舍/大简化/核心价值不变），它将随终态呈报用户裁决后才动；「文档没写」更可能是文档侧漏登记而非代码越权，宁可多呈报一张候选卡，不可直接删码。deferred 的另一合法场景 = 退役引用清理条目核实为必须原样指向的合法存证（条目指引会标明）。");
  L.push("7. 符号豁免申报（仅机械信号条目可用）：若某条指控「词表符号 X 在代码库零命中」，而你核实 X 本就不该被扫描（典型 = 外部/上游包符号、且文档已就地解释其来源）——不要为消信号去删改文档（会丢失对外部依赖行为的关键描述），放入 exempt（reason 写核实证据：如在依赖包中的命中位置 / 文档解释所在位置），它将转豁免终态、落豁免登记并随终态呈报主 agent 终审。真悬空引用（本项目符号被删/改名）不属于豁免，照常修复。");
  L.push("8. 职责外申报：条目属实、但修复动作属其他职责域（典型 = e2e/测试资产修复、跨模块公共设施改动落在生产代码组）——不要硬修也不要留置不理（留置会让复审每轮重报直到 stuck，实测单条空转 6 轮），放入 delegated（reason 写修复动作属什么域、为什么不在本组职责内），它将转 delegated 终态随终态呈报主 agent 重派或立项。职责内该修的照常修。");
  L.push("");
  L.push(runlogDutyLine(`sync-fix-${fileSafe(g.id)}`));
  L.push("完成后返回 JSON：fixes（元素 {issueId, description, selfCheck}，issueId 与上面条目一致原样引用，本组全部条目必须被 fixes / deferred / exempt / delegated 之一覆盖）+ deferred（元素 {issueId, reason}——仅越权候选防线场景）+ exempt（元素 {issueId, reason}——仅机械条目的符号豁免场景）+ delegated（元素 {issueId, reason}——仅职责外场景，无申报时显式 []）+ affectedFiles（实际改动文件路径数组，含新增文件）。");
  return L.join("\n");
}

const retirePromptText = [
  "终态同步已收敛，做伴生产物退役判定——只产判定清单，不执行任何移动/修改/删除。",
  "判定规则：",
  "1. 盘点本设计相关产物（设计文档 / impl-plan / 各轮审查留档）：已在 ~/.agents/skill-data/ 工作流产物目录下的属合规放置；项目内 .tmp/design-doc-retirement/ 下的也属合规放置（退役移动目标，git mv 语义绑定项目内目录）——两类逐项列 kept（理由 = 合规放置无需处理）。",
  "2. 残留在源码树（docs/ 等）的伴生产物——旧惯例 .review* 报告、probe 产物等——若内容判断已无存留价值，列 candidates。",
  "3. 被本次设计整体取代的旧设计文档——由你独立做内容判断（新版是否完全覆盖其价值），不受「是否还有引用」影响：引用的存在不是保留的理由，引擎会把全仓引用扫描结果转为清理条目先修引用、清零后才执行移动。",
  `输入：仓库 ${projectRoot}；设计文档 ${designDoc}；同步矩阵 ${matrixFile}（可 Read 了解本次改动面与涉及文件）。`,
  "完成后返回 JSON：candidates（元素 {path, reason}，path 为 projectRoot 相对或绝对路径）+ kept（元素 {path, reason}）。零候选时 candidates 返回空数组（显式）——不要为了非空而虚构候选。",
].join("\n");

// ── 退役闭环（2026-09-27 裁决：退役决定权 = 判定 agent 的内容判断，机器引用扫描不
//    否决——「grep 命中即不退役」的旧门禁整体删除；命中只产清理素材，先修引用后移动，
//    引用迁移工作由修复循环承载而非冻结为永久保留）──

/** 退役引用扫描：文件名去扩展名词干的字面搜索（词干是完整名的超串，一发覆盖完整名
 *  与省扩展名链接两种形态）+ --untracked-files（未跟踪新文件的引用可见；工作流产物已迁
 *  HOME 下 skill-data 目录、不在 repo 内天然不可见，存量 gitignore 的 .tmp 产物同样排除）。词干误命中方向 = 保守多生成清理条目（fixer 处置时判伪），比
 *  链接形态正则枚举（变体不全 = 新盲区）安全；动态拼接路径是机械搜索固有边界，由
 *  「退役 = 移动可找回 + README 索引 + 反向告警」兜住后果。返回命中行（file:line:内容），
 *  null = git grep 异常（≠ 无引用，调用方按保守处理） */
async function scanRetireRefs(base: string): Promise<string[] | null> {
  const stem = base.replace(/\.[^.]+$/, "");
  const pat = stem !== "" ? stem : base;
  // 参数序：选项在 -e pattern 之前（pattern 后的 token 会被当 pathspec）；git grep 的
  // 未跟踪选项是 --untracked（不是 git status 的 --untracked-files，实测探针校正）
  const g = await world.run("git", ["-C", projectRoot, "grep", "-n", "-F", "--untracked", "-e", pat]);
  if (g.exitCode !== 0 && g.exitCode !== 1) return null;
  if (g.exitCode === 1) return [];
  return g.stdout.split("\n").filter((s) => s.trim() !== "");
}

/** 清理条目 → 退役候选的登记（修复轮后机器对账锚：该候选词干全仓零命中 = 条目 fixed） */
const retireCleanupTargets = new Map<string, { src: string; base: string }>();

type RetireClosureOutcome =
  | { kind: "cleanup"; findings: FindingRecord[]; next: number }
  | { kind: "done" }
  | { kind: "failure" };

/** 收敛点退役闭环：判定 agent 独立判定（唯一决定权）→ 全候选引用扫描 → 有命中转清理
 *  条目回修复循环（下轮收敛再进入本闭环保留移动）；零命中（或命中已被 deferred 裁决
 *  保留）执行移动 + 退役 commit + README 索引，并构造 converged 终态。 */
async function retireClosure(round: number, seqStart: number): Promise<RetireClosureOutcome> {
  phase("伴生产物退役判定");
  // 实例名带轮号：退役闭环的清理分支会回到下轮修复再进本函数（round 递增），
  // 固定名会在第二次进入时与首个实例同名——zcode run 内同名即整 run 拒绝（实测 dwfrun-2598036a）
  const retireAgent = agent(`伴生产物判定-R${round}`, RETIRE_PERSONA);
  let verdict: RetirementVerdict | null = null;
  let rErr = "";
  try {
    const cand = await askValidated(
      (v: unknown): Validated<RetirementVerdict> => {
        if (typeof v !== "object" || v === null) return { ok: false, errors: ["返回须为对象"] };
        return { ok: true, value: normRetirement(v as RetirementVerdict) };
      },
      (q) => retireAgent.ask<RetirementVerdict>(q),
      retirePromptText,
    );
    if (cand === null) throw new Error("结构化返回不合规（3 次回喂重试后仍失败）");
    verdict = cand;
  } catch (e) {
    rErr = String(e);
  }
  if (verdict === null) {
    finalResult = finish("retire-failure", round, `退役判定 agent 返回无效（${rErr}）。恢复动作：同步修复成果已在工作区/commit 中，${HINT_RETIRE_INVALID}`);
    return { kind: "failure" };
  }
  const retired: { from: string; to: string }[] = [];
  const kept = [...verdict.kept];
  let movedTracked = false;
  const cleanups: { src: string; base: string; dest: string; hits: string[]; reason: string }[] = [];
  const candSrcs = new Set(verdict.candidates.map((c) => pathUnderRoot(c.path)));
  for (const c of verdict.candidates) {
    const src = pathUnderRoot(c.path);
    // 活跃产物护栏：设计文档 / impl-plan / 本同步 runDir 不在退役范围（即便被误判为候选）
    if (src === designDoc || src === implPlan || src.startsWith(`${runDir}/`) || src.startsWith(`${retirementDestDir}/`)) {
      kept.push({ path: c.path, reason: `${c.reason}；引擎未执行：活跃产物（设计文档/impl-plan/同步产物目录）不退役` });
      continue;
    }
    if (!(await pathExists(src))) {
      kept.push({ path: c.path, reason: `${c.reason}；引擎未执行：候选路径不存在` });
      continue;
    }
    const base = src.split("/").pop() ?? "";
    if (base === "") {
      kept.push({ path: c.path, reason: `${c.reason}；引擎未执行：候选路径无文件名` });
      continue;
    }
    const dest = `${retirementDestDir}/${base}`;
    if (await pathExists(dest)) {
      kept.push({ path: c.path, reason: `${c.reason}；引擎未执行：目标已存在同名文件（${rel(dest)}）` });
      continue;
    }
    // 历史清理条目已 deferred = fixer 裁决「该引用须原样保留」（合法存证）——引用存在
    // 不阻断移动（决定权在内容判断），该引用随移动悬空、随终态 deferred 呈报，从退役
    // 目录 README 可找回。否则每轮重扫都会再命中，deferred 裁决被空转绕过
    const priorDeferred = [...retireCleanupTargets.entries()].some(
      ([fid, t]) => t.src === src && ledgerById(fid)?.status === "deferred",
    );
    let hits: string[] = [];
    if (!priorDeferred) {
      const hitsRaw = await scanRetireRefs(base);
      if (hitsRaw === null) {
        // 扫描异常 ≠ 无引用：不是保留（那是否决）、不是清理（证据缺失）——保守保留本轮
        // + 人工复核（基础设施故障不进修复循环空转）
        kept.push({ path: c.path, reason: `${c.reason}；引擎未执行：引用扫描 git grep 异常——保守保留待人工复核` });
        continue;
      }
      hits = hitsRaw.filter((h) => {
        const f = h.split(":")[0] ?? "";
        return !candSrcs.has(pathUnderRoot(f));
      });
    }
    if (hits.length > 0) {
      cleanups.push({ src, base, dest, hits, reason: c.reason });
      continue;
    }
    // 执行移动：tracked → git mv（失败降级 rm --cached + rename）；untracked → rename
    const tracked = await world.run("git", ["-C", projectRoot, "ls-files", "--error-unmatch", "--", rel(src)]);
    if (tracked.exitCode === 0) {
      const mv = await world.run("git", ["-C", projectRoot, "mv", "--", rel(src), rel(dest)]);
      if (mv.exitCode === 0) {
        movedTracked = true;
      } else {
        const rm = await world.run("git", ["-C", projectRoot, "rm", "--cached", "--", rel(src)]);
        const rn = await world.run("node", ["-e", NODE_RENAME_FILE, src, dest]);
        if (rm.exitCode === 0 && rn.exitCode === 0) {
          movedTracked = true;
        } else {
          kept.push({ path: c.path, reason: `${c.reason}；引擎未执行：移动失败（git mv exit ${mv.exitCode}，降级 rm=${rm.exitCode}/rename=${rn.exitCode}）` });
          continue;
        }
      }
    } else {
      const rn = await world.run("node", ["-e", NODE_RENAME_FILE, src, dest]);
      if (rn.exitCode !== 0) {
        kept.push({ path: c.path, reason: `${c.reason}；引擎未执行：文件移动失败（exit ${rn.exitCode}）` });
        continue;
      }
    }
    retired.push({ from: rel(src), to: rel(dest) });
    log(`退役：${rel(src)} → ${rel(dest)}`);
    // 反向复验：移动后残留引用告警（引用先清理后移动的正常路径应为零；命中 = 清理对账
    // 与事实矛盾或新引用，人工复核）
    const post = await scanRetireRefs(base);
    if (post !== null) {
      const postHits = post.filter((h) => {
        const f = h.split(":")[0] ?? "";
        return !pathUnderRoot(f).startsWith(`${retirementDestDir}/`);
      }).length;
      if (postHits > 0) log(`WARN: 退役 ${base} 后仍有 ${postHits} 处文件名词干引用（清理对账与事实矛盾或移动后新增，复核：${post.slice(0, 3).join("、")}）`);
    } else {
      log(`WARN: 退役 ${base} 后反向复验 git grep 异常——无法确认无残留引用，人工复核`);
    }
  }
  if (cleanups.length > 0) {
    // 清理条目（复用 FindingRecord 结构走既有修复循环：分组派发 fixer → 范围声明核验 → 组
    // 提交 → 下轮机器对账「词干零命中 = fixed」）；fixer 裁决引用须原样保留 → deferred
    // 终态呈报，下轮收敛时该候选跳过重扫直接移动
    const findings: FindingRecord[] = [];
    let seq = seqStart;
    for (const cu of cleanups) {
      const id = `F${round}-${seq}`;
      const firstHit = cu.hits[0] ?? "";
      const locParts = firstHit.split(":");
      findings.push({
        id,
        owner: "retire-cleanup",
        location: locParts.length >= 2 ? `${locParts[0]}:${locParts[1]}` : cu.base,
        gap: `退役候选 ${rel(cu.src)} 全仓仍有 ${cu.hits.length} 处引用（${cu.hits.slice(0, 5).map((h) => h.split(":").slice(0, 2).join(":")).join("、")}${cu.hits.length > 5 ? " 等" : ""}）——逐处改指取代它的新文档（判定依据：${cu.reason}）或删除过时引用；若核实为必须原样指向的合法存证，放入 deferred 并说明`,
        direction: "doc-right",
        severity: "must-fix",
        impact: "退役移动的前置清理——未清即移动会产生悬空引用",
        rationale: cu.reason,
        fixHint: `更新或删除对 ${cu.base} 的全部引用（改指新版文档，或改指退役目录 ${rel(cu.dest)}）；修后全仓不应再命中该词干`,
        firstSeen: round,
        status: "open",
      });
      retireCleanupTargets.set(id, { src: cu.src, base: cu.base });
      seq += 1;
    }
    log(`第 ${round} 轮收敛，但 ${cleanups.length} 个退役候选仍有引用——转清理条目（${findings.map((f) => f.id).join("、")}）进下轮修复，清零后执行移动`);
    return { kind: "cleanup", findings, next: seq };
  }
  if (movedTracked) {
    // --only + pathspec：只提交退役移动的文件，不卷入 index 预存 staged 内容
    const retireRels = retired.map((r) => r.from);
    const cm = await world.run("git", ["-C", projectRoot, "commit", "--only", "-m", "chore: retire superseded design artifacts (design-code-sync)", "--", ...retireRels]);
    if (cm.exitCode !== 0) {
      finalResult = finish(
        "retire-failure",
        round,
        `退役移动已执行但收尾 commit 失败（exit ${cm.exitCode}）：${(cm.stderr !== "" ? cm.stderr : cm.stdout).trim()}。恢复动作：人工检查 git index（退役删除已 staged）后重试 commit`,
      );
      return { kind: "failure" };
    }
  }
  // 退役目录 README 索引（老 skill [MANDATORY]：文件名/日期/依据/找回方式——找回不只靠 final.json）
  if (retired.length > 0 || kept.length > 0) {
    try {
      const readmeLines = [
        "# 退役设计文档索引",
        "",
        `基线 HEAD：${headHash.slice(0, 12)}（日期见 git log）；来源：design-code-sync-loop（终态同步退役判定）`,
        "",
        "| 原路径 | 退役后路径 | 依据 |",
        "|--------|-----------|------|",
        ...retired.map((r) => `| ${r.from} | ${r.to} | 见 final.json retirement 字段与 runDir 留档 |`),
        ...(kept.length > 0 ? ["", "## 保留项（未退役）", "", ...kept.map((k) => `- ${k.path}：${k.reason}`)] : []),
      ];
      const wr = await world.run("node", [
        "-e",
        "require('fs').mkdirSync(process.argv[1],{recursive:true});require('fs').writeFileSync(process.argv[2],process.argv[3])",
        retirementDestDir,
        `${retirementDestDir}/README.md`,
        readmeLines.join("\n"),
      ]);
      if (wr.exitCode !== 0) log(`WARN: 退役 README 索引写盘失败（exit ${wr.exitCode}）——找回信息仍完整保留在 final.json retirement 字段`);
    } catch (e) {
      log(`WARN: 退役 README 索引写盘异常（${String(e)}）——找回信息仍完整保留在 final.json retirement 字段`);
    }
  }
  const ds = {
    docRight: ledger.filter((f) => f.direction === "doc-right").length,
    codeRight: ledger.filter((f) => f.direction === "code-right").length,
    contested: ledger.filter((f) => f.direction === "contested").length,
  };
  const sugContested = ledger.filter((f) => f.direction === "contested" && f.severity !== "must-fix");
  finalNote = `converged（R${round} 确认 0 活跃条目）`;
  const msg = [
    `终态同步收敛（第 ${round} 轮确认 0 活跃条目）；矩阵与收敛轨迹：${matrixFile}`,
    `方向分布 doc-right ${ds.docRight} / code-right ${ds.codeRight} / contested ${ds.contested}`,
    `退役 ${retired.length} / 保留 ${kept.length}${sugContested.length > 0 ? `；contested 非 must-fix 级 ${sugContested.length} 条已按 doc-right 默认修复并记录（见 contestedList）` : ""}`,
  ].join("；");
  finalResult = { ...finish("converged", round, msg), retirement: { retired, kept } };
  return { kind: "done" };
}

async function commitGroupFiles(round: number, gid: string, count: number, files: string[]): Promise<void> {
  const staged: string[] = [];
  const skipped: string[] = [];
  for (const p of files) {
    if (!(await pathExists(p))) {
      skipped.push(p);
      continue;
    }
    // projectRoot 外的文件（skill-data 产物已迁 HOME 下，如设计文档/impl-plan）：不属于本仓，
    // git add 会报 repo 外错误——留盘即可（HOME 下天然不入 git），语义与 gitignore 产物一致
    if (!p.startsWith(`${projectRoot}/`)) {
      log(`  ${gid}: ${p} 在 projectRoot 外（skill-data 产物），留盘不入 commit`);
      continue;
    }
    // gitignore 产物（存量 .tmp 产物等）留盘不提交
    const ig = await world.run("git", ["-C", projectRoot, "check-ignore", "--", p]);
    if (ig.exitCode === 0) {
      log(`  ${gid}: ${rel(p)} 属 gitignore 产物，改动留盘不入 commit`);
      continue;
    }
    const a = await world.run("git", ["-C", projectRoot, "add", "--", p]);
    if (a.exitCode === 0) staged.push(p);
    else skipped.push(p);
  }
  if (skipped.length > 0) {
    log(`WARN: ${gid} 跳过 ${skipped.length} 条（不存在/add 失败，改动留工作区）：${skipped.map((p) => rel(p)).join("、")}`);
  }
  if (staged.length === 0) {
    log(`  ${gid}: 无可提交文件（改动均在 gitignore 产物或为空）——不 commit`);
    return;
  }
  // 路径限定（沿 W2 GIT_ADD_COMMIT 惯例）：--only + pathspec 把提交面钉死在本组文件——
  // 预检对脏工作区仅 WARN 不阻断，无 pathspec 时 index 里预存 staged 内容会被卷入组 commit，
  // 且 diff --cached 判定也会被预存 staged 干扰
  const rels = staged.map((p) => rel(p));
  const has = await world.run("git", ["-C", projectRoot, "diff", "--cached", "--quiet", "--", ...rels]);
  if (has.exitCode === 0) {
    log(`  ${gid}: staged 内容与 HEAD 无差异——不 commit`);
    return;
  }
  const msg = `fix: design-code-sync R${round} ${gid} (${count} findings)`;
  const c = await world.run("git", ["-C", projectRoot, "commit", "--only", "-m", msg, "--", ...rels]);
  if (c.exitCode !== 0) {
    throw new Error(
      `组 ${gid} git commit 失败（exit ${c.exitCode}）：${(c.stderr !== "" ? c.stderr : c.stdout).trim()}。改动已 staged 未提交。恢复动作：人工检查 git index 后重试 commit 或接管`,
    );
  }
  log(`  ${gid}: commit（${staged.length} 文件）`);
}

log(`design-code-sync-loop 启动：runDir=${runDir}（attempt=${attempt}），基线 HEAD=${headHash.slice(0, 12)}，maxRounds=${maxRounds}`);

// planner agent（两级拓扑第一级，R1 创建并 ask；R2+ 聚焦复审续聊同一上下文——
// 循环外顶层声明保证跨轮引用）
const plannerAgent = agent("框架对照规划", PLANNER_PERSONA);

let finalResult: SyncResult | null = null;
let prevActiveMust = 0;
let stallStreak = 0;

for (let round = 1; round <= maxRounds && finalResult === null; round++) {
  const roundDir = `${runDir}/${roundDirName(round)}`;
  let seq = 1;
  const rowsBefore = matrixRowsRec.length;
  const findingsBefore = ledger.length;

  if (round === 1) {
    // ── phase 1：framework-scan（R1 才做，R2+ 跳过）──
    // phase 语境由启动段的「框架对照与模块规划」标记占据（顶层标记覆盖其后的顶层语句
    // 与本分支未再打标的步骤）
    let plan: PlannerResult | null = null;
    let planErr = "";
    try {
      plan = await askValidated(
        validatePlannerResult,
        (q) => plannerAgent.ask<PlannerResult>(q),
        plannerPromptText,
      );
      if (plan === null) throw new Error("返回不合规（结构/枚举/modules 空均回喂重试过）");
    } catch (e) {
      planErr = String(e);
    }
    if (plan === null) {
      finalResult = finish("planner-failure", round, `planner 返回无效（${planErr}，${STRUCTURED_RETRY_MAX} 次回喂重试后仍不合规）。恢复动作：检查模板 ${plannerTplAbs} ，${HINT_PLANNER_INVALID}`);
      break;
    }
    // 模块计划落地校验（机器闸门）：files 逐条验「projectRoot 内 + 磁盘存在」，不过回喂
    // 重产一次，仍不过走 planner-failure——必须在 auditJson/moduleById/fan-out 之前，
    // 留档与派发消费的都是过闸后的终版计划
    const gated = await gateModulePlanFiles(plan);
    if (!gated.ok) {
      finalResult = finish("planner-failure", round, `模块计划路径校验不过（${gated.error}）。恢复动作：核对 planner 输出的 modules.files（须为 ${projectRoot} 内既有文件），${HINT_PLANNER_INVALID}`);
      break;
    }
    plan = gated.plan;
    log(`第 ${round} 轮 framework-scan：框架发现 ${plan.frameworkFindings.length} 条，模块分解 ${plan.modules.length} 个${plan.modules.length === 1 ? "（单模块退化 = 单 reviewer）" : ""}`);
    await auditJson(`${roundDir}/planner.json`, JSON.stringify(plan, null, 2));
    moduleById = new Map(plan.modules.map((m) => [m.id, m]));
    // 框架级发现入台账：方向推断（模板无 direction 字段）——漏实现 = design 有 code 无 →
    // doc-right（补代码）；越权/其余（impl-plan 现实性/内部一致性/登记面/越权回写）→ code-right
    //（修文档侧）；「一致」行只进矩阵不立项；矩阵行直接进全量矩阵顶层。
    // overdesign = 过度/存疑 档入账即转候选卡呈报（§7.3：只报告不删码，不进修复循环）
    for (const ff of plan.frameworkFindings) {
      matrixRowsRec.push({ ...ff.matrixRow, overdesign: ff.matrixRow.overdesign, source: "框架（planner）", round });
      const verdict = ff.matrixRow.verdict;
      // od 检查先于「一致」短路：planner 同时报「一致」与「过度/存疑」的矛盾行信号更可疑，
      // 照常转候选卡并 WARN 标注矛盾（曾因一致 continue 在前被静默吞掉）
      const od = ff.matrixRow.overdesign ?? "";
      if (od.includes("过度") || od.includes("存疑")) {
        overdesignCandidates.push({
          id: `F${round}-${seq}`,
          location: ff.matrixRow.impl !== "" ? ff.matrixRow.impl : ff.matrixRow.claim,
          gap: `${ff.matrixRow.claim} ↔ ${ff.matrixRow.impl}`,
          reason: `框架三问初评「${od}」——候选卡：${ff.matrixRow.note}`,
        });
        if (verdict.includes("一致")) {
          log(`WARN: 框架行 ${ff.id} verdict=一致 但 overdesign=${od}——矛盾行，转候选卡供人工复核`);
        }
        log(`框架越权行初评「${od}」→ 候选卡呈报（不进修复循环，用户裁决后才动）`);
        seq += 1;
        continue;
      }
      if (verdict.includes("一致")) {
        seq += 1;
        continue;
      }
      // 「未评」= planner 畸形行（verdict 缺失被归一）——不立项进修复（方向判定无依据），
      // 只留矩阵行 + WARN 供人工复核（审查 P3-3：盲目 code-right 立项会误导修复）
      if (verdict === "未评") {
        log(`WARN: 框架行 ${ff.id}（${ff.matrixRow.claim.slice(0, 40)}…）verdict 缺失归一为「未评」——不立项，人工复核矩阵`);
        seq += 1;
        continue;
      }
      ledger.push({
        id: `F${round}-${seq}`,
        owner: "planner",
        location: ff.matrixRow.impl !== "" ? ff.matrixRow.impl : ff.matrixRow.claim,
        gap: `${ff.matrixRow.claim} ↔ ${ff.matrixRow.impl}`,
        direction: verdict.includes("漏") ? "doc-right" : "code-right",
        severity: ff.severity,
        impact: ff.matrixRow.note,
        rationale: "框架级对照（planner 域）",
        fixHint: ff.matrixRow.note,
        firstSeen: round,
        status: "open",
      });
      seq += 1;
    }

    // ── phase 1.5：机械信号步（§7.1 符号词表 grep，R1 一次；机器产确定性信号，
    //    severity/direction 语义判级归后续复核——机械对账见 R2+ 分支）──
    // 词源 = T3 符号词表（watchlist，语义甄别在词表产出时完成）；未传词表 → 整步跳过，
    // 不回退文档反引号抓取（旧抓取依赖「反引号 = 本项目符号」隐式约定，2026-09-27 废除）
    if (round === 1) {
      if (watchlist === "") {
        log("WARN: 未传 watchlist（符号词表）——机械信号步跳过，悬空引用防线本轮不生效。恢复动作：按 tech-design-wf flow/plan.md「符号词表」节产出 <basename>.symbol-watchlist.json 后，携 watchlist 参数重新发起");
      } else {
        phase("机械信号扫描");
        const implMdPath = implPlan.replace(/\.impl-plan\.json$/, ".impl-plan.md");
        const mechRes = await world.run("node", ["-e", NODE_BACKTICK_GREP, projectRoot, watchlist, designDoc, implMdPath]);
        if (mechRes.exitCode === 0) {
          try {
            const parsed: unknown = JSON.parse(mechRes.stdout);
            const rec = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
            if (rec["ok"] === true && isStrArr(rec["missing"])) {
              for (const sym of rec["missing"]) {
                ledger.push({
                  id: `F${round}-${seq}`,
                  owner: "mechanical",
                  location: `${designDoc}（词表符号 ${sym}）`,
                  gap: `词表符号 ${sym} 在代码库零命中（git grep）——文档引用悬空`,
                  direction: "code-right",
                  severity: "suggestion",
                  impact: "悬空引用误导后来者按图索骥找不到目标（[HISTORICAL] 事故防线）",
                  rationale: "机械信号：词表收录的符号在代码库不存在，默认实现期删改未回写文档",
                  fixHint: `核实 ${sym} 是否被删/改名——改文档引用到现存符号；若确认应补实现，改按 doc-right 处理；若核实为不该扫描的词（如上游包符号），申报 exempt 豁免`,
                  firstSeen: round,
                  status: "open",
                });
                seq += 1;
              }
              log(`机械信号：词表符号零命中 ${rec["missing"].length} 条立项（owner=mechanical，severity 默认 suggestion 待复核）`);
            } else if (rec["ok"] === false && typeof rec["reason"] === "string" && rec["reason"] !== "") {
              log(`WARN: 机械信号步跳过——${rec["reason"]}`);
            } else {
              log("WARN: 机械信号步输出解析失败——跳过机械立项（LLM 审查通道不受影响）");
            }
          } catch {
            log("WARN: 机械信号步输出解析失败——跳过机械立项（LLM 审查通道不受影响）");
          }
        } else {
          log(`WARN: 机械信号步执行失败（exit ${mechRes.exitCode}）——跳过，不阻断循环：${mechRes.stderr.trim().slice(0, 200)}`);
        }
      }
    }

    // ── phase 2：模块 fan-out（并行；modules 长度 1 = 单 reviewer 退化，零分支）──
    phase("并行模块审查");
    for (const m of plan.modules) moduleAgents.set(m.id, agent(`模块审查-${m.id}`, REVIEWER_PERSONA));
    const reviews: { mid: string; res: ModuleReview }[] = [];
    try {
      for (let i = 0; i < plan.modules.length; i += REVIEWER_BATCH) {
        const batch = plan.modules.slice(i, i + REVIEWER_BATCH);
        log(`  模块审查批次 ${Math.floor(i / REVIEWER_BATCH) + 1}/${Math.ceil(plan.modules.length / REVIEWER_BATCH)}：${batch.map((m) => m.id).join("、")}`);
        const part = await Promise.all(
          batch.map(async (m) => {
            const a = moduleAgents.get(m.id);
            if (!a) throw new Error(`模块 agent 缺失：${m.id}`);
            const res = await askValidated(
              validateModuleReview,
              (q) => a.ask<ModuleReview>(q),
              reviewPrompt(m),
            );
            if (res === null) throw new Error(`模块 ${m.id} 结构化返回 ${STRUCTURED_RETRY_MAX} 次回喂重试仍不合规`);
            return { mid: m.id, res };
          }),
        );
        reviews.push(...part);
      }
    } catch (e) {
      finalResult = finish("review-failure", round, `模块审查 fan-out 失败：${String(e)}。恢复动作：按 runDir 各轮留档定位失败模块，attempt 递增重新发起`);
      break;
    }
    for (const { mid, res } of reviews) {
      const rows = normMatrixRows(res.matrixRows, `模块 ${mid}`, round);
      matrixRowsRec.push(...rows);
      collectModuleOverdesign(rows, round);
      const nf = normFindings(res.findings, mid, round, seq);
      seq = nf.next;
      ledger.push(...nf.findings);
      const noNote = asStr(res.moduleNoFinding);
      if (nf.findings.length === 0 && noNote === "") {
        log(`WARN: 模块 ${mid} 零发现且未按模板显式声明 moduleNoFinding（模板验收要求）——按零发现处理`);
      }
      await auditJson(`${roundDir}/module-${mid}.json`, JSON.stringify(res, null, 2));
    }
  } else {
    // ── R2+：聚焦复审（同 agent 续聊，只审上轮修复影响面）──
    phase("聚焦复审");
    // 机械条目（owner=mechanical）不走 LLM 复审——引擎机械对账：重跑机械步，
    // 上轮机械条目的符号已不在悬空清单 = 修好（fixed）；仍悬空 = 保留 open 进下轮修复组
    const mechPrev = lastDispatchedIds
      .map((id) => ledgerById(id))
      .filter((f): f is FindingRecord => f !== undefined && f.owner === "mechanical" && f.status === "open");
    if (mechPrev.length > 0) {
      const implMdRe = implPlan.replace(/\.impl-plan\.json$/, ".impl-plan.md");
      const mv = await world.run("node", ["-e", NODE_BACKTICK_GREP, projectRoot, designDoc, implMdRe]);
      let stillMissing: Set<string> | null = null; // null = 机械步失败/输出不可解析 → 本轮不对账
      if (mv.exitCode === 0) {
        try {
          const arr: unknown = JSON.parse(mv.stdout);
          if (Array.isArray(arr)) stillMissing = new Set(arr.filter((x): x is string => typeof x === "string"));
        } catch {
          // 输出不可解析 → 保持 null，整批保留 open 下轮再验（空集会让全部条目被误判 fixed——
          // 审查 P0 修正：失败路径绝不假清账）
        }
      }
      if (stillMissing !== null) {
        for (const f of mechPrev) {
          const mSym = /词表符号 (\S+) 在代码库/.exec(f.gap);
          const sym = mSym?.[1] ?? "";
          if (sym !== "" && !stillMissing.has(sym)) {
            f.status = "fixed";
            f.fixedRound = round;
          }
        }
        log(`机械条目对账：${mechPrev.length} 条中 ${mechPrev.filter((f) => f.status === "fixed").length} 条已清（重跑机械步验证）`);
      } else {
        log(`WARN: 机械步重跑失败/输出不可解析——${mechPrev.length} 条机械条目本轮不对账，全部保留 open 下轮再验`);
      }
    }
    // 退役引用清理条目（owner=retire-cleanup）不走 LLM 复审——引擎机械对账（同 mechanical
    // 模式）：重扫该候选词干，全仓零命中 = 修好（fixed）；仍命中 = 保留 open 下轮重派
    const retirePrev = lastDispatchedIds
      .map((id) => ledgerById(id))
      .filter((f): f is FindingRecord => f !== undefined && f.owner === "retire-cleanup" && f.status === "open");
    if (retirePrev.length > 0) {
      for (const f of retirePrev) {
        const t = retireCleanupTargets.get(f.id);
        if (t === undefined) {
          log(`WARN: 清理条目 ${f.id} 无退役候选登记（状态不一致）——保留 open 人工复核`);
          continue;
        }
        const hits = await scanRetireRefs(t.base);
        if (hits === null) {
          log(`WARN: 清理条目 ${f.id} 对账扫描异常——本轮不对账，保留 open 下轮再验`);
          continue;
        }
        const ext = hits.filter((h) => {
          const hf = h.split(":")[0] ?? "";
          return !pathUnderRoot(hf).startsWith(`${retirementDestDir}/`);
        });
        if (ext.length === 0) {
          f.status = "fixed";
          f.fixedRound = round;
        }
      }
      log(`退役清理条目对账：${retirePrev.length} 条中 ${retirePrev.filter((f) => f.status === "fixed").length} 条已清（词干重扫零命中）`);
    }
    const owners = [...new Set(lastDispatchedIds.map((id) => ledgerById(id)?.owner ?? "").filter((o) => o !== "" && o !== "mechanical" && o !== "retire-cleanup"))];
    if (owners.length === 0 && mechPrev.length === 0 && retirePrev.length === 0 && lastDispatchedIds.length > 0) {
      // 防御：lastDispatchedIds 中存在 LLM/mech/清理条目（非 deferred）但 owner 全部解析失败 = 状态
      // 不一致，诚实终止（不假收敛）。全 defer 场景 lastDispatchedIds 已被过滤为空，不触发。
      finalResult = finish("fix-failure", round, "上轮有修复派发但条目归属丢失（状态不一致）。恢复动作：按 runDir 各轮留档对账后重新发起");
      break;
    }
    const reviews: { owner: string; res: ModuleReview }[] = [];
    try {
      for (let i = 0; i < owners.length; i += REVIEWER_BATCH) {
        const batch = owners.slice(i, i + REVIEWER_BATCH);
        const part = await Promise.all(
          batch.map(async (owner) => {
            const a = owner === "planner" ? plannerAgent : moduleAgents.get(owner);
            if (!a) throw new Error(`聚焦复审 agent 缺失：${owner}`);
            const scopeFindings = lastDispatchedIds
              .map((id) => ledgerById(id))
              .filter((f): f is FindingRecord => f !== undefined && f.owner === owner);
            const mm = owner !== "planner" ? moduleById.get(owner) : undefined;
            const res = await askValidated(
              validateModuleReview,
              (q) => a.ask<ModuleReview>(q),
              [
                r2PrevContextBlock(owner, mm, projectRoot, designDoc, implPlan, headHash, plannerTplAbs, reviewerTplAbs, rel),
                reReviewPrompt(round, scopeFindings),
              ]
                .filter(Boolean)
                .join("\n\n"),
            );
            if (res === null) throw new Error(`聚焦复审（${owner}）结构化返回 ${STRUCTURED_RETRY_MAX} 次回喂重试仍不合规`);
            return { owner, res };
          }),
        );
        reviews.push(...part);
      }
    } catch (e) {
      finalResult = finish("review-failure", round, `聚焦复审失败：${String(e)}。恢复动作：按 runDir 各轮留档定位失败归属，attempt 递增重新发起`);
      break;
    }
    let confirmed = 0;
    for (const { owner, res } of reviews) {
      // 对账套用：fixed 须有实证（verify-first）；not-fixed/regressed 保持 open（停机线承接）
      for (const r of normRecon(res.reconciliation)) {
        const f = ledgerById(r.prevId);
        if (f && f.owner === owner && r.status === "fixed" && r.evidence.trim() !== "") {
          f.status = "fixed";
          f.fixedRound = round;
          confirmed += 1;
        }
      }
      const rows = normMatrixRows(res.matrixRows, owner === "planner" ? "框架（planner）" : `模块 ${owner}`, round);
      matrixRowsRec.push(...rows);
      collectModuleOverdesign(rows, round);
      const nf = normFindings(res.findings, owner, round, seq);
      seq = nf.next;
      ledger.push(...nf.findings);
      await auditJson(`${roundDir}/module-${owner === "planner" ? "plan" : owner}.json`, JSON.stringify(res, null, 2));
    }
    log(`第 ${round} 轮聚焦复审：确认修复 ${confirmed} 条，新立项 ${ledger.length - findingsBefore} 条`);
  }
  if (finalResult !== null) break;

  // ── 矩阵合并落盘（脚本 concat，无 LLM 聚合层；contested 分流前保证矩阵已落盘）──
  let active = ledger.filter((f) => f.status === "open");
  let activeMust = active.filter((f) => f.severity === "must-fix").length;
  try {
    await persistArtifacts();
  } catch (e) {
    finalResult = finish("io-failure", round, String(e));
    break;
  }

  // ── contested 分流（2026-09-26 用户裁决，同依赖可达性原则）：must-fix 级方向争议
  // 按「是否 block 后续」处置——争议条目编辑集与其余待修条目编辑集相交 = block
  //（并行修复会撞同文件）→ 立即停回用户裁决；不相交 = 冻结该条目（status=frozen：
  // 不修、不参与收敛计数），其余条目照常修复，全部执行完随终态汇报争议清单 ──
  const contestedMust = active.filter((f) => f.direction === "contested" && f.severity === "must-fix");
  // 停机终态轮也入收敛轨迹（此前 contested/stuck 尾轮缺数据点，轨迹断在修复轮）
  const pushStopRoundStat = (): void => {
    roundsHist.push({
      round,
      rowsNew: matrixRowsRec.length - rowsBefore,
      findingsNew: ledger.length - findingsBefore,
      mustActive: activeMust,
      sugActive: active.filter((f) => f.severity === "suggestion").length,
      infoActive: active.filter((f) => f.severity === "info").length,
      contestedActive: active.filter((f) => f.direction === "contested").length,
      fixGroups: 0,
    });
  };
  if (contestedMust.length > 0) {
    const contestedFiles = new Set(contestedMust.flatMap((f) => findingEditFiles(f)));
    const others = active.filter((f) => f.direction !== "contested" || f.severity !== "must-fix");
    const blocksOthers = others.some((f) => findingEditFiles(f).some((p) => contestedFiles.has(p)));
    if (blocksOthers) {
      pushStopRoundStat();
      finalNote = `contested（R${round}）：must-fix 级方向争议 ${contestedMust.length} 条与待修条目编辑文件相交（阻塞后续修复）`;
      try {
        await persistArtifacts();
      } catch {
        // 矩阵本轮已落盘过，终态标注写失败不改变拦截语义
      }
      log(`第 ${round} 轮：must-fix 级方向争议 ${contestedMust.length} 条（${contestedMust.map((f) => f.id).join("、")}）——与待修条目编辑文件相交（block），立即停回用户裁决`);
      finalResult = finish(
        "contested",
        round,
        `must-fix 级方向争议 ${contestedMust.length} 条与待修条目编辑文件相交（阻塞后续修复），停回用户裁决（doc-right/code-right 二选一或给出裁决理由），矩阵与证据见 ${matrixFile}。恢复动作：用户逐条裁决后重新发起（runDir 自动 attempt 后缀不覆盖历史；重发起首轮为 planner 全量重审，上轮修复在重审对账中确认）`,
      );
      break;
    }
    for (const f of contestedMust) f.status = "frozen";
    log(`第 ${round} 轮：must-fix 级方向争议 ${contestedMust.length} 条（${contestedMust.map((f) => f.id).join("、")}）——编辑集与其余条目不相交，冻结不修（随终态 contestedList 呈报），其余条目继续修复`);
    // 冻结条目退出活跃集：后续收敛判定 / 停机线 / 修复派发均按重算后的 active
    active = ledger.filter((f) => f.status === "open");
    activeMust = active.filter((f) => f.severity === "must-fix").length;
  }

  // ── 全清判定（R1 零发现或 R2+ 全部确认且无新立项；冻结争议另走 contested 终态）──
  if (active.length === 0) {
    roundsHist.push({
      round,
      rowsNew: matrixRowsRec.length - rowsBefore,
      findingsNew: ledger.length - findingsBefore,
      mustActive: 0,
      sugActive: 0,
      infoActive: 0,
      contestedActive: 0,
      fixGroups: 0,
    });
    const frozenContested = ledger.filter((f) => f.status === "frozen");
    if (frozenContested.length > 0) {
      // 非争议条目已全部修复收敛；冻结争议不阻塞（编辑集不相交已判），随终态汇报
      finalNote = `contested（R${round}）：非争议条目已全部修复收敛；must-fix 级方向争议 ${frozenContested.length} 条冻结待用户裁决`;
      try {
        await persistArtifacts();
      } catch {
        // 矩阵本轮已落盘过，终态标注写失败不改变终态语义
      }
      finalResult = finish(
        "contested",
        round,
        `非争议条目已全部修复收敛；must-fix 级方向争议 ${frozenContested.length} 条冻结待用户裁决（doc-right/code-right 二选一或给出裁决理由），清单随终态 contestedList，矩阵与证据见 ${matrixFile}。恢复动作：用户逐条裁决后重新发起（重发起首轮为 planner 全量重审，已修部分在重审对账中确认）`,
      );
      break;
    }
    // 退役闭环在收敛点执行：判定 agent 独立判定 → 有引用未清理 → 转清理条目回下轮
    // 修复（continue，不 break）；清零（或命中已被 deferred 裁决保留）→ 执行移动并构造
    // converged 终态。终态构造（含 retirement 结果）在 retireClosure 内完成
    const rc = await retireClosure(round, seq);
    if (rc.kind === "cleanup") {
      seq = rc.next;
      ledger.push(...rc.findings);
      continue;
    }
    break;
  }

  // ── 停机线（设计 §7）：must-fix 连续 N 轮不降 / 单条活跃超 N 轮 → stuck（清单随终态）──
  stallStreak = activeMust > 0 && activeMust >= prevActiveMust ? stallStreak + 1 : 0;
  prevActiveMust = activeMust;
  const perFindingStuck = active.filter(
    (f) => f.severity === "must-fix" && round - f.firstSeen >= STUCK_PER_FINDING_ROUNDS,
  );
  if (perFindingStuck.length > 0) {
    pushStopRoundStat();
    finalNote = `stuck（R${round}）：单条条目超 ${STUCK_PER_FINDING_ROUNDS} 轮未收敛`;
    try {
      await persistArtifacts();
    } catch {
      // 见上：不改变终止语义
    }
    finalResult = finish(
      "stuck",
      round,
      `单条条目超过 ${STUCK_PER_FINDING_ROUNDS} 轮未收敛（${perFindingStuck.map((f) => f.id).join("、")}）——残余差距矩阵见 ${matrixFile}，呈报用户裁决`,
    );
    break;
  }
  if (stallStreak >= STUCK_STALL_ROUNDS) {
    pushStopRoundStat();
    finalNote = `stuck（R${round}）：must-fix 连续 ${stallStreak} 轮不降`;
    try {
      await persistArtifacts();
    } catch {
      // 见上：不改变终止语义
    }
    finalResult = finish(
      "stuck",
      round,
      `must-fix 连续 ${stallStreak} 轮不收敛——残余差距矩阵见 ${matrixFile}，呈报用户裁决`,
    );
    break;
  }

  // ── 修复：分组（模块 files 并集候选组 → reconcileGroups 机器校验）→ 并行双向修复 →
  //     范围声明核验 → 组级一笔 commit ──
  phase("并行修复与复审");
  const groups = reconcileGroups(
    buildCandidateGroups(active),
    active.map((f) => ({ id: f.id, files: findingEditFiles(f) })),
  );
  log(`第 ${round} 轮修复分 ${groups.length} 组：${groups.map((g) => `${g.id}(${g.issueIds.length}条)`).join("、")}`);
  const activeById = new Map(active.map((f) => [f.id, f] as const));
  const roundFixes: FixRecord[] = [];
  // ── 修复环 run 内自愈（2026-10-03）：ES 语义覆盖违规不终止 run，回喂纠正至多 FIX_SELFHEAL_MAX 次 ──
  // 镜像 askValidated 的回喂形态（错误清单回灌 + 全量重报），但作用在语义层：fixer 申报的四桶
  // 覆盖面与分组任务不符时，把违规清单 + 上轮申报原样回灌；纠正轮 agent 是新实例（pi 无同名
  // 续聊保证），故纠正 brief 必须自包含。纠正耗尽仍违规 → 维持原 fail-fast（接管协议为最后
  // 兜底）。与 attempt 重发起的区别：纠正发生在组内状态新鲜时（在途编辑就是本组 fixer 的产物，
  // 无跨 run 对账成本），attempt 是跨 run 兜底而非常规路径。
  const FIX_SELFHEAL_MAX = 2;
  function esCheckGroup(g: FixGroup, o: FixOutcome): string[] {
    const es: string[] = [];
    const ids = new Set(o.fixes.map((fx) => fx.issueId));
    const defIds = new Set(o.deferred.map((d) => d.issueId));
    const exemptIds = new Set(o.exempt.map((d) => d.issueId));
    const dlgIds = new Set(o.delegated.map((d) => d.issueId));
    for (const fid of g.issueIds) {
      if (!ids.has(fid) && !defIds.has(fid) && !exemptIds.has(fid) && !dlgIds.has(fid)) es.push(`漏修 ${fid}`);
    }
    for (const fx of o.fixes) {
      if (!g.issueIds.includes(fx.issueId)) es.push(`fixes 引用未知条目 ${fx.issueId}`);
    }
    for (const d of o.deferred) {
      if (!g.issueIds.includes(d.issueId)) es.push(`deferred 引用未知条目 ${d.issueId}`);
      // 互斥（审查 P3-2）：同 id 既在 fixes 又在 deferred = fixer 矛盾输出——该条的修复
      // 已执行且被 commit 却被标 deferred 退出复审对账，修复无验证，拒绝
      if (ids.has(d.issueId)) es.push(`条目 ${d.issueId} 同时出现在 fixes 与 deferred（矛盾输出）`);
      if (exemptIds.has(d.issueId)) es.push(`条目 ${d.issueId} 同时出现在 deferred 与 exempt（矛盾输出）`);
    }
    for (const d of o.exempt) {
      if (!g.issueIds.includes(d.issueId)) es.push(`exempt 引用未知条目 ${d.issueId}`);
      if (ids.has(d.issueId)) es.push(`条目 ${d.issueId} 同时出现在 fixes 与 exempt（矛盾输出）`);
      if (d.reason.trim() === "") es.push(`exempt 条目 ${d.issueId} 缺豁免理由`);
    }
    for (const d of o.delegated) {
      if (!g.issueIds.includes(d.issueId)) es.push(`delegated 引用未知条目 ${d.issueId}`);
      if (ids.has(d.issueId)) es.push(`条目 ${d.issueId} 同时出现在 fixes 与 delegated（矛盾输出）`);
      if (defIds.has(d.issueId)) es.push(`条目 ${d.issueId} 同时出现在 deferred 与 delegated（矛盾输出）`);
      if (exemptIds.has(d.issueId)) es.push(`条目 ${d.issueId} 同时出现在 exempt 与 delegated（矛盾输出）`);
    }
    return es;
  }
  async function askFixOutcomeSelfHeal(
    g: FixGroup,
    activeById: Map<string, FindingRecord>,
    round: number,
  ): Promise<{ g: FixGroup; o: FixOutcome }> {
    const basePrompt = fixerPrompt(g, activeById);
    let prompt = basePrompt;
    for (let i = 0; ; i++) {
      // 纠正轮实例名带 -cN 后缀：避免与首发实例同名（宿主按名路由时防串实例）
      const name = i === 0 ? `同步修复-R${round}-${g.id}` : `同步修复-R${round}-${g.id}-c${i}`;
      // 构造外提（同 dev-consistency-loop 的 askValidated 调用方契约）：闭包只做 .ask()，
      // 防校验重试再入同名二次创建（zcode run 内同名即整 run 拒绝）
      const fixerAgent = agent(name, FIXER_PERSONA);
      const o = await askValidated(
        validateFixOutcome,
        (q) => fixerAgent.ask<FixOutcome>(q),
        prompt,
      );
      if (o === null) throw new Error(`组 ${g.id} fixer 结构化返回 ${STRUCTURED_RETRY_MAX} 次回喂重试仍不合规`);
      const norm = normFixOutcome(o, projectRoot);
      const es = esCheckGroup(g, norm);
      if (es.length === 0) {
        if (i > 0) log(`  [fix-selfheal] 组 ${g.id} 第 ${i} 次纠正回喂后覆盖校验通过`);
        return { g, o: norm };
      }
      if (i >= FIX_SELFHEAL_MAX) {
        throw new Error(`ES 校验违规（自愈 ${FIX_SELFHEAL_MAX} 次纠正回喂后仍违规）：${g.id} ${es.join("；")}。恢复动作：检查 fixer 返回 issueId 引用；在途编辑已留工作区未提交，接管前先 git status 盘点`);
      }
      log(`  [fix-selfheal] 组 ${g.id} 申报覆盖违规（第 ${i + 1}/${FIX_SELFHEAL_MAX} 次纠正）：${es.join("；")}`);
      const buckets = (arr: { issueId: string }[]) => arr.map((x) => x.issueId).join("、") || "空";
      prompt = [
        basePrompt,
        "",
        `━━━ 自愈纠正（第 ${i + 1} 次申报）━━━`,
        `你上一轮的四桶申报未通过引擎覆盖校验，违规清单：`,
        ...es.map((e) => `- ${e}`),
        ``,
        `你上一轮的申报为：fixes=[${buckets(norm.fixes)}] deferred=[${buckets(norm.deferred)}] exempt=[${buckets(norm.exempt)}] delegated=[${buckets(norm.delegated)}]`,
        ``,
        `要求：`,
        `1. 你上一轮的实际编辑已留在工作区（未提交）——不要重复执行已声明的修复动作；`,
        `2. 先用工具核对工作树实际完成面（哪些条目已修、哪些缺口）；`,
        `3. 缺口条目现在补齐修复；或按四桶语义如实改报（deferred=越权删码申报 / exempt=符号豁免申报 / delegated=职责外申报，三桶均须 reason）；`,
        `4. 全量重新申报四桶（完整 JSON，不是增量补丁）——引擎将重新执行同一覆盖校验。`,
      ].join("\n");
    }
  }
  try {
    for (let i = 0; i < groups.length; i += FIXER_CONCURRENCY) {
      const batch = groups.slice(i, i + FIXER_CONCURRENCY);
      log(`  修复批次 ${Math.floor(i / FIXER_CONCURRENCY) + 1}/${Math.ceil(groups.length / FIXER_CONCURRENCY)}：${batch.map((g) => g.id).join("、")}`);
      const snapRes = await world.run("git", ["-C", projectRoot, "status", "--porcelain"]);
      if (snapRes.exitCode !== 0) {
        throw new Error(`git status 快照失败（exit ${snapRes.exitCode}）：${snapRes.stderr.trim()}`);
      }
      // 批前快照 = 脏文件集的内容指纹（不是状态码——批前已改文件被 fixer 再改后状态
      // 分类不变（M→M），状态码差分对它全盲；指纹直读内容，无论申报与否都被看见）
      const snapAbs = [...parsePorcelain(snapRes.stdout).keys()].map((f) => pathUnderRoot(f));
      const snapshot = await fingerprintFiles(snapAbs);
      const outcomes = await Promise.all(batch.map((g) => askFixOutcomeSelfHeal(g, activeById, round)));
      // 批级 ES 断言——逐组校验已前移进 askFixOutcomeSelfHeal 的 run 内自愈纠正环，
      // 此处退化为不变量防线：仅当自愈耗尽后由自愈函数自身抛出，理论恒过；保留以兜底
      // 未来改动破坏该不变式
      const es = outcomes.flatMap(({ g, o }) => esCheckGroup(g, o).map((v) => `${g.id} ${v}`));
      if (es.length > 0) {
        throw new Error(`ES 校验违规：${es.join("；")}。恢复动作：检查 fixer 返回 issueId 引用；在途编辑已留工作区未提交，接管前先 git status 盘点`);
      }
      // 范围声明核验：改动 ⊆ 组文件并集 ∪ 如实申报的 affectedFiles；无组认领 / 多组认领均为违规
      const curRes = await world.run("git", ["-C", projectRoot, "status", "--porcelain"]);
      if (curRes.exitCode !== 0) {
        throw new Error(`git status 复查失败（exit ${curRes.exitCode}）：${curRes.stderr.trim()}`);
      }
      // 批后指纹覆盖「批前 ∪ 批后」文件集：新增文件（批前无）与删除文件（批后无）经
      // 集合差捕获，两侧都在但内容变（含批前已改文件被改回与 HEAD 一致的「归零」修复）
      // 经指纹差捕获
      const curAbs = [...parsePorcelain(curRes.stdout).keys()].map((f) => pathUnderRoot(f));
      const union = [...new Set([...snapshot.keys(), ...curAbs])];
      const current = await fingerprintFiles(union);
      // 口径统一：指纹键为绝对路径，claims（组 files/affectedFiles）同为绝对路径直接比对
      const changed = new Set<string>();
      for (const p of union) {
        if (snapshot.get(p) !== current.get(p)) changed.add(p);
      }
      for (const { o } of outcomes) {
        for (const p of o.affectedFiles) {
          if (await pathExists(p)) changed.add(p);
        }
      }
      const claims = outcomes.map(({ g, o }) => ({ gid: g.id, files: new Set([...g.files, ...o.affectedFiles]) }));
      const attributed = new Map<string, string>();
      let unclaimed = 0;
      let conflicted = 0;
      for (const p of changed) {
        const owners = claims.filter((c) => c.files.has(p)).map((c) => c.gid);
        if (owners.length === 0) {
          // 无组认领：不提交留盘、不阻塞本批（2026-09-26 用户裁决——每个组只对自己的
          // 改动负责，无人认领的改动随终态 residualFiles 呈报主 agent 判归属处置）
          residualFiles.add(rel(p));
          unclaimed += 1;
        } else if (owners.length > 1) {
          // 多组认领（并行冲突）：提交任何一版都会丢另一组的工作——不提交留盘，
          // 相关条目经下轮聚焦复审自然重派对账，冲突文件随终态呈报人工合并
          residualFiles.add(`${rel(p)}（${owners.join("/")} 多组认领冲突）`);
          conflicted += 1;
        } else attributed.set(p, owners[0] ?? "");
      }
      if (unclaimed > 0 || conflicted > 0) {
        log(
          `WARN: 本批 ${unclaimed} 项无组认领 + ${conflicted} 项多组认领冲突——不提交留盘（认领唯一的各组照常提交），随终态 residualFiles 呈报`,
        );
      }
      // 组级一笔 commit（引擎执行，fixer 全程无 git 写）
      for (const { g, o } of outcomes) {
        roundFixes.push(...o.fixes);
        // defer 申报消费（§7.3 机器落点）：条目转 deferred 终态，不进聚焦复审对账，随终态呈报
        for (const d of o.deferred) {
          const f = activeById.get(d.issueId);
          if (f && f.status === "open") {
            f.status = "deferred";
            overdesignCandidates.push({ id: f.id, location: f.location, gap: f.gap, reason: d.reason });
            log(`条目 ${f.id} 被 fixer 申报 defer（越权候选防线）——转终态呈报，不执行删除`);
          }
        }
        // exempt 申报消费（2026-09-27 用户裁决）：fixer 核实机械条目指向的词不该被扫描
        // （典型 = 外部/上游包符号）→ 条目转 exempt 终态；登记文件 + exemptList 双落点，
        // 交主 agent 终审（fixer 的语义判断可被推翻：改词表后 attempt 递增重发）
        for (const d of o.exempt) {
          const f = activeById.get(d.issueId);
          if (f && f.status === "open") {
            const mSym = /词表符号 (\S+) 在代码库/.exec(f.gap);
            const word = mSym?.[1] ?? "";
            f.status = "exempt";
            exemptList.push({ id: f.id, word, reason: d.reason });
            log(`条目 ${f.id} 被 fixer 申报豁免（词「${word}」不该被扫描：${d.reason}）——转终态呈报主 agent 终审`);
          }
        }
        if (o.exempt.some((d) => activeById.get(d.issueId)?.status === "exempt")) {
          await writeArtifact(
            `${runDir}/exempted.json`,
            JSON.stringify({ note: "fixer 申报的符号豁免登记（主 agent 终审：认可则无动作，推翻则改词表后重发）", exempted: exemptList }, null, 2),
          );
        }
        // delegated 申报消费（2026-09-29 裁决）：条目属实但修复动作属其他职责域 → 置
        // delegated 终态不计活跃（防复审每轮重报空转到 stuck），随终态 delegatedList 呈报
        for (const d of o.delegated) {
          const f = activeById.get(d.issueId);
          if (f && f.status === "open") {
            f.status = "delegated";
            delegatedList.push({ id: f.id, location: f.location, reason: d.reason });
            log(`条目 ${f.id} 被 fixer 申报职责外（${d.reason}）——转终态呈报主 agent 重派或立项`);
          }
        }
        const files = [...attributed.entries()]
          .filter(([, gid]) => gid === g.id)
          .map(([p]) => p);
        await commitGroupFiles(round, g.id, g.issueIds.length, files);
        await auditJson(`${roundDir}/fixer-${g.id}.json`, JSON.stringify(o, null, 2));
      }
    }
  } catch (e) {
    finalResult = finish("fix-failure", round, `修复失败：${String(e)}`);
    break;
  }
  lastDispatchedIds = groups
    .flatMap((g) => g.issueIds)
    .filter((id) => {
      const st = ledgerById(id)?.status;
      return st !== "deferred" && st !== "exempt" && st !== "delegated"; // deferred/exempt/delegated 条目已转终态呈报，不进复审对账
    });
  lastFixRecords = roundFixes;
  roundsHist.push({
    round,
    rowsNew: matrixRowsRec.length - rowsBefore,
    findingsNew: ledger.length - findingsBefore,
    mustActive: activeMust,
    sugActive: active.filter((f) => f.severity === "suggestion").length,
    infoActive: active.filter((f) => f.severity === "info").length,
    contestedActive: active.filter((f) => f.direction === "contested").length,
    fixGroups: groups.length,
  });
}

// ── 轮次耗尽兜底（未收敛也未触发停机线；含退役清理轮把轮次烧尽的形态）──
if (finalResult === null) {
  finalNote = `stuck：轮次上限耗尽（${maxRounds} 轮）`;
  finalResult = finish(
    "stuck",
    maxRounds,
    `轮次上限耗尽（${maxRounds} 轮）仍未收敛——残余差距矩阵见 ${matrixFile}，呈报用户裁决`,
  );
}

// ── 收尾：终态标注落盘 + final.json（attempt 检测锚点）──
if (finalNote === "" && finalResult !== null) {
  finalNote = `${finalResult.terminated}（R${finalResult.rounds}）`;
}
try {
  await persistArtifacts();
} catch {
  log("WARN: 终态标注写盘失败（本轮矩阵此前已落盘，不影响终态数据）");
}
if (finalResult !== null) {
  // final.json 落盘（best-effort：失败只告警）——attempt 缺省检测锚点 = runDir 轮次目录
  // 扫描（attemptM 后缀 max+1；存在无后缀 round-* 或 final.json → 至少 attempt2 防覆盖
  // 首轮）；syncRoot 存在性兜底语义不受影响，round 目录后缀仍可由显式 args.attempt 可控
  await auditJson(finalJsonPath, JSON.stringify(finalResult, null, 2));
  // run.json（分析契约，skill-data-redesign §5.1）与 final.json 同批终态写出。
  // mustFixTrajectory = 逐轮活跃 must-fix 计数（roundsHist.mustActive 序列——该循环的
  // 终态同步语义口径）；baseCommit = null（终态同步审 HEAD 全量，无 diff 基线分界），
  // headCommit = 终态时点 HEAD（含本 run 修复组 commit）
  if (runStartedAt !== null) {
    const endRes = await world.run("node", ["-e", NODE_PROBE_NOW]);
    const gitRev = await gitRevProbe();
    await writeRunManifest({
      workflow: "design-code-sync-loop",
      segment: "dev-flow",
      host: HOST_PLATFORM,
      projectRoot,
      worktreePath: projectRoot,
      branch: gitRev.branch,
      baseCommit: null,
      headCommit: gitRev.head,
      attempt,
      model: null,
      startedAt: runStartedAt,
      endedAt: endRes.exitCode === 0 && endRes.stdout.trim() !== "" ? endRes.stdout.trim() : null,
      terminated: finalResult.terminated,
      rounds: finalResult.rounds,
      mustFixTrajectory: roundsHist.map((r) => r.mustActive),
    });
  } else {
    log("WARN: run.json 未落盘（startedAt 探针失败，防覆盖判据不可用）——终态数据以 final.json 与返回值为准");
  }
  // 终态写入 ledger（W4 终态全量已在 final.json——此处只记终态行 + 未决清单 + 指针，
  // 供主会话中断后从 skill-data dev-flow 段平铺档案直接恢复「哪些事待处置」）
  {
    const one = (s: string): string => (s.length > 80 ? `${s.slice(0, 80)}…` : s);
    const lgLines: string[] = [
      `终态 ${finalResult.terminated}（R${finalResult.rounds}，attempt ${attempt}）：${finalResult.message}`,
    ];
    if (finalResult.contestedList.length > 0)
      lgLines.push(
        `- [裁决] contested ${finalResult.contestedList.length} 项（must-fix 级方向争议，停回用户裁决）：${finalResult.contestedList.map((c) => `${c.id} ${c.location}——${one(c.gap)}`).join("；")}`,
      );
    if (finalResult.overdesignCandidates.length > 0)
      lgLines.push(
        `- [裁决] overdesignCandidates ${finalResult.overdesignCandidates.length} 项（用户裁决前不删码）：${finalResult.overdesignCandidates.map((c) => `${c.id} ${c.location}`).join("；")}`,
      );
    if (finalResult.exemptList.length > 0)
      lgLines.push(`- [待办] exemptList ${finalResult.exemptList.length} 项（主 agent 终审符号豁免申报）：${finalResult.exemptList.map((c) => `${c.id}「${c.word}」`).join("、")}`);
    if (finalResult.delegatedList.length > 0)
      lgLines.push(`- [待办] delegatedList ${finalResult.delegatedList.length} 项（职责外，主 agent 重派或立项）：${finalResult.delegatedList.map((c) => `${c.id} ${c.location}`).join("；")}`);
    if (finalResult.remaining.length > 0)
      lgLines.push(
        `- [待办] remaining 活跃条目 ${finalResult.remaining.length} 项（stuck/*-failure 在场，呈报用户）：${finalResult.remaining.map((c) => `${c.id} ${c.location}`).join("；")}`,
      );
    if (finalResult.residualFiles.length > 0)
      lgLines.push(`- [待办] 工作区残留改动 ${finalResult.residualFiles.length} 项（判归属后处置，禁静默丢弃）：${finalResult.residualFiles.join("、")}`);
    lgLines.push(`终态全量指针：${finalJsonPath}（final.json）/ 矩阵 ${matrixFile}`);
    await appendLedger(`W4 design-code-sync 终态 ${finalResult.terminated}（attempt ${attempt}）`, lgLines.join("\n"));
  }
}
if (finalResult === null) {
  // 不可达分支防御：所有路径都应已设置终态——保持「return 结构化对象」契约密闭
  finalResult = finish("io-failure", 0, "内部错误：终态未被设置（不可达分支防御）。恢复动作：附 runDir 留档重新发起");
}
return finalResult;

