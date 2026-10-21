# 设置页 provider 管理

用户配置模型 provider 的地方：列表、展开详情、设默认、启用开关、删除。provider 配置是首次使用必经路径——配不了 provider 连会话都建不起来。写侧经跨进程锁 + 字段域合并落到 `<dataDir>/agent/models.json`。

## Sub-features

- `sp-open` 侧栏设置按钮打开设置 modal。
- `sp-nav` 左侧导航进 provider 页（`settings-nav-provider`）。
- `sp-list` provider 列表（`provider-card` 每行、计数徽标、空态）。
- `sp-expand` 点行展开详情体 `provider-expand-body`（模型清单 / api key 等）。
- `sp-default` 设默认 provider（`provider-default-pill` 迁移）。
- `sp-toggle` 启用开关切换。
- `sp-remove` 删除（自建 `provider-delete-btn` / taiji 清单来源 `provider-remove-btn`）。
- `sp-error` 动作失败常驻错误条 `provider-action-error`。

## How to get to it (user POV)

- 侧栏底部设置按钮（title/aria-label = 设置）→ 设置 modal → 左导航「模型服务 / Provider」页。

## Driving it with browser-automation (CDP)

Preconditions:

- doctor 全绿；常规实例（模板种子含 provider）或 faux 实例（列表里至少有 faux provider）都可。
- 删除/改默认只在 verify 数据目录实例做。

- **打开设置。** 点侧栏设置按钮（`getByTitle` / aria-label 匹配「设置」）→ modal 可见 → 点 `settings-nav-provider` → `provider-list-header` 可见。
- **列表与展开。** 断言 `provider-card` 数量与计数徽标一致；点某行 → `provider-expand-body` 可见，展开行内容含模型清单；再点收起。
- **设默认。** 展开非默认 provider → 点设默认动作 → `provider-default-pill` 从原 provider 行迁到目标行。
- **删除。** 展开自建 provider → 点删除（需确认的走完确认）→ 该 `provider-card` 消失、计数 -1。
- **错误条。** 造一次失败动作（如断开 runtime 后操作）→ `provider-action-error` 可见且含可读信息；恢复后可继续操作。
- **副作用取证。** 动作前后各取一份 `<dataDir>/agent/models.json` 对照（默认 provider 字段迁移 / providers 条目增删）；动作成功以**文件内容**为准，不只看 UI。
- **Proof。** 截图（列表 / 展开态）+ models.json 前后 diff + DOM 断言输出。

## Gotchas

- settings.json / models.json 写侧有跨进程锁 + 字段域合并：断言用整文件对照，别假设单字段原子替换。
- faux 实例的 provider 列表 = faux 一个（seed 写入）；要验多 provider 形态用常规实例（模板种子）或手工在 models.json 预置。
- 删除按钮按来源二分：自建 = `provider-delete-btn`，taiji 远程清单来源 = `provider-remove-btn`；断言时按行的来源取对应 testid。
- 关 modal 用 `settings-close-btn`；「返回」是 `settings-back-btn`（移动形态）。
- 该页是设置写侧的门面：动作后若 UI 与文件不一致，先 doctor 看 runtime 是否还活着再报缺陷。
