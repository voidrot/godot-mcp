import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { registerProjectInfo } from "./tools/project.ts";

// stdout carries only MCP frames. Log to stderr.
const server = new McpServer({ name: "godot-mcp", version: "0.0.1" });
registerProjectInfo(server);
await server.connect(new StdioServerTransport());
