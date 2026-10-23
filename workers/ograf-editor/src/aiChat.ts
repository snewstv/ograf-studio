/**
 * Worker AI chat for the in-tab AI Assistant (OG-090/OG-091).
 *
 * POST /ai/chat (SSE) runs the account's DeepSeek Flash model with the 14
 * editor tools as function calls. Tool calls fan out to the ORIGIN TAB's
 * connected editor session through a per-tab GatewayDO stub
 * (POST /internal/tool-call), so the tab executes with its live project
 * and the worker never touches project state itself. Multiple tabs on
 * different projects each resolve to their own stub via tabId.
 *
 * Auth mirrors /mcp: Souv Bearer token verified via auth.ts, no Souv
 * code changes. ograf_apply_operations applies live by default (undoable);
 * propose/dry-run/preview stay proposal-only for human review.
 */
import { MCP_TOOL_DESCRIPTIONS, MCP_TOOL_NAMES, MCP_TOOL_SCHEMAS } from './catalog';
import { bearerToken, sha256Hex, verifySouvToken } from './auth';

export const AI_DEFAULT_MODEL = '@cf/deepseek-ai/deepseek-v4.1-flash-1017';
/** Model turns per request (each turn may fan out to several tab tool calls). */
export const AI_MAX_TURNS = 8;
/** Hard stop across all turns so a looping model cannot spin forever. */
export const AI_MAX_TOOL_CALLS = 24;
/** Rejects oversized prompts before they reach the model. */
export const AI_MAX_TEXT_CHARS = 20_000;
/** Total conversational history budget per request (newest entries win). */
export const AI_MAX_HISTORY_CHARS = 6_000;
/** Editor-context (ambient) budget per request. */
export const AI_MAX_AMBIENT_CHARS = 4_000;
/** Attached area images forwarded per request. */
export const AI_MAX_AREA_IMAGES = 4;
/** Single attached image budget (data-URI chars, ~1.1 MiB of bytes). */
export const AI_MAX_IMAGE_CHARS = 1_500_000;

interface WorkersAiBinding {
  run(model: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface AiChatEnv {
  AI?: WorkersAiBinding;
  AI_MODEL?: string;
  GATEWAY?: DurableObjectNamespace;
  SOUV_API?: string;
}

export interface AiChatDeps {
  verifyToken?: (env: Record<string, unknown>, token: string) => Promise<string | null>;
  runModel?: (model: string, input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  callTabTool?: (
    token: string,
    name: string,
    args: Record<string, unknown>,
  ) => Promise<{ ok: boolean; result?: unknown; error?: string; noTab?: boolean }>;
}

interface IncomingToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** First assistant message of an OpenAI-style chat-completions response. */
function firstChoiceMessage(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object') return null;
  const choices = (raw as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const message = (choices[0] as { message?: unknown } | null)?.message;
  return message && typeof message === 'object' ? (message as Record<string, unknown>) : null;
}

/** Assistant text: legacy response first, then OpenAI choices[0].message.content. */
export function extractAssistantText(output: Record<string, unknown>): string {
  if (typeof output.response === 'string' && output.response) return output.response;
  const content = firstChoiceMessage(output)?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (part): part is { type: 'text'; text: string } =>
          !!part &&
          typeof part === 'object' &&
          typeof (part as { text?: unknown }).text === 'string' &&
          ((part as { type?: unknown }).type === undefined ||
            (part as { type?: unknown }).type === 'text'),
      )
      .map((part) => part.text)
      .join('\n');
  }
  return '';
}

/** Accepts {name, arguments} (Workers AI docs shape); arguments may arrive stringified. */
export function normalizeToolCalls(raw: unknown): IncomingToolCall[] {
  if (!Array.isArray(raw)) return [];
  const calls: IncomingToolCall[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const fn =
      record.function && typeof record.function === 'object'
        ? (record.function as Record<string, unknown>)
        : null;
    const name = record.name ?? fn?.name;
    let args: unknown = record.arguments ?? fn?.arguments ?? {};
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args) as unknown;
      } catch {
        args = {};
      }
    }
    if (typeof name === 'string' && name && args && typeof args === 'object') {
      const id = record.id ?? fn?.id;
      calls.push({
        id: typeof id === 'string' && id ? id : crypto.randomUUID(),
        name,
        args: args as Record<string, unknown>,
      });
      continue;
    }
    // OpenAI custom tool calls: { id, type: 'custom', custom: { name, input } }.
    // input may arrive stringified; otherwise it is dropped (never a surprise shape).
    if (record.type === 'custom' && record.custom && typeof record.custom === 'object') {
      const custom = record.custom as Record<string, unknown>;
      if (typeof custom.name === 'string' && custom.name) {
        let customArgs: unknown = custom.input ?? {};
        if (typeof customArgs === 'string') {
          try {
            customArgs = JSON.parse(customArgs) as unknown;
          } catch {
            customArgs = {};
          }
        }
        if (customArgs && typeof customArgs === 'object') {
          const id = record.id;
          calls.push({
            id: typeof id === 'string' && id ? id : crypto.randomUUID(),
            name: custom.name,
            args: customArgs as Record<string, unknown>,
          });
        }
      }
    }
  }
  return calls;
}

/**
 * Tool calls from either envelope: legacy top-level tool_calls, OpenAI
 * choices[0].message.tool_calls, or the singular function_call fallback.
 */
export function extractToolCalls(output: Record<string, unknown>): IncomingToolCall[] {
  const legacy = normalizeToolCalls(output.tool_calls);
  if (legacy.length > 0) return legacy;
  const message = firstChoiceMessage(output);
  if (!message) return [];
  const calls = normalizeToolCalls(message.tool_calls);
  if (calls.length > 0) return calls;
  const functionCall = message.function_call;
  if (functionCall && typeof functionCall === 'object') {
    return normalizeToolCalls([
      { id: 'call_' + String(Date.now()), ...(functionCall as Record<string, unknown>) },
    ]);
  }
  return [];
}

/**
 * Last-line defense: the parsers only emit plain-object args, but no model
 * quirk may ever turn every tool call into a 400 — coerce and warn (reads
 * need no args; writes re-validate tab-side and fail legibly there).
 */
export function coerceToolArgs(args: unknown, toolName: string): Record<string, unknown> {
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    return args as Record<string, unknown>;
  }
  console.warn('[ai-chat] non-object args for ' + toolName + '; sending {}.');
  return {};
}

/** Function definitions for the model, derived from the shared MCP catalog. */
export function toWorkersAITools(): Array<{
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}> {
  return MCP_TOOL_NAMES.map((name) => ({
    name,
    description: MCP_TOOL_DESCRIPTIONS[name],
    parameters: MCP_TOOL_SCHEMAS[name] ?? { type: 'object', properties: {} },
  }));
}

const SYSTEM_PROMPT = [
  'You are the in-tab authoring assistant for OGraf Studio, a broadcast-graphics editor.',
  'You act through function calls that execute live in the user open editor tab.',
  'Inspect before changing: use ograf_get_project / ograf_query_scene / ograf_inspect_scene to ground every edit.',
  'For ograf_apply_operations: use mode "apply" for the requested edit so it lands live in the tab (it stays undoable); first read the current revision and pass it as expectedRevision. Use mode "propose" only when the change is uncertain or structural and needs human review before landing.',
  'Build every operation with a valid type from the tool schema enum; never invent operation names or fields.',
  'Editing operations always require their nested objects: update_element/update_transform/update_effect/update_effects/set_layer_semantics need a `patch` object plus a layer selector. Example card recolor: {"type":"update_element","layerId":"<id>","patch":{"fill":"#00ff00"}}. A bare {"type":"update_element"} never changes anything.',
  'Adding new content uses creation types, never updates: {"type":"add_layer","kind":"text","name":"<name>","element":{"content":"<visible text>"}} adds a text layer (text layers use the `content` field, never `text`; unknown element fields apply silently with zero visible change).',
  'Shape layers use the full kind names exactly (rectangle, ellipse, text, image, path, pattern, image-sequence, lottie, shader) — never abbreviate to rect or similar; the tab rejects unknown kinds loudly. Example red box: {"type":"add_layer","kind":"rectangle","name":"<name>","transform":{"x":100,"y":100,"width":200,"height":200},"element":{"fill":"#ff0000"}}.',
  'After a tool result reports an error, always retry with fixed arguments before ending the turn; ending right after an error without a retry counts as a failure.',
  'If a tool call fails, fix the arguments and retry within this turn; when you cannot proceed, end with a short explanation, never with silence after an error.',
  'Never claim a change is applied until a tool result confirms it. Proposals surface in the editor for human Accept/Reject, applied only after explicit approval.',
  'Keep replies short; confirm what changed and what to check next.',
].join('\n');

interface TurnMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: unknown;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

function toModelMessages(input: {
  history: Array<{ role: 'user' | 'assistant'; text: string }>;
  text: string;
  ambient?: unknown;
  areaReferences?: Array<{
    instruction?: string;
    frame?: number;
    number?: number;
    image?: { data?: unknown; mime?: unknown };
  }>;
}): TurnMessage[] {
  const messages: TurnMessage[] = [{ role: 'system', content: SYSTEM_PROMPT }];
  // Newest entries win: a long transcript is cut from the oldest side so a
  // single huge conversation cannot blow up every request's context/cost.
  let historyChars = 0;
  const historyMessages: TurnMessage[] = [];
  for (let i = input.history.length - 1; i >= 0; i--) {
    const entry = input.history[i];
    if (!entry || (entry.role !== 'user' && entry.role !== 'assistant')) continue;
    if (typeof entry.text !== 'string' || !entry.text.trim()) continue;
    const text =
      entry.text.length > 2_000 ? entry.text.slice(0, 2_000) + '...(truncated)' : entry.text;
    if (historyChars + text.length > AI_MAX_HISTORY_CHARS) break;
    historyChars += text.length;
    historyMessages.unshift({ role: entry.role, content: text });
  }
  messages.push(...historyMessages);
  const contextParts = ['Request: ' + input.text];
  if (input.ambient !== undefined) {
    try {
      let ambientText = JSON.stringify(input.ambient);
      if (ambientText.length > AI_MAX_AMBIENT_CHARS) {
        ambientText = ambientText.slice(0, AI_MAX_AMBIENT_CHARS) + '...(truncated)';
      }
      if (ambientText.length > 0) contextParts.push('Editor context: ' + ambientText);
    } catch {
      // Non-serializable ambient is dropped; the request text still stands.
    }
  }
  const imageParts: Array<{ type: 'image_url'; image_url: { url: string } }> = [];
  for (const area of (input.areaReferences ?? []).slice(0, AI_MAX_AREA_IMAGES)) {
    const instruction =
      typeof area?.instruction === 'string' && area.instruction.trim()
        ? ' (instruction: ' + area.instruction.trim() + ')'
        : '';
    const data = area?.image?.data;
    if (typeof data === 'string' && data.indexOf('data:') === 0) {
      if (data.length > AI_MAX_IMAGE_CHARS) {
        contextParts.push('Attached area image' + instruction + ' (omitted: exceeds size budget).');
      } else {
        imageParts.push({ type: 'image_url', image_url: { url: data } });
        contextParts.push('Attached area image' + instruction + '.');
      }
    } else if (instruction) {
      contextParts.push('Area note' + instruction + '.');
    }
  }
  const text = contextParts.join('\n');
  messages.push(
    imageParts.length > 0
      ? { role: 'user', content: [{ type: 'text', text: text }, ...imageParts] }
      : { role: 'user', content: text },
  );
  return messages;
}

function sseEncode(payload: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode('data: ' + JSON.stringify(payload) + '\n\n');
}

/**
 * Resolves the per-tab gateway stub for a tool call. The stub name binds the
 * login token AND the origin tab id, so concurrent tabs on different projects
 * never share a bridge slot. Exported for tests.
 */
export async function gatewayStubForCall(
  env: AiChatEnv,
  token: string,
  tabId: string | null,
): Promise<DurableObjectStub | null> {
  const namespace = env.GATEWAY;
  if (!namespace) return null;
  const scope = tabId ? token + '\n' + tabId : token;
  return namespace.get(namespace.idFromName('gateway-' + (await sha256Hex(scope))));
}

async function defaultCallTabTool(
  request: Request,
  env: AiChatEnv,
  token: string,
  tabId: string | null,
  name: string,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; result?: unknown; error?: string; noTab?: boolean }> {
  const stub = await gatewayStubForCall(env, token, tabId);
  if (!stub) {
    return {
      ok: false,
      error:
        'MCP gateway binding is not configured on this worker. Start the worker with its wrangler.toml (durable_objects GATEWAY binding), e.g. bun run worker:dev from the repo root.',
    };
  }
  const url = new URL(request.url);
  url.pathname = '/internal/tool-call';
  let response: Response;
  try {
    response = await stub.fetch(
      new Request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ name: name, args: coerceToolArgs(args, name) }),
      }),
    );
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  try {
    const data = (await response.json()) as {
      ok?: boolean;
      result?: unknown;
      error?: string;
      noTab?: boolean;
    };
    if (data?.ok) return { ok: true, result: data.result ?? null };
    return {
      ok: false,
      error:
        typeof data?.error === 'string' ? data.error : 'Tab call failed (' + response.status + ').',
      noTab: data?.noTab === true,
    };
  } catch {
    return { ok: false, error: 'Tab call failed (' + response.status + ').' };
  }
}

function badRequest(message: string): Response {
  return Response.json({ error: message }, { status: 400 });
}

/**
 * Handles POST /ai/chat. Streams SSE events shaped like the tab's existing
 * BridgeMessage chat events (chat.config, chat.progress, chat.text,
 * chat.tool, chat.proposal, chat.turn.end, chat.error), so the editor reuses
 * its current reducers and review UI unchanged.
 */
export async function handleAiChat(
  request: Request,
  env: Record<string, unknown>,
  deps: AiChatDeps = {},
): Promise<Response> {
  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed. Use POST /ai/chat.' }, { status: 405 });
  }
  const token = bearerToken(request);
  if (!token) {
    return Response.json(
      {
        error:
          'Missing Souv credential. Send Authorization: Bearer <token> (log in with your Souv account).',
      },
      { status: 401 },
    );
  }
  const aiEnv = env as AiChatEnv;
  const verify = deps.verifyToken ?? verifySouvToken;
  if ((await verify(env, token)) === null) {
    return Response.json(
      { error: 'Missing or invalid Souv token. Log in and try again.' },
      { status: 401 },
    );
  }
  if (!aiEnv.AI && !deps.runModel) {
    return Response.json(
      { error: 'Workers AI binding is not configured on this worker.' },
      { status: 500 },
    );
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest('Parse error');
  }
  const record = (body ?? {}) as {
    turnId?: unknown;
    sessionId?: unknown;
    tabId?: unknown;
    text?: unknown;
    ambient?: unknown;
    areaReferences?: unknown;
    history?: unknown;
  };
  if (typeof record.turnId !== 'string' || !record.turnId) return badRequest('Missing turnId.');
  if (typeof record.text !== 'string' || !record.text.trim()) return badRequest('Missing text.');
  if (record.text.length > AI_MAX_TEXT_CHARS) {
    return badRequest('The message is too long for one turn.');
  }
  const history = Array.isArray(record.history)
    ? record.history
        .filter(
          (entry): entry is { role: 'user' | 'assistant'; text: string } =>
            !!entry &&
            typeof entry === 'object' &&
            ((entry as { role?: unknown }).role === 'user' ||
              (entry as { role?: unknown }).role === 'assistant') &&
            typeof (entry as { text?: unknown }).text === 'string',
        )
        .slice(-10)
    : [];
  const areaReferences = Array.isArray(record.areaReferences)
    ? (record.areaReferences as Array<{
        instruction?: string;
        frame?: number;
        number?: number;
        image?: { data?: unknown; mime?: unknown };
      }>)
    : [];
  // Origin-tab routing: tool calls in this turn resolve to the tab that sent
  // the prompt (falls back to the login-wide stub when the client is old).
  const tabId = typeof record.tabId === 'string' && record.tabId ? record.tabId : null;
  const sessionId =
    typeof record.sessionId === 'string' && record.sessionId ? record.sessionId : 'editor';

  const turnId = record.turnId;
  const model =
    typeof aiEnv.AI_MODEL === 'string' && aiEnv.AI_MODEL ? aiEnv.AI_MODEL : AI_DEFAULT_MODEL;
  const runModel =
    deps.runModel ??
    ((name: string, input: Record<string, unknown>) => {
      if (!aiEnv.AI) throw new Error('Workers AI binding is not configured on this worker.');
      return aiEnv.AI.run(name, input) as Promise<Record<string, unknown>>;
    });
  const callTabTool =
    deps.callTabTool ??
    // NOTE: keep the (token, name, args) arity of AiChatDeps.callTabTool.
    // A shorter closure is assignable in TS but silently shifts every
    // argument (the Bearer token landed in `name`, the tool name in `args`
    // and the real args were dropped) — every tab call failed with
    // `Unknown WebMCP tool: <token…>` and nothing was ever applied.
    ((callToken: string, name: string, args: Record<string, unknown>) =>
      defaultCallTabTool(request, aiEnv, callToken, tabId, name, args));

  let aborted = false;
  if (request.signal) {
    request.signal.addEventListener('abort', () => {
      aborted = true;
    });
  }

  const stream = new ReadableStream({
    async start(controller) {
      const send = (payload: Record<string, unknown>) => {
        if (!aborted) controller.enqueue(sseEncode(payload));
      };
      const finish = (payload: Record<string, unknown>) => {
        send(payload);
        controller.close();
      };
      try {
        send({
          type: 'chat.config',
          turnId: turnId,
          configured: true,
          exclusive: false,
          provider: 'workers-ai',
          model: model,
        });
        const messages = toModelMessages({
          history: history,
          text: record.text as string,
          ambient: record.ambient,
          areaReferences: areaReferences,
        });
        const tools = toWorkersAITools();
        let assistantText = '';
        let toolCallCount = 0;
        const totalUsage = emptyUsage();
        for (let turn = 1; turn <= AI_MAX_TURNS; turn++) {
          if (aborted) {
            finish({
              type: 'chat.turn.end',
              turnId: turnId,
              stopReason: 'cancelled',
              usage: emptyUsage(),
            });
            return;
          }
          send({
            type: 'chat.progress',
            turnId: turnId,
            phase: 'continuing',
            message: turn === 1 ? 'Thinking...' : 'Working... (step ' + turn + ')',
            round: turn,
          });
          let output: Record<string, unknown>;
          try {
            output = await runModel(model, { messages: messages, tools: tools });
          } catch (error) {
            finish({
              type: 'chat.error',
              turnId: turnId,
              message: error instanceof Error ? error.message : String(error),
            });
            return;
          }
          const text = extractAssistantText(output);
          if (text) {
            assistantText = assistantText ? assistantText + '\n' + text : text;
            send({ type: 'chat.text', turnId: turnId, text: assistantText });
          }
          // Report cumulative usage: per-turn figures would underreport loops.
          {
            const turnUsage = toUsage(output.usage);
            totalUsage.input += turnUsage.input;
            totalUsage.output += turnUsage.output;
            totalUsage.cacheRead += turnUsage.cacheRead;
          }
          const calls = extractToolCalls(output);
          if (calls.length === 0) {
            finish({
              type: 'chat.turn.end',
              turnId: turnId,
              stopReason: 'done',
              usage: {
                input: totalUsage.input,
                output: totalUsage.output,
                cacheRead: totalUsage.cacheRead,
              },
            });
            return;
          }
          for (const call of calls) {
            toolCallCount += 1;
            if (toolCallCount > AI_MAX_TOOL_CALLS) {
              finish({
                type: 'chat.turn.end',
                turnId: turnId,
                stopReason: 'done',
                usage: {
                  input: totalUsage.input,
                  output: totalUsage.output,
                  cacheRead: totalUsage.cacheRead,
                },
              });
              return;
            }
            send({
              type: 'chat.tool',
              turnId: turnId,
              callId: call.id,
              name: call.name,
              summary: call.name,
              status: 'running',
            });
            const callResult = await callTabTool(token, call.name, call.args);
            send({
              type: 'chat.tool',
              turnId: turnId,
              callId: call.id,
              name: call.name,
              summary: call.name,
              status: callResult.ok ? 'ok' : 'error',
              ...(callResult.ok ? {} : { error: callResult.error ?? 'Tab tool execution failed.' }),
            });
            const resultRecord =
              callResult.ok && callResult.result && typeof callResult.result === 'object'
                ? (callResult.result as Record<string, unknown>)
                : null;
            // Proposal-mode results never mutate: the tab validates but does
            // not apply. Surface them as reviewable proposals so the editor
            // can Accept/Reject them in the AI Assistant panel, then end the
            // turn: the human reviews next, not the model.
            let presentedProposal = false;
            if (
              callResult.ok &&
              resultRecord &&
              resultRecord.mode === 'proposal' &&
              Array.isArray(call.args.operations)
            ) {
              const rawOperations = call.args.operations as Array<Record<string, unknown>>;
              send({
                type: 'chat.proposal',
                turnId: turnId,
                proposalId: crypto.randomUUID(),
                proposal: {
                  title:
                    typeof call.args.title === 'string' && call.args.title
                      ? call.args.title
                      : 'Proposed changes',
                  description:
                    typeof call.args.description === 'string' ? call.args.description : '',
                  operations: call.args.operations,
                  operationTypes: rawOperations.map((operation) =>
                    operation && typeof operation.type === 'string' ? operation.type : 'unknown',
                  ),
                  operationCount: rawOperations.length,
                  sessionId: sessionId,
                },
              });
              presentedProposal = true;
            }
            messages.push({
              role: 'assistant',
              content: text || null,
              tool_calls: [
                {
                  id: call.id,
                  type: 'function',
                  function: { name: call.name, arguments: JSON.stringify(call.args) },
                },
              ],
            });
            messages.push({
              role: 'tool',
              tool_call_id: call.id,
              content: JSON.stringify(
                callResult.ok
                  ? callResult.result
                  : {
                      error: callResult.error ?? 'failed',
                      retry:
                        'Fix the arguments and call the tool again; do not end the turn on this error.',
                    },
              ),
            });
            if (!callResult.ok && callResult.noTab) {
              finish({
                type: 'chat.error',
                turnId: turnId,
                message:
                  'The editor tab that sent this prompt is not connected for tool calls. Keep that tab open and try again.',
              });
              return;
            }
            if (presentedProposal) {
              finish({
                type: 'chat.turn.end',
                turnId: turnId,
                stopReason: 'done',
                usage: {
                  input: totalUsage.input,
                  output: totalUsage.output,
                  cacheRead: totalUsage.cacheRead,
                },
              });
              return;
            }
          }
        }
        finish({
          type: 'chat.turn.end',
          turnId: turnId,
          stopReason: 'done',
          usage: {
            input: totalUsage.input,
            output: totalUsage.output,
            cacheRead: totalUsage.cacheRead,
          },
        });
      } catch (error) {
        finish({
          type: 'chat.error',
          turnId: turnId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
    cancel() {
      aborted = true;
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}

function emptyUsage(): { input: number; output: number; cacheRead: number } {
  return { input: 0, output: 0, cacheRead: 0 };
}

function toUsage(raw: unknown): { input: number; output: number; cacheRead: number } {
  if (!raw || typeof raw !== 'object') return emptyUsage();
  const record = raw as Record<string, unknown>;
  const pick = (keys: string[]): number => {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === 'number' && Number.isFinite(value))
        return Math.max(0, Math.floor(value));
    }
    return 0;
  };
  return {
    input: pick(['prompt_tokens', 'input', 'input_tokens']),
    output: pick(['completion_tokens', 'output', 'output_tokens']),
    cacheRead: pick(['cached_tokens', 'cacheRead', 'cache_read']),
  };
}
