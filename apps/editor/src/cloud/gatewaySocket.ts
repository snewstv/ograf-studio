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

/** Opt-in for the worker AI Assistant route (`POST /ai/chat`, OG-092). */
function aiChatEnabled(): boolean {
  if (aiChatFlagOff()) return false;
  if (aiChatFlagOverride()) return true;
  const value = (import.meta as unknown as { env?: Record<string, string | undefined> }).env
    ?.VITE_AI_CHAT;
  // Default-on: only an explicit `0` disables (kill-switch `VITE_AI_CHAT=0`).
  if (value !== undefined) return value !== '0';
  return true;
}

/**
 * Per-tab id for the worker tool loop (OG-091). One id per tab, kept in
 * `sessionStorage` so reloads in the same tab keep their GatewayDO stub
 * (and concurrent tabs on different projects never share a bridge slot).
 */
const TAB_ID_KEY = 'ograf-studio:tab-id';

let cachedTabId: string | null = null;

export function getTabId(): string {
  if (cachedTabId) return cachedTabId;
  try {
    cachedTabId = sessionStorage.getItem(TAB_ID_KEY);
  } catch {
    cachedTabId = null;
  }
  if (!cachedTabId) {
    cachedTabId =
      typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : Date.now().toString(36) + '-' + Math.floor(Math.random() * 4294967295).toString(36);
    try {
      sessionStorage.setItem(TAB_ID_KEY, cachedTabId);
    } catch {
      // Private mode: the tab keeps its in-memory id for this load.
    }
  }
  return cachedTabId;
}

/** The tab bridge may serve the opt-in MCP gateway, the AI Assistant, or both. */
function bridgeAllowed(): boolean {
  return gatewayEnabled() || aiChatEnabled();
}

/** Consecutive failed bridge attempts without a successful open. */
let consecutiveBridgeFailures = 0;
/** After this many consecutive failures, take a fresh bridge slot. */
const MAX_BRIDGE_FAILURES_BEFORE_ROTATE = 5;

/**
 * Takes a fresh bridge slot (new tabId) after repeated failures. A stub can
 * be left rejecting handshakes (e.g. stranded on a previous worker version
 * after a deploy), and every retry would otherwise hit the same stub
 * forever. Rotating routes to a fresh stub on the current version;
 * in-flight calls on the old stub settle as no-tab errors.
 */
function rotateBridgeSlot(): void {
  consecutiveBridgeFailures = 0;
  cachedTabId = null;
  try {
    sessionStorage.removeItem(TAB_ID_KEY);
  } catch {
    // Private mode: the in-memory id is still replaced below.
  }
  getTabId();
}

const AI_FLAG_KEY = 'ograf-studio:ai-chat';
const GATEWAY_URL_KEY = 'ograf-studio:gateway-url';

/**
 * Tab-scoped rescue hatch (Fase 6B follow-up): `?ai_chat=1` enables the
 * worker assistant without rebuilding the editor, `?ai_chat=0` clears it;
 * `?gateway_url=` points this tab at another worker. Stored per-tab in
 * `sessionStorage`, so only the tab carrying the query string is affected.
 * Call once from the cloud mount before starting any bridge.
 */
/**
 * Per-tab assistant switch. The worker assistant is ON by default (no flag
 * or query param needed): `?ai_chat=0` (or `VITE_AI_CHAT=0`) turns it off
 * for this tab, `?ai_chat=1` forces it back on; `?gateway_url=` points this
 * tab at another worker (bare `?gateway_url=` clears a previously stored
 * override). Stored per-tab in `sessionStorage`, so only the
 * tab carrying the query string is affected. Call once from the cloud
 * mount before starting any bridge.
 */
export function consumeAiChatFlagFromLocation(): void {
  let params: URLSearchParams;
  try {
    params = new URL(window.location.href).searchParams;
  } catch {
    return;
  }
  try {
    const ai = params.get('ai_chat');
    if (ai === '1') sessionStorage.setItem(AI_FLAG_KEY, '1');
    else if (ai === '0') sessionStorage.setItem(AI_FLAG_KEY, '0');
    const gatewayUrl = params.get('gateway_url');
    if (gatewayUrl) sessionStorage.setItem(GATEWAY_URL_KEY, gatewayUrl);
    else if (params.has('gateway_url')) sessionStorage.removeItem(GATEWAY_URL_KEY);
  } catch {
    // Private mode: flags stay baked-in.
  }
}

function storedFlag(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Query override for `VITE_AI_CHAT` (see consumeAiChatFlagFromLocation). */
export function aiChatFlagOverride(): boolean {
  return storedFlag(AI_FLAG_KEY) === '1';
}

/** Explicit per-tab opt-out (`?ai_chat=0`; see consumeAiChatFlagFromLocation). */
export function aiChatFlagOff(): boolean {
  return storedFlag(AI_FLAG_KEY) === '0';
}

/** Query override for `VITE_GATEWAY_URL` (see consumeAiChatFlagFromLocation). */
export function gatewayUrlOverride(): string | null {
  const value = storedFlag(GATEWAY_URL_KEY);
  return value && value.trim() ? value.trim().replace(/\/$/, '') : null;
}

function bridgeUrl(token: string): string | null {
  const override = (import.meta as unknown as { env?: Record<string, string | undefined> }).env
    ?.VITE_GATEWAY_URL;
  const gatewayOverride = gatewayUrlOverride() ?? override;
  const query =
    'bridge?token=' + encodeURIComponent(token) + '&tabId=' + encodeURIComponent(getTabId());
  if (gatewayOverride) return gatewayOverride.replace(/\/$/, '') + '/' + query;
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return protocol + '//' + window.location.host + '/' + query;
}

let socket: WebSocket | null = null;
let retryTimer: number | null = null;
/** Watchdog for a handshake that never settles (no open, no close). */
let connectingTimer: number | null = null;
let started = false;
/** Set when this tab was replaced by a newer tab: never auto-reconnect. */
let replaced = false;

export type GatewayBridgeStatus = 'off' | 'connecting' | 'connected' | 'replaced';

let bridgeStatus: GatewayBridgeStatus = 'off';
const statusListeners = new Set<(status: GatewayBridgeStatus) => void>();

/** Last bridge failure for on-page diagnostics (no tokens or URLs). */
let lastBridgeError: string | null = null;
let bridgeAttempts = 0;

/** Read-only diagnostics for field debugging (no secrets). */
export interface BridgeDiagnostics {
  status: GatewayBridgeStatus;
  attempts: number;
  consecutiveFailures: number;
  lastError: string | null;
  tabIdPrefix: string;
  hasToken: boolean;
  gatewayOverride: string | null;
  bridgeAllowed: boolean;
}

export function readBridgeDiagnostics(): BridgeDiagnostics {
  return {
    status: bridgeStatus,
    attempts: bridgeAttempts,
    consecutiveFailures: consecutiveBridgeFailures,
    lastError: lastBridgeError,
    tabIdPrefix: getTabId().slice(0, 8),
    hasToken: !!getSouvToken(),
    gatewayOverride: gatewayUrlOverride(),
    bridgeAllowed: bridgeAllowed(),
  };
}

if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__ografBridge = { read: readBridgeDiagnostics };
}

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
  if (retryTimer !== null || !bridgeAllowed() || !getSouvToken()) return;
  retryTimer = window.setTimeout(() => {
    retryTimer = null;
    connect();
  }, 3000);
}

function connect(): void {
  if (!bridgeAllowed()) return;
  const token = getSouvToken();
  if (!token || (socket && socket.readyState <= WebSocket.OPEN)) return;
  const url = bridgeUrl(token);
  if (!url) return;
  let ws: WebSocket;
  try {
    bridgeAttempts += 1;
    ws = new WebSocket(url);
  } catch {
    lastBridgeError = 'construct-throw';
    scheduleReconnect();
    return;
  }
  socket = ws;
  setBridgeStatus('connecting');
  // Watchdog: a handshake that never settles (no open, no close) would
  // otherwise freeze retries forever, because connect() skips while a
  // CONNECTING socket exists. Force it closed so onclose drives the retry.
  if (connectingTimer !== null) window.clearTimeout(connectingTimer);
  connectingTimer = window.setTimeout(() => {
    connectingTimer = null;
    try {
      if (ws.readyState === WebSocket.CONNECTING) ws.close();
    } catch {
      // Already gone; onclose (if it fires) drives the normal retry.
    }
  }, 10000);
  ws.onopen = () => {
    if (connectingTimer !== null) {
      window.clearTimeout(connectingTimer);
      connectingTimer = null;
    }
    consecutiveBridgeFailures = 0;
    lastBridgeError = null;
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
        // Another tab holds this tabId: take a fresh slot and rejoin
        // instead of fighting over the shared one (rotation moves away
        // from the contested id, so concurrent tabs converge to
        // distinct slots instead of evicting each other in a loop).
        rotateBridgeSlot();
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
  ws.onclose = (event) => {
    if (connectingTimer !== null) {
      window.clearTimeout(connectingTimer);
      connectingTimer = null;
    }
    if (socket === ws) socket = null;
    if (replaced) {
      replaced = false;
      return;
    }
    consecutiveBridgeFailures += 1;
    if (consecutiveBridgeFailures >= MAX_BRIDGE_FAILURES_BEFORE_ROTATE) rotateBridgeSlot();
    try {
      const code =
        event && typeof (event as CloseEvent).code === 'number' ? (event as CloseEvent).code : -1;
      const clean =
        event && typeof (event as CloseEvent).wasClean === 'boolean'
          ? (event as CloseEvent).wasClean
          : false;
      lastBridgeError = 'close code=' + code + ' clean=' + clean;
    } catch {
      lastBridgeError = 'close';
    }
    setBridgeStatus('connecting');
    scheduleReconnect();
  };
  ws.onerror = () => {
    lastBridgeError = 'error-event';
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
  if (connectingTimer !== null) {
    window.clearTimeout(connectingTimer);
    connectingTimer = null;
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
  if (started || !bridgeAllowed()) return;
  started = true;
  onSouvAuthChange((token) => {
    if (token) connect();
    else disconnectGatewayBridge();
  });
  if (getSouvToken()) connect();
}

/**
 * Ensures the ORIGIN TAB bridge is connected for the worker AI loop
 * (OG-092). Reuses the single tab socket (same replaced slot as an
 * external MCP client) and routes by `tabId`, so no second connection is
 * opened per turn. No-op unless `VITE_AI_CHAT=1`.
 */
export function ensureBridgeForAI(): void {
  if (!aiChatEnabled()) return;
  startGatewayBridge();
  if (getSouvToken()) connect();
}
