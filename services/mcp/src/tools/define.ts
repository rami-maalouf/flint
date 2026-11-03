import { isInputRequiredResult, type CallToolResult, type InputRequiredResult, type McpServer,
  type ServerContext } from '@modelcontextprotocol/server';
import type { z } from 'zod';

import { ToolError, type Accounts } from '../accounts.ts';

export type ToolContext = { accountId: string; scopes: ReadonlySet<string>; accounts: Accounts; era: 'legacy' | 'modern' };

// keeps one answer comfortably inside a model's context.
const MAX_RESULT_BYTES = 100_000;

type Definition<Input extends z.ZodObject, Output extends z.ZodObject> = {
  description: string;
  input: Input;
  output: Output;
  // writes are retry-safe through their operation id, so every tool is idempotent.
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
};

export function defineTool<Input extends z.ZodObject, Output extends z.ZodObject>(server: McpServer, name: string,
  definition: Definition<Input, Output>,
  run: (input: z.infer<Input>, ctx: ServerContext) => Promise<z.infer<Output> | InputRequiredResult>) {
  const { readOnlyHint = true, destructiveHint = false } = definition.annotations ?? {};
  server.registerTool(name, {
    description: definition.description,
    inputSchema: definition.input,
    outputSchema: definition.output,
    annotations: { readOnlyHint, destructiveHint, idempotentHint: true, openWorldHint: false },
  }, (async (input: z.infer<Input>, ctx: ServerContext): Promise<CallToolResult | InputRequiredResult> => {
    try {
      const result = await run(input, ctx);
      if (isInputRequiredResult(result)) return result;
      const text = JSON.stringify(result);
      if (Buffer.byteLength(text) > MAX_RESULT_BYTES) {
        throw new ToolError('INVALID_INPUT', 'This result is too large. Ask for a smaller page with limit.');
      }
      return { structuredContent: result, content: [{ type: 'text', text }] };
    } catch (cause) {
      const error = cause instanceof ToolError ? cause
        : new ToolError('UNAVAILABLE', 'Flint could not complete this request. Try again shortly.');
      if (!(cause instanceof ToolError)) console.error(`tool ${name} failed`, cause);
      return { isError: true, content: [{ type: 'text', text: `${error.code}: ${error.message}` }] };
    }
  }) as never);
}
