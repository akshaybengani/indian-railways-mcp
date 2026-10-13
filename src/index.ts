import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import http from "node:http";
import { getStationLiveStatus, getTrainDetails, getTrainsBetweenStations, getTrainRoute, getTrainsOnDate, getPnrStatus } from "./railwayService.js";
import { TrainInfo, LiveStationStatusResponse, TrainDetailsResponse, TrainsBetweenStationsResponse, TrainRouteResponse, TrainsOnDateResponse, PnrStatusResponse } from "./railwayUtils.js";

// Shared server instance (used only in stdio mode; HTTP mode creates one per session)
const server = new McpServer({
  name: "indian-railways-mcp",
  version: "1.0.0",
  capabilities: { resources: {}, tools: {} },
});

// ─── Transport selection ────────────────────────────────────────────────────
// When PORT is set (e.g. inside Docker), the server exposes an HTTP/SSE
// endpoint so it can be reached through a Cloudflare Tunnel or any reverse
// proxy.  Without PORT it falls back to stdio for local MCP client use.

async function startHttp(port: number) {
  // Track active SSE transports keyed by sessionId so POST messages can be
  // routed to the correct session.
  const transports = new Map<string, SSEServerTransport>();

  const httpServer = http.createServer(async (req, res) => {
    // Health-check endpoint
    if (req.url === "/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", server: "indian-railways-mcp" }));
      return;
    }

    // ── SSE connection (client → subscribe) ──────────────────────────────
    if (req.url === "/sse" && req.method === "GET") {
      const transport = new SSEServerTransport("/messages", res);

      transports.set(transport.sessionId, transport);
      transport.onclose = () => transports.delete(transport.sessionId);

      // Each SSE connection gets its own McpServer instance so tools are
      // isolated per session and there are no cross-session race conditions.
      const sessionServer = new McpServer({
        name: "indian-railways-mcp",
        version: "1.0.0",
        capabilities: { resources: {}, tools: {} },
      });

      // Re-register all tools on the session server
      registerTools(sessionServer);
      await sessionServer.connect(transport);

      console.error(`[SSE] New session: ${transport.sessionId}`);
      return;
    }

    // ── POST messages (client → server) ──────────────────────────────────
    if (req.url?.startsWith("/messages") && req.method === "POST") {
      const url = new URL(req.url, `http://localhost`);
      const sessionId = url.searchParams.get("sessionId") ?? "";
      const transport = transports.get(sessionId);

      if (!transport) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session not found" }));
        return;
      }

      await transport.handlePostMessage(req, res);
      return;
    }

    // Fallback
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  });

  httpServer.listen(port, "0.0.0.0", () => {
    console.error(`Indian Railway MCP Server (HTTP/SSE) listening on port ${port}`);
    console.error(`  SSE endpoint : http://0.0.0.0:${port}/sse`);
    console.error(`  POST endpoint: http://0.0.0.0:${port}/messages`);
    console.error(`  Health check : http://0.0.0.0:${port}/health`);
  });
}

// ─── Tool registration helper ────────────────────────────────────────────────
// Extracted so we can register the same tools on both the global server (stdio)
// and per-session servers (HTTP/SSE).

function registerTools(s: McpServer) {
  s.tool(
    "get-station-live-status",
    "Get live station status",
    { stationCode: z.string().describe("The station code to get live status for") },
    async ({ stationCode }) => {
      const liveStationCode = stationCode.toUpperCase();
      const stationStatusResponse = await getStationLiveStatus<LiveStationStatusResponse>(liveStationCode);
      const stationStatus = stationStatusResponse?.station;
      const trains = stationStatusResponse?.trains;

      if (!stationStatus || !trains) {
        return { content: [{ type: "text", text: `Error fetching live station status for ${liveStationCode}` }] };
      }
      return {
        content: [
          { type: "text", text: `Live status for station ${liveStationCode}: ${stationStatus}` },
          { type: "text", text: `Trains: ${trains?.map((train: TrainInfo) => `${train.name} - ${train.time}`).join(", ")}` },
        ],
      };
    }
  );

  s.tool(
    "get-train-details",
    "Get train details by train number",
    { trainNumber: z.string().describe("The train number to get details for") },
    async ({ trainNumber }) => {
      const trainDetailsResponse = await getTrainDetails<TrainDetailsResponse>(trainNumber);
      if (!trainDetailsResponse) {
        return { content: [{ type: "text", text: `Error fetching train details for ${trainNumber}` }] };
      }
      return { content: [{ type: "text", text: `Train details for ${trainNumber}: ${JSON.stringify(trainDetailsResponse)}` }] };
    }
  );

  s.tool(
    "get-trains-between-stations",
    "Get trains between two stations",
    {
      from: z.string().describe("The starting station code"),
      to: z.string().describe("The destination station code"),
    },
    async ({ from, to }) => {
      const trainsBetweenStationsResponse = await getTrainsBetweenStations<TrainsBetweenStationsResponse>(from, to);
      if (!trainsBetweenStationsResponse) {
        return { content: [{ type: "text", text: `Error fetching trains between stations ${from} and ${to}` }] };
      }
      return { content: [{ type: "text", text: `Trains between stations ${from} and ${to}: ${JSON.stringify(trainsBetweenStationsResponse)}` }] };
    }
  );

  s.tool(
    "get-train-route",
    "Get train route by train number",
    { trainNumber: z.string().describe("The train number to get route for") },
    async ({ trainNumber }) => {
      const trainRouteResponse = await getTrainRoute<TrainRouteResponse>(trainNumber);
      if (!trainRouteResponse) {
        return { content: [{ type: "text", text: `Error fetching train route for ${trainNumber}` }] };
      }
      return { content: [{ type: "text", text: `Train route for ${trainNumber}: ${JSON.stringify(trainRouteResponse)}` }] };
    }
  );

  s.tool(
    "get-trains-on-date",
    "Get trains between two stations on a specific date",
    {
      from: z.string().describe("The starting station code"),
      to: z.string().describe("The destination station code"),
      date: z.string().describe("The date to get trains for"),
    },
    async ({ from, to, date }) => {
      const trainsOnDateResponse = await getTrainsOnDate<TrainsOnDateResponse>(from, to, date);
      if (!trainsOnDateResponse) {
        return { content: [{ type: "text", text: `Error fetching trains on date ${date} between stations ${from} and ${to}` }] };
      }
      return { content: [{ type: "text", text: `Trains on date ${date} between stations ${from} and ${to}: ${JSON.stringify(trainsOnDateResponse)}` }] };
    }
  );

  s.tool(
    "get-pnr-status",
    "Get PNR status by PNR number",
    { pnrNumber: z.string().describe("The PNR number to get status for") },
    async ({ pnrNumber }) => {
      const pnrStatusResponse = await getPnrStatus<PnrStatusResponse>(pnrNumber);
      if (!pnrStatusResponse) {
        return { content: [{ type: "text", text: `Error fetching PNR status for ${pnrNumber}` }] };
      }
      return { content: [{ type: "text", text: `PNR status for ${pnrNumber}: ${JSON.stringify(pnrStatusResponse)}` }] };
    }
  );
}

async function main() {
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : undefined;

  if (port) {
    await startHttp(port);
  } else {
    // Stdio mode — register tools on the global server and connect
    registerTools(server);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Indian Railway MCP Server running on stdio");
  }
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});