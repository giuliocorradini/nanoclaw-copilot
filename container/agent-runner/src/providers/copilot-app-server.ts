import fs from 'fs';
import path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { createInterface, type Interface as ReadlineInterface } from 'readline';

function log(msg: string): void {
  console.error(`[copilot-app-server] ${msg}`);
}

const INIT_TIMEOUT_MS = 30_000;

export const STALE_THREAD_RE = /thread\s+not\s+found|unknown\s+thread|thread[_\s]id|no such thread/i;

export function tomlBasicString(value: string, context = 'value'): string {
  if (value.includes('\n') || value.includes('\r')) {
    throw new Error(
      `MCP config ${context} contains newline (not supported in config.toml): ${JSON.stringify(value.slice(0, 40))}${value.length > 40 ? '…' : ''}`,
    );
  }
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

let nextRequestId = 1;

interface JsonRpcRequest {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

export interface JsonRpcResponse {
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification {
  method: string;
  params: Record<string, unknown>;
}

export interface JsonRpcServerRequest {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

type JsonRpcMessage = JsonRpcResponse | JsonRpcNotification | JsonRpcServerRequest;

function makeRequest(method: string, params: Record<string, unknown>): JsonRpcRequest {
  return { id: nextRequestId++, method, params };
}

function isResponse(msg: JsonRpcMessage): msg is JsonRpcResponse {
  return 'id' in msg && ('result' in msg || 'error' in msg) && !('method' in msg);
}

function isServerRequest(msg: JsonRpcMessage): msg is JsonRpcServerRequest {
  return 'id' in msg && 'method' in msg;
}

export interface AppServer {
  process: ChildProcess;
  readline: ReadlineInterface;
  pending: Map<number, { resolve: (r: JsonRpcResponse) => void; reject: (e: Error) => void }>;
  notificationHandlers: ((n: JsonRpcNotification) => void)[];
  serverRequestHandlers: ((r: JsonRpcServerRequest) => void)[];
}

export function spawnCopilotAppServer(configOverrides: string[] = []): AppServer {
  const appServerBin = process.env.COPILOT_APP_SERVER_BIN || 'copilot';
  const args = ['app-server', '--listen', 'stdio://'];
  for (const override of configOverrides) args.push('-c', override);

  log(`Spawning: ${appServerBin} ${args.join(' ')}`);
  const proc = spawn(appServerBin, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  const rl = createInterface({ input: proc.stdout! });
  const server: AppServer = {
    process: proc,
    readline: rl,
    pending: new Map(),
    notificationHandlers: [],
    serverRequestHandlers: [],
  };

  proc.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) log(`[stderr] ${text}`);
  });

  rl.on('line', (line: string) => {
    if (!line.trim()) return;
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line);
    } catch {
      log(`[parse-error] ${line.slice(0, 200)}`);
      return;
    }

    if (isResponse(msg)) {
      const handler = server.pending.get(msg.id);
      if (handler) {
        server.pending.delete(msg.id);
        handler.resolve(msg);
      }
    } else if (isServerRequest(msg)) {
      for (const h of server.serverRequestHandlers) h(msg);
    } else if ('method' in msg) {
      for (const h of server.notificationHandlers) h(msg as JsonRpcNotification);
    }
  });

  proc.on('error', (err) => {
    log(`[process-error] ${err.message}`);
    for (const [, handler] of server.pending) handler.reject(err);
    server.pending.clear();
  });

  proc.on('exit', (code, signal) => {
    log(`[exit] code=${code} signal=${signal}`);
    const err = new Error(`Copilot app-server exited: code=${code} signal=${signal}`);
    for (const [, handler] of server.pending) handler.reject(err);
    server.pending.clear();
  });

  return server;
}

export function sendCopilotRequest(
  server: AppServer,
  method: string,
  params: Record<string, unknown>,
  timeoutMs = 60_000,
): Promise<JsonRpcResponse> {
  const req = makeRequest(method, params);
  const line = JSON.stringify(req) + '\n';

  return new Promise<JsonRpcResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      server.pending.delete(req.id);
      reject(new Error(`Timeout waiting for ${method} response (${timeoutMs}ms)`));
    }, timeoutMs);

    server.pending.set(req.id, {
      resolve: (r) => {
        clearTimeout(timer);
        resolve(r);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });

    try {
      server.process.stdin!.write(line);
    } catch (err) {
      clearTimeout(timer);
      server.pending.delete(req.id);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

export function sendCopilotResponse(server: AppServer, id: number, result: unknown): void {
  const line = JSON.stringify({ id, result }) + '\n';
  try {
    server.process.stdin!.write(line);
  } catch (err) {
    log(`[send-error] Failed to send response for id=${id}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function killCopilotAppServer(server: AppServer): void {
  try {
    server.readline.close();
    server.process.kill('SIGTERM');
  } catch {
    /* ignore */
  }
}

export function attachCopilotAutoApproval(server: AppServer): void {
  server.serverRequestHandlers.push((req) => {
    const method = req.method;

    switch (method) {
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval':
        sendCopilotResponse(server, req.id, { decision: 'accept' });
        break;
      case 'item/permissions/requestApproval':
        sendCopilotResponse(server, req.id, {
          permissions: { fileSystem: { read: ['/workspace', '/tmp'], write: ['/workspace', '/tmp'] }, network: { enabled: true } },
          scope: 'session',
        });
        break;
      case 'applyPatchApproval':
      case 'execCommandApproval':
        sendCopilotResponse(server, req.id, { decision: 'approved' });
        break;
      case 'item/tool/call':
        {
          const toolName = (req.params as { tool?: string }).tool || 'unknown';
          sendCopilotResponse(server, req.id, {
            success: false,
            contentItems: [
              {
                type: 'inputText',
                text: `Tool "${toolName}" is not supported in this mode. Please use MCP-registered tools instead.`,
              },
            ],
          });
        }
        break;
      case 'item/tool/requestUserInput':
      case 'mcpServer/elicitation/request':
        sendCopilotResponse(server, req.id, { input: null });
        break;
      default:
        sendCopilotResponse(server, req.id, { decision: 'accept' });
        break;
    }
  });
}

export async function initializeCopilotAppServer(server: AppServer): Promise<void> {
  const resp = await sendCopilotRequest(
    server,
    'initialize',
    {
      clientInfo: { name: 'nanoclaw', version: '1.0.0' },
      capabilities: { experimentalApi: false },
    },
    INIT_TIMEOUT_MS,
  );
  if (resp.error) throw new Error(`Initialize failed: ${resp.error.message}`);
}

export interface ThreadParams {
  model: string;
  cwd: string;
  sandbox?: string;
  approvalPolicy?: string;
  personality?: string;
  baseInstructions?: string;
}

export async function startOrResumeCopilotThread(
  server: AppServer,
  threadId: string | undefined,
  params: ThreadParams,
): Promise<string> {
  if (threadId) {
    const resp = await sendCopilotRequest(server, 'thread/resume', {
      threadId,
      ...(params as unknown as Record<string, unknown>),
    });
    if (!resp.error) return threadId;
    if (!STALE_THREAD_RE.test(resp.error.message)) {
      throw new Error(`thread/resume failed: ${resp.error.message}`);
    }
  }

  const resp = await sendCopilotRequest(server, 'thread/start', {
    ...(params as unknown as Record<string, unknown>),
  });
  if (resp.error) throw new Error(`thread/start failed: ${resp.error.message}`);

  const result = resp.result as { thread?: { id?: string } } | undefined;
  const newThreadId = result?.thread?.id;
  if (!newThreadId) throw new Error('thread/start response missing thread ID');
  return newThreadId;
}

export interface TurnParams {
  threadId: string;
  inputText: string;
  model?: string;
  cwd?: string;
}

export async function startCopilotTurn(server: AppServer, params: TurnParams): Promise<void> {
  const resp = await sendCopilotRequest(server, 'turn/start', {
    threadId: params.threadId,
    input: [{ type: 'text', text: params.inputText }],
    model: params.model,
    cwd: params.cwd,
  });
  if (resp.error) throw new Error(`turn/start failed: ${resp.error.message}`);
}

export interface CopilotMcpServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export function writeCopilotMcpConfigToml(servers: Record<string, CopilotMcpServer>): void {
  const copilotConfigDir = process.env.COPILOT_HOME || path.join(process.env.HOME || '/home/node', '.copilot');
  fs.mkdirSync(copilotConfigDir, { recursive: true });
  const configTomlPath = path.join(copilotConfigDir, 'config.toml');

  const lines: string[] = [];
  for (const [name, config] of Object.entries(servers)) {
    lines.push(`[mcp_servers.${name}]`);
    lines.push('type = "stdio"');
    lines.push(`command = ${tomlBasicString(config.command, `${name}.command`)}`);
    if (config.args && config.args.length > 0) {
      lines.push(`args = [${config.args.map((arg, idx) => tomlBasicString(arg, `${name}.args[${idx}]`)).join(', ')}]`);
    }
    if (config.env && Object.keys(config.env).length > 0) {
      lines.push(`[mcp_servers.${name}.env]`);
      for (const [key, value] of Object.entries(config.env)) {
        lines.push(`${key} = ${tomlBasicString(value, `${name}.env.${key}`)}`);
      }
    }
    lines.push('');
  }
  fs.writeFileSync(configTomlPath, lines.join('\n'));
}

export function createCopilotConfigOverrides(): string[] {
  const raw = process.env.COPILOT_CONFIG_OVERRIDES;
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
