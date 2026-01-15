
import { WorkerEntrypoint } from "cloudflare:workers";
import { StoryAgent } from "./story-agent";

export default {
    async fetch(request: Request, env: any) {
        const url = new URL(request.url);

        if (url.pathname === "/agent") {
            // Use a single global room for this MVP demo
            const id = env.StoryAgent.idFromName("global-story-room");
            const stub = env.StoryAgent.get(id);
            return stub.fetch(request);
        }

        // Serve static assets (for local dev mostly, or if configured)
        return env.ASSETS.fetch(request);
    }
}

// Export the Agent class so Durable Objects can find it
export { StoryAgent };
