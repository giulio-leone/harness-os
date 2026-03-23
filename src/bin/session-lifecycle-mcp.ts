import { SessionLifecycleMcpServer } from '../mcp/session-lifecycle-mcp-server.js';
import { loadDefaultMem0Adapter } from '../runtime/default-mem0-loader.js';
import { SessionLifecycleAdapter } from '../runtime/session-lifecycle-adapter.js';
import { SessionOrchestrator } from '../runtime/session-orchestrator.js';

async function main(): Promise<void> {
  const mem0Adapter = await loadDefaultMem0Adapter();
  const orchestrator = new SessionOrchestrator({
    mem0Adapter,
  });
  const adapter = new SessionLifecycleAdapter(orchestrator);
  const server = new SessionLifecycleMcpServer(adapter);

  server.start();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
