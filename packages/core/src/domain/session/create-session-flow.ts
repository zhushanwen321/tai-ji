/**
 * createSessionFlow —— session 创建编排原语（IF5，w4，core 平台无关）。
 *
 * [归位] 迁自 renderer composables/features/useNewTaskFlow.ts:235-340 的 session 创建部分
 * （C-SS-2 裁决：useNewTaskFlow.submitFirstMessage 把创建与发送耦合在一个 100+ 行函数内，
 * 违反 D4 单一归位——session 创建属 session 域，发送属 chat 域）。本函数只承接创建编排：
 * guard→cwd 兜底→label 派生→create→INV-7 降级（含 E7 两空提示）→appendSession→migrateImages。
 *
 * 边界（C-W4-3）：panel.loadSession / navigation.push / send / transition / fileTree
 * 预加载 留壳层（useNewTaskFlow 在 createSessionFlow 返回后编排）。原 thinkingLevel apply
 * 留壳步已随 D5 契约快照化删除（2026-09，U2b）。
 *
 * 裁决标注：
 * - C-W4-1：SessionApiPort.migrateImage 签名对齐 renderer（{fromPath,sessionId,fileName}→{path}）
 * - C-W4-2：migrateImages 内部实现（不走 IF5 字面的注入回调）——图片归档是 session 域固有副作用；
 *   返回 {session, migratedSegments} | null，调用方用 migratedSegments 做 send
 * - C-W4-3：thinkingLevel apply 留壳（[已废除 2026-09 D5] 壳层 C-W4-3 setThinkingLevel 与本函数
 *   step 7 applyModel 同批删除——landing 恒传解析终值后二者均为同值二次 RPC，override 经
 *   create 快照化一次到位）；空 content guard 进本函数（null 分支）
 * - C-W4-4：defaultCwd 由壳注入 ctx，cwd ?? defaultCwd 兜底
 *
 * 依赖方向：SessionApiPort（./api-port）+ createSessionStore 类型（./store）+ Segment/SessionSummary
 * （@taiji/shared）。core 零 renderer import。
 */
import type { Segment, SessionSummary, ThinkingLevel } from '@taiji/shared'
import type { SessionApiPort } from './api-port'
import type { createSessionStore } from './store'

/** session label 截断阈值：取首条提示词前 N 字符（codePoint 计，中文/emoji 算 1 字） */
const SESSION_LABEL_MAX = 10
/** 空提示词兜底文案（UI 已拦截空提交，此处为防御性默认） */
const EMPTY_PROMPT_FALLBACK = '无提示词'

/**
 * 从首条提示词派生 session label（codePoint 计前 10 字符，超长加省略号）。
 *
 * 迁自 renderer lib/utils.ts（core 不 import renderer lib；label 派生是纯函数属 session 域）。
 * 规则：空白→兜底文案；≤10→原文；>10→前 10+…。Array.from 按 codePoint 拆分，避免 UTF-16
 * 代理对被截断成乱码（中文/emoji 算 1 字）。
 */
function deriveSessionLabel(text: string): string {
  const chars = Array.from(text.trim())
  if (chars.length === 0) return EMPTY_PROMPT_FALLBACK
  if (chars.length <= SESSION_LABEL_MAX) return chars.join('')
  return chars.slice(0, SESSION_LABEL_MAX).join('') + '…'
}

/** 图片迁移回调签名（SessionApiPort.migrateImage 与 ImageMigratePort.migrateImage 结构同型，C-W4-1）。 */
export type MigrateImageFn = (
  p: { fromPath: string; sessionId: string; fileName: string },
) => Promise<{ path: string }>

/** migrateImageSegments 返回：迁移后的段 + 成功计数（调用方做 partial-fail 判定）。 */
export interface MigrateImageSegmentsResult {
  /** 迁移后的段（无待迁移段原样返回；迁移成功 image 段 path 更新 + needsMigrate 重置 false） */
  segments: Segment[]
  /** 成功迁移的 image 段数 */
  migratedCount: number
  /** 待迁移的 image 段总数（needsMigrate=true 的段数） */
  total: number
}

/**
 * tmpdir image 段迁移原语（单源）：扫描 segments 中 needsMigrate=true 的 image 段，
 * 经 migrateImage 回调 move 到 attachments/<sessionId>/（持久化），返回更新后的段。
 *
 * 为什么导出：创建分支（本文件 createSessionFlow）与 retry/预建分支
 * （new-task-search flow.migrateRetryImages）消费同一迁移语义——双份实现曾因
 * 各自演化产生漂移面（S4-A2 收口）。单文件失败不阻断（OS 可能已清理 tmpdir），
 * Promise.allSettled 收集结果，rejected console.warn 后跳过（migratedCount < total
 * 即部分失败，调用方自决 toast 提示）。migrateImage 回调在 web/mock 环境可能
 * 返回 undefined（非 reject），不进 migrated，调用方据此保留原 path。
 *
 * [归位] 迁自 renderer useNewTaskFlow.migrateTmpdirImages + 本文件私有 migrateSegments
 * （两处逐字同构，合一于此——session 域固有的图片归档副作用原语）。
 */
export async function migrateImageSegments(
  segments: Segment[],
  sessionId: string,
  migrateImage: MigrateImageFn,
  opts?: { logTag?: string },
): Promise<MigrateImageSegmentsResult> {
  const logTag = opts?.logTag ?? 'createSessionFlow'
  const needsMigrateImages = segments.filter(
    (s): s is Extract<Segment, { type: 'image' }> => s.type === 'image' && s.needsMigrate === true,
  )
  if (needsMigrateImages.length === 0) {
    return { segments, migratedCount: 0, total: 0 }
  }
  const migrated = new Map<string, string>()
  const results = await Promise.allSettled(
    needsMigrateImages.map(async (img) => {
      const result = await migrateImage({
        fromPath: img.path,
        sessionId,
        fileName: img.fileName,
      })
      if (result?.path) {
        migrated.set(img.path, result.path)
      }
    }),
  )
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.warn(`[${logTag}] image migrate failed: ${needsMigrateImages[i].path}`, r.reason)
    }
  })
  const finalSegments = segments.map((s) => {
    if (s.type === 'image' && migrated.has(s.path)) {
      // 迁移成功：更新 path + 重置 needsMigrate=false（避免后续重发误迁移）
      return { ...s, path: migrated.get(s.path)!, needsMigrate: false }
    }
    return s
  })
  return { segments: finalSegments, migratedCount: migrated.size, total: needsMigrateImages.length }
}

/** createSessionFlow 的依赖注入上下文（壳注入实现，core 零跨包 import）。 */
export interface CreateSessionFlowCtx {
  /** session 列表 store（w1 交付的纯 factory 实例，壳显式持有） */
  store: ReturnType<typeof createSessionStore>
  /** session 后端操作端口（w2 交付） */
  api: SessionApiPort
  /** 默认 cwd（壳解析 workspaceStore.defaultCwd 传入；input.cwd 为空时兜底） */
  defaultCwd: string
  /** INV-7 cwd 降级回调（created.cwd !== 请求 cwd 时触发（含 E7 两空空串），壳做 toast 通知） */
  onCwdFallback?: (reqCwd: string, actualCwd: string) => void
}

/** createSessionFlow 的输入（landing 态首发提交的创建参数）。 */
export interface CreateSessionFlowInput {
  /** 选定 cwd（landing 态 pendingCwd；null 时用 ctx.defaultCwd 兜底） */
  cwd: string | null
  /** preset id（landing 态 pendingPreset；空传 undefined 给 create） */
  presetId?: string | null
  /** landing 态选定的模型（"provider/modelId" 复合串；经 create modelOverride 快照化生效） */
  pendingModel?: string | null
  /** 归属 project id（D14 语义修正 2026-08-04：创建时归属当前 activeProject；空 = 默认项目兑底） */
  projectId?: string | null
  /** 首发消息段（含 text/image/skill 等；label 从首条 text 段取、trim 空时回退首个 slash 段，
   * image 段需迁移） */
  segments: Segment[]
  /** bash 首发（landing 态 !/!! 前缀）；存在时 label 从 command 取 */
  bashCommand?: { command: string; excludeFromContext: boolean } | null
  /** landing 态选定的思考等级（透传 session.create，session 创建即带正确等级） */
  pendingThinkingLevel?: ThinkingLevel | null
}

/** createSessionFlow 的返回值（非 null 分支；null = guard 命中未创建）。 */
export interface CreateSessionFlowResult {
  /** 新建的 session */
  session: SessionSummary
  /** 迁移后的段（未迁移段原样保留；迁移成功的 image 段 path 更新 + needsMigrate 重置 false） */
  migratedSegments: Segment[]
}

/**
 * step 1 输入：首条 text 段 trim；trim 后为空（含无 text 段）→ 回退首个 slash 段（'/' + name）。
 *
 * D4-a 后命令 chip 产结构化 slash 段（不再拍平进 text 段），landing 首发纯命令（如 `/tasks`）
 * 若只认 text 段，label 会从 `/tasks` 退化为通用兜底文案。此处把 slash 段视同 text-like 作为
 * label 文本源回退——`hasSubmittableContent` 的判定维度不变（slash 仍算非 text 段）。
 */
function firstTextTrimmed(input: CreateSessionFlowInput): string {
  const firstTextSeg = input.segments.find(
    (s): s is Extract<Segment, { type: 'text' }> => s.type === 'text',
  )
  const trimmed = firstTextSeg?.text?.trim() ?? ''
  if (trimmed) return trimmed
  const firstSlashSeg = input.segments.find(
    (s): s is Extract<Segment, { type: 'slash' }> => s.type === 'slash',
  )
  return firstSlashSeg ? `/${firstSlashSeg.name}` : ''
}

/** step 1 guard：无 text trim 且无非 text 段且无 bashCommand → 无可用内容（不创建）。 */
function hasSubmittableContent(input: CreateSessionFlowInput, trimmed: string): boolean {
  const hasNonTextSegment = input.segments.some((s) => s.type !== 'text')
  return Boolean(trimmed) || hasNonTextSegment || input.bashCommand != null
}

/** step 4：调 api.create（null 参数归一 undefined；override 优先级见 createSessionFlow 注释）。 */
async function createSessionRecord(
  ctx: CreateSessionFlowCtx,
  input: CreateSessionFlowInput,
  cwd: string,
  label: string,
): Promise<SessionSummary> {
  return ctx.api.create(
    cwd,
    label,
    input.presetId ?? undefined,
    input.projectId ?? undefined,
    input.pendingModel ?? undefined,
    input.pendingThinkingLevel ?? undefined,
  )
}

/**
 * step 5：cwd 降级比对（runtime create 内部可能降级 homedir）。
 *
 * E7（D10）两空提示：landing 未选目录且无 defaultCwd 时 cwd 为空串，runtime create('')
 * 落 homedir——空串守卫（`reqCwd &&`）曾跳过回调致静默换目录。现放宽为「实际值 ≠ 请求值
 * 即回调」：两空场景也触发 onCwdFallback('', homedir)，壳侧同一 toast 通道提示用户
 * 「已切换到主目录」（reqCwd 空串与降级 toast 的区分由壳按 reqCwd 是否为空自行决定文案）。
 */
function notifyCwdFallback(ctx: CreateSessionFlowCtx, reqCwd: string, actualCwd: string): void {
  if (actualCwd !== reqCwd) {
    ctx.onCwdFallback?.(reqCwd, actualCwd)
  }
}

/** step 7：migrateImages（needsMigrate image 段经 api.migrateImage 迁移，更新 path + 重置 needsMigrate）。 */
async function migrateSegments(segments: Segment[], sessionId: string, api: SessionApiPort): Promise<Segment[]> {
  const { segments: migratedSegments } = await migrateImageSegments(
    segments,
    sessionId,
    (p) => api.migrateImage(p),
  )
  return migratedSegments
}

/**
 * 创建 session 的纯编排原语（IF5）。
 *
 * 编排顺序（对齐 renderer useNewTaskFlow.submitFirstMessage 创建段）：
 * 1. guard：无 text trim 且无非 text 段且无 bashCommand → 返回 null（不创建）
 * 2. cwd 兜底：input.cwd ?? ctx.defaultCwd
 * 3. label 派生：bashCommand ? command : trimmed（codePoint 前 10 + 省略号）
 * 4. create：api.create(cwd, label, presetId, projectId, modelOverride, thinkingOverride)
 * 5. INV-7 降级 + E7 两空：created.cwd !== cwd（含 cwd 空串落 homedir）→ onCwdFallback?.(cwd, created.cwd)
 * 6. appendSession：store.appendSession(created)
 * 7. migrateImages：needsMigrate image 段经 api.migrateImage 迁移，更新 path + 重置 needsMigrate
 * 8. 返回 { session: created, migratedSegments }
 *
 * [D5 已删] 原 step 7 applyModel（pendingModel 非空 → ctx.applyModel）：landing 恒传解析
 * 终值后是对每个新 session 的同值二次 RPC，模型经 create modelOverride 快照化一次到位。
 *
 * @returns null = 空 content guard 命中（未创建）；否则创建结果
 */
export async function createSessionFlow(
  ctx: CreateSessionFlowCtx,
  input: CreateSessionFlowInput,
): Promise<CreateSessionFlowResult | null> {
  // 1. 空 content guard（对齐 renderer：无可用内容时不创建）
  const trimmed = firstTextTrimmed(input)
  if (!hasSubmittableContent(input, trimmed)) {
    return null
  }

  // 2. cwd 兜底
  const cwd = input.cwd ?? ctx.defaultCwd

  // 3. label 派生（bash 首发用 command，否则首条 text；trim 空回退首个 slash 段）
  const label = deriveSessionLabel(input.bashCommand ? input.bashCommand.command : trimmed)

  // 4. create session（label 已派生；presetId 透传；projectId 归属透传：D14 语义修正，创建时归属当前 activeProject）
  // D5 契约快照化：modelOverride/thinkingOverride 透传 landing 解析终值（U2b 起恒非空），
  // 优先级 override > preset > 全局默认；post-create applyModel 已删（同值二次 RPC）。
  const created = await createSessionRecord(ctx, input, cwd, label)

  // 5. INV-7 cwd 降级比对 + E7 两空提示（runtime create 内部可能降级 homedir；
  // reqCwd 空串且实际落 homedir 时也回调，见 notifyCwdFallback 注释）
  notifyCwdFallback(ctx, cwd, created.cwd)

  // 6. appendSession（store 真实响应式，非 mock）
  ctx.store.appendSession(created)

  // 7. migrateImages（needsMigrate image 段经 api.migrateImage 迁移）
  const migratedSegments = await migrateSegments(input.segments, created.id, ctx.api)

  // 8. 返回创建结果
  return { session: created, migratedSegments }
}
