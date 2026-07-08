---
name: feishu-pi-bot
description: >
  将 pi agent 接入飞书个人机器人，实现飞书内自动问答（方案A：纯文本回复）。
  覆盖飞书应用创建、权限配置、公网代理、加解密、事件订阅全流程。
  触发词：飞书机器人、飞书接入pi、飞书bot、feishu bot。
---

# 飞书 Pi 机器人接入指南

## 整体架构

```
飞书用户 → 飞书服务器 → 公网 → nps/ngrok → 本地 pi bot (HTTP :8087)
                                      ↑
                               pi extension 驱动
```

## 前置条件

- 飞书管理员账号（创建企业自建应用）
- 一台有公网 IP 的服务器（做内网穿透），或 ngrok/cloudflared
- pi agent 已安装

## 步骤 1：创建飞书应用

1. 打开 [飞书开放平台](https://open.feishu.cn/app)
2. **创建企业自建应用** → 填名称如「Pi 助手」
3. 左侧 **凭证与基础信息** → 记下 **App ID** 和 **App Secret**
4. 左侧 **权限管理** → 搜索并添加：
   - `im:message`（读取消息，也用于接收事件）
   - `im:message:send_as_bot`（发送机器人消息）

## 步骤 2：配置事件订阅

1. 左侧 **事件与回调** → **加密策略**：
   - Encrypt Key：点击重置生成一个（建议配置，更安全）
   - Verification Token：自动生成，不用管
2. 进入 **事件配置** → 订阅方式选「将事件发送至开发者服务器」
3. 请求地址填公网地址（详见步骤 3）
4. 添加事件：`im.message.receive_v1`
5. 保存（需要 pi bot 已启动，飞书会做 URL 验证）

## 步骤 3：公网穿透（选一种）

### 方案 A：nps 穿透（推荐，需要自有服务器）

服务器端部署 nps，本地 Windows 安装 npc 客户端。

npc 配置文件 `conf/npc.conf`：
```ini
[common]
server_addr=你的服务器域名:8024
conn_type=tcp
vkey=你的vkey

[feishu]
mode=tcp
target_addr=127.0.0.1:8087
server_port=18087
```

飞书回调地址：`http://skyissky.com:18087/feishu/event`

### 方案 B：ngrok（免费，无需服务器）

```bash
ngrok config add-authtoken 你的token
ngrok http 8087
```

飞书回调地址：`https://xxx.ngrok-free.app/feishu/event`

### 方案 C：cloudflared（免费，无需注册）

```bash
cloudflared tunnel --url http://localhost:8087
```

飞书回调地址：`https://xxx.trycloudflare.com/feishu/event`

## 步骤 4：创建 pi extension

在 `~/.pi/agent/extensions/feishu-bot.ts` 创建扩展文件，包含：
- HTTP 服务器监听飞书回调
- AES-256-CBC 加解密（飞书 Encrypt Key）
- `pi -p` 命令行调用
- 飞书 API 发送消息

关键点：
- **解密**：`base64_decode` → 前 16 字节是 IV → AES-256-CBC 用 SHA256(EncryptKey) 解密
- **URL 验证**：解密请求后返回明文 `{"challenge":"xxx"}`（即使配了 Encrypt Key 也返回明文）
- **发消息**：POST `open.feishu.cn/open-apis/im/v1/messages`，content 是 JSON 字符串的字符串

## 步骤 5：启动

```bash
# 设置环境变量（或硬编码在 extension 中）
set FEISHU_APP_ID=cli_xxx
set FEISHU_APP_SECRET=xxx

pi
/reload
/feishu-bot-start
```

## 步骤 6：发布应用

1. 飞书开放平台 → **应用发布** → 创建版本 → 保存
2. 飞书客户端 → 工作台搜索应用名 → 进入对话

## 常见问题

| 问题 | 原因 | 解决 |
|------|------|------|
| Challenge code 没有返回 | URL 验证失败 | 检查解密逻辑，IV 用密文前 16 字节而非 key 派生；返回明文 challenge |
| 返回的 JSON 不合法 | 加密解密格式错误 | 同上，以及检查响应 body 格式 |
| 机器人无回复 | 权限不足 | 添加 `im:message:send_as_bot` 并重新发布版本 |
| ngrok 掉线 | 免费版不稳定 | 换 nps 或 cloudflared |

## 方案 A 限制

- 一问一答，`pi -p` 不支持工具调用（不能读写文件）
- 如需完整 agent 能力，需改用 pi SDK 模式（方案 B，另行实现）
