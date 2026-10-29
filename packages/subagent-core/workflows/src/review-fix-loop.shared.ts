// review-fix-loop.shared.ts — review-fix-loop 双平台单源机制段（zcode / pi 产物共用）
//
// 单源纪律（对齐 zsw-skills build-workflows 管线）：本文件是唯一实现源，经
// scripts/build-review-fix-loop.mjs 拼进两侧产物——zcode 产物（.dwf.ts）原文拼接，
// pi 产物（review-fix-loop.js）经 TS 剥离后拼接。改本文件必须重跑构建，两产物
// 不得手改（--check 拦截漂移）。
//
// 形态约束：TS 子集（类型注解/interface/泛型可用，enum/namespace 禁用——
// transpileModule 剥离）；无 import/require（单文件自包含）；无字面 agent( 调用
// （平台 agent 形态差异经 ctx 注入，zcode GUI 泳道分析依赖壳内字面调用点）。
//
// 承载机制（2026-10-23 收编，源自空壳缺陷 + 补修子循环双版本漂移治理）：
// - inheritCarryoverFields / refreshTrackedFields：跨轮条目字段级安全合并
//   （空壳缺陷修复——wf-1792073055433：聚合器延续条目无 title/severity 时
//   旧 zcode 版无条件覆盖把已追踪字段抹成空壳，跨轮身份锚点断链）
// - contentRepairLoop：统一 commit 的 content 补修子循环（commit 被 pre-commit
//   拦截且恢复需改仓库内文件时：派补修 agent 按报错原文补全 → git status 快照
//   差集对账 → 显式路径 add → 重跑同一 commit，上限 maxRepairs 次）
// 设计依据：commit content 补修子循环 = 路线 B 数据流（2026-10-23 落地；原始登记文档已删，见 git 历史）。

/** 命令执行结果（平台注入统一形状：zcode 侧 world.run / pi 侧 execFileSync 包装） */
export interface CmdResult { // oe-exempt:20261023:framework:双平台单源契约/平台注入面——接口先立、单实现常态（zcode world.run 与 pi execFileSync 等差异经此边界注入）
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** 补修 agent 的结构化返回契约（两平台共享；校验在 isValidRepairReport 单点） */
export interface CommitRepairReport { // oe-exempt:20261023:framework:双平台单源契约/平台注入面——接口先立、单实现常态（zcode world.run 与 pi execFileSync 等差异经此边界注入）
  /** 补修涉及的全部文件，不只报错点名文件——供对账核对越权改动（与修复前后 git status 增量交叉验证，不一致以实际为准并披露） */
  repairedFiles: string[];
  /** 一句补修说明 */
  note: string;
}

/** content 补修子循环的结果。repaired = 重跑 commit 成功；其余三值均由调用方转 fix-failure 终态。 */
export interface ContentRepairResult { // oe-exempt:20261023:framework:双平台单源契约/平台注入面——接口先立、单实现常态（zcode world.run 与 pi execFileSync 等差异经此边界注入）
  outcome: "repaired" | "exhausted" | "unrepairable" | "invalid-return";
  tries: number;
  allRepairFiles: string[];
  note: string;
  lastErr: string;
  lastExitCode: number;
  /** unrepairable（补修 agent 空申报的说明）/ invalid-return（结构化非法的原因）补充信息 */
  why: string;
}

/** 平台注入面。壳（模板）负责装配；本文件不触碰平台 API。 */
export interface ContentRepairCtx { // oe-exempt:20261023:framework:双平台单源契约/平台注入面——接口先立、单实现常态（zcode world.run 与 pi execFileSync 等差异经此边界注入）
  /** 轮次标签（日志与 prompt 语境，如「第 3 轮」「Batch 1 round 3」） */
  roundLabel: string;
  /** 补修尝试上限（循环头判定；达上限返回 exhausted） */
  maxRepairs: number;
  /** 进入子循环前的报错原文（env 恢复后重跑仍败的那次，≤4000 截断） */
  initialErr: string;
  /** 进入子循环前那次 commit 的 exit code（终态文案用） */
  initialExitCode: number;
  /** 重跑同一条 commit（命令与参数与首次完全一致——zcode 侧 journal 重放确定性） */
  retryCommit(): Promise<CmdResult>;
  /** git add -- <paths>（补修文件必须进 staged：e2e-map 等登记门禁按 --staged 模式只查暂存内容） */
  stageFiles(paths: string[]): Promise<CmdResult>;
  /** git status --porcelain 解析后的脏路径数组（含脚本自持目录过滤） */
  dirtyPaths(): Promise<string[]>;
  /**
   * 单次补修 agent 调用。attemptNo = 当前尝试序号（1 起，agent 名带序号防同轮撞名）；
   * 返回结构化原始值（失败/异常由壳转 undefined，统一走 isValidRepairReport 校验路径）。
   * 同 attemptNo 的第二次调用（回注重试）在 zcode 壳 = 同一 agent 会话延续；pi 壳 =
   * 独立调用靠 prompt 回注——平台差异由壳消化。
   */
  askRepairAgent(attemptNo: number, prompt: string): Promise<unknown>;
  log(msg: string): void;
}

/** git status --porcelain 输出 → 路径数组。rename 行取新路径、剥引号包裹；
 *  过滤 .review/ 与 .tmp/（脚本自持目录——差集对账不得把脚本自产文件算作补修改动）。
 *  status 失败由壳在取 stdout 前抛错（commit 已跑通说明是有效 git 仓库，此处失败属异常，
 *  不静默折叠成空快照）。 */
export function parsePorcelain(out: string): string[] {
  return out
    .split("\n")
    .map((s) => s.trimEnd())
    .filter(Boolean)
    .map((line) => {
      let p = line.slice(3).trim().replace(/^"|"$/g, "");
      const arrow = p.indexOf(" -> ");
      if (arrow >= 0) p = p.slice(arrow + 4).trim().replace(/^"|"$/g, "");
      return p;
    })
    .filter((p) => !p.startsWith(".review/") && !p.startsWith(".tmp/"));
}

/** CommitRepairReport 字段级校验（repairedFiles 数组、note 非空字符串）。 */
export function isValidRepairReport(v: unknown): v is CommitRepairReport {
  return (
    typeof v === "object" && v !== null && Array.isArray((v as CommitRepairReport).repairedFiles) &&
    typeof (v as CommitRepairReport).note === "string" && (v as CommitRepairReport).note.trim() !== ""
  );
}

/** 不可信内容包裹（报错原文进 prompt 的注入隔离；格式与两版既有 wrapUntrusted 对齐）。 */
export function wrapUntrustedText(body: string): string {
  return [
    "<<<不可信内容 开始>>>",
    body,
    "<<<不可信内容 结束>>>",
  ].join("\n");
}

/** 补修 agent prompt（roundLabel 语境参数化；报错原文为恢复动作唯一权威源）。 */
export function buildRepairPrompt(roundLabel: string, errText: string, retryNote: string[]): string {
  return [
    `workflow review-fix-loop ${roundLabel}——修复改动统一 commit 被提交前自动检查（pre-commit）拦截，环境恢复后重试仍失败（content 类：恢复需要修改仓库内文件，报错写明了具体动作）。`,
    "你的职责 = 按报错写明的恢复动作完成内容补全（如补登记、补配套改动），使该 commit 重试可以通过。",
    "",
    "报错原文（权威源，恢复动作以它为准）：",
    wrapUntrustedText(errText),
    "",
    "要求：",
    "1. 只改报错原文写明的登记/配套文件（如 e2e-map 新增 rule、补 changeset 声明），恢复动作以报错原文为权威源；不碰其他文件，不改检查器本体。",
    "2. 报错原文没有写明可改文件的恢复动作时不要臆测——返回 repairedFiles 空数组并在 note 说明。",
    "3. 不 commit：工作流把补修文件 git add 后统一重试。",
    '4. 返回严格 JSON：{ "repairedFiles": ["<补修涉及的全部文件>"], "note": "<一句补修说明>" }——repairedFiles 列全部你实际改动的文件（不只报错点名文件，供对账核对越权）。',
    ...retryNote,
  ].join("\n");
}

/** content 补修子循环终态文案（fix-failure 信息全集：次数/文件/note/末次报错/staged 位置/env 回复末段）。 */
export function buildRepairFailureMessage(r: ContentRepairResult, envTail: string): string {
  const head =
    r.outcome === "invalid-return"
      ? `补修 agent 结构化返回非法（回注重试后仍无效：${r.why}）；`
      : r.outcome === "unrepairable"
        ? `补修 agent 判定不可修（repairedFiles 为空，说明：${r.why}）；`
        : "";
  return (
    `${head}统一 git commit 补修 ${r.tries} 次仍被拦截（exit ${r.lastExitCode}）：${r.lastErr}` +
    `；补修涉及文件（全部）：${r.allRepairFiles.join("、") || "（无）"}` +
    `${r.note !== "" ? `；补修说明：${r.note}` : ""}` +
    `；改动已 staged 未提交，人工检查 git status 后显式路径处置（环境恢复 agent 回复末段：${envTail}）`
  );
}

/** severity 等级表（critical > major > minor）：单向只升不降的判定基准。 */
const SEVERITY_RANK: Record<string, number> = { critical: 3, major: 2, minor: 1 };

/**
 * 延续/重报条目的身份锚点字段继承（空壳缺陷修复核心，wf-1792073055433）：
 * - title：target 缺失侧才回填——已追踪条目的 title 是跨轮身份锚点（L2 标题对账依据），
 *   锁定不覆盖，防聚合器空 title 把锚点抹掉；
 * - severity：单向只升不降（dmg-r1-1）——source 显式给出且等级更高时回写，更低时
 *   不覆盖。同题 suggestion 重报（恒 minor 层）经 L2 标题命中已追踪 critical/major
 *   条目时若照采本轮标注，追踪条目被洗成 minor 后 ES3 defer 校验以追踪 severity 为
 *   权威，「must-fix 不得 defer」红线被静默绕过；降级必须走 aggregator 显式裁决
 *   （adjudication=downgraded → dormant 通道）。与 R1 init 的同题异号防覆盖守卫
 *   （已建条目不覆盖）镜像，「must-fix 优先」在 R1/R2+ 两个合并站点一致成立。
 *   target.severity 来自历史状态文件，不在等级表内的意外值不参与降级判定（source
 *   合法等级照常回写，保持「清单侧字段异常时本轮为权威」语义）。
 * 返回是否有变更（调用方可记 log）。
 */
export function inheritCarryoverFields(
  target: { title?: string; severity?: string; [key: string]: unknown },
  source: { title?: string; severity?: string; [key: string]: unknown },
): boolean {
  let changed = false;
  if (!target.title && typeof source.title === "string" && source.title) {
    target.title = source.title;
    changed = true;
  }
  if (typeof source.severity === "string" && source.severity && target.severity !== source.severity) {
    // target.severity 可能 undefined（历史条目缺字段）——等级表查值前先收窄，缺值视同历史脏值
    const from = target.severity !== undefined ? SEVERITY_RANK[target.severity] : undefined;
    const to = SEVERITY_RANK[source.severity];
    // from 缺等级 = 历史脏值 → 采信本轮；to 缺等级（normalize 契约破裂）或降级 → 不覆盖
    if (from === undefined || to > from) {
      target.severity = source.severity;
      changed = true;
    }
  }
  return changed;
}

/** 延续/重报条目的内容字段非空刷新（防空壳覆盖：source 字段非空才写 target，
 *  旧无条件赋值会把已追踪条目的 evidence/files 抹成 undefined/空串）。
 *  与 inheritCarryoverFields 分立：身份锚点字段（title/severity）与内容字段（files/
 *  evidence/guidance）的合并方向不同——前者防覆盖，后者刷新但防空值。 */
export function refreshTrackedFields(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  fields: string[],
): void {
  for (const f of fields) {
    const v = source[f];
    const nonEmpty = Array.isArray(v) ? v.length > 0 : typeof v === "string" && v !== "";
    if (nonEmpty) target[f] = v;
  }
}

/**
 * content 补修子循环（设计 commit-content-self-heal 路线 B；ctx 注入平台差异）。
 *
 * 数据流：报错原文 → 派补修 agent（prompt 以报错原文为权威源）→ 结构化校验（失败回注
 * 原因重试一次，回注不消耗补修次数）→ 空申报 = 判不可修立即终止 → git status 前后快照
 * 差集对账（未申报的新增脏文件以实际为准并入并披露，越权改动防线）→ 显式路径 add →
 * 重跑同一 commit → 成功收工 / 仍败取最新报错回循环头。上限判定在循环头。
 *
 * askRepairAgent 异常不在此 catch（zcode 侧 provider 类失败由平台 stopped/resume 承接，
 * 不进入脚本——设计 §3.1 契约节；pi 侧壳把失败信封转 undefined 走校验路径）。
 */
export async function contentRepairLoop(ctx: ContentRepairCtx): Promise<ContentRepairResult> {
  let lastErr = ctx.initialErr;
  let lastExitCode = ctx.initialExitCode;
  let repairTries = 0;
  const allRepairFiles: string[] = [];
  let lastNote = "";
  while (true) {
    if (repairTries >= ctx.maxRepairs) {
      return { outcome: "exhausted", tries: repairTries, allRepairFiles, note: lastNote, lastErr, lastExitCode, why: "" };
    }
    // before 快照（每次尝试派发前重取，对齐参照实装）
    const before = new Set(await ctx.dirtyPaths());
    const prompt = (retryNote: string[]): string => buildRepairPrompt(ctx.roundLabel, lastErr, retryNote);
    const firstAsk = await ctx.askRepairAgent(repairTries + 1, prompt([]));
    // 计数立即 +1（先于任何判定——终态「尝试次数」即该值，不可修场景显示 1；回注重试不消耗次数）
    repairTries += 1;
    let report: CommitRepairReport | null = isValidRepairReport(firstAsk) ? firstAsk : null;
    if (report === null) {
      const invalidWhy = "返回非对象，或 repairedFiles 非数组，或 note 非非空字符串";
      ctx.log(`补修 agent 结构化返回无效（${invalidWhy}），回注失败原因重试一次`);
      const retryAsk = await ctx.askRepairAgent(repairTries, prompt(["", `上一次返回被判为无效（原因：${invalidWhy}）。重新输出有效 JSON。`]));
      if (!isValidRepairReport(retryAsk)) {
        return { outcome: "invalid-return", tries: repairTries, allRepairFiles, note: lastNote, lastErr, lastExitCode, why: invalidWhy };
      }
      report = retryAsk;
    }
    // 补修 agent 判不可修（空申报）→ 立即终止（不空耗剩余次数）
    if (report.repairedFiles.length === 0) {
      return { outcome: "unrepairable", tries: repairTries, allRepairFiles, note: lastNote, lastErr, lastExitCode, why: report.note };
    }
    lastNote = report.note;
    // after 快照差集对账：差集 = 补修期间新增脏文件；未申报文件以实际为准并入（越权改动防线）。
    // 边界（与参照实装同款）：差集只覆盖新增脏文件——本轮修复改动已在 before 集合内不会被
    // 误判；补修 agent 对既有脏/已暂存文件的未申报改动不进差集，靠申报文件恒被 add 兜底
    const declared = [...new Set(
      report.repairedFiles
        .filter((s): s is string => typeof s === "string")
        .map((s) => s.trim())
        .filter(Boolean),
    )];
    const actualNew = (await ctx.dirtyPaths()).filter((f) => !before.has(f));
    const undeclared = actualNew.filter((f) => !declared.includes(f));
    if (undeclared.length > 0) {
      ctx.log(`WARN: 补修 agent 申报与 git status 实际增量不一致（以实际为准并入并披露）：未申报 ${undeclared.join("、")}`);
    }
    const roundRepairFiles = [...new Set([...declared, ...actualNew])];
    for (const f of roundRepairFiles) if (!allRepairFiles.includes(f)) allRepairFiles.push(f);
    await ctx.stageFiles(roundRepairFiles);
    const commitRes = await ctx.retryCommit();
    lastExitCode = commitRes.exitCode;
    if (commitRes.exitCode === 0) {
      ctx.log(`补修重试成功（第 ${repairTries} 次补修）：补修文件 ${allRepairFiles.join("、") || "（无）"}；报错首行：${lastErr.split("\n")[0] ?? ""}${lastNote !== "" ? `；补修说明：${lastNote}` : ""}`);
      return { outcome: "repaired", tries: repairTries, allRepairFiles, note: lastNote, lastErr, lastExitCode, why: "" };
    }
    // 仍败 → 最新报错原文（≤4000 截断，同 initialErr 口径）进下一轮补修 prompt，回循环头次数检查
    lastErr = (commitRes.stderr.trim() || commitRes.stdout.trim()).slice(0, 4000);
    ctx.log(`补修重试仍被拦截（第 ${repairTries} 次补修后，exit ${commitRes.exitCode}）——回到补修循环头`);
  }
}
