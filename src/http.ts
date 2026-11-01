import { createServer } from "node:http";
import type { Server } from "node:http";

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
          (error: Error) => response.writeHead(500, { "content-type": "text/plain" }).end(`${error.message}\n`),
        );
      return;
    }
    response.writeHead(404).end();
  });
}
