declare module "cloudflare:workers" {
  export class DurableObject<Env = unknown> {
    protected ctx: DurableObjectState;
    protected env: Env;
    constructor(ctx: DurableObjectState, env: Env);
    fetch(request: Request): Promise<Response> | Response;
    alarm?(): Promise<void> | void;
    webSocketMessage?(ws: WebSocket, message: string | ArrayBuffer): Promise<void> | void;
    webSocketClose?(
      ws: WebSocket,
      code: number,
      reason: string,
      wasClean: boolean,
    ): Promise<void> | void;
    webSocketError?(ws: WebSocket, error: unknown): Promise<void> | void;
  }
}
