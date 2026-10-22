# 归档两个边缘输入形态 fail-fast 报错（零消息 session / 符号链接 cwd）

状态：未解决（2026-10-20 登记；suppress 真机探针跑测时发现，均为安全失败形态，无数据丢失）

## 现状

session-archive 的 suppress 死亡处置真机探针（真实 runtime + 真实 pi 进程，临时数据目录）跑测中发现两个归档失败边缘，均以 `archive_io_error` fail-fast 拒绝、零副作用（不搬移、不删原件）：

1. **零消息 session 归档报错**：pi 1.0.0 起 session 文件延迟落盘（首次 flush 条件 = 存在 user 或 assistant 消息，项目 AGENTS.md 关键规则 6）。新建 session 未发任何消息即归档时，活跃 session 的 `sessionFilePath` 指向尚未创建的文件，搬移 rename 报 ENOENT → `archive_io_error`。用户体感：刚建的空会话归档失败。设计未覆盖零消息 session 形态。
2. **符号链接 cwd 归档报错**：macOS 上 `/var` 是 `/private/var` 的符号链接。session 的 cwd 传未解析路径（如 `/var/folders/...`）时，pi 实际把 session 文件写在解析后的真实路径编码目录（`--private-var-...`）下，而归档单元目录按 cwd 原样编码（`--var-...`）——rename 源与目标编码不一致报 ENOENT → `archive_io_error`。生产场景：用户在项目选择器输入含符号链接的路径（如 `/tmp` 下的工作目录、外置盘软链）。

## 影响

均为 fail-fast 安全失败（拒绝归档、数据不动），但用户会遇到「归档按钮点了却报错」且错误信息是底层 ENOENT（`归档搬移失败 ... ENOENT`），无可操作指引。

## 修复方向（待裁决）

- 零消息 session：归档前判主文件不存在 → 要么直接成功（空归档单元，簿记 name 回退 sessionId），要么报带指引的明确错误（「空会话无需归档」）。倾向前者（幂等、无用户价值损失）。
- 符号链接 cwd：归档入口对 cwd 做 `realpathSync` 归一（与 pi 落盘路径同编码），或单元目录改用 sessionFilePath 的父目录派生。需同步核对恢复路径（`sessionOriginalPath` 按簿记 cwd 推导）的一致性。

## 证据

探针跑测记录（2026-10-20，临时数据目录 + dev 模板配置种子，零 LLM turn）：两形态各复现一次 `archive_io_error` ENOENT；补写会话文件（形态 1）与传解析后 cwd（形态 2）后归档成功，suppress 路径验证通过（归档后死亡通知通道零输出、pi 进程终止）。
