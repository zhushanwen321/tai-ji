// verify-taiji fixture (S13)：sandbox 插件最小形态——激活为 no-op，fork 常驻，
// 供剧本从外部 SIGKILL 注入进程崩溃。
export async function activate(_context) {
  // no-op：保持 fork 存活即可
}

export async function deactivate() {}
