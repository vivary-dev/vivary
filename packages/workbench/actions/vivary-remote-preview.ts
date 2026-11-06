import { defineAction } from '@agent-native/core/action';
import { remotePreviewInput } from '../shared/remote-preview';
import { remotePreviewCommand } from '../server/preview-ingress.mjs';
export default defineAction({
  description: 'Open or close the paired browser document’s isolated project preview.',
  schema: remotePreviewInput,
  requiresAuth: true, readOnly: false, agentTool: false, mcpTool: false, toolCallable: false,
  audit: { recordInputs: false, target: () => ({ visibility: 'private' }) },
  run: (input, context) => {
    if (!context) throw new Error('Authenticated preview context is unavailable.');
    return remotePreviewCommand(input, context);
  },
});
