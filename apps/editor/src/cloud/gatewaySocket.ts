/**
 * Tab side of the MCP gateway bridge (OG-028G).
 *
 * Opt-in via `VITE_MCP_GATEWAY=1`. When the user is logged in, the tab opens
 * `wss://<editor-host>/bridge?token=` so an external MCP client holding the
 * same Souv token can drive the 14 WebMCP tools through this tab
 * (`webmcpFallbackBridge.executeTool`, same handlers as WebMCP).
 * No tab state leaves the browser except tool results for the token owner.
 */
import { getSouvToken, onSouvAuthChange } from './souvAuth';
import { webmcpFallbackBridge, type WebMCPToolName } from './webmcpHost';

function gatewayEnabled(): boolean {
  return (
    (import.meta as unknown as { env?: Record<string, string | undefined> }).env
      ?.VITE_MCP_GATEWAY === '1'
  );
}

function bridgeUrl(token: string): string | null {
  const override = (import.meta as unknown as { env?: Record<string, string | undefined> }).env
    ?.VITE_GATEWAY_URL;
  if (override) return `${override.replace(/\/$/, '')}/bridge?token=${encodeURIComponent(token)}`;
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/bridge?token=${encodeURIComponent(token)}`;
}

let socket: WebSocket | null = null;
let retryTimer: number | null = null;
let started = false;
/** Set when this tab was replaced by a newer tab: never auto-reconnect. */
let replaced = false;

export type GatewayBridgeStatus = 'off' | 'connecting' | 'connected' | 'replaced';

let bridgeStatus: GatewayBridgeStatus = 'off';
const statusListeners = new Set<(status: GatewayBridgeStatus) => void>();

function setBridgeStatus(status: GatewayBridgeStatus): void {
  bridgeStatus = status;
  for (const listener of statusListeners) listener(status);
}

export function getGatewayBridgeStatus(): GatewayBridgeStatus {
  return bridgeStatus;
}

export function onGatewayBridgeChange(listener: (status: GatewayBridgeStatus) => void): () => void {
  statusListeners.add(listener);
  return () => {
    statusListeners.delete(listener);
  };
}

function scheduleReconnect(): void {
  if (retryTimer !== null || !gatewayEnabled() || !getSouvToken()) return;
  retryTimer = window.setTimeout(() => {
    retryTimer = null;
    connect();
  }, 3000);
}

function connect(): void {
  if (!gatewayEnabled()) return;
  const token = getSouvToken();
  if (!token || (socket && socket.readyState <= WebSocket.OPEN)) return;
  const url = bridgeUrl(token);
  if (!url) return;
  let ws: WebSocket;
  try {
    ws = new WebSocket(url);
  } catch {
    scheduleReconnect();
    return;
  }
  socket = ws;
  setBridgeStatus('connecting');
  ws.onopen = () => {
    setBridgeStatus('connected');
    ws.send(JSON.stringify({ type: 'bridge.hello' }));
  };
  ws.onmessage = (event) => {
    void (async () => {
      let message: {
        type?: string;
        callId?: string;
        name?: WebMCPToolName;
        args?: Record<string, unknown>;
      };
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message.type === 'bridge.replaced') {
        // Another tab took the bridge slot for this login. Stay out so the
        // two tabs don't evict each other in a reconnect war.
        replaced = true;
        setBridgeStatus('replaced');
        try {
          ws.close(1000, 'Replaced');
        } catch {
          // Already closing.
        }
        return;
      }
      if (message.type !== 'tool.call' || !message.callId || !message.name) return;
      const sendResult = (payload: unknown) => {
        try {
          ws.send(JSON.stringify(payload));
        } catch {
          // Socket closed mid-call; the DO timeout settles the caller.
        }
      };
      try {
        const result = await webmcpFallbackBridge.executeTool(message.name, message.args ?? {});
        sendResult({ type: 'tool.result', callId: message.callId, ok: true, result });
      } catch (error) {
        sendResult({
          type: 'tool.result',
          callId: message.callId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  };
  ws.onclose = () => {
    if (socket === ws) socket = null;
    if (replaced) {
      replaced = false;
      return;
    }
    setBridgeStatus('connecting');
    scheduleReconnect();
  };
  ws.onerror = () => {
    try {
      ws.close();
    } catch {
      // Reconnect is driven by onclose.
    }
  };
}

export function disconnectGatewayBridge(): void {
  if (retryTimer !== null) {
    window.clearTimeout(retryTimer);
    retryTimer = null;
  }
  if (socket) {
    try {
      socket.close(1000, 'Logged out');
    } catch {
      // Already closed.
    }
    socket = null;
  }
  setBridgeStatus('off');
}

/** Idempotent: call once from `mount.ts`. */
export function startGatewayBridge(): void {
  if (started || !gatewayEnabled()) return;
  started = true;
  onSouvAuthChange((token) => {
    if (token) connect();
    else disconnectGatewayBridge();
  });
  if (getSouvToken()) connect();
}
