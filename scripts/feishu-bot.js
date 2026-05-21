// ============================================================
// feishu-bot.js — 本地持久进程，3 秒轮询 + 可选事件订阅
//
// 启动: node feishu-bot.js
// 默认每 3 秒查新消息，体感秒回
// 可选: 设 PUBLIC_URL 开启 Feishu Event Subscription（需 ngrok）
// /p SA042 <url> → 预览 → /p yes 确认 → 填表
// ============================================================

const fs = require("fs");
const path = require("path");
const http = require("http");

// ── Config ────────────────────────────────────────────────
const CONFIG = {
  port: parseInt(process.env.PORT) || 3456,
  publicUrl: process.env.PUBLIC_URL || "",
  feishu: {
    appId: process.env.FEISHU_APP_ID || "cli_aa873d6374a31cba",
    appSecret: process.env.FEISHU_APP_SECRET || "",
    verificationToken: process.env.FEISHU_VERIFICATION_TOKEN || "",
    spreadsheetToken: "SVPssYjPshEOzot6VuJcmqzqnMg",
    templateSheetId: "hb1ouh",
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
const TOKEN_REFRESH_MS = 100 * 60 * 1000;

// ── Global token cache ─────────────────────────────────────
let cachedToken = null;
let lastTokenRefresh = 0;

async function getToken() {
  if (cachedToken && Date.now() - lastTokenRefresh < TOKEN_REFRESH_MS) {
    return cachedToken;
  }
  cachedToken = await fetchTenantToken();
  lastTokenRefresh = Date.now();
  return cachedToken;
}

// ── Main ──────────────────────────────────────────────────
async function main() {
  if (!CONFIG.feishu.appSecret) {
    console.error("ERROR: FEISHU_APP_SECRET env var is required");
    process.exit(1);
  }
  if (!CONFIG.ai.apiKey) {
    console.error("ERROR: DEEPSEEK_API_KEY env var is required");
    process.exit(1);
  }

  // Pre-fetch token
  await getToken();
  log("===== feishu-bot started (event-driven) =====");
  log(`http server: port ${CONFIG.port}`);
  if (CONFIG.publicUrl) {
    log(`public url: ${CONFIG.publicUrl}`);
    log(`event callback: ${CONFIG.publicUrl}/feishu/events`);
  } else {
    log("WARNING: PUBLIC_URL not set — event subscription won't work");
    log("  Start ngrok: ngrok http " + CONFIG.port);
    log("  Then set PUBLIC_URL=<ngrok-url> and restart");
  }

  // Start HTTP server for Feishu events
  const server = http.createServer(handleRequest);
  server.listen(CONFIG.port);

  // Background: cleanup expired pending items every 15s
  setInterval(async () => {
    try {
      const token = await getToken();
      await cleanupExpired(token, Date.now());
    } catch {}
  }, 15000);

  // Background: polling loop (3s — feels instant)
  setInterval(async () => {
    try {
      const token = await getToken();
      const state = loadState();
      const chats = await listBotChats(token);
      for (const chat of chats) {
        const msgs = await listRecentMessages(token, chat.chat_id, state.lastProcessedTime);
        for (const msg of msgs) {
          await processMessage(token, msg);
        }
        if (msgs.length > 0) {
          state.lastProcessedTime = Math.max(...msgs.map((m) => m.create_time_ms));
          saveState(state);
        }
      }
    } catch {}
  }, 3000);
}

// ── HTTP Request Handler ───────────────────────────────────
async function handleRequest(req, res) {
  // CORS for ngrok debug UI
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("feishu-bot running\n");
    return;
  }

  if (req.method === "POST" && req.url === "/feishu/events") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const data = JSON.parse(body);
        log(`event: ${data.header?.event_type || "unknown"}`);

        // URL verification challenge
        if (data.type === "url_verification") {
          const resp = { challenge: data.challenge };
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(resp));
          log("url verification: ok");
          return;
        }

        // Message received
        if (data.header?.event_type === "im.message.receive_v1") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ code: 0 }));

          // Process asynchronously (don't block event response)
          const msg = data.event?.message;
          if (msg && msg.msg_type === "text") {
            const token = await getToken();
            // Construct message object compatible with existing processMessage
            const msgObj = {
              chat_id: msg.chat_id,
              message_id: msg.message_id,
              create_time_ms: parseInt(msg.create_time) || Date.now(),
              body: { content: msg.content },
            };
            await processMessage(token, msgObj);
            // Update state
            const state = loadState();
            state.lastProcessedTime = Math.max(
              state.lastProcessedTime,
              msgObj.create_time_ms
            );
            saveState(state);
          }
          return;
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ code: 0 }));
      } catch (e) {
        log(`event error: ${e.message}`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ code: 0 }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end("not found\n");
}

// ── Message Processing ─────────────────────────────────────
async function processMessage(token, msg) {
  // Skip bot's own messages
  if (msg.msg_type === "text" && msg.body?.content) {
    try {
      const content = typeof msg.body.content === "string"
        ? JSON.parse(msg.body.content) : msg.body.content;
      if (content.text && /^[⚠️❌📋✅⏰]/.test(content.text)) return;
    } catch {}
  }

  let text = extractText(msg);
  if (!text) return;

  // Strip @mention prefix
  text = text.replace(/^@\S+\s+/, "").trim();
  if (!text) return;

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
    await deletePending(token, msg.chat_id);
    await replyText(token, msg.message_id, "⏰ 预览已过期，请重新发送 `/p` 命令。");
    return;
  }

  // Try to write to spreadsheet; if permissions fail, still confirm cancellation
  let writeOk = false;
  try {
    const sheetId = await ensureSheet(token, item.project_code);
    const maxId = await getMaxId(token, sheetId);
    await appendRows(token, sheetId, item.requirements, maxId, item.doc_url);
    writeOk = true;
  } catch (e) {
    log(`sheet write failed: ${e.message}`);
  }

  const count = item.requirements.length;
  await deletePending(token, msg.chat_id);

  if (writeOk) {
    await replyText(
      token,
      msg.message_id,
      `✅ **${item.project_code}** 已更新需求表，新增 **${count}** 条。`
    );
  } else {
    // Best-effort: confirm even if sheet write failed
    await replyText(
      token,
      msg.message_id,
      `✅ 已确认 **${item.project_code}** 的 **${count}** 条需求（暂存已清理）。\n⚠️ 写入需求表失败，请检查表格权限后手动导入。`
    );
  }
  log(`confirmed: ${item.project_code}, ${count} items, writeOk=${writeOk}`);
}

// ── /p no → Cancel ───────────────────────────────────────
async function handleCancel(token, msg) {
  const pending = await getPending(token, msg.chat_id);
  if (!pending || pending.length === 0) {
    await replyText(token, msg.message_id, "⚠️ 没有待确认的需求。");
    return;
  }
  const item = pending[0];
  await deletePending(token, msg.chat_id);
  await replyText(
    token,
    msg.message_id,
    `已取消 **${item.project_code}** 的 **${item.requirements.length}** 条需求预览。`
  );
}

// ── Cleanup Expired ──────────────────────────────────────
async function cleanupExpired(token, now) {
  const all = await getAllPending(token);
  for (const item of all) {
    if (now - item.created_at > PENDING_EXPIRE_MS) {
      await deletePending(token, item.chat_id);
      try {
        await replyText(
          token,
          item.message_id,
          `⏰ **${item.project_code}** 预览已过期（超 5 分钟），已自动取消。请重新发送 \`/p\` 命令。`
        );
      } catch {}
      log(`expired: ${item.project_code}`);
    }
  }
}

// ── Feishu API ────────────────────────────────────────────
async function fetchTenantToken() {
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

美术类型（可组合）：UI, Icon, 模型, 原画, 动画, 特效
优先级：文档明确标核心/紧急 → P1，明确标重要 → P2，其余一律 P3

返回纯 JSON 数组（不要 markdown 代码块）：
[
  {"名称": "需求名称", "类型": "UI,Icon", "优先级": "P3", "备注": "补充说明"}
]

提取规则：
1. 一切源于文档，不编造文档中没有的内容。
2. 拆得越细越好——每个独立的美术资产单独一条。
3. 同名或强关联的组件/状态变体合并为一条，用"及其组件"或"及其状态"连接。
   例：文档有"连胜进度条"和"连胜进度条各里程碑节点发光"→ 合并为"连胜进度条及其组件"。
   例：文档有"落槌背景"和"金槌子落槌背景"→ 合并为"落槌背景及其状态"。
4. 独立功能、独立界面的元素不合并。
5. 名称用"界面名/资产名"，备注里简要说明文档中提到的关键细节。
6. 有动画/特效时类型里必须包含 动画/特效。

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

// ── Pending State (local JSON file) ───────────────────────
const PENDING_FILE = path.join(__dirname, ".feishu-bot-pending.json");

function loadPending() {
  try {
    return JSON.parse(fs.readFileSync(PENDING_FILE, "utf8"));
  } catch {
    return {};
  }
}

function savePendingFile(data) {
  fs.writeFileSync(PENDING_FILE, JSON.stringify(data));
}

async function savePending(token, item) {
  const all = loadPending();
  all[item.chat_id] = item;
  // Clean up expired entries
  for (const [chatId, pending] of Object.entries(all)) {
    if (Date.now() - pending.created_at > PENDING_EXPIRE_MS) {
      delete all[chatId];
    }
  }
  savePendingFile(all);
}

async function getPending(token, chatId) {
  const all = loadPending();
  const item = all[chatId];
  if (!item) return [];
  if (Date.now() - item.created_at > PENDING_EXPIRE_MS) {
    delete all[chatId];
    savePendingFile(all);
    return [];
  }
  return [item];
}

async function getAllPending(token) {
  const all = loadPending();
  const results = [];
  let changed = false;
  for (const [chatId, item] of Object.entries(all)) {
    if (Date.now() - item.created_at > PENDING_EXPIRE_MS) {
      delete all[chatId];
      changed = true;
    } else {
      results.push(item);
    }
  }
  if (changed) savePendingFile(all);
  return results;
}

async function deletePending(token, chatId) {
  const all = loadPending();
  delete all[chatId];
  savePendingFile(all);
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
