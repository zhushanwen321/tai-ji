/**
 * reviewer 六维度清单模板（设计 §3.1(2) 审查编排：完备 / 必要 / 支撑 / 真实 /
 * 冲突 / 深度均衡）。落 prompts/ 的形态 = 静态文本 TS 模块（模板是编译期常量，
 * 经包内 import 加载——不走 fs 读 .md，esbuild 打包与 files 白名单天然覆盖）。
 *
 * reviewer 的完整 task = buildReviewerPrompt(...)：模板 + 画布全量数据内联 +
 * 轮次指令（R1 全面审 / R2+ 收窄到 scope 与上轮处置表）。输出契约（entries
 * schema）由派发侧注入，模板只描述维度判据与输出义务。
 */

/** 单维度判据（键 = ReviewDimension 契约值，reviewer 输出 entries 时按键引用）。 */
export const REVIEW_DIMENSIONS_GUIDE: ReadonlyArray<{ dim: string; title: string; criteria: string }> = [
  {
    dim: "completeness",
    title: "完备",
    criteria:
      "分解是否 MECE：有没有漏掉的子问题 / 候选方案 / 关键约束？每个 question 是否长出了候选，每个候选是否被论证？",
  },
  {
    dim: "necessity",
    title: "必要",
    criteria:
      "每个节点是否都为回答根问题所必需？删掉它论证是否塌陷？冗余复述、与判据无关的装饰性节点点名。",
  },
  {
    dim: "support",
    title: "支撑",
    criteria:
      "主干边（decompose/resolve）的支撑度是否成立？结论是否有 support/gap 标注的论据链，还是悬空断言？支撑缺口逐条点名。" +
      "对被评价的主干边输出 supportRating（sufficient/gap/invalid）；gap 必附 supportGaps 清单（该边缺什么支撑）。",
  },
  {
    dim: "authenticity",
    title: "真实",
    criteria:
      "fact 论据是否已核实（factVerified）？claim 是否被伪装成事实引用？数据/路径/接口名是否可核？",
  },
  {
    dim: "conflict",
    title: "冲突",
    criteria:
      "候选之间、论据之间有没有未解决的矛盾？被 rebut 的论点是否有人回应？与既定约束（根节点 scope）冲突的分支点名。",
  },
  {
    dim: "depth",
    title: "深度均衡",
    criteria:
      "各分支的分解深度是否与问题复杂度匹配（过浅 = 不可执行的叶子；过深 = 过早细化）？执行叶子是否可直接派发（有判据、可验证）？",
  },
]

export interface ReviewerPromptInput { // oe-exempt:20261015:framework:画布域类型契约（数据形状/端口/测试 harness，非抽象接口单实现）
  /** 画布名（引导 reviewer 建立上下文）。 */
  canvasName: string
  /** 本轮审查轮次（R1 = 全量六维度；R2+ = 处置表复审 + 攻击点）。 */
  round: number
  /** R2+ 的审查范围收窄描述（canvas_review run 的 scope 参数）；R1 缺省。 */
  scope?: string
  /** runtime read 回包的画布全量 JSON（reviewer 的唯一数据源——reviewer 不持工具）。 */
  canvasStateJson: string
  /** R2+ 注入：上轮条目的处置表渲染（entryId / 维度 / 等级 / 摘要 / 处置）。 */
  resolutionTable?: string
}

/** 渲染 reviewer 完整 task prompt（六维度模板 + 数据 + 轮次指令 + 输出契约说明）。 */
export function buildReviewerPrompt(input: ReviewerPromptInput): string {
  const dims = REVIEW_DIMENSIONS_GUIDE.map((d, i) => `${i + 1}. [${d.dim}] ${d.title}：${d.criteria}`).join("\n")
  const roundSection =
    input.round <= 1
      ? "本轮为 R1 全面审查：对下方画布逐维度打靶。"
      : [
          `本轮为 R${input.round} 复审：只审「上轮处置表」与新增攻击点，不再全图重扫。`,
          input.scope ? `本轮审查范围（发起方收窄）：${input.scope}` : undefined,
          input.resolutionTable ? `上轮处置表：\n${input.resolutionTable}` : undefined,
        ]
          .filter(Boolean)
          .join("\n")
  return [
    "你是问题解决画布的对抗式审查者（reviewer）。你的唯一职责 = 审查并输出报告条目；你没有任何工具，全部输入在下方向画布 JSON 中，输出以结构化 JSON 返回。",
    "",
    "画布名：" + input.canvasName,
    "",
    "== 审查指令 ==",
    roundSection,
    "",
    "== 六维度清单（逐维度打靶，不泛泛「是否合理」）==",
    dims,
    "",
    "== 画布全量数据（CanvasState JSON）==",
    input.canvasStateJson,
    "",
    "== 输出契约 ==",
    "输出一个 JSON 对象：{ entries: [{ id, dimension, severity, targetId, note, supportRating?, supportGaps? }], summary?: string }。",
    "- id：本条目唯一 id（rv-<序号> 即可）；",
    "- dimension：六词表之一（completeness/necessity/support/authenticity/conflict/depth）；",
    "- severity：'must-fix'（不修不得收敛）或 'suggestion'（改进建议）；",
    "- targetId：条目指向的图元素 id（节点 / 边 / 评论，必须存在于画布数据中）；",
    "- note：一句话说清问题与依据（引用 targetId 的内容），可附修复方向；",
    "- supportRating：仅当 targetId 是主干边（decompose/resolve）且你在评价该边支撑度时输出（sufficient/gap/invalid）；节点与论证边不评级；",
    "- supportGaps：supportRating='gap' 时必填（至少一条：该边缺什么支撑）。",
    "- summary：可选的一段话整体判定。整体结论只允许出现在 summary——条目 note 只陈述该条目自身的问题与依据，不得复述整体结论或与其他条目互相重复（同一结论在报告多处出现 = 报告不可读）。",
    "没有问题的维度不输出条目；宁缺毋滥，不凑数。",
  ].join("\n")
}
