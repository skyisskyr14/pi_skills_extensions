// 飞书 Pi 多项目机器人 v8
// 总 agent → 直接对话 + 项目路由 + sessions/switch
// 项目 agent → sendUserMessage + agent_end + sessions/switch
//
// 配置方式（三选一）：
//   1. 环境变量: FEISHU_APP_ID, FEISHU_APP_SECRET, FEISHU_ENCRYPT_KEY
//   2. 修改下方常量
//   3. 首次运行时 pi 会提示配置

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { createHash, createCipheriv, createDecipheriv } from "node:crypto";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const APP_ID = process.env.FEISHU_APP_ID || "cli_aac761d877f8dbe3";
const APP_SECRET = process.env.FEISHU_APP_SECRET || "GoCDIwtbdaIBUwF1iqf2OeQUJ6QwTI2C";
const ENCRYPT_KEY = process.env.FEISHU_ENCRYPT_KEY || "tqI9UA7zdCeKMqp2i4YUFhLQm08wvjyZ";
const FEISHU_BASE = "https://open.feishu.cn/open-apis";
const MASTER_PORT = 8087;

let accessToken = "", tokenExpire = 0;
let server: ReturnType<typeof createServer> | null = null;
let lastDebug: any = {};
let piApi: ExtensionAPI | null = null;
let projectPort = 0, isMaster = false;

type PendingItem = { resolve: (text: string) => void; timeout: NodeJS.Timeout };
type ProjectInfo = { name: string; cwd: string; port: number; lastSeen: number };

// ── 加解密 ──
function getAesKey() { return createHash("sha256").update(ENCRYPT_KEY).digest(); }
function decrypt(t: string): string { const k = getAesKey(), r = Buffer.from(t, "base64"); const d = createDecipheriv("aes-256-cbc", k, r.subarray(0, 16)); d.setAutoPadding(true); return Buffer.concat([d.update(r.subarray(16)), d.final()]).toString("utf-8"); }
function encrypt(t: string): string { const k = getAesKey(), iv = Buffer.alloc(16); for (let i = 0; i < 16; i++) iv[i] = Math.floor(Math.random() * 256); const c = createCipheriv("aes-256-cbc", k, iv); c.setAutoPadding(true); return Buffer.concat([iv, c.update(t, "utf-8"), c.final()]).toString("base64"); }

async function feishuToken(): Promise<string> {
  if (accessToken && Date.now() < tokenExpire) return accessToken;
  const r = await fetch(`${FEISHU_BASE}/auth/v3/tenant_access_token/internal`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }) });
  const d: any = await r.json(); if (d.code !== 0) throw new Error(`token: ${d.msg}`);
  accessToken = d.tenant_access_token; tokenExpire = Date.now() + (d.expire - 300) * 1000; return accessToken;
}
function parseBody(req: IncomingMessage) { return new Promise<string>((r) => { let b = ""; req.on("data", (c: Buffer) => b += c.toString()); req.on("end", () => r(b)); }); }
function projectName(cwd: string) { const p = cwd.replace(/\\/g, "/").split("/").filter(Boolean); return p[p.length - 1] || "?"; }
function parseMsg(text: string) { const m = text.match(/^@?(\S+)\s+(.+)/); return m ? { project: m[1].toLowerCase(), question: m[2] } : null; }

async function sendToChat(chatId: string, text: string) {
  try {
    const token = await feishuToken();
    await fetch(`${FEISHU_BASE}/im/v1/messages?receive_id_type=chat_id`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ receive_id: chatId, msg_type: "text", content: JSON.stringify({ text }) }) });
  } catch {}
}

function sessionsDir(cwd: string): string {
  const base = process.env.PI_CODING_AGENT_SESSION_DIR || join(process.env.PI_CODING_AGENT_DIR || join(process.env.HOME || process.env.USERPROFILE || "", ".pi", "agent"), "sessions");
  return join(base, "--" + cwd.replace(/[\\:]/g, "-").replace(/\/$/, "") + "--");
}

interface SessionMeta { file: string; id: string; name: string; parent: string | null; date: string; firstMsg: string; }

function buildSessionIndex(cwd: string): Map<string, SessionMeta> {
  const metas = new Map<string, SessionMeta>();
  const dir = sessionsDir(cwd); if (!existsSync(dir)) return metas;
  const files = readdirSync(dir).filter(f => f.endsWith(".jsonl")).sort().reverse();
  for (const f of files) { try {
    const lines = readFileSync(join(dir, f), "utf-8").split("\n");
    const header = JSON.parse(lines[0]); const id = header.id?.slice(0, 12) || "";
    let dname = "", firstMsg = "";
    for (const line of lines) { try { const e = JSON.parse(line); if (e.type === "session_info" && e.name) dname = e.name; if (!firstMsg && e.type === "message" && e.message?.role === "user") { firstMsg = typeof e.message.content === "string" ? e.message.content : e.message.content?.[0]?.text || ""; } } catch {} }
    if (!dname) dname = firstMsg.slice(0, 30) || id;
    let parent: string | null = null;
    if (header.parentSession) { const p = header.parentSession.split("\\").pop()?.split("_") || []; parent = p[p.length - 1]?.slice(0, 12) || null; }
    metas.set(id, { file: join(dir, f), id, name: dname, parent, date: f.slice(0, 10), firstMsg: firstMsg.slice(0, 25) });
  } catch {} }
  return metas;
}

function listSessions(cwd: string, label: string): string {
  const dir = sessionsDir(cwd); if (!existsSync(dir)) return "无会话目录";
  const files = readdirSync(dir).filter(f => f.endsWith(".jsonl")); if (!files.length) return "暂无";
  const metas = buildSessionIndex(cwd);
  const visited = new Set<string>(); let out = `「${label}」会话树（${files.length}个）：\n`;
  function render(m: SessionMeta, d: number, n: number) { if (visited.has(m.id)) return ""; visited.add(m.id); const p = "  ".repeat(d) + (d > 0 ? "├─ " : ""); let l = `${p}${n}. [${m.date}] ${m.name}`; if (m.firstMsg && m.name !== m.firstMsg) l += ` (${m.firstMsg}...)`; out += l + "\n"; let ci = 0; for (const [, s] of metas) { if (s.parent === m.id) render(s, d + 1, ++ci); } }
  let idx = 0; for (const [, m] of metas) { if (!m.parent || !metas.has(m.parent)) render(m, 0, ++idx); }
  for (const [, m] of metas) { if (!visited.has(m.id)) render(m, 0, ++idx); }
  out += "\n切换：switch 关键词"; return out;
}

async function switchSession(cwd: string, target: string, label: string): Promise<string> {
  const dir = sessionsDir(cwd); if (!existsSync(dir)) return "无会话目录";
  const metas = buildSessionIndex(cwd); const tl = target.toLowerCase();
  for (const [, m] of metas) {
    if (m.name.toLowerCase() === tl || m.name.toLowerCase().includes(tl)) {
      const { exec } = await import("node:child_process");
      exec(`start "PiAgent" cmd /c ""${process.execPath}" --session "${m.file}""`, { cwd });
      if (piApi) piApi.sendUserMessage("旧会话（请手动关闭此窗口）");
      return `✅ 切换「${label}」→「${m.name}」\n新窗口已开，请手动关旧窗口`;
    }
  }
  for (const [, m] of metas) {
    if (m.firstMsg?.toLowerCase().includes(tl)) {
      const { exec } = await import("node:child_process");
      exec(`start "PiAgent" cmd /c ""${process.execPath}" --session "${m.file}""`, { cwd });
      if (piApi) piApi.sendUserMessage("旧会话（请手动关闭此窗口）");
      return `✅ 切换「${label}」→「${m.name}」\n新窗口已开，请手动关旧窗口`;
    }
  }
  return `未匹配「${target}」，发 sessions 查看`;
}

// ── HTTP 注册辅助 ──
async function registerToMaster(port: number, name: string, cwd: string) {
  try {
    const r = await fetch(`http://127.0.0.1:${MASTER_PORT}/register`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, cwd, port }),
      signal: AbortSignal.timeout(3000),
    });
    return (await r.json()).ok;
  } catch { return false; }
}

// ── 消费 agent_end 队列 ──
function consumeReply(replyQueue: Map<string, PendingItem>, messages: any[]): string | null {
  if (replyQueue.size === 0) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") {
      const texts: string[] = [];
      for (const b of messages[i].content) { if (b.type === "text" && b.text) texts.push(b.text); }
      if (texts.length > 0) {
        const [key, item] = Array.from(replyQueue.entries())[0];
        clearTimeout(item.timeout); replyQueue.delete(key);
        item.resolve(texts.join("\n").slice(0, 4000));
        return texts.join("\n").slice(0, 4000);
      }
    }
  }
  return null;
}

// ── 直接对话：入队 + sendUserMessage ──
function directAsk(question: string, chatId: string, label: string, replyQueue: Map<string, PendingItem>, seqRef: { v: number }) {
  const sid = String(++seqRef.v);
  const promise = new Promise<string>((resolve) => {
    const t = setTimeout(() => { replyQueue.delete(sid); resolve("⏰ 超时"); }, 180_000);
    replyQueue.set(sid, { resolve, timeout: t });
  });
  piApi!.sendUserMessage(question);
  promise.then((reply) => { sendToChat(chatId, `【${label}】\n${reply}`).catch(() => {}); });
}

// ═══════════════════════════════════════════
// 主入口
// ═══════════════════════════════════════════
export default function (pi: ExtensionAPI) {
  piApi = pi;
  const home = (process.env.USERPROFILE || process.env.HOME || "").toLowerCase().replace(/\\/g, "/");
  const cwd = process.cwd();
  isMaster = cwd.toLowerCase().replace(/\\/g, "/") === home;

  // ═══ 总 agent ═══
  if (isMaster) {
    const registry = new Map<string, ProjectInfo>();
    const replyQueue = new Map<string, PendingItem>();
    const seqRef = { v: 0 };
    const masterLabel = "总 agent";

    // agent_end → 消费回复队列
    pi.on("agent_end", (event) => {
      const reply = consumeReply(replyQueue, (event as any).messages || []);
    });

    // session_start → 自动注册（接收直接对话）
    pi.on("session_start", () => {
      // 确保 agent_end 监听已就绪（已在上面注册）
    });

    pi.registerCommand("feishu-bot-start", {
      description: "启动总 agent（直接对话 + 项目路由）",
      async handler(_args, ctx) {
        if (server) { ctx.ui.notify("已运行", "info"); return; }
        server = createServer(async (req, res) => {
          // ── 飞书事件 ──
          if (req.url === "/feishu/event" && req.method === "POST") {
            const body = await parseBody(req);
            try {
              const raw: any = JSON.parse(body);
              if (!raw.encrypt) { res.writeHead(400); res.end("bad"); return; }
              const dec = JSON.parse(decrypt(raw.encrypt));

              // URL 验证
              if (dec.type === "url_verification") {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ challenge: dec.challenge })); return;
              }

              // 消息事件
              if (dec.header?.event_type === "im.message.receive_v1") {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ encrypt: encrypt(JSON.stringify({ code: 0 })) }));
                const c = JSON.parse(dec.event?.message?.content || "{}");
                const text = c.text || "", chatId = dec.event?.message?.chat_id;
                if (!text || !chatId || dec.event?.sender?.sender_type !== "user") return;
                lastDebug.lastMsg = text;

                // ── 全局命令 ──
                if (text.trim().toLowerCase() === "list" || text.trim() === "列表") {
                  const items = Array.from(registry.values());
                  const projList = items.map((v, i) => `${i + 1}. ${v.name}`).join("\n");
                  await sendToChat(chatId, `【总 agent】直接对话\n${projList ? "项目：\n" + projList : "暂无项目"}\n\n用法：\n- 直接发问题 → 总 agent 回答\n- 项目名+问题 → 如 F302 你好\n- sessions → 总 agent 会话\n- switch xxx → 切换总 agent 会话`); return;
                }

                // ── 总 agent 自用命令 ──
                if (text.trim() === "sessions" || text.trim() === "会话列表") {
                  await sendToChat(chatId, listSessions(cwd, "总 agent")); return;
                }
                if (text.startsWith("/switch") || text.startsWith("switch ")) {
                  const t = text.replace(/^\/(switch|切换)\s*/, "").replace(/^switch\s+/, "").trim();
                  await sendToChat(chatId, await switchSession(cwd, t, "总 agent")); return;
                }
                if (text.startsWith("/resume")) {
                  piApi!.sendUserMessage("/resume");
                  await sendToChat(chatId, "已在终端打开 /resume"); return;
                }

                // ── 项目路由：F302 问题 → 转发 ──
                const parsed = parseMsg(text);
                if (parsed) {
                  // 先模糊匹配已注册项目
                  const nameKey = parsed.project.toLowerCase();
                  const info = registry.get(nameKey);
                  if (info) {
                    try { await fetch(`http://127.0.0.1:${info.port}/ask`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: parsed.question, chatId }), signal: AbortSignal.timeout(5000) }); } catch (e) {}
                    return;
                  }
                  // 模糊匹配
                  const subs = Array.from(registry.values()).filter(v => v.name.toLowerCase().includes(nameKey) || nameKey.includes(v.name.toLowerCase()));
                  if (subs.length === 1) {
                    try { await fetch(`http://127.0.0.1:${subs[0].port}/ask`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: parsed.question, chatId }), signal: AbortSignal.timeout(5000) }); } catch (e) {}
                    return;
                  }
                  if (subs.length > 1) { await sendToChat(chatId, `多个匹配：${subs.map(v => v.name).join(", ")}`); return; }
                  // 全都不匹配 → 当作普通对话
                }

                // ── 直接对话 ──
                directAsk(text, chatId, "总 agent", replyQueue, seqRef);
              }
            } catch (e: any) {
              lastDebug.error = e.message;
              try { res.writeHead(200); res.end("{}"); } catch {}
            }
            return;
          }

          // ── 管理端点 ──
          if (req.url === "/feishu/debug") { res.writeHead(200); res.end(JSON.stringify(lastDebug, null, 2)); return; }
          if (req.url === "/feishu/health") { res.writeHead(200); res.end('{"status":"ok"}'); return; }
          if (req.url === "/register" && req.method === "POST") {
            const b = await parseBody(req); const i: any = JSON.parse(b);
            registry.set(i.name.toLowerCase(), { ...i, lastSeen: Date.now() });
            res.writeHead(200); res.end(JSON.stringify({ ok: true })); return;
          }
          res.writeHead(404); res.end("nf");
        });
        server.listen(MASTER_PORT, () => ctx.ui.notify(`总 agent :${MASTER_PORT}（直接对话+路由）`, "info"));
      },
    });
    pi.registerCommand("feishu-bot-stop", { description: "停止", async handler(_args, ctx) { if (server) { server.close(); server = null; } ctx.ui.notify("已停止", "info"); } });
    return;
  }

  // ═══ 项目 agent ═══
  const name = projectName(cwd);
  projectPort = MASTER_PORT + 100 + Math.floor(Math.random() * 100);
  const replyQueue = new Map<string, PendingItem>();
  const seqRef = { v: 0 };

  // agent_end → 消费回复队列 → 异步发飞书
  pi.on("agent_end", (event) => {
    consumeReply(replyQueue, (event as any).messages || []);
  });

  // /ask 处理函数
  function startProjectHttp() {
    return createServer(async (req, res) => {
      if (req.url === "/ask" && req.method === "POST") {
        const body = await parseBody(req);
        const { question, chatId } = JSON.parse(body);

        // 项目自有命令
        if (question.trim() === "sessions" || question.trim() === "会话列表") {
          const r = listSessions(cwd, name);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          sendToChat(chatId, r).catch(() => {}); return;
        }
        if (question.startsWith("/switch") || question.startsWith("switch ")) {
          const t = question.replace(/^\/(switch|切换)\s*/, "").replace(/^switch\s+/, "").trim();
          const r = await switchSession(cwd, t, name);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          sendToChat(chatId, r).catch(() => {}); return;
        }
        if (question.startsWith("/resume")) {
          piApi!.sendUserMessage("/resume");
          res.writeHead(200); res.end(JSON.stringify({ ok: true }));
          sendToChat(chatId, "已打开 /resume").catch(() => {}); return;
        }
        if (question.startsWith("/tree")) {
          piApi!.sendUserMessage("/tree");
          res.writeHead(200); res.end(JSON.stringify({ ok: true }));
          sendToChat(chatId, "已打开 /tree").catch(() => {}); return;
        }

        // 普通问答：入队 + sendUserMessage
        directAsk(question, chatId, name, replyQueue, seqRef);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.url === "/health") { res.writeHead(200); res.end("ok"); return; }
      res.writeHead(404); res.end("nf");
    });
  }

  // 自动注册（仅当总 agent 在线时）
  pi.on("session_start", () => {
    setTimeout(async () => {
      if (server) return;
      // 先检测总 agent 是否在线
      try {
        await fetch(`http://127.0.0.1:${MASTER_PORT}/feishu/health`, { signal: AbortSignal.timeout(2000) });
      } catch {
        return; // 总 agent 不在线，不注册
      }
      server = startProjectHttp();
      server.listen(projectPort, async () => {
        const ok = await registerToMaster(projectPort, name, cwd);
        if (ok) console.log(`[agent] 「${name}」自动注册`);
      });
    }, 1500);
  });

  pi.registerCommand("feishu-agent-register", {
    description: "注册到总 agent",
    async handler(_args, ctx) {
      if (server) { ctx.ui.notify("已运行", "info"); return; }
      server = startProjectHttp();
      server.listen(projectPort, async () => {
        try {
          const r = await fetch(`http://127.0.0.1:${MASTER_PORT}/register`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, cwd, port: projectPort }),
            signal: AbortSignal.timeout(3000),
          });
          ctx.ui.notify((await r.json()).ok ? `✅ 「${name}」已注册` : "注册失败", "info");
        } catch { ctx.ui.notify(`项目 agent :${projectPort}，总 agent 未在线`, "warn"); }
      });
    },
  });
}
