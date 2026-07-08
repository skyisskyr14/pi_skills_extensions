---
name: feishu-pi-bot
description: >
  将 pi agent 接入飞书，支持直接对话、多项目路由、会话管理（sessions/switch）。
  一键安装，配置好 App ID/Secret 即可使用。
  触发词：飞书机器人、飞书接入pi、飞书bot、feishu bot。
---

# 飞书 Pi 多项目机器人

## 一键安装

```bash
pi install git:github.com/skyisskyr14/pi_skills_extensions.git
```

## 获取飞书凭据

1. [飞书开放平台](https://open.feishu.cn/app) → 创建企业自建应用
2. **凭证与基础信息** → 记下 App ID、App Secret
3. **权限管理** → 添加：
   - `im:message`
   - `im:message:send_as_bot`
4. **事件与回调** → **加密策略** → 重置 Encrypt Key（记下）
5. 可选：设置环境变量（不设则用默认值）

## 配置公网穿透（选一种）

### nps（自有服务器）
```ini
# npc.conf
[common]
server_addr=你的域名:8024
conn_type=tcp
vkey=你的vkey

[feishu]
mode=tcp
target_addr=127.0.0.1:8087
server_port=18087
```

### ngrok（免费）
```bash
ngrok http 8087
```

### cloudflared（免费）
```bash
cloudflared tunnel --url http://localhost:8087
```

## 启动

### 总 agent（用户根目录）

```bash
pi    # 在用户根目录启动
/reload
/feishu-bot-start
```

### 项目 agent（各项目目录）

```bash
pi    # 在项目目录启动
/reload
# 自动注册到总 agent（无需手动操作）
```

## 飞书配置

1. **事件与回调** → **事件配置**：
   - 订阅方式：将事件发送至开发者服务器
   - 请求地址：`http://你的公网地址:端口/feishu/event`
   - 添加事件：`im.message.receive_v1`
   - 保存
2. **应用发布** → 创建版本 → 发布
3. 飞书客户端搜索应用名开始对话

## 用法

| 飞书消息 | 效果 |
|----------|------|
| `你好` | 总 agent 直接对话 |
| `F302 查看main.c` | 路由到项目 agent |
| `list` | 查看总 agent + 已注册项目 |
| `sessions` | 总 agent 会话树（含名字/层级） |
| `F302 sessions` | 项目会话树 |
| `switch code` | 切换总 agent 会话（按 /name 匹配） |
| `F302 switch IAP` | 切换项目会话 |

## 架构

```
飞书 → 公网穿透 → 总 agent (:8087, 用户根目录)
                    ├── 直接对话（sendUserMessage + agent_end）
                    ├── 会话管理（sessions/switch）
                    └── 项目路由 → 项目 agent (:81xx)
                                    ├── 直接对话
                                    └── 会话管理
```

## 注意事项

- 总 agent 必须在用户根目录启动
- 项目 agent 首次启动自动注册到总 agent
- Encrypt Key 用于加解密飞书事件，必须与飞书平台一致
- 切换会话时旧 pi 窗口不会自动关闭，需手动关
