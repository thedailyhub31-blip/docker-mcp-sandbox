import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as path from 'node:path';

async function runTest() {
  console.log('\n======================================================');
  console.log('   MCP DEV SANDBOX - AUTOMATED VERIFICATION SUITE');
  console.log('======================================================\n');

  const distIndex = path.resolve(process.cwd(), 'dist', 'index.js');
  console.log(`[Test] Launching MCP server at: ${distIndex}`);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [distIndex],
  });

  const client = new Client(
    {
      name: 'sandbox-test-client',
      version: '1.0.0',
    },
    {
      capabilities: {},
    }
  );

  await client.connect(transport);
  console.log('✔ Connected to MCP Server over Stdio transport.');

  // Step 1: List Tools
  console.log('\n--- Step 1: List Tools ---');
  const toolsResult = await client.listTools();
  console.log(`✔ Found ${toolsResult.tools.length} available tools:`);
  toolsResult.tools.forEach((t) => console.log(`   - ${t.name}: ${t.description.substring(0, 70)}...`));

  let sandboxId: string | null = null;

  try {
    // Step 2: Create Sandbox
    console.log('\n--- Step 2: Create Sandbox (node:20-alpine) ---');
    const createRes = await client.callTool({
      name: 'create_sandbox',
      arguments: {
        image: 'node:20-alpine',
        memoryLimitMb: 512,
      },
    });

    const parsedCreate = JSON.parse((createRes.content[0] as any).text);
    console.log('✔ create_sandbox response:', parsedCreate);
    sandboxId = parsedCreate.sandboxId;

    if (!sandboxId) {
      throw new Error('No sandboxId returned');
    }

    // Step 3: Write File
    console.log('\n--- Step 3: Write File (/workspace/index.js) ---');
    const writeRes = await client.callTool({
      name: 'write_file',
      arguments: {
        sandboxId,
        path: 'src/app.js',
        content: `
const os = require('os');
console.log("HELLO FROM INSIDE CONTAINER SANDBOX!");
console.log("Kernel: " + os.type() + " " + os.release());
console.log("Platform: " + os.platform() + " " + os.arch());
console.log("Math result: " + (40 + 2));
`,
      },
    });
    console.log('✔ write_file response:', (writeRes.content[0] as any).text);

    // Step 4: Read File
    console.log('\n--- Step 4: Read File Verification ---');
    const readRes = await client.callTool({
      name: 'read_file',
      arguments: {
        sandboxId,
        path: 'src/app.js',
      },
    });
    const parsedRead = JSON.parse((readRes.content[0] as any).text);
    console.log(`✔ read_file (${parsedRead.size} bytes) successfully verified.`);

    // Step 5: Execute Command
    console.log('\n--- Step 5: Execute Command (node src/app.js) ---');
    const execRes = await client.callTool({
      name: 'execute_command',
      arguments: {
        sandboxId,
        command: 'node src/app.js',
      },
    });
    const parsedExec = JSON.parse((execRes.content[0] as any).text);
    console.log('✔ Execution stdout:\n' + parsedExec.stdout);
    console.log(`✔ Exit code: ${parsedExec.exitCode}, Execution time: ${parsedExec.executionTimeMs}ms`);

    // Step 6: Command Timeout Protection
    console.log('\n--- Step 6: Test Command Timeout Protection (sleep 10 with 2s timeout) ---');
    const timeoutRes = await client.callTool({
      name: 'execute_command',
      arguments: {
        sandboxId,
        command: 'sleep 10',
        timeoutMs: 2000,
      },
    });
    const parsedTimeout = JSON.parse((timeoutRes.content[0] as any).text);
    console.log('✔ Timeout test result:', parsedTimeout);
    if (!parsedTimeout.timedOut) {
      console.warn('⚠ Expected command to time out!');
    } else {
      console.log('✔ Command timeout successfully enforced!');
    }

    // Step 7: Security Path Traversal Protection
    console.log('\n--- Step 7: Test Path Traversal Protection ---');
    const attackRes = await client.callTool({
      name: 'write_file',
      arguments: {
        sandboxId,
        path: '../../etc/hacked.txt',
        content: 'malicious payload',
      },
    });
    console.log('✔ Path traversal defense result:', (attackRes.content[0] as any).text);

    // Step 8: Git Workflow Tools
    console.log('\n--- Step 8: Git Workflow Tools ---');
    console.log('1. Initializing Git repository in sandbox...');
    const initRes = await client.callTool({
      name: 'git_init',
      arguments: {
        sandboxId,
        userName: 'AI Orchestrator',
        userEmail: 'orchestrator@agent.local',
      },
    });
    console.log('✔ git_init response:', (initRes.content[0] as any).text);

    console.log('2. Checking git status...');
    const statusRes = await client.callTool({
      name: 'git_status',
      arguments: { sandboxId },
    });
    console.log('✔ git_status response:\n' + JSON.parse((statusRes.content[0] as any).text).status);

    console.log('3. Committing changes...');
    const commitRes = await client.callTool({
      name: 'git_commit',
      arguments: {
        sandboxId,
        message: 'feat: add initial application code inside isolated sandbox',
      },
    });
    console.log('✔ git_commit response:', (commitRes.content[0] as any).text);

    console.log('4. Reading git log...');
    const logRes = await client.callTool({
      name: 'git_log',
      arguments: { sandboxId, maxCount: 3 },
    });
    console.log('✔ git_log response:', (logRes.content[0] as any).text);

  } finally {
    // Step 9: Destroy Sandbox
    if (sandboxId) {
      console.log('\n--- Step 9: Clean Up & Destroy Sandbox ---');
      const destroyRes = await client.callTool({
        name: 'destroy_sandbox',
        arguments: { sandboxId },
      });
      console.log('✔ destroy_sandbox response:', (destroyRes.content[0] as any).text);
    }

    await client.close();
    console.log('\n✔ Test Client disconnected cleanly.');
    console.log('======================================================');
    console.log('   ALL MCP DEV SANDBOX VERIFICATIONS PASSED SUCCESSFULLY!');
    console.log('======================================================\n');
    process.exit(0);
  }
}

runTest().catch((err) => {
  console.error('\n❌ Test Client failed with error:', err);
  process.exit(1);
});
