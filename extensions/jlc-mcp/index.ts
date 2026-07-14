// jlc-mcp pi 扩展 — 让 pi agent 直接操控嘉立创 EDA 专业版
// 替代了原架构中的 Gateway + MCP Server，pi 扩展直接与 jlc-bridge 插件通信
//
// 架构：pi agent → 本扩展(WebSocket Server) → jlc-bridge 插件 → 嘉立创 EDA
//
// 使用前：
//   1. cd ~/.pi/agent/extensions/jlc-mcp && npm install
//   2. 在嘉立创 EDA 专业版中安装 jlc-bridge 插件（.eext）
//   3. 在 EDA 菜单中启用 JLC Bridge
//   4. 重启 pi agent

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";

// ─── WebSocket 服务器（Bun 原生，不用 ws 库——ws 在 Bun 下端口冲突时抛异步异常，try/catch 抓不住）───
const WS_PORT = 18800;
const WS_PATH = "/ws/bridge";
const COMMAND_TIMEOUT_MS = 60_000;

let server: ReturnType<typeof Bun.serve> | null = null;
let bridgeSocket: import("bun").ServerWebSocket<unknown> | null = null;
let gatewayRunning = false;
// 等待响应的命令映射：commandId → {resolve, reject, timer}
const pendingCommands = new Map<string, {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}>();

/** 关闭 Gateway，断开所有连接 */
function stopGateway(): void {
  if (bridgeSocket) {
    bridgeSocket.close();
    bridgeSocket = null;
  }
  for (const [, p] of pendingCommands) {
    clearTimeout(p.timer);
    p.reject(new Error("Gateway 已关闭"));
  }
  pendingCommands.clear();
  if (server) {
    server.stop();
    server = null;
  }
  gatewayRunning = false;
}

/** 启动 WebSocket 服务器。返回 null 表示成功，否则返回错误信息 */
function startGateway(): string | null {
  if (gatewayRunning) return "Gateway 已在运行中";

  // ponytail: Bun.serve 的 error 回调能正确捕获 EADDRINUSE，不会崩进程
  server = Bun.serve({
    port: WS_PORT,
    error(err) {
      // 端口冲突等错误在这里处理，不会变成 uncaughtException
      console.log(`[jlc-mcp] ⚠️ Gateway 错误: ${err.message}`);
      stopGateway();
    },
    fetch(req, srv) {
      // 只处理 /ws/bridge 路径的 WebSocket 升级
      const url = new URL(req.url);
      if (url.pathname === WS_PATH) {
        const upgraded = srv.upgrade(req);
        if (!upgraded) {
          return new Response("WebSocket upgrade failed", { status: 500 });
        }
        return undefined; // Bun 接管连接
      }
      return new Response("Not Found", { status: 404 });
    },
    websocket: {
      open(ws) {
        if (bridgeSocket) bridgeSocket.close();
        bridgeSocket = ws;
        console.log("[jlc-mcp] ✅ jlc-bridge 已连接");
      },
      message(ws, raw) {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === "result" && msg.payload?.commandId) {
            const pending = pendingCommands.get(msg.payload.commandId);
            if (pending) {
              clearTimeout(pending.timer);
              pendingCommands.delete(msg.payload.commandId);
              if (msg.payload.success) {
                pending.resolve(msg.payload.data);
              } else {
                pending.reject(new Error(msg.payload.error ?? "Bridge 命令执行失败"));
              }
            }
          }
        } catch {
          // 忽略非 JSON 消息
        }
      },
      close() {
        bridgeSocket = null;
        for (const [, p] of pendingCommands) {
          clearTimeout(p.timer);
          p.reject(new Error("jlc-bridge 连接断开"));
        }
        pendingCommands.clear();
        console.log("[jlc-mcp] ⚠️ jlc-bridge 已断开，等待重连...");
      },
    },
  });

  gatewayRunning = true;
  console.log(`[jlc-mcp] Gateway 已启动: ws://127.0.0.1:${WS_PORT}${WS_PATH}`);
  return null;
}

/** 向 jlc-bridge 发送命令并等待结果 */
async function sendCommand(action: string, params: Record<string, unknown> = {}): Promise<unknown> {
  if (!bridgeSocket || bridgeSocket.readyState !== 1) { // 1 = WebSocket.OPEN
    throw new Error("jlc-bridge 未连接。请确保嘉立创 EDA 已打开且 JLC Bridge 已启用");
  }

  const commandId = randomUUID();
  const cmd = {
    type: "command",
    id: commandId, // 命令 id 与 pendingCommands key 一致，bridge 返回时才能匹配
    timestamp: Date.now(),
    payload: { action, params },
  };

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCommands.delete(commandId);
      reject(new Error(`命令 '${action}' 超时 (${COMMAND_TIMEOUT_MS / 1000}s)`));
    }, COMMAND_TIMEOUT_MS);

    pendingCommands.set(commandId, { resolve, reject, timer });
    bridgeSocket!.send(JSON.stringify(cmd));
  });
}

// ─── 工具定义辅助函数 ───
// ponytail: 用简单的工厂函数减少重复代码

/** 无参数工具 */
function simpleTool(name: string, action: string, description: string) {
  return {
    name,
    label: name,
    description,
    parameters: Type.Object({}),
    async execute() {
      const result = await sendCommand(action);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        details: { action, result },
      };
    },
  };
}

// ─── 扩展入口 ───
export default function (pi: ExtensionAPI) {
  // ─── 手动启停命令（ponytail: 不自动启动，避免端口冲突时 Bun 下 ws 异常不可捕获导致 pi 崩溃）───

  pi.registerCommand("jlc-start", {
    description: "启动 JLC Bridge Gateway（端口 18800）",
    handler: async (_args, ctx) => {
      const err = startGateway();
      if (err) {
        ctx.ui.notify(err, "error");
      } else {
        ctx.ui.notify("JLC Gateway 已启动，等待 EDA bridge 连接...", "info");
      }
    },
  });

  pi.registerCommand("jlc-stop", {
    description: "停止 JLC Bridge Gateway",
    handler: async (_args, ctx) => {
      if (!gatewayRunning) {
        ctx.ui.notify("Gateway 未在运行", "info");
        return;
      }
      stopGateway();
      ctx.ui.notify("JLC Gateway 已停止", "info");
    },
  });

  // ═══════════════════════════════════════════
  // 状态查询工具 (9)
  // ═══════════════════════════════════════════

  pi.registerTool(simpleTool("pcb_get_state", "get_state", "获取 PCB 完整状态（元件、网络、板框等）"));
  pi.registerTool(simpleTool("pcb_screenshot", "screenshot", "截取当前 PCB 编辑器截图（base64 PNG）"));
  pi.registerTool(simpleTool("pcb_run_drc", "run_drc", "运行 PCB 设计规则检查"));
  pi.registerTool(simpleTool("pcb_get_board_info", "get_board_info", "获取工程信息（板名、层数等）"));
  pi.registerTool(simpleTool("pcb_get_feature_support", "get_feature_support", "查询 bridge 支持的功能列表"));
  pi.registerTool(simpleTool("pcb_ping", "ping", "检查 bridge 连接状态"));
  pi.registerTool(simpleTool("pcb_get_silkscreens", "get_silkscreens", "查询所有丝印文字"));

  pi.registerTool({
    name: "pcb_get_tracks",
    label: "查询走线",
    description: "查询走线段，可按网络/层过滤",
    parameters: Type.Object({
      net: Type.Optional(Type.String({ description: "网络名称（可选）" })),
      layer: Type.Optional(Type.Number({ description: "层号（可选，1=顶层, 2=底层）" })),
    }),
    async execute(_id, params) {
      const result = await sendCommand("get_tracks", params as Record<string, unknown>);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: { action: "get_tracks", result },
      };
    },
  });

  pi.registerTool({
    name: "pcb_get_pads",
    label: "查询焊盘",
    description: "查询焊盘信息，可按位号过滤",
    parameters: Type.Object({
      designator: Type.Optional(Type.String({ description: "元件位号（可选，如 U1, R1）" })),
    }),
    async execute(_id, params) {
      const result = await sendCommand("get_pads", params as Record<string, unknown>);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: { action: "get_pads", result },
      };
    },
  });

  pi.registerTool({
    name: "pcb_get_net_primitives",
    label: "查询网络图元",
    description: "查询指定网络的所有图元",
    parameters: Type.Object({
      net: Type.String({ description: "网络名称" }),
    }),
    async execute(_id, params) {
      const result = await sendCommand("get_net_primitives", params as Record<string, unknown>);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: { action: "get_net_primitives", result },
      };
    },
  });

  // ═══════════════════════════════════════════
  // 元件操作工具 (6)
  // ═══════════════════════════════════════════

  pi.registerTool({
    name: "pcb_move_component",
    label: "移动元件",
    description: "移动元件到指定坐标（单位：mil）",
    parameters: Type.Object({
      designator: Type.String({ description: "元件位号，如 U1, R1" }),
      x: Type.Number({ description: "X 坐标 (mil)" }),
      y: Type.Number({ description: "Y 坐标 (mil)" }),
      rotation: Type.Optional(Type.Number({ description: "旋转角度（可选）" })),
    }),
    async execute(_id, params) {
      const result = await sendCommand("move_component", params as Record<string, unknown>);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: { action: "move_component", result },
      };
    },
  });

  pi.registerTool({
    name: "pcb_relocate_component",
    label: "搬迁元件",
    description: "安全搬迁元件（自动断开走线后移动）",
    parameters: Type.Object({
      designator: Type.String({ description: "元件位号" }),
      x: Type.Number({ description: "X 坐标 (mil)" }),
      y: Type.Number({ description: "Y 坐标 (mil)" }),
      rotation: Type.Optional(Type.Number({ description: "旋转角度（可选）" })),
    }),
    async execute(_id, params) {
      const result = await sendCommand("relocate_component", params as Record<string, unknown>);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: { action: "relocate_component", result },
      };
    },
  });

  pi.registerTool({
    name: "pcb_batch_move",
    label: "批量移动",
    description: "批量移动多个元件",
    parameters: Type.Object({
      moves: Type.Array(Type.Object({
        designator: Type.String({ description: "元件位号" }),
        x: Type.Number({ description: "X 坐标 (mil)" }),
        y: Type.Number({ description: "Y 坐标 (mil)" }),
        rotation: Type.Optional(Type.Number({})),
      }), { description: "移动列表" }),
    }),
    async execute(_id, params) {
      const result = await sendCommand("batch_move", params as Record<string, unknown>);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: { action: "batch_move", result },
      };
    },
  });

  pi.registerTool({
    name: "pcb_select_component",
    label: "选中元件",
    description: "在编辑器中选中指定元件",
    parameters: Type.Object({
      designator: Type.String({ description: "元件位号" }),
    }),
    async execute(_id, params) {
      const result = await sendCommand("select_component", params as Record<string, unknown>);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: { action: "select_component", result },
      };
    },
  });

  pi.registerTool(simpleTool("pcb_delete_selected", "delete_selected", "删除当前选中的对象"));

  pi.registerTool({
    name: "pcb_create_component",
    label: "放置元件",
    description: "从库中放置元件到 PCB",
    parameters: Type.Object({
      component: Type.Object({
        libraryUuid: Type.String({ description: "库 UUID" }),
        uuid: Type.String({ description: "元件 UUID" }),
      }, { description: "元件标识" }),
      layer: Type.Number({ description: "层号" }),
      x: Type.Number({ description: "X 坐标 (mil)" }),
      y: Type.Number({ description: "Y 坐标 (mil)" }),
      rotation: Type.Optional(Type.Number({ description: "旋转角度（可选）" })),
    }),
    async execute(_id, params) {
      const result = await sendCommand("create_pcb_component", params as Record<string, unknown>);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: { action: "create_pcb_component", result },
      };
    },
  });

  // ═══════════════════════════════════════════
  // 走线 / 过孔工具 (4)
  // ═══════════════════════════════════════════

  pi.registerTool({
    name: "pcb_route_track",
    label: "画走线",
    description: "在指定网络画走线（单位：mil）",
    parameters: Type.Object({
      net: Type.String({ description: "网络名称" }),
      points: Type.Array(Type.Object({
        x: Type.Number({}),
        y: Type.Number({}),
      }), { description: "走线路径点数组 (mil)" }),
      layer: Type.Number({ description: "层号 (1=顶层, 2=底层)" }),
      width: Type.Number({ description: "线宽 (mil)" }),
    }),
    async execute(_id, params) {
      const result = await sendCommand("route_track", params as Record<string, unknown>);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: { action: "route_track", result },
      };
    },
  });

  pi.registerTool({
    name: "pcb_create_via",
    label: "创建过孔",
    description: "在指定位置创建过孔",
    parameters: Type.Object({
      net: Type.String({ description: "网络名称" }),
      x: Type.Number({ description: "X 坐标 (mil)" }),
      y: Type.Number({ description: "Y 坐标 (mil)" }),
      drill: Type.Number({ description: "钻孔直径 (mil)" }),
      diameter: Type.Number({ description: "过孔外径 (mil)" }),
    }),
    async execute(_id, params) {
      const result = await sendCommand("create_via", params as Record<string, unknown>);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: { action: "create_via", result },
      };
    },
  });

  pi.registerTool({
    name: "pcb_delete_tracks",
    label: "删除走线",
    description: "删除指定走线",
    parameters: Type.Object({
      primitiveIds: Type.Array(Type.String(), { description: "走线图元 ID 列表" }),
    }),
    async execute(_id, params) {
      const result = await sendCommand("delete_tracks", params as Record<string, unknown>);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: { action: "delete_tracks", result },
      };
    },
  });

  pi.registerTool({
    name: "pcb_delete_via",
    label: "删除过孔",
    description: "删除指定过孔",
    parameters: Type.Object({
      primitiveIds: Type.Array(Type.String(), { description: "过孔图元 ID 列表" }),
    }),
    async execute(_id, params) {
      const result = await sendCommand("delete_via", params as Record<string, unknown>);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: { action: "delete_via", result },
      };
    },
  });

  // ═══════════════════════════════════════════
  // 铺铜 / 禁布区工具 (4)
  // ═══════════════════════════════════════════

  pi.registerTool({
    name: "pcb_create_copper_pour",
    label: "创建铺铜",
    description: "创建矩形铺铜区域",
    parameters: Type.Object({
      net: Type.String({ description: "网络名称（如 GND）" }),
      layer: Type.Number({ description: "层号" }),
      x1: Type.Number({ description: "左上角 X (mil)" }),
      y1: Type.Number({ description: "左上角 Y (mil)" }),
      x2: Type.Number({ description: "右下角 X (mil)" }),
      y2: Type.Number({ description: "右下角 Y (mil)" }),
    }),
    async execute(_id, params) {
      const result = await sendCommand("create_pour_rect", params as Record<string, unknown>);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: { action: "create_pour_rect", result },
      };
    },
  });

  pi.registerTool({
    name: "pcb_delete_pour",
    label: "删除铺铜",
    description: "删除指定铺铜",
    parameters: Type.Object({
      primitiveId: Type.String({ description: "铺铜图元 ID" }),
    }),
    async execute(_id, params) {
      const result = await sendCommand("delete_pour", params as Record<string, unknown>);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: { action: "delete_pour", result },
      };
    },
  });

  pi.registerTool({
    name: "pcb_create_keepout",
    label: "创建禁布区",
    description: "创建矩形禁布区",
    parameters: Type.Object({
      x1: Type.Number({ description: "左上角 X (mil)" }),
      y1: Type.Number({ description: "左上角 Y (mil)" }),
      x2: Type.Number({ description: "右下角 X (mil)" }),
      y2: Type.Number({ description: "右下角 Y (mil)" }),
      layer: Type.Optional(Type.Number({ description: "层号（不填则所有层）" })),
    }),
    async execute(_id, params) {
      const result = await sendCommand("create_keepout_rect", params as Record<string, unknown>);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: { action: "create_keepout_rect", result },
      };
    },
  });

  pi.registerTool({
    name: "pcb_delete_keepout",
    label: "删除禁布区",
    description: "删除指定禁布区",
    parameters: Type.Object({
      primitiveId: Type.String({ description: "禁布区图元 ID" }),
    }),
    async execute(_id, params) {
      const result = await sendCommand("delete_region", params as Record<string, unknown>);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: { action: "delete_region", result },
      };
    },
  });

  // ═══════════════════════════════════════════
  // 丝印工具 (3)
  // ═══════════════════════════════════════════

  pi.registerTool({
    name: "pcb_move_silkscreen",
    label: "移动丝印",
    description: "移动丝印文字到指定位置",
    parameters: Type.Object({
      primitiveId: Type.String({ description: "丝印图元 ID" }),
      x: Type.Number({ description: "X 坐标 (mil)" }),
      y: Type.Number({ description: "Y 坐标 (mil)" }),
      rotation: Type.Optional(Type.Number({ description: "旋转角度（可选）" })),
    }),
    async execute(_id, params) {
      const result = await sendCommand("move_silkscreen", params as Record<string, unknown>);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: { action: "move_silkscreen", result },
      };
    },
  });

  pi.registerTool(simpleTool("pcb_auto_silkscreen", "auto_silkscreen", "自动排列所有丝印（避免重叠）"));

  // ═══════════════════════════════════════════
  // 差分对 / 等长组工具 (6)
  // ═══════════════════════════════════════════

  pi.registerTool({
    name: "pcb_create_diff_pair",
    label: "创建差分对",
    description: "创建差分对（如 USB_DP/USB_DN）",
    parameters: Type.Object({
      name: Type.String({ description: "差分对名称" }),
      posNet: Type.String({ description: "正极网络名" }),
      negNet: Type.String({ description: "负极网络名" }),
    }),
    async execute(_id, params) {
      const result = await sendCommand("create_differential_pair", params as Record<string, unknown>);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: { action: "create_differential_pair", result },
      };
    },
  });

  pi.registerTool(simpleTool("pcb_list_diff_pairs", "list_differential_pairs", "列出所有差分对"));

  pi.registerTool({
    name: "pcb_delete_diff_pair",
    label: "删除差分对",
    description: "删除指定差分对",
    parameters: Type.Object({
      name: Type.String({ description: "差分对名称" }),
    }),
    async execute(_id, params) {
      const result = await sendCommand("delete_differential_pair", params as Record<string, unknown>);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: { action: "delete_differential_pair", result },
      };
    },
  });

  pi.registerTool({
    name: "pcb_create_equal_length",
    label: "创建等长组",
    description: "创建等长组（用于匹配走线长度）",
    parameters: Type.Object({
      name: Type.String({ description: "等长组名称" }),
      nets: Type.Array(Type.String(), { description: "网络名称列表" }),
    }),
    async execute(_id, params) {
      const result = await sendCommand("create_equal_length_group", params as Record<string, unknown>);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: { action: "create_equal_length_group", result },
      };
    },
  });

  pi.registerTool(simpleTool("pcb_list_equal_lengths", "list_equal_length_groups", "列出所有等长组"));

  pi.registerTool({
    name: "pcb_delete_equal_length",
    label: "删除等长组",
    description: "删除指定等长组",
    parameters: Type.Object({
      name: Type.String({ description: "等长组名称" }),
    }),
    async execute(_id, params) {
      const result = await sendCommand("delete_equal_length_group", params as Record<string, unknown>);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: { action: "delete_equal_length_group", result },
      };
    },
  });

  // ═══════════════════════════════════════════
  // 原理图 / 文档工具 (10)
  // ═══════════════════════════════════════════

  pi.registerTool(simpleTool("sch_get_state", "get_schematic_state", "读取原理图状态"));

  pi.registerTool({
    name: "sch_get_netlist",
    label: "导出网表",
    description: "导出原理图网表",
    parameters: Type.Object({
      type: Type.Optional(Type.String({ description: "网表格式（可选）" })),
    }),
    async execute(_id, params) {
      const result = await sendCommand("get_netlist", params as Record<string, unknown>);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: { action: "get_netlist", result },
      };
    },
  });

  pi.registerTool({
    name: "sch_run_drc",
    label: "原理图 DRC",
    description: "运行原理图设计规则检查",
    parameters: Type.Object({
      strict: Type.Optional(Type.Boolean({ description: "是否严格模式" })),
    }),
    async execute(_id, params) {
      const result = await sendCommand("run_sch_drc", params as Record<string, unknown>);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: { action: "run_sch_drc", result },
      };
    },
  });

  // ─── 原理图写入工具 ───

  pi.registerTool({
    name: "sch_create_component",
    label: "放置原理图元件",
    description: "在原理图中从元件库放置元件",
    parameters: Type.Object({
      component: Type.Object({
        libraryUuid: Type.String({ description: "库 UUID" }),
        uuid: Type.String({ description: "元件 UUID" }),
      }, { description: "元件标识" }),
      x: Type.Number({ description: "X 坐标" }),
      y: Type.Number({ description: "Y 坐标" }),
      rotation: Type.Optional(Type.Number({ description: "旋转角度（可选，0/90/180/270）" })),
      mirror: Type.Optional(Type.Boolean({ description: "是否镜像（可选）" })),
    }),
    async execute(_id, params) {
      const result = await sendCommand("sch_create_component", params as Record<string, unknown>);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: { action: "sch_create_component", result },
      };
    },
  });

  pi.registerTool({
    name: "sch_create_wire",
    label: "画原理图导线",
    description: "在原理图中画导线。line 为坐标数组 [x1,y1,x2,y2,...] 或 [[x1,y1,x2,y2], ...]",
    parameters: Type.Object({
      line: Type.Array(Type.Number(), { description: "导线坐标数组，如 [x1,y1,x2,y2] 表示一段线" }),
      net: Type.Optional(Type.String({ description: "网络名称（可选，不填则自动跟随连接图元的网络）" })),
    }),
    async execute(_id, params) {
      const result = await sendCommand("sch_create_wire", params as Record<string, unknown>);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: { action: "sch_create_wire", result },
      };
    },
  });

  pi.registerTool({
    name: "sch_move_component",
    label: "移动原理图元件",
    description: "移动原理图中的元件到指定坐标",
    parameters: Type.Object({
      primitiveId: Type.String({ description: "元件图元 ID" }),
      x: Type.Number({ description: "X 坐标" }),
      y: Type.Number({ description: "Y 坐标" }),
      rotation: Type.Optional(Type.Number({ description: "旋转角度（可选）" })),
    }),
    async execute(_id, params) {
      const result = await sendCommand("sch_move_component", params as Record<string, unknown>);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: { action: "sch_move_component", result },
      };
    },
  });

  pi.registerTool({
    name: "sch_delete_component",
    label: "删除原理图元件",
    description: "删除原理图中的指定元件",
    parameters: Type.Object({
      primitiveId: Type.String({ description: "元件图元 ID" }),
    }),
    async execute(_id, params) {
      const result = await sendCommand("sch_delete_component", params as Record<string, unknown>);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: { action: "sch_delete_component", result },
      };
    },
  });

  pi.registerTool({
    name: "sch_create_net_flag",
    label: "放置电源/地标志",
    description: "在原理图中放置 VCC/GND 等电源网络标志",
    parameters: Type.Object({
      type: Type.String({ description: "标志类型: Power | Ground | AnalogGround | ProtectGround" }),
      net: Type.String({ description: "网络名称，如 VCC、GND、+3.3V" }),
      x: Type.Number({ description: "X 坐标" }),
      y: Type.Number({ description: "Y 坐标" }),
      rotation: Type.Optional(Type.Number({ description: "旋转角度（可选）" })),
    }),
    async execute(_id, params) {
      const result = await sendCommand("sch_create_net_flag", params as Record<string, unknown>);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: { action: "sch_create_net_flag", result },
      };
    },
  });

  pi.registerTool({
    name: "sch_create_net_port",
    label: "放置网络端口",
    description: "在原理图中放置网络端口（用于跨页连接或对外接口）",
    parameters: Type.Object({
      direction: Type.String({ description: "端口方向: IN | OUT | BI" }),
      net: Type.String({ description: "网络名称" }),
      x: Type.Number({ description: "X 坐标" }),
      y: Type.Number({ description: "Y 坐标" }),
      rotation: Type.Optional(Type.Number({ description: "旋转角度（可选）" })),
    }),
    async execute(_id, params) {
      const result = await sendCommand("sch_create_net_port", params as Record<string, unknown>);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: { action: "sch_create_net_port", result },
      };
    },
  });

  pi.registerTool({
    name: "sch_get_component_pins",
    label: "查询元件引脚",
    description: "获取原理图中指定元件的所有引脚信息（编号、名称、坐标、网络）",
    parameters: Type.Object({
      primitiveId: Type.String({ description: "元件图元 ID" }),
    }),
    async execute(_id, params) {
      const result = await sendCommand("sch_get_component_pins", params as Record<string, unknown>);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: { action: "sch_get_component_pins", result },
      };
    },
  });

  pi.registerTool({
    name: "sch_create_text",
    label: "创建文字",
    description: "在原理图中创建文字（用于模块标题、说明等）",
    parameters: Type.Object({
      x: Type.Number({ description: "X 坐标" }),
      y: Type.Number({ description: "Y 坐标" }),
      content: Type.String({ description: "文字内容" }),
      rotation: Type.Optional(Type.Number({ description: "旋转角度（可选，0/90/180/270）" })),
      fontSize: Type.Optional(Type.Number({ description: "字体大小（可选）" })),
    }),
    async execute(_id, params) {
      const result = await sendCommand("sch_create_text", params as Record<string, unknown>);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: { action: "sch_create_text", result },
      };
    },
  });

  pi.registerTool(simpleTool("sch_save", "sch_save", "保存当前原理图文档"));

  pi.registerTool({
    name: "sch_modify_component",
    label: "修改元件属性",
    description: "修改原理图元件的位号、名称、坐标等属性",
    parameters: Type.Object({
      primitiveId: Type.String({ description: "元件图元 ID" }),
      designator: Type.Optional(Type.String({ description: "新位号（如 R1, C2），传 null 清除" })),
      name: Type.Optional(Type.String({ description: "新名称/型号" })),
      x: Type.Optional(Type.Number({ description: "新 X 坐标" })),
      y: Type.Optional(Type.Number({ description: "新 Y 坐标" })),
      rotation: Type.Optional(Type.Number({ description: "新旋转角度" })),
    }),
    async execute(_id, params) {
      const result = await sendCommand("sch_modify_component", params as Record<string, unknown>);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: { action: "sch_modify_component", result },
      };
    },
  });

  pi.registerTool({
    name: "pcb_open_document",
    label: "切换文档",
    description: "切换到指定文档（原理图或 PCB）",
    parameters: Type.Object({
      uuid: Type.String({ description: "文档 UUID" }),
    }),
    async execute(_id, params) {
      const result = await sendCommand("open_document", params as Record<string, unknown>);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: { action: "open_document", result },
      };
    },
  });

  // ═══════════════════════════════════════════
  // 计算工具 (2) — 纯数学，不走 bridge
  // ═══════════════════════════════════════════

  pi.registerTool({
    name: "calc_impedance",
    label: "阻抗计算",
    description: "计算走线阻抗，或根据目标阻抗反算线宽（微带线/带状线/差分）",
    parameters: Type.Object({
      type: Type.String({ description: "走线类型: microstrip | stripline | diff_microstrip | diff_stripline" }),
      width: Type.Optional(Type.Number({ description: "线宽 (mil)，与 targetImpedance 二选一" })),
      targetImpedance: Type.Optional(Type.Number({ description: "目标阻抗 (Ω)，填此项则反算线宽" })),
      thickness: Type.Optional(Type.Number({ description: "铜厚 (mil)，默认 1.4 (1oz)" })),
      height: Type.Number({ description: "介质厚度 (mil)" }),
      er: Type.Optional(Type.Number({ description: "介电常数，默认 4.3 (FR4)" })),
      spacing: Type.Optional(Type.Number({ description: "差分间距 (mil)，差分模式必填" })),
    }),
    async execute(_id, params) {
      const p = params as Record<string, unknown>;
      const T = (p.thickness as number) ?? 1.4;
      const H = p.height as number;
      const Er = (p.er as number) ?? 4.3;
      const type = p.type as string;

      // 如果给了 targetImpedance，反算线宽
      if (p.targetImpedance !== undefined) {
        const target = p.targetImpedance as number;
        let lo = 0.5, hi = 200;
        for (let i = 0; i < 100; i++) {
          const mid = (lo + hi) / 2;
          const W = mid;
          let Z0: number;
          if (type === "microstrip") {
            Z0 = (87 / Math.sqrt(Er + 1.41)) * Math.log(5.98 * H / (0.8 * W + T));
          } else if (type === "stripline") {
            Z0 = (60 / Math.sqrt(Er)) * Math.log((4 * H) / (Math.PI * (W + T)));
          } else if (type === "diff_microstrip") {
            const S = (p.spacing as number) ?? 0;
            const Z0s = (87 / Math.sqrt(Er + 1.41)) * Math.log(5.98 * H / (0.8 * W + T));
            Z0 = 2 * Z0s * (1 - 0.48 * Math.exp(-0.96 * S / H));
          } else if (type === "diff_stripline") {
            const S = (p.spacing as number) ?? 0;
            Z0 = (120 / Math.sqrt(Er)) * Math.log((2 * H) / (Math.PI * (W + T + S)));
          } else {
            throw new Error(`未知阻抗类型: ${type}`);
          }
          if (Math.abs(Z0 - target) < 0.01) {
            return {
              content: [{ type: "text", text: `目标阻抗 ${target}Ω → 推荐线宽 ${mid.toFixed(2)} mil (实际阻抗 ${Z0.toFixed(2)}Ω)` }],
              details: { width: Math.round(mid * 100) / 100, impedance: Z0, error: Math.round((Z0 - target) * 100) / 100 },
            };
          }
          if (Z0 > target) lo = mid; else hi = mid;
        }
        const finalW = (lo + hi) / 2;
        return {
          content: [{ type: "text", text: `目标阻抗 ${target}Ω → 近似线宽 ${finalW.toFixed(2)} mil` }],
          details: { width: Math.round(finalW * 100) / 100 },
        };
      }

      // 给定线宽，计算阻抗
      const W = (p.width as number) ?? 10;
      let Z0: number;
      if (type === "microstrip") {
        Z0 = (87 / Math.sqrt(Er + 1.41)) * Math.log(5.98 * H / (0.8 * W + T));
      } else if (type === "stripline") {
        Z0 = (60 / Math.sqrt(Er)) * Math.log((4 * H) / (Math.PI * (W + T)));
      } else if (type === "diff_microstrip") {
        const S = (p.spacing as number) ?? 8;
        const Z0s = (87 / Math.sqrt(Er + 1.41)) * Math.log(5.98 * H / (0.8 * W + T));
        Z0 = 2 * Z0s * (1 - 0.48 * Math.exp(-0.96 * S / H));
      } else if (type === "diff_stripline") {
        const S = (p.spacing as number) ?? 8;
        Z0 = (120 / Math.sqrt(Er)) * Math.log((2 * H) / (Math.PI * (W + T + S)));
      } else {
        throw new Error(`未知阻抗类型: ${type}`);
      }
      return {
        content: [{ type: "text", text: `线宽 ${W}mil → 阻抗 ${Z0.toFixed(2)}Ω (${type})` }],
        details: { impedance: Math.round(Z0 * 100) / 100, type, width: W },
      };
    },
  });

  pi.registerTool({
    name: "calc_trace_width",
    label: "线宽计算",
    description: "根据载流要求计算最小走线宽度 (IPC-2221)",
    parameters: Type.Object({
      current: Type.Number({ description: "电流 (A)" }),
      thickness: Type.Optional(Type.Number({ description: "铜厚 (mil)，默认 1.4 (1oz)" })),
      tempRise: Type.Optional(Type.Number({ description: "允许温升 (°C)，默认 10" })),
      layer: Type.Optional(Type.String({ description: "走线层类型: external | internal，默认 external" })),
    }),
    async execute(_id, params) {
      const p = params as Record<string, unknown>;
      const I = p.current as number;
      const T_copper = (p.thickness as number) ?? 1.4;
      const dT = (p.tempRise as number) ?? 10;
      const layer = (p.layer as string) ?? "external";

      const k = layer === "external" ? 0.048 : 0.024;
      const b = 0.44, c = 0.725;
      const A = Math.pow(I / (k * Math.pow(dT, b)), 1 / c);
      const W = A / T_copper;

      return {
        content: [{ type: "text", text: `${I}A, ${layer}, 温升${dT}°C → 最小线宽 ${W.toFixed(2)} mil` }],
        details: { minWidth: Math.round(W * 100) / 100, crossSection: Math.round(A * 100) / 100, current: I, tempRise: dT, layer },
      };
    },
  });

  // ─── 启动提示 ───
  pi.on("session_start", async () => {
    console.log("[jlc-mcp] 扩展已加载，使用 /jlc-start 启动 Gateway");
  });
}
