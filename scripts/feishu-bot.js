// ============================================================
// feishu-bot.js — GitHub Actions 定时轮询
//
// 每 2 分钟运行:
//   1. 查机器人新消息
//   2. /p SA042 <url> → 预览
//   3. /p yes → 确认填表
//   4. 5 分钟无确认 → 自动取消
// ============================================================

const fs = require("fs");
const path = require("path");

// ── Config ────────────────────────────────────────────────
const CONFIG = {
  feishu: {
    appId: process.env.FEISHU_APP_ID || "cli_aa873d6374a31cba",
    appSecret: process.env.FEISHU_APP_SECRET || "",
    spreadsheetToken: "SVPssYjPshEOzot6VuJcmqzqnMg",
    templateSheetId: "hb1ouh",
    pendingSheetTitle: "待确认",
  },
  ai: {
    apiKey: process.env.DEEPSEEK_API_KEY || "",
    baseUrl: "https://api.deepseek.com/anthropic",
    model: "deepseek-v4-pro",
  },
};

const FEISHU_HOST = "https://open.feishu.cn";
const STATE_FILE = path.join(__dirname, ".feishu-bot-state.json");
const PENDING_EXPIRE_MS = 5 * 60 * 1000;

// ── Main ──────────────────────────────────────────────────
async function main() {
  log("bot start");

  const state = loadState();
  const now = Date.now();

  const token = await getTenantToken();
  const chats = await listBotChats(token);
  log(`found ${chats.length} chats`);

  // Get new messages from all chats
  const newMessages = [];
  for (const chat of chats) {
    const msgs = await listRecentMessages(token, chat.chat_id, state.lastProcessedTime);
    newMessages.push(...msgs);
  }
  log(`new messages: ${newMessages.length}`);

  if (newMessages.length > 0) {
    const maxTime = Math.max(...newMessages.map((m) => m.create_time_ms));
    state.lastProcessedTime = maxTime;
    saveState(state);
  }

  // Process messages
  for (const msg of newMessages) {
    // Skip bot's own messages to avoid infinite loop
    if (msg.msg_type === "text" && msg.body?.content) {
      try {
        const content = typeof msg.body.content === "string"
          ? JSON.parse(msg.body.content) : msg.body.content;
        if (content.text && /^[⚠️❌📋✅⏰]/.test(content.text)) continue;
      } catch {}
    }

    let text = extractText(msg);
    if (!text) continue;

    // Strip @mention prefix (group chat bot @mention format)
    text = text.replace(/^@\S+\s+/, "").trim();
    if (!text) continue;

    log(`msg: chat=${msg.chat_id} text="${text.slice(0, 80)}"`);

    try {
      if (/^\/p\s+yes\b/i.test(text)) {
        await handleConfirm(token, msg);
      } else if (/^\/p\s+no\b/i.test(text)) {
        await handleCancel(token, msg);
      } else {
        const match = text.match(/^\/p\s+(\S+)\s+(https?:\/\/\S+)/);
        if (match) {
          await handlePreview(token, msg, match[1].toUpperCase(), match[2]);
        }
      }
    } catch (e) {
      log(`error: ${e.message}`);
    }
  }

  // Clean up expired pending items
  await cleanupExpired(token, now);

  log("bot done");
}

// ── Message Helpers ──────────────────────────────────────
function extractText(msg) {
  try {
    // Feishu API wraps content inside body.content (not top-level content)
    const raw = msg.body?.content || msg.content;
    const content = typeof raw === "string" ? JSON.parse(raw) : (raw || {});
    return (content.text || "").trim();
  } catch {
    return "";
  }
}

// ── /p <code> <url> → Preview ────────────────────────────
async function handlePreview(token, msg, projectCode, docUrl) {
  log(`preview: ${projectCode}`);

  const docContent = await fetchFeishuDoc(token, docUrl);
  if (!docContent) {
    await replyText(token, msg.message_id, "❌ 无法读取文档内容，请确认链接可访问。");
    return;
  }

  const requirements = await extractArtRequirements(docContent);
  if (!requirements || requirements.length === 0) {
    await replyText(token, msg.message_id, "⚠️ 未从文档中识别到美术需求。");
    return;
  }

  // Send preview FIRST, then try to save pending state (non-blocking)
  const lines = requirements.map(
    (r, i) => `  ${i + 1}. **${r.名称}** — ${r.类型} [${r.优先级}]`
  );
  await replyText(
    token,
    msg.message_id,
    `📋 **${projectCode}** 识别到 **${requirements.length}** 条美术需求：\n${lines.join("\n")}\n\n---\n回复 \`/p yes\` 确认填入需求表\n回复 \`/p no\` 取消\n⏰ 5 分钟后自动取消`
  );
  log(`preview sent: ${requirements.length} items`);

  // Save pending state for /p yes|no (best-effort, don't block reply)
  try {
    await savePending(token, {
      chat_id: msg.chat_id,
      message_id: msg.message_id,
      project_code: projectCode,
      doc_url: docUrl,
      requirements: requirements,
      created_at: Date.now(),
    });
  } catch (e) {
    log(`savePending failed (non-fatal): ${e.message}`);
    await replyText(token, msg.message_id, "⚠️ 预览已生成，但暂存状态失败，`/p yes` 确认功能暂不可用。");
  }
}

// ── /p yes → Confirm ─────────────────────────────────────
async function handleConfirm(token, msg) {
  const pending = await getPending(token, msg.chat_id);
  if (!pending || pending.length === 0) {
    await replyText(token, msg.message_id, "⚠️ 没有待确认的需求（可能已过期）。");
    return;
  }

  const item = pending[0];
  if (Date.now() - item.created_at > PENDING_EXPIRE_MS) {
    await deletePending(token, item.row_index);
    await replyText(token, msg.message_id, "⏰ 预览已过期，请重新发送 `/p` 命令。");
    return;
  }

  const sheetId = await ensureSheet(token, item.project_code);
  const maxId = await getMaxId(token, sheetId);
  await appendRows(token, sheetId, item.requirements, maxId, item.doc_url);
  await deletePending(token, item.row_index);

  const count = item.requirements.length;
  await replyText(
    token,
    msg.message_id,
    `✅ **${item.project_code}** 已更新，新增 **${count}** 条美术需求。`
  );
  log(`confirmed: ${item.project_code}, ${count} items`);
}

// ── /p no → Cancel ───────────────────────────────────────
async function handleCancel(token, msg) {
  const pending = await getPending(token, msg.chat_id);
  if (!pending || pending.length === 0) {
    await replyText(token, msg.message_id, "⚠️ 没有待确认的需求。");
    return;
  }
  await deletePending(token, pending[0].row_index);
  await replyText(token, msg.message_id, "已取消。");
}

// ── Cleanup Expired ──────────────────────────────────────
async function cleanupExpired(token, now) {
  const all = await getAllPending(token);
  for (const item of all) {
    if (now - item.created_at > PENDING_EXPIRE_MS) {
      await deletePending(token, item.row_index);
      try {
        await replyText(
          token,
          item.message_id,
          "⏰ 预览已过期，已自动取消。"
        );
      } catch {}
      log(`expired: ${item.project_code}`);
    }
  }
}

// ── Feishu API ────────────────────────────────────────────
async function getTenantToken() {
  const resp = await fetch(`${FEISHU_HOST}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      app_id: CONFIG.feishu.appId,
      app_secret: CONFIG.feishu.appSecret,
    }),
  });
  const data = await resp.json();
  if (data.code !== 0) throw new Error(`token: ${data.msg}`);
  return data.tenant_access_token;
}

async function feishuApi(token, method, path, body = null) {
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

async function listBotChats(token) {
  const data = await feishuApi(token, "GET", "/open-apis/im/v1/chats?page_size=100");
  return data.data?.items || [];
}

async function listRecentMessages(token, chatId, sinceTimeMs) {
  const path = `/open-apis/im/v1/messages?container_id_type=chat&container_id=${chatId}&page_size=20&sort_type=ByCreateTimeDesc`;
  const data = await feishuApi(token, "GET", path);
  const items = data.data?.items || [];
  // create_time from Feishu API is already in milliseconds
  const since = Number(sinceTimeMs) || 0;
  return items
    .filter((m) => (Number(m.create_time) || 0) > since)
    .map((m) => ({ ...m, create_time_ms: Number(m.create_time) || 0 }));
}

async function replyText(token, messageId, text) {
  await feishuApi(token, "POST", `/open-apis/im/v1/messages/${messageId}/reply`, {
    content: JSON.stringify({ text }),
    msg_type: "text",
  });
}

// ── Doc Reading ──────────────────────────────────────────
async function fetchFeishuDoc(token, url) {
  const tokenMatch = url.match(/\/(wiki|docx)\/([A-Za-z0-9]+)/);
  if (!tokenMatch) return null;
  const docToken = tokenMatch[2];

  try {
    const nodeData = await feishuApi(
      token, "GET",
      `/open-apis/wiki/v2/spaces/get_node?token=${docToken}`
    );
    log(`wiki nodeData keys: ${Object.keys(nodeData).join(",")} data keys: ${nodeData.data ? Object.keys(nodeData.data).join(",") : "no data"}`);
    const node = nodeData.data?.node;
    log(`wiki node: ${node ? `obj_type=${node.obj_type} obj_token=${node.obj_token?.slice(0,19)}` : "null"}`);
    if (node?.obj_type === "docx" && node?.obj_token) {
      return await fetchDocxContent(token, node.obj_token);
    }
    log(`wiki node: obj_type=${node?.obj_type} obj_token=${node?.obj_token}`);
    return `[${node?.obj_type || "unknown"}]`;
  } catch (e) {
    log(`wiki node error: ${e.message}`);
  }

  log(`falling back to docx direct with token=${docToken}`);
  return await fetchDocxContent(token, docToken);
}

async function fetchDocxContent(token, documentId) {
  try {
    const data = await feishuApi(
      token, "GET",
      `/open-apis/docx/v1/documents/${documentId}/raw_content`
    );
    // raw_content returns data.content as plain text
    const content = data.data?.content || "";
    if (content) {
      log(`docx content: ${content.length} chars`);
      return content;
    }
    // Fallback: try structured blocks
    const blocks = data.data?.blocks || [];
    log(`docx blocks fallback: ${blocks.length} blocks`);
    return blocks
      .map((block) => {
        const getText = (el) => el.text_run?.content || "";
        if (block.text) return block.text.elements?.map(getText).join("");
        if (block.heading1) return "# " + block.heading1.elements?.map(getText).join("");
        if (block.heading2) return "## " + block.heading2.elements?.map(getText).join("");
        if (block.heading3) return "### " + block.heading3.elements?.map(getText).join("");
        if (block.bullet) return "• " + block.bullet.elements?.map(getText).join("");
        if (block.ordered) return "1. " + block.ordered.elements?.map(getText).join("");
        return "";
      })
      .filter(Boolean)
      .join("\n");
  } catch (e) {
    log(`docx error: ${e.message}`);
    return null;
  }
}

// ── AI Extraction ────────────────────────────────────────
async function extractArtRequirements(docContent) {
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

  const url = `${CONFIG.ai.baseUrl}/v1/messages`;
  const t0 = Date.now();
  let resp;
  try {
    resp = await fetch(url, {
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
  } catch (e) {
    log(`ai fetch error: ${e.message}`);
    return [];
  }

  const elapsed = Date.now() - t0;
  log(`ai http: ${resp.status} ${resp.statusText} (${elapsed}ms)`);

  const rawBody = await resp.text();
  log(`ai resp body: ${rawBody.slice(0, 500)}`);

  if (!resp.ok) {
    log(`ai non-ok response, returning []`);
    return [];
  }

  let data;
  try {
    data = JSON.parse(rawBody);
  } catch {
    log(`ai resp not valid json`);
    return [];
  }

  // DeepSeek returns content array with thinking + text blocks; find the text one
  let aiText = "";
  if (typeof data.content === "string") {
    aiText = data.content;
  } else if (Array.isArray(data.content)) {
    aiText = data.content.find(c => c.type === "text")?.text || "";
    // Fallback: some responses might only have a single content block without type
    if (!aiText && data.content.length === 1 && data.content[0].text) {
      aiText = data.content[0].text;
    }
  }
  log(`ai text length: ${aiText.length}, preview: ${aiText.slice(0, 200)}`);

  // Try multiple extraction strategies
  let jsonStr = aiText.trim();

  // Strategy 1: extract from ```json ... ``` code block
  const fenced = jsonStr.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced) jsonStr = fenced[1].trim();

  // Strategy 2: find first [ ... ] array
  const arrayMatch = jsonStr.match(/\[\s*\{[\s\S]*\}\s*\]/);
  if (arrayMatch) jsonStr = arrayMatch[0];

  try {
    const result = JSON.parse(jsonStr);
    if (!Array.isArray(result)) {
      log(`ai returned non-array: ${typeof result}`);
      return [];
    }
    log(`ai parsed: ${result.length} items`);
    return result;
  } catch (e) {
    log(`ai json parse failed: ${e.message}. jsonStr preview: ${jsonStr.slice(0, 300)}`);
    return [];
  }
}

// ── Sheet Operations ─────────────────────────────────────
async function ensureSheet(token, projectCode) {
  const data = await feishuApi(
    token, "GET",
    `/open-apis/sheets/v2/spreadsheets/${CONFIG.feishu.spreadsheetToken}/metainfo?extended_fields=true`
  );
  const sheets = data.data?.sheets || [];
  const existing = sheets.find((s) => s.title === projectCode && !s.hidden);
  if (existing) return existing.sheet_id;

  const resp = await feishuApi(
    token, "POST",
    `/open-apis/sheets/v2/spreadsheets/${CONFIG.feishu.spreadsheetToken}/sheets_batch_update`,
    {
      requests: [{
        copySheet: {
          source: { sheetId: CONFIG.feishu.templateSheetId },
          destination: { title: projectCode },
        },
      }],
    }
  );
  return resp.data?.replies?.[0]?.copySheet?.sheetId;
}

async function getMaxId(token, sheetId) {
  try {
    const data = await feishuApi(
      token, "GET",
      `/open-apis/sheets/v2/spreadsheets/${CONFIG.feishu.spreadsheetToken}/values/${sheetId}!A2:A`
    );
    const values = data.data?.valueRange?.values || [];
    return Math.max(0, ...values.map((r) => parseInt(r[0]) || 0));
  } catch {
    return 0;
  }
}

async function appendRows(token, sheetId, requirements, startId, docUrl) {
  const rows = requirements.map((r, i) => [
    startId + i + 1,
    r.名称 || "",
    docUrl,
    r.类型 || "",
    r.优先级 || "P2",
    "", "", "", "", "",
    r.备注 || "",
  ]);
  for (let i = 0; i < rows.length; i += 50) {
    await feishuApi(
      token, "POST",
      `/open-apis/sheets/v2/spreadsheets/${CONFIG.feishu.spreadsheetToken}/values_append`,
      {
        valueRange: {
          range: `${sheetId}!A${startId + i + 2}`,
          values: rows.slice(i, i + 50),
        },
      }
    );
  }
}

// ── Pending State ("待确认" sheet in spreadsheet) ───────
async function ensurePendingSheet(token) {
  const data = await feishuApi(
    token, "GET",
    `/open-apis/sheets/v2/spreadsheets/${CONFIG.feishu.spreadsheetToken}/metainfo?extended_fields=true`
  );
  const sheets = data.data?.sheets || [];
  const existing = sheets.find((s) => s.title === CONFIG.feishu.pendingSheetTitle);
  if (existing) return existing.sheet_id;

  const resp = await feishuApi(
    token, "POST",
    `/open-apis/sheets/v2/spreadsheets/${CONFIG.feishu.spreadsheetToken}/sheets_batch_update`,
    {
      requests: [{
        addSheet: { properties: { title: CONFIG.feishu.pendingSheetTitle, index: 0 } },
      }],
    }
  );
  const sheetId = resp.data?.replies?.[0]?.addSheet?.properties?.sheetId;
  if (sheetId) {
    await feishuApi(
      token, "POST",
      `/open-apis/sheets/v2/spreadsheets/${CONFIG.feishu.spreadsheetToken}/values_append`,
      {
        valueRange: {
          range: `${sheetId}!A1`,
          values: [["chat_id", "message_id", "project_code", "doc_url", "requirements_json", "created_at"]],
        },
      }
    );
  }
  return sheetId;
}

async function savePending(token, item) {
  const sheetId = await ensurePendingSheet(token);
  await feishuApi(
    token, "POST",
    `/open-apis/sheets/v2/spreadsheets/${CONFIG.feishu.spreadsheetToken}/values_append`,
    {
      valueRange: {
        range: `${sheetId}!A2`,
        values: [[
          item.chat_id,
          item.message_id,
          item.project_code,
          item.doc_url,
          JSON.stringify(item.requirements),
          item.created_at,
        ]],
      },
    }
  );
}

async function getPending(token, chatId) {
  try {
    const sheetId = await ensurePendingSheet(token);
    const data = await feishuApi(
      token, "GET",
      `/open-apis/sheets/v2/spreadsheets/${CONFIG.feishu.spreadsheetToken}/values/${sheetId}!A2:F`
    );
    const rows = data.data?.valueRange?.values || [];
    const idx = rows.findIndex((row) => row[0] === chatId);
    if (idx === -1) return [];
    const row = rows[idx];
    return [{
      row_index: idx + 2,
      chat_id: row[0],
      message_id: row[1],
      project_code: row[2],
      doc_url: row[3],
      requirements: JSON.parse(row[4] || "[]"),
      created_at: Number(row[5]) || 0,
    }];
  } catch {
    return [];
  }
}

async function getAllPending(token) {
  try {
    const sheetId = await ensurePendingSheet(token);
    const data = await feishuApi(
      token, "GET",
      `/open-apis/sheets/v2/spreadsheets/${CONFIG.feishu.spreadsheetToken}/values/${sheetId}!A2:F`
    );
    const rows = data.data?.valueRange?.values || [];
    return rows.map((row, i) => ({
      row_index: i + 2,
      chat_id: row[0],
      message_id: row[1],
      project_code: row[2],
      doc_url: row[3],
      requirements: JSON.parse(row[4] || "[]"),
      created_at: Number(row[5]) || 0,
    }));
  } catch {
    return [];
  }
}

async function deletePending(token, rowIndex) {
  try {
    const sheetId = await ensurePendingSheet(token);
    // Clear the row by writing empty values
    await feishuApi(
      token, "POST",
      `/open-apis/sheets/v2/spreadsheets/${CONFIG.feishu.spreadsheetToken}/values_append`,
      {
        valueRange: {
          range: `${sheetId}!A${rowIndex}:F${rowIndex}`,
          values: [["__DELETED__", "", "", "", "", ""]],
        },
      }
    );
  } catch {}
}

// ── State File ────────────────────────────────────────────
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { lastProcessedTime: 0 };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state));
}

function log(msg) {
  const ts = new Date().toISOString().slice(0, 19).replace("T", " ");
  console.log(`[${ts}] ${msg}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
