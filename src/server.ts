
import { WorkerEntrypoint } from "cloudflare:workers";
import { StoryAgent } from "./story-agent";

export default {
    async fetch(request: Request, env: any) {
        const url = new URL(request.url);

        console.log(`[Worker] Incoming request: ${request.method} ${request.url}`);

        if (url.pathname === "/agent") {
            try {
                const upgradeHeader = request.headers.get("Upgrade");
                console.log(`[Worker] Processing /agent request. Upgrade header: ${upgradeHeader}`);

                // Use a single global room for this MVP demo
                const id = env.StoryAgent.idFromName("global-story-room");
                const stub = env.StoryAgent.get(id);

                // Rewrite URL to root so Agent sees "/"
                // This is often required if the Agent SDK expects to handle the root path
                const newUrl = new URL(request.url);
                newUrl.pathname = "/";

                console.log(`[Worker] Forwarding to StoryAgent DO with URL: ${newUrl.toString()}`);

                const response = await stub.fetch(new Request(newUrl.toString(), request));
                console.log(`[Worker] StoryAgent response status: ${response.status}`);
                return response;
            } catch (e: any) {
                console.error("[Worker] Error connecting to StoryAgent:", e);
                return new Response(`Error connecting to agent: ${e.message}\nStack: ${e.stack}`, { status: 500 });
            }
        }

        // Serve static assets (for local dev mostly, or if configured)
        return env.ASSETS.fetch(request);
    }
}

// Export the Agent class so Durable Objects can find it
export { StoryAgent };
