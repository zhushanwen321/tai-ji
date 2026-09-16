/**
 * skillNotice 广播编排共享函数（adversarial-review-fixes A2 D-A2-2 提取）。
 *
 * 原为 MessageDispatcher 私有方法（composer-multi-skill-injection D6/D8，三入口
 * 共用）；A2 给 subagentAction（session-records.ts）与 deliverText
 * （session-delivery-registry.ts）两个新挂载点同款复用，提取为本模块——注入器本体
 * 保持「只产出 notices 不发消息」（skill-injector.ts 类注释契约），广播编排收敛于此。
 *
 * 时机契约（调用方必须遵守）：发送成功（client.prompt/steer/followUp await 无异常）
 * 之后才调用——提示描述的注入形态此时才成立；发送失败路径不发（用户可见错误已由
 * 各自的错误通路覆盖）。
 */
import type { SkillNotice } from './skill-injector.js'
import type { IMessageBus } from '../message-bus/message-bus.js'

/**
 * clientUuid 从发送文本提取（`<!--taiji:msg:<uuid>-->`，全文匹配使降级拼接把块放到标记之后
 * 也不影响提取）。
 *
 * **双形态**（[u2 投递所有权内核] 契约扩展）：`u-<uuid>`（renderer/msg-id-mapper 写入面，
 * 与 extensions/taiji/msg-id-mapper 的 TAG_MATCH 同构——该侧标记会被 input hook 剥离）
 * 与**裸 uuid**（内核出站标记形态，D2：内核侧出站身份必须存活进 transcript 供送达回执匹配，
 * 故刻意用不被 msg-id-mapper TAG_STRIP 命中的裸形态）。两形态指向同一 clientUuid——
 * 回归时（renderer 拼 u- 形态 + 内核追加裸形态）首个命中即正确值。
 * payload 的 clientUuid 恒出 renderer 气泡 id 形态（`u-<uuid>`），与既有消费方（notice →
 * 气泡锚定）契约逐字一致；无标记（生成 id / steer 通路）→ 字段缺省（类型可空，u5 按可空消费）。
 */
const MSG_ID_TAG_RE = /<!--taiji:msg:(?:u-)?([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})-->/

/**
 * 逐条定向发布 skill 注入提示（session.skillNotice，payload 契约见 protocol.ts）。
 * notices 为空 no-op；bus 为 null/undefined（晚期注入前 / 测试未装配）同样 no-op——
 * 与 SessionRecordsDeps「getMessageBus 未注入时 null → 广播 no-op」语义同构。
 */
export function publishSkillNotices(
  bus: IMessageBus | null | undefined,
  sessionId: string,
  sentText: string,
  notices: SkillNotice[],
): void {
  if (notices.length === 0) return
  const matched = sentText.match(MSG_ID_TAG_RE)?.[1]
  const clientUuid = matched !== undefined ? `u-${matched.toLowerCase()}` : undefined
  for (const notice of notices) {
    bus?.publish(sessionId, {
      type: 'session.skillNotice',
      payload: {
        sessionId,
        ...(clientUuid !== undefined ? { clientUuid } : {}),
        reason: notice.reason,
        skills: notice.skills,
      },
    })
  }
}
