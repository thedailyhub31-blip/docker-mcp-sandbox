import { z } from 'zod';
import { SandboxManager } from '../docker/sandboxManager.js';
import { logger } from '../utils/logger.js';

export const gitInitSchema = z.object({
  sandboxId: z.string().uuid().describe('Target sandbox identifier'),
  initialBranch: z.string().optional().default('main').describe('Initial branch name (default: main)'),
  userEmail: z.string().optional().default('agent@mcp.local').describe('Git author email'),
  userName: z.string().optional().default('AI Agent').describe('Git author name'),
});

export const gitStatusSchema = z.object({
  sandboxId: z.string().uuid().describe('Target sandbox identifier'),
});

export const gitDiffSchema = z.object({
  sandboxId: z.string().uuid().describe('Target sandbox identifier'),
  cached: z.boolean().optional().default(false).describe('If true, shows diff of staged changes'),
  file: z.string().optional().describe('Specific relative file path to diff'),
});

export const gitCommitSchema = z.object({
  sandboxId: z.string().uuid().describe('Target sandbox identifier'),
  message: z.string().min(1).describe('Commit message'),
  addFiles: z.array(z.string()).optional().default(['.']).describe('Files to add to stage (defaults to all: ["."])'),
  authorName: z.string().optional().describe('Author name override'),
  authorEmail: z.string().optional().describe('Author email override'),
});

export const gitLogSchema = z.object({
  sandboxId: z.string().uuid().describe('Target sandbox identifier'),
  maxCount: z.number().int().min(1).max(50).optional().default(10).describe('Max number of commits to return (default 10)'),
});

export function registerGitTools(manager: SandboxManager) {
  return [
    {
      name: 'git_init',
      description: 'Initializes a Git repository in the sandbox workspace and sets default author configs.',
      inputSchema: {
        type: 'object',
        properties: {
          sandboxId: { type: 'string', description: 'Target sandbox identifier' },
          initialBranch: { type: 'string', description: 'Initial branch name (default: main)', default: 'main' },
          userEmail: { type: 'string', description: 'Git author email', default: 'agent@mcp.local' },
          userName: { type: 'string', description: 'Git author name', default: 'AI Agent' },
        },
        required: ['sandboxId'],
      },
      handler: async (args: unknown) => {
        const validated = gitInitSchema.parse(args);
        // Ensure git is installed (in alpine: apk add --no-cache git if needed)
        const checkGit = await manager.executeCommand(validated.sandboxId, 'which git || apk add --no-cache git');
        if (checkGit.exitCode !== 0) {
          logger.warn(`Failed ensuring git package inside sandbox: ${checkGit.stderr}`);
        }

        const cmd = [
          'git config --global --add safe.directory /workspace',
          `git config --global user.email "${validated.userEmail}"`,
          `git config --global user.name "${validated.userName}"`,
          `git init -b "${validated.initialBranch}"`,
        ].join(' && ');

        const result = await manager.executeCommand(validated.sandboxId, cmd);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  initialized: result.exitCode === 0,
                  stdout: result.stdout,
                  stderr: result.stderr,
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
      name: 'git_status',
      description: 'Shows the working tree status in the sandbox repository.',
      inputSchema: {
        type: 'object',
        properties: {
          sandboxId: { type: 'string', description: 'Target sandbox identifier' },
        },
        required: ['sandboxId'],
      },
      handler: async (args: unknown) => {
        const validated = gitStatusSchema.parse(args);
        const result = await manager.executeCommand(validated.sandboxId, 'git status');
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  status: result.stdout,
                  stderr: result.stderr,
                  exitCode: result.exitCode,
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
      name: 'git_diff',
      description: 'Shows changes between commits, commit and working tree, etc.',
      inputSchema: {
        type: 'object',
        properties: {
          sandboxId: { type: 'string', description: 'Target sandbox identifier' },
          cached: { type: 'boolean', description: 'View staged changes', default: false },
          file: { type: 'string', description: 'Specific file path' },
        },
        required: ['sandboxId'],
      },
      handler: async (args: unknown) => {
        const validated = gitDiffSchema.parse(args);
        let cmd = validated.cached ? 'git diff --cached' : 'git diff';
        if (validated.file) {
          const safeFile = manager.validateRelativePath(validated.file);
          cmd += ` -- "${safeFile}"`;
        }

        const result = await manager.executeCommand(validated.sandboxId, cmd);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  diff: result.stdout,
                  stderr: result.stderr,
                  exitCode: result.exitCode,
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
      name: 'git_commit',
      description: 'Stages specified files and creates a Git commit in the sandbox.',
      inputSchema: {
        type: 'object',
        properties: {
          sandboxId: { type: 'string', description: 'Target sandbox identifier' },
          message: { type: 'string', description: 'Commit message' },
          addFiles: {
            type: 'array',
            items: { type: 'string' },
            description: 'Files to add (default: ["."])',
            default: ['.'],
          },
          authorName: { type: 'string', description: 'Override author name' },
          authorEmail: { type: 'string', description: 'Override author email' },
        },
        required: ['sandboxId', 'message'],
      },
      handler: async (args: unknown) => {
        const validated = gitCommitSchema.parse(args);

        // Sanitize add file arguments
        const safeAddArgs = validated.addFiles
          .map((f) => (f === '.' ? '.' : `"${manager.validateRelativePath(f)}"`))
          .join(' ');

        let configPrefix = '';
        if (validated.authorName) {
          configPrefix += `git config user.name "${validated.authorName}" && `;
        }
        if (validated.authorEmail) {
          configPrefix += `git config user.email "${validated.authorEmail}" && `;
        }

        // Escape double quotes in commit message
        const escapedMessage = validated.message.replace(/"/g, '\\"');
        const cmd = `${configPrefix}git add ${safeAddArgs} && git commit -m "${escapedMessage}"`;

        const result = await manager.executeCommand(validated.sandboxId, cmd);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: result.exitCode === 0,
                  output: result.stdout,
                  stderr: result.stderr,
                  exitCode: result.exitCode,
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
      name: 'git_log',
      description: 'Returns recent commit history in the sandbox repository.',
      inputSchema: {
        type: 'object',
        properties: {
          sandboxId: { type: 'string', description: 'Target sandbox identifier' },
          maxCount: { type: 'number', description: 'Maximum commits to return', default: 10 },
        },
        required: ['sandboxId'],
      },
      handler: async (args: unknown) => {
        const validated = gitLogSchema.parse(args);
        const cmd = `git log -n ${validated.maxCount} --pretty=format:'{"hash":"%h","author":"%an","date":"%ad","message":"%s"}' --date=iso`;
        const result = await manager.executeCommand(validated.sandboxId, cmd);

        const commits = result.stdout
          .split('\n')
          .filter((line) => line.trim().length > 0)
          .map((line) => {
            try {
              return JSON.parse(line);
            } catch {
              return { raw: line };
            }
          });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  commits,
                  exitCode: result.exitCode,
                  stderr: result.stderr,
                },
                null,
                2
              ),
            },
          ],
        };
      },
    },
  ];
}
