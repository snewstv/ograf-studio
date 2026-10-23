/**
 * Per-token MCP gateway (Durable Object).
 *
 * - `POST` (JSON-RPC, MCP Streamable HTTP, single-response mode): `initialize`,
 *   `ping`, `tools/list`, `tools/call`. `tools/call` for `ograf_get_capabilities`
 *   answers inline; everything else forwards to the owner's connected editor tab
 *   over the tab WebSocket. No tab → JSON-RPC `-32001` ("open the editor tab").
 * - `GET` with `Upgrade: websocket` (`/bridge?token=`): tab session socket.
 *   One authoritative tab per token; a newer tab replaces the older one.
 * - Auth: Souv Bearer (POST) or `?token=` (bridge). Verified via `auth.ts`;
 *   the stub name is the token hash, so sessions isolate per login.
 *
 * Local-first notes: classic (non-hibernating) sockets + in-memory pending
 * calls are enough for `wrangler dev --local`. Production follow-ups (not
 * implemented): hibernation API, R2-backed captures, rate limits.
 *
 * NOTE: the tab token travels in the bridge query string (browsers cannot set
 * headers on WebSocket upgrades) and may appear in access logs — prefer
 * short-lived Souv tokens for gateway use.
 */
import type { MCPToolName } from './catalog';
import { NO_TAB_MESSAGE, respondToMessage } from './mcpRouter';
import { bearerToken, sha256Hex, verifySouvToken } from './auth';

const TOOL_CALL_TIMEOUT_MS = 25_000;
const VERIFY_POSITIVE_TTL_MS = 5 * 60 * 1000;
const VERIFY_NEGATIVE_TTL_MS = 60 * 1000;

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Env {
  SOUV_API?: string;
}

export class GatewayDO {
  readonly #pending = new Map<string, PendingCall>();
  #tab: WebSocket | null = null;

  /**
   * Token-check cache scoped to this login's stub (one stub per token
   * hash): a single Souv introspection per TTL no matter how many worker
   * isolates forward here — this is what keeps deploys (cold isolates)
   * from bursting the Souv API. Lost on DO eviction (safe direction:
   * re-verify on next call).
   */
  readonly #verified = new Map<string, { ok: boolean; exp: number }>();

  constructor(
    _state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.headers.get('Upgrade') === 'websocket') {
      return this.#acceptBridge(url);
    }
    // Internal tab-tool bridge for the worker AI chat route (OG-091).
    // Same per-login isolation as MCP: the worker routes by token+tabId
    // stub, and calls fan out to that tab with the same timeout semantics
    // as `tools/call`.
    if (url.pathname === '/internal/tool-call') {
      if (request.method !== 'POST') {
        return Response.json(
          { ok: false, error: 'Method not allowed. Use POST.' },
          { status: 405 },
        );
      }
      const token = bearerToken(request);
      if (!(await this.#valid(token))) {
        return Response.json(
          { ok: false, error: 'Missing or invalid Souv token.' },
          { status: 401 },
        );
      }
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return Response.json({ ok: false, error: 'Parse error' }, { status: 400 });
      }
      const record = (body ?? {}) as { name?: unknown; args?: unknown };
      if (typeof record.name !== 'string' || !record.name) {
        return Response.json({ ok: false, error: 'Missing tool name.' }, { status: 400 });
      }
      if (record.args !== undefined && (typeof record.args !== 'object' || record.args === null)) {
        // Report only the received kind, never the value (args may carry
        // project content).
        const received = record.args === null ? 'null' : typeof record.args;
        return Response.json(
          { ok: false, error: 'Tool args must be an object (received ' + received + ').' },
          { status: 400 },
        );
      }
      try {
        const result = await this.#callTab(
          record.name as MCPToolName,
          (record.args ?? {}) as Record<string, unknown>,
        );
        return Response.json({ ok: true, result: result });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const noTab = message === NO_TAB_MESSAGE;
        return Response.json(
          { ok: false, error: message, noTab: noTab },
          { status: noTab ? 409 : 500 },
        );
      }
    }
    if (request.method !== 'POST') {
      return Response.json({ error: 'Method not allowed. Use POST for MCP.' }, { status: 405 });
    }
    const token = bearerToken(request);
    if (!(await this.#valid(token))) {
      return Response.json(
        { error: 'Missing or invalid Souv token. Log in and send Authorization: Bearer <token>.' },
        { status: 401 },
      );
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json(
        { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
        { status: 400 },
      );
    }
    const messages = Array.isArray(body) ? body : [body];
    // Dispatch concurrently so one slow tab call doesn't stall the rest of the
    // batch; replies reassemble in request order.
    const replies = (
      await Promise.all(messages.map((message) => this.#handleMessage(message)))
    ).filter((reply) => reply !== undefined);
    if (replies.length === 0) return new Response(null, { status: 202 });
    return Response.json(Array.isArray(body) ? replies : replies[0], {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  async #valid(token: string | null): Promise<boolean> {
    if (!token) return false;
    const hash = await sha256Hex(token);
    const hit = this.#verified.get(hash);
    if (hit && hit.exp > Date.now()) return hit.ok;
    const ok = (await verifySouvToken(this.env as Record<string, unknown>, token)) !== null;
    this.#verified.set(hash, {
      ok,
      exp: Date.now() + (ok ? VERIFY_POSITIVE_TTL_MS : VERIFY_NEGATIVE_TTL_MS),
    });
    return ok;
  }

  async #acceptBridge(url: URL): Promise<Response> {
    const token = url.searchParams.get('token') ?? '';
    if (!(await this.#valid(token))) {
      return new Response('Missing or invalid Souv token.', { status: 401 });
    }
    const pair = new WebSocketPair();
    const client = pair[0]!;
    const server = pair[1]!;
    server.accept();
    server.addEventListener('message', (event) => {
      void this.#onTabMessage(event);
    });
    const closePrevious = () => {
      if (this.#tab && this.#tab !== server) {
        try {
          this.#tab.send(JSON.stringify({ type: 'bridge.replaced' }));
          this.#tab.close(1000, 'Replaced by a newer editor tab');
        } catch {
          // Already gone.
        }
      }
    };
    server.addEventListener(
      'close',
      () => {
        if (this.#tab === server) {
          this.#tab = null;
          for (const [callId, pending] of this.#pending) {
            clearTimeout(pending.timer);
            pending.reject(new Error('The editor tab disconnected during the tool call.'));
            this.#pending.delete(callId);
          }
        }
      },
      { once: true },
    );
    closePrevious();
    this.#tab = server;
    return new Response(null, { status: 101, webSocket: client });
  }

  async #onTabMessage(event: MessageEvent): Promise<void> {
    let message: { type?: string; callId?: string; ok?: boolean; result?: unknown; error?: string };
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (!message || typeof message !== 'object') return;
    if (message.type !== 'tool.result' || !message.callId) return;
    const pending = this.#pending.get(message.callId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.#pending.delete(message.callId);
    if (message.ok) pending.resolve(message.result ?? null);
    else pending.reject(new Error(message.error || 'Tab tool execution failed.'));
  }

  #callTab(name: MCPToolName, args: Record<string, unknown>): Promise<unknown> {
    const tab = this.#tab;
    if (!tab || tab.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(NO_TAB_MESSAGE));
    }
    const callId = crypto.randomUUID();
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(callId);
        reject(
          new Error(
            `Tab tool call timed out after ${TOOL_CALL_TIMEOUT_MS} ms. Keep the editor tab focused and retry.`,
          ),
        );
      }, TOOL_CALL_TIMEOUT_MS);
      this.#pending.set(callId, { resolve, reject, timer });
      try {
        tab.send(JSON.stringify({ type: 'tool.call', callId, name, args }));
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(callId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async #handleMessage(message: unknown): Promise<unknown | undefined> {
    return respondToMessage(message, { callTab: (name, args) => this.#callTab(name, args) });
  }
}
