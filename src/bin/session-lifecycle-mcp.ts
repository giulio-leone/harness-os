import { FileBackedMem0Adapter } from '../memory/file-mem0-adapter.js';
import { SessionLifecycleMcpServer } from '../mcp/session-lifecycle-mcp-server.js';
import { SessionLifecycleAdapter } from '../runtime/session-lifecycle-adapter.js';
import { SessionOrchestrator } from '../runtime/session-orchestrator.js';

async function main(): Promise<void> {
  const orchestrator = new SessionOrchestrator({
    mem0Adapter: FileBackedMem0Adapter.fromEnv(),
  });
  const adapter = new SessionLifecycleAdapter(orchestrator);
  const server = new SessionLifecycleMcpServer(adapter);

  server.start();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
