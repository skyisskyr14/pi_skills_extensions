import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

// ── helpers ────────────────────────────────────────────────────────

function run(cmd: string, opts?: { timeout?: number; cwd?: string }) {
  try {
    const out = execSync(cmd, {
      encoding: "utf-8",
      maxBuffer: 500 * 1024,
      timeout: opts?.timeout ?? 30_000,
      cwd: opts?.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, text: out };
  } catch (e: any) {
    const msg = e.stderr || e.stdout || e.message || String(e);
    return { ok: false, text: msg };
  }
}

// Walk up from cwd to find nearest valid .codegraph/ index
// A valid index has db.sqlite or graph.db or at least 3 entries in the dir
function findCodegraphRoot(cwd: string): string | null {
  let dir = resolve(cwd);
  for (let i = 0; i < 10; i++) {
    const cg = join(dir, ".codegraph");
    if (existsSync(cg)) {
      // must have an actual index, not just leftover daemons/ dir
      try {
        const entries = require("node:fs").readdirSync(cg);
        const hasIndex = entries.some((e: string) =>
          e.endsWith(".db") || e.endsWith(".sqlite") || e === "index"
        );
        if (hasIndex || entries.length >= 4) return dir;
      } catch { /* skip */ }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// ── extension ──────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── 语言约束：每次对话注入中文要求 ──────────────────────────

  pi.on("before_agent_start", async (event) => {
    return {
      systemPrompt: event.systemPrompt +
        "\n\n## 语言要求\n\n所有思考过程和回复内容必须使用简体中文。代码、技术术语、文件名、命令行输出等可以保留原文,但解释、分析、总结、对话都必须用中文。" +
        "\n\n## CodeGraph 优先\n\n当需要理解项目架构、查找符号、分析调用链时，必须先调用 codegraph_explore 或 codegraph_node。只有 codegraph 返回空或报错时，才降级使用 read/bash/grep。",
    };
  });

  // ── codegraph_explore ──────────────────────────────────────────

  pi.registerTool({
    name: "codegraph_explore",
    label: "CodeGraph Explore",
    description:
      "Explore a codebase area using CodeGraph's pre-built knowledge graph. " +
      "Returns relevant symbols, their source, and call paths in one shot. " +
      "Works only in projects that have run `codegraph init`. " +
      "Auto-finds .codegraph/ index by searching up from cwd. " +
      "Use for architecture questions like 'how does X connect to Y?'",
    promptSnippet: "codegraph_explore <query> — semantic codebase exploration via knowledge graph",
    promptGuidelines: [
      "Before using grep/glob/bash to explore a codebase, always try codegraph_explore first. It returns relevant symbols with full source and call paths in one call — faster, cheaper, and more precise than manual file scanning.",
      "Only fall back to read/grep/bash if codegraph_explore returns an error or empty results.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Natural language query about the codebase" }),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const root = findCodegraphRoot(ctx.cwd) || ctx.cwd;
      // ponytail: sync before query so index is always fresh after file edits
      run(`codegraph sync -p ${escapeArg(root)}`, { timeout: 30_000 });
      const result = run(`codegraph explore -p ${escapeArg(root)} ${escapeArg(params.query)}`, {
        timeout: 60_000,
      });
      return {
        content: [{ type: "text", text: result.ok ? result.text : `CodeGraph error: ${result.text}` }],
        details: {},
      };
    },
  });

  // ── codegraph_node ─────────────────────────────────────────────

  pi.registerTool({
    name: "codegraph_node",
    label: "CodeGraph Node",
    description:
      "Get a single symbol's source code plus its caller/callee trail, or read a file with line numbers and dependents. Same as the codegraph_node MCP tool.",
    promptSnippet: "codegraph_node <name> — inspect a symbol or file via knowledge graph",
    promptGuidelines: [
      "Use codegraph_node instead of read+grep when you need to see a symbol's full source code and its caller/callee relationships. One call returns everything.",
    ],
    parameters: Type.Object({
      name: Type.String({ description: "Symbol name or file path to inspect" }),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const root = findCodegraphRoot(ctx.cwd) || ctx.cwd;
      // ponytail: sync before query so index is always fresh after file edits
      run(`codegraph sync -p ${escapeArg(root)}`, { timeout: 30_000 });
      const result = run(`codegraph node -p ${escapeArg(root)} ${escapeArg(params.name)}`, {
        timeout: 30_000,
      });
      return {
        content: [{ type: "text", text: result.ok ? result.text : `CodeGraph error: ${result.text}` }],
        details: {},
      };
    },
  });

  // ── url_fetch ──────────────────────────────────────────────────

  pi.registerTool({
    name: "url_fetch",
    label: "URL Fetch",
    description:
      "Fetch content from a URL. Returns the HTTP response body as text (truncated). Use for reading documentation, API responses, or any web page.",
    promptSnippet: "url_fetch <url> — fetch a URL and return its text content",
    promptGuidelines: [
      "Use url_fetch to read web pages, documentation URLs, GitHub raw files, or API endpoints. Prefer it over asking the user to paste content.",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "The URL to fetch" }),
    }),
    async execute(_id, params, signal) {
      const c = `curl -sL --max-time 15 "${params.url}" 2>&1`;
      const r = run(c, { timeout: 20_000 });
      const text = r.text.slice(0, 50_000); // ponytail: 50K cap, add config if needed
      return {
        content: [{ type: "text", text: r.ok ? text : `Fetch error: ${text}` }],
        details: {},
      };
    },
  });

  // ── web_search ─────────────────────────────────────────────────

  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web using Bing. Returns result titles, snippets, and URLs. Use for finding documentation, solutions, or up-to-date information.",
    promptSnippet: "web_search <query> — search the web via Bing",
    promptGuidelines: [
      "Use web_search when you need information that isn't in the codebase or training data. Follow up with url_fetch to read promising results.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
    }),
    async execute(_id, params, signal) {
      const q = encodeURIComponent(params.query);
      const raw = run(
        `curl -sL --max-time 10 -H "User-Agent: Mozilla/5.0" "https://cn.bing.com/search?q=${q}&setlang=zh-cn" 2>&1`,
        { timeout: 15_000 },
      );
      if (!raw.ok) {
        return {
          content: [{ type: "text", text: `Search error: ${raw.text}` }],
          details: {},
        };
      }
      // Parse Bing results: each result is an <li class="b_algo"> with <h2><a>, then <p>
      const links: string[] = [];
      const blockRe = /<li class="b_algo"[^>]*>([\s\S]*?)<\/li>/gi;
      let blockMatch: RegExpExecArray | null;
      while ((blockMatch = blockRe.exec(raw.text)) !== null) {
        const block = blockMatch[1];
        const titleM = /<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
        const snippetM = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(block);
        if (titleM) {
          const url = titleM[1];
          const title = titleM[2].replace(/<[^>]+>/g, "").trim();
          const snippet = snippetM ? snippetM[1].replace(/<[^>]+>/g, "").trim() : "";
          links.push(`${title}\n  ${url}\n  ${snippet}`);
        }
      }
      if (links.length === 0) {
        const stripped = raw.text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 3000);
        return {
          content: [{ type: "text", text: stripped || "No results found." }],
          details: {},
        };
      }
      return {
        content: [{ type: "text", text: links.slice(0, 12).join("\n\n") }],
        details: {},
      };
    },
  });
}

function escapeArg(s: string): string {
  if (process.platform === "win32") {
    return `"${s.replace(/"/g, '\\"')}"`;
  }
  return `'${s.replace(/'/g, "'\\''")}'`;
}
