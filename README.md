# 微信 Codex 桥接助手

> English package name: `weixin-codex-bridge`

把个人微信会话连接到 Codex 的轻量桥接工具。它基于 `weixin-agent-sdk` 接收微信消息，用 `weixin-acp` 和 `@zed-industries/codex-acp` 把消息转给 Codex，并只允许一个已绑定的微信会话与 Codex 通信。

> 说明：这是个人自用桥接方案，不是微信官方开放平台能力。请自行评估账号、隐私和合规风险。

## 功能

- 扫码登录微信。
- 绑定一个微信会话白名单，默认只处理这个会话的消息。
- 微信里直接和 Codex 对话。
- `/sessions` 查看本机 Codex 历史会话。
- `/resume <编号|ID|名称>` 在微信里继续旧 Codex 会话。
- `/resume 0` 或 `/resume new` 开启新的微信侧 Codex 对话。
- `/mode light` 让微信闲聊短回复，节省 token。
- `/policy unsafe 确认高权限` 临时处理 Windows sandbox / `spawn EPERM` 问题。
- `weixin-sync.jsonl` 记录微信侧收发事件，方便桌面端手动同步。

## 环境要求

- Windows 10/11。
- Node.js 18+。
- npm。
- Codex CLI，且 `codex.exe` 在 `PATH` 中。
- 能正常扫码登录的微信账号。

如果 `codex.exe` 不在 `PATH`，可以设置环境变量：

```powershell
$env:CODEX_CMD = "C:\Path\To\codex.exe"
```

如果 `npm.cmd` 不在 `PATH`，可以设置：

```powershell
$env:NPM_CMD = "C:\Path\To\npm.cmd"
```

## 安装

```powershell
git clone <your-repo-url>
cd weixin-codex-bridge
npm install
```

`npm install` 后会自动执行 `scripts/patch-weixin-sdk.mjs`，用于：

- 禁用 SDK 内置 slash command 拦截，让 `/sessions`、`/resume` 等命令交给本桥接处理。
- 在扫码登录时打印二维码链接，终端二维码显示失败时也能用浏览器打开。

也可以手动执行：

```powershell
node .\scripts\patch-weixin-sdk.mjs
```

## 第一次绑定

1. 启动绑定模式：

```powershell
.\run-weixin-bind.cmd
```

2. 终端出现二维码后，用微信扫码登录。
3. 从你希望绑定的微信会话里发送：

```text
绑定Codex
```

4. 绑定成功后会生成本地文件 `weixin-bridge.config.json`。

这个文件包含你的微信 `conversationId`，不要提交到 GitHub。

## 启动桥接

```powershell
.\run-weixin-bridge.cmd
```

日志输出在：

- `logs/bridge.out.log`
- `logs/bridge.err.log`
- `weixin-bridge.log`

查看状态：

```powershell
npm.cmd run weixin:status
```

查看微信侧同步事件：

```powershell
npm.cmd run weixin:sync
```

## 微信命令

- `/help` 或 `/帮助`：查看命令。
- `/sessions` 或 `/会话`：列出最近 Codex 会话，列表里包含 `0. 开启新对话`。
- `/resume 0` 或 `/resume new`：开启新的微信侧 Codex 对话。
- `/resume <编号|ID|名称>` 或 `/继续 <...>`：切到旧 Codex 会话。
- `/resume <编号|ID|名称> <问题>`：切到旧会话并立刻提问。
- `/live` 或 `/实时`：回到当前实时 ACP 会话。
- `/new` 或 `/新会话`：清空当前实时 ACP 会话。
- `/current` 或 `/当前`：查看当前路由、权限、回复模式。
- `/mode light`：微信端默认短回复，节省 token。
- `/mode full`：微信端默认完整回复。
- `/policy` 或 `/权限`：查看权限说明。
- `/policy unsafe 确认高权限`：临时切到高权限。
- `/policy safe`：切回安全模式。
- `/whoami`：查看当前微信 `conversationId`。

在 `light` 模式下，消息用这些前缀开头会自动按完整任务处理，无需额外确认：

```text
详细:
执行:
代码:
查一下:
修复:
分析:
```

## 继续旧会话的机制

本工具优先尝试：

```text
codex.exe exec resume <sessionId>
```

但在 Windows 上可能遇到 `spawn EPERM`、`拒绝访问` 或 `windows sandbox: spawn setup refresh`。如果失败，桥接会退回到“上下文注入”模式：

1. 读取本机 `~/.codex/session_index.jsonl` 和 `~/.codex/sessions/**.jsonl`。
2. 提取旧会话最近对话。
3. 注入到当前隐藏 ACP 会话里继续处理。

这能在微信里继续旧上下文，但它不是 Codex Desktop UI 原生同一个聊天窗口。

## 桌面同步

微信侧消息不会自动出现在当前 Codex Desktop UI。桥接会把收发事件写入：

```text
weixin-sync.jsonl
```

当微信里执行 `/resume 0`、`/resume new`、`/new` 或切换旧会话时，会额外写入：

```json
{ "event": "route_changed" }
```

桌面端可以运行：

```powershell
npm.cmd run weixin:sync
```

然后根据里面的 `events` 和 `state` 手动同步上下文。

## 处理 `spawn EPERM` / Sandbox 问题

推荐顺序：

1. 默认保持 `/policy safe`。
2. 如果微信侧 Codex 工具失败，错误包含 `spawn EPERM`、`拒绝访问` 或 `windows sandbox: spawn setup refresh`，从白名单微信会话发送：

```text
/policy unsafe 确认高权限
```

3. 重试刚才的任务。
4. 完成后立即发送：

```text
/policy safe
```

`unsafe` 会让隐藏 Codex 进程使用 `danger-full-access`，只建议短时间开启。

## 重置绑定

```powershell
npm.cmd run weixin:reset
```

然后重新执行“第一次绑定”流程。

## 安全提示

- 只绑定你自己的微信会话。
- 谨慎使用 `/policy unsafe 确认高权限`。
- 微信消息和 Codex 回复会以明文写入 `weixin-sync.jsonl`，如果不需要桌面同步，可以定期删除该文件。
