/**
 * 网络工具扩展（合并 web_search + url_fetch）
 * 提供 web_search（DuckDuckGo 主引擎 + Bing fallback）和 url_fetch
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execSync } from "node:child_process";

function run(cmd: string, opts?: { timeout?: number }) {
  try {
    const out = execSync(cmd, {
      encoding: "utf-8",
      maxBuffer: 500 * 1024,
      timeout: opts?.timeout ?? 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, text: out };
  } catch (e: any) {
    const msg = e.stderr || e.stdout || e.message || String(e);
    return { ok: false, text: msg };
  }
}

// DuckDuckGo HTML 搜索解析
// DDG 的跳转链接格式: //duckduckgo.com/l/?uddg=ENCODED_URL&rut=...
function decodeDdgUrl(href: string): string {
  const m = href.match(/uddg=([^&]+)/);
  if (m) try { return decodeURIComponent(m[1]); } catch { /* fall through */ }
  return href;
}

function searchDuckDuckGo(q: string): string[] {
  const raw = run(
    `curl -sL --max-time 12 -H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64)" "https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}"`,
    { timeout: 15_000 },
  );
  if (!raw.ok) return [];

  const results: string[] = [];
  // 每个结果块: <h2 class="result__title">...<a class="result__a" href="跳转链接">标题</a>...
  // 摘要: <a class="result__snippet" href="...">摘要文本</a>
  const blockRe = /<h2 class="result__title">([\s\S]*?)<\/h2>[\s\S]*?<a class="result__snippet"[\s\S]*?>(.*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(raw.text)) !== null) {
    const titleBlock = m[1];
    const snippet = m[2].replace(/<[^>]+>/g, "").trim();
    const linkM = /<a[^>]+href="([^"]+)"[^>]*>(.*?)<\/a>/i.exec(titleBlock);
    if (linkM) {
      const url = decodeDdgUrl(linkM[1]);
      const title = linkM[2].replace(/<[^>]+>/g, "").trim();
      results.push(`${title}\n  ${url}\n  ${snippet}`);
    }
  }
  return results;
}

// Bing 搜索解析（fallback）
function searchBing(q: string): string[] {
  const raw = run(
    `curl -sL --max-time 10 -H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64)" "https://www.bing.com/search?q=${encodeURIComponent(q)}"`,
    { timeout: 15_000 },
  );
  if (!raw.ok) return [];

  const results: string[] = [];
  const blockRe = /<li class="b_algo"[^>]*>([\s\S]*?)<\/li>/gi;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(raw.text)) !== null) {
    const block = m[1];
    const titleM = /<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    const snippetM = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(block);
    if (titleM) {
      const url = titleM[1];
      const title = titleM[2].replace(/<[^>]+>/g, "").trim();
      const snippet = snippetM ? snippetM[1].replace(/<[^>]+>/g, "").trim() : "";
      results.push(`${title}\n  ${url}\n  ${snippet}`);
    }
  }
  return results;
}

export default function (pi: ExtensionAPI) {
  // ── web_search ────────────────────────────────────────────────

  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web via DuckDuckGo (primary) with Bing fallback. " +
      "Returns result titles, URLs, and snippets. " +
      "Use for finding documentation, solutions, or up-to-date information.",
    promptSnippet: "web_search <query> — search the web (DuckDuckGo + Bing fallback)",
    promptGuidelines: [
      "Use web_search when you need information that isn't in the codebase or training data. Follow up with url_fetch to read promising results.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
    }),
    async execute(_id, params) {
      // 先尝试 DuckDuckGo，失败或结果太少则 fallback 到 Bing
      let results = searchDuckDuckGo(params.query);
      if (results.length < 3) {
        const bingResults = searchBing(params.query);
        // 合并去重（按标题去重）
        const seen = new Set(results.map(r => r.split("\n")[0]));
        for (const r of bingResults) {
          const title = r.split("\n")[0];
          if (!seen.has(title)) {
            results.push(r);
            seen.add(title);
          }
        }
      }
      if (results.length === 0) {
        return {
          content: [{ type: "text", text: "No results found from either search engine." }],
          details: {},
        };
      }
      return {
        content: [{ type: "text", text: results.slice(0, 12).join("\n\n") }],
        details: {},
      };
    },
  });

  // ── url_fetch ─────────────────────────────────────────────────

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
    async execute(_id, params) {
      const c = `curl -sL --max-time 15 "${params.url}" 2>&1`;
      const r = run(c, { timeout: 20_000 });
      const text = r.text.slice(0, 50_000);
      return {
        content: [{ type: "text", text: r.ok ? text : `Fetch error: ${text}` }],
        details: {},
      };
    },
  });
}
