# CUIT 校园网助手

成都信息工程大学校园网（锐捷 Portal）Windows 开机自动登录工具。
开机进桌面后自动完成「连 WiFi → 识别认证状态 → 填账号密码 → 勾协议 → 登录 → 选运营商」，全程无窗口、无需人工操作。

> **行为边界（安全兜底）**：只在"确实连着校园网且需要认证"时才动手。
> 已能上网 / 在家 / 连着别的网络时，脚本检测后立即静默退出，**不会断开、不会抢连、不会误登别处的认证页**。

## 功能特性

- **开机全自动**：计划任务在登录后 4 秒静默运行，实测开机到联网约 55 秒（含系统/驱动启动时间）
- **真实浏览器登录**：Playwright 驱动 Chromium 走完整人工流程，不依赖门户内部接口，改版抗性强
- **WiFi 兜底连接**：调用 Windows 原生 `WlanConnect` API 按配置文件直连——不需要系统位置权限，也不需要管理员权限
- **环境门禁**：门户为纯内网 IP 且不依赖 DNS，探测不可达即判定"不在校园网"，直接退出
- **失败可排查**：登录失败自动截图到 `logs/`，日志逐行记录每一步

## 安装

前置要求：Windows 10/11、[Node.js](https://nodejs.org) ≥ 18（LTS 即可）

```powershell
git clone https://github.com/metbeing/cuit-campusnet-helper.git
cd cuit-campusnet-helper
powershell -ExecutionPolicy Bypass -File install.ps1
```

`install.ps1` 会自动完成：定位 Node.js → 生成 `config.json` → `npm install` + 下载 Chromium → 注册计划任务 `CampusAutoLogin`。

然后编辑 `config.json`（**你的账号密码只存在本机，不会上传任何地方**）：

```jsonc
{
  "portalUrl": "http://10.254.241.66/portal/",  // 认证门户地址
  "wifiName": "Cuit_WiFi",                      // 校园网 WiFi 名称
  "username": "你的学号",
  "password": "你的密码",
  "isp": "中国移动"                              // 与"请选择服务"页文字一致(电信/移动/联通)
}
```

重启电脑实测即可。也可以先手动验证：

```powershell
node login.mjs --check   # 只检测当前网络状态(不开浏览器)
node login.mjs           # 手动跑一次完整登录
node e2e.mjs             # 端到端测试: 自动下线当前会话→重新登录→验证在线(会断网约 30 秒)
```

## 工作原理

```
登录桌面 ──4s──▶ 计划任务 ──▶ 隐藏运行 login.mjs
                                │
                                ├─ generate_204 探测: 204=已在线 → 退出
                                ├─ 未在线: 探测门户内网 IP → 不可达=不在校园网 → 退出
                                ├─ 离线中: 原生 WlanConnect 连 Cuit_WiFi(每 5s 重试)
                                └─ 门户可达: Chromium 打开认证页
                                     → 跨 iframe 找表单 → 填账号密码 → 勾协议
                                     → 立即登录 → "请选择服务"选运营商 → 确定
                                     → 轮询确认在线
```

- 未认证时访问外网探测地址会被网关 302 重定向到门户（自动带上 `userip`/`usermac` 参数），因此无需硬编码认证参数
- 门户为 Angular SPA，登录表单在 cas-sso iframe 中，脚本遍历所有 frame 查找
- 失败自动重试（默认 3 次），每次尝试间隔可配置

## 配置项

| 字段 | 说明 | 默认 |
|---|---|---|
| `portalUrl` | 认证门户地址 | CUIT 门户 |
| `wifiName` | 校园网 WiFi SSID（有线接入可留空） | `Cuit_WiFi` |
| `username` / `password` | 校园网账号密码 | — |
| `isp` | 运营商，须与"请选择服务"页文字一致 | `中国移动` |
| `checkUrls` | 联网探测地址（返回 204 视为在线） | gstatic / miui |
| `headless` | 是否无头模式（改 `false` 可看浏览器操作过程） | `true` |
| `waitNetworkSeconds` | 开机后等待网卡就绪的最长时间 | `90` |
| `maxAttempts` / `attemptIntervalSeconds` | 登录重试次数 / 间隔 | `3` / `10` |

## 常见问题

- **想卸载**：`schtasks /Delete /TN "CampusAutoLogin" /F` 删除任务，再删掉整个目录即可
- **登录失败**：看 `logs/` 最新的失败截图——`fail-无登录表单` 多为门户改版；服务选择页若文字不同，改 `isp` 为页面原文
- **换了电脑**：重新跑一遍 `install.ps1` 即可（会重新生成 `node.path` 和计划任务）
- **密码修改后**：更新 `config.json` 即可

## 免责声明

本项目仅供学习交流，请遵守学校网络使用规范。校园网认证门户更新可能导致脚本失效，欢迎提 Issue/PR。

## License

[MIT](LICENSE)
