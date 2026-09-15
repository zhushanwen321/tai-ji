# @zhushanwen/pi-base-tool-enhance

同名 override pi 内置 bash 工具的增强层：前台行为 100% 委托 pi 官方工厂（`createBashToolDefinition`），增量提供 background 模式、强制后台白名单与双模式可配置超时。能力面：测试类命令 force-test 白名单命中自动转后台（模式登记于 force-patterns.ts）、网络类挂死保护（可配置前台默认超时）、工具报错审计（tool_error 审计 hook，entry customType 为 `unified-hooks:tool-error`）。

设计决策沉淀在包内源码注释与本文档。

## 配置

`<pi agentDir>/config/base-tool-enhance-ext-config.json`（读时刷新热重载，坏键回退默认不拒载）：

```jsonc
{
  "forceBackgroundPatterns": [],          // 用户正则，追加到内置白名单后
  "disableBuiltinForcePatterns": false,   // true = 关闭内置 force-test/force-longrun 两组
  "foregroundTimeoutSeconds": null,       // null = 不注入（pi 原生不限时）
  "backgroundTimeoutSeconds": null,       // null = 不注入
  "maxConcurrentBackground": 8
}
```

## 工具

- `bash {command, timeout?, background?}` —— 白名单命中自动转后台（忽略显式 timeout，D13）
- `bash_output {task_id?}` —— 省略列出任务（单例表 + registry 终态条目）；指定返回状态与 tail 输出
- `bash_kill {task_id}` —— 终止后台任务（限本进程任务；跨进程 running 条目由发起进程或 reaper 管理）

完成通知经 pending-notifications（`type:"bash"`，process 生命周期档）+ sendMessage steer 注入当前 session。

## 退役条件（sunset，D18）

pi 上游出现原生 background bash（或等价长时命令异步化）能力时评估退役本包；届时前台行为已收敛在 `createBashToolDefinition` 委托面，迁移成本可控。不登记此条件则 3 年后冗余层无人敢删（override 层与上游能力双轨漂移）。
