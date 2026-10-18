/** The Worker's entry point: wires the handler to the runtime. The logic is in `handler.ts`. */
import { remoteKeys } from "./auth.ts";
import { createHandler } from "./handler.ts";

// Module scope, so the team's keys are cached across the requests an isolate serves.
const handle = createHandler({ keys: remoteKeys() });

export default {
  // `env` is checked by the handler (`parseConfig`), not trusted to match `Env`.
  fetch: (request: Request, env: unknown) => handle(request, env),
} satisfies ExportedHandler<Env>;
