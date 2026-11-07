/**
 * Minimal runtime shim for `cloudflare:workers` used when running unit tests in Node/Vitest.
 * In Cloudflare's workerd runtime (`wrangler dev` / `wrangler deploy`), the native built-in
 * `cloudflare:workers` module is used directly.
 */
export class DurableObject<Env = unknown> {
  protected ctx: DurableObjectState;
  protected env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(_request: Request): Promise<Response> {
    return new Response("Not Implemented", { status: 501 });
  }
}
