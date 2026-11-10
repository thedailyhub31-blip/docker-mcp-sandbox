import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { SandboxManager } from './docker/sandboxManager.js';
import { registerGitTools } from './tools/gitTools.js';
import { registerSandboxTools } from './tools/sandboxTools.js';
import { logger } from './utils/logger.js';

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: unknown) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
}

async function main() {
  logger.info('=== MCP Containerized Sandbox Server starting ===');

  const sandboxManager = new SandboxManager();

  // Test Docker daemon connection
  const isDockerAlive = await sandboxManager.ping();
  if (!isDockerAlive) {
    logger.error('CRITICAL: Docker daemon is unreachable. Verify Docker Desktop or the Docker daemon is active.');
  } else {
    logger.info('Docker daemon connection confirmed active.');
  }

  // Register tools
  const tools: ToolDefinition[] = [
    ...registerSandboxTools(sandboxManager),
    ...registerGitTools(sandboxManager),
  ];

  const toolsMap = new Map<string, ToolDefinition>();
  for (const tool of tools) {
    toolsMap.set(tool.name, tool);
  }

  // Initialize MCP Server
  const server = new Server(
    {
      name: 'mcp-dev-sandbox',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Handle tools listing
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    logger.debug('Received ListToolsRequest');
    return {
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    };
  });

  // Handle tool invocation
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    logger.info(`Received CallToolRequest: [${name}]`, { args });

    const tool = toolsMap.get(name);
    if (!tool) {
      logger.error(`Unknown tool requested: [${name}]`);
      throw new McpError(ErrorCode.MethodNotFound, `Tool not found: ${name}`);
    }

    try {
      const result = await tool.handler(args || {});
      return result;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error(`Tool execution error in [${name}]: ${errorMessage}`);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                error: true,
                tool: name,
                message: errorMessage,
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }
  });

  // Graceful shutdown management
  let isShuttingDown = false;
  const gracefulShutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info(`Shutdown signal received: [${signal}]. Cleaning up resources...`);

    try {
      await sandboxManager.cleanupAll();
      await server.close();
      logger.info('MCP Sandbox Server safely shut down.');
    } catch (err) {
      logger.error('Error during shutdown cleanup', { error: String(err) });
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

  process.on('uncaughtException', (err) => {
    logger.error('Uncaught Exception', { error: err.message, stack: err.stack });
    gracefulShutdown('uncaughtException').catch(() => process.exit(1));
  });

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled Promise Rejection', { reason: String(reason) });
  });

  // Connect stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info('MCP Server listening over Stdio transport.');
}

main().catch((err) => {
  logger.error('Fatal initialization error in MCP server', { error: String(err) });
  process.exit(1);
});
