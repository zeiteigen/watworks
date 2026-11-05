import { VERSION } from "../../shared/src/version.js";
import { createMcpConfig } from "./config.js";

const HELP = `WaterlooWorks MCP ${VERSION}

Usage: waterlooworks-mcp [--help | --version | --print-config | --dashboard]

With no arguments, starts the stdio MCP server and its local browser bridge.
  --install-native-host  Enable extension service startup (one-time registration)
  --dashboard     Start the local application dashboard (http://127.0.0.1:39452)
  --help          Show this help
  --version       Show the release version
  --print-config  Print MCP JSON configuration for this executable's current path

Extract the release to a permanent folder before generating configuration.
Load its extension/ folder in Chrome using Developer mode and Load unpacked.
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "--native-host" || args[0]?.startsWith("chrome-extension://")) {
    const { runNativeHost } = await import("../../native-host/src/host.js");
    await runNativeHost(args[0] === "--native-host" ? args[1] : args[0]);
    return;
  }
  if (args.length === 0) {
    const { runMcpServer } = await import("./run.js");
    await runMcpServer();
    return;
  }
  if (args.length !== 1) throw new Error("Use one option at a time. Run --help for usage.");
  switch (args[0]) {
    case "--help":
      console.log(HELP);
      return;
    case "--install-native-host": {
      const { installNativeHost } = await import("../../native-host/src/install.js");
      console.log((await installNativeHost()).join("\n"));
      return;
    }
    case "--dashboard": {
      const { runDashboard } = await import("../../dashboard/src/run.js");
      await runDashboard();
      return;
    }
    case "--version":
      console.log(VERSION);
      return;
    case "--print-config":
      console.log(JSON.stringify(
        createMcpConfig(process.execPath, Bun.isStandaloneExecutable ? [] : [import.meta.path]),
        null,
        2,
      ));
      return;
    default:
      throw new Error(`Unknown option: ${args[0]}. Run --help for usage.`);
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(JSON.stringify({ event: "mcp.error", message: error instanceof Error ? error.message : "unknown error" }));
    process.exitCode = 1;
  });
}
