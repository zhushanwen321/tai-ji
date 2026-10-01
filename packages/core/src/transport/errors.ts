/**
 * transport 域错误构造工厂（renderer-deepening D10①）。
 *
 * `code: 'disconnected'` 是「传输断开类失败」的字符串契约——生产消费方不判等，只读
 * error.code 字符串透传（useFileTree 存 reason）；`error.code === 'disconnected'` 等值
 * 断言在钉住测试（transport/__tests__/errors.test.ts），任何一处手写字面量拼错即静默
 * 失配（编译器无信号）。此前 4 处
 * （api/request.ts send-fail、use-connection.ts stateWatch 两分支 + queue-drop）
 * 各自 Object.assign 手写，靠注释互相对齐——收编为单点后新增构造只能走本工厂。
 */
export interface TransportUnavailableError extends Error {
  code: 'disconnected'
}

/**
 * 构造传输不可用错误（code='disconnected' 字面量唯一出处）。
 *
 * @param message 展示文案（调用方决定来源：i18n key 经 ports.t 解析，或固定英文）
 */
export function transportUnavailableError(message: string): TransportUnavailableError {
  const error = new Error(message) as TransportUnavailableError
  error.code = 'disconnected'
  return error
}

/**
 * 「消息未送达 runtime 消息处理链」的传输失败（TransportUnavailableError 的收窄形态）。
 *
 * 与普通传输断开的关键区别：本形态**可证明**请求没有抵达 runtime 处理链（send() 返回
 * false 消息没离机 / pre-auth 队列被丢弃），消费方可据此安全判定「未执行」（如 bash
 * 回执翻译为 rejected、恢复 !command 草稿不会双执行）；而断连 rejectAll 的同 code 错误
 * 只能证明「reply 没回来」——请求可能已送达并执行，消费方必须保守处置。
 */
export interface NotDeliveredError extends TransportUnavailableError {
  notDelivered: true
}

/** 构造「未送达」传输错误（notDelivered 标记唯一出处）。 */
export function notDeliveredError(message: string): NotDeliveredError {
  const error = transportUnavailableError(message) as NotDeliveredError
  error.notDelivered = true
  return error
}

/** 判定错误是否为「消息未送达 runtime」形态（消费方据它区分「可证明未执行」与「判定未知」）。 */
export function isNotDeliveredError(e: unknown): e is NotDeliveredError {
  return typeof e === 'object' && e !== null && (e as { notDelivered?: unknown }).notDelivered === true
}
