#!/usr/bin/env node
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer, getAgentVersion } from "./server";
import { error } from "./logger";
import express from "express";
import { program } from "commander";

const startSseServer = async (host: string, port: number) => {
	const app = express();

	const authToken = process.env.MOBILEMCP_AUTH;
	if (!authToken) {
		error("WARNING: MOBILEMCP_AUTH is not set. The SSE server will accept unauthenticated connections. Set MOBILEMCP_AUTH to require Bearer token authentication.");
	}

	if (authToken) {
		app.use((req, res, next) => {
			if (req.headers.authorization !== `Bearer ${authToken}`) {
				res.status(401).json({ error: "Unauthorized" });
				return;
			}

			next();
		});
	}

	// Block cross-origin requests — MCP clients are not browsers
	app.use((req, res, next) => {
		if (req.headers.origin) {
			res.status(403).json({ error: "Cross-origin requests are not allowed" });
			return;
		}

		if (req.method === "OPTIONS") {
			res.status(403).end();
			return;
		}

		next();
	});

	// farm fork (#1590): MULTI-CLIENT SSE. Upstream 0.0.60 kept ONE global transport
	// and 409'd every second `GET /mcp` ("Another client is already connected"). That
	// single decision forced the ~1300-LOC bmfarm mux (mobileMcpMux*). We now keep a
	// Map<sessionId, {server, transport}> so N clients (the iOS-farm leg, BusyBro over
	// ngrok, the dashboard Inspect) connect concurrently; each POST routes by its own
	// `sessionId` query param the SDK's SSEServerTransport advertises on connect.
	const sessions = new Map<string, { server: ReturnType<typeof createMcpServer>; transport: SSEServerTransport }>();

	app.post("/mcp", (req, res) => {
		const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : undefined;
		const session = sessionId ? sessions.get(sessionId) : undefined;
		if (!session) {
			res.status(404).json({ error: "Unknown or expired sessionId. Reconnect with GET /mcp." });
			return;
		}

		session.transport.handlePostMessage(req, res);
	});

	app.get("/mcp", (req, res) => {
		const server = createMcpServer();
		const transport = new SSEServerTransport("/mcp", res);

		sessions.set(transport.sessionId, { server, transport });

		transport.onclose = () => {
			sessions.delete(transport.sessionId);
		};

		server.connect(transport);
	});

	app.listen(port, host, () => {
		error(`mobile-mcp ${getAgentVersion()} sse server listening on http://${host}:${port}/mcp`);
	});
};

const startStdioServer = async () => {
	try {
		const transport = new StdioServerTransport();

		const server = createMcpServer();
		await server.connect(transport);

		error("mobile-mcp server running on stdio");
	} catch (err: any) {
		console.error("Fatal error in main():", err);
		error("Fatal error in main(): " + JSON.stringify(err.stack));
		process.exit(1);
	}
};

const main = async () => {
	program
		.version(getAgentVersion())
		.option("--listen <listen>", "Start SSE server on [host:]port")
		.option("--stdio", "Start stdio server (default)")
		.parse(process.argv);

	const options = program.opts();

	if (options.listen) {
		const listen = (options.listen as string).trim();
		const lastColon = listen.lastIndexOf(":");
		let host = "localhost";
		let rawPort: string;

		if (lastColon > 0) {
			host = listen.substring(0, lastColon);
			rawPort = listen.substring(lastColon + 1);
		} else {
			rawPort = listen;
		}

		const port = Number.parseInt(rawPort, 10);
		if (!host || !rawPort || !Number.isInteger(port) || port < 1 || port > 65535) {
			error(`Invalid --listen value "${listen}". Expected [host:]port with port 1-65535.`);
			process.exit(1);
		}

		await startSseServer(host, port);
	} else {
		await startStdioServer();
	}
};

main().then();
