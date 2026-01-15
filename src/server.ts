
import { WorkerEntrypoint } from "cloudflare:workers";
import { StoryAgent } from "./story-agent";
import { routeAgentRequest } from "agents-sdk";

export default {
    async fetch(request: Request, env: any) {
        const url = new URL(request.url);

        // Map /agent requests to a specific room in StoryAgent
        if (url.pathname === "/agent") {
            try {
                // Extract room from query parameter, fallback to global
                const roomName = url.searchParams.get("room") || "global-story-room";

                const id = env.StoryAgent.idFromName(roomName);
                const stub = env.StoryAgent.get(id);

                // Inject headers for agents-sdk
                const newRequest = new Request(request);
                newRequest.headers.set("x-partykit-room", roomName);

                return await stub.fetch(newRequest);
            } catch (e: any) {
                console.error("[Worker] Room routing error:", e);
                return new Response(`Error connecting to room: ${e.message}`, { status: 500 });
            }
        }

        // Standard routeAgentRequest for potential future default paths
        const agentResponse = await routeAgentRequest(request, env);
        if (agentResponse) return agentResponse;

        // Serve static assets
        return env.ASSETS.fetch(request);
    }
}

export { StoryAgent };
