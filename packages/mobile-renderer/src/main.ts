// mobile-renderer 入口：样式装配 + bootstrap 编排。
// core/ui 依赖与平台注入由 bootstrap.ts 内部真实 import 承载（依赖边由 package.json
// workspace 声明 + bootstrap import 图护住，ac1-dependency-edge.test.ts 断言 package.json 面）。
import './styles/tokens.css'

// 浮层进出场过渡（dialog 居中依赖 translate(-50%,-50%)，缺失时弹窗出视口）。
// styles/shell.css 是桌面 style.css 同段的 mobile 镜像副本，改动须同步两处。
import './styles/shell.css'

import { bootstrap } from './bootstrap'

// 启动壳编排（platform 注入 → 壳层端口注入/连接编排 → 挂载 App）。
void bootstrap()
