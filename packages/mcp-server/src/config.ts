export function createMcpConfig(command: string, args: string[] = []): {
  mcpServers: { waterlooworks: { command: string; args: string[] } };
} {
  return { mcpServers: { waterlooworks: { command, args } } };
}
