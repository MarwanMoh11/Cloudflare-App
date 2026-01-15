import { WorkerEntrypoint } from "cloudflare:workers";
import { StoryAgent } from "./story-agent";
import { routeAgentRequest } from "agents-sdk";

export default {
    async fetch(request: Request, env: any) {

        console.log(`[Worker] Incoming request: ${request.method} ${request.url}`);

        // Attempt to route to an Agent if the URL matches standard agent patterns
        // OR manually rewrite our /agent URL to what routeAgentRequest expects if needed.
        // However, routeAgentRequest usually expects /parties/:namespace/:id or /agents/:namespace/:id

        // Let's try to map /agent requests to the StoryAgent
        const url = new URL(request.url);
        if (url.pathname === "/agent") {
            // Create a request that looks like what routeAgentRequest expects?
            // Actually, routeAgentRequest takes options.

            // If we use routeAgentRequest, we can pass a prefix.
            // But simpler: just use routeAgentRequest directly and update client to connect to /agents/StoryAgent/global-story-room

            // BUT user wants /agent.
            // Let's rewrite the URL to a standard pattern that routeAgentRequest understands
            // Typical pattern: /parties/StoryAgent/global-story-room

            const newUrl = new URL(request.url);
            newUrl.pathname = "/parties/StoryAgent/global-story-room";

            console.log(`[Worker] Rewriting /agent to ${newUrl.pathname} for routeAgentRequest`);

            return await routeAgentRequest(new Request(newUrl.toString(), request), env);
        }

        // Also allow direct standard access if the client is updated
        const agentResponse = await routeAgentRequest(request, env);
        if (agentResponse) return agentResponse;

        // Serve static assets (for local dev mostly, or if configured)
        return env.ASSETS.fetch(request);
    }
}

// Export the Agent class so Durable Objects can find it
export { StoryAgent };
