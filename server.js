// server.js
// Node.js 18+ (ESM). Express webhook receiver for Bitrix24 BP.
// Поток: приняли вебхук БП -> достали dealId + memberId -> нашли компанию в Postgres
// -> нашли последний чат Открытых линий по сделке -> если чата нет/уже закрыт: ранний выход
// -> если чат есть: закрыли -> лог OK/ОШБ на русском, без дубляжа даты (Railway сам показывает время).

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

const LOG_LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase(); // info | debug
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 8000);

// Bitrix BP обычно шлёт form-urlencoded + иногда массивы
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// ---- DB ----
if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL не задан. Добавь его в Variables сервиса Railway."
  );
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Railway Postgres часто требует SSL
});

// Тест коннекта к БД при старте (можно оставить)
(async () => {
  try {
    const r = await pool.query("SELECT 1 AS ok");
    console.log("[DB] подключено:", r.rows?.[0] || {});
  } catch (e) {
    console.error("[DB] ошибка подключения:", e?.message || e);
    process.exit(1);
  }
})();

// ---- ЛОГГЕР (русский, без даты — Railway сам показывает время слева) ----
function tag(status) {
  const map = {
    OK: chalk.green("OK "),
    ERROR: chalk.red("ОШБ"),
    WARN: chalk.yellow("ВНМ"),
    INFO: chalk.cyan("ИНФ"),
  };
  return map[status] || status;
}

function formatMeta(meta = {}) {
  const order = ["requestId", "dealId", "chatId", "memberId", "ip", "path"];
  const parts = [];

  for (const key of order) {
    if (meta[key] != null && meta[key] !== "")
      parts.push(`${key}=${meta[key]}`);
  }
  for (const [k, v] of Object.entries(meta)) {
    if (order.includes(k)) continue;
    if (v == null || v === "") continue;
    parts.push(`${k}=${v}`);
  }

  return parts.length ? " | " + parts.join(" ") : "";
}

function log({ company = "СИСТЕМА", status = "INFO", message, meta = {} }) {
  console.log(
    `${chalk.cyan(`[${company}]`)} ${tag(status)} ${message}${formatMeta(meta)}`
  );
}

function logDebug(label, data) {
  if (LOG_LEVEL !== "debug") return;
  console.log(chalk.gray(`  ↳ ${label}:`));
  console.log(chalk.gray(JSON.stringify(data, null, 2)));
}

// ---- HELPERS ----
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
  // 1) из query: ?deal_id=475509
  const q = query?.deal_id;
  if (q && /^\d+$/.test(String(q))) return String(q);

  // 2) из body.document_id: ["crm","CCrmDocumentDeal","DEAL_475509"]
  const doc = body?.document_id;
  if (Array.isArray(doc) && typeof doc[2] === "string") {
    const m = doc[2].match(/DEAL_(\d+)/);
    if (m) return m[1];
  }

  return null;
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
    throw new Error("bitrix_webhook_url пустой или некорректный");
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

// ---- OpenLines: найти последний чат и закрыть ----
async function getLastOpenlinesChatIdForDeal(company, dealId) {
  const id = Number(dealId);
  if (!Number.isFinite(id)) {
    return { chatId: null, reason: "Некорректный ID сделки" };
  }

  try {
    // По документации Bitrix:
    // CRM_ENTITY_TYPE = DEAL, CRM_ENTITY = <число>
    const chatId = await bx(company, "imopenlines.crm.chat.getLastId", {
      CRM_ENTITY_TYPE: "DEAL",
      CRM_ENTITY: id,
    });

    if (!chatId || Number(chatId) <= 0) {
      return { chatId: null, reason: "Активный чат не найден" };
    }

    return { chatId: String(chatId), reason: null };
  } catch (e) {
    const msg = String(e?.message || "");

    // Нормальная ситуация — у сущности нет чата OL
    if (msg.includes("Could not find CRM entity")) {
      return { chatId: null, reason: "Активный чат не найден" };
    }

    // Любая другая ошибка — реальная ошибка интеграции
    throw e;
  }
}

async function finishOpenlinesChatIfAny(company, dealId) {
  const { chatId, reason } = await getLastOpenlinesChatIdForDeal(
    company,
    dealId
  );

  // РАННИЙ ВЫХОД — чат не найден / уже закрыт
  if (!chatId) {
    return { found: false, finished: false, chatId: null, reason };
  }

  // Закрываем чат
  await bx(company, "imopenlines.operator.another.finish", { CHAT_ID: chatId });
  return { found: true, finished: true, chatId, reason: null };
}

// ---- health endpoints ----
app.get("/", (_req, res) => res.status(200).send("OK"));
app.get("/healthz", (_req, res) => res.status(200).send("OK"));

// ---- Bitrix BP webhook endpoint ----
app.post("/", (req, res) => {
  // Bitrix любит быстрый 200
  res.sendStatus(200);

  (async () => {
    const requestId = req.headers["x-railway-request-id"];
    const ip = getIp(req);
    const query = req.query || {};
    const body = req.body || {};

    const dealId = extractDealId({ query, body });
    const memberId = body?.auth?.member_id ? String(body.auth.member_id) : null;

    // Лог входящего вебхука (компания ещё неизвестна — пишем "СИСТЕМА")
    log({
      company: "СИСТЕМА",
      status: "INFO",
      message: "Получен вебхук бизнес-процесса",
      meta: { requestId, ip, dealId, memberId, path: req.originalUrl },
    });

    // Детали — только в debug
    logDebug(
      "Заголовки",
      pick(req.headers, [
        "user-agent",
        "content-type",
        "x-forwarded-for",
        "x-real-ip",
      ])
    );
    logDebug("Query", query);
    logDebug("Body", body);

    let companyName = "СИСТЕМА";

    try {
      // Ранние проверки (дешёвые)
      if (!dealId) {
        log({
          company: companyName,
          status: "WARN",
          message: "ID сделки не найден — пропускаем",
          meta: { requestId, ip, memberId },
        });
        return;
      }

      if (!memberId) {
        log({
          company: companyName,
          status: "WARN",
          message: "member_id не найден в auth — пропускаем",
          meta: { requestId, ip, dealId },
        });
        return;
      }

      // 1) Ищем компанию в БД
      const company = await getCompanyByMemberId(memberId);

      if (!company) {
        log({
          company: companyName,
          status: "WARN",
          message: "Компания не найдена в базе — пропускаем",
          meta: { requestId, dealId, memberId },
        });
        return;
      }

      companyName = company.name || "КОМПАНИЯ";

      if (!company.enabled) {
        log({
          company: companyName,
          status: "WARN",
          message: "Компания отключена (enabled=false) — пропускаем",
          meta: { requestId, dealId, memberId, companyId: company.id },
        });
        return;
      }

      if (!company.bitrix_webhook_url) {
        log({
          company: companyName,
          status: "ERROR",
          message: "В базе не заполнен bitrix_webhook_url — остановка",
          meta: { requestId, dealId, companyId: company.id },
        });
        return;
      }

      // 2) Пытаемся закрыть чат OL (или выходим раньше)
      log({
        company: companyName,
        status: "INFO",
        message: "Пробуем закрыть чат открытых линий по сделке",
        meta: { requestId, dealId },
      });

      const r = await finishOpenlinesChatIfAny(company, dealId);

      if (!r.found) {
        log({
          company: companyName,
          status: "OK",
          message: "Активный чат не найден — завершаем без действий",
          meta: { requestId, dealId, reason: r.reason },
        });
        return;
      }

      log({
        company: companyName,
        status: "OK",
        message: "Чат открытых линий успешно закрыт",
        meta: { requestId, dealId, chatId: r.chatId },
      });
    } catch (e) {
      log({
        company: companyName,
        status: "ERROR",
        message: "Ошибка при обработке вебхука",
        meta: { requestId, dealId, memberId },
      });
      logDebug("Детали ошибки", { error: e?.message, stack: e?.stack });
    }
  })();
});

// ---- start server ----
const server = app.listen(PORT, "0.0.0.0", () => {
  log({
    company: "СИСТЕМА",
    status: "INFO",
    message: "Сервер запущен",
    meta: { port: String(PORT), node: process.version },
  });
});

process.on("SIGTERM", () => {
  log({
    company: "СИСТЕМА",
    status: "WARN",
    message: "Получен SIGTERM — корректно завершаем работу",
  });
  server.close(() => process.exit(0));
});
