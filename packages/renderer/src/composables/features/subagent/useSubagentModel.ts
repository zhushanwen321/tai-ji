/**
 * useSubagentModel —— subagent / workflow run 执行模型切换编排（subagent-model-switch
 * §7.1 入口层前端半边；R2 features 层，跨 api + 回执态的唯一合法层，ADR-0028「api 调用
 * 只在 features 层」落点）。
 *
 * 回执消费范式照 useModel.ts 现役范式（U6 弃乐观写）：**应答到达才写显示态，禁用请求值
 * 乐观写**——已生效型的生效模型可能 ≠ 请求目标（pi 模型族静默替换成同族模型，§6.4）；
 * 已记账型不携带档位值。RPC 失败默认不写任何状态（标签维持切换前显示——分支③由本范式
 * 构造性成立），唯一例外 = 「记账已写」型错误码（SUBAGENT_SET_MODEL_ACCOUNTED_ERROR_CODES，
 * D3 缺陷七：宿主先写覆盖记账再回错误，错误即意图受理凭证——badge 同已记账型通道亮灯；
 * chat 域走 catch 通道，run 级聚合的该分型内联在聚合应答失败名单（reply.failures），按
 * 成员键同权责亮灯）。
 *
 * 显示态（回执态）的归属与生命周期：renderer 会话期内存（模块级 reactive Map，跨组件
 * 实例共享——SubagentTab / WorkflowTab 各自调本 composable 读同一份）；**不写
 * SubagentRecord.model 等详情载荷字段**（那是 runtime 详情载荷组装的域，前端写它会
 * 被下一帧 runtime 推送冲掉）。重载后回执态随组件生命周期丢失，标签由详情载荷字段
 * 承接（分支④「最近生效值」——仅活进程在场 / 覆盖状态），见 resolveSubagentModelDisplay。
 */
import { reactive } from 'vue'
import { useI18n } from 'vue-i18n'
import { toErrorMessage } from '@taiji/core'
import { subagent as subagentApi } from '@/api'
import { useToast } from '@/composables/useToast'
import type { ProviderId, SubagentSetModelReply, SubagentStatus, WorkflowAgentCall } from '@taiji/shared'
import { SUBAGENT_SET_MODEL_ACCOUNTED_ERROR_CODES } from '@taiji/shared'

/**
 * 单目标的模型显示态（renderer 会话期回执态）。
 * effectiveModel 与 overrideIntent 同场并存（F1-31 裁决候选 A）：已生效型回执同时写
 * 生效值与意图 ref——回执本身即用户意图的受理凭证，「用户覆盖中」badge 的事实依据 =
 * 意图已受理，不等待 record.modelOverride 载荷重推（D3 缺陷四轮内空窗修复）；已记账型
 * 只写 overrideIntent（无回读源，标签承接不变）。读取端按 resolveSubagentModelDisplay
 * 的优先级合成（生效值优先、意图承覆盖标注）。
 */
export interface SubagentModelDisplayState { // oe-exempt:20261006:framework:wire 展示契约形状（u-foundation 定形，单实现常态）
  /** 已生效型回执的生效模型（canonical ref 串 'provider/id'——引擎回读值）。 */
  effectiveModel?: string
  /** 已记账型回执的覆盖意图值（本次切换目标——分支②「已记账型标签显示覆盖值」）。 */
  overrideIntent?: string
  /** 已生效型回执的生效 thinking 档位（§6.4：热切联动重设后的实际档位，防面板档位与生效值脱节）；回执缺省不写。 */
  thinkingLevel?: string
}

/** 模型标签显示态（四分支合成输出）。 */
export interface SubagentModelDisplay {
  /** 标签文本（undefined = 无可显示值——消费方按现状隐藏槽位）。 */
  label: string | undefined
  /** 「用户覆盖中」标注在场（覆盖意图已表达——§7 实现期同步义务的前端标注）。 */
  overridden: boolean
}

/** 显示态键：chat 域 = recordId；workflow 域 = `${runId}:${memberRunId}`（成员标识 = 聚合应答与成员态数组的同维成员 runId，§7.1）。 */
type DisplayKey = string

/** workflow 成员显示键（runId + 聚合成员标识）。 */
export function subagentMemberDisplayKey(runId: string, memberRunId: string): DisplayKey {
  return `${runId}:${memberRunId}`
}

/**
 * 「记账已写」分型判定（词表成员守卫）：run 级失败名单成员的 reason 落在该词表 =
 * 宿主对该成员已写覆盖记账（覆盖已受理、重派生效），错误本身即意图受理凭证——
 * 与 chat 域 catch 通道同权责（词表语义见 SUBAGENT_SET_MODEL_ACCOUNTED_ERROR_CODES）。
 */
function isAccountedErrorCode(reason: string): boolean {
  return (SUBAGENT_SET_MODEL_ACCOUNTED_ERROR_CODES as readonly string[]).includes(reason)
}

/**
 * 回执态注册表（模块级单例——renderer 会话期，跨组件实例共享；测试经
 * resetSubagentModelDisplayForTests 隔离）。
 *
 * @data-owner #58 —— #58 subagent 模型切换回执显示态（登记表主表正向条目，2026-10-07
 * dev-merge branch-review dmg-r1-7 按 #57 先例由 W24-EX-B 豁免转正）：切换回执的显示态
 * （生效值 / 覆盖意图），生命周期 = 页面会话期，重载后由详情载荷字段承接（标签读取
 * 规则分支④）；session 删除无清理口、页面刷新收敛（显式取舍，登记表 #58 例外列）。
 */
const displayStates = reactive(new Map<DisplayKey, SubagentModelDisplayState>())

/** 测试隔离：清空回执态注册表（生产禁用——会话期态，生产生命周期 = 页面刷新）。 */
export function resetSubagentModelDisplayForTests(): void {
  displayStates.clear()
}

/** canonical ref 串（'provider/id'）。 */
function toModelRef(provider: string, modelId: string): string {
  return `${provider}/${modelId}`
}

/** 四分支合成输入（详情载荷面 + 回执态面）。 */
export interface SubagentModelDisplayInput { // oe-exempt:20261006:framework:wire 展示输入契约形状（u-foundation 定形，单实现常态）
  /** 回执态（renderer 会话期；未切换过 / 重载后 = undefined）。 */
  display?: SubagentModelDisplayState
  /** 盖章值（record.model / call.model，现状兜底）。 */
  stampedModel?: string
  /** 覆盖状态（详情载荷 modelOverride.model；无覆盖 undefined）。 */
  modelOverride?: string
  /** 最近生效值（详情载荷 recentEffectiveModel——pi session model_change 尾条目）。 */
  recentEffectiveModel?: { provider: string; modelId: string }
  /** 详情载荷主体执行状态（chat 域 = SubagentRecord.status；workflow 域 = WorkflowAgentCall.status）。
   *  分支④活进程门控（§6.4/§9 消费域三条件之一）：仅 'running' 时分支④可达。 */
  recordStatus?: SubagentStatus | WorkflowAgentCall['status']
}

/**
 * 标签读取规则四分支（subagent-model-switch §9 文件地图 transport 行；纯函数可单测）：
 * ① 生效值在场（回执态）→ 显示实际生效值（热切回读值；同族替换时生效值 ≠ 覆盖意图，
 *    如实显示生效值）；
 * ② 已记账型路径（回执 recorded，或重载后仅覆盖状态载荷在场）→ 显示覆盖意图值 +
 *    「用户覆盖中」标注——§6.4：无回读源的已记账型路径标签 = 覆盖意图值（= 下次 spawn
 *    解析裁决值）；已记账回执在场时优先于载荷「最近生效值」——后者是同会话早前热切的
 *    历史生效值，不是本次切换后的生效事实，其消费域仅限④分叉态重载（回执态整体缺席）；
 * ③ 生效值回读失败 → 不落本函数输入（错误应答不写显示态），标签维持切换前显示——由
 *    「禁乐观写 + 失败不写」构造性成立，无显式分支；
 * ④ 分叉态重载（面板重载 + 同族替换已发生 + **活进程在场**，回执态已丢）→ 按详情载荷
 *    「最近生效值」显示，不回退覆盖意图值——门控依据（§6.4/§9 消费域三条件）：分支④
 *    语义是「重载后显示轮内生效值」，只对正在运行的成员有意义；已结束成员的重载显示
 *    走覆盖意图（②'，与「用户覆盖中」badge 同源）或盖章值。pi 成员的 recentEffectiveModel
 *    恒有值（spawn 首条即写 model_change），无门控时②'恒不可达、recorded 型切换重载后
 *    标签与实际生效值背离。
 *
 * 优先级链：回执生效值 > 回执覆盖意图（已记账回执优先于载荷最近生效值）> 载荷最近生效值
 * （仅回执态整体缺席且活进程在场——分叉态重载）> 载荷覆盖状态 > 盖章值（现状兜底）。
 * overridden = 覆盖意图在场（覆盖状态载荷字段或已记账回执）——覆盖生效处显式标注
 * 「用户覆盖中」（§7 实现期文档同步义务的前端部分）。
 */
export function resolveSubagentModelDisplay(input: SubagentModelDisplayInput): SubagentModelDisplay {
  const overrideIntent = input.display?.overrideIntent ?? input.modelOverride
  // ① 回执生效值在场（覆盖标注按覆盖意图在场性——生效值 ≠ 覆盖意图时仍如实显示生效值）
  if (input.display?.effectiveModel !== undefined) {
    return { label: input.display.effectiveModel, overridden: overrideIntent !== undefined }
  }
  // ② 已记账型回执在场（本次切换无活进程）：显示本次覆盖意图值（§6.4 口径），不显示
  //    载荷「最近生效值」（同会话早前热切的历史值——记账型切换后它已不代表生效事实）
  if (input.display?.overrideIntent !== undefined) {
    return { label: input.display.overrideIntent, overridden: true }
  }
  // ④ 分叉态重载（回执态整体缺席 + 活进程在场——recordStatus === 'running'）：
  //    详情载荷最近生效值承接（不回退覆盖意图值）。门控语义：「重载后显示轮内生效值」
  //    只对正在运行的成员有意义（§6.4/§9 消费域三条件）；已结束成员不吃
  //    recentEffectiveModel（pi 成员该值恒有值——spawn 首条即写 model_change），落到
  //    ②' 覆盖意图或盖章值
  if (input.recordStatus === 'running' && input.recentEffectiveModel !== undefined) {
    return {
      label: toModelRef(input.recentEffectiveModel.provider, input.recentEffectiveModel.modelId),
      overridden: overrideIntent !== undefined,
    }
  }
  // ②' 重载后仅覆盖状态载荷在场：覆盖意图值 + 标注
  if (overrideIntent !== undefined) {
    return { label: overrideIntent, overridden: true }
  }
  // 兜底：盖章值（从未切换——现状语义不变）
  return { label: input.stampedModel, overridden: false }
}

/**
 * thinking 槽取值（§6.4 展示口径的档位半边，纯函数可单测）：热切回执的生效档位
 * （展示态 thinkingLevel——pi setModel 联动重设后的实际档位）优先，回退启动盖章值
 * （record.thinkingLevel）。回执缺省档位字段时展示态不写（UI 跟随事实，禁乐观回显），
 * 此处自然回退盖章值——面板档位不与实际生效值脱节（§6.4 不采用理由）。
 */
export function resolveSubagentThinkingLevel(
  display: SubagentModelDisplayState | undefined,
  stampedLevel: string | undefined,
): string | undefined {
  return display?.thinkingLevel ?? stampedLevel
}

/** setSubagentModel 的目标参数（wire 契约：recordId 与 runId 二选一；provider 品牌类型随 wire 契约）。 */
export interface SubagentSetModelTarget { // oe-exempt:20261006:framework:wire 切换目标契约形状（u-foundation 定形，单实现常态）
  recordId?: string
  runId?: string
  provider: ProviderId
  modelId: string
  thinkingLevel?: string
}

/**
 * useSubagentModel：提交走 subagent.setModel 新消息 + 回执写显示态（禁乐观写）+
 * 失败 toast（§5.2 错误文案经 toErrorMessage 直出——runtime 已按分型给可操作文案）。
 */
export function useSubagentModel() {
  const { t } = useI18n()
  const { error: toastError } = useToast()

  /** chat 域目标的显示态读取（响应式——Map 项变化触发重算）。 */
  function displayOf(recordId: string): SubagentModelDisplayState | undefined {
    return displayStates.get(recordId)
  }

  /** workflow run 成员目标的显示态读取（响应式；成员标识 = 聚合成员 runId）。 */
  function memberDisplayOf(runId: string, memberRunId: string): SubagentModelDisplayState | undefined {
    return displayStates.get(subagentMemberDisplayKey(runId, memberRunId))
  }

  /**
   * 提交切换：请求 → runtime → 宿主编排 → 应答三形态分流写显示态：
   * - chat 两型：effective → 写 effectiveModel（回读生效值）+ overrideIntent（意图受理
   *   凭证——F1-31 裁决候选 A）；recorded → 写 overrideIntent
   *   （本次目标——「已记录，下次执行生效」的标签承接）；
   * - run 级聚合：按成员键写——switched 成员写生效值；not-active / not-applicable 成员写
   *   overrideIntent（记账路径，重派生效）；失败名单成员不写生效值（分支③），但
   *   「记账已写」分型（SUBAGENT_SET_MODEL_ACCOUNTED_ERROR_CODES）补写 overrideIntent
   *   亮 badge（与 chat 域 catch 通道同权责），toast 分项呈现照常（成员标识 + 失败分型）。
   *
   * @returns 应答（成功）；失败返回 undefined（toast 已报，显示态未动）。
   */
  async function setSubagentModel(target: SubagentSetModelTarget): Promise<SubagentSetModelReply | undefined> {
    try {
      const reply = await subagentApi.setModel(target)
      applyReplyToDisplay(target, reply)
      return reply
    } catch (e) {
      // 「记账已写」型错误（D3 缺陷七）：处置表行 3/7（快照型 / 回读失败型）的错误
      // 应答在宿主侧先写了覆盖记账再回错误——错误本身即意图受理凭证，badge 与
      // 已记账型同通道亮灯（overrideIntent），不等轮边界载荷重推（缺陷四同机制）。
      // 词表外错误（credential_missing 未写 / 校验型未写 / 通道型未知）一律不写。
      const code = (e as { code?: unknown }).code
      if (
        target.recordId !== undefined &&
        typeof code === 'string' &&
        (SUBAGENT_SET_MODEL_ACCOUNTED_ERROR_CODES as readonly string[]).includes(code)
      ) {
        displayStates.set(target.recordId, { overrideIntent: toModelRef(target.provider, target.modelId) })
      }
      toastError(t('panel.sideDrawer.modelSwitchFailed', { msg: toErrorMessage(e) }))
      return undefined
    }
  }

  /** 应答 → 显示态写入（setSubagentModel 的状态半边；导出供测试直驱回执消费断言）。 */
  function applyReplyToDisplay(target: SubagentSetModelTarget, reply: SubagentSetModelReply): void {
    const intentRef = toModelRef(target.provider, target.modelId)
    if ('kind' in reply) {
      // chat 域两型（recordId 目标）
      const key = target.recordId
      if (key === undefined) return
      if (reply.kind === 'effective') {
        displayStates.set(key, {
          effectiveModel: toModelRef(reply.effectiveModel.provider, reply.effectiveModel.modelId),
          // 意图受理凭证（F1-31 裁决候选 A）：回执型同时携带意图 ref（本次切换目标——
          // 应答 wire 无意图字段，取请求目标 ref，回执即该意图的受理凭证）——badge 事实
          // 依据 = 意图已受理，消除 record.modelOverride 重推前的轮内空窗（D3 缺陷四）
          overrideIntent: intentRef,
          // §6.4：切换回执连生效档位一起同步（面板 thinking 档位随热切更新）；回执缺省
          // 该字段不写（UI 跟随事实，禁乐观回显——读取端回退启动盖章值）
          ...(reply.effectiveThinkingLevel !== undefined ? { thinkingLevel: reply.effectiveThinkingLevel } : {}),
        })
      } else {
        displayStates.set(key, { overrideIntent: intentRef })
      }
      return
    }
    // run 级聚合（runId 目标）：按成员键分写（成员标识 = 聚合成员 runId）
    const runId = target.runId
    if (runId === undefined) return
    for (const member of reply.members) {
      const key = subagentMemberDisplayKey(runId, member.runId)
      if (member.state === 'switched' && member.effectiveModel !== undefined) {
        displayStates.set(key, {
          effectiveModel: toModelRef(member.effectiveModel.provider, member.effectiveModel.modelId),
          // 成员生效档位为 optional（wire 契约：仅回读成功成员携带）：缺省不写，
          // 同上「UI 跟随事实」——档位未知时不虚构，读取端回退盖章值
          ...(member.effectiveThinkingLevel !== undefined ? { thinkingLevel: member.effectiveThinkingLevel } : {}),
        })
      } else if (member.state === 'not-active' || member.state === 'not-applicable') {
        displayStates.set(key, { overrideIntent: intentRef })
      }
      // switched 但无生效值（契约外形态）：不写（禁虚构生效值）
    }
    for (const failure of reply.failures) {
      // 失败名单成员：生效值未知（分支③，不写 effectiveModel），但「记账已写」分型
      // （快照型 / 回读失败型——宿主转发前已写 run 级意图，该成员重派吃覆盖）与 chat
      // 域同权责亮 badge（overrideIntent）；词表外（credential_missing / 透传码）不写。
      if (isAccountedErrorCode(failure.reason)) {
        displayStates.set(subagentMemberDisplayKey(runId, failure.runId), { overrideIntent: intentRef })
      }
      // toast 分项呈现照常（错误应答的失败事实必须可见——显示态补写不吞错误）
      toastError(t('panel.sideDrawer.modelSwitchMemberFailed', { member: failure.runId, reason: failure.reason }))
    }
  }

  return { setSubagentModel, displayOf, memberDisplayOf, applyReplyToDisplay }
}
