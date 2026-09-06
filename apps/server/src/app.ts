import Fastify, { type FastifyInstance } from "fastify";
import type { EditorialService } from "@siftera/core";

export interface ServerDependencies {
  editorial: EditorialService;
}
/** M1 only exposes liveness; application routes wait for verified Firebase identity in M2. */
export function createServer(
  _dependencies: ServerDependencies,
): FastifyInstance {
  void _dependencies;
  const app = Fastify({ logger: false });
  app.get("/healthz", async () => ({ status: "ok" }));
  return app;
}
