import Docker from 'dockerode';
import * as path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import tar from 'tar-stream';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../utils/logger.js';

export interface SandboxInfo {
  sandboxId: string;
  containerId: string;
  image: string;
  status: 'running' | 'stopped' | 'destroyed';
  createdAt: string;
  memoryLimitMb: number;
}

export interface CreateSandboxOptions {
  image?: string;
  memoryLimitMb?: number;
  cpuLimit?: number;
  env?: Record<string, string>;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  executionTimeMs: number;
  timedOut: boolean;
}

export class SandboxManager {
  private docker: Docker;
  private sandboxes: Map<string, { container: Docker.Container; info: SandboxInfo }> = new Map();

  constructor() {
    const isWindows = process.platform === 'win32';
    if (process.env.DOCKER_HOST) {
      this.docker = new Docker();
    } else if (isWindows) {
      // Connect to Docker Desktop on Windows named pipe
      this.docker = new Docker({ socketPath: '//./pipe/docker_engine' });
    } else {
      // Connect to Unix socket on Linux/macOS
      this.docker = new Docker({ socketPath: '/var/run/docker.sock' });
    }

    logger.info('SandboxManager initialized Docker client', {
      platform: process.platform,
      host: process.env.DOCKER_HOST || (isWindows ? '//./pipe/docker_engine' : '/var/run/docker.sock'),
    });
  }

  /**
   * Ping Docker daemon to ensure availability
   */
  public async ping(): Promise<boolean> {
    try {
      await this.docker.ping();
      return true;
    } catch (err) {
      logger.error('Failed to ping Docker daemon', { error: String(err) });
      return false;
    }
  }

  /**
   * Validate relative path to prevent directory traversal
   */
  public validateRelativePath(userPath: string): string {
    if (!userPath || typeof userPath !== 'string') {
      throw new Error('Path must be a non-empty string');
    }

    // Convert Windows backslashes to forward slashes for POSIX container compliance
    const normalized = path.posix.normalize(userPath.replace(/\\/g, '/')).replace(/^\/+/, '');

    if (
      normalized.startsWith('..') ||
      path.posix.isAbsolute(userPath) ||
      userPath.includes('\0') ||
      /^[a-zA-Z]:/.test(userPath)
    ) {
      throw new Error(
        `Security Violation: Path traversal rejected for "${userPath}". Paths must be relative to /workspace and cannot escape root.`
      );
    }

    return normalized;
  }

  /**
   * Pull Docker image if not already present locally
   */
  private async ensureImage(image: string): Promise<void> {
    try {
      const images = await this.docker.listImages();
      const exists = images.some((img) =>
        img.RepoTags?.some(
          (tag) => tag === image || tag === `docker.io/library/${image}` || tag.endsWith(`/${image}`)
        )
      );
      if (exists) {
        logger.debug(`Image "${image}" found locally.`);
        return;
      }
    } catch (listErr) {
      logger.warn(`Failed to check local images: ${listErr}`);
    }

    logger.info(`Image "${image}" not found locally. Pulling image...`);
    await new Promise<void>((resolve, reject) => {
      this.docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => {
        if (err) {
          return reject(err);
        }
        this.docker.modem.followProgress(
          stream,
          (pullErr) => {
            if (pullErr) {
              return reject(pullErr);
            }
            logger.info(`Successfully pulled image "${image}".`);
            resolve();
          },
          (event) => {
            if (event && event.status) {
              logger.debug(`Docker pull [${image}]: ${event.status}`);
            }
          }
        );
      });
    });
  }

  /**
   * Spin up a new isolated Docker container sandbox
   */
  public async createSandbox(options: CreateSandboxOptions = {}): Promise<SandboxInfo> {
    const sandboxId = uuidv4();
    const image = options.image || 'node:20-alpine';
    const memoryLimitMb = options.memoryLimitMb || 512;
    const cpuLimit = options.cpuLimit || 1;

    logger.info(`Creating sandbox [${sandboxId}] with image ${image}...`);

    await this.ensureImage(image);

    const envList = options.env
      ? Object.entries(options.env).map(([k, v]) => `${k}=${v}`)
      : [];

    const container = await this.docker.createContainer({
      Image: image,
      name: `mcp-sandbox-${sandboxId.substring(0, 8)}`,
      Cmd: ['sh', '-c', 'trap : TERM INT; sleep infinity & wait'],
      WorkingDir: '/workspace',
      Env: ['TERM=xterm-256color', 'LANG=C.UTF-8', ...envList],
      Labels: {
        'mcp-sandbox': 'true',
        'mcp-sandbox-id': sandboxId,
      },
      HostConfig: {
        Memory: memoryLimitMb * 1024 * 1024,
        NanoCpus: Math.floor(cpuLimit * 1e9),
        NetworkMode: 'bridge',
        AutoRemove: false,
      },
    });

    await container.start();

    // Ensure /workspace exists inside container
    const exec = await container.exec({
      Cmd: ['mkdir', '-p', '/workspace'],
      AttachStdout: true,
      AttachStderr: true,
    });
    await exec.start({ hijack: true, stdin: false });

    const info: SandboxInfo = {
      sandboxId,
      containerId: container.id,
      image,
      status: 'running',
      createdAt: new Date().toISOString(),
      memoryLimitMb,
    };

    this.sandboxes.set(sandboxId, { container, info });
    logger.info(`Sandbox [${sandboxId}] created and running (container: ${container.id.substring(0, 12)}).`);

    return info;
  }

  /**
   * Get active container for a sandboxId
   */
  private getContainer(sandboxId: string): Docker.Container {
    const entry = this.sandboxes.get(sandboxId);
    if (!entry || entry.info.status !== 'running') {
      throw new Error(`Sandbox "${sandboxId}" not found or not running.`);
    }
    return entry.container;
  }

  /**
   * Write a file inside the sandbox container safely
   */
  public async writeFile(sandboxId: string, relativePath: string, content: string): Promise<{ success: boolean; bytesWritten: number; path: string }> {
    const safePath = this.validateRelativePath(relativePath);
    const container = this.getContainer(sandboxId);

    logger.debug(`Writing file to sandbox [${sandboxId}] at /workspace/${safePath}`);

    // Use tar stream to safely upload file into container
    const pack = tar.pack();
    const contentBuffer = Buffer.from(content, 'utf8');

    // Create intermediate directory entries inside tar archive
    const pathParts = safePath.split('/');
    if (pathParts.length > 1) {
      let currentDir = '';
      for (let i = 0; i < pathParts.length - 1; i++) {
        currentDir = currentDir ? `${currentDir}/${pathParts[i]}` : pathParts[i];
        pack.entry({ name: currentDir, type: 'directory', mode: 0o755 });
      }
    }

    pack.entry(
      {
        name: safePath,
        size: contentBuffer.length,
        mode: 0o644,
      },
      contentBuffer
    );
    pack.finalize();

    const tarChunks: Buffer[] = [];
    for await (const chunk of pack) {
      tarChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as any));
    }
    const tarBuffer = Buffer.concat(tarChunks);

    await container.putArchive(tarBuffer, { path: '/workspace' });

    logger.info(`File successfully written to sandbox [${sandboxId}] at /workspace/${safePath} (${contentBuffer.length} bytes).`);

    return {
      success: true,
      bytesWritten: contentBuffer.length,
      path: safePath,
    };
  }

  /**
   * Read file content from inside sandbox container safely
   */
  public async readFile(sandboxId: string, relativePath: string): Promise<{ content: string; path: string; size: number }> {
    const safePath = this.validateRelativePath(relativePath);
    const container = this.getContainer(sandboxId);

    logger.debug(`Reading file from sandbox [${sandboxId}] at /workspace/${safePath}`);

    try {
      const stream = await container.getArchive({ path: `/workspace/${safePath}` });
      const extract = tar.extract();

      return await new Promise<{ content: string; path: string; size: number }>((resolve, reject) => {
        let fileContent = '';
        let found = false;

        extract.on('entry', (header, entryStream, next) => {
          const chunks: Buffer[] = [];
          entryStream.on('data', (chunk: any) => chunks.push(Buffer.from(chunk)));
          entryStream.on('end', () => {
            if (!found) {
              found = true;
              fileContent = Buffer.concat(chunks).toString('utf8');
            }
            next();
          });
          entryStream.resume();
        });

        extract.on('finish', () => {
          if (!found) {
            reject(new Error(`File not found: ${safePath}`));
          } else {
            resolve({
              content: fileContent,
              path: safePath,
              size: Buffer.byteLength(fileContent),
            });
          }
        });

        extract.on('error', (err) => reject(err));

        if (stream instanceof Readable) {
          stream.pipe(extract);
        } else {
          Readable.from(stream as any).pipe(extract);
        }
      });
    } catch (err) {
      logger.error(`Error reading file "${safePath}" from sandbox [${sandboxId}]`, { error: String(err) });
      throw new Error(`Failed to read file "${safePath}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Execute a shell command inside the sandbox with strict timeout and demuxed streams
   */
  public async executeCommand(
    sandboxId: string,
    command: string,
    timeoutMs: number = 30000,
    workingDir?: string
  ): Promise<CommandResult> {
    const container = this.getContainer(sandboxId);
    const effectiveWorkingDir = workingDir
      ? `/workspace/${this.validateRelativePath(workingDir)}`
      : '/workspace';

    logger.info(`Executing command in sandbox [${sandboxId}] [dir: ${effectiveWorkingDir}]: "${command}"`);

    const startTime = Date.now();

    const exec = await container.exec({
      Cmd: ['/bin/sh', '-c', command],
      AttachStdout: true,
      AttachStderr: true,
      WorkingDir: effectiveWorkingDir,
      Env: ['TERM=xterm-256color', 'LANG=C.UTF-8'],
    });

    const stream = await exec.start({ hijack: true, stdin: false });

    const stdoutStream = new PassThrough();
    const stderrStream = new PassThrough();

    let stdoutData = '';
    let stderrData = '';

    stdoutStream.on('data', (chunk: Buffer) => {
      stdoutData += chunk.toString('utf8');
    });

    stderrStream.on('data', (chunk: Buffer) => {
      stderrData += chunk.toString('utf8');
    });

    // Demux multiplexed Docker stream into stdout and stderr
    this.docker.modem.demuxStream(stream, stdoutStream, stderrStream);

    return new Promise<CommandResult>((resolve) => {
      let completed = false;
      let timedOut = false;

      const timer = setTimeout(async () => {
        if (!completed) {
          timedOut = true;
          completed = true;
          logger.warn(`Command timed out after ${timeoutMs}ms in sandbox [${sandboxId}]: "${command}"`);
          
          try {
            // Attempt to destroy the stream to unblock
            (stream as any).destroy?.();
          } catch {
            // ignore
          }

          resolve({
            stdout: stdoutData,
            stderr: stderrData + `\n[MCP Sandbox] Command execution timed out after ${timeoutMs}ms`,
            exitCode: 124, // Standard Linux timeout exit code
            executionTimeMs: Date.now() - startTime,
            timedOut: true,
          });
        }
      }, timeoutMs);

      stream.on('end', async () => {
        if (completed) return;
        completed = true;
        clearTimeout(timer);

        try {
          const inspectData = await exec.inspect();
          const exitCode = inspectData.ExitCode !== null ? inspectData.ExitCode : 0;
          const executionTimeMs = Date.now() - startTime;

          logger.info(`Command finished in ${executionTimeMs}ms (exitCode: ${exitCode})`);

          resolve({
            stdout: stdoutData,
            stderr: stderrData,
            exitCode,
            executionTimeMs,
            timedOut: false,
          });
        } catch (inspectErr) {
          resolve({
            stdout: stdoutData,
            stderr: stderrData + `\nError inspecting exec: ${inspectErr}`,
            exitCode: 1,
            executionTimeMs: Date.now() - startTime,
            timedOut: false,
          });
        }
      });

      stream.on('error', (streamErr) => {
        if (completed) return;
        completed = true;
        clearTimeout(timer);

        resolve({
          stdout: stdoutData,
          stderr: stderrData + `\nStream error: ${streamErr.message}`,
          exitCode: 1,
          executionTimeMs: Date.now() - startTime,
          timedOut: false,
        });
      });
    });
  }

  /**
   * Stop and remove a sandbox container
   */
  public async destroySandbox(sandboxId: string): Promise<{ success: boolean; message: string }> {
    const entry = this.sandboxes.get(sandboxId);
    if (!entry) {
      throw new Error(`Sandbox "${sandboxId}" not found.`);
    }

    logger.info(`Destroying sandbox [${sandboxId}] (container: ${entry.container.id.substring(0, 12)})...`);

    try {
      await entry.container.stop({ t: 1 }).catch(() => {});
      await entry.container.remove({ force: true, v: true });
      entry.info.status = 'destroyed';
      this.sandboxes.delete(sandboxId);

      logger.info(`Sandbox [${sandboxId}] destroyed.`);
      return { success: true, message: `Sandbox ${sandboxId} successfully destroyed.` };
    } catch (err) {
      logger.error(`Error destroying sandbox [${sandboxId}]`, { error: String(err) });
      this.sandboxes.delete(sandboxId);
      throw new Error(`Failed to destroy sandbox: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Get list of active sandboxes
   */
  public listSandboxes(): SandboxInfo[] {
    return Array.from(this.sandboxes.values()).map((s) => s.info);
  }

  /**
   * Clean up all sandboxes created in this session and any orphaned containers with 'mcp-sandbox=true' label
   */
  public async cleanupAll(): Promise<void> {
    logger.info('Initiating cleanup of all sandbox containers...');

    // Clean up tracked sandboxes
    for (const [id, entry] of this.sandboxes.entries()) {
      try {
        await entry.container.stop({ t: 1 }).catch(() => {});
        await entry.container.remove({ force: true, v: true }).catch(() => {});
        logger.info(`Cleaned up tracked sandbox [${id}]`);
      } catch (err) {
        logger.warn(`Could not remove sandbox [${id}]`, { error: String(err) });
      }
    }
    this.sandboxes.clear();

    // Query docker for any orphaned containers with mcp-sandbox label
    try {
      const containers = await this.docker.listContainers({
        all: true,
        filters: { label: ['mcp-sandbox=true'] },
      });

      for (const info of containers) {
        try {
          const container = this.docker.getContainer(info.Id);
          await container.stop({ t: 1 }).catch(() => {});
          await container.remove({ force: true, v: true }).catch(() => {});
          logger.info(`Cleaned up orphan container [${info.Id.substring(0, 12)}]`);
        } catch (orphanErr) {
          logger.warn(`Failed to remove orphan container [${info.Id}]`, { error: String(orphanErr) });
        }
      }
    } catch (listErr) {
      logger.warn('Failed to list containers for orphan cleanup', { error: String(listErr) });
    }

    logger.info('Sandbox cleanup completed.');
  }
}
