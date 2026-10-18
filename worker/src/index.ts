/** The Worker's entry point: wires the handler and the scheduled run to the runtime. The logic is in their modules. */
import { translateWith } from "../../src/lib/clients.ts";
import { remoteKeys } from "./auth.ts";
import { createHandler } from "./handler.ts";
import { runScheduled } from "./scheduled.ts";

// Module scope, so the team's keys are cached across the requests an isolate serves.
const handle = createHandler({
  keys: remoteKeys(),
  translate: (choice, segments, apiKey) => translateWith(choice, segments, apiKey),
  now: () => Date.now(),
});

export default {
  // `env` is checked by the handler (`parseConfig`), not trusted to match `Env`.
  fetch: (request: Request, env: unknown) => handle(request, env),
  /**
   * The Cron Trigger (`triggers.crons` in wrangler.jsonc): the ahead-of-time translation. `env` is checked by
   * `parseScheduledConfig`. A run that fails is logged with a reason code and fails the invocation; one that stops at a
   * cap succeeds, and the next run resumes.
   */
  async scheduled(_controller: ScheduledController, env: unknown): Promise<void> {
    const result = await runScheduled(env, { fetch: (input, init) => fetch(input, init), now: () => Date.now() });
    if (!result.ok) throw new Error("the scheduled run failed");
  },
} satisfies ExportedHandler<Env>;
