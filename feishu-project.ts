// 项目 agent HTTP 服务（独立子进程，stop 可杀不伤 pi）
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const PORT = parseInt(process.env.FEISHU_PORT || "8187");
const CWD = process.env.FEISHU_CWD || process.cwd();
const NAME = process.env.FEISHU_NAME || "unknown";
const PI_PORT = parseInt(process.env.FEISHU_PI_PORT || "0");

let accessToken = "", tokenExpire = 0;
const APP_ID = process.env.FEISHU_APP_ID || "";
const APP_SECRET = process.env.FEISHU_APP_SECRET || "";
const FEISHU_BASE = "https://open.feishu.cn/open-apis";

async function feishuToken() {
  if (accessToken && Date.now() < tokenExpire) return accessToken;
  const r = await fetch(`${FEISHU_BASE}/auth/v3/tenant_access_token/internal`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }) });
  const d: any = await r.json(); if (d.code !== 0) throw new Error(`token: ${d.msg}`);
  accessToken = d.tenant_access_token; tokenExpire = Date.now() + (d.expire - 300) * 1000; return accessToken;
}
async function sendToChat(chatId: string, text: string) {
  try { const t = await feishuToken(); await fetch(`${FEISHU_BASE}/im/v1/messages?receive_id_type=chat_id`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` }, body: JSON.stringify({ receive_id: chatId, msg_type: "text", content: JSON.stringify({ text }) }) }); } catch {}
}

// 会话管理（同 feishu-server.ts）
function sessionsDir(cwd: string) {
  const local = join(cwd, ".pi", "sessions");
  if (existsSync(local)) return local;
  const b = process.env.PI_CODING_AGENT_SESSION_DIR || join(process.env.PI_CODING_AGENT_DIR || join(process.env.HOME || process.env.USERPROFILE || "", ".pi", "agent"), "sessions");
  return join(b, "--" + cwd.replace(/[\\:]/g, "-").replace(/\/$/, "") + "--");
}
interface SMeta { file: string; id: string; name: string; parent: string | null; date: string; firstMsg: string; }
function buildIdx(cwd: string) {
  const m = new Map<string, SMeta>(); const d = sessionsDir(cwd); if (!existsSync(d)) return m;
  for (const f of readdirSync(d).filter(x => x.endsWith(".jsonl")).sort().reverse()) { try {
    const lines = readFileSync(join(d, f), "utf-8").split("\n"); const h = JSON.parse(lines[0]); const id = h.id?.slice(0, 12) || ""; let dn = "", fm = "";
    for (const l of lines) { try { const e = JSON.parse(l); if (e.type === "session_info" && e.name) dn = e.name; if (!fm && e.type === "message" && e.message?.role === "user") fm = (typeof e.message.content === "string" ? e.message.content : e.message.content?.[0]?.text || ""); } catch {} }
    if (!dn) dn = fm.slice(0, 30) || id; let p: string | null = null;
    if (h.parentSession) { const pp = h.parentSession.split("\\").pop()?.split("_") || []; p = pp[pp.length - 1]?.slice(0, 12) || null; }
    m.set(id, { file: join(d, f), id, name: dn, parent: p, date: f.slice(0, 10), firstMsg: fm.slice(0, 25) });
  } catch {} } return m;
}
function listSessions(cwd: string, label: string) {
  const metas = buildIdx(cwd); const visited = new Set<string>(); let out = `「${label}」会话树：\n`;
  function render(m: SMeta, dp: number, n: number) { if (visited.has(m.id)) return ""; visited.add(m.id); const pre = "  ".repeat(dp) + (dp > 0 ? "├─ " : ""); let l = `${pre}${n}. [${m.date}] ${m.name}`; if (m.firstMsg && m.name !== m.firstMsg) l += ` (${m.firstMsg}...)`; out += l + "\n"; let ci = 0; for (const [, s] of metas) { if (s.parent === m.id) render(s, dp + 1, ++ci); } }
  let idx = 0; for (const [, m] of metas) { if (!m.parent || !metas.has(m.parent)) render(m, 0, ++idx); }
  for (const [, m] of metas) { if (!visited.has(m.id)) render(m, 0, ++idx); }
  return out;
}
async function switchSession(cwd: string, target: string) {
  const metas = buildIdx(cwd); const tl = target.toLowerCase();
  for (const [, m] of metas) { if (m.name.toLowerCase().includes(tl)) { const { exec } = await import("node:child_process"); exec(`start "PiAgent" cmd /c ""${process.execPath}" --session "${m.file}""`, { cwd }); return `✅ 切换到「${m.name}」`; } }
  return `未匹配「${target}」`;
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/ask" && req.method === "POST") {
      try {
        const { question, chatId } = JSON.parse(await req.text());
        if (question.trim() === "sessions" || question.trim() === "会话列表") {
          const r = listSessions(CWD, NAME);
          if (chatId) sendToChat(chatId, r);
          return new Response(JSON.stringify({ ok: true, reply: r }));
        }
        if (question.startsWith("/switch") || question.startsWith("switch ")) {
          const t = question.replace(/^\/(switch|切换)\s*/, "").replace(/^switch\s+/, "").trim();
          const r = await switchSession(CWD, t);
          if (chatId) sendToChat(chatId, r);
          return new Response(JSON.stringify({ ok: true, reply: r }));
        }
        if (PI_PORT > 0) {
          try {
            const piResp = await fetch(`http://127.0.0.1:${PI_PORT}/feishu-ask`, {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ question, chatId }),
              signal: AbortSignal.timeout(200_000),
            });
            return new Response(JSON.stringify(await piResp.json()));
          } catch { return new Response(JSON.stringify({ ok: false, error: "pi无响应" })); }
        }
        return new Response(JSON.stringify({ ok: false }));
      } catch { return new Response("{}"); }
    }
    if (url.pathname === "/health") return new Response("ok");
    return new Response("nf", { status: 404 });
  },
});
