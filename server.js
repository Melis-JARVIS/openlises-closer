import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

app.get("/", (_req, res) => res.status(200).send("OK"));
app.get("/healthz", (_req, res) => res.status(200).send("OK"));

app.all("*", (req, res) => {
  res.status(200).send("OK");

  const log = {
    time: new Date().toISOString(),
    method: req.method,
    path: req.originalUrl,
    ip: req.headers["x-forwarded-for"] || req.socket?.remoteAddress || req.ip,
    headers: req.headers,
    query: req.query,
    body: req.body,
  };

  console.log("===== INCOMING REQUEST =====");
  console.log(JSON.stringify(log, null, 2));
  console.log("============================");
});

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`Logger server listening on http://0.0.0.0:${PORT}`);
});

process.on("SIGTERM", () => {
  console.log("SIGTERM received, closing server...");
  server.close(() => {
    console.log("Server closed");
    process.exit(0);
  });
});
