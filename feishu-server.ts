// 飞书 bot HTTP 服务进程（独立进程，可被主进程 kill）
// 由 feishu-bot.ts 的 start 命令 spawn，stop 命令 kill

import { createHash, createCipheriv, createDecipheriv } from "node:crypto";
import { readdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ── 项目路径配置 ──
const PATHS_FILE = join(process.env.PI_CODING_AGENT_DIR || join(process.env.HOME || process.env.USERPROFILE || "", ".pi", "agent"), "project-paths.json");
function loadPaths(): string[] { try { return JSON.parse(readFileSync(PATHS_FILE, "utf-8")); } catch { return []; } }
function savePaths(p: string[]) { writeFileSync(PATHS_FILE, JSON.stringify(p, null, 2)); }

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
const ORIGIN_SESSION = process.env.FEISHU_ORIGIN_SESSION || "";
const processedMsgIds = new Set<string>();

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
          const msgId = dec.event?.message?.message_id || dec.header?.event_id || "";
          if (processedMsgIds.has(msgId)) return resp(JSON.stringify({ code: 0 }));
          if (processedMsgIds.size > 200) processedMsgIds.clear();
          processedMsgIds.add(msgId);
          const c = JSON.parse(dec.event?.message?.content || "{}"), text = c.text || "", chatId = dec.event?.message?.chat_id;
          if (!text || !chatId || dec.event?.sender?.sender_type !== "user")
            return resp(JSON.stringify({ code: 0 }));
          lastDebug.lastMsg = text;

          if (text.trim().toLowerCase() === "whoami" || text.trim() === "我是谁") {
            const uid = dec.event?.sender?.sender_id?.open_id || "未知";
            sendToChat(chatId, `open_id: ${uid}`).catch(() => {});
            return resp(JSON.stringify({ code: 0 }));
          }

          if (text.trim().toLowerCase() === "list" || text.trim() === "列表") {
            const items = Array.from(registry.values()), pl = items.map((v, i) => `${i + 1}. ${v.name}`).join("\n");
            sendToChat(chatId, `项目：\n${pl || "暂无"}\n\n编号+问题 如「1 你好」\n项目名+问题 如「F302 你好」\n直接对话→总 agent`).catch(() => {});
            return resp(JSON.stringify({ code: 0 }));
          }
          // 编号路由: "1 问题"
          const numMatch = text.match(/^(\d+)\s+(.+)/);
          if (numMatch) {
            const items = Array.from(registry.values());
            const idx = parseInt(numMatch[1]) - 1;
            if (idx >= 0 && idx < items.length) {
              const info = items[idx];
              if (info.port === 0) {
                // 总 agent：pi -p（用注册的 session 文件）
                const info2 = registry.get("总 agent");
                const sf = (info2 as any)?.sessionFile || ORIGIN_SESSION || join(process.env.PI_CODING_AGENT_SESSION_DIR || join(process.env.HOME || process.env.USERPROFILE || "", ".pi", "agent", "sessions"), "feishu-master.jsonl");
                (async () => {
                  try {
                    const { execSync } = await import("node:child_process");
                    const r = execSync(`pi -p --session "${sf}" "${numMatch[2].replace(/"/g, '\\"')}"`, { encoding: "utf-8", timeout: 300000, maxBuffer: 200 * 1024, cwd: MASTER_CWD, windowsHide: true }).toString().trim();
                    sendToChat(chatId, `【总 agent】\n${r.slice(0, 4000)}`).catch(() => {});
                  } catch (e) {}
                })();
              } else {
                fetch(`http://127.0.0.1:${info.port}/ask`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: numMatch[2], chatId }), signal: AbortSignal.timeout(5000) }).catch(() => {});
              }
            } else { sendToChat(chatId, `编号 ${numMatch[1]} 超出范围 (共${items.length}个)`).catch(() => {}); }
            return resp(JSON.stringify({ code: 0 }));
          }
          if (text.startsWith("/set-session") || text.startsWith("set-session")) {
            let sf = text.replace(/^\/?(set-session)\s+/, "").trim();
            if (sf === "origin") { sf = ORIGIN_SESSION; }
            if (!sf) { sendToChat(chatId, "用法: set-session <path> 或 set-session origin").catch(() => {}); return resp(JSON.stringify({ code: 0 })); }
            const info = registry.get("总 agent");
            if (info) (info as any).sessionFile = sf;
            sendToChat(chatId, `✅ 会话: ${sf.slice(-50)}`).catch(() => {});
            return resp(JSON.stringify({ code: 0 }));
          }

          if (text.trim() === "sessions" || text.trim() === "会话列表") {
            try {
              const r = listSessions(MASTER_CWD, "总 agent");
              await sendToChat(chatId, r);
            } catch (e: any) {
              await sendToChat(chatId, `错误: ${e.message}`);
            }
            return resp(JSON.stringify({ code: 0 }));
          }

          if (text.trim() === "projects" || text.trim() === "项目列表") {
            const paths = loadPaths();
            if (paths.length === 0) { sendToChat(chatId, "无项目路径。\nadd-path D:/path").catch(() => {}); return resp(JSON.stringify({ code: 0 })); }
            let out = "";
            for (const base of paths) {
              out += `📁 ${base}\n`;
              if (!existsSync(base)) { out += "  (目录不存在)\n"; continue; }
              const dirs = readdirSync(base, { withFileTypes: true }).filter(d => d.isDirectory() && existsSync(join(base, d.name, ".pi"))).map(d => d.name);
              if (dirs.length === 0) out += "  (无 pi 项目)\n";
              else dirs.forEach((d, i) => out += `  ${i + 1}. ${d}\n`);
            }
            out += "add-path / remove-path / projects";
            sendToChat(chatId, out).catch(() => {});
            return resp(JSON.stringify({ code: 0 }));
          }
          if (text.startsWith("add-path ") || text.startsWith("添加路径 ")) {
            const p = text.replace(/^(add-path|添加路径)\s+/, "").trim();
            if (!existsSync(p)) { sendToChat(chatId, `不存在: ${p}`).catch(() => {}); return resp(JSON.stringify({ code: 0 })); }
            const paths = loadPaths();
            if (paths.includes(p)) { sendToChat(chatId, "已存在").catch(() => {}); return resp(JSON.stringify({ code: 0 })); }
            paths.push(p); savePaths(paths);
            sendToChat(chatId, `✅ 已添加 ${p}`).catch(() => {});
            return resp(JSON.stringify({ code: 0 }));
          }
          if (text.startsWith("remove-path ") || text.startsWith("移除路径 ")) {
            const p = text.replace(/^(remove-path|移除路径)\s+/, "").trim();
            let paths = loadPaths(); paths = paths.filter(x => x !== p); savePaths(paths);
            sendToChat(chatId, `✅ 已移除 ${p}`).catch(() => {});
            return resp(JSON.stringify({ code: 0 }));
          }
          if (text.startsWith("start-pi ") || text.startsWith("启动 ")) {
            const name = text.replace(/^(start-pi|启动)\s+/, "").trim();
            const paths = loadPaths();
            const found: string[] = [];
            for (const base of paths) {
              if (!existsSync(base)) continue;
              for (const d of readdirSync(base, { withFileTypes: true })) {
                if (d.isDirectory() && d.name.toLowerCase().includes(name.toLowerCase())) found.push(join(base, d.name));
              }
            }
            if (found.length === 0) { sendToChat(chatId, `未找到「${name}」`).catch(() => {}); return resp(JSON.stringify({ code: 0 })); }
            if (found.length === 1) {
              const { exec } = await import("node:child_process");
              exec(`start "Pi" pi`, { cwd: found[0] });
              sendToChat(chatId, `✅ 已启动 ${found[0]}`).catch(() => {});
              return resp(JSON.stringify({ code: 0 }));
            }
            sendToChat(chatId, `多个匹配:\n${found.map((p, i) => `${i + 1}. ${p}`).join("\n")}\n回复编号选择`).catch(() => {});
            // 记下待选列表
            (lastDebug as any)._startPiChoices = found;
            return resp(JSON.stringify({ code: 0 }));
          }
          // 编号选择启动
          if (lastDebug._startPiChoices && /^\d+$/.test(text.trim())) {
            const idx = parseInt(text.trim()) - 1;
            const choices = lastDebug._startPiChoices;
            if (idx >= 0 && idx < choices.length) {
              const { exec } = await import("node:child_process");
              exec(`start "Pi" pi`, { cwd: choices[idx] });
              sendToChat(chatId, `✅ 已启动 ${choices[idx]}`).catch(() => {});
              delete lastDebug._startPiChoices;
              return resp(JSON.stringify({ code: 0 }));
            }
          }
          if (text.startsWith("/switch") || text.startsWith("switch ")) {
            const t = text.replace(/^\/(switch|切换)\s*/, "").replace(/^switch\s+/, "").trim();
            const metas = buildSessionIndex(MASTER_CWD); const tl = t.toLowerCase();
            for (const [, m] of metas) {
              if (m.name.toLowerCase().includes(tl)) {
                const { exec } = await import("node:child_process");
                exec(`start "PiAgent" cmd /c ""${process.execPath}" --session "${m.file}""`, { cwd: MASTER_CWD });
                const info = registry.get("总 agent");
                if (info) (info as any).sessionFile = m.file;
                sendToChat(chatId, `✅ 已切换「${m.name}」`).catch(() => {});
                return resp(JSON.stringify({ code: 0 }));
              }
            }
            sendToChat(chatId, `未找到「${t}」`).catch(() => {});
            return resp(JSON.stringify({ code: 0 }));
          }

          const pm = text.match(/^@?(\S+)\s+(.+)/);
          if (pm) {
            const nk = pm[1].toLowerCase();
            const info = registry.get(nk) || Array.from(registry.values()).find(v => v.name.toLowerCase().includes(nk));
            if (info && info.port > 0) {
              fetch(`http://127.0.0.1:${info.port}/ask`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: pm[2], chatId }), signal: AbortSignal.timeout(5000) }).catch(() => {});
              return resp(JSON.stringify({ code: 0 }));
            }
          }

          // 直接对话: 先 ack，再 pi -p
          const { execSync } = await import("node:child_process");
          const masterInfo = registry.get("总 agent");
          const sf = (masterInfo as any)?.sessionFile || ORIGIN_SESSION || join(
            process.env.PI_CODING_AGENT_SESSION_DIR || join(process.env.HOME || process.env.USERPROFILE || "", ".pi", "agent", "sessions"),
            "feishu-master.jsonl"
          );
          const q = text, cid = chatId;
          const mcwd = MASTER_CWD;
          // 异步处理，不阻塞飞书事件响应
          (async () => {
            try {
              const r = execSync(`pi -p --session "${sf}" "${q.replace(/"/g, '\\"')}"`, {
                encoding: "utf-8", timeout: 180_000, maxBuffer: 200 * 1024, cwd: mcwd, windowsHide: true,
              }).toString().trim() || "（无回复）";
              sendToChat(cid, `【总 agent】\n${r.slice(0, 4000)}`).catch(() => {});
            } catch (e: any) { sendToChat(cid, `失败: ${e.stderr || e.message}`).catch(() => {}); }
          })();
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
