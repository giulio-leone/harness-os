import { FileBackedMem0Adapter } from '../memory/file-mem0-adapter.js';
import { Mem0McpServer } from '../mcp/mem0-mcp-server.js';

async function main(): Promise<void> {
  const adapter = FileBackedMem0Adapter.fromEnv();
  const server = new Mem0McpServer(adapter);

  server.start();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
