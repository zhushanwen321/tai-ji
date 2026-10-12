import { expect } from 'vitest'
import { translate } from '../event-adapter'

/**
 * 取 translate 产物中 turn-end 的 message.complete 帧（retry-sound / turn-usage-sum
 * 两文件的取帧 helper 单源；断言帧类型存在性）。
 */
export function expectCompleteMessage(translated: ReturnType<typeof translate>): {
  type: string
  payload: Record<string, unknown>
} {
  const turnEnd = translated.find((e) => e.kind === 'turn-end')
  expect(turnEnd).toBeDefined()
  const message = (turnEnd as { message: { type: string; payload: Record<string, unknown> } }).message
  expect(message.type).toBe('message.complete')
  return message
}
