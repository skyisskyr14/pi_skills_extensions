// 飞书个人机器人 extension
// 启动后监听飞书消息，调 pi -p 自动回复
// ponytail: 方案A纯问答模式，无文件操作

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { execSync } from "node:child_process";
import { randomInt, createHash, createCipheriv, createDecipheriv } from "node:crypto";

// ── 配置 ──
const APP_ID = "cli_aac761d877f8dbe3";
const APP_SECRET = "GoCDIwtbdaIBUwF1iqf2OeQUJ6QwTI2C";
const ENCRYPT_KEY = "tqI9UA7zdCeKMqp2i4YUFhLQm08wvjyZ";
const PORT = Number(process.env.FEISHU_PORT) || 8087;
const FEISHU_BASE = "https://open.feishu.cn/open-apis";

// ── 飞书事件加解密 ──
// 飞书使用 AES-256-CBC + 自定义消息结构
// key = SHA256(encrypt_key)，iv = key 前16字节
// 加密消息结构: {16字节随机}{4字节长度(大端)}{消息体}{corp_id}
function getAesKey(): Buffer {
  return createHash("sha256").update(ENCRYPT_KEY).digest();
}

// 解密飞书加密消息，返回 JSON 字符串
// 飞书格式: base64(16字节随机IV + AES密文)，key=SHA256(EncryptKey)
function decrypt(encryptText: string): string {
  const key = getAesKey();
  const raw = Buffer.from(encryptText, "base64");
  const iv = raw.subarray(0, 16);       // 前16字节是随机IV
  const ciphertext = raw.subarray(16);   // 后面是密文
  const decipher = createDecipheriv("aes-256-cbc", key, iv);
  decipher.setAutoPadding(true);  // 让 Node 自动处理 PKCS7
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString("utf-8");
}

// 加密飞书消息，返回 base64
// 格式: base64(16字节随机IV + AES密文)
function encrypt(plainText: string): string {
  const key = getAesKey();
  const iv = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) iv[i] = Math.floor(Math.random() * 256);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  cipher.setAutoPadding(true);
  const encrypted = Buffer.concat([cipher.update(plainText, "utf-8"), cipher.final()]);
  return Buffer.concat([iv, encrypted]).toString("base64");
}

let accessToken = "";
let tokenExpire = 0;
let server: ReturnType<typeof createServer> | null = null;
// 调试用：记录最后一次飞书请求
let lastDebug: any = {};

// ── 获取 tenant_access_token ──
async function refreshToken(): Promise<string> {
  const now = Date.now();
  if (accessToken && now < tokenExpire) return accessToken;

  const resp = await fetch(`${FEISHU_BASE}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  });
  const data: any = await resp.json();
  if (data.code !== 0) throw new Error(`飞书 token 获取失败: ${data.msg}`);
  accessToken = data.tenant_access_token;
  tokenExpire = now + (data.expire - 300) * 1000; // 提前5分钟刷新
  return accessToken;
}

// ── 发送消息 ──
async function sendMessage(receiveId: string, content: string) {
  const token = await refreshToken();
  const msgId = randomInt(100000, 999999).toString();
  const body = {
    receive_id: receiveId,
    msg_type: "text",
    content: JSON.stringify({ text: content }),
  };
  const resp = await fetch(`${FEISHU_BASE}/im/v1/messages?receive_id_type=chat_id`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const result: any = await resp.json();
  lastDebug.feishuApiResp = result;
  if (result.code !== 0) {
    throw new Error(`飞书发消息失败: [${result.code}] ${result.msg}`);
  }
  return result;
}

// ── 调 pi -p 问答 ──
function askPi(question: string): string {
  try {
    const result = execSync(`pi -p ${escapeArg(question)} --no-session`, {
      encoding: "utf-8",
      timeout: 120_000, // 2分钟超时
      maxBuffer: 100 * 1024,
    });
    return result.trim() || "（pi 未返回内容）";
  } catch (e: any) {
    return `pi 调用失败: ${e.stderr || e.message}`;
  }
}

function escapeArg(s: string): string {
  if (process.platform === "win32") {
    return `"${s.replace(/"/g, '\\"')}"`;
  }
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// ── 解析请求 body ──
function parseBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => resolve(body));
  });
}

// ── 处理飞书事件回调 ──
async function handleRequest(req: IncomingMessage, res: ServerResponse) {
  if (req.url?.startsWith("/feishu/event") && req.method === "POST") {
    const body = await parseBody(req);
    try {
      const raw: any = JSON.parse(body);

      // 飞书加密模式：body 里是 { "encrypt": "base64..." }
      if (raw.encrypt) {
        lastDebug = { time: new Date().toISOString(), encryptLen: raw.encrypt.length, encryptPreview: raw.encrypt.slice(0, 40) };
        console.log("[飞书] 收到加密请求, encrypt前20字符:", raw.encrypt.slice(0, 20));
        let decryptedStr: string;
        let decrypted: any;
        try {
          decryptedStr = decrypt(raw.encrypt);
          lastDebug.decrypted = decryptedStr;
          decrypted = JSON.parse(decryptedStr);
        } catch (e: any) {
          lastDebug.error = e.message;
          console.error("[飞书] 解密失败:", e.message);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ encrypt: encrypt(JSON.stringify({ code: -1, msg: e.message })) }));
          return;
        }

        // URL 验证 — 直接返回明文 challenge（部分飞书版本不要求加密返回）
        if (decrypted.type === "url_verification") {
          lastDebug.challenge = decrypted.challenge;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ challenge: decrypted.challenge }));
          return;
        }

        // 事件回调 — decrypted 已经是解析好的对象
        if (decrypted.header?.event_type === "im.message.receive_v1") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ encrypt: encrypt(JSON.stringify({ code: 0 })) }));

          const msgContent = JSON.parse(decrypted.event?.message?.content || "{}");
          const text = msgContent.text || "";
          const chatId = decrypted.event?.message?.chat_id;
          const senderType = decrypted.event?.sender?.sender_type;

          if (text && chatId && senderType === "user") {
            lastDebug.lastMsg = text;
            try {
              const reply = askPi(text);
              lastDebug.lastReply = reply.slice(0, 200);
              await sendMessage(chatId, reply);
              lastDebug.sent = "ok";
            } catch (e: any) {
              lastDebug.sendError = e.message;
            }
          } else {
            lastDebug.skipReason = `text:${!!text} chatId:${!!chatId} sender:${senderType}`;
          }
          return;
        }
      }

      res.writeHead(200);
      res.end("ok");
    } catch (e) {
      console.error("[飞书] 处理事件失败:", e);
      res.writeHead(500);
      res.end("error");
    }
    return;
  }

  // 调试端点
  if (req.url === "/feishu/debug") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", port: PORT, ...lastDebug }, null, 2));
    return;
  }

  // 健康检查
  if (req.url === "/feishu/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", port: PORT }));
    return;
  }

  res.writeHead(404);
  res.end("not found");
}

export default function (pi: ExtensionAPI) {
  // ponytail: 注册命令来启停，不用自动启动
  pi.registerCommand("feishu-bot-start", {
    description: "启动飞书个人机器人（方案A：纯问答）",
    async handler(_args, ctx) {
      if (server) {
        ctx.ui.notify("飞书 bot 已在运行中", "info");
        return;
      }
      if (!APP_ID || !APP_SECRET) {
        ctx.ui.notify("请配置 APP_ID 和 APP_SECRET", "error");
        return;
      }

      server = createServer(handleRequest);
      server.listen(PORT, () => {
        const msg = `飞书 bot 已启动，端口 ${PORT}
ngrok: ngrok http ${PORT}
回调地址: https://xxx.ngrok-free.app/feishu/event
事件类型: im.message.receive_v1`;
        ctx.ui.notify(msg, "info");
        console.log(`[飞书] HTTP 服务运行在 http://localhost:${PORT}`);
      });
    },
  });

  pi.registerCommand("feishu-bot-stop", {
    description: "停止飞书个人机器人",
    async handler(_args, ctx) {
      if (!server) {
        ctx.ui.notify("飞书 bot 未在运行", "info");
        return;
      }
      server.close();
      server = null;
      ctx.ui.notify("飞书 bot 已停止", "info");
    },
  });
}
