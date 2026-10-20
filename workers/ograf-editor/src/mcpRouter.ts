/**
 * Pure MCP JSON-RPC router (no I/O, no sockets): fully unit-testable.
 * The Durable Object owns transport state (tab socket, pending calls) and
 * delegates message handling here.
 */
import {
  MCP_GATEWAY_NAME,
  MCP_GATEWAY_VERSION,
  MCP_TOOL_DESCRIPTIONS,
  MCP_TOOL_NAMES,
  MCP_TOOL_SCHEMAS,
  type MCPToolName,
} from './catalog';

export const KNOWN_PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];
export const LATEST_PROTOCOL_VERSION = KNOWN_PROTOCOL_VERSIONS[KNOWN_PROTOCOL_VERSIONS.length - 1]!;

export const NO_TAB_MESSAGE =
  'No editor tab is connected for this login. Open the OGraf editor, log in with the same Souv account, and keep the tab focused.';
export const NO_TAB_CODE = -32001;

export interface RouterHooks {
  callTab: (name: MCPToolName, args: Record<string, unknown>) => Promise<unknown>;
}

export function parseEnvelope(
  message: unknown,
):
  | { ok: true; id: unknown; method: string; params: Record<string, unknown> }
  | { ok: false; id: unknown } {
  const envelope = (message ?? {}) as {
    jsonrpc?: string;
    id?: unknown;
    method?: string;
    params?: unknown;
  };
  if (envelope.jsonrpc !== '2.0' || typeof envelope.method !== 'string') {
    return { ok: false, id: envelope.id ?? null };
  }
  const params =
    envelope.params && typeof envelope.params === 'object'
      ? (envelope.params as Record<string, unknown>)
      : {};
  return { ok: true, id: envelope.id, method: envelope.method, params };
}

export async function respondToMessage(
  message: unknown,
  hooks: RouterHooks,
): Promise<Record<string, unknown> | undefined> {
  const parsed = parseEnvelope(message);
  if (!parsed.ok) {
    return { jsonrpc: '2.0', id: parsed.id, error: { code: -32600, message: 'Invalid Request' } };
  }
  const { id, method, params } = parsed;
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id, result });
  const fail = (code: number, errorMessage: string) => ({
    jsonrpc: '2.0',
    id,
    error: { code, message: errorMessage },
  });
  switch (method) {
    case 'initialize': {
      const requested = (params.protocolVersion as string | undefined) ?? '';
      return ok({
        protocolVersion: KNOWN_PROTOCOL_VERSIONS.includes(requested)
          ? requested
          : LATEST_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: MCP_GATEWAY_NAME, version: MCP_GATEWAY_VERSION },
      });
    }
    case 'ping':
      return ok({});
    case 'notifications/initialized':
      return undefined;
    case 'tools/list':
      return ok({
        tools: MCP_TOOL_NAMES.map((name) => ({
          name,
          description: MCP_TOOL_DESCRIPTIONS[name],
          inputSchema: MCP_TOOL_SCHEMAS[name],
        })),
      });
    case 'tools/call': {
      const name = params.name as string | undefined;
      const args = (params.arguments as Record<string, unknown> | undefined) ?? {};
      if (!name || !(MCP_TOOL_NAMES as readonly string[]).includes(name)) {
        return fail(-32602, `Unknown tool: ${name ?? '(missing)'}`);
      }
      if (name === 'ograf_get_capabilities') {
        return ok({
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                transport: 'mcp-gateway',
                multiUser: 'isolated-per-token',
                tools: MCP_TOOL_NAMES,
              }),
            },
          ],
        });
      }
      try {
        const result = await hooks.callTab(name as MCPToolName, args);
        return ok({
          content: [
            { type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) },
          ],
        });
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error);
        return fail(messageText === NO_TAB_MESSAGE ? NO_TAB_CODE : -32603, messageText);
      }
    }
    default:
      return fail(-32601, `Method not found: ${method}`);
  }
}
