import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { installShutdownCleanup } from "./proc.ts";
import { registerImport } from "./tools/import.ts";
import { registerProjectInfo } from "./tools/project.ts";
import { registerRun } from "./tools/run.ts";

// stdout carries only MCP frames. Log to stderr.
const server = new McpServer({ name: "godot-mcp", version: "0.0.1" });
registerProjectInfo(server);
registerImport(server);
registerRun(server);
installShutdownCleanup();
await server.connect(new StdioServerTransport());
