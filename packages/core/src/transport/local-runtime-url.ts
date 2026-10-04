/**
 * 本地形态 runtime WS 地址单点派生（renderer-package-topology §2.4「连接发现策略收口」）。
 *
 * use-connection 的三形态分支（mock = VITE_MOCK / 本地 = IPC / 远程 = profile）中，仅本地
 * 形态需要由端口号拼出 WS URL。本函数是连接发现链路上该 URL 形态的唯一拼接点（收口单点）——
 * 新增连接发起路径一律经 use-connection 的形态分支取得连接目标，禁止在分支外内联重拼。
 */
export function localRuntimeUrl(port: number): string {
  return 'ws://localhost:' + port
}
