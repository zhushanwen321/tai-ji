/**
 * 阶段 2 的 main 同步（fetch → 领先防护 → checkout → reset → 取 HEAD）。
 *
 * 数据丢失防护（reset --hard 前两道）：①本地 main 不领先远端（领先防护——发布流程
 * 自身会制造领先窗口：阶段 4 bump commit / 阶段 5 notes commit 之后、push 之前重跑
 * 阶段 2 即是，无条件 reset 会把未 push 的 commit 拨回，仅 reflog 可恢复）；②工作区
 * 无未提交的 tracked 改动（脏树防护——阶段 4 bump 中途崩溃的半成品、AI/人工留下的
 * 改动会被 reset --hard 静默抹掉且 reflog 不可恢复；untracked 文件 reset --hard
 * 不删，不属本防线损害形态）。同理 fetch / checkout / status 的退出码
 * 必须逐一检查：fetch 失败后 reset 到的是陈旧远端引用；checkout 失败时 reset 移动的
 * 是当前 checkout 分支的指针（无论那是什么分支）；status 失败被当「干净」放行 =
 * 脏树防线静默失效。
 *
 * 纯依赖注入（run 注入）——供 scripts/__tests__/merge-sync.test.mjs 做回归测试。
 */

/**
 * 同步本地 main 到 github/main。
 *
 * 返回 { ok: true, mainSha } ——mainSha = 同步后 main HEAD（merge commit 或其后的
 * 远端 tip），供阶段 3 wait-for-ci 作为 push CI 的判定对象落盘（mergeSha）。
 * 返回 { ok: false, step, ... } ——step ∈ fetch / ahead-count / ahead-guard /
 * checkout / status / dirty-tree / reset / head-sha；ahead-guard 附 ahead 数，
 * fetch/checkout 附手动恢复命令，dirty-tree 附处置提示。
 */
export function syncMain({ run, mainWt, ghRemote = 'github' }) {
  const fetchRes = run('git', ['-C', mainWt, 'fetch', ghRemote, 'main'])
  if (!fetchRes.ok) {
    return { ok: false, step: 'fetch', hint: `git -C ${mainWt} fetch ${ghRemote} main` }
  }
  // 领先防护只读 ref（rev-list 不依赖 checkout 位置），在 checkout/reset 之前判
  const aheadRes = run('git', ['-C', mainWt, 'rev-list', '--count', `${ghRemote}/main..main`], { stdio: 'capture' })
  if (!aheadRes.ok) return { ok: false, step: 'ahead-count' }
  // 空输出显式拒绝：Number('') === 0 会被当「不领先」放行，防线静默失效
  const aheadOut = aheadRes.stdout.trim()
  const ahead = Number(aheadOut)
  if (aheadOut === '' || !Number.isFinite(ahead)) return { ok: false, step: 'ahead-count' }
  if (ahead > 0) return { ok: false, step: 'ahead-guard', ahead }
  // checkout 退出码即权威判据（成功 = 分支已切到 main），reset 只在其后执行
  const checkoutRes = run('git', ['-C', mainWt, 'checkout', 'main'])
  if (!checkoutRes.ok) {
    return { ok: false, step: 'checkout', hint: `git -C ${mainWt} checkout main` }
  }
  // 脏树防护：reset --hard 会抹掉未提交的 tracked 改动（reflog 不可恢复，领先防护
  // 不覆盖），故 status 只查 tracked 改动（--untracked-files=no）——reset --hard
  // 不删 untracked 文件，?? 行计入即误挡无损害场景。status 退出码必须检查——失败
  // 被当「干净」放行即防线静默失效（同 ahead-count 的空输出显式拒绝）
  const statusRes = run('git', ['-C', mainWt, 'status', '--porcelain', '--untracked-files=no'], { stdio: 'capture' })
  if (!statusRes.ok) return { ok: false, step: 'status' }
  if (statusRes.stdout.trim() !== '') {
    return { ok: false, step: 'dirty-tree', hint: '未提交的 tracked 改动先 commit/stash 或确认丢弃后重跑' }
  }
  const resetRes = run('git', ['-C', mainWt, 'reset', '--hard', `${ghRemote}/main`])
  if (!resetRes.ok) return { ok: false, step: 'reset' }
  const headRes = run('git', ['-C', mainWt, 'rev-parse', 'HEAD'], { stdio: 'capture' })
  if (!headRes.ok) return { ok: false, step: 'head-sha' }
  return { ok: true, mainSha: headRes.stdout.trim() }
}
