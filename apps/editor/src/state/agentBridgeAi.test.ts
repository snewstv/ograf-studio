import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  vi.stubGlobal('window', {
    innerWidth: 1280,
    innerHeight: 720,
    location: { origin: 'http://editor.test', protocol: 'http:', host: 'editor.test' },
  });
  vi.stubGlobal('document', { querySelector: () => null });
});

const sendAiChatTurn = vi.hoisted(() =>
  vi.fn(async (_turn: unknown, _signal: unknown, _onEvent: unknown): Promise<void> => undefined),
);
const ensureBridgeForAI = vi.hoisted(() => vi.fn());
const aiState = vi.hoisted(() => ({ on: true }));
const executeToolMock = vi.hoisted(() => vi.fn(async () => ({ ok: true, result: {} })));

vi.mock('../cloud/aiChatClient', () => ({
  isAiChatEnabled: () => aiState.on,
  sendAiChatTurn,
}));
vi.mock('../cloud/gatewaySocket', () => ({
  ensureBridgeForAI,
  getGatewayBridgeStatus: () => 'connected',
  onGatewayBridgeChange: () => () => undefined,
}));
vi.mock('../cloud/webmcpHost', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../cloud/webmcpHost')>();
  return { ...actual, webmcpFallbackBridge: { executeTool: executeToolMock } };
});
vi.mock('./agentCapture', () => ({
  captureAgentPng: vi.fn(),
  measureAgentText: vi.fn(),
  renderAgentStripPng: vi.fn(),
}));
vi.mock('./ografCompatibility', () => ({ certifyExportArtifacts: vi.fn() }));

import { cancelAgentChat, sendAgentChat, useAgentChatStore } from './agentBridge';
import { useAgentReviewStore } from './agentReviewStore';
import { decideAgentProposal, startAiAssistantBridge } from './agentBridge';
import { useProjectStore } from './projectStore';
import { applyAuthoringOperations } from '@ograf-editor/authoring-core';

let scripted: Array<Record<string, unknown>> = [];
let captured: { turn: Record<string, unknown>; signal: AbortSignal } | null = null;

beforeEach(() => {
  aiState.on = true;
  scripted = [];
  captured = null;
  sendAiChatTurn.mockReset();
  ensureBridgeForAI.mockClear();
  sendAiChatTurn.mockImplementation(async (turn, signal, onEvent) => {
    captured = { turn: turn as Record<string, unknown>, signal: signal as AbortSignal };
    for (const event of scripted) (onEvent as (event: unknown) => void)(event);
  });
  useAgentChatStore.setState({
    configured: null,
    exclusive: false,
    externalAgentActive: false,
    provider: null,
    model: null,
    configMessage: null,
    entries: [],
    activeTurnId: null,
    activeTurnStartedAt: null,
    progress: null,
    pendingAssistantText: '',
    sessionUsage: { input: 0, output: 0, cacheRead: 0 },
    projectUsage: { input: 0, output: 0, cacheRead: 0 },
  });
  useAgentReviewStore.setState({ proposals: [], lastResolution: null });
});

describe('worker-driven AI seam (Fase 6B follow-up)', () => {
  it('sends the prompt to the worker with history, without localhost', () => {
    sendAgentChat('Muda o fundo para azul', [], []);
    expect(ensureBridgeForAI).toHaveBeenCalledTimes(1);
    expect(sendAiChatTurn).toHaveBeenCalledTimes(1);
    expect(captured?.turn.text).toBe('Muda o fundo para azul');
    expect(typeof captured?.turn.turnId).toBe('string');
    expect(captured?.turn.sessionId).toMatch(/^editor:/);
    expect(Array.isArray(captured?.turn.history)).toBe(true);
    const chat = useAgentChatStore.getState();
    expect(chat.activeTurnId).toBe(captured?.turn.turnId);
    expect(chat.entries.at(-1)).toMatchObject({ kind: 'user', text: 'Muda o fundo para azul' });
  });

  it('leaves localhost behavior alone when the worker assistant is off', () => {
    aiState.on = false;
    sendAgentChat('x', [], []);
    expect(sendAiChatTurn).not.toHaveBeenCalled();
    expect(useAgentChatStore.getState().entries).toHaveLength(0);
    expect(useAgentChatStore.getState().activeTurnId).toBeNull();
  });

  it('routes worker events into the existing reducers', () => {
    scripted = [
      { type: 'chat.config', turnId: 't', configured: true, provider: 'workers-ai', model: 'm' },
      { type: 'chat.text', turnId: 't', text: 'Feito.' },
      { type: 'chat.turn.end', turnId: 't', stopReason: 'done', usage: { input: 3, output: 1 } },
    ];
    sendAiChatTurn.mockImplementation(async (turn, _signal, onEvent) => {
      const id = (turn as Record<string, unknown>).turnId as string;
      for (const event of scripted) (onEvent as (event: unknown) => void)({ ...event, turnId: id });
    });
    sendAgentChat('oi', [], []);
    const chat = useAgentChatStore.getState();
    expect(chat.configured).toBe(true);
    expect(chat.provider).toBe('workers-ai');
    expect(chat.activeTurnId).toBeNull();
    expect(chat.entries.at(-1)).toMatchObject({ kind: 'assistant', text: 'Feito.' });
    expect(chat.sessionUsage).toMatchObject({ input: 3, output: 1 });
  });

  it('cancel aborts the worker turn and settles locally', () => {
    sendAgentChat('longo', [], []);
    expect(captured?.signal.aborted).toBe(false);
    cancelAgentChat();
    expect(captured?.signal.aborted).toBe(true);
    const chat = useAgentChatStore.getState();
    expect(chat.activeTurnId).toBeNull();
    expect(chat.progress?.message).toBe('Cancelled');
  });

  it('presents worker proposals for review without localhost', () => {
    scripted = [
      {
        type: 'chat.proposal',
        turnId: 't',
        proposalId: 'p1',
        proposal: {
          title: 'Muda o nome',
          description: '',
          operations: [{ type: 'set_project_metadata', name: 'Proposta' }],
          sessionId: 'editor:x',
        },
      },
    ];
    sendAiChatTurn.mockImplementation(async (turn, _signal, onEvent) => {
      const id = (turn as Record<string, unknown>).turnId as string;
      for (const event of scripted) (onEvent as (event: unknown) => void)({ ...event, turnId: id });
    });
    sendAgentChat('propoe', [], []);
    const proposals = useAgentReviewStore.getState().proposals;
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ id: 'p1', title: 'Muda o nome', valid: true });
    expect(proposals[0]?.project?.name).toBe('Proposta');
  });

  it('presents proposals with a future expiry so Accept is not blocked', () => {
    scripted = [
      {
        type: 'chat.proposal',
        turnId: 't',
        proposalId: 'p1',
        proposal: {
          title: 'Muda o nome',
          description: '',
          operations: [{ type: 'set_project_metadata', name: 'Proposta' }],
          sessionId: 'editor:x',
        },
      },
    ];
    sendAiChatTurn.mockImplementation(async (turn, _signal, onEvent) => {
      const id = (turn as Record<string, unknown>).turnId as string;
      for (const event of scripted) (onEvent as (event: unknown) => void)({ ...event, turnId: id });
    });
    sendAgentChat('propoe', [], []);
    const proposal = useAgentReviewStore.getState().proposals[0];
    expect(proposal?.staleReason).toBeNull();
    expect(Date.parse(proposal?.previewExpiresAt ?? '')).toBeGreaterThan(Date.now());
  });

  it('accepts a worker proposal through the review guards', async () => {
    startAiAssistantBridge();
    scripted = [
      {
        type: 'chat.proposal',
        turnId: 't',
        proposalId: 'p1',
        proposal: {
          title: 'Muda o nome',
          description: '',
          operations: [{ type: 'set_project_metadata', name: 'Proposta' }],
          sessionId: 'editor:x',
        },
      },
    ];
    sendAiChatTurn.mockImplementation(async (turn, _signal, onEvent) => {
      const id = (turn as Record<string, unknown>).turnId as string;
      for (const event of scripted) (onEvent as (event: unknown) => void)({ ...event, turnId: id });
    });
    sendAgentChat('propoe', [], []);
    // The canvas preview (browser-only) flips this; simulate it here.
    useAgentReviewStore.getState().update('p1', { previewReady: true });
    decideAgentProposal('p1', 'accept');
    expect(executeToolMock).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(useAgentReviewStore.getState().proposals).toHaveLength(0);
    });
    expect(useAgentReviewStore.getState().lastResolution).toMatchObject({
      status: 'accepted',
    });
  });

  it('surfaces tool failures as chat errors instead of silent completion', () => {
    scripted = [
      {
        type: 'chat.tool',
        turnId: 't',
        callId: 'c1',
        name: 'ograf_apply_operations',
        summary: 'ograf_apply_operations',
        status: 'error',
        error:
          'ograf_apply_operations: unknown operation type "set_background_color". Valid types: set_project_metadata, ...',
      },
      { type: 'chat.turn.end', turnId: 't', stopReason: 'done', usage: {} },
    ];
    sendAiChatTurn.mockImplementation(async (turn, _signal, onEvent) => {
      const id = (turn as Record<string, unknown>).turnId as string;
      captured = { turn: turn as Record<string, unknown>, signal: _signal as AbortSignal };
      for (const event of scripted) (onEvent as (event: unknown) => void)({ ...event, turnId: id });
    });
    sendAgentChat('muda o fundo', [], []);
    const chat = useAgentChatStore.getState();
    expect(chat.activeTurnId).toBeNull();
    expect(chat.entries.map((entry) => entry.kind)).toEqual(['user', 'error']);
    expect(chat.entries.at(-1)).toMatchObject({
      kind: 'error',
      turnId: captured?.turn.turnId,
    });
    expect(chat.entries.at(-1)?.text).toContain('unknown operation type');
  });

  it('turns an unpreviewable proposal into a chat error, not a dead review', () => {
    scripted = [
      {
        type: 'chat.proposal',
        turnId: 't',
        proposalId: 'p9',
        proposal: {
          title: 'Card de tempo verde',
          description: '',
          operations: [{ frame: 45 }],
          sessionId: 'editor:x',
        },
      },
    ];
    sendAiChatTurn.mockImplementation(async (turn, _signal, onEvent) => {
      captured = { turn: turn as Record<string, unknown>, signal: _signal as AbortSignal };
      const id = (turn as Record<string, unknown>).turnId as string;
      for (const event of scripted) (onEvent as (event: unknown) => void)({ ...event, turnId: id });
    });
    sendAgentChat('muda a cor do card', [], []);
    const chat = useAgentChatStore.getState();
    expect(chat.activeTurnId).toBeNull();
    expect(useAgentReviewStore.getState().proposals).toHaveLength(0);
    const last = chat.entries.at(-1);
    expect(last?.kind).toBe('error');
    expect(String(last?.text)).toContain('Could not preview the proposal');
    expect(String(last?.text)).not.toContain('Cannot read properties');
  });

  it('turns a valid-type proposal without patch into a legible chat error', () => {
    const base = useProjectStore.getState().project;
    const withCard = applyAuthoringOperations(base, [
      { type: 'add_layer', kind: 'rectangle', name: 'Card' },
    ]).project;
    const layerId = withCard.compositions[0]!.layers[0]!.id;
    useProjectStore.setState({ project: withCard });
    try {
      scripted = [
        {
          type: 'chat.proposal',
          turnId: 't',
          proposalId: 'p10',
          proposal: {
            title: 'Card de tempo verde',
            description: '',
            operations: [{ type: 'update_element', layerId }],
            sessionId: 'editor:x',
          },
        },
      ];
      sendAiChatTurn.mockImplementation(async (turn, _signal, onEvent) => {
        const id = (turn as Record<string, unknown>).turnId as string;
        for (const event of scripted)
          (onEvent as (event: unknown) => void)({ ...event, turnId: id });
      });
      sendAgentChat('muda a cor do card', [], []);
      expect(useAgentReviewStore.getState().proposals).toHaveLength(0);
      const chat = useAgentChatStore.getState();
      const last = chat.entries.at(-1);
      expect(last?.kind).toBe('error');
      expect(String(last?.text)).toContain('Could not preview the proposal');
      expect(String(last?.text)).toContain('patch');
      expect(String(last?.text)).not.toContain('Cannot read properties');
    } finally {
      useProjectStore.setState({ project: base });
    }
  });

  it('expires a pending proposal only after the project changes', () => {
    startAiAssistantBridge();
    scripted = [
      {
        type: 'chat.proposal',
        turnId: 't',
        proposalId: 'p1',
        proposal: {
          title: 'Muda o nome',
          description: '',
          operations: [{ type: 'set_project_metadata', name: 'Proposta' }],
          sessionId: 'editor:x',
        },
      },
    ];
    sendAiChatTurn.mockImplementation(async (turn, _signal, onEvent) => {
      const id = (turn as Record<string, unknown>).turnId as string;
      for (const event of scripted) (onEvent as (event: unknown) => void)({ ...event, turnId: id });
    });
    sendAgentChat('propoe', [], []);
    expect(useAgentReviewStore.getState().proposals[0]?.staleReason).toBeNull();
    // A later edit (user or another applied turn) stales the review.
    const current = useProjectStore.getState().project;
    useProjectStore.setState({ project: { ...current, name: current.name + ' edited' } });
    expect(useAgentReviewStore.getState().proposals[0]?.staleReason).toMatch(/regenerate/);
  });
});
