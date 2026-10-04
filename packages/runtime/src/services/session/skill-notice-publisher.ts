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
import { MSG_ID_UUID_SEGMENT } from '@taiji/shared'
import type { SkillNotice } from './skill-injector.js'
import type { IMessageBus } from '../message-bus/message-bus.js'

/**
 * clientUuid 从发送文本提取：正则由 shared MSG_ID_UUID_SEGMENT 构造（uuid 段单点，
 * [MF-1-11]），**只认 renderer 气泡 id 形态**（`u-<uuid>` / 裸 `<uuid>`）——刻意不含
 * MSG_ID_TAG_RE 的 `m-` 收养分支（2026-10-04 收编）：notice 的 clientUuid 用于气泡
 * 锚定，收养条目无本地气泡、锚定无意义，误提取会把收养 id 误装成 `u-` 气泡 id 形态。
 * payload 的 clientUuid 恒出 `u-<uuid>` 形态，与既有消费方（notice → 气泡锚定）契约
 * 逐字一致；无 uuid 标记（收养 id / steer 通路）→ 字段缺省（类型可空，u5 按可空消费）。
 */
const BUBBLE_ANCHOR_MARKER_RE = new RegExp(`<!--taiji:msg:(u-)?(${MSG_ID_UUID_SEGMENT})-->`, 'i')

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
  const matched = sentText.match(BUBBLE_ANCHOR_MARKER_RE)?.[2]
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
