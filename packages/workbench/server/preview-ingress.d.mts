import type { ActionRunContext } from '@agent-native/core/action';
import type { z } from 'zod';
import type { remotePreviewInput, previewHandoff } from '../shared/remote-preview';
export function remotePreviewCommand(input: z.infer<typeof remotePreviewInput>, context: ActionRunContext): Promise<z.infer<typeof previewHandoff> | { closed: true }>;
