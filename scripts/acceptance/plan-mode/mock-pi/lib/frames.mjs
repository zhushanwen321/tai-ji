/**
 * pi RPC 协议帧构造器（mock pi 脚本族）。
 *
 * 契约锚点 = `packages/runtime/src/infra/pi/pi-protocol.ts`（pi JSONL RPC 帧类型真契约）。
 * 本文件是纯 JS 构造器（mock pi 以 `node_modules/.bin/pi` 文件级置换形态被 spawn，
 * 不能依赖 tsx / TS 导入），marker 字面量镜像自 extension-protocol——自测入口
 * `selftest.mjs` 的 `marker-literal-drift` 用例对源文件做字面量比对防漂移：
 * - PLAN_REVIEW_MARKER ← `packages/extension-protocol/src/core/markers.ts`（注意带尾冒号）
 * - UI_FORM_MARKER    ← `packages/extension-protocol/src/extensions/ui-form/marker.ts`（无尾冒号）
 *
 * 帧形态关键事实（pi-protocol.ts GOTCHAS）：
 * - prompt 命令用 `message` 字段；get_messages 历史在 `data.messages`；
 * - 响应 = `{id, type:'response', command, success, error?, data?}`（error envelope = success:false + error）；
 * - extension_ui_request = `{type:'extension_ui_request', id?, method, title?, message?, options?}`；
 * - marker select 的 payload 在 options[0]（JSON 字符串），title 精确等于 marker（isMarkerSelect === 判定）；
 * - extension_ui_response 由 runtime 走 sendRaw 注入（pi 不回 RPC reply），形态
 *   `{id, value|confirmed|cancelled}`（buildExtensionUiResponsePayload 鸭子类型字段）。
 */

export const PLAN_REVIEW_MARKER = '\u0000TAIJI_PLAN_REVIEW:';
export const UI_FORM_MARKER = '\u0000TAIJI_UI_FORM';

// ── 响应帧 ─────────────────────────────────────────────────────────

export function responseOk(id, command, data) {
  return { id, type: 'response', command, success: true, ...(data !== undefined ? { data } : {}) };
}

/** error envelope 应答（success:false + error 文本）——协议错误/未知命令/强制错误注入共用。 */
export function responseError(id, command, error) {
  return { id, type: 'response', command, success: false, error };
}

/** 独立 error 事件帧（非应答，pi 报运行期错误）。 */
export function errorEvent(error) {
  return { type: 'error', error };
}

// ── 生命周期 / 消息事件 ────────────────────────────────────────────

export function agentStart() {
  return { type: 'agent_start' };
}

export function agentEnd(messages = [], willRetry = false) {
  return { type: 'agent_end', messages, willRetry };
}

export function agentSettled() {
  return { type: 'agent_settled' };
}

/** message_end（content 用 pi 规范 Part[] 形态）。 */
export function messageEnd(role, text, extra = {}) {
  return { type: 'message_end', message: { role, content: [{ type: 'text', text }], ...extra } };
}

// ── extension UI 帧 ────────────────────────────────────────────────

/**
 * plan 审批 marker select（runtime tryTranslatePlanReviewSelect 命中形态：
 * title === PLAN_REVIEW_MARKER 且 options[0] JSON 含 docs 数组）。
 */
export function planReviewSelect({ id = `pr-${nextSeq()}`, docs = [], selfReview, message } = {}) {
  const payload = { docs };
  // selfReview 前向兼容键（U3b 透传面）：现版 runtime 不透传，携带有界字段不改路由。
  if (selfReview !== undefined) payload.selfReview = selfReview;
  return {
    type: 'extension_ui_request',
    id,
    method: 'select',
    title: PLAN_REVIEW_MARKER,
    ...(message !== undefined ? { message } : {}),
    options: [JSON.stringify(payload)],
  };
}

/** 执行方式表单 marker select（UI_FORM_MARKER + formQuestions payload——plan complete 的三档表单）。 */
export function uiFormSelect({ id = `uf-${nextSeq()}`, formQuestions = [], allowCancel = true } = {}) {
  return {
    type: 'extension_ui_request',
    id,
    method: 'select',
    title: UI_FORM_MARKER,
    options: [JSON.stringify({ formQuestions, allowCancel })],
  };
}

/** plan complete 执行方式表单的标准三档问题（S5/S7/S16 构造用，形态对齐 plan 扩展 uiFormInteract）。 */
export function execFormQuestions({ skills = [] } = {}) {
  const options = skills.map((s) => ({ label: `用技能「${s}」执行`, value: `skill:${s}` }));
  options.push({ label: '普通执行', value: 'execute' });
  options.push({ label: '暂不执行', value: 'later' });
  return [
    {
      id: 'exec-mode',
      kind: 'select',
      label: '选择执行方式',
      description: '计划已批准，选择执行方式',
      options,
    },
  ];
}

// ── 边界帧（空载荷 / 非法形态 / 超限）────────────────────────────────
//
// 每个构造器对应一种「宿主必须降级不炸」的边界输入；自测入口逐个断言边界性质
//（options 空 / JSON 不可解析 / docs 非数组 / 载荷超限），runtime 侧的降级行为
// 由 runtime 自身测试族覆盖（event-adapter marker 守卫），此处只保证帧面构造正确。

/** 空载荷：select 无 options（parseSelectOptionsPayload → undefined → 降级普通 select）。 */
export function emptyOptionsSelect(id = `edge-${nextSeq()}`) {
  return { type: 'extension_ui_request', id, method: 'select', title: 'edge-empty-options', options: [] };
}

/** 空载荷变体：options[0] 空串（JSON.parse 失败 → 降级普通 select）。 */
export function blankOptionSelect(id = `edge-${nextSeq()}`) {
  return { type: 'extension_ui_request', id, method: 'select', title: 'edge-blank-option', options: [''] };
}

/** 非法形态：options[0] 非法 JSON。 */
export function illegalJsonSelect(id = `edge-${nextSeq()}`) {
  return { type: 'extension_ui_request', id, method: 'select', title: PLAN_REVIEW_MARKER, options: ['{not-json'] };
}

/** 非法形态变体：marker 命中但 docs 非数组（plan-review 检测整体判否 → 降级普通 select）。 */
export function docsNonArraySelect(id = `edge-${nextSeq()}`) {
  return {
    type: 'extension_ui_request',
    id,
    method: 'select',
    title: PLAN_REVIEW_MARKER,
    options: [JSON.stringify({ docs: 'not-an-array' })],
  };
}

/** 超限：plan-review payload 自审字段 > 4KB 截断域（D9 写侧 4KB 上限的对侧边界输入）。 */
export function oversizedPlanReviewSelect(id = `edge-${nextSeq()}`) {
  return planReviewSelect({
    id,
    docs: [{ fileName: 'plan.md', absPath: '/edge/plan.md', sourceSkill: '', version: 1 }],
    selfReview: 'X'.repeat(8 * 1024),
  });
}

/** 超限：plan-state entry requirement > 64KB（plan-state-extractor 读侧 capTo 截断域）。 */
export function oversizedPlanStateEntry() {
  return planStateEntry({
    isActive: true,
    planFilePath: '/edge/plan.md',
    requirement: 'R'.repeat(70 * 1024),
    templateName: null,
    skills: [],
    docs: [],
  });
}

/** 超限：message_end 巨文本（投影链有界性边界输入）。 */
export function oversizedMessageEnd(role = 'assistant') {
  return messageEnd(role, 'M'.repeat(200 * 1024));
}

/** error envelope 用例帧（应答形态：success:false + error）。 */
export function errorEnvelopeResponse(id = `edge-${nextSeq()}`) {
  return responseError(id, 'prompt', 'mock-pi: injected error envelope');
}

/** 边界帧注册表（scenario rawFrames 的 `{"__frame__": <name>}` 引用形态）。 */
export const BOUNDARY_FRAMES = {
  'empty-options-select': emptyOptionsSelect,
  'blank-option-select': blankOptionSelect,
  'illegal-json-select': illegalJsonSelect,
  'docs-nonarray-select': docsNonArraySelect,
  'oversized-plan-review-select': oversizedPlanReviewSelect,
  'oversized-plan-state-entry': oversizedPlanStateEntry,
  'oversized-message-end': oversizedMessageEnd,
  'error-envelope-response': errorEnvelopeResponse,
};

// ── session entry（plan-state 快照）────────────────────────────────

/**
 * plan-state custom entry——字段集镜像 `extensions/universal/plan/src/state.ts`
 * `persistPlanState` 的 appendEntry 载荷（现版 schema；optional 字段 undefined 时
 * JSON 序列化自然消失）。mock pi 以「pi-plan 扩展现版行为」的身份写入 session JSONL。
 */
export function planStateEntry(data) {
  const d = {
    isActive: data.isActive === true,
    planFilePath: data.planFilePath ?? null,
    requirement: data.requirement ?? null,
    templateName: data.templateName ?? null,
    templateProvidedPath: data.templateProvidedPath,
    skills: data.skills ?? [],
    docs: data.docs ?? [],
    reviewState: data.reviewState,
    reviewStateSource: data.reviewStateSource,
    lastSubmitReviewDocsFingerprint: data.lastSubmitReviewDocsFingerprint,
  };
  return { type: 'custom', customType: 'plan-state', data: d };
}

// ── 内部 ───────────────────────────────────────────────────────────

let seq = 0;
function nextSeq() {
  seq += 1;
  return seq;
}
