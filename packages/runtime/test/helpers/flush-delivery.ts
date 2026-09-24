/**
 * flush 投递交接异步链（port.send → ensureActive → inject → prompt → 三副作用置位）——
 * dispatcher 只提交，出站交接异步落在投递注册表适配层，断言前须推进微任务。
 *
 * ticks 是冲洗次数的安全余量而非精确步数；按各测试链路深度选档（默认 40 档，
 * 浅链路文件显式传 30），档位差异必须保留，不得静默统一。
 */
const DEFAULT_FLUSH_TICKS = 40

export async function flushDelivery(ticks: number = DEFAULT_FLUSH_TICKS): Promise<void> {
  for (let i = 0; i < ticks; i += 1) await Promise.resolve()
}
