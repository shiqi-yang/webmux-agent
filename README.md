# webmux-agent

在你的机器上运行，通过 WebSocket 连接到 Hub，把本机的 tmux 会话暴露给浏览器客户端。

## 依赖

| 依赖 | 说明 |
|------|------|
| **Node.js** ≥ 18 | 运行时 |
| **tmux** | 会话管理，必须在 PATH 中可用 |
| **node-gyp 构建工具** | node-pty 需要编译原生模块 |

**构建工具安装（按系统）：**

```bash
# Debian / Ubuntu
sudo apt install build-essential python3

# macOS（需要先装 Xcode Command Line Tools）
xcode-select --install
```

## 安装

```bash
git clone <repo-url> webmux-agent
cd webmux-agent
npm install
```

## 配置

首次运行会自动进入交互式配置向导，按提示填写即可：

```
Hub URL       https://home.agentscom.top
Username      alice
Password      ****
Managed only  N
```

配置保存在 `config.json`。也可以手动复制示例文件修改：

```bash
cp config.example.json config.json
```

**配置项说明：**

| 字段 | 说明 |
|------|------|
| `hubUrl` | Hub 服务器地址，如 `https://home.agentscom.top` |
| `username` | 在 Hub 上注册/登录的用户名 |
| `password` | 对应密码 |
| `managedOnly` | `true` 时只暴露由 webmux 创建的 tmux 会话，`false` 暴露所有会话 |
| `reconnect.initialDelay` | 断线重连初始等待时间（毫秒） |
| `reconnect.maxDelay` | 断线重连最大等待时间（毫秒） |

**环境变量覆盖（优先级高于 config.json）：**

```bash
HUB_URL=https://home.agentscom.top
AGENT_USERNAME=alice
AGENT_PASSWORD=yourpassword
MANAGED_ONLY=false
```

## 启动

```bash
npm start
```

开发模式（文件变更自动重启）：

```bash
npm run dev
```

## 使用 systemd 后台运行（可选）

```ini
[Unit]
Description=WebMux Agent
After=network.target

[Service]
WorkingDirectory=/path/to/webmux-agent
ExecStart=/usr/bin/node index.js
Restart=always
RestartSec=5
Environment=HUB_URL=https://home.agentscom.top
Environment=AGENT_USERNAME=alice
Environment=AGENT_PASSWORD=yourpassword

[Install]
WantedBy=default.target
```

```bash
systemctl --user enable --now webmux-agent
```
