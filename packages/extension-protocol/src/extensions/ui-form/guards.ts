/**
 * 统一提问表单（ui-form）的形状守卫。
 *
 * isFormQuestion 按 type 判别分支逐项校验（白名单风格：必填字段类型校验、可选
 * 字段校验、未知字段忽略——与 isAskUserQuestion / isScheduleDraft 同构语义）。
 * 三个消费点失败策略各异（设计 D2）：
 * - 发送侧（uiFormInteract 内）：不合法项抛错（调用方编码 bug，fail-fast）；
 * - event-adapter：逐项过滤，合法项 ≥1 才产 form 帧、全不合法降级普通 select；
 * - renderer：复核守卫，不合法项跳过 + warn，全部不合法 → overlay 错误占位仅取消可点。
 *
 * isFormAnswers 校验回包形状（Record<string, string>）：键动态（key = header ??
 * question）无法枚举白名单，故只校验值域全 string；JSON 合法但非本形状由
 * uiFormInteract 折叠 non-json（协议版本错配类故障）。
 */

import type { FormAnswers, FormOption, FormQuestion } from './types'
import { isScheduleDraft } from '../scheduler-create/helpers'

/** 形状守卫公共前置：非 null 的普通对象（排除数组；JSON.parse 产物均为 JSON 值） */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 选项条目：label 必填 string，description 可选 string（未知字段忽略） */
function isFormOption(value: unknown): value is FormOption {
  if (!isPlainRecord(value)) return false
  const o = value
  return typeof o.label === 'string'
    && (o.description === undefined || typeof o.description === 'string')
}

/** 选项数组逐项校验（空数组形状合法——语义完备性由调用方/渲染器处理，守卫只管形状） */
function isFormOptionArray(value: unknown): value is FormOption[] {
  return Array.isArray(value) && value.every(isFormOption)
}

/**
 * 类型守卫：验证 unknown 是否为合法的 FormQuestion（choice / text / schedule 三分支）。
 * 用于发送侧 fail-fast、event-adapter 逐项过滤与 renderer 复核（三消费点见文件头）。
 */
export function isFormQuestion(value: unknown): value is FormQuestion {
  if (!isPlainRecord(value)) return false
  const q = value
  // 公共字段（三类型共享）：question 必填，header / context 可选
  if (typeof q.question !== 'string') return false
  if (q.header !== undefined && typeof q.header !== 'string') return false
  if (q.context !== undefined && typeof q.context !== 'string') return false
  if (q.type === 'choice') {
    return isFormOptionArray(q.options)
      && (q.multi === undefined || typeof q.multi === 'boolean')
      && (q.allowOther === undefined || typeof q.allowOther === 'boolean')
  }
  if (q.type === 'text') return true
  if (q.type === 'schedule') {
    // initial 复用 scheduler-create 的深度守卫：携带即必须形状合法
    return q.initial === undefined || isScheduleDraft(q.initial)
  }
  return false
}

/** 类型守卫：验证 unknown 是否为合法的 FormAnswers（值域全 string 的普通对象） */
export function isFormAnswers(value: unknown): value is FormAnswers {
  if (!isPlainRecord(value)) return false
  return Object.values(value).every((v) => typeof v === 'string')
}
