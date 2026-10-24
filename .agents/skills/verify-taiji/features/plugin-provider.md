# 插件 Provider 接入

用户在 Provider 页以「插件 Provider」形态接入第三方模型服务商：远程清单驱动家族卡，两段式安装确认后插件以自身命名空间向 `models.json` 写 provider 条目，条目扩展区由插件推送交互树（凭据状态标记 / 表单 / 动作按钮），OAuth 授权走宿主系统浏览器通道。权威层在 [capabilities/plugin.md](../capabilities/plugin.md)「Provider 插件化」节（剧本索引与 verdict）与 [scenarios/](../scenarios/) 的 `p1-plugin-*.mjs`（可执行剧本），本文是人读叙事摘要，不复制清单。

## Sub-features

- `pp-menu` 「添加供应商 ▾」三入口并列（内置 / 自定义 / 插件）。
- `pp-family-cards` 清单驱动的家族卡两态（已装徽标 / 「需要先安装插件」引导）。
- `pp-install` 两段式安装：暂存 → 确认卡全量展示 capabilities/readPaths → 提交激活；取消清暂存不落盘。
- `pp-update` 更新链：清单版本翻转 → 更新徽标两级提示 → 两段式确认提交，条目凭据保留。
- `pp-detail-sections` 条目两区边界（宿主字段区 / 插件 detail-extra 扩展区）。
- `pp-status` 凭据状态双通道：`plugin:event` 推送标记 + 重新展开 invoke getStatus 收敛；未上报条目零标记。
- `pp-text-input` text-input 原语输入回传与 action-bar 命令触发重推。
- `pp-oauth` 宿主 OAuth 通道：系统浏览器唤起 + 本地回调端口。
- `pp-uninstall` 卸载编排：命名空间前缀全清（条目 + 插件目录 + `.staging` + pi 扩展 + installed.json）。

## How to get to it (user POV)

- 侧栏设置 → 「模型服务 / Provider」页 → 「添加供应商 ▾」菜单第三项「插件」→ 家族卡（安装引导 / 已装条目）。
- 已装插件条目：点行展开 → 宿主字段区 + 「插件提供」扩展区（凭据状态标记、插件渲染控件）+ 条目动作「重新授权」「更新插件」。
- 安装路径二选一：家族卡点装（清单条目）或直装输入包名（npm 安装链）。

## Driving it with browser-automation (CDP)

Preconditions:

- doctor 全绿；用 verify 数据目录实例。
- 插件剧本用 `scenarios/lib-plugin-fixtures.mjs` + `scenarios/lib/plugin-provider-fixture.mjs` 的 launch 前 seed（fixture 插件写 `<dataDir>/plugins/`、清单 envelope 写 `<dataDir>/remote-config/v2-plugins.json`）；npm 安装链用 `scenarios/lib/mock-npm-registry.mjs`（本机 HTTPS mock registry）。
- 设置 → Provider → 添加供应商 → 家族卡 / 直装 → 确认卡的锚点链见 `scenarios/lib/plugin-flow-helper.mjs` 文件头。
- 声明了写侧能力的 fixture 需 `plugin.approvePermissions` 预批（`lib-plugin-fixtures.mjs` 的 `pluginFixture`）。

- **家族卡与安装。** 打开 Provider 页 → 「添加供应商 ▾」→ 断言 `add-menu-plugin` 入口与家族卡两态（`p1-plugin-a1-family-cards`）；点装 → 确认卡全量展示 capabilities/readPaths（与暂存解压物 manifest 同源核对）→ 提交；未确认取消则暂存清空、正式目录不出现（`p1-plugin-install-confirm`）。
- **条目两区与输入回传。** 展开已装条目 → `provider-detail-extra-boundary` 上下两区互不溢入（`p1-plugin-a6-detail-sections`）；`gui-text-input-field-<id>` change 即回传、action-bar 命令触发重推、重推 value 回显覆盖本地镜像（`p1-plugin-a7-text-input`）。
- **状态与授权。** 凭据状态标记随 `plugin:event` 出现、推送丢失后重新展开经 getStatus 收敛、未上报条目零标记（`p1-plugin-a17-status-report`）；OAuth 中断三段（取消重发起 / 回调拒绝可理解 / 端口预占含恢复动作）无残留监听（`p1-plugin-a19-oauth-interrupt`）。
- **更新与卸载。** 清单版本翻转 → 更新徽标 → 确认提交后磁盘/注册表/激活面换新、条目凭据保留（`p1-plugin-a26-update-chain`）；装卸 5 轮含中途重启后邻居条目与凭据零污染、无孤儿残留（`p1-plugin-a14-install-neighbors`）；双产物五处落盘 / 卸载五处清除（`p1-plugin-a23a-dual-artifact`）。
- **防御面。** 跨命名空间回读 NAMESPACE_MISMATCH、未声明能力 PERMISSION_DENIED 且拒绝 reply 无凭据外泄（`p1-plugin-a21-credential-deny`）；非法 guiTree 渲染降级不断链不白屏（`p1-plugin-a16-invalid-tree`）；SIGKILL fork → `plugin:crashed` 广播 + 邻居与宿主不受影响（`p1-plugin-crash`）。
- **Proof。** 各剧本 verdict 断言数与覆盖矩阵见 [capabilities/P0-P1-COVERAGE.md](../capabilities/P0-P1-COVERAGE.md) 第六节；人工复跑按本目录 README 三件套标准（截图 + DOM 断言 + 磁盘副作用）取证。

## Gotchas

- 权限审批门：声明了 `providers.write` 等能力的插件首次激活停在审批，`plugin.approvePermissions` 批准落盘后免审批——seed 时不预批会卡在激活等待（[plugin.md](../capabilities/plugin.md) 坑 2）。
- 清单读取有 `checkedAt` 4h 节流窗：launch 前 seed 缓存 envelope = 确定性注入；删缓存文件才是「从未拉取」断网前提，别等网络超时（坑 3）。
- action-bar 命令执行器是容器级 provide（`ProviderRowCard` 容器内直发 `plugin.executeCommand`），宿主命令面板里没有这些命令——从条目扩展区按钮驱动，不从命令面板找（坑 1）。
- 更新链的进程边界（坑 4）：sandbox fork 按插件 id 复用（存活即复用，deactivate 不 terminate）+ 同 URL ESM 模块缓存，意味着「换磁盘文件 ≠ 换运行代码」——更新提交与回滚重激活都必须先 terminate 旧 sandbox fork 再激活（进程即模块边界，宿主侧 `plugin-update-activation.ts` 已实现）。排障信号：更新后版本号变了但行为还是旧的 = 进程没换；`p1-plugin-a26-update-chain` 断言正向更新 fork PID 更替、回滚重激活达 active。
- 真实凭据的 OAuth 全链路（WorkBuddy 扫码出话）不在本剧本集：`p1-plugin-a19-oauth-interrupt` 只验中断三段，全链路属设计验收 S2 / P-wool-e2e 真机剧本。
