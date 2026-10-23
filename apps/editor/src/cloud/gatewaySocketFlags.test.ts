import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  aiChatFlagOff,
  aiChatFlagOverride,
  consumeAiChatFlagFromLocation,
  gatewayUrlOverride,
} from './gatewaySocket';
import { isAiChatEnabled } from './aiChatClient';

function stubTabStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
  });
  return store;
}

describe('tab-scoped AI flag rescue hatch', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('is on by default without baked flag, query or storage', () => {
    expect(aiChatFlagOverride()).toBe(false);
    expect(aiChatFlagOff()).toBe(false);
    expect(isAiChatEnabled()).toBe(true);
    expect(gatewayUrlOverride()).toBeNull();
  });

  it('keeps the assistant on with explicit ?ai_chat=1', () => {
    stubTabStorage();
    vi.stubGlobal('window', { location: new URL('http://editor.test/?ai_chat=1') });
    consumeAiChatFlagFromLocation();
    expect(aiChatFlagOverride()).toBe(true);
    expect(isAiChatEnabled()).toBe(true);
  });

  it('disables the assistant with ?ai_chat=0', () => {
    const store = stubTabStorage();
    store.set('ograf-studio:ai-chat', '1');
    vi.stubGlobal('window', { location: new URL('http://editor.test/?ai_chat=0') });
    consumeAiChatFlagFromLocation();
    expect(aiChatFlagOff()).toBe(true);
    expect(aiChatFlagOverride()).toBe(false);
    expect(isAiChatEnabled()).toBe(false);
  });

  it('points the tab at another worker from ?gateway_url=', () => {
    stubTabStorage();
    vi.stubGlobal('window', {
      location: new URL('http://editor.test/?gateway_url=https://w.test/'),
    });
    consumeAiChatFlagFromLocation();
    expect(gatewayUrlOverride()).toBe('https://w.test');
  });

  it('clears a stored gateway override with bare ?gateway_url=', () => {
    const store = stubTabStorage();
    store.set('ograf-studio:gateway-url', 'https://dead.test/');
    vi.stubGlobal('window', { location: new URL('http://editor.test/?gateway_url=') });
    consumeAiChatFlagFromLocation();
    expect(gatewayUrlOverride()).toBeNull();
  });

  it('ignores missing DOM globals instead of throwing', () => {
    expect(() => consumeAiChatFlagFromLocation()).not.toThrow();
  });
});
