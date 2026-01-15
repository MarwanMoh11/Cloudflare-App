import { WorkerEntrypoint } from "cloudflare:workers";
import { StoryAgent } from "./story-agent";
import { routeAgentRequest } from "agents-sdk";

export default {
    async fetch(request: Request, env: any) {

        // Attempt to route to an Agent if the URL matches standard agent patterns
        // OR manually rewrite our /agent URL to what routeAgentRequest expects if needed.
        // However, routeAgentRequest usually expects /parties/:namespace/:id or /agents/:namespace/:id

        // Let's try to map /agent requests to the StoryAgent
        const url = new URL(request.url);
        if (url.pathname === "/agent") {
            try {
                // Use a single global room for this MVP demo
                const id = env.StoryAgent.idFromName("global-story-room");
                const stub = env.StoryAgent.get(id);

                // Inject specific headers required by agents-sdk (partyserver)
                const newRequest = new Request(request);
                newRequest.headers.set("x-partykit-room", "global-story-room");

                return await stub.fetch(newRequest);
            } catch (e: any) {
                console.error("[Worker] Error connecting to StoryAgent:", e);
                return new Response(`Error connecting to agent: ${e.message}\nStack: ${e.stack}`, { status: 500 });
            }
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
