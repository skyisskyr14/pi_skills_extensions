// 飞书 bot HTTP 服务进程（独立进程，可被主进程 kill）
// 由 feishu-bot.ts 的 start 命令 spawn，stop 命令 kill

import { createHash, createCipheriv, createDecipheriv } from "node:crypto";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const APP_ID = process.env.FEISHU_APP_ID || "";
const APP_SECRET = process.env.FEISHU_APP_SECRET || "";
const ENCRYPT_KEY = process.env.FEISHU_ENCRYPT_KEY || "";
const PORT = parseInt(process.env.FEISHU_PORT || "8087");
const FEISHU_BASE = "https://open.feishu.cn/open-apis";
const MASTER_CWD = process.env.FEISHU_MASTER_CWD || process.cwd();

let accessToken = "", tokenExpire = 0;

function getAesKey() { return createHash("sha256").update(ENCRYPT_KEY).digest(); }
function decrypt(t: string) { const k = getAesKey(), r = Buffer.from(t, "base64"); const d = createDecipheriv("aes-256-cbc", k, r.subarray(0, 16)); d.setAutoPadding(true); return Buffer.concat([d.update(r.subarray(16)), d.final()]).toString("utf-8"); }
function encrypt(t: string) { const k = getAesKey(), iv = Buffer.alloc(16); for (let i = 0; i < 16; i++) iv[i] = Math.floor(Math.random() * 256); const c = createCipheriv("aes-256-cbc", k, iv); c.setAutoPadding(true); return Buffer.concat([iv, c.update(t, "utf-8"), c.final()]).toString("base64"); }

async function feishuToken() {
  if (accessToken && Date.now() < tokenExpire) return accessToken;
  const r = await fetch(`${FEISHU_BASE}/auth/v3/tenant_access_token/internal`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }) });
  const d: any = await r.json(); if (d.code !== 0) throw new Error(`token: ${d.msg}`);
  accessToken = d.tenant_access_token; tokenExpire = Date.now() + (d.expire - 300) * 1000; return accessToken;
}

async function sendToChat(chatId: string, text: string) {
  try { const t = await feishuToken(); await fetch(`${FEISHU_BASE}/im/v1/messages?receive_id_type=chat_id`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` }, body: JSON.stringify({ receive_id: chatId, msg_type: "text", content: JSON.stringify({ text }) }) }); } catch {}
}

function sessionsDir(cwd: string) {
  const b = process.env.PI_CODING_AGENT_SESSION_DIR || join(process.env.PI_CODING_AGENT_DIR || join(process.env.HOME || process.env.USERPROFILE || "", ".pi", "agent"), "sessions");
  return join(b, "--" + cwd.replace(/[\\:]/g, "-").replace(/\/$/, "") + "--");
}

interface SessionMeta { file: string; id: string; name: string; parent: string | null; date: string; firstMsg: string; }

function buildSessionIndex(cwd: string) {
  const m = new Map<string, SessionMeta>(); const d = sessionsDir(cwd); if (!existsSync(d)) return m;
  for (const f of readdirSync(d).filter(x => x.endsWith(".jsonl")).sort().reverse()) { try {
    const lines = readFileSync(join(d, f), "utf-8").split("\n"); const h = JSON.parse(lines[0]); const id = h.id?.slice(0, 12) || ""; let dn = "", fm = "";
    for (const l of lines) { try { const e = JSON.parse(l); if (e.type === "session_info" && e.name) dn = e.name; if (!fm && e.type === "message" && e.message?.role === "user") fm = (typeof e.message.content === "string" ? e.message.content : e.message.content?.[0]?.text || ""); } catch {} }
    if (!dn) dn = fm.slice(0, 30) || id; let p: string | null = null;
    if (h.parentSession) { const pp = h.parentSession.split("\\").pop()?.split("_") || []; p = pp[pp.length - 1]?.slice(0, 12) || null; }
    m.set(id, { file: join(d, f), id, name: dn, parent: p, date: f.slice(0, 10), firstMsg: fm.slice(0, 25) });
  } catch {} } return m;
}

function listSessions(cwd: string, label: string) {
  const d = sessionsDir(cwd); if (!existsSync(d)) return "无会话目录"; const fs = readdirSync(d).filter(f => f.endsWith(".jsonl")); if (!fs.length) return "暂无";
  const metas = buildSessionIndex(cwd); const visited = new Set<string>(); let out = `「${label}」会话树（${fs.length}个）：\n`;
  function render(m: SessionMeta, dp: number, n: number) { if (visited.has(m.id)) return ""; visited.add(m.id); const pre = "  ".repeat(dp) + (dp > 0 ? "├─ " : ""); let l = `${pre}${n}. [${m.date}] ${m.name}`; if (m.firstMsg && m.name !== m.firstMsg) l += ` (${m.firstMsg}...)`; out += l + "\n"; let ci = 0; for (const [, s] of metas) { if (s.parent === m.id) render(s, dp + 1, ++ci); } }
  let idx = 0; for (const [, m] of metas) { if (!m.parent || !metas.has(m.parent)) render(m, 0, ++idx); }
  for (const [, m] of metas) { if (!visited.has(m.id)) render(m, 0, ++idx); }
  return out;
}

async function switchSession(cwd: string, target: string, label: string) {
  const metas = buildSessionIndex(cwd); const tl = target.toLowerCase();
  for (const [, m] of metas) { if (m.name.toLowerCase().includes(tl)) { const { exec } = await import("node:child_process"); exec(`start "PiAgent" cmd /c ""${process.execPath}" --session "${m.file}""`, { cwd }); return `✅ 切换「${label}」→「${m.name}」`; } }
  return `未匹配「${target}」`;
}

// ── 注册表（内存，重启丢失）──
type ProjectInfo = { name: string; cwd: string; port: number; lastSeen: number };
const registry = new Map<string, ProjectInfo>();
let lastDebug: any = {};

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/feishu/event" && req.method === "POST") {
      const body = await req.text();
      try {
        const raw = JSON.parse(body);
        if (!raw.encrypt) return new Response("bad", { status: 400 });
        const dec = JSON.parse(decrypt(raw.encrypt));
        if (dec.type === "url_verification") return new Response(JSON.stringify({ challenge: dec.challenge }), { headers: { "Content-Type": "application/json" } });

        if (dec.header?.event_type === "im.message.receive_v1") {
          const c = JSON.parse(dec.event?.message?.content || "{}"), text = c.text || "", chatId = dec.event?.message?.chat_id;
          if (!text || !chatId || dec.event?.sender?.sender_type !== "user")
            return resp(JSON.stringify({ code: 0 }));
          lastDebug.lastMsg = text;

          if (text.trim().toLowerCase() === "list" || text.trim() === "列表") {
            const items = Array.from(registry.values()), pl = items.map((v, i) => `${i + 1}. ${v.name}`).join("\n");
            sendToChat(chatId, `【总 agent】\n${pl ? "项目：\n" + pl : "暂无"}\n直接发问题→回答\n项目名+问题→路由`).catch(() => {});
            return resp(JSON.stringify({ code: 0 }));
          }
          if (text.trim() === "sessions" || text.trim() === "会话列表") { sendToChat(chatId, listSessions(MASTER_CWD, "总 agent")).catch(() => {}); return resp(JSON.stringify({ code: 0 })); }
          if (text.startsWith("/switch") || text.startsWith("switch ")) {
            const t = text.replace(/^\/(switch|切换)\s*/, "").replace(/^switch\s+/, "").trim();
            switchSession(MASTER_CWD, t, "总 agent").then(r => sendToChat(chatId, r)).catch(() => {});
            return resp(JSON.stringify({ code: 0 }));
          }

          const pm = text.match(/^@?(\S+)\s+(.+)/);
          if (pm) {
            const nk = pm[1].toLowerCase();
            const info = registry.get(nk) || Array.from(registry.values()).find(v => v.name.toLowerCase().includes(nk));
            if (info) fetch(`http://127.0.0.1:${info.port}/ask`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: pm[2], chatId }), signal: AbortSignal.timeout(5000) }).catch(() => {});
            else sendToChat(chatId, `未找到「${pm[1]}」`).catch(() => {});
            return resp(JSON.stringify({ code: 0 }));
          }

          // 直接对话：转发到总 agent 本地端点
          const masterInfo = registry.get("总 agent");
          if (masterInfo) {
            fetch(`http://127.0.0.1:${masterInfo.port}/ask`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: text, chatId }), signal: AbortSignal.timeout(5000) }).catch(() => {});
          } else {
            sendToChat(chatId, "总 agent 未就绪，请等待注册完成").catch(() => {});
          }
          return resp(JSON.stringify({ code: 0 }));
        }
      } catch (e: any) { lastDebug.error = e.message; }
      return resp(JSON.stringify({ code: -1 }));
    }

    if (url.pathname === "/feishu/debug") return new Response(JSON.stringify(lastDebug, null, 2));
    if (url.pathname === "/feishu/health") return new Response('{"status":"ok"}');
    if (url.pathname === "/register" && req.method === "POST") {
      try { const i = JSON.parse(await req.text()); registry.set(i.name.toLowerCase(), { ...i, lastSeen: Date.now() }); return new Response(JSON.stringify({ ok: true })); } catch { return new Response("{}"); }
    }
    return new Response("nf", { status: 404 });
  },
});

function resp(body: string) {
  return new Response(encryptResponse(body), { headers: { "Content-Type": "application/json" } });
}
function encryptResponse(body: string) {
  return JSON.stringify({ encrypt: encrypt(body) });
}
