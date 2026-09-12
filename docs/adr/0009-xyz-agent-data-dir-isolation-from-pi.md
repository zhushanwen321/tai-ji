# ADR-0009: xyz-agent 数据目录与 pi 数据目录完全隔离

- 状态：Accepted

## 上下文

xyz-agent 通过 RPC 模式调用 pi 子进程，两者共享同一台机器。pi 有自己的数据目录（`~/.pi/agent/`），包含 extensions、skills、config 等。如果 xyz-agent 直接读写 pi 的数据目录来管理 extension，当用户已经独立使用 pi 时，两边的 extension 列表和配置会互相干扰。

## 决策

xyz-agent 维护独立的数据目录（`~/.xyz-agent/`），与 pi 的数据目录（`~/.pi/agent/`）完全隔离。Extension 安装在 `~/.xyz-agent/extensions/`，通过 `--extension` CLI 参数在 pi 启动时注入。不共享 extension、skill、config 文件。

## 理由

1. 已有 pi 用户的环境不受 xyz-agent 安装/卸载 extension 的影响
2. xyz-agent 可以对 extension 做独立的启用/禁用管理，不影响 pi 的行为
3. 数据归属清晰，避免"谁拥有这个文件"的混淆
