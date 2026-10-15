/**
 * choice/text 问题的答案编辑状态（FormOverlay 壳持有，渲染器经 v-model 编辑）。
 *
 * 实现已收敛 @taiji/ui/extension-host form-protocol 共享纯模块（MF-1-8：ui-form 编码契约
 * 双壳单点——问题 key / 已答判定 / FormAnswers envelope 编码 / schedule 草稿回显构造）；
 * 本文件保留为桌面 form 渲染器（ChoiceQuestion / TextQuestion）的 import 路径稳定层——
 * 纯 re-export 转发，无独立实现。
 */
export { initialQuestionState, OTHER_VALUE, type QuestionState } from '@taiji/ui/extension-host'
