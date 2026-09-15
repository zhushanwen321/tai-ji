/**
 * 排空微任务队列：固定 ticks 次 `await Promise.resolve()`，把 fire-and-forget
 * promise 链推进到稳定态。递归而非 for 循环——固定 tick 排空不是逐项串行等待，
 * no-await-in-loop 豁免形态统一收敛到本函数（项目纪律禁行内 disable）。
 *
 * 不用 vi.waitFor 的场景：反向断言（「X 未发生」）下 waitFor 会一满足即返回，
 * 必须先跑满固定 tick 再静态断言。
 */
export async function flushMicrotasks(ticks = 10): Promise<void> {
  if (ticks <= 0) return;
  await Promise.resolve();
  await flushMicrotasks(ticks - 1);
}
