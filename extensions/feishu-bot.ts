// 飞书 Pi 多项目机器人 v10
// HTTP 服务独立子进程，start/stop 真杀进程

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHash, createCipheriv, createDecipheriv } from "node:crypto";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawn, ChildProcess } from "node:child_process";

const APP_ID = process.env.FEISHU_APP_ID || "cli_aac761d877f8dbe3";
const APP_SECRET = process.env.FEISHU_APP_SECRET || "GoCDIwtbdaIBUwF1iqf2OeQUJ6QwTI2C";
const ENCRYPT_KEY = process.env.FEISHU_ENCRYPT_KEY || "tqI9UA7zdCeKMqp2i4YUFhLQm08wvjyZ";
const FEISHU_BASE = "https://open.feishu.cn/open-apis";
const MASTER_PORT = 8087;

let piApi: ExtensionAPI | null = null;
let projectPort = 0, isMaster = false;

// ═══ 飞书工具函数（项目 agent 也用） ═══
let accessToken = "", tokenExpire = 0;
async function feishuToken(): Promise<string> {
  if (accessToken && Date.now() < tokenExpire) return accessToken;
  const r = await fetch(`${FEISHU_BASE}/auth/v3/tenant_access_token/internal`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }) });
  const d: any = await r.json(); if (d.code !== 0) throw new Error(`token: ${d.msg}`);
  accessToken = d.tenant_access_token; tokenExpire = Date.now() + (d.expire - 300) * 1000; return accessToken;
}
async function sendToChat(chatId: string, text: string) {
  try { const t = await feishuToken(); await fetch(`${FEISHU_BASE}/im/v1/messages?receive_id_type=chat_id`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` }, body: JSON.stringify({ receive_id: chatId, msg_type: "text", content: JSON.stringify({ text }) }) }); } catch {}
}
function projectName(cwd: string) { const p = cwd.replace(/\\/g, "/").split("/").filter(Boolean); return p[p.length - 1] || "?"; }

// ═══ 会话管理（主/项目共用） ═══
function sessionsDir(cwd: string): string {
  const local = join(cwd, ".pi", "sessions");
  if (existsSync(local)) return local;
  const b = process.env.PI_CODING_AGENT_SESSION_DIR || join(process.env.PI_CODING_AGENT_DIR || join(process.env.HOME || process.env.USERPROFILE || "", ".pi", "agent"), "sessions");
  return join(b, "--" + cwd.replace(/[\\:]/g, "-").replace(/\/$/, "") + "--");
}
interface SessionMeta { file: string; id: string; name: string; parent: string | null; date: string; firstMsg: string; }
function buildSessionIndex(cwd: string): Map<string, SessionMeta> {
  const m = new Map<string, SessionMeta>(); const d = sessionsDir(cwd); if (!existsSync(d)) return m;
  for (const f of readdirSync(d).filter(x => x.endsWith(".jsonl")).sort().reverse()) { try {
    const lines = readFileSync(join(d, f), "utf-8").split("\n"); const h = JSON.parse(lines[0]); const id = h.id?.slice(0, 12) || ""; let dn = "", fm = "";
    for (const l of lines) { try { const e = JSON.parse(l); if (e.type === "session_info" && e.name) dn = e.name; if (!fm && e.type === "message" && e.message?.role === "user") fm = (typeof e.message.content === "string" ? e.message.content : e.message.content?.[0]?.text || ""); } catch {} }
    if (!dn) dn = fm.slice(0, 30) || id; let p: string | null = null;
    if (h.parentSession) { const pp = h.parentSession.split("\\").pop()?.split("_") || []; p = pp[pp.length - 1]?.slice(0, 12) || null; }
    m.set(id, { file: join(d, f), id, name: dn, parent: p, date: f.slice(0, 10), firstMsg: fm.slice(0, 25) });
  } catch {} } return m;
}
function listSessions(cwd: string, label: string): string {
  const metas = buildSessionIndex(cwd); const visited = new Set<string>(); let out = `「${label}」会话树：\n`;
  function render(m: SessionMeta, dp: number, n: number) { if (visited.has(m.id)) return ""; visited.add(m.id); const pre = "  ".repeat(dp) + (dp > 0 ? "├─ " : ""); let l = `${pre}${n}. [${m.date}] ${m.name}`; if (m.firstMsg && m.name !== m.firstMsg) l += ` (${m.firstMsg}...)`; out += l + "\n"; let ci = 0; for (const [, s] of metas) { if (s.parent === m.id) render(s, dp + 1, ++ci); } }
  let idx = 0; for (const [, m] of metas) { if (!m.parent || !metas.has(m.parent)) render(m, 0, ++idx); }
  for (const [, m] of metas) { if (!visited.has(m.id)) render(m, 0, ++idx); }
  return out + "\n切换：switch 关键词";
}
async function switchSession(cwd: string, target: string, label: string, autoExit = false): Promise<string> {
  const metas = buildSessionIndex(cwd); const tl = target.toLowerCase();
  for (const [, m] of metas) { if (m.name.toLowerCase().includes(tl)) { const { exec } = await import("node:child_process"); exec(`start "PiAgent" cmd /c ""${process.execPath}" --session "${m.file}""`, { cwd }); if (autoExit) setTimeout(() => process.exit(0), 5000); return `✅ 切换到「${m.name}」`; } }
  return `未匹配「${target}」`;
}

// ═══ 项目 agent 对话逻辑 ═══
type PendingItem = { resolve: (text: string) => void; timeout: ReturnType<typeof setTimeout> };
function consumeReply(replyQueue: Map<string, PendingItem>, messages: any[]) {
  if (replyQueue.size === 0) return;
  for (let i = messages.length - 1; i >= 0; i--) { if (messages[i]?.role === "assistant") { const ts: string[] = []; for (const b of messages[i].content) { if (b.type === "text" && b.text) ts.push(b.text); } if (ts.length > 0) { const [k, it] = Array.from(replyQueue.entries())[0]; clearTimeout(it.timeout); replyQueue.delete(k); it.resolve(ts.join("\n").slice(0, 4000)); return; } } }
}
function directAsk(q: string, chatId: string, label: string, replyQueue: Map<string, PendingItem>, seqRef: { v: number }) {
  const sid = String(++seqRef.v);
  const p = new Promise<string>((resolve) => { const t = setTimeout(() => { replyQueue.delete(sid); resolve("⏰ 超时"); }, 180_000); replyQueue.set(sid, { resolve, timeout: t }); });
  piApi!.sendUserMessage(q);
  p.then((r) => { sendToChat(chatId, `【${label}】\n${r}`).catch(() => {}); });
}

// ═══════════════════════════════════════════
export default function (pi: ExtensionAPI) {
  piApi = pi;
  const home = (process.env.USERPROFILE || process.env.HOME || "").toLowerCase().replace(/\\/g, "/");
  const cwd = process.cwd();
  isMaster = cwd.toLowerCase().replace(/\\/g, "/") === home;

  if (isMaster) {
    let child: ChildProcess | null = null;
    const replyQueue = new Map<string, PendingItem>();
    const seqRef = { v: 0 };
    const masterPort = MASTER_PORT + Math.floor(Math.random() * 50) + 50; // 8137-8187
    let localSrv: ReturnType<typeof Bun.serve> | null = null;

    pi.on("agent_end", (event) => { consumeReply(replyQueue, (event as any).messages || []); });

    pi.registerCommand("feishu-bot-start", {
      description: "启动总 agent（独立子进程）",
      async handler(_args, ctx) {
        // 检测是否已有服务在运行
        let serverRunning = false;
        try { serverRunning = (await fetch(`http://127.0.0.1:${MASTER_PORT}/feishu/health`, { signal: AbortSignal.timeout(2000) })).ok; } catch {}
        // 找到 feishu-server.ts 路径
        // 找 bun.exe 完整路径（pi 环境中 bun 不在 PATH）
        const agentDir = process.env.PI_CODING_AGENT_DIR || join(process.env.HOME || process.env.USERPROFILE || "", ".pi", "agent");
        const serverPath = join(agentDir, "feishu-server.ts");
        const maybeBun = [
          join(process.env.APPDATA || "", "npm/node_modules/bun/bin/bun.exe"),
          join(process.env.USERPROFILE || "", ".bun/bin/bun.exe"),
          join(process.env.LOCALAPPDATA || "", "bun/bun.exe"),
          "bun.exe",
        ];
        let bunExe = "";
        for (const p of maybeBun) { if (existsSync(p)) { bunExe = p; break; } }
        if (!bunExe) { ctx.ui.notify("未找到 bun.exe，请设置 BUN_PATH 环境变量", "error"); return; }
        if (!serverRunning) {
          const sessionFile = (ctx as any).sessionManager?.getSessionFile?.() || "";
          child = spawn(bunExe, ["run", serverPath], {
          env: {
            ...process.env,
            FEISHU_APP_ID: APP_ID,
            FEISHU_APP_SECRET: APP_SECRET,
            FEISHU_ENCRYPT_KEY: ENCRYPT_KEY,
            FEISHU_PORT: String(MASTER_PORT),
            FEISHU_MASTER_CWD: cwd,
            FEISHU_ORIGIN_SESSION: sessionFile,
          },
          stdio: "ignore",
          detached: true,
        });
        child.unref();
        child.on("exit", () => { child = null; });
        ctx.ui.notify(`总 agent :${MASTER_PORT}（子进程）`, "info");
        }

        // 启动本地 /ask 端点（永远执行）
        if (!localSrv) {
          localSrv = Bun.serve({
            port: masterPort,
            async fetch(req) {
              const url = new URL(req.url);
              if (url.pathname === "/ask" && req.method === "POST") {
                try {
                  const { question, chatId } = JSON.parse(await req.text());
                  if (question.trim() === "sessions" || question.trim() === "会话列表") { sendToChat(chatId, listSessions(cwd, "总 agent")).catch(() => {}); return new Response(JSON.stringify({ ok: true })); }
                  if (question.startsWith("/switch") || question.startsWith("switch ")) { const t = question.replace(/^\/(switch|切换)\s*/, "").replace(/^switch\s+/, "").trim(); switchSession(cwd, t, "总 agent").then(r => sendToChat(chatId, r)).catch(() => {}); return new Response(JSON.stringify({ ok: true })); }
                  if (question.startsWith("/resume")) { piApi!.sendUserMessage("/resume"); sendToChat(chatId, "已打开 /resume").catch(() => {}); return new Response(JSON.stringify({ ok: true })); }
                  directAsk(question, chatId, "总 agent", replyQueue, seqRef);
                  return new Response(JSON.stringify({ ok: true }));
                } catch { return new Response("{}"); }
              }
              return new Response("nf", { status: 404 });
            },
          });
          // 注册到 HTTP 服务
          try {
            await fetch(`http://127.0.0.1:${MASTER_PORT}/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "总 agent", cwd, port: masterPort }), signal: AbortSignal.timeout(5000) });
          } catch {}
        }
      },
    });

    pi.registerCommand("feishu-bot-stop", {
      description: "停止总 agent",
      async handler(_args, ctx) {
        try {
          const { execSync } = await import("node:child_process");
          const out = execSync(`netstat -ano | findstr ":8087 "`, { encoding: "utf-8" });
          const m = out.match(/LISTENING\s+(\d+)/g);
          if (m) for (const pid of [...new Set(m.map(x => x.split(/\s+/).pop()).filter(p => p && p !== "0"))]) execSync(`taskkill /PID ${pid} /F`, { timeout: 3000 });
          child = null;
          ctx.ui.notify("已停止", "info");
        } catch (e: any) { ctx.ui.notify(`失败: ${e.message}`, "error"); }
      },
    });
    return;
  }

  // ═══ 项目 agent（不变） ═══
  const name = projectName(cwd);
  projectPort = MASTER_PORT + 100 + Math.floor(Math.random() * 100);
  const replyQueue = new Map<string, PendingItem>();
  const seqRef = { v: 0 };
  let server: ReturnType<typeof Bun.serve> | null = null;

  pi.on("agent_end", (event) => { consumeReply(replyQueue, (event as any).messages || []); });

  function startProjectHttp() {
    return Bun.serve({
      port: projectPort,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/ask" && req.method === "POST") {
          try {
            const { question, chatId } = JSON.parse(await req.text());
            if (question.trim() === "sessions" || question.trim() === "会话列表") { sendToChat(chatId, listSessions(cwd, name)).catch(() => {}); return new Response(JSON.stringify({ ok: true })); }
            if (question.startsWith("/switch") || question.startsWith("switch ")) { const t = question.replace(/^\/(switch|切换)\s*/, "").replace(/^switch\s+/, "").trim(); switchSession(cwd, t, name, true).then(r => sendToChat(chatId, r)).catch(() => {}); return new Response(JSON.stringify({ ok: true })); }
            if (question.startsWith("/resume")) { piApi!.sendUserMessage("/resume"); sendToChat(chatId, "已打开 /resume").catch(() => {}); return new Response(JSON.stringify({ ok: true })); }
            directAsk(question, chatId, name, replyQueue, seqRef);
            return new Response(JSON.stringify({ ok: true }));
          } catch { return new Response("{}"); }
        }
        if (url.pathname === "/health") return new Response("ok");
        return new Response("nf", { status: 404 });
      },
    });
  }

  pi.on("session_start", () => {
    setTimeout(async () => {
      if (server) return;
      try { await fetch(`http://127.0.0.1:${MASTER_PORT}/feishu/health`, { signal: AbortSignal.timeout(2000) }); } catch { return; }
      server = startProjectHttp();
      try { await fetch(`http://127.0.0.1:${MASTER_PORT}/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, cwd, port: projectPort }), signal: AbortSignal.timeout(3000) }); } catch {}
    }, 1500);
  });

  pi.registerCommand("feishu-agent-register", {
    description: "注册到总 agent",
    async handler(_args, ctx) {
      if (server) { ctx.ui.notify("已运行", "info"); return; }
      server = startProjectHttp();
      try {
        await fetch(`http://127.0.0.1:${MASTER_PORT}/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, cwd, port: projectPort }), signal: AbortSignal.timeout(3000) });
        ctx.ui.notify(`✅ 「${name}」已注册`, "info");
      } catch { ctx.ui.notify(`项目 agent :${projectPort}，总 agent 未在线`, "warn"); }
    },
  });
}
