// ============================================================
// Feishu Art Bot — Vercel Serverless Function
//
// 飞书事件订阅 → Webhook → 处理 /p 命令 → 回复
// 无需轮询，无需 im:chat 权限
// ============================================================

const FEISHU_HOST = "https://open.feishu.cn";

const CONFIG = {
  feishu: {
    appId: process.env.FEISHU_APP_ID || "cli_aa873d6374a31cba",
    appSecret: process.env.FEISHU_APP_SECRET || "",
    spreadsheetToken: "SVPssYjPshEOzot6VuJcmqzqnMg",
    templateSheetId: "hb1ouh",
  },
  ai: {
    apiKey: process.env.DEEPSEEK_API_KEY || "",
    baseUrl: "https://api.deepseek.com/anthropic",
    model: "deepseek-v4-pro",
  },
};

// Simple in-memory token cache (per instance, good enough for low traffic)
let tokenCache = { value: null, expiresAt: 0 };

// ── Entry Point ─────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method === "GET") return res.status(200).send("feishu-art-bot OK");

  if (req.method !== "POST") return res.status(405).send("method not allowed");

  const body = req.body;

  // URL Verification (Feishu webhook challenge)
  if (body.type === "url_verification") {
    console.log("[webhook] url verification");
    return res.json({ challenge: body.challenge });
  }

  // Parse event
  const eventType = body.header?.event_type;
  if (eventType !== "im.message.receive_v1") {
    console.log(`[webhook] ignoring: ${eventType}`);
    return res.send("ok");
  }

  const event = body.event;
  const msg = event?.message;
  if (!msg) return res.send("ok");

  // Skip bot's own messages
  if (msg.sender?.sender_type === "bot") return res.send("ok");

  // Parse content
  let content;
  try {
    content = typeof msg.content === "string" ? JSON.parse(msg.content) : msg.content;
  } catch {
    return res.send("ok");
  }

  const text = (content.text || "").trim();
  console.log(`[msg] chat=${msg.chat_id} text="${text.slice(0, 80)}"`);

  // ── Route command ────────────────────────────────────────
  try {
    if (/^\/p\s+yes\b/i.test(text)) {
      await handleConfirm(msg);
    } else if (/^\/p\s+no\b/i.test(text)) {
      await handleCancel(msg);
    } else {
      const m = text.match(/^\/p\s+(\S+)\s+(https?:\/\/\S+)/);
      if (m) {
        await handlePreview(msg, m[1].toUpperCase(), m[2]);
      }
    }
  } catch (e) {
    console.error(`[error] ${e.message}`);
  }

  // Always return 200 quickly — processing happens in background
  // Vercel serverless: max 10s for free tier, which is enough
  res.send("ok");
}

// ── Token ───────────────────────────────────────────────────
async function getToken() {
  if (tokenCache.value && Date.now() < tokenCache.expiresAt) return tokenCache.value;
  const resp = await fetch(`${FEISHU_HOST}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: CONFIG.feishu.appId, app_secret: CONFIG.feishu.appSecret }),
  });
  const data = await resp.json();
  if (data.code !== 0) throw new Error(`token: ${data.msg}`);
  tokenCache = { value: data.tenant_access_token, expiresAt: Date.now() + (data.expire - 60) * 1000 };
  return tokenCache.value;
}

async function feishuApi(method, path, body) {
  const token = await getToken();
  const headers = { Authorization: `Bearer ${token}` };
  if (body) headers["Content-Type"] = "application/json";
  const resp = await fetch(`${FEISHU_HOST}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await resp.json();
  if (data.code !== 0) throw new Error(`${path}: ${data.code} ${data.msg}`);
  return data;
}

// ── Reply ───────────────────────────────────────────────────
async function replyText(messageId, text) {
  await feishuApi("POST", `/open-apis/im/v1/messages/${messageId}/reply`, {
    content: JSON.stringify({ text }),
    msg_type: "text",
  });
}

// ── /p <code> <url> → Preview ──────────────────────────────
async function handlePreview(msg, projectCode, docUrl) {
  console.log(`[preview] ${projectCode}`);

  // 1. Read doc
  const docContent = await fetchDoc(docUrl);
  if (!docContent) {
    await replyText(msg.message_id, "❌ 无法读取文档，请确认链接可访问。");
    return;
  }

  // 2. AI extract
  const requirements = await extractRequirements(projectCode, docUrl, docContent);
  if (!requirements || requirements.length === 0) {
    await replyText(msg.message_id, "⚠️ 未从文档中识别到美术需求。");
    return;
  }

  // 3. Save pending state (simple: encode in reply context)
  const pendingKey = Buffer.from(JSON.stringify({
    chat_id: msg.chat_id,
    project_code: projectCode,
    doc_url: docUrl,
    requirements,
    created_at: Date.now(),
  })).toString("base64");

  const lines = requirements.map(
    (r, i) => `  ${i + 1}. **${r.名称}** — ${r.类型} [${r.优先级}]`
  );
  await replyText(
    msg.message_id,
    `📋 **${projectCode}** 识别到 **${requirements.length}** 条美术需求：\n${lines.join("\n")}\n\n---\n回复 \`/p yes\` 确认填入需求表\n回复 \`/p no\` 取消\n⏰ 5 分钟后自动取消\n\n\`${pendingKey}\``
  );
  console.log(`[preview] done: ${requirements.length} items`);
}

// ── /p yes → Confirm ───────────────────────────────────────
async function handleConfirm(msg) {
  // Read pending from the message being replied to
  // For simplicity: we'll use a spreadsheet-based pending state
  // that the old bot used — "待确认" sheet
  const pending = await getPending(msg.chat_id);
  if (!pending) {
    await replyText(msg.message_id, "⚠️ 没有待确认的需求（可能已过期）。");
    return;
  }

  if (Date.now() - pending.created_at > 5 * 60 * 1000) {
    await deletePending(pending.row_index);
    await replyText(msg.message_id, "⏰ 预览已过期，请重新发送 `/p` 命令。");
    return;
  }

  const sheetId = await ensureSheet(pending.project_code);
  const maxId = await getMaxId(sheetId);
  await appendRows(sheetId, pending.requirements, maxId, pending.doc_url);
  await deletePending(pending.row_index);

  await replyText(
    msg.message_id,
    `✅ **${pending.project_code}** 已更新，新增 **${pending.requirements.length}** 条美术需求。`
  );
  console.log(`[confirm] ${pending.project_code}, ${pending.requirements.length} items`);
}

// ── /p no → Cancel ─────────────────────────────────────────
async function handleCancel(msg) {
  const pending = await getPending(msg.chat_id);
  if (!pending) {
    await replyText(msg.message_id, "⚠️ 没有待确认的需求。");
    return;
  }
  await deletePending(pending.row_index);
  await replyText(msg.message_id, "已取消。");
}

// ── Doc Reading ─────────────────────────────────────────────
async function fetchDoc(url) {
  const m = url.match(/\/(wiki|docx)\/([A-Za-z0-9]+)/);
  if (!m) return null;
  const docToken = m[2];

  if (m[1] === "wiki") {
    try {
      const data = await feishuApi("GET", `/open-apis/wiki/v2/spaces/get_node?token=${docToken}`);
      const node = data.data?.node;
      if (node?.obj_token) return await fetchDocxContent(node.obj_token);
    } catch {}
    return await fetchDocxContent(docToken);
  }
  return await fetchDocxContent(docToken);
}

async function fetchDocxContent(documentId) {
  try {
    const data = await feishuApi("GET", `/open-apis/docx/v1/documents/${documentId}/raw_content`);
    const blocks = data.data?.blocks || [];
    return blocks
      .map((b) => {
        const getText = (el) => el.text_run?.content || "";
        if (b.text) return b.text.elements?.map(getText).join("");
        if (b.heading1) return "# " + b.heading1.elements?.map(getText).join("");
        if (b.heading2) return "## " + b.heading2.elements?.map(getText).join("");
        if (b.heading3) return "### " + b.heading3.elements?.map(getText).join("");
        if (b.bullet) return "• " + b.bullet.elements?.map(getText).join("");
        if (b.ordered) return "1. " + b.ordered.elements?.map(getText).join("");
        return "";
      })
      .filter(Boolean)
      .join("\n");
  } catch {
    return null;
  }
}

// ── AI Extraction ───────────────────────────────────────────
async function extractRequirements(projectCode, docUrl, docContent) {
  const prompt = `你是游戏项目美术需求提取工具。阅读以下策划文档，提取所有美术资源需求。

美术类型只能是以下之一或组合：UI, Icon, 模型, 原画, 动画, 特效
优先级：P1(核心/紧急), P2(重要), P3(锦上添花)

返回纯 JSON 数组（不要 markdown 代码块）：
[
  {"名称": "需求名称", "类型": "UI,Icon", "优先级": "P2", "备注": "补充说明"}
]

规则：每个独立美术资源拆一条。名称具体。有动画/特效时类型里要包含。

文档：
---
${docContent}
---`;

  const resp = await fetch(`${CONFIG.ai.baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": CONFIG.ai.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: CONFIG.ai.model,
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const data = await resp.json();
  const text = data.content?.[0]?.text || "";
  const json = text.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  try { return JSON.parse(json); } catch { return []; }
}

// ── Sheet Operations ────────────────────────────────────────
async function ensureSheet(projectCode) {
  const data = await feishuApi("GET",
    `/open-apis/sheets/v2/spreadsheets/${CONFIG.feishu.spreadsheetToken}/metainfo?extended_fields=true`);
  const sheets = data.data?.sheets || [];
  const existing = sheets.find((s) => s.title === projectCode && !s.hidden);
  if (existing) return existing.sheet_id;

  const resp = await feishuApi("POST",
    `/open-apis/sheets/v2/spreadsheets/${CONFIG.feishu.spreadsheetToken}/sheets_batch_update`,
    { requests: [{ copySheet: { source: { sheetId: CONFIG.feishu.templateSheetId }, destination: { title: projectCode } } }] });
  return resp.data?.replies?.[0]?.copySheet?.sheetId;
}

async function getMaxId(sheetId) {
  try {
    const data = await feishuApi("GET",
      `/open-apis/sheets/v2/spreadsheets/${CONFIG.feishu.spreadsheetToken}/values/${sheetId}!A2:A`);
    return Math.max(0, ...(data.data?.valueRange?.values || []).map((r) => parseInt(r[0]) || 0));
  } catch { return 0; }
}

async function appendRows(sheetId, requirements, startId, docUrl) {
  const rows = requirements.map((r, i) => [
    startId + i + 1, r.名称 || "", docUrl, r.类型 || "", r.优先级 || "P2",
    "", "", "", "", "", r.备注 || "",
  ]);
  for (let i = 0; i < rows.length; i += 50) {
    await feishuApi("POST",
      `/open-apis/sheets/v2/spreadsheets/${CONFIG.feishu.spreadsheetToken}/values_append`,
      { valueRange: { range: `${sheetId}!A${startId + i + 2}`, values: rows.slice(i, i + 50) } });
  }
}

// ── Pending State (in "待确认" sheet) ─────────────────────
async function ensurePendingSheet() {
  const data = await feishuApi("GET",
    `/open-apis/sheets/v2/spreadsheets/${CONFIG.feishu.spreadsheetToken}/metainfo?extended_fields=true`);
  const sheets = data.data?.sheets || [];
  const existing = sheets.find((s) => s.title === "待确认");
  if (existing) return existing.sheet_id;

  const resp = await feishuApi("POST",
    `/open-apis/sheets/v2/spreadsheets/${CONFIG.feishu.spreadsheetToken}/sheets_batch_update`,
    { requests: [{ addSheet: { properties: { title: "待确认", index: 0 } } }] });
  const sheetId = resp.data?.replies?.[0]?.addSheet?.properties?.sheetId;
  if (sheetId) {
    await feishuApi("POST",
      `/open-apis/sheets/v2/spreadsheets/${CONFIG.feishu.spreadsheetToken}/values_append`,
      { valueRange: { range: `${sheetId}!A1`, values: [["chat_id", "message_id", "project_code", "doc_url", "requirements_json", "created_at"]] } });
  }
  return sheetId;
}

async function savePending(item) {
  const sheetId = await ensurePendingSheet();
  await feishuApi("POST",
    `/open-apis/sheets/v2/spreadsheets/${CONFIG.feishu.spreadsheetToken}/values_append`,
    { valueRange: { range: `${sheetId}!A2`, values: [[item.chat_id, item.message_id, item.project_code, item.doc_url, JSON.stringify(item.requirements), item.created_at]] } });
}

async function getPending(chatId) {
  try {
    const sheetId = await ensurePendingSheet();
    const data = await feishuApi("GET",
      `/open-apis/sheets/v2/spreadsheets/${CONFIG.feishu.spreadsheetToken}/values/${sheetId}!A2:F`);
    const rows = data.data?.valueRange?.values || [];
    const idx = rows.findIndex((row) => row[0] === chatId);
    if (idx === -1) return null;
    const row = rows[idx];
    return { row_index: idx + 2, chat_id: row[0], message_id: row[1], project_code: row[2], doc_url: row[3], requirements: JSON.parse(row[4] || "[]"), created_at: Number(row[5]) || 0 };
  } catch { return null; }
}

async function deletePending(rowIndex) {
  try {
    const sheetId = await ensurePendingSheet();
    await feishuApi("POST",
      `/open-apis/sheets/v2/spreadsheets/${CONFIG.feishu.spreadsheetToken}/values_append`,
      { valueRange: { range: `${sheetId}!A${rowIndex}:F${rowIndex}`, values: [["__DEL__", "", "", "", "", ""]] } });
  } catch {}
}
