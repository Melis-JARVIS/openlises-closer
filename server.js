import express from "express";
import chalk from "chalk";

const app = express();
const PORT = process.env.PORT || 3000;

const COMPANY = process.env.COMPANY_NAME || "JARVIS";
const LOG_LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase();

// parse body from Bitrix BP webhook
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// helpers
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
  // status: OK | ERROR | WARN | INFO
  const map = {
    OK: chalk.bgGreen.black(" OK "),
    ERROR: chalk.bgRed.white(" ERROR "),
    WARN: chalk.bgYellow.black(" WARN "),
    INFO: chalk.bgBlue.white(" INFO "),
  };
  return map[status] || chalk.bgGray.white(` ${status} `);
}

function logBlock({ status = "INFO", title, meta = {}, details = null }) {
  const prefix =
    chalk.gray(`[${nowIso()}]`) +
    " " +
    chalk.cyan(`[${COMPANY}]`) +
    " " +
    statusBadge(status);
  console.log(`${prefix} ${title}`);

  // краткий мета-блок (1–2 строки)
  if (Object.keys(meta).length) {
    console.log(chalk.gray("  ├─ meta:"), JSON.stringify(meta));
  }

  // подробности (по желанию)
  if (details && (LOG_LEVEL === "debug" || status === "ERROR")) {
    console.log(chalk.gray("  └─ details:"));
    console.log(chalk.gray(JSON.stringify(details, null, 2)));
  }

  console.log(chalk.gray("—".repeat(72)));
}

// health
app.get("/", (_req, res) => res.status(200).send("OK"));
app.get("/healthz", (_req, res) => res.status(200).send("OK"));

// основной обработчик БП
app.post("/", (req, res) => {
  // отвечаем сразу
  res.sendStatus(200);

  const requestId = req.headers["x-railway-request-id"];
  const ip = getIp(req);

  const query = req.query || {};
  const body = req.body || {};

  const dealId = extractDealId({ query, body });

  try {
    // пример проверки токена (если захочешь)
    // const token = String(query.token || body.token || "");
    // if (process.env.BP_TOKEN && token !== process.env.BP_TOKEN) {
    //   logBlock({
    //     status: "WARN",
    //     title: `BP webhook ignored (invalid token)`,
    //     meta: { requestId, ip, dealId },
    //   });
    //   return;
    // }

    logBlock({
      status: "OK",
      title: `BP webhook received`,
      meta: {
        requestId,
        ip,
        method: req.method,
        path: req.originalUrl,
        dealId,
        contentType: req.headers["content-type"],
      },
      details: {
        query,
        body,
        headers: pick(req.headers, [
          "user-agent",
          "x-forwarded-for",
          "x-real-ip",
          "x-forwarded-proto",
          "x-forwarded-host",
          "host",
        ]),
      },
    });

    // тут позже будет логика действий (закрыть чат и т.д.)
    // если действие ок:
    // logBlock({ status:"OK", title:"OpenLines chat closed", meta:{ requestId, dealId, chatId } })
    // если ошибка:
    // logBlock({ status:"ERROR", title:"OpenLines close failed", meta:{ requestId, dealId }, details:{ error: e.message } })
  } catch (e) {
    logBlock({
      status: "ERROR",
      title: `BP webhook handler failed`,
      meta: { requestId, ip, dealId },
      details: { error: e?.message, stack: e?.stack, query, body },
    });
  }
});

const server = app.listen(PORT, "0.0.0.0", () => {
  logBlock({
    status: "INFO",
    title: `Server started`,
    meta: { port: PORT, node: process.version },
  });
});

process.on("SIGTERM", () => {
  logBlock({ status: "WARN", title: "SIGTERM received, shutting down..." });
  server.close(() => process.exit(0));
});
