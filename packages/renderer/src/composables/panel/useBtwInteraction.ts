/**
 * btw 内联确认条编排（D8 降级路径，唯一形态）——useExtensionUI 的 btw 交互段拆分
 * （依赖方向单向：本文件 → useExtensionUI / useBtwTabData / btw-pending-bookkeeping，无环）。
 *
 * V4 核实③不成立（plan-store 单全局 focusedSid 焦点投影，第二 usePlanState 实例会把
 * 主审批条读分区抢走 → S9b 互不抢占被破坏；修复面在领地外 plan-store/use-plan-sync）
 * → 按设计 D8 降级路径：五类请求（ask-user 富表单 / scheduler 表单 / plan 审批 /
 * 权限审批 / confirm·input·editor 简单 dialog）统一由 drawer 内联确认条独立轻实现
 * 呈现，富表单降档（choice→选项按钮、text→单行输入、schedule→预填草稿一键确认、
 * plan→两键+单行意见、editor→单行输入），**不回退主视图模态面**；降档契约登记于
 * 实施计划偏差表。提交回路契约与降级态同源：走 D8 终态机表（useBtwTabData 簿记）；
 * 投递失败可重试（仅限未送达/未终结 requestId）；已终结 requestId 的应答丢弃并提示失效。
 *
 * 并发：本编排只读 vid 分区（store 分区 + 模块级簿记），主视图三模态面读主 sid 分区
 * ——两面同屏互不抢占、提交态按表单实例/vid 隔离（S9b）。
 */
import { computed, watch, type Ref } from 'vue'
import type { ExtensionUIRequest } from '@taiji/core/transport/api/domains/extension'
import type { DialogRequest as UiDialogRequest } from '@taiji/ui/extension-host'
import { btwBarDrafts, emptyBtwBarDraft, useExtensionUI, type BtwBarDraft } from '@/composables/useExtensionUI'
import { firstBtwDialogReq, noteBtwRequestResolved } from '@/composables/panel/btw-pending-bookkeeping'
import { ensureBtwPendingBookkeeping, respondBtwDialog } from '@/composables/panel/useBtwTabData'

/** 确认条当前活动请求（按 receivedAt 与 store 族/dialog 族合并排序取最早——多请求并发呈现有序） */
export interface BtwBarRequest {
  kind: 'form' | 'planReview' | 'dialog'
  requestId: string
  receivedAt: number
  /** kind==='form'：完整表单请求（formQuestions / legacy scheduleCreate·scheduleDraft 源） */
  form?: ExtensionUIRequest
  /** kind==='dialog'：简单 dialog 载荷（含权限审批 select；ui 包 DialogRequest，非 core 同名类型） */
  dialog?: UiDialogRequest
}

/** 降档表单选项（本地同形，renderer 不反向依赖 extension-protocol——PlanReviewComment 惯例） */
export interface BtwBarOption {
  label: string
  description?: string
}

/** 降档 schedule 草稿（本地同形：ScheduleDraft 的消费面字段子集） */
export interface BtwScheduleDraft {
  kind: 'once' | 'recurring'
  schedule: string
  prompt: string
  model?: string
  name?: string
  expires?: string
}

/** 降档表单问题（本地同形守卫收窄后的渲染面） */
export interface BtwBarFormQuestion {
  type: 'choice' | 'text' | 'schedule'
  header?: string
  question: string
  options?: BtwBarOption[]
  multi?: boolean
  allowOther?: boolean
  initial?: BtwScheduleDraft
}

/** schedule 草稿形状守卫（结构化收窄，禁 any；缺字段 = 不可降级确认，走取消支） */
function toScheduleDraft(v: unknown): BtwScheduleDraft | null {
  if (typeof v !== 'object' || v === null) return null
  const d = v as Record<string, unknown>
  if (d.kind !== 'once' && d.kind !== 'recurring') return null
  if (typeof d.schedule !== 'string' || typeof d.prompt !== 'string') return null
  return {
    kind: d.kind,
    schedule: d.schedule,
    prompt: d.prompt,
    ...(typeof d.model === 'string' ? { model: d.model } : {}),
    ...(typeof d.name === 'string' ? { name: d.name } : {}),
    ...(typeof d.expires === 'string' ? { expires: d.expires } : {}),
  }
}

/** 问题类型收窄（choice/text/schedule 之外 = 非法项） */
function toBarQuestionKind(t: unknown): 'choice' | 'text' | 'schedule' | null {
  if (t === 'choice' || t === 'text' || t === 'schedule') return t
  return null
}

/** 公共基底提取（header/question 双守卫；两者皆缺 = 非法项） */
function toBarQuestionBase(
  q: Record<string, unknown>,
  kind: 'choice' | 'text' | 'schedule',
): Omit<BtwBarFormQuestion, 'options' | 'multi' | 'allowOther' | 'initial'> | null {
  const header = typeof q.header === 'string' ? q.header : undefined
  const question = typeof q.question === 'string' ? q.question : ''
  if (header === undefined && question === '') return null
  return { type: kind, ...(header !== undefined ? { header } : {}), question }
}

/** choice 选项数组归一（非法项剔除——label 守卫；非数组/无有效项 = 空数组） */
function toBarOptions(v: unknown): BtwBarOption[] {
  const out: BtwBarOption[] = []
  if (!Array.isArray(v)) return out
  for (const o of v) {
    if (typeof o !== 'object' || o === null) continue
    const rec = o as Record<string, unknown>
    if (typeof rec.label !== 'string') continue
    out.push({
      label: rec.label,
      ...(typeof rec.description === 'string' ? { description: rec.description } : {}),
    })
  }
  return out
}

/** formQuestions 逐项归一（非法项剔除——runtime 侧 isFormQuestion 逐项过滤同策略） */
function toBarQuestion(v: unknown): BtwBarFormQuestion | null {
  if (typeof v !== 'object' || v === null) return null
  const q = v as Record<string, unknown>
  const kind = toBarQuestionKind(q.type)
  if (kind === null) return null
  const base = toBarQuestionBase(q, kind)
  if (base === null) return null
  if (kind === 'schedule') {
    const initial = toScheduleDraft(q.initial)
    return { ...base, ...(initial !== null ? { initial } : {}) }
  }
  if (kind !== 'choice') return base
  return { ...base, options: toBarOptions(q.options), multi: q.multi === true, allowOther: q.allowOther !== false }
}

/** 问题集派生（questions 源优先；legacy scheduleCreate·scheduleDraft 源包装单 schedule 问） */
function questionsOf(req: ExtensionUIRequest): BtwBarFormQuestion[] {
  const out: BtwBarFormQuestion[] = []
  if (Array.isArray(req.formQuestions)) {
    for (const q of req.formQuestions) {
      const n = toBarQuestion(q)
      if (n) out.push(n)
    }
  }
  if (out.length > 0) return out
  const draft = toScheduleDraft(
    (req as { scheduleDraft?: unknown }).scheduleDraft,
  )
  if (req.scheduleCreate === true && draft) {
    return [{ type: 'schedule', question: '', initial: draft }]
  }
  return []
}

/** answers key（与协议 askUserKey fallback 同规则：header ?? question） */
function questionKey(q: BtwBarFormQuestion): string {
  return q.header ?? q.question
}

/** schedule 降档提交体（预填草稿直接确认——FormOverlay「预填草稿视为有效」语义；once 的
 *  draft.schedule 已是折叠一次性 cron（唯一时间来源），不再二次折叠）。 */
function scheduleResultJson(d: BtwScheduleDraft): string {
  const result: Record<string, unknown> = {
    action: 'create',
    kind: d.kind,
    schedule: d.schedule,
    prompt: d.prompt,
  }
  if (d.model !== undefined) result.model = d.model
  if (d.name !== undefined) result.name = d.name
  if (d.kind === 'recurring' && d.expires !== undefined) result.expires = d.expires
  return JSON.stringify(result)
}

/**
 * 接线 drawer 内联确认条（BtwPanel setup 同步调用）。
 *
 * 数据面三通道合并：store 族（form + planReview，useExtensionUI vid 分区）∪ dialog 族
 * （模块级簿记 FIFO）——按 receivedAt 取最早呈现（并发有序），respond 后自然晋升下一条。
 */
export function useBtwInteraction(vidRef: Ref<string | null>) {
  ensureBtwPendingBookkeeping()
  const ui = useExtensionUI(vidRef, () => true)

  const active = computed<BtwBarRequest | null>(() => {
    const vid = vidRef.value
    if (!vid) return null
    const cands: BtwBarRequest[] = []
    const form = ui.currentFormRequest.value
    if (form) {
      cands.push({ kind: 'form', requestId: form.requestId, receivedAt: form.receivedAt ?? 0, form })
    }
    const plan = ui.currentPlanReviewRequests.value[0]
    if (plan) {
      cands.push({ kind: 'planReview', requestId: plan.requestId, receivedAt: plan.receivedAt ?? 0 })
    }
    const dialog = firstBtwDialogReq(vid)
    if (dialog) {
      cands.push({ kind: 'dialog', requestId: dialog.requestId, receivedAt: dialog.receivedAt, dialog })
    }
    if (cands.length === 0) return null
    return cands.reduce((best, c) => (c.receivedAt < best.receivedAt ? c : best))
  })

  // ── 提交态草稿（D7⑤「挂起表单提交态 per-vid 隔离，切走切回不丢」，U2 修复）──
  // 分键 = `${vid}:${requestId}`，模块级保存（组件卸载/切线/切主会话均不清）；
  // 仅在请求终结时清：应答送达（respondActive 成功支）/ 失效（invalidated 订阅）/
  // 快照差集修剪（subscribe retainOnly diff）。active 切换零清理——watch 只负责在
  // 激活新分键时补建空草稿（幂等，不删旧键）。载体 = useExtensionUI 模块级 btwBarDrafts
  // （终结清理入口挂其失效链/快照修剪两路，与编排层无环单向依赖）。
  const draftKeyOf = (a: BtwBarRequest | null, vid: string | null): string | null => a && vid ? `${vid}:${a.requestId}` : null
  watch(
    () => draftKeyOf(active.value, vidRef.value),
    (key) => { if (key !== null && !btwBarDrafts.has(key)) btwBarDrafts.set(key, emptyBtwBarDraft()) },
    { immediate: true },
  )
  const curDraft = computed<BtwBarDraft | null>(() => {
    const key = draftKeyOf(active.value, vidRef.value)
    return key === null ? null : (btwBarDrafts.get(key) ?? null)
  })
  /** 模板绑定面（v-model 写入当前分键草稿；无活动请求时为只读空表，写入无副作用） */
  const formSel = computed<Record<string, string[]>>(() => curDraft.value?.sel ?? {})
  const formText = computed<Record<string, string>>(() => curDraft.value?.text ?? {})
  const planComment = computed<string>({
    get: () => curDraft.value?.planComment ?? '',
    set: (v) => { if (curDraft.value) curDraft.value.planComment = v },
  })
  const dialogSelect = computed<string>({
    get: () => curDraft.value?.dialogSelect ?? '',
    set: (v) => { if (curDraft.value) curDraft.value.dialogSelect = v },
  })
  const dialogText = computed<string>({
    get: () => curDraft.value?.dialogText ?? '',
    set: (v) => { if (curDraft.value) curDraft.value.dialogText = v },
  })

  const activeQuestions = computed<BtwBarFormQuestion[]>(() => {
    const a = active.value
    if (a?.kind !== 'form' || !a.form) return []
    return questionsOf(a.form)
  })

  function toggleSelect(key: string, label: string, multi: boolean): void {
    const sel = curDraft.value?.sel
    if (!sel) return
    const cur = sel[key] ?? []
    if (multi) {
      sel[key] = cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label]
    } else {
      sel[key] = [label]
    }
  }

  function isSelected(key: string, label: string): boolean {
    return (curDraft.value?.sel[key] ?? []).includes(label)
  }

  function draftValid(d: BtwScheduleDraft | null | undefined): boolean {
    return d !== null && d !== undefined && d.prompt.trim().length > 0
  }

  /** Submit 门（降档口径）：逐题可答判定（choice=选项或 Other；text=非空；schedule=草稿可用） */
  const canSubmitForm = computed(() => {
    const a = active.value
    if (a?.kind !== 'form' || !a.form) return false
    const qs = activeQuestions.value
    if (qs.length === 0) return false
    if (a.form.scheduleCreate === true) {
      // legacy draft 源：无 questions，直接校验草稿
      return draftValid(toScheduleDraft((a.form as { scheduleDraft?: unknown }).scheduleDraft))
    }
    return qs.every((q) => {
      const key = questionKey(q)
      if (q.type === 'schedule') return draftValid(q.initial)
      const text = curDraft.value?.text ?? {}
      if (q.type === 'text') return (text[`${key}__other`] ?? '').trim().length > 0
      const sel = (curDraft.value?.sel[key] ?? []).length > 0
      const other = (text[`${key}__other`] ?? '').trim().length > 0
      if ((q.options ?? []).length === 0) return other
      return sel || other
    })
  })

  /** 主按钮文案（含 schedule 题 =「创建任务」，FormOverlay 同口径；降档复用既有 key） */
  const submitLabel = computed(() => {
    const a = active.value
    if (a?.kind !== 'form') return ''
    const hasSchedule = activeQuestions.value.some((q) => q.type === 'schedule')
    return hasSchedule ? 'schedule' : 'submit'
  })

  /** 取消键显隐（协议缺省 true；显式 false 隐藏——FormOverlay 同语义；dialog 恒显） */
  const allowCancel = computed(() => {
    const a = active.value
    if (a?.kind !== 'form') return true
    return a.form?.allowCancel !== false
  })

  /** 应答出口（三 kind 共用；送达才出账——未送达保持挂起可重试、草稿随挂起保留，D8 提交回路契约；
   *  终结即清本请求草稿分键（D7⑤） */
  function respondActive(result: boolean | string | null): void {
    const a = active.value
    const vid = vidRef.value
    if (!a || !vid) return
    const key = `${vid}:${a.requestId}`
    if (a.kind === 'dialog') { if (respondBtwDialog(vid, a.requestId, result)) btwBarDrafts.delete(key); return }
    if (ui.respond(a.requestId, result)) {
      noteBtwRequestResolved(vid, a.requestId)
      btwBarDrafts.delete(key)
    }
  }

  /** 表单提交：按挂载源构造应答形状（draft 源 = 扁平 ScheduleFormResult；questions 源 = answers envelope） */
  function submitForm(): void {
    const a = active.value
    if (a?.kind !== 'form' || !a.form) return
    if (a.form.scheduleCreate === true) {
      const draft = toScheduleDraft((a.form as { scheduleDraft?: unknown }).scheduleDraft)
      if (draft) respondActive(scheduleResultJson(draft))
      return
    }
    const payload = formAnswersJson(activeQuestions.value, curDraft.value)
    if (payload !== null) respondActive(payload)
  }

  /** 逐题收集 answers envelope（null = 有题不可答，整体不回传——对齐原「遇缺 initial 即中止」语义） */
  function formAnswersJson(
    qs: BtwBarFormQuestion[],
    draft: BtwBarDraft | null,
  ): string | null {
    const answers: Record<string, string> = {}
    const draftText = draft?.text ?? {}
    const draftSel = draft?.sel ?? {}
    for (const q of qs) {
      if (!appendQuestionAnswer(answers, q, draftText, draftSel)) return null
    }
    return JSON.stringify(answers)
  }

  /** 单题入账；false = schedule 题缺 initial（预填草稿被清），整体不可提交 */
  function appendQuestionAnswer(
    answers: Record<string, string>,
    q: BtwBarFormQuestion,
    draftText: Record<string, string>,
    draftSel: Record<string, string[]>,
  ): boolean {
    const key = questionKey(q)
    if (q.type === 'schedule') {
      if (!q.initial) return false
      answers[key] = scheduleResultJson(q.initial)
      return true
    }
    if (q.type === 'text') {
      appendTextAnswer(answers, key, draftText[`${key}__other`] ?? '')
      return true
    }
    appendChoiceAnswer(answers, key, q, draftText, draftSel)
    return true
  }

  /** text 题入账（空白不写键） */
  function appendTextAnswer(answers: Record<string, string>, key: string, text: string): void {
    if (text.trim().length > 0) answers[`${key}__other`] = text
  }

  /** choice 题入账：选中项（multi = JSON 数组 / 单选 = 首项）+ Other 文本（写入判定无 trim，
   *  与 text 题的 trim 判定不同——保持既有提交形状） */
  function appendChoiceAnswer(
    answers: Record<string, string>,
    key: string,
    q: BtwBarFormQuestion,
    draftText: Record<string, string>,
    draftSel: Record<string, string[]>,
  ): void {
    const sel = draftSel[key] ?? []
    if ((q.options ?? []).length > 0 && sel.length > 0) {
      answers[key] = q.multi === true ? JSON.stringify(sel) : sel[0]
    }
    const other = draftText[`${key}__other`] ?? ''
    if (other.length > 0) answers[`${key}__other`] = other
  }

  /** plan 审批降档回传（PlanReviewResponse 本地同形；revise 单行意见 = 降档契约登记面） */
  function submitPlan(decision: 'approve' | 'revise'): void {
    const payload =
      decision === 'approve'
        ? JSON.stringify({ decision: 'approve' })
        : JSON.stringify({ decision: 'revise', comments: [{ quote: '', comment: planComment.value.trim() }] })
    respondActive(payload)
  }

  function cancelActive(): void {
    respondActive(null)
  }

  return {
    active,
    activeQuestions,
    formSel,
    formText,
    planComment,
    dialogSelect,
    dialogText,
    questionKey,
    toggleSelect,
    isSelected,
    canSubmitForm,
    submitLabel,
    allowCancel,
    respondActive,
    submitForm,
    submitPlan,
    cancelActive,
  }
}
