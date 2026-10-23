import { useAgentReviewStore, type AgentAuthoringProposal } from './agentReviewStore';
export { useAgentReviewStore, type AgentAuthoringProposal } from './agentReviewStore';
import { useEffect } from 'react';
import type { AgentAreaReference } from '@ograf-editor/agent-tools/chat-references';
import { resolveAgentBridgeUrl } from './agentBridgeUrl';
import { getTotalFrames, type Project } from '@ograf-editor/scene-model';
import type { ExportArtifacts } from '@ograf-editor/codegen';
import { create } from 'zustand';
import { certifyExportArtifacts } from './ografCompatibility';
import { applyRemoteProjectUpdate } from './historyStore';
import { useProjectStore } from './projectStore';
import { useSelectionStore } from './selectionStore';
import { useTimelineStore } from './timelineStore';
import {
  captureAgentPng,
  measureAgentText,
  renderAgentStripPng,
  type AgentCaptureRequest,
  type AgentMeasureTextRequest,
  type AgentStripRequest,
} from './agentCapture';
import type { AgentLayerReference } from './agentLayerReference';
import { isAiChatEnabled, sendAiChatTurn } from '../cloud/aiChatClient';
import {
  ensureBridgeForAI,
  getGatewayBridgeStatus,
  onGatewayBridgeChange,
  type GatewayBridgeStatus,
} from '../cloud/gatewaySocket';
import { normalizeOperationSelectors } from '@ograf-editor/agent-tools/normalize-operations';
import { applyAuthoringOperations } from '@ograf-editor/authoring-core';
import { assertKnownOperationTypes, webmcpFallbackBridge } from '../cloud/webmcpHost';

interface AgentBridgeStatus {
  connected: boolean;
  authoritative: boolean;
  revision: number | null;
  activity: string;
  setStatus: (patch: Partial<Omit<AgentBridgeStatus, 'setStatus'>>) => void;
}

export const useAgentBridgeStatus = create<AgentBridgeStatus>((set) => ({
  connected: false,
  authoritative: true,
  revision: null,
  activity: 'Agent bridge offline',
  setStatus: (patch) => set(patch),
}));

export interface ChatUsage {
  input: number;
  output: number;
  cacheRead: number;
}

export interface ChatTranscriptEntry {
  id: string;
  turnId: string;
  kind: 'user' | 'assistant' | 'tool' | 'proposal' | 'error';
  text: string;
  status?: 'running' | 'ok' | 'error';
  usage?: ChatUsage;
  areaReferences?: AgentAreaReference[];
  areaSummaries?: Array<{ number: number; frame: number; instruction: string }>;
}

export interface ChatProgress {
  phase: 'sending' | 'waiting' | 'continuing' | 'tool' | 'complete' | 'error';
  message: string;
  round: number;
  updatedAt: number;
}

interface AgentChatState {
  configured: boolean | null;
  exclusive: boolean;
  externalAgentActive: boolean;
  provider: string | null;
  model: string | null;
  configMessage: string | null;
  entries: ChatTranscriptEntry[];
  activeTurnId: string | null;
  activeTurnStartedAt: number | null;
  progress: ChatProgress | null;
  pendingAssistantText: string;
  sessionUsage: ChatUsage;
  projectUsage: ChatUsage;
  addEntry: (entry: ChatTranscriptEntry) => void;
  setState: (patch: Partial<Omit<AgentChatState, 'addEntry' | 'setState'>>) => void;
}

const EMPTY_USAGE: ChatUsage = { input: 0, output: 0, cacheRead: 0 };
const PROJECT_USAGE_KEY = 'ograf-studio:agent-usage';

function addUsage(left: ChatUsage, right: ChatUsage): ChatUsage {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
  };
}

function readProjectUsage(projectId: string): ChatUsage {
  try {
    const all = JSON.parse(localStorage.getItem(PROJECT_USAGE_KEY) ?? '{}') as Record<
      string,
      ChatUsage
    >;
    return all[projectId] ?? EMPTY_USAGE;
  } catch {
    return EMPTY_USAGE;
  }
}

function persistProjectUsage(projectId: string, usage: ChatUsage): void {
  try {
    const all = JSON.parse(localStorage.getItem(PROJECT_USAGE_KEY) ?? '{}') as Record<
      string,
      ChatUsage
    >;
    all[projectId] = usage;
    localStorage.setItem(PROJECT_USAGE_KEY, JSON.stringify(all));
  } catch {
    // Usage display is local convenience state and must never enter the project document.
  }
}

export const useAgentChatStore = create<AgentChatState>((set) => ({
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
  sessionUsage: EMPTY_USAGE,
  projectUsage: EMPTY_USAGE,
  addEntry: (entry) =>
    set((state) => ({
      entries: [
        ...state.entries.map((previous) =>
          entry.areaReferences && previous.areaReferences
            ? { ...previous, areaReferences: undefined }
            : previous,
        ),
        entry,
      ],
    })),
  setState: (patch) => set(patch),
}));

let sendProposalDecision: ((payload: unknown) => void) | null = null;
let sendChatPayload: ((payload: unknown) => void) | null = null;
type ProposalCapture = (
  request: AgentCaptureRequest,
  isCurrent: () => boolean,
) => Promise<Awaited<ReturnType<typeof captureAgentPng>> | null>;
const directProposalCapture: ProposalCapture = async (request, isCurrent) =>
  isCurrent() ? captureAgentPng(request) : null;
let proposalCapture = directProposalCapture;

/** Share the renderer queue with MCP capture/certification work. */
export function captureAgentProposal(request: AgentCaptureRequest, isCurrent: () => boolean) {
  return proposalCapture(request, isCurrent);
}

export function decideAgentProposal(proposalId: string, decision: 'accept' | 'reject'): void {
  const proposal = useAgentReviewStore.getState().proposals.find((item) => item.id === proposalId);
  const connection = useAgentBridgeStatus.getState();
  if (
    !sendProposalDecision ||
    !connection.connected ||
    !connection.authoritative ||
    !proposal ||
    proposal.deciding
  )
    return;
  if (decision === 'accept' && (!proposal.valid || proposal.staleReason || !proposal.previewReady))
    return;
  useAgentReviewStore.getState().update(proposalId, { deciding: decision });
  useAgentBridgeStatus.getState().setStatus({
    activity:
      decision === 'accept' ? 'Applying accepted agent proposal…' : 'Rejecting agent proposal…',
  });
  sendProposalDecision({ type: 'proposal.decision', proposalId, decision });
}

// Fork (OG-092/OG-093): worker-driven AI transport. When VITE_AI_CHAT=1 the
// prompt goes to POST /ai/chat (Workers AI) instead of the localhost socket;
// the worker loop calls back into THIS tab through its per-tab GatewayDO
// stub. Localhost behavior below is untouched when the flag is off.
let aiAbort: AbortController | null = null;
let aiBridgeStarted = false;
/** Worker-proposed operations awaiting human Accept/Reject in the panel. */
const aiProposalOperations = new Map<string, Array<Record<string, unknown>>>();
/** Last tool error per worker turn: a turn that ends with no assistant text
 * after a tool error becomes a visible chat error instead of a silent
 * `Completed` with an empty message. Cleared on `ok` and on turn end. */
const aiTurnToolErrors = new Map<string, string>();

function buildChatAmbient(
  references: AgentLayerReference[],
  areaReferences: AgentAreaReference[],
): Record<string, unknown> {
  const selection = useSelectionStore.getState();
  const timeline = useTimelineStore.getState();
  const activity = useAgentBridgeStatus.getState().activity;
  const referencedLayerIds = references.map((reference) => reference.layerId);
  return {
    selection: {
      layerIds: areaReferences.length
        ? []
        : referencedLayerIds.length
          ? referencedLayerIds
          : selection.selectedLayerIds,
      primaryLayerId: areaReferences.length
        ? null
        : (referencedLayerIds[0] ?? selection.selectedLayerId),
    },
    ...(references.length ? { references } : {}),
    frame: timeline.currentFrame,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      zoom: Number(
        document.querySelector<HTMLElement>('.canvas-stage-viewport')?.dataset.ografZoom ?? 1,
      ),
    },
    recentEdits: activity && activity !== 'Agent connected' ? [activity] : [],
  };
}

function workerHistory(): Array<{ role: 'user' | 'assistant'; text: string }> {
  return useAgentChatStore
    .getState()
    .entries.filter((entry) => entry.kind === 'user' || entry.kind === 'assistant')
    .slice(-10)
    .map((entry) => ({ role: entry.kind as 'user' | 'assistant', text: entry.text }));
}

function beginChatTurn(text: string, areaReferences: AgentAreaReference[]): string {
  const turnId = crypto.randomUUID();
  useAgentChatStore.getState().addEntry({
    id: `user-${turnId}`,
    turnId,
    kind: 'user',
    text,
    ...(areaReferences.length
      ? {
          areaSummaries: areaReferences.map((area, index) => ({
            number: index + 1,
            frame: area.frame,
            instruction: area.instruction ?? '',
          })),
        }
      : {}),
    ...(areaReferences.length ? { areaReferences } : {}),
  });
  useAgentChatStore.getState().setState({
    activeTurnId: turnId,
    pendingAssistantText: '',
    activeTurnStartedAt: Date.now(),
    progress: {
      phase: 'sending',
      message: 'Sending request to the model',
      round: 0,
      updatedAt: Date.now(),
    },
  });
  return turnId;
}

function aiChatError(turnId: string, message: string): void {
  const chat = useAgentChatStore.getState();
  if (chat.activeTurnId !== turnId) return;
  chat.setState({
    activeTurnId: null,
    activeTurnStartedAt: null,
    pendingAssistantText: '',
    progress: {
      phase: 'error',
      message,
      round: chat.progress?.round ?? 1,
      updatedAt: Date.now(),
    },
  });
  chat.addEntry({ id: `error-${turnId}`, turnId, kind: 'error', text: message });
}

function cancelAiTurn(): void {
  aiAbort?.abort();
  aiAbort = null;
  const chat = useAgentChatStore.getState();
  if (!chat.activeTurnId) return;
  const turnId = chat.activeTurnId;
  chat.setState({
    activeTurnId: null,
    activeTurnStartedAt: null,
    pendingAssistantText: '',
    progress: {
      phase: 'complete',
      message: 'Cancelled',
      round: chat.progress?.round ?? 1,
      updatedAt: Date.now(),
    },
  });
  chat.addEntry({ id: `assistant-${turnId}`, turnId, kind: 'assistant', text: 'Cancelled.' });
}
export function sendAgentChat(
  text: string,
  references: AgentLayerReference[] = [],
  areaReferences: AgentAreaReference[] = [],
): void {
  if (!text.trim()) return;
  if (isAiChatEnabled()) {
    sendAgentChatViaWorker(text.trim(), references, areaReferences);
    return;
  }
  if (!sendChatPayload) return;
  const projectId = useProjectStore.getState().project.id;
  const turnId = beginChatTurn(text.trim(), areaReferences);
  sendChatPayload({
    type: 'chat.send',
    turnId,
    sessionId: `editor:${projectId}`,
    text: text.trim(),
    ...(areaReferences.length ? { areaReferences } : {}),
    ambient: buildChatAmbient(references, areaReferences),
  });
}

export function cancelAgentChat(): void {
  if (isAiChatEnabled()) {
    cancelAiTurn();
    return;
  }
  const turnId = useAgentChatStore.getState().activeTurnId;
  if (turnId) sendChatPayload?.({ type: 'chat.cancel', turnId });
}

function sendAgentChatViaWorker(
  text: string,
  references: AgentLayerReference[],
  areaReferences: AgentAreaReference[],
): void {
  const projectId = useProjectStore.getState().project.id;
  const turnId = beginChatTurn(text, areaReferences);
  ensureBridgeForAI();
  const controller = new AbortController();
  aiAbort = controller;
  void sendAiChatTurn(
    {
      turnId,
      sessionId: `editor:${projectId}`,
      text,
      ambient: buildChatAmbient(references, areaReferences),
      ...(areaReferences.length ? { areaReferences } : {}),
      history: workerHistory(),
    },
    controller.signal,
    (event) => handleAiChatEvent(event),
  ).catch((error) => {
    if (controller.signal.aborted) return;
    aiChatError(turnId, error instanceof Error ? error.message : String(error));
  });
}

function handleAiChatEvent(event: Record<string, unknown>): void {
  const turnId = typeof event.turnId === 'string' ? event.turnId : '';
  switch (event.type) {
    case 'chat.config': {
      useAgentChatStore.getState().setState({
        configured: typeof event.configured === 'boolean' ? event.configured : true,
        exclusive: event.exclusive === true,
        provider: typeof event.provider === 'string' ? event.provider : 'workers-ai',
        model: typeof event.model === 'string' ? event.model : null,
        configMessage: typeof event.message === 'string' ? event.message : null,
        projectUsage: readProjectUsage(useProjectStore.getState().project.id),
      });
      return;
    }
    case 'chat.progress': {
      updateAgentChatActivity({
        type: 'chat.progress',
        turnId,
        phase: event.phase === 'waiting' ? 'waiting' : 'continuing',
        message: typeof event.message === 'string' ? event.message : 'Working…',
        round: typeof event.round === 'number' ? event.round : 1,
      });
      return;
    }
    case 'chat.text': {
      updateAgentChatActivity({
        type: 'chat.text',
        turnId,
        text: typeof event.text === 'string' ? event.text : '',
      });
      return;
    }
    case 'chat.tool': {
      const toolStatus =
        event.status === 'running' ? 'running' : event.status === 'ok' ? 'ok' : 'error';
      const toolName = typeof event.name === 'string' ? event.name : 'tool';
      if (toolStatus === 'error') {
        const detail =
          typeof event.error === 'string' && event.error
            ? event.error
            : 'Tool ' + toolName + ' failed.';
        aiTurnToolErrors.set(turnId, detail);
      } else if (toolStatus === 'ok') {
        aiTurnToolErrors.delete(turnId);
      }
      updateAgentChatActivity({
        type: 'chat.tool',
        turnId,
        callId: typeof event.callId === 'string' ? event.callId : '',
        name: toolName,
        summary: typeof event.summary === 'string' ? event.summary : 'tool',
        status: toolStatus,
      });
      return;
    }
    case 'chat.proposal': {
      const proposalId = typeof event.proposalId === 'string' ? event.proposalId : turnId;
      updateAgentChatActivity({ type: 'chat.proposal', turnId, proposalId });
      presentAiProposal(turnId, proposalId, event.proposal);
      return;
    }
    case 'chat.turn.end': {
      const usageRecord = (event.usage ?? {}) as Record<string, unknown>;
      const amount = (value: unknown) =>
        typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
      const pendingText = useAgentChatStore.getState().pendingAssistantText;
      const toolError = aiTurnToolErrors.get(turnId);
      aiTurnToolErrors.delete(turnId);
      if (!pendingText && toolError) {
        aiChatError(turnId, toolError);
        return;
      }
      finishAgentChatTurn({
        type: 'chat.turn.end',
        turnId,
        stopReason: typeof event.stopReason === 'string' ? event.stopReason : 'done',
        usage: {
          input: amount(usageRecord.input),
          output: amount(usageRecord.output),
          cacheRead: amount(usageRecord.cacheRead),
        },
      });
      return;
    }
    case 'chat.error': {
      aiChatError(
        turnId,
        typeof event.message === 'string' && event.message
          ? event.message
          : 'The AI worker connection ended before the turn completed.',
      );
      return;
    }
    default:
      return;
  }
}

/**
 * Presents a worker-proposed batch in the existing review UI (OG-093). The
 * proposed project is computed in-tab so the canvas preview, Accept and
 * Reject work exactly like localhost proposals; `decideAgentProposal`, the
 * review store and export paths are untouched.
 *
 * An invalid batch never reaches the review as a dead proposal: the tab
 * validates first (known types via the shared catalog, then full
 * normalization) and failures surface as a chat error instead, so the
 * worker can correct them within the turn.
 */
function presentAiProposal(turnId: string, proposalId: string, raw: unknown): void {
  const record = (raw ?? {}) as {
    title?: unknown;
    description?: unknown;
    operations?: unknown;
    sessionId?: unknown;
  };
  const operations = Array.isArray(record.operations)
    ? (record.operations as Array<Record<string, unknown>>)
    : [];
  const project = useProjectStore.getState().project;
  let previewProject: Project | undefined;
  let operationTypes: string[] = [];
  try {
    assertKnownOperationTypes(operations);
    const typed = normalizeOperationSelectors(project, operations);
    previewProject = applyAuthoringOperations(project, typed).project;
    operationTypes = typed.map((operation) => operation?.type ?? 'unknown');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    aiChatError(turnId, 'Could not preview the proposal: ' + detail);
    return;
  }
  if (operations.length > 0) aiProposalOperations.set(proposalId, operations);
  useTimelineStore.getState().controller?.pause();
  useTimelineStore.getState().setPreviewLoopLayerId(null);
  const title =
    typeof record.title === 'string' && record.title ? record.title : 'Proposed changes';
  useAgentReviewStore.getState().present(
    {
      id: proposalId,
      title,
      description: typeof record.description === 'string' ? record.description : '',
      sessionId: typeof record.sessionId === 'string' ? record.sessionId : `editor:${project.id}`,
      baseRevision: useAgentBridgeStatus.getState().revision ?? 0,
      operationTypes,
      operationCount: operations.length,
      previewUrl: '',
      // No remote URL expires here: the preview is rendered in-tab from
      // `previewProject`. AppShell still sweeps on this timestamp, so give
      // the review a real window instead of expiring it on arrival.
      previewExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      render: 'frame',
      frames: [useTimelineStore.getState().currentFrame],
      valid: previewProject !== undefined,
      warnings: [],
      ...(previewProject ? { project: previewProject } : {}),
      compositionId: useProjectStore.getState().activeCompositionId ?? undefined,
    },
    project,
    undefined,
  );
  useAgentBridgeStatus.getState().setStatus({ activity: `Review requested: ${title}` });
}

/** In-tab decision path for worker proposals (Accept applies live, undoable). */
async function decideAiProposal(payload: unknown): Promise<void> {
  const record = (payload ?? {}) as { proposalId?: unknown; decision?: unknown };
  if (typeof record.proposalId !== 'string') return;
  if (record.decision !== 'accept' && record.decision !== 'reject') return;
  const proposalId = record.proposalId;
  const decision = record.decision;
  const store = useAgentReviewStore.getState();
  const proposal = store.proposals.find((item) => item.id === proposalId);
  const connection = useAgentBridgeStatus.getState();
  // NOTE: the exported decideAgentProposal marks `deciding` BEFORE delegating
  // here, so a set flag equal to this decision means our own in-flight work —
  // not someone else's. (Repeated clicks are already stopped by the exported
  // wrapper, which returns early while `deciding` is set.)
  if (!proposal || (proposal.deciding && proposal.deciding !== decision)) return;
  if (decision === 'reject') {
    store.update(proposalId, { deciding: 'reject' });
    aiProposalOperations.delete(proposalId);
    store.resolve(proposalId, { status: 'rejected', message: 'Proposal rejected.' });
    connection.setStatus({ activity: 'Proposal rejected.' });
    return;
  }
  if (!proposal.valid || proposal.staleReason || !proposal.previewReady) return;
  const operations = aiProposalOperations.get(proposalId);
  if (!operations) return;
  store.update(proposalId, { deciding: 'accept' });
  connection.setStatus({ activity: 'Applying accepted agent proposal…' });
  try {
    const result = (await webmcpFallbackBridge.executeTool('ograf_apply_operations', {
      operations,
      expectedRevision: 0,
      mode: 'apply',
      reason: `Accepted proposal: ${proposal.title}`,
    })) as { operationCount?: unknown; operationTypes?: unknown };
    aiProposalOperations.delete(proposalId);
    const count =
      typeof result?.operationCount === 'number' ? result.operationCount : operations.length;
    const types = Array.isArray(result?.operationTypes)
      ? (result.operationTypes as string[])
      : proposal.operationTypes;
    const detail = types.length > 0 ? ` — ${types.join(', ')}` : '';
    const state = useProjectStore.getState();
    const composition = state.project.compositions.find(
      (item) => item.id === (proposal.compositionId ?? state.project.mainCompositionId),
    );
    if (composition) {
      useProjectStore.setState({ activeCompositionId: composition.id });
      useTimelineStore
        .getState()
        .setCurrentFrame(Math.min(proposal.previewFrame, getTotalFrames(composition)));
    }
    store.resolve(proposalId, {
      status: 'accepted',
      message: `Agent: ${count} change${count === 1 ? '' : 's'}${detail}`,
    });
    connection.setStatus({
      revision: connection.revision,
      activity: `Agent: ${count} change${count === 1 ? '' : 's'}${detail}`,
    });
  } catch (error) {
    store.update(proposalId, { deciding: null });
    connection.setStatus({
      activity: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Starts the worker-driven AI Assistant seam (OG-092). No-op unless
 * `VITE_AI_CHAT=1`. Call once from the cloud mount; localhost wiring is
 * untouched. Mirrors the tab bridge (shared slot with external MCP) into the
 * legacy status store so review Accept/Reject guards see the live tab, and
 * routes proposal decisions to the in-tab apply path.
 */
export function startAiAssistantBridge(): void {
  if (!isAiChatEnabled() || aiBridgeStarted) return;
  aiBridgeStarted = true;
  const mirror = (status: GatewayBridgeStatus) => {
    const current = useAgentBridgeStatus.getState();
    if (status === 'connected') {
      current.setStatus({
        connected: true,
        authoritative: true,
        ...(current.activity === 'Agent bridge offline'
          ? { activity: 'AI assistant connected' }
          : {}),
      });
    } else if (status === 'connecting') {
      if (!current.connected) current.setStatus({ activity: 'AI assistant connecting…' });
    } else if (status === 'replaced') {
      current.setStatus({
        connected: false,
        authoritative: false,
        activity: 'This tab is not the active editor session.',
      });
    } else if (!useAgentChatStore.getState().activeTurnId) {
      current.setStatus({ connected: false, activity: 'Agent bridge offline' });
    } else {
      current.setStatus({ connected: false });
    }
  };
  mirror(getGatewayBridgeStatus());
  onGatewayBridgeChange(mirror);
  // Real expiry, mirroring the localhost bridge: a project change after a
  // proposal was presented invalidates pending reviews (AI applies also
  // flow through here, so an applied turn correctly stales older proposals).
  useProjectStore.subscribe((state, previous) => {
    if (state.project === previous.project) return;
    useAgentReviewStore
      .getState()
      .invalidate('The template changed. Ask the assistant to regenerate this proposal.');
    if (state.project.id !== previous.project.id) {
      useAgentChatStore.getState().setState({ projectUsage: readProjectUsage(state.project.id) });
    }
  });
  ensureBridgeForAI();
  sendProposalDecision = (payload: unknown) => {
    void decideAiProposal(payload);
  };
}

export function setAgentChatExclusive(enabled: boolean): void {
  sendChatPayload?.({ type: 'chat.exclusive', enabled });
}

/** Activity replaces one status line; it must never append or patch transcript rows. */
export function updateAgentChatActivity(
  message: Extract<
    BridgeMessage,
    { type: 'chat.progress' | 'chat.text' | 'chat.tool' | 'chat.proposal' }
  >,
): void {
  const chat = useAgentChatStore.getState();
  if (chat.activeTurnId !== message.turnId) return;
  let text: string;
  let phase: ChatProgress['phase'] = 'continuing';
  let round = chat.progress?.round ?? 1;
  if (message.type === 'chat.progress') {
    text = message.message;
    phase = message.phase;
    round = message.round;
  } else if (message.type === 'chat.tool') {
    text = `${message.status === 'running' ? 'Running' : message.status === 'ok' ? 'Done' : 'Error'}: ${message.summary}`;
    phase =
      message.status === 'running' ? 'tool' : message.status === 'error' ? 'error' : 'continuing';
  } else if (message.type === 'chat.proposal') {
    text = 'Proposal ready for review';
  } else {
    text = message.text;
  }
  chat.setState({
    progress: { phase, message: text, round, updatedAt: Date.now() },
    ...(message.type === 'chat.text' ? { pendingAssistantText: message.text } : {}),
  });
}

export function finishAgentChatTurn(
  message: Extract<BridgeMessage, { type: 'chat.turn.end' }>,
): void {
  const chat = useAgentChatStore.getState();
  if (chat.activeTurnId !== message.turnId) return;
  const projectId = useProjectStore.getState().project.id;
  const projectUsage = addUsage(readProjectUsage(projectId), message.usage);
  persistProjectUsage(projectId, projectUsage);
  const cancelled = message.stopReason === 'cancelled';
  chat.setState({
    activeTurnId: null,
    activeTurnStartedAt: null,
    pendingAssistantText: '',
    progress: {
      phase: 'complete',
      message: cancelled
        ? 'Cancelled'
        : useAgentReviewStore.getState().proposals.length
          ? 'Proposal ready for review'
          : 'Completed',
      round: chat.progress?.round ?? 1,
      updatedAt: Date.now(),
    },
    sessionUsage: addUsage(chat.sessionUsage, message.usage),
    projectUsage,
  });
  chat.addEntry({
    id: `assistant-${message.turnId}`,
    turnId: message.turnId,
    kind: 'assistant',
    text: cancelled ? 'Cancelled.' : chat.pendingAssistantText,
    usage: message.usage,
  });
}

type BridgeMessage =
  | { type: 'editor.ack'; revision: number }
  | { type: 'editor.error'; message: string }
  | { type: 'heartbeat.request'; requestId: string }
  | {
      type: 'project.replace';
      revision: number;
      project: Project;
      source: string;
      reason?: string;
      summary?: { operationCount?: number; operationTypes?: string[] };
    }
  | { type: 'certification.request'; requestId: string; artifacts: ExportArtifacts }
  | { type: 'capture.request'; requestId: string; request: AgentCaptureRequest }
  | { type: 'strip.request'; requestId: string; request: AgentStripRequest }
  | { type: 'measure-text.request'; requestId: string; request: AgentMeasureTextRequest }
  | { type: 'proposal.present'; proposal: AgentAuthoringProposal }
  | {
      type: 'proposal.resolved';
      proposalId: string;
      result: { status: string; message: string; revision?: number };
    }
  | { type: 'editor.replaced'; message: string }
  | {
      type: 'chat.config';
      configured: boolean;
      exclusive: boolean;
      provider?: string;
      model?: string;
      message?: string;
    }
  | { type: 'chat.external'; active: boolean }
  | { type: 'chat.turn.start'; turnId: string }
  | {
      type: 'chat.progress';
      turnId: string;
      phase: 'waiting' | 'continuing';
      message: string;
      round: number;
    }
  | { type: 'chat.text'; turnId: string; text: string }
  | {
      type: 'chat.tool';
      turnId: string;
      callId: string;
      name: string;
      summary: string;
      status: 'running' | 'ok' | 'error';
    }
  | { type: 'chat.proposal'; turnId: string; proposalId: string }
  | { type: 'chat.turn.end'; turnId: string; stopReason: string; usage: ChatUsage }
  | { type: 'chat.error'; turnId: string; message: string };

const BRIDGE_URL = resolveAgentBridgeUrl(
  import.meta.env.VITE_OGRAF_AGENT_BRIDGE_URL,
  window.location,
);

// Fork (OG-049): the upstream localhost agent bridge is DISABLED unless
// explicitly configured — with no `VITE_OGRAF_AGENT_BRIDGE_URL` the editor
// must not attempt `ws://127.0.0.1:4318/editor` at all (no local MCP server
// is part of this deployment; remote tooling uses the in-tab WebMCP host /
// opt-in gateway socket instead). Set the env to re-enable the local bridge.
const BRIDGE_ENABLED = Boolean(import.meta.env.VITE_OGRAF_AGENT_BRIDGE_URL?.trim());

/** Keeps the live browser document and the local MCP authoring session synchronized. */
export function useAgentBridge(): void {
  useEffect(() => {
    if (!BRIDGE_ENABLED) return;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | undefined;
    let syncTimer: number | undefined;
    let stopped = false;
    let applyingRemote = false;
    let replaced = false;
    // Certification, raster capture, frame strips, and text measurement all exercise the same
    // browser renderer/font resources. Serialize them so a heavy strip cannot overlap a save gate
    // or leave shared renderer state half-disposed for the next request.
    let browserWorkQueue: Promise<void> = Promise.resolve();
    const queuedProposalCapture: ProposalCapture = (request, isCurrent) => {
      const result = browserWorkQueue
        .catch(() => undefined)
        .then(() => (isCurrent() ? captureAgentPng(request) : null));
      browserWorkQueue = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    };
    proposalCapture = queuedProposalCapture;
    const status = useAgentBridgeStatus.getState().setStatus;

    const send = (payload: unknown) => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
    };
    sendProposalDecision = send;
    sendChatPayload = send;

    const unsubscribe = useProjectStore.subscribe((state, previous) => {
      if (state.project === previous.project || applyingRemote) return;
      useAgentReviewStore
        .getState()
        .invalidate('The template changed. Ask the assistant to regenerate this proposal.');
      if (state.project.id !== previous.project.id) {
        useAgentChatStore.getState().setState({ projectUsage: readProjectUsage(state.project.id) });
      }
      window.clearTimeout(syncTimer);
      syncTimer = window.setTimeout(() => {
        syncTimer = undefined;
        send({
          type: 'editor.project',
          project: useProjectStore.getState().project,
          reason: 'UI edit',
        });
      }, 150);
    });

    const connect = () => {
      if (stopped) return;
      socket = new WebSocket(BRIDGE_URL);
      socket.addEventListener('open', () => {
        if (stopped) {
          socket?.close();
          return;
        }
        status({ connected: true, authoritative: true, activity: 'Agent connected' });
        send({ type: 'editor.hello', project: useProjectStore.getState().project });
      });
      socket.addEventListener('message', async (event) => {
        let message: BridgeMessage;
        try {
          message = JSON.parse(String(event.data)) as BridgeMessage;
        } catch {
          return;
        }
        if (message.type === 'editor.ack') {
          useAgentReviewStore
            .getState()
            .invalidate(
              'The template changed. Ask the assistant to regenerate this proposal.',
              message.revision,
            );
          const prior = useAgentBridgeStatus.getState();
          status({
            revision: message.revision,
            ...(prior.activity.startsWith('The editor update could not be synchronized:')
              ? { activity: 'Agent connected' }
              : {}),
          });
          return;
        }
        if (message.type === 'editor.error') {
          status({ activity: message.message });
          return;
        }
        if (message.type === 'editor.replaced') {
          useAgentReviewStore.getState().invalidate('This editor is no longer the active session.');
          replaced = true;
          status({ connected: false, authoritative: false, activity: message.message });
          return;
        }
        if (message.type === 'chat.config') {
          useAgentChatStore.getState().setState({
            configured: message.configured,
            exclusive: message.exclusive,
            provider: message.provider ?? null,
            model: message.model ?? null,
            configMessage: message.message ?? null,
            projectUsage: readProjectUsage(useProjectStore.getState().project.id),
          });
          return;
        }
        if (message.type === 'chat.external') {
          useAgentChatStore.getState().setState({ externalAgentActive: message.active });
          return;
        }
        if (message.type === 'chat.turn.start') {
          const chat = useAgentChatStore.getState();
          chat.setState({
            activeTurnId: message.turnId,
            pendingAssistantText: '',
            activeTurnStartedAt: chat.activeTurnStartedAt ?? Date.now(),
            progress: {
              phase: 'waiting',
              message: 'Preparing model request',
              round: 1,
              updatedAt: Date.now(),
            },
          });
          return;
        }
        if (
          message.type === 'chat.progress' ||
          message.type === 'chat.text' ||
          message.type === 'chat.tool' ||
          message.type === 'chat.proposal'
        ) {
          updateAgentChatActivity(message);
          return;
        }
        if (message.type === 'chat.turn.end') {
          finishAgentChatTurn(message);
          return;
        }
        if (message.type === 'chat.error') {
          const chat = useAgentChatStore.getState();
          chat.setState({
            activeTurnId: null,
            activeTurnStartedAt: null,
            pendingAssistantText: '',
            progress: {
              phase: 'error',
              message: message.message,
              round: chat.progress?.round ?? 1,
              updatedAt: Date.now(),
            },
          });
          chat.addEntry({
            id: `error-${message.turnId}`,
            turnId: message.turnId,
            kind: 'error',
            text: message.message,
          });
          return;
        }
        if (message.type === 'heartbeat.request') {
          window.setTimeout(
            () => send({ type: 'heartbeat.result', requestId: message.requestId }),
            0,
          );
          return;
        }
        if (message.type === 'project.replace') {
          window.clearTimeout(syncTimer);
          syncTimer = undefined;
          useAgentReviewStore
            .getState()
            .invalidate(
              'The template changed. Ask the assistant to regenerate this proposal.',
              message.revision,
            );
          applyingRemote = true;
          try {
            applyRemoteProjectUpdate(message.project, message);
          } finally {
            applyingRemote = false;
          }
          const count = message.summary?.operationCount;
          const detail = message.reason || message.summary?.operationTypes?.join(', ');
          const sourceLabel =
            message.source === 'agent'
              ? 'Agent'
              : message.source === 'undo'
                ? 'Agent undo'
                : message.source === 'redo'
                  ? 'Agent redo'
                  : 'Agent update';
          status({
            revision: message.revision,
            activity: `${sourceLabel}: ${count ? `${count} change${count === 1 ? '' : 's'}` : 'project updated'}${detail ? ` — ${detail}` : ''}`,
          });
          return;
        }
        if (message.type === 'proposal.present') {
          const stale =
            syncTimer !== undefined ||
            message.proposal.baseRevision !== useAgentBridgeStatus.getState().revision;
          useTimelineStore.getState().controller?.pause();
          useTimelineStore.getState().setPreviewLoopLayerId(null);
          useAgentReviewStore
            .getState()
            .present(
              message.proposal,
              useProjectStore.getState().project,
              stale
                ? 'The template changed. Ask the assistant to regenerate this proposal.'
                : undefined,
            );
          status({ activity: `Review requested: ${message.proposal.title}` });
          return;
        }
        if (message.type === 'proposal.resolved') {
          const reviewed = useAgentReviewStore
            .getState()
            .proposals.find((item) => item.id === message.proposalId);
          if (message.result.status === 'accepted' && reviewed) {
            const state = useProjectStore.getState();
            const composition = state.project.compositions.find(
              (item) => item.id === (reviewed.compositionId ?? state.project.mainCompositionId),
            );
            if (composition) {
              useProjectStore.setState({ activeCompositionId: composition.id });
              useTimelineStore
                .getState()
                .setCurrentFrame(Math.min(reviewed.previewFrame, getTotalFrames(composition)));
            }
          }
          useAgentReviewStore.getState().resolve(message.proposalId, message.result);
          if (!useAgentChatStore.getState().activeTurnId)
            useAgentChatStore.getState().setState({
              progress: {
                phase: 'complete',
                message: message.result.message,
                round: 1,
                updatedAt: Date.now(),
              },
            });
          status({
            revision: message.result.revision ?? useAgentBridgeStatus.getState().revision,
            activity: message.result.message,
          });
          return;
        }
        if (message.type === 'certification.request') {
          browserWorkQueue = browserWorkQueue
            .catch(() => undefined)
            .then(async () => {
              status({ activity: 'Agent requested OGraf certification…' });
              try {
                const result = await certifyExportArtifacts(message.artifacts);
                send({ type: 'certification.result', requestId: message.requestId, result });
                status({
                  activity: result.valid
                    ? 'Agent output OGraf certified'
                    : 'Agent output certification failed',
                });
              } catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                send({
                  type: 'certification.result',
                  requestId: message.requestId,
                  result: { valid: false, checks: [], errors: [detail] },
                });
                status({ activity: 'Agent output certification failed' });
              }
            });
          return;
        }
        if (message.type === 'capture.request') {
          browserWorkQueue = browserWorkQueue
            .catch(() => undefined)
            .then(async () => {
              status({ activity: 'Agent requested PNG capture…' });
              try {
                const result = await captureAgentPng(message.request);
                send({ type: 'capture.result', requestId: message.requestId, result });
                status({ activity: 'Agent PNG capture ready' });
              } catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                send({ type: 'capture.result', requestId: message.requestId, error: detail });
                status({ activity: 'Agent PNG capture failed' });
              }
            });
          return;
        }
        if (message.type === 'strip.request') {
          browserWorkQueue = browserWorkQueue
            .catch(() => undefined)
            .then(async () => {
              status({ activity: 'Agent requested PNG frame strip…' });
              try {
                const result = await renderAgentStripPng(message.request);
                send({ type: 'strip.result', requestId: message.requestId, result });
                status({ activity: 'Agent PNG frame strip ready' });
              } catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                send({ type: 'strip.result', requestId: message.requestId, error: detail });
                status({ activity: 'Agent PNG frame strip failed' });
              }
            });
          return;
        }
        if (message.type === 'measure-text.request') {
          browserWorkQueue = browserWorkQueue
            .catch(() => undefined)
            .then(async () => {
              status({ activity: 'Agent requested text measurement…' });
              try {
                const result = await measureAgentText(message.request);
                send({ type: 'measure-text.result', requestId: message.requestId, result });
                status({ activity: 'Agent text measurement ready' });
              } catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                send({ type: 'measure-text.result', requestId: message.requestId, error: detail });
                status({ activity: 'Agent text measurement failed' });
              }
            });
        }
      });
      socket.addEventListener('close', () => {
        // React StrictMode intentionally mounts, cleans up, and remounts effects in development.
        // The disposed bridge must not overwrite the status of its replacement connection.
        if (stopped) return;
        useAgentReviewStore
          .getState()
          .invalidate('Connection lost. Reconnect before reviewing this proposal.');
        const chat = useAgentChatStore.getState();
        if (chat.activeTurnId) {
          chat.addEntry({
            id: `error-${chat.activeTurnId}-disconnect`,
            turnId: chat.activeTurnId,
            kind: 'error',
            text: 'The agent connection closed before the turn finished. Reconnect, then retry.',
          });
          chat.setState({
            activeTurnId: null,
            activeTurnStartedAt: null,
            pendingAssistantText: '',
            progress: {
              phase: 'error',
              message: 'Connection lost',
              round: 1,
              updatedAt: Date.now(),
            },
          });
        }
        status({ connected: false, revision: null, activity: 'Agent bridge offline' });
        if (!replaced) reconnectTimer = window.setTimeout(connect, 3000);
      });
      socket.addEventListener('error', () => socket?.close());
    };

    connect();
    return () => {
      stopped = true;
      window.clearTimeout(reconnectTimer);
      window.clearTimeout(syncTimer);
      unsubscribe();
      if (sendProposalDecision === send) sendProposalDecision = null;
      if (sendChatPayload === send) sendChatPayload = null;
      if (proposalCapture === queuedProposalCapture) proposalCapture = directProposalCapture;
      socket?.close();
    };
  }, []);
}
