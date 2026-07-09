// 飞书路由脚本 v2 — 未知用户自动回复 open_id
const crypto = require("crypto");
const http = require("http");
const https = require("https");

const APP_ID = "cli_aac761d877f8dbe3";
const APP_SECRET = "GoCDIwtbdaIBUwF1iqf2OeQUJ6QwTI2C";
const ENCRYPT_KEY = "tqI9UA7zdCeKMqp2i4YUFhLQm08wvjyZ";
const PORT = 9999;
const USER_PORT = 18087;
const FRIEND_PORT = 18088;

const userMap = {
  "ou_c092a8ff2be6ec55e2a84859aaada5dc": USER_PORT,
  "ou_1c6cbe0ba663e938df3873ed1113ca8c": FRIEND_PORT,
};

function getAesKey() { return crypto.createHash("sha256").update(ENCRYPT_KEY).digest(); }
function decrypt(t) {
  const k = getAesKey(), r = Buffer.from(t, "base64");
  const d = crypto.createDecipheriv("aes-256-cbc", k, r.subarray(0, 16)); d.setAutoPadding(true);
  return Buffer.concat([d.update(r.subarray(16)), d.final()]).toString("utf-8");
}
function encrypt(t) {
  const k = getAesKey(), iv = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) iv[i] = Math.floor(Math.random() * 256);
  const c = crypto.createCipheriv("aes-256-cbc", k, iv); c.setAutoPadding(true);
  return Buffer.concat([iv, c.update(t, "utf-8"), c.final()]).toString("base64");
}

let token = "", expires = 0;
function getToken() {
  return new Promise((resolve, reject) => {
    if (token && Date.now() < expires) return resolve(token);
    const body = JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET });
    const req = https.request("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST", headers: { "Content-Type": "application/json" },
    }, res => { let d = ""; res.on("data", c => d += c); res.on("end", () => { const j = JSON.parse(d); token = j.tenant_access_token; expires = Date.now() + (j.expire - 300) * 1000; resolve(token); }); });
    req.on("error", reject); req.write(body); req.end();
  });
}

async function replyOpenId(openId, chatId) {
  try {
    const t = await getToken();
    const body = JSON.stringify({ receive_id: chatId, msg_type: "text", content: JSON.stringify({ text: `你的 open_id: ${openId}` }) });
    return new Promise(resolve => {
      const req = https.request("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` },
      }, res => { let d = ""; res.on("data", c => d += c); res.on("end", () => resolve(JSON.parse(d))); });
      req.write(body); req.end();
    });
  } catch (e) { console.error(e); }
}

function getOpenId(body) {
  try {
    const dec = JSON.parse(decrypt(body.encrypt));
    return {
      openId: (dec.event && dec.event.sender && dec.event.sender.sender_id && dec.event.sender.sender_id.open_id) || "",
      chatId: (dec.event && dec.event.message && dec.event.message.chat_id) || "",
      isVerification: dec.type === "url_verification",
      challenge: dec.challenge || "",
    };
  } catch (e) { return { openId: "", chatId: "", isVerification: false, challenge: "" }; }
}

http.createServer(async (req, res) => {
  if (req.method !== "POST" || !req.url.startsWith("/feishu/event")) {
    res.writeHead(404); res.end(); return;
  }
  let body = "";
  req.on("data", c => body += c);
  req.on("end", async () => {
    try {
      const raw = JSON.parse(body);
      const { openId, chatId, isVerification, challenge } = getOpenId(raw);

      // URL 验证：转发给你
      if (isVerification) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ challenge }));
        return;
      }

      const targetPort = userMap[openId];
      if (!targetPort) {
        // 未知用户：回复 open_id
        if (openId && chatId) replyOpenId(openId, chatId);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ encrypt: encrypt(JSON.stringify({ code: 0 })) }));
        return;
      }

      // 已知用户：转发
      const proxyReq = http.request({
        hostname: "127.0.0.1", port: targetPort, path: "/feishu/event",
        method: "POST", headers: { "Content-Type": "application/json" }, timeout: 10000,
      }, proxyRes => { let d = ""; proxyRes.on("data", c => d += c); proxyRes.on("end", () => { res.writeHead(proxyRes.statusCode, { "Content-Type": "application/json" }); res.end(d); }); });
      proxyReq.on("error", () => { res.writeHead(502); res.end(); });
      proxyReq.write(JSON.stringify(raw)); proxyReq.end();
    } catch (e) { res.writeHead(500); res.end(); }
  });
}).listen(PORT, () => console.log(`Router :${PORT} | user:${USER_PORT} friend:${FRIEND_PORT} | 未知用户自动回复open_id`));
