// server.js
// Node.js 18+ (ESM). Express webhook receiver for Bitrix24 BP.
// Flow: receive BP webhook -> extract dealId + memberId -> lookup company in Postgres
// -> find last OpenLines chat for deal (cheap) -> if none: exit early -> else close chat.
// Logs: colored OK/WARN/ERROR with company name.

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
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 8000);

// Parse Bitrix BP webhook payloads (usually x-www-form-urlencoded + some arrays)
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// ---- DB ----
if (!process.env.DATABASE_URL) {
  // Fail fast: without DB we can't map member_id -> company -> bitrix webhook url
  throw new Error(
    "DATABASE_URL is not set. Add it in Railway service Variables."
  );
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Railway Postgres commonly needs SSL
  ssl: { rejectUnauthorized: false },
});

// Optional: quick DB connectivity check at boot (helps debugging)
(async () => {
  try {
    const r = await pool.query("SELECT 1 AS ok");
    console.log("[DB] connected:", r.rows?.[0] || {});
  } catch (e) {
    console.error("[DB] connect failed:", e?.message || e);
    process.exit(1);
  }
})();

// ---- helpers ----
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

// ---- DB queries ----
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

// ---- Bitrix REST via webhook url ----
async function bx(
  company,
  method,
  params = {},
  { timeoutMs = REQUEST_TIMEOUT_MS } = {}
) {
  const base = String(company?.bitrix_webhook_url || "").replace(/\/?$/, "/");
  if (!base || !base.startsWith("http")) {
    throw new Error("bitrix_webhook_url is empty/invalid");
  }

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

function isCouldNotFindCrmEntityError(err) {
  const msg = String(err?.message || "");
  return msg.includes("Could not find CRM entity");
}

/**
 * Finds last OpenLines chatId linked to a deal. Tries multiple entity formats
 * because Bitrix portals can store CRM bindings differently.
 */
async function getLastOpenlinesChatIdForDeal(company, dealId) {
  const id = Number(dealId);
  if (!Number.isFinite(id)) {
    return { chatId: null, reason: "invalid dealId" };
  }

  try {
    const chatId = await bx(company, "imopenlines.crm.chat.getLastId", {
      CRM_ENTITY_TYPE: "DEAL",
      CRM_ENTITY: id, // ✅ строго число
    });

    if (!chatId || Number(chatId) <= 0) {
      return { chatId: null, reason: "no chat" };
    }

    return { chatId: String(chatId) };
  } catch (e) {
    const msg = String(e?.message || "");

    // ❗ нормальная ситуация — просто нет чата
    if (msg.includes("Could not find CRM entity")) {
      return { chatId: null, reason: "no chat" };
    }

    // ❌ реальная ошибка
    throw e;
  }
}

/**
 * Close last OpenLines chat if exists.
 * EARLY EXIT: if no chat -> returns found=false quickly (no extra CRM calls).
 */
async function finishOpenlinesChatIfAny(company, dealId) {
  const { chatId, tried } = await getLastOpenlinesChatIdForDeal(
    company,
    dealId
  );

  if (!chatId) {
    return { found: false, finished: false, chatId: null, tried };
  }

  await bx(company, "imopenlines.operator.another.finish", { CHAT_ID: chatId });
  return { found: true, finished: true, chatId, tried };
}

// ---- health endpoints ----
app.get("/", (_req, res) => res.status(200).send("OK"));
app.get("/healthz", (_req, res) => res.status(200).send("OK"));

// ---- Bitrix BP webhook endpoint ----
app.post("/", (req, res) => {
  // Reply immediately to Bitrix
  res.sendStatus(200);

  (async () => {
    const requestId = req.headers["x-railway-request-id"];
    const ip = getIp(req);
    const query = req.query || {};
    const body = req.body || {};

    const dealId = extractDealId({ query, body });
    const memberId = body?.auth?.member_id ? String(body.auth.member_id) : null;

    // Raw incoming log
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
      // Early validations (cheap)
      if (!dealId) {
        logBlock({
          companyName: "JARVIS",
          status: "WARN",
          title: "dealId not found, skip",
          meta: { requestId, ip, memberId },
        });
        return;
      }

      if (!memberId) {
        logBlock({
          companyName: "JARVIS",
          status: "WARN",
          title: "member_id not found in body.auth, skip",
          meta: { requestId, ip, dealId },
        });
        return;
      }

      // Company lookup (DB)
      const company = await getCompanyByMemberId(memberId);

      if (!company) {
        logBlock({
          companyName: "JARVIS",
          status: "WARN",
          title: "Company not found in DB, skip",
          meta: { requestId, memberId, dealId },
        });
        return;
      }

      if (!company.enabled) {
        logBlock({
          companyName: company.name,
          status: "WARN",
          title: "Company disabled, skip",
          meta: { requestId, memberId, dealId, companyId: company.id },
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

      // EARLY EXIT PATH: check if there is a chat and close it; if no chat, stop.
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
          status: "OK",
          title: "No active OpenLines chat for deal (skip early)",
          meta: { requestId, dealId, tried: r.tried },
        });
        return;
      }

      logBlock({
        companyName: company.name,
        status: "OK",
        title: "OpenLines chat closed",
        meta: { requestId, dealId, chatId: r.chatId, tried: r.tried },
      });
    } catch (e) {
      // Prefer company name if we already have it, otherwise JARVIS
      const companyNameGuess = "JARVIS";
      logBlock({
        companyName: companyNameGuess,
        status: "ERROR",
        title: "Handler failed",
        meta: { requestId, dealId, memberId },
        details: { error: e?.message, stack: e?.stack },
      });
    }
  })();
});

// ---- start server ----
const server = app.listen(PORT, "0.0.0.0", () => {
  logBlock({
    companyName: "JARVIS",
    status: "INFO",
    title: "Server started",
    meta: { port: String(PORT), node: process.version },
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
