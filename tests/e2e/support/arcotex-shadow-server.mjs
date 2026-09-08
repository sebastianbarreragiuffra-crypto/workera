import { createServer } from "node:http";
import next from "next";

const hostname = process.env.ARCOTEX_SHADOW_E2E_HOSTNAME ?? "127.0.0.1";
const port = Number(process.env.ARCOTEX_SHADOW_E2E_PORT ?? "3107");
const app = next({
  dev: true,
  dir: process.cwd(),
  hostname,
  port,
  turbopack: true,
});
const sockets = new Set();
let stopping = false;

await app.prepare();

const handleRequest = app.getRequestHandler();
const handleUpgrade = app.getUpgradeHandler();
const server = createServer((request, response) => {
  handleRequest(request, response).catch((error) => {
    console.error("Error en el servidor E2E ARCOTEX:", error);
    if (!response.headersSent) response.writeHead(500);
    response.end();
  });
});

server.on("upgrade", (request, socket, head) => {
  void handleUpgrade(request, socket, head);
});
server.on("connection", (socket) => {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
});

async function shutdown(exitCode = 0) {
  if (stopping) return;
  stopping = true;

  const stopped = new Promise((resolveStopped) => server.close(resolveStopped));
  for (const socket of sockets) socket.destroy();
  await stopped;
  // Next dev conserva handles internos de Turbopack en Windows aun después de
  // cerrar el HTTP server. Le damos tiempo para su cleanup y luego terminamos
  // este proceso dedicado para no dejar Playwright esperando indefinidamente.
  await Promise.race([
    app.close(),
    new Promise((resolveTimeout) => setTimeout(resolveTimeout, 5_000)),
  ]);
  process.disconnect();
  process.exit(exitCode);
}

process.on("message", (message) => {
  if (message === "shutdown") void shutdown();
});
process.once("SIGINT", () => void shutdown(130));
process.once("SIGTERM", () => void shutdown(143));

server.listen(port, hostname, () => process.send?.("ready"));
