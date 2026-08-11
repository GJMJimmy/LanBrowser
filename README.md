# LAN Browser

LAN Browser 是运行在 Windows 服务端的虚拟浏览器。内网终端只访问本服务，网页请求由服务端的 Microsoft Edge 发出；画面、声音与输入通过 WebRTC DataChannel 传输，不要求终端能够直接访问互联网，也不需要 Docker。

## 快速启动

开发环境需要 Node.js 22 或更高版本：

```powershell
pnpm install
pnpm start
```

服务默认监听 `0.0.0.0:7798`。控制台会打印带随机访问口令的本机和内网 URL，例如：

```text
http://192.168.1.20:7798/?token=访问口令
```

首次运行时，Windows 防火墙可能询问是否允许访问。需要允许内网 TCP 7798 以及该程序的 WebRTC UDP 流量。

## 构建 Windows 单文件 EXE

```powershell
pnpm build:exe
```

产物位于 `dist/lan-browser.exe`。目标 Windows 10/11 无需 Node.js 或 Docker，但需要 Microsoft Edge（系统通常已预装）。双击 EXE 后保持控制台窗口开启，按窗口中显示的 URL 访问。

也可以直接传入常用参数：

```powershell
.\dist\lan-browser.exe --port 8080 --token "change-this-password" --max-sessions 8
```

## JSON 配置文件

EXE 会自动读取与自身同目录的 `lan-browser.config.json`。构建时会在 `dist` 目录创建一份默认配置，但不会覆盖已有配置。常用示例：

```json
{
  "host": "0.0.0.0",
  "port": 8080,
  "tokens": ["phone-password", "desktop-password"],
  "startUrl": "https://www.bing.com/",
  "maxSessions": 4,
  "idleMinutes": 20,
  "audio": true,
  "frame": {
    "width": 1440,
    "height": 900,
    "quality": 72
  },
  "browserPath": "",
  "proxy": "",
  "noSandbox": false,
  "allowPrivate": false
}
```

`tokens` 可以填写多个访问口令；留空数组时，每次启动会生成随机口令并打印在控制台。配置优先级为：命令行参数 > 环境变量 > JSON 配置文件 > 默认值。也可通过 `--config D:\path\custom.json` 指定其他配置文件。

如果启动报 `listen EACCES`，可能是端口被 Windows 保留，请将 `port` 改为其他端口。

## 环境变量

通过环境变量配置：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `LAN_BROWSER_PORT` | `7798` | Web 服务端口 |
| `LAN_BROWSER_HOST` | `0.0.0.0` | 监听地址 |
| `LAN_BROWSER_TOKEN` | 每次随机生成 | 单个固定访问口令 |
| `LAN_BROWSER_TOKENS` | 空 | 多个口令，以英文逗号分隔 |
| `LAN_BROWSER_START_URL` | Bing | 起始页 |
| `LAN_BROWSER_MAX_SESSIONS` | `4` | 最大并发浏览器数 |
| `LAN_BROWSER_IDLE_MINUTES` | `20` | 空闲会话回收时间 |
| `LAN_BROWSER_PROXY` | 空 | 服务端上游代理，例如 `http://127.0.0.1:7890` |
| `LAN_BROWSER_EDGE_PATH` | 自动查找 | 自定义 `msedge.exe` 或 `chrome.exe` 路径 |
| `LAN_BROWSER_FRAME_QUALITY` | `72` | JPEG 质量，范围 30-90 |
| `LAN_BROWSER_AUDIO` | `1` | 设为 `0` 时禁用声音采集 |
| `LAN_BROWSER_NO_SANDBOX` | 空 | 设为 `1` 时关闭 Chromium 沙箱，仅用于受限服务账户排障 |

示例：

```powershell
$env:LAN_BROWSER_TOKEN="change-this-password"
$env:LAN_BROWSER_PORT="8080"
$env:LAN_BROWSER_PROXY="http://127.0.0.1:7890"
.\dist\lan-browser.exe
```

## 手机触屏

- 单指轻触用于点击，双击会作为远程双击发送。
- 单指上下或左右拖动用于滚动远程网页，不会误触链接。
- 轻触远程输入框会自动调起手机输入法；若某些浏览器阻止自动弹出，可点击工具栏的键盘图标。
- 支持中文/英文输入、输入法组合文本、退格和回车。
- 点击工具栏的画面设置按钮，可选择自动适应，也可输入 320×240 到 3840×2160 的自定义分辨率。
- 网页打开新标签页时会自动切换远程画面，后退按钮可返回原标签页。

## 网络与安全

```text
内网终端浏览器 <-- HTTP/信令 + WebRTC --> LAN Browser/Edge --> 互联网
```

- 客户端不会直接请求目标网站，DNS、HTTP、HTTPS 和代理配置都发生在服务端 Edge。
- 声音使用 Windows WASAPI 系统输出回环采集。服务端同时播放的其他系统声音也可能被传给客户端，因此运行服务时应避免播放无关音频。
- 默认只允许 `http://` 和 `https://`，并阻止直接访问服务端环回及内网 IP，降低被用来探测内网服务的风险。
- 访问口令是最低安全边界。不要把未配置 TLS 的服务直接暴露到公网；跨网段或公网部署应在前面配置 HTTPS 反向代理，并使用 TURN 服务处理严格 NAT。
- 默认启用 Chromium 页面沙箱。只有确认 Windows 服务策略阻止无头浏览器运行时，才使用 `--no-sandbox`；使用该参数时不要向不受信任的用户开放服务。
- 当前画面使用带单调序号的 CDP JPEG 截帧，通过 WebRTC 不可靠 DataChannel 发送；客户端会丢弃迟到旧帧。它适合网页和管理后台，不适合高清视频或游戏。
