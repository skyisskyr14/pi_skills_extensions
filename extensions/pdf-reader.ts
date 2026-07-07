import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";

// ── PDF 图片分析工具 ──────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "pdf_read",
    label: "PDF Read (图片+文本)",
    description:
      "读取 PDF 文件，将页面渲染为图片并提取文字。" +
      "纯文本模型可读 OCR 文字；多模态模型可搭配图片路径用 read 工具看图。" +
      "支持指定页码范围，不指定则读取全部页。",
    promptSnippet: "pdf_read <pdf路径> [起始页-结束页] — 渲染PDF为图片并提取文字",
    promptGuidelines: [
      "读取 PDF 时应优先使用 pdf_read 而非直接 read（read 只能提取纯文本，丢失图表和排版信息）。",
      "pdf_read 会将每页渲染为图片保存到临时目录，返回 OCR 文字和图片路径。",
      "如果使用多模态模型，可以用 read 工具读取返回的图片路径，模型就能直接「看到」图表和排版。",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "PDF 文件路径（绝对或相对）" }),
      pages: Type.Optional(
        Type.String({
          description: "页码范围，如 '1-3' 或 '5'。不指定则读取全部页。",
        })
      ),
      dpi: Type.Optional(
        Type.Number({
          description: "渲染分辨率，默认 150。图表示例建议 200。",
          default: 150,
        })
      ),
    }),
    async execute(_id, params, signal) {
      const pdfPath = params.path;
      if (!existsSync(pdfPath)) {
        return {
          content: [
            { type: "text", text: `文件不存在: ${pdfPath}` },
          ],
          details: {},
        };
      }

      // 创建临时输出目录
      const pdfName = basename(pdfPath).replace(/\.pdf$/i, "");
      const outDir = join(tmpdir(), `pi-pdf-${pdfName}-${Date.now()}`);
      mkdirSync(outDir, { recursive: true });

      // 用 Python+PyMuPDF 渲染 PDF：图片 + 文字提取
      const dpi = params.dpi ?? 150;
      const pages = params.pages ?? "all";
      const script = `
import fitz, sys, json, os
doc = fitz.open(${JSON.stringify(pdfPath)})
total = doc.page_count

# 解析页码范围
pages_arg = ${JSON.stringify(pages)}
pages_to_render = []
if pages_arg == "all":
    pages_to_render = list(range(total))
else:
    for part in pages_arg.split(","):
        rng = part.strip().split("-")
        if len(rng) == 1:
            pages_to_render.append(int(rng[0]) - 1)
        else:
            pages_to_render.extend(range(int(rng[0]) - 1, int(rng[1])))

results = []
for i in pages_to_render:
    if i >= total:
        break
    page = doc[i]
    # 渲染为图片
    pix = page.get_pixmap(dpi=${dpi})
    img_path = os.path.join(${JSON.stringify(outDir)}, f"page_{i+1}.png")
    pix.save(img_path)
    # 提取文字
    text = page.get_text()
    results.append({
        "page": i + 1,
        "img": img_path,
        "text": text.strip() or "(本页无可提取文字，请查看图片)",
        "text_len": len(text),
    })

doc.close()
print(json.dumps({"total": total, "rendered": len(results), "pages": results, "out_dir": ${JSON.stringify(outDir)}}))
`;
      const pyResult = runPython(script);

      if (!pyResult.ok) {
        return {
          content: [{ type: "text", text: `PDF 解析失败: ${pyResult.text}` }],
          details: {},
        };
      }

      try {
        const data = JSON.parse(pyResult.text);
        // 检查图片文件是否存在，存在则读取并作为图片返回
        const imgContents: Array<{ type: "image"; data: string; mimeType: string }> = [];
        for (const p of data.pages) {
          if (existsSync(p.img) && statSync(p.img).size > 0) {
            const buf = readFileSync(p.img);
            imgContents.push({
              type: "image" as const,
              data: buf.toString("base64"),
              mimeType: "image/png",
            });
          }
        }

        // 图片在前，文字在后
        // 多模态模型会优先处理图片；纯文本模型自动 fallback 到文字
        const allContent: any[] = [];

        // 把图片放前面（最多 5 页，避免上下文爆炸）
        const maxImages = 5;
        allContent.push(...imgContents.slice(0, maxImages));

        // 文字作为补充说明
        const textLines: string[] = [];
        for (const p of data.pages) {
          if (p.text_len > 0) {
            textLines.push(`\n--- 第 ${p.page}/${data.total} 页 OCR 文字 ---\n${p.text}`);
          }
        }

        const textInfo =
          `PDF: ${pdfPath}（共 ${data.total} 页，已渲染 ${data.rendered} 页为图片，DPI=${dpi}）\n` +
          `图片保存到: ${data.out_dir}\n` +
          (textLines.length > 0 ? textLines.join("") + "\n" : "") +
          `# 重要：你已收到 ${Math.min(imgContents.length, maxImages)} 页图片，请基于图片内容分析，不要只看 OCR 文字！OCR 文字仅供辅助。` +
          (imgContents.length > maxImages ? `\n剩余 ${imgContents.length - maxImages} 页请用 read 工具读取: ${data.out_dir}/page_*.png` : "");

        allContent.push({ type: "text", text: textInfo });

        return {
          content: allContent,
          details: { pages: data.rendered, total: data.total, outDir: data.out_dir },
        };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `解析结果失败: ${e.message}` }],
          details: {},
        };
      }
    },
  });
}

// ── 运行 Python 脚本 ──────────────────────────────────────────────

function runPython(script: string) {
  try {
    const out = execSync("python -c " + JSON.stringify(script), {
      encoding: "utf-8",
      maxBuffer: 50 * 1024 * 1024, // 50MB，大图片可能较大
      timeout: 120_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, text: out };
  } catch (e: any) {
    const msg = e.stderr || e.stdout || e.message || String(e);
    return { ok: false, text: msg };
  }
}
