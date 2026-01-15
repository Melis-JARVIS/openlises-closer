import express from "express";
import chalk from "chalk";
import pg from "pg";
process.on("unhandledRejection", (err) => {
  console.error("[FATAL] unhandledRejection:", err);
});

process.on("uncaughtException", (err) => {
  console.error("[FATAL] uncaughtException:", err);
});

const { Pool } = pg;

const app = express();
const PORT = process.env.PORT || 3000;

const LOG_LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase();

// parse body from Bitrix BP webhook
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// --- DB ---
if (!process.env.DATABASE_URL) {
  console.warn(
    "[warn] DATABASE_URL is not set. Add Postgres plugin in Railway or set DATABASE_URL variable."
  );
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Railway обычно требует SSL
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : undefined,
});

// --- helpers ---
const nowIso = () => new Date().toISOString();

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj?.[k] != null) out[k] = obj[k];
  return out;
}

function getIp(req) {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.headers["x-real-ip"] ||
    req.socket?.remoteAddress ||
    req.ip
  );
}

function extractDealId({ query, body }) {
  // 1) from query: ?deal_id=475509
  const q = query?.deal_id;
  if (q && /^\d+$/.test(String(q))) return String(q);

  // 2) from body.document_id: ["crm","CCrmDocumentDeal","DEAL_475509"]
  const doc = body?.document_id;
  if (Array.isArray(doc) && typeof doc[2] === "string") {
    const m = doc[2].match(/DEAL_(\d+)/);
    if (m) return m[1];
  }

  return null;
}

function statusBadge(status) {
  const map = {
    OK: chalk.bgGreen.black(" OK "),
    ERROR: chalk.bgRed.white(" ERROR "),
    WARN: chalk.bgYellow.black(" WARN "),
    INFO: chalk.bgBlue.white(" INFO "),
  };
  return map[status] || chalk.bgGray.white(` ${status} `);
}

function logBlock({
  companyName = "JARVIS",
  status = "INFO",
  title,
  meta = {},
  details = null,
}) {
  const prefix =
    chalk.gray(`[${nowIso()}]`) +
    " " +
    chalk.cyan(`[${companyName}]`) +
    " " +
    statusBadge(status);
  console.log(`${prefix} ${title}`);

  if (Object.keys(meta).length) {
    console.log(chalk.gray("  ├─ meta:"), JSON.stringify(meta));
  }

  if (details && (LOG_LEVEL === "debug" || status === "ERROR")) {
    console.log(chalk.gray("  └─ details:"));
    console.log(chalk.gray(JSON.stringify(details, null, 2)));
  }

  console.log(chalk.gray("—".repeat(72)));
}

// --- Bitrix REST via webhook url ---
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 8000);

async function bx(
  company,
  method,
  params = {},
  { timeoutMs = REQUEST_TIMEOUT_MS } = {}
) {
  const base = String(company.bitrix_webhook_url || "").replace(/\/?$/, "/");
  if (!base.startsWith("http"))
    throw new Error("bitrix_webhook_url is empty/invalid");

  const url = `${base}${method}`;

  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    body.append(k, typeof v === "string" ? v : String(v));
  }

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: ac.signal,
    });

    const json = await res.json().catch(() => ({}));

    if (!res.ok || json.error) {
      const m =
        json.error_description ||
        json.error ||
        res.statusText ||
        "Unknown error";
      throw new Error(`${method} → ${m}`);
    }
    return json.result;
  } finally {
    clearTimeout(t);
  }
}

async function getCompanyByMemberId(memberId) {
  const { rows } = await pool.query(
    `SELECT id, name, member_id, bitrix_webhook_url, enabled
     FROM companies
     WHERE member_id = $1
     LIMIT 1`,
    [memberId]
  );
  return rows[0] || null;
}

async function finishOpenlinesChatIfAny(company, dealId) {
  // 1) найти последний чат по сделке
  const chatId = await bx(company, "imopenlines.crm.chat.getLastId", {
    CRM_ENTITY_TYPE: "DEAL",
    CRM_ENTITY: String(dealId),
  });

  if (!chatId || Number(chatId) <= 0) {
    return { found: false, finished: false, chatId: chatId ?? null };
  }

  // 2) закрыть чат
  await bx(company, "imopenlines.operator.another.finish", {
    CHAT_ID: String(chatId),
  });
  return { found: true, finished: true, chatId: String(chatId) };
}

// --- health ---
app.get("/", (_req, res) => res.status(200).send("OK"));
app.get("/healthz", (_req, res) => res.status(200).send("OK"));

// --- webhook handler ---
app.post("/", (req, res) => {
  // отвечаем сразу (Битрикс любит быстрый 200)
  res.sendStatus(200);

  (async () => {
    const requestId = req.headers["x-railway-request-id"];
    const ip = getIp(req);
    const query = req.query || {};
    const body = req.body || {};

    const dealId = extractDealId({ query, body });

    // из Bitrix BP обычно приходит auth.member_id
    const memberId = body?.auth?.member_id ? String(body.auth.member_id) : null;

    // Лог-заголовок (ещё без имени компании)
    logBlock({
      companyName: "JARVIS",
      status: "INFO",
      title: "BP webhook received (raw)",
      meta: { requestId, ip, dealId, memberId, path: req.originalUrl },
      details: {
        query,
        body,
        headers: pick(req.headers, [
          "user-agent",
          "x-forwarded-for",
          "x-real-ip",
          "content-type",
        ]),
      },
    });

    try {
      if (!dealId) {
        logBlock({
          companyName: "JARVIS",
          status: "WARN",
          title: "dealId not found, ignore",
          meta: { requestId, ip, memberId },
        });
        return;
      }

      if (!memberId) {
        logBlock({
          companyName: "JARVIS",
          status: "WARN",
          title: "member_id not found in body.auth, ignore",
          meta: { requestId, ip, dealId },
        });
        return;
      }

      const company = await getCompanyByMemberId(memberId);

      if (!company) {
        logBlock({
          companyName: "JARVIS",
          status: "WARN",
          title: "Company not found in DB, ignore",
          meta: { requestId, memberId, dealId },
        });
        return;
      }

      if (!company.enabled) {
        logBlock({
          companyName: company.name,
          status: "WARN",
          title: "Company disabled, ignore",
          meta: { requestId, memberId, dealId },
        });
        return;
      }

      if (!company.bitrix_webhook_url) {
        logBlock({
          companyName: company.name,
          status: "ERROR",
          title: "bitrix_webhook_url is NULL/empty in DB",
          meta: { requestId, memberId, dealId, companyId: company.id },
        });
        return;
      }

      // Закрываем чат (если есть)
      logBlock({
        companyName: company.name,
        status: "INFO",
        title: "Trying to close OpenLines chat for deal",
        meta: { requestId, dealId },
      });

      const r = await finishOpenlinesChatIfAny(company, dealId);

      if (!r.found) {
        logBlock({
          companyName: company.name,
          status: "WARN",
          title: "OpenLines chat not found for deal",
          meta: { requestId, dealId, chatId: r.chatId },
        });
        return;
      }

      logBlock({
        companyName: company.name,
        status: "OK",
        title: "OpenLines chat closed",
        meta: { requestId, dealId, chatId: r.chatId },
      });
    } catch (e) {
      logBlock({
        companyName: "JARVIS",
        status: "ERROR",
        title: "Handler failed",
        meta: { requestId, dealId, memberId },
        details: { error: e?.message, stack: e?.stack },
      });
    }
  })();
});

const server = app.listen(PORT, "0.0.0.0", () => {
  logBlock({
    companyName: "JARVIS",
    status: "INFO",
    title: "Server started",
    meta: { port: PORT, node: process.version },
  });
});

process.on("SIGTERM", () => {
  logBlock({
    companyName: "JARVIS",
    status: "WARN",
    title: "SIGTERM received, shutting down...",
  });
  server.close(() => process.exit(0));
});
