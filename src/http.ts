import { createServer } from "node:http";
import type { Server } from "node:http";

/** Why a status server can't take its address. Capture doesn't need the endpoint, so these only cost the endpoint. */
const BIND_FAILURES: ReadonlySet<string> = new Set(["EADDRINUSE", "EADDRNOTAVAIL", "EACCES"]);

/** Starts listening. A port someone else holds is reported, and capture carries on without the endpoint. */
export function listenForStatus(server: Server, port: number, bind: string, log: (message: string) => void): void {
  server.on("error", (error: NodeJS.ErrnoException) => {
    if (!BIND_FAILURES.has(error.code ?? "")) throw error;
    log(`the status endpoint isn't available on ${bind}:${port} (${error.code}), and capture carries on without it. Change http.port, or stop whatever holds it, then restart.`);
  });
  server.listen(port, bind);
}

/**
 * The private status endpoint. /healthz says only that this process is alive. Whether frames are arriving is /status's job.
 * A report that fails answers 500 and nothing more: a monitoring request must never be able to take the service down.
 */
export function createStatusServer(report: () => Promise<unknown>): Server {
  return createServer((request, response) => {
    if (request.url === "/healthz") {
      response.writeHead(200, { "content-type": "text/plain" }).end("alive\n");
      return;
    }
    if (request.url === "/status") {
      report()
        .then((status) => `${JSON.stringify(status, null, 2)}\n`)
        .then(
          (body) => response.writeHead(200, { "content-type": "application/json" }).end(body),
          // outer-boundary-process-contract: a monitor reads a non-200 as this report failing. This emits that 500 with the
          // reason. Letting any error propagate would be an unhandled rejection, which ends the process and stops captures.
          (error: Error) => response.writeHead(500, { "content-type": "text/plain" }).end(`${error.message}\n`),
        );
      return;
    }
    response.writeHead(404).end();
  });
}
