import { z } from 'zod';
import { SandboxManager } from '../docker/sandboxManager.js';
import { logger } from '../utils/logger.js';

export const createSandboxSchema = z.object({
  image: z
    .string()
    .optional()
    .default('node:20-alpine')
    .describe('Docker image to use for the sandbox (e.g. node:20-alpine, python:3.11-slim, alpine:latest)'),
  memoryLimitMb: z
    .number()
    .int()
    .min(128)
    .max(4096)
    .optional()
    .default(512)
    .describe('Container RAM limit in megabytes (default 512MB)'),
  cpuLimit: z
    .number()
    .min(0.2)
    .max(4.0)
    .optional()
    .default(1.0)
    .describe('Container CPU limit in cores (default 1.0)'),
  env: z
    .record(z.string())
    .optional()
    .describe('Environment variables to set inside the sandbox container'),
});

export const writeFileSchema = z.object({
  sandboxId: z.string().uuid().describe('Target sandbox identifier'),
  path: z.string().min(1).describe('Relative file path inside the /workspace directory'),
  content: z.string().describe('UTF-8 text or code content to write to the file'),
});

export const readFileSchema = z.object({
  sandboxId: z.string().uuid().describe('Target sandbox identifier'),
  path: z.string().min(1).describe('Relative file path inside /workspace to read'),
});

export const executeCommandSchema = z.object({
  sandboxId: z.string().uuid().describe('Target sandbox identifier'),
  command: z.string().min(1).describe('Shell command to execute inside the sandbox'),
  timeoutMs: z
    .number()
    .int()
    .min(1000)
    .max(120000)
    .optional()
    .default(30000)
    .describe('Execution timeout in milliseconds (default 30,000ms / 30s)'),
  workingDir: z
    .string()
    .optional()
    .describe('Subdirectory relative to /workspace to execute the command in'),
});

export const destroySandboxSchema = z.object({
  sandboxId: z.string().uuid().describe('Target sandbox identifier to terminate and remove'),
});

export const listSandboxesSchema = z.object({});

export function registerSandboxTools(manager: SandboxManager) {
  return [
    {
      name: 'create_sandbox',
      description:
        'Spawns a new isolated Docker container sandbox with a dedicated /workspace directory, resource quotas, and bash/sh environment.',
      inputSchema: {
        type: 'object',
        properties: {
          image: {
            type: 'string',
            description: 'Docker image to use for the sandbox (e.g. node:20-alpine, python:3.11-slim)',
            default: 'node:20-alpine',
          },
          memoryLimitMb: {
            type: 'number',
            description: 'RAM limit in MB (default 512)',
            default: 512,
          },
          cpuLimit: {
            type: 'number',
            description: 'CPU cores limit (default 1.0)',
            default: 1.0,
          },
          env: {
            type: 'object',
            additionalProperties: { type: 'string' },
            description: 'Optional environment variables',
          },
        },
      },
      handler: async (args: unknown) => {
        const validated = createSandboxSchema.parse(args);
        const info = await manager.createSandbox(validated);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  status: 'created',
                  sandboxId: info.sandboxId,
                  image: info.image,
                  memoryLimitMb: info.memoryLimitMb,
                  workspace: '/workspace',
                  createdAt: info.createdAt,
                },
                null,
                2
              ),
            },
          ],
        };
      },
    },
    {
      name: 'write_file',
      description:
        'Safely creates or overwrites a file at a relative path inside the sandbox /workspace directory. Includes path traversal security checks.',
      inputSchema: {
        type: 'object',
        properties: {
          sandboxId: {
            type: 'string',
            description: 'Sandbox ID',
          },
          path: {
            type: 'string',
            description: 'Relative path inside /workspace (e.g. "src/index.js")',
          },
          content: {
            type: 'string',
            description: 'Text content to write',
          },
        },
        required: ['sandboxId', 'path', 'content'],
      },
      handler: async (args: unknown) => {
        const validated = writeFileSchema.parse(args);
        const result = await manager.writeFile(validated.sandboxId, validated.path, validated.content);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      },
    },
    {
      name: 'read_file',
      description:
        'Safely reads the contents of a file inside the sandbox /workspace directory. Enforces path traversal security checks.',
      inputSchema: {
        type: 'object',
        properties: {
          sandboxId: {
            type: 'string',
            description: 'Sandbox ID',
          },
          path: {
            type: 'string',
            description: 'Relative path inside /workspace to read',
          },
        },
        required: ['sandboxId', 'path'],
      },
      handler: async (args: unknown) => {
        const validated = readFileSchema.parse(args);
        const result = await manager.readFile(validated.sandboxId, validated.path);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  path: result.path,
                  size: result.size,
                  content: result.content,
                },
                null,
                2
              ),
            },
          ],
        };
      },
    },
    {
      name: 'execute_command',
      description:
        'Executes a shell command inside the sandbox container at /workspace with timeout enforcement (default 30s) and captures demuxed stdout, stderr, and exitCode.',
      inputSchema: {
        type: 'object',
        properties: {
          sandboxId: {
            type: 'string',
            description: 'Sandbox ID',
          },
          command: {
            type: 'string',
            description: 'Shell command string (e.g. "npm test" or "python app.py")',
          },
          timeoutMs: {
            type: 'number',
            description: 'Command timeout in milliseconds (default 30,000ms)',
            default: 30000,
          },
          workingDir: {
            type: 'string',
            description: 'Subdirectory inside /workspace (optional)',
          },
        },
        required: ['sandboxId', 'command'],
      },
      handler: async (args: unknown) => {
        const validated = executeCommandSchema.parse(args);
        const result = await manager.executeCommand(
          validated.sandboxId,
          validated.command,
          validated.timeoutMs,
          validated.workingDir
        );
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  stdout: result.stdout,
                  stderr: result.stderr,
                  exitCode: result.exitCode,
                  executionTimeMs: result.executionTimeMs,
                  timedOut: result.timedOut,
                },
                null,
                2
              ),
            },
          ],
        };
      },
    },
    {
      name: 'destroy_sandbox',
      description:
        'Stops and permanently removes an ephemeral Docker sandbox container and frees associated resources.',
      inputSchema: {
        type: 'object',
        properties: {
          sandboxId: {
            type: 'string',
            description: 'Sandbox ID to terminate',
          },
        },
        required: ['sandboxId'],
      },
      handler: async (args: unknown) => {
        const validated = destroySandboxSchema.parse(args);
        const result = await manager.destroySandbox(validated.sandboxId);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      },
    },
    {
      name: 'list_sandboxes',
      description: 'Lists all active Docker sandbox instances managed by this MCP server.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      handler: async () => {
        const sandboxes = manager.listSandboxes();
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ activeSandboxes: sandboxes }, null, 2),
            },
          ],
        };
      },
    },
  ];
}
