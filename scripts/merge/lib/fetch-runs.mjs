/**
 * gh run list 查询闭包工厂（按 commit 查 workflow runs 的三态契约 SSOT）。
 *
 * 消费方：wait-for-ci.mjs（阶段 3，main push CI）与 pr-merge.mjs（阶段 2，PR
 * head CI）——同一条「按 commit 查询」的两处消费收敛于本工厂，契约演化只改
 * 此处。verify-ci-release.mjs 自带同名工厂是查询语义真差异（按 workflow 查
 * 最近 5 条，不按 commit），不在本收敛范围。
 *
 * 三态契约：查询失败（gh 退出非 0 / JSON 输出畸形 / 非数组）返回 null，与
 * 「查询成功且空」的 [] 分流——gate.mjs 对 null 持续重试到 deadline 判
 * fetch-error（调用方按工具错误处理），绝不并入 no-runs 的 30s 宽限放行
 * 路径。runImpl 注入点供测试替换，生产路径用 lib/exec.mjs 的 run。
 */
import { run } from './exec.mjs'
import { filterDependabot } from './gate.mjs'

export function makeFetchRuns({ REF, WORKFLOW, GH_REPO, runImpl = run }) {
  return async () => {
    const args = ['run', 'list', '--commit', REF]
    if (WORKFLOW !== '') args.push('--workflow', WORKFLOW)
    if (GH_REPO !== '') args.push('--repo', GH_REPO)
    args.push('--json', 'databaseId,status,conclusion,name,workflowName')
    const res = runImpl('gh', args, { stdio: 'capture' })
    if (!res.ok) return null
    try {
      const runs = JSON.parse(res.stdout)
      if (!Array.isArray(runs)) return null
      // [2026-10-13] 过滤 Dependabot Updates：event=dynamic 的平台侧依赖机器人任务
      // （updater 容器对个别依赖如 electron 偶发 unknown_error 失败），不是本次合并的
      // 代码验证线——计入判定会让发布恒被与代码无关的机器人红阻塞。
      // WORKFLOW 显式指定时不过滤（用户点名）。
      return WORKFLOW !== '' ? runs : filterDependabot(runs)
    } catch {
      return null
    }
  }
}
