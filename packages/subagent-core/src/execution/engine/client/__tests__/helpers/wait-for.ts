/**
 * 集成轨轮询等待（真实 timers）：真实子进程的信号传播 / 退出回执有毫秒级延迟，事件
 * 无法即时可得，按步进轮询谓词至成立或超时。供引擎客户端族集成门控用例（真 spawn
 * fake-engine 形态）共用，禁 fake timers（会挂死自写轮询）。
 *
 * 消费方：同目录 engine-client.test.ts / remote-engine.test.ts、
 * src/__tests__/transport-local.test.ts。
 *
 * 节拍 1ms：谓词先立即求值、之后按节拍重查——节拍只影响「条件已成立」到「被发现」的
 * 延迟上限，不影响超时语义；25ms 节拍会让每次 ready/退出等待白付一个节拍。
 */
export async function waitFor(predicate: () => boolean, timeoutMs = 5_000, stepMs = 1): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  throw new Error("waitFor: condition not met within timeout");
}
