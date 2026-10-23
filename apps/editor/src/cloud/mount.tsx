/**
 * Cloud mount (additive only). Imported once from `main.tsx` as a side effect.
 * - Consumes a `?souv_token=` / `?auth=` login callback if present.
 * - Registers WebMCP tools when the browser exposes the API.
 * - Starts the opt-in MCP gateway tab bridge.
 * Souv UI lives in the native flows (Menubar Souv menu, Save/Export dialogs).
 * No existing editor module is modified by this file.
 */
import { consumeTokenFromLocation, isSouvLoggedIn, checkCookieSession } from './souvAuth';
import { registerWebMCPTools } from './webmcpHost';
import { consumeAiChatFlagFromLocation, startGatewayBridge } from './gatewaySocket';
import { startAiAssistantBridge } from '../state/agentBridge';

if (typeof window !== 'undefined') {
  consumeAiChatFlagFromLocation();
  consumeTokenFromLocation();
  // A cookie session from another tab isn't visible until probed once.
  if (!isSouvLoggedIn()) void checkCookieSession();
  void registerWebMCPTools().catch(() => undefined);
  startGatewayBridge();
  startAiAssistantBridge();
}
