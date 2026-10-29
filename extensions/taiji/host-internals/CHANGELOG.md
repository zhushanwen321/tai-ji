# @zhushanwen/pi-host-internals

## 1.5.0

### Minor Changes

- 701143b67: pi-agent-ext 与 pi-msg-id-mapper 合并为单包 pi-host-internals：taiji 内部宿主协议设施（`__taiji_get_system_prompt__` / `__taiji_nav__` host commands 与 client UUID ↔ user entry ID 映射 hooks）统一到单一扩展装载入口，行为不变；旧两包名停止更新。

## 1.4.1

### Minor Changes

- Initial release: single package hosting the taiji internal protocol facilities — host commands (`__taiji_get_system_prompt__`, `__taiji_nav__`) plus the client UUID ↔ user entry ID mapping hooks; infrastructure tier, no behavior change.
