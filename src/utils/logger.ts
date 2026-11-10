import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

class Logger {
  private logFilePath: string;
  private logStream: fs.WriteStream | null = null;
  private minLevel: LogLevel = 'DEBUG';

  private readonly levels: Record<LogLevel, number> = {
    DEBUG: 10,
    INFO: 20,
    WARN: 30,
    ERROR: 40,
  };

  constructor() {
    this.logFilePath = path.resolve(__dirname, '../../server.log');
    try {
      this.logStream = fs.createWriteStream(this.logFilePath, { flags: 'a' });
      this.logStream.on('error', () => {
        // Fallback: If unable to open/write file, fallback to process.stderr
        this.logStream = null;
      });
    } catch {
      // Fallback: If unable to open file, process.stderr will be used
      this.logStream = null;
    }
  }

  public setLevel(level: LogLevel): void {
    this.minLevel = level;
  }

  private shouldLog(level: LogLevel): boolean {
    return this.levels[level] >= this.levels[this.minLevel];
  }

  private formatMessage(level: LogLevel, message: string, meta?: unknown): string {
    const timestamp = new Date().toISOString();
    let metaStr = '';
    if (meta !== undefined) {
      try {
        metaStr = ` ${JSON.stringify(meta)}`;
      } catch {
        metaStr = ` [Unserializable Meta]`;
      }
    }
    return `[${timestamp}] [${level.padEnd(5)}] ${message}${metaStr}\n`;
  }

  public log(level: LogLevel, message: string, meta?: unknown): void {
    if (!this.shouldLog(level)) {
      return;
    }

    const formatted = this.formatMessage(level, message, meta);

    // CRITICAL: NEVER write to process.stdout!
    // Write to server.log file
    try {
      if (this.logStream && this.logStream.writable) {
        this.logStream.write(formatted);
      }
    } catch {
      // Fallback: ignore file write errors
    }

    // Mirror to stderr for server operators without disrupting stdio JSON-RPC
    try {
      process.stderr.write(formatted);
    } catch {
      // Fallback: ignore stderr write errors
    }
  }

  public debug(message: string, meta?: unknown): void {
    this.log('DEBUG', message, meta);
  }

  public info(message: string, meta?: unknown): void {
    this.log('INFO', message, meta);
  }

  public warn(message: string, meta?: unknown): void {
    this.log('WARN', message, meta);
  }

  public error(message: string, meta?: unknown): void {
    this.log('ERROR', message, meta);
  }
}

export const logger = new Logger();
