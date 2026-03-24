import type { ClawdbotPluginApi } from "openclaw-cn/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw-cn/plugin-sdk";

import { setOdooRuntime, getOdooRuntime } from "./runtime.js";

interface OdooConfig {
  url: string;
  db?: string;
  uid?: number;
  password?: string;
  apiKey?: string;
  botPartnerId: number;
  webhookSecret?: string;
}

type MaybeWrappedOdooConfig = OdooConfig & { odoo?: OdooConfig };

type OdooMessage = {
  id: number;
  body?: string;
  author_id?: [number, string];
  partner_ids?: number[];
  res_id?: number;
  date?: string;
};

type OdooChannel = {
  id: number;
  name?: string;
  channel_type?: string;
};

/* ── Legacy JSON-RPC only ── */

async function odooRpcLegacy(
  cfg: OdooConfig,
  model: string,
  method: string,
  args: any[] = [],
  kwargs: Record<string, any> = {},
): Promise<any> {
  if (!cfg.db || !cfg.uid || !cfg.password) {
    throw new Error("Legacy Odoo RPC requires db, uid, and password");
  }

  const body = JSON.stringify({
    jsonrpc: "2.0",
    method: "call",
    id: Date.now(),
    params: {
      service: "object",
      method: "execute_kw",
      args: [cfg.db, cfg.uid, cfg.password, model, method, args],
      kwargs,
    },
  });

  const resp = await fetch(`${cfg.url}/jsonrpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });

  const json = (await resp.json()) as any;
  if (json.error) {
    throw new Error(`Odoo RPC error: ${json.error.data?.message || json.error.message}`);
  }
  return json.result;
}

async function odooRpc(
  cfg: OdooConfig,
  model: string,
  method: string,
  args: any[] = [],
  kwargs: Record<string, any> = {},
): Promise<any> {
  return await odooRpcLegacy(cfg, model, method, args, kwargs);
}

async function sendToChannel(cfg: OdooConfig, channelId: number, text: string, isHtml = false): Promise<void> {
  await odooRpcLegacy(cfg, "discuss.channel", "openclaw_post_bot_message", [[channelId], text], {
    author_partner_id: cfg.botPartnerId,
    is_html: isHtml,
  });
}

/* ── Helpers ── */

function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatInlineMarkdown(text: string): string {
  let s = escapeHtml(text);
  s = s.replace(/`([^`]+)`/g, "<code style=\"background:#eef2ff;color:#3730a3;padding:2px 6px;border-radius:6px;font-family:Consolas,monospace;font-size:12px;\">$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__(.+?)__/g, "<strong>$1</strong>");
  s = s.replace(/\*(?!\s)([^*]+?)\*/g, "<em>$1</em>");
  return s;
}

function getNoticeStyle(text: string): string | null {
  if (/^(✅|🎉|🟢|成功|已完成|已创建|已确认)/.test(text)) {
    return "background:#ecfdf3;border-left:4px solid #16a34a;";
  }
  if (/^(⚠️|⚠|提醒|注意|警告)/.test(text)) {
    return "background:#fffbeb;border-left:4px solid #d97706;";
  }
  if (/^(❌|错误|失败|异常|报错)/.test(text)) {
    return "background:#fef2f2;border-left:4px solid #dc2626;";
  }
  if (/^(ℹ️|提示|说明|信息)/.test(text)) {
    return "background:#eff6ff;border-left:4px solid #2563eb;";
  }
  return null;
}

function guessEmojiTitle(text: string): { emoji: string; title: string } | null {
  const first = text.split(/\r?\n/).map((s) => s.trim()).find(Boolean) || "";
  if (!first) return null;

  if (/(失败|错误|异常|报错|error)/i.test(first)) return { emoji: "❌", title: first.replace(/^(❌|错误[:：]?|失败[:：]?)/, "").trim() || "处理失败" };
  if (/(提醒|注意|警告|warning)/i.test(first)) return { emoji: "⚠️", title: first.replace(/^(⚠️|⚠|提醒[:：]?|注意[:：]?)/, "").trim() || "请注意" };
  if (/(采购单|purchase|rfq|po)/i.test(text)) return { emoji: "📦", title: first };
  if (/(销售单|sale order|\bso\b)/i.test(text)) return { emoji: "🧾", title: first };
  if (/(发票|invoice|bill)/i.test(text)) return { emoji: "💰", title: first };
  if (/(客户|联系人|partner|supplier|vendor)/i.test(text)) return { emoji: "👤", title: first };
  if (/(成功|已创建|已确认|已完成|完成了)/i.test(first)) return { emoji: "✅", title: first };
  if (/(查询|结果|找到|列表|list|search|show)/i.test(first)) return { emoji: "🔎", title: first };
  return { emoji: "✨", title: first };
}

function parseKeyValueLine(line: string): { key: string; value: string } | null {
  const m = line.match(/^\s*(?:[-*•]\s*)?(?:\*\*)?([^:：]{1,24}?)(?:\*\*)?\s*[:：]\s*(.+)\s*$/);
  if (!m) return null;
  const key = m[1].trim();
  const value = m[2].trim();
  if (!key || !value) return null;
  if (/^(http|https):\/\//i.test(key)) return null;
  return { key, value };
}

function looksLikeDivider(line: string): boolean {
  return /^[-=]{3,}$/.test(line.trim());
}

function parseListHeader(line: string): string | null {
  const trimmed = line.trim();
  const numbered = trimmed.match(/^\d+[.)]\s+(.+)$/);
  if (numbered) return numbered[1].trim();
  const bulleted = trimmed.match(/^[-*]\s+(.+)$/);
  if (bulleted) return bulleted[1].trim();
  return null;
}

function tryBuildRecordTable(src: string[], startIndex: number): { lines: string[]; nextIndex: number } | null {
  const records: Array<{ title: string; fields: Record<string, string> }> = [];
  let i = startIndex;

  while (i < src.length) {
    while (i < src.length && !src[i].trim()) i += 1;
    if (i >= src.length) break;

    const title = parseListHeader(src[i]);
    if (!title) break;
    i += 1;

    const fields: Record<string, string> = {};
    while (i < src.length) {
      const line = src[i].trim();
      if (!line) {
        i += 1;
        break;
      }
      if (parseListHeader(line)) break;
      const kv = parseKeyValueLine(line);
      if (!kv) break;
      fields[kv.key] = kv.value;
      i += 1;
    }

    if (Object.keys(fields).length < 2) break;
    records.push({ title, fields });
  }

  if (records.length < 2) return null;

  const keyOrder: string[] = [];
  for (const record of records) {
    for (const key of Object.keys(record.fields)) {
      if (!keyOrder.includes(key)) keyOrder.push(key);
    }
  }
  const usefulKeys = keyOrder.filter((key) => records.filter((r) => r.fields[key]).length >= 2).slice(0, 5);
  if (usefulKeys.length < 2) return null;

  const tableLines = [
    `| 项目 | ${usefulKeys.join(" | ")} |`,
    `| ${["---", ...usefulKeys.map(() => "---")].join(" | ")} |`,
    ...records.map((record) => `| ${record.title} | ${usefulKeys.map((key) => record.fields[key] || "-").join(" | ")} |`),
    "",
  ];

  return { lines: tableLines, nextIndex: i };
}

function preprocessForOdooRichText(text: string): string {
  const normalized = String(text || "").replace(/\r\n/g, "\n").trim();
  if (!normalized) return normalized;

  const src = normalized.split("\n");
  const out: string[] = [];
  let i = 0;
  let injectedTitle = false;

  const titleGuess = guessEmojiTitle(normalized);
  if (titleGuess) {
    out.push(`## ${titleGuess.emoji} ${titleGuess.title}`);
    injectedTitle = true;
  }

  while (i < src.length) {
    const raw = src[i] ?? "";
    const line = raw.trim();

    if (!line) {
      out.push("");
      i += 1;
      continue;
    }

    if (looksLikeDivider(line)) {
      i += 1;
      continue;
    }

    if (injectedTitle && i === 0 && titleGuess && line === titleGuess.title) {
      i += 1;
      continue;
    }

    if (isMarkdownTable(src, i)) {
      out.push(src[i], src[i + 1]);
      i += 2;
      while (i < src.length && /^\|.+\|$/.test(src[i].trim())) {
        out.push(src[i]);
        i += 1;
      }
      out.push("");
      continue;
    }

    const recordTable = tryBuildRecordTable(src, i);
    if (recordTable) {
      out.push(...recordTable.lines);
      i = recordTable.nextIndex;
      continue;
    }

    const kvRows: Array<{ key: string; value: string }> = [];
    let j = i;
    while (j < src.length) {
      const parsed = parseKeyValueLine(src[j]);
      if (!parsed) break;
      kvRows.push(parsed);
      j += 1;
    }
    if (kvRows.length >= 2) {
      out.push("| 字段 | 内容 |", "| --- | --- |");
      for (const row of kvRows) {
        out.push(`| ${row.key} | ${row.value} |`);
      }
      out.push("");
      i = j;
      continue;
    }

    const numbered = line.match(/^(\d+)[.)]\s+(.+)$/);
    if (numbered) {
      out.push(`${numbered[1]}. ${numbered[2]}`);
      i += 1;
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      const body = line.replace(/^[-*]\s+/, "");
      if (!/^(✅|📌|👉|🔹|▫️|•)/.test(body)) {
        out.push(`- 👉 ${body}`);
      } else {
        out.push(`- ${body}`);
      }
      i += 1;
      continue;
    }

    if (/^(接下来|你还可以|下一步|可继续|可执行)/.test(line)) {
      out.push(`### 👉 ${line}`);
      i += 1;
      continue;
    }

    out.push(line);
    i += 1;
  }

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function isMarkdownTable(lines: string[], index: number): boolean {
  if (index + 1 >= lines.length) return false;
  const header = lines[index]?.trim() || "";
  const sep = lines[index + 1]?.trim() || "";
  return /^\|.+\|$/.test(header) && /^\|?[\s:-]+(?:\|[\s:-]+)+\|?$/.test(sep);
}

function parseTableRow(line: string): string[] {
  return line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
}

function markdownTableToHtml(lines: string[], index: number): { html: string; nextIndex: number } {
  const headerCells = parseTableRow(lines[index]);
  let i = index + 2;
  const bodyRows: string[][] = [];
  while (i < lines.length && /^\|.+\|$/.test(lines[i].trim())) {
    bodyRows.push(parseTableRow(lines[i]));
    i += 1;
  }

  const thead = `<tr>${headerCells.map((c) => `<th style=\"padding:10px 12px;border:1px solid #e5e7eb;background:#f8fafc;text-align:left;font-weight:700;white-space:nowrap;\">${formatInlineMarkdown(c)}</th>`).join("")}</tr>`;
  const tbody = bodyRows.map((row, rowIndex) => `<tr style=\"background:${rowIndex % 2 === 0 ? "#ffffff" : "#fbfdff"};\">${row.map((c) => `<td style=\"padding:9px 12px;border:1px solid #e5e7eb;vertical-align:top;\">${formatInlineMarkdown(c)}</td>`).join("")}</tr>`).join("");
  return {
    html: `<div style=\"margin:12px 0 16px 0;overflow-x:auto;border:1px solid #e5e7eb;border-radius:12px;\"><table style=\"border-collapse:collapse;width:100%;font-size:13px;background:#fff;\"><thead>${thead}</thead><tbody>${tbody}</tbody></table></div>`,
    nextIndex: i,
  };
}

function formatOdooRichText(text: string): string {
  const normalized = preprocessForOdooRichText(text);
  if (!normalized) return "<div> </div>";

  const lines = normalized.split("\n");
  const parts: string[] = ["<div class=\"openclaw-rich\" style=\"line-height:1.65;font-size:14px;color:#0f172a;\">"];
  let i = 0;

  while (i < lines.length) {
    const raw = lines[i] ?? "";
    const line = raw.trim();

    if (!line) {
      i += 1;
      continue;
    }

    if (isMarkdownTable(lines, i)) {
      const table = markdownTableToHtml(lines, i);
      parts.push(table.html);
      i = table.nextIndex;
      continue;
    }

    const h3 = line.match(/^###\s+(.+)$/);
    const h2 = line.match(/^##\s+(.+)$/);
    const h1 = line.match(/^#\s+(.+)$/);
    if (h3 || h2 || h1) {
      const textValue = h3?.[1] || h2?.[1] || h1?.[1] || line;
      const size = h1 ? 20 : h2 ? 18 : 16;
      parts.push(`<div style=\"margin:14px 0 10px 0;padding:0 0 6px 0;font-weight:800;font-size:${size}px;border-bottom:1px solid #e5e7eb;letter-spacing:.1px;\">${formatInlineMarkdown(textValue)}</div>`);
      i += 1;
      continue;
    }

    if (/^([-*])\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        i += 1;
      }
      parts.push(`<ul style=\"margin:8px 0 14px 18px;padding:0;\">${items.map((item) => `<li style=\"margin:6px 0;padding-left:2px;\">${formatInlineMarkdown(item)}</li>`).join("")}</ul>`);
      continue;
    }

    if (/^\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ""));
        i += 1;
      }
      parts.push(`<ol style=\"margin:8px 0 14px 20px;padding:0;\">${items.map((item) => `<li style=\"margin:6px 0;padding-left:2px;\">${formatInlineMarkdown(item)}</li>`).join("")}</ol>`);
      continue;
    }

    const block: string[] = [line];
    i += 1;
    while (i < lines.length) {
      const next = (lines[i] || "").trim();
      if (!next || isMarkdownTable(lines, i) || /^#{1,3}\s+/.test(next) || /^[-*]\s+/.test(next) || /^\d+[.)]\s+/.test(next)) break;
      block.push(next);
      i += 1;
    }

    const joined = block.join("<br/>");
    const noticeStyle = block.length === 1 ? getNoticeStyle(block[0]) : null;
    if (noticeStyle) {
      parts.push(`<div style=\"margin:10px 0 14px 0;padding:10px 12px;border-radius:10px;${noticeStyle}\">${formatInlineMarkdown(joined)}</div>`);
    } else {
      parts.push(`<p style=\"margin:8px 0 14px 0;\">${formatInlineMarkdown(joined)}</p>`);
    }
  }

  parts.push("</div>");
  return parts.join("");
}

function cleanOdooBody(html: string): string {
  let text = (html || "").replace(/<[^>]+>/g, " ");
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#\d+;/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.replace(/@?[\w\u4e00-\u9fa5\-_. ]+AI\s*/g, "").trim();
}

function getCfg(api: ClawdbotPluginApi): OdooConfig | null {
  const raw = api.config?.channels?.odoo as MaybeWrappedOdooConfig | undefined;
  const cfg = raw?.odoo?.url ? raw.odoo : raw;
  if (!cfg?.url || !cfg?.botPartnerId) return null;
  if (!cfg.db || !cfg.uid || !cfg.password) return null;
  return cfg as OdooConfig;
}

/* ── Channel plugin definition ── */

let lastMessageId = 0;
let pollingTimer: ReturnType<typeof setInterval> | null = null;

const odooPlugin = {
  id: "odoo",
  meta: {
    id: "odoo",
    label: "Odoo Discuss",
    selectionLabel: "Odoo Discuss (local deploy)",
    docsPath: "/channels/odoo",
    blurb: "Odoo Discuss channel plugin supporting DMs and group channels.",
    aliases: ["odoo", "odoo-discuss"],
  },
  capabilities: {
    chatTypes: ["direct", "group"],
  },
  config: {
    listAccountIds: (cfg: any) => {
      const channelCfg = cfg?.channels?.odoo;
      return channelCfg ? ["default"] : [];
    },
    resolveAccount: (cfg: any, accountId: string) => {
      const channelCfg = cfg?.channels?.odoo;
      return channelCfg ? { accountId, ...(channelCfg.odoo || channelCfg) } : null;
    },
  },
  outbound: {
    deliveryMode: "direct",
    sendText: async ({ text, to }: { text: string; to: string }) => {
      const cfg = getCfg(getOdooRuntime() as any);
      if (!cfg) return { ok: false, error: "Odoo not configured" };

      const match = to.match(/^(?:channel|chat|group):(\d+)$/) ?? to.match(/^(\d+)$/);
      if (!match) return { ok: false, error: `Invalid 'to' format: ${to}` };

      const channelId = parseInt(match[1], 10);
      await sendToChannel(cfg, channelId, text);
      return { ok: true };
    },
  },
};

/* ── Inbound: route to agent session (let the model decide what to do) ── */

async function handleInboundMessage(api: ClawdbotPluginApi, cfg: OdooConfig, msg: OdooMessage) {
  const core = getOdooRuntime();
  const channelId = msg.res_id;
  api.logger?.info(`odoo-channel: handleInbound start messageId=${msg.id} channelId=${channelId ?? "?"}`);
  if (!channelId) return;

  const channels = await odooRpc(cfg, "discuss.channel", "search_read", [[
    ["id", "=", channelId],
  ]], {
    fields: ["id", "name", "channel_type"],
    limit: 1,
  });
  const channel = channels?.[0] as OdooChannel | undefined;
  api.logger?.info(`odoo-channel: fetched channel messageId=${msg.id} found=${channel ? "yes" : "no"}`);
  if (!channel) return;

  const isPrivateChat = channel.channel_type === "chat";
  const mentionsBot = Array.isArray(msg.partner_ids) && msg.partner_ids.includes(cfg.botPartnerId);
  api.logger?.info(`odoo-channel: channel_type=${channel.channel_type ?? "?"} isPrivate=${isPrivateChat} mentionsBot=${mentionsBot}`);
  if (!isPrivateChat && !mentionsBot) return;

  const bodyText = cleanOdooBody(msg.body ?? "");
  api.logger?.info(`odoo-channel: cleaned body messageId=${msg.id} len=${bodyText.length}`);
  if (!bodyText) return;

  const authorId = String(msg.author_id?.[0] ?? "unknown");
  const authorName = msg.author_id?.[1] ?? "Unknown User";
  const peerId = String(channelId);
  const resolvedRoute = core.channel.routing.resolveAgentRoute({
    cfg: api.config,
    channel: "odoo",
    accountId: "default",
    peer: {
      kind: isPrivateChat ? "dm" : "group",
      id: peerId,
    },
    messageText: isPrivateChat ? bodyText : null,
  });
  const agentId = resolvedRoute?.agentId || "main";
  const accountId = resolvedRoute?.accountId || "default";
  const sessionKey = `agent:${agentId}:odoo:${isPrivateChat ? "dm" : "group"}:${peerId}`;
  api.logger?.info(`odoo-channel: HARD ROUTE sessionKey=${sessionKey} agentId=${agentId} peerId=${peerId} private=${isPrivateChat}`);
  const chatType = isPrivateChat ? "direct" : "group";
  const to = isPrivateChat ? `chat:${channelId}` : `channel:${channelId}`;
  const fromLabel = isPrivateChat ? authorName : `${channel.name || `channel-${channelId}`} / ${authorName}`;

  core.system.enqueueSystemEvent(
    isPrivateChat
      ? `Odoo DM from ${authorName}: ${bodyText.slice(0, 160)}`
      : `Odoo message in ${channel.name || channelId} from ${authorName}: ${bodyText.slice(0, 160)}`,
    {
      sessionKey,
      contextKey: `odoo:message:${channelId}:${msg.id}`,
    },
  );
  api.logger?.info(`odoo-channel: system event enqueued messageId=${msg.id}`);

  const body = core.channel.reply.formatInboundEnvelope({
    channel: "Odoo Discuss",
    from: fromLabel,
    timestamp: msg.date ? Date.parse(msg.date) : undefined,
    body: `${bodyText}\n[odoo message id: ${msg.id} channel: ${channelId}]`,
    chatType,
    sender: { name: authorName, id: authorId },
  });
  api.logger?.info(`odoo-channel: inbound envelope built messageId=${msg.id}`);

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: bodyText,
    CommandBody: bodyText,
    From: isPrivateChat ? `odoo:${authorId}` : `odoo:channel:${channelId}`,
    To: to,
    SessionKey: sessionKey,
    AccountId: accountId,
    ChatType: chatType,
    ConversationLabel: fromLabel,
    GroupSubject: !isPrivateChat ? (channel.name || `channel-${channelId}`) : undefined,
    SenderName: authorName,
    SenderId: authorId,
    Provider: "odoo",
    Surface: "odoo",
    MessageSid: String(msg.id),
    Timestamp: msg.date ? Date.parse(msg.date) : undefined,
    WasMentioned: !isPrivateChat ? mentionsBot : undefined,
    OriginatingChannel: "odoo",
    OriginatingTo: to,
  });
  api.logger?.info(`odoo-channel: inbound context finalized messageId=${msg.id}`);

  if (isPrivateChat) {
    const storePath = core.channel.session.resolveStorePath(api.config?.session?.store, {
      agentId: agentId,
    });
    await core.channel.session.updateLastRoute({
      storePath,
      sessionKey,
      deliveryContext: {
        channel: "odoo",
        to,
        accountId: accountId,
      },
    });
    api.logger?.info(`odoo-channel: last route updated messageId=${msg.id}`);
  }

  const textLimit = core.channel.text.resolveTextChunkLimit(api.config, "odoo", "default", {
    fallbackLimit: 4000,
  });
  const chunkMode = core.channel.text.resolveChunkMode(api.config, "odoo", "default");
  const { dispatcher, replyOptions, markDispatchIdle } = core.channel.reply.createReplyDispatcherWithTyping({
    humanDelay: core.channel.reply.resolveHumanDelayConfig(api.config, agentId),
    deliver: async (payload: { text?: string }) => {
      const text = payload.text ?? "";
      api.logger?.info(`odoo-channel: deliver invoked messageId=${msg.id} textLen=${text.length} channelId=${channelId}`);
      const chunks = core.channel.text.chunkMarkdownTextWithMode(text, textLimit, chunkMode);
      for (const chunk of chunks.length > 0 ? chunks : [text]) {
        if (!chunk) continue;
        api.logger?.info(`odoo-channel: sending chunk messageId=${msg.id} chunkLen=${chunk.length}`);
        await sendToChannel(cfg, channelId, formatOdooRichText(chunk), true);
      }
      api.logger?.info(`odoo-channel: delivered reply to ${to}`);
    },
    onError: (err: unknown, info: { kind: string }) => {
      api.logger?.error(`odoo ${info.kind} reply failed: ${String(err)}`);
    },
  });
  api.logger?.info(`odoo-channel: dispatcher created messageId=${msg.id}`);

  await core.channel.reply.dispatchReplyFromConfig({
    ctx: ctxPayload,
    cfg: api.config,
    dispatcher,
    replyOptions,
  });
  api.logger?.info(`odoo-channel: dispatch complete messageId=${msg.id}`);
  markDispatchIdle();
}

/* ── Plugin registration ── */

const plugin = {
  id: "odoo-channel",
  name: "Odoo Discuss",
  description: "Odoo Discuss channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: ClawdbotPluginApi) {
    setOdooRuntime(api.runtime);
    api.registerChannel({ plugin: odooPlugin as any });

    /* Register odoo_api tool - uses legacy JSON-RPC only */
    if (api.registerTool) {
      api.registerTool({
        name: "odoo_api",
        description: "Call any Odoo model method via legacy JSON-RPC. Use for search_read, create, write, unlink, button_confirm, or any other Odoo model method.",
        inputSchema: {
          type: "object",
          required: ["model", "method"],
          properties: {
            model: { type: "string", description: "Odoo model name, e.g. purchase.order, sale.order, res.partner, account.move, product.product" },
            method: { type: "string", description: "Method name, e.g. search_read, create, write, unlink, button_confirm, name_search" },
            args: { type: "array", description: "Positional arguments. For search_read: [domain]. For create: [{ field: value }]. For write: [[ids], { field: value }].", default: [] },
            kwargs: { type: "object", description: "Keyword arguments. For search_read: { fields: [...], limit: N, order: '...' }.", default: {} },
          },
        },
        handler: async ({ model, method, args = [], kwargs = {} }: any) => {
          const cfg = getCfg(api);
          if (!cfg) throw new Error("Odoo not configured - check channels.odoo config");
          const result = await odooRpc(cfg, model, method, args, kwargs);
          return JSON.stringify(result, null, 2);
        },
      });
    }

    /* Polling service */
    api.registerService({
      id: "odoo-poller",
      start: async () => {
        api.logger?.info("odoo-channel: starting polling service");

        const poll = async () => {
          const cfg = getCfg(api);
          if (!cfg) return;

          try {
            if (lastMessageId === 0) {
              const msgs = await odooRpc(cfg, "mail.message", "search_read", [[]], {
                fields: ["id"],
                limit: 1,
                order: "id desc",
              });
              lastMessageId = msgs?.[0]?.id ?? 0;
              api.logger?.info(`odoo-channel: initialized cursor lastMessageId=${lastMessageId}`);
              return;
            }

            const newMsgs = (await odooRpc(
              cfg,
              "mail.message",
              "search_read",
              [[
                ["id", ">", lastMessageId],
                ["model", "=", "discuss.channel"],
                ["message_type", "in", ["comment", "email"]],
              ]],
              {
                fields: ["id", "body", "author_id", "partner_ids", "res_id", "date"],
                order: "id asc",
                limit: 20,
              },
            )) as OdooMessage[];

            if (!newMsgs?.length) return;

            for (const msg of newMsgs) {
              lastMessageId = Math.max(lastMessageId, msg.id);
              if (msg.author_id?.[0] === cfg.botPartnerId) continue;

              api.logger?.info(
                `odoo-channel: new message ch=${msg.res_id ?? "?"} from=${msg.author_id?.[1] ?? "unknown"}: ${cleanOdooBody(msg.body ?? "").slice(0, 80)}`,
              );

              const cleaned = cleanOdooBody(msg.body ?? "");
              const looksLikeBotEcho = (!msg.author_id?.[0] || msg.author_id?.[0] === cfg.botPartnerId)
                && !!cleaned
                && /OpenClaw|我是|我看到了|对，你说得对|这个动作影响比较大|JSON-2/i.test(cleaned);
              if (looksLikeBotEcho) {
                api.logger?.info(`odoo-channel: skipping suspected bot echo messageId=${msg.id}`);
                continue;
              }

              await handleInboundMessage(api, cfg, msg);
            }
          } catch (e: any) {
            api.logger?.error(`odoo-channel polling error: ${e?.stack || e?.message || e}`);
          }
        };

        await poll();
        pollingTimer = setInterval(poll, 3000);
      },
      stop: () => {
        if (pollingTimer) {
          clearInterval(pollingTimer);
          pollingTimer = null;
        }
        api.logger?.info("odoo-channel: polling service stopped");
      },
    });

    api.logger?.info("odoo-channel plugin loaded (legacy RPC + odoo_api tool)");
  },
};

export default plugin;
