/**
 * Tab-side transport for the worker AI chat route (OG-092, POST /ai/chat).
 *
 * On by default (kill-switch `VITE_AI_CHAT=0` or `?ai_chat=0`). Authenticates
 * with the tab's Souv Bearer token — the same session storage the cloud
 * save and the tab bridge use, so a logged-in tab never logs in twice —
 * (login popup only when no token is available, never twice: the shared
 * `requireSouvLogin` flow owns the popup for logged-out tabs). Ensures the
 * ORIGIN TAB's bridge is connected (the worker loop fans tool calls out
 * through the per-tab GatewayDO stub), and streams the SSE turn events
 * into the editor's existing chat reducers. Every turn carries the tab id
 * so concurrent tabs on different projects never mix.
 */
import {
  aiChatFlagOff,
  aiChatFlagOverride,
  ensureBridgeForAI,
  gatewayUrlOverride,
  getTabId,
} from './gatewaySocket';
import { getSouvToken, isSouvLoggedIn, loginWithSouvPopup, requireSouvLogin } from './souvAuth';

export function isAiChatEnabled(): boolean {
  if (aiChatFlagOff()) return false;
  if (aiChatFlagOverride()) return true;
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  if (env?.VITE_AI_CHAT !== undefined) return env.VITE_AI_CHAT !== '0';
  // Node/vitest fallback (the browser build bakes VITE_* at compile time):
  // lets tooling and tests toggle the flag through the process env.
  const procEnv =
    typeof process !== 'undefined'
      ? (process as unknown as { env?: Record<string, string | undefined> }).env
      : undefined;
  if (procEnv?.VITE_AI_CHAT !== undefined) return procEnv.VITE_AI_CHAT !== '0';
  return true;
}

function aiChatUrl(): string {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  const override = gatewayUrlOverride() ?? env?.VITE_GATEWAY_URL;
  if (override) {
    // Same override as the bridge socket (a ws:// URL there); the AI route
    // lives on the same worker over HTTP(S).
    return override.replace(/^ws(s)?:\/\//, 'http$1://').replace(/\/$/, '') + '/ai/chat';
  }
  return '/ai/chat';
}

export interface AiChatHistoryEntry {
  role: 'user' | 'assistant';
  text: string;
}

/**
 * Streams one worker turn. onEvent receives the decoded SSE payloads
 * (chat.config, chat.progress, chat.text, chat.tool, chat.proposal,
 * chat.turn.end, chat.error) for the editor's existing reducers.
 */
export async function sendAiChatTurn(
  turn: {
    turnId: string;
    sessionId: string;
    text: string;
    ambient?: unknown;
    areaReferences?: unknown[];
    history?: AiChatHistoryEntry[];
  },
  signal: AbortSignal,
  onEvent: (event: Record<string, unknown>) => void,
): Promise<void> {
  let token = await requireSouvLogin();
  if (!token) {
    // `requireSouvLogin` already popped up for logged-out tabs (shared with
    // cloud save): only a cookie-only session still lacks a Bearer here, so
    // popup exactly once instead of twice.
    if (!isSouvLoggedIn()) {
      throw new Error('Souv login is required for the AI assistant.');
    }
    await loginWithSouvPopup();
    token = getSouvToken();
  }
  if (!token) throw new Error('Souv login is required for the AI assistant.');
  ensureBridgeForAI();

  let response: Response;
  try {
    response = await fetch(aiChatUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      credentials: 'include',
      signal: signal,
      body: JSON.stringify({
        turnId: turn.turnId,
        sessionId: turn.sessionId,
        tabId: getTabId(),
        text: turn.text,
        ...(turn.ambient !== undefined ? { ambient: turn.ambient } : {}),
        ...(turn.areaReferences && turn.areaReferences.length
          ? { areaReferences: turn.areaReferences }
          : {}),
        ...(turn.history && turn.history.length ? { history: turn.history } : {}),
      }),
    });
  } catch (error) {
    if (signal.aborted) return;
    throw new Error(
      'Could not reach the AI worker. Check the network connection. (' +
        (error instanceof Error ? error.message : String(error)) +
        ')',
    );
  }
  if (!response.ok || !response.body) {
    let detail = 'HTTP ' + response.status;
    try {
      const envelope = (await response.json()) as { error?: unknown };
      if (typeof envelope?.error === 'string' && envelope.error) detail = envelope.error;
    } catch {
      // Fall through with the status text.
    }
    throw new Error(detail);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let settled = false;
  const emit = (event: Record<string, unknown>) => {
    if (event.type === 'chat.turn.end' || event.type === 'chat.error') settled = true;
    onEvent(event);
  };
  for (;;) {
    const chunk = await reader.read().catch(() => null);
    if (!chunk || chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary).trim();
      buffer = buffer.slice(boundary + 2);
      if (frame.indexOf('data:') === 0) {
        try {
          emit(JSON.parse(frame.slice('data:'.length)) as Record<string, unknown>);
        } catch {
          // Ignore a malformed frame; the turn-end event still settles the UI.
        }
      }
      boundary = buffer.indexOf('\n\n');
    }
  }
  // A truncated stream (network drop, worker restart) otherwise resolves
  // silently and leaves the composer stuck busy: fail loudly instead.
  if (!settled && !signal.aborted) {
    emit({
      type: 'chat.error',
      turnId: turn.turnId,
      message: 'The AI worker connection ended before the turn completed. Try again.',
    });
  }
}
