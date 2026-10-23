import { beforeEach, describe, expect, it, vi } from 'vitest';

const bridge = vi.hoisted(() => ({
  aiChatFlagOff: vi.fn(() => false),
  aiChatFlagOverride: vi.fn(() => false),
  consumeAiChatFlagFromLocation: vi.fn(),
  ensureBridgeForAI: vi.fn(),
  gatewayUrlOverride: vi.fn((): string | null => null),
  getTabId: vi.fn(() => 'tab-9'),
}));
const auth = vi.hoisted(() => ({
  getSouvToken: vi.fn((): string | null => null),
  isSouvLoggedIn: vi.fn(() => false),
  loginWithSouvPopup: vi.fn(async (): Promise<string | null> => null),
  requireSouvLogin: vi.fn(async (): Promise<string | null> => null),
}));

vi.mock('./gatewaySocket', () => bridge);
vi.mock('./souvAuth', () => auth);

import { isAiChatEnabled, sendAiChatTurn } from './aiChatClient';

function sseBody(frames: Array<Record<string, unknown>>): ReadableStream<Uint8Array> {
  const text = frames.map((frame) => 'data: ' + JSON.stringify(frame) + '\n\n').join('');
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function mockFetchOk(frames: Array<Record<string, unknown>>) {
  const fetchMock = vi.fn(async (_url: unknown, _init?: unknown) => ({
    ok: true,
    status: 200,
    body: sseBody(frames),
    json: async () => ({}),
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const turn = { turnId: 't1', sessionId: 'editor:p1', text: 'Muda o fundo para azul.' };

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  bridge.ensureBridgeForAI.mockClear();
  bridge.getTabId.mockClear();
  auth.requireSouvLogin.mockReset();
  auth.getSouvToken.mockReset();
  auth.isSouvLoggedIn.mockReset();
  auth.loginWithSouvPopup.mockReset();
  auth.requireSouvLogin.mockResolvedValue('tok-1');
  auth.getSouvToken.mockReturnValue('tok-1');
});

describe('worker AI chat client (OG-094)', () => {
  it('is enabled by default and honors explicit opt-outs', () => {
    expect(isAiChatEnabled()).toBe(true);
    vi.stubEnv('VITE_AI_CHAT', '0');
    expect(isAiChatEnabled()).toBe(false);
  });

  it('sends Bearer + turnId + tabId and streams turn events', async () => {
    const fetchMock = mockFetchOk([
      { type: 'chat.text', turnId: 't1', text: 'Feito.' },
      { type: 'chat.turn.end', turnId: 't1', stopReason: 'done', usage: {} },
    ]);
    const seen: Array<Record<string, unknown>> = [];
    await sendAiChatTurn(turn, new AbortController().signal, (event) => {
      seen.push(event);
    });
    expect(bridge.ensureBridgeForAI).toHaveBeenCalledTimes(1);
    expect(bridge.getTabId).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]?.[1] as
      { headers?: Record<string, string>; body?: string } | undefined;
    expect(init?.headers?.Authorization).toBe('Bearer tok-1');
    const body = JSON.parse(String(init?.body)) as { turnId?: string; tabId?: string };
    expect(body.turnId).toBe('t1');
    expect(body.tabId).toBe('tab-9');
    expect(seen).toContainEqual({
      type: 'chat.turn.end',
      turnId: 't1',
      stopReason: 'done',
      usage: {},
    });
  });

  it('opens the login popup for cookie-only sessions', async () => {
    auth.requireSouvLogin.mockResolvedValue(null);
    auth.isSouvLoggedIn.mockReturnValue(true);
    auth.getSouvToken.mockReturnValue('tok-2');
    const fetchMock = mockFetchOk([
      { type: 'chat.turn.end', turnId: 't1', stopReason: 'done', usage: {} },
    ]);
    await sendAiChatTurn(turn, new AbortController().signal, () => undefined);
    expect(auth.loginWithSouvPopup).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]?.[1] as { headers?: Record<string, string> } | undefined;
    expect(init?.headers?.Authorization).toBe('Bearer tok-2');
  });

  it('fails loudly without credentials', async () => {
    auth.requireSouvLogin.mockResolvedValue(null);
    auth.isSouvLoggedIn.mockReturnValue(false);
    auth.getSouvToken.mockReturnValue(null);
    auth.loginWithSouvPopup.mockResolvedValue(null);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      sendAiChatTurn(turn, new AbortController().signal, () => undefined),
    ).rejects.toThrow('Souv login is required');
    // The shared requireSouvLogin flow already popped up for logged-out
    // tabs: do not open a second popup, fail with guidance instead.
    expect(auth.loginWithSouvPopup).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails loudly on a truncated stream', async () => {
    mockFetchOk([{ type: 'chat.text', turnId: 't1', text: 'Meio…' }]);
    const seen: Array<Record<string, unknown>> = [];
    await sendAiChatTurn(turn, new AbortController().signal, (event) => {
      seen.push(event);
    });
    expect(seen).toContainEqual({
      type: 'chat.error',
      turnId: 't1',
      message: 'The AI worker connection ended before the turn completed. Try again.',
    });
  });

  it('an aborted turn settles without a chat.error', async () => {
    mockFetchOk([{ type: 'chat.text', turnId: 't1', text: 'Meio…' }]);
    const controller = new AbortController();
    controller.abort();
    const seen: Array<Record<string, unknown>> = [];
    await sendAiChatTurn(turn, controller.signal, (event) => {
      seen.push(event);
    });
    expect(seen.some((event) => event.type === 'chat.error')).toBe(false);
  });
});
