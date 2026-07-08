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

## 架构

```
飞书 → 公网穿透 → Bun HTTP 子进程 (:8087, feishu-server.ts)
                    ├── 路由 → 项目 agent (:81xx, feishu-bot.ts)
                    ├── sessions/switch → 会话管理
                    └── 注册表 → 项目自动注册
```

总 agent 和项目 agent 共用 `feishu-bot.ts`，通过 `process.cwd()` 判断角色：

| 启动目录 | 角色 | 命令 |
|----------|------|------|
| 用户根目录 | 总 agent | `/feishu-bot-start` / `stop` |
| 项目目录 | 项目 agent | `/feishu-agent-register`（自动注册） |

HTTP 服务由 `feishu-server.ts` 以**独立子进程**运行，`stop` 通过 `netstat` + `taskkill` 杀进程释放端口，总 agent 不受影响。

## 获取飞书凭据

1. [飞书开放平台](https://open.feishu.cn/app) → 创建企业自建应用
2. **凭证与基础信息** → App ID、App Secret
3. **权限管理** → 添加 `im:message` + `im:message:send_as_bot`
4. **事件与回调** → **加密策略** → 重置 Encrypt Key
5. 设环境变量（可选，不设则用默认值）：
   ```
   set FEISHU_APP_ID=cli_xxx
   set FEISHU_APP_SECRET=xxx
   set FEISHU_ENCRYPT_KEY=xxx
   ```

## 配置公网穿透

```bash
# nps（自有服务器）
npc

# ngrok（免费）
ngrok http 8087

# cloudflared（免费）
cloudflared tunnel --url http://localhost:8087
```

## 飞书端配置

1. **事件与回调** → **事件配置**：
   - 订阅方式：将事件发送至开发者服务器
   - 请求地址：`http://公网:端口/feishu/event`
   - 添加事件：`im.message.receive_v1`
   - Encrypt Key 必须与代码一致
2. **应用发布** → 创建版本 → 发布

## 用法

| 飞书消息 | 效果 |
|----------|------|
| 直接发问题 | 总 agent 回答（支持 sessions/switch） |
| `list` | 查看已注册项目 |
| `sessions` | 总 agent 会话树 |
| `switch 关键词` | 切换总 agent 会话 |
| `F302 问题` | 路由到项目 agent |
| `F302 sessions` | 项目会话树 |
| `F302 switch 关键词` | 切换项目会话（弹新 pi 窗口） |

## 加解密要点

- key = SHA256(EncryptKey)
- 密文格式：`base64(随机16字节IV + AES-256-CBC密文)`
- IV 从密文前 16 字节提取，**不是** key 的前 16 字节
- URL 验证响应：**明文** `{"challenge":"xxx"}`，即使配了 Encrypt Key 也返回明文

## 注意事项

- 凭据优先读环境变量，fallback 到代码常量
- `stop` 用 `taskkill` 杀进程，Windows 上百分百生效
- 切换会话弹新 pi 窗口，旧窗口需手动关（不杀进程避免飞书断连）
- `feishu-server.ts` 不能放 `extensions/` 目录（会被当扩展加载）
- bun.exe 路径自动检测，找不到则提示设 `BUN_PATH`
