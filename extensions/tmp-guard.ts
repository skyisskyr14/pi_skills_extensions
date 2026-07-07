/**
 * tmp-guard.ts — pi agent 中间产物自动追踪
 *
 * 原理：
 *   每次 bash/write 工具执行前后对项目根目录拍快照，差分发现的新文件
 *   自动追加到 .gitignore（# pi-tmp: 标记行）和 .pi/tmpfiles.log（清单）
 *
 * 验证是否生效：
 *   /tmp-guard     → 查看状态、追踪文件数、最近一次差分结果
 *   /tmp-guard log → 查看 .pi/tmpfiles.log 内容
 *
 * 批量删除中间产物：
 *   xargs -d '\n' rm < .pi/tmpfiles.log
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

const MARKER = "# pi-tmp:";

export default function (pi: ExtensionAPI) {
  // ── 状态 ──
  let rootDir = "";
  let trackedThisSession = new Set<string>();
  let totalTracked = 0;
  let lastDiffLog = "";

  // ── 快照：项目根目录下的普通文件名（不含子目录） ──
  function snapshot(): Set<string> {
    if (!rootDir) return new Set();
    try {
      const entries = fs.readdirSync(rootDir, { withFileTypes: true });
      const files = new Set<string>();
      for (const e of entries) {
        if (e.isFile()) files.add(e.name);
      }
      return files;
    } catch {
      return new Set();
    }
  }

  // ── 确保 .pi/ 目录和 .gitignore 存在 ──
  function ensureInfra(): void {
    const piDir = path.join(rootDir, ".pi");
    if (!fs.existsSync(piDir)) fs.mkdirSync(piDir, { recursive: true });
    const gi = path.join(rootDir, ".gitignore");
    if (!fs.existsSync(gi)) {
      fs.writeFileSync(gi, "", "utf8");
    }
  }

  // ── 从 tmpfiles.log 加载所有已追踪文件名（跨会话去重） ──
  function loadTrackedFromLog(): Set<string> {
    const logPath = path.join(rootDir, ".pi", "tmpfiles.log");
    const hist = new Set<string>();
    try {
      const lines = fs.readFileSync(logPath, "utf8").split(/\r?\n/);
      for (const line of lines) {
        const t = line.trim();
        if (t && !t.startsWith("#")) hist.add(t);
      }
    } catch { /* 文件不存在 */ }
    return hist;
  }

  // ── 追加到 .gitignore ──
  function appendToGitignore(files: string[]): string[] {
    const giPath = path.join(rootDir, ".gitignore");
    let content = "";
    try { content = fs.readFileSync(giPath, "utf8"); } catch { return []; }

    // 收集已有的 gitignore 规则（用户手写的 + pi 之前加的）
    const existingRules = new Set<string>();
    const piAlready = new Set<string>();
    for (const line of content.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) {
        if (t.startsWith(MARKER)) {
          const m = t.match(/# pi-tmp:\s+(.+?)\s+\(/);
          if (m) piAlready.add(m[1]);
        }
        continue;
      }
      existingRules.add(t);
    }

    const now = new Date().toISOString().replace("T", " ").substring(0, 19);
    const added: string[] = [];
    for (const f of files) {
      if (!existingRules.has(f) && !piAlready.has(f)) {
        added.push(`${MARKER} ${f} (${now})`);
      }
    }

    if (added.length > 0) {
      const newContent = content.replace(/\n*$/, "\n") + added.join("\n") + "\n";
      fs.writeFileSync(giPath, newContent, "utf8");
    }
    return added;
  }

  // ── 追加到 .pi/tmpfiles.log ──
  function appendToLog(files: string[]): void {
    const logPath = path.join(rootDir, ".pi", "tmpfiles.log");
    const hist = loadTrackedFromLog();
    const toAdd = files.filter(f => !hist.has(f));
    if (toAdd.length === 0) return;

    const now = new Date().toISOString().replace("T", " ").substring(0, 19);
    let content = "";
    try { content = fs.readFileSync(logPath, "utf8"); } catch { /* 新建 */ }

    if (!content.trim()) {
      content =
        `# pi agent 中间产物清单\n` +
        `# 项目: ${rootDir}\n` +
        `# 批量删除: xargs -d '\\n' rm < .pi/tmpfiles.log\n` +
        `# 创建时间: ${now}\n\n`;
    }

    fs.writeFileSync(logPath, content.replace(/\n*$/, "\n") + "\n" + toAdd.join("\n") + "\n", "utf8");
    totalTracked += toAdd.length;
  }

  // ── session_start ──
  pi.on("session_start", (_event, ctx) => {
    rootDir = ctx.cwd;
    ensureInfra();
    const hist = loadTrackedFromLog();
    trackedThisSession = new Set(hist);
    totalTracked = hist.size;
    lastDiffLog = `[${new Date().toLocaleTimeString()}] tmp-guard 已加载，项目: ${rootDir}`;
  });

  // ── 快照存储（key=toolCallId） ──
  const snapshots = new Map<string, Set<string>>();

  // ── tool_call：拍快照 ──
  pi.on("tool_call", (event) => {
    if (event.toolName === "bash" || event.toolName === "write") {
      snapshots.set(event.toolCallId, snapshot());
    }
  });

  // ── tool_result：差分、追加 ──
  pi.on("tool_result", (event) => {
    const before = snapshots.get(event.toolCallId);
    snapshots.delete(event.toolCallId);
    if (!before || event.isError) return;

    const after = snapshot();
    const newFiles: string[] = [];
    for (const f of after) {
      if (!before.has(f) && !trackedThisSession.has(f)) {
        newFiles.push(f);
        trackedThisSession.add(f);
      }
    }

    if (newFiles.length > 0) {
      const added = appendToGitignore(newFiles);
      appendToLog(newFiles);
      lastDiffLog = `[${new Date().toLocaleTimeString()}] ${event.toolName} 新增: ${newFiles.join(", ")}`;
    } else {
      lastDiffLog = `[${new Date().toLocaleTimeString()}] ${event.toolName} 无新文件`;
    }
  });

  // ── /tmp-guard 诊断命令 ──
  pi.registerCommand("tmp-guard", {
    description: "查看中间产物追踪状态",
    handler: async (args, ctx) => {
      const logPath = path.join(rootDir, ".pi", "tmpfiles.log");
      const giPath = path.join(rootDir, ".gitignore");

      if (args === "log") {
        // 显示清单内容
        try {
          const log = fs.readFileSync(logPath, "utf8");
          ctx.ui.notify(log.trim() || "(空)", "info");
        } catch {
          ctx.ui.notify("tmpfiles.log 不存在", "warn");
        }
        return;
      }

      const hasGi = fs.existsSync(giPath);
      const giPiLines = hasGi
        ? fs.readFileSync(giPath, "utf8").split("\n").filter(l => l.trim().startsWith(MARKER)).length
        : 0;

      const currentFiles = snapshot().size;
      const msg = [
        `项目: ${rootDir}`,
        `追踪总数: ${totalTracked} 文件`,
        `当前根目录文件: ${currentFiles}`,
        `.gitignore 存在: ${hasGi ? "是" : "否"}`,
        `.gitignore pi行数: ${giPiLines}`,
        `最近: ${lastDiffLog || "(尚无)"}`,
      ].join("\n");

      ctx.ui.notify(msg, "info");
    },
  });
}
