// verify-taiji fixture (S26) v2.0.0：激活即抛错的「更新中途必失败」包——manifest 校验
// 通过（prepare/commit 成功），激活失败触发 commitAndActivate 回滚（旧版本幸存断言的
// 注入面，设计 S26「更新中途必失败的 fixture 包」）。
export async function activate(_context) {
  throw new Error('verify-taiji S26 fixture: broken-on-activate update package (intentional)')
}

export async function deactivate() {}
