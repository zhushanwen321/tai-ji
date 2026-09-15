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
 * clientUuid 从发送文本提取（`<!--taiji:msg:<uuid>-->`，与 pi 侧 msg-id-mapper TAG_MATCH
 * 同款全文正则——全文匹配使降级拼接把块放到标记之后也不影响提取）。[双侧同构字面量]
 * 标记格式 SSOT = extensions/taiji/msg-id-mapper/src/index.ts（TAG_MATCH 常量，写入/剥离
 * 两端协议），本正则是消费侧同构镜像，禁单侧修改——不收敛 shared：extension 独立发布
 * 体系不依赖 @taiji/shared（S4 裁决，注释互指替代）。纯文本消息与
 * steer/followUp 路径无此标记 → payload 缺省该字段（类型可空，u5 按可空消费）。
 */
const MSG_ID_TAG_RE = /<!--taiji:msg:(u-[0-9a-fA-F-]{36})-->/

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
  const clientUuid = sentText.match(MSG_ID_TAG_RE)?.[1]
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
