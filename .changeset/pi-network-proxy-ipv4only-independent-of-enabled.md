---
'@zhushanwen/pi-network-proxy': patch
---

ipv4Only 清单不再受 enabled 代理开关门控：enabled=false 且 ipv4Only 非空时包装层照常安装，命中清单的域名锁 IPv4 直连（此前 enabled=false 时整层包装被摘除，强制 IPv4 静默失效）；开关关闭时 rules 不再参与分流（记 direct 计数）
