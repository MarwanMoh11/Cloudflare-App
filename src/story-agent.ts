
import { Agent } from "agents-sdk";

interface StoryState {
    messages: { role: "system" | "user" | "assistant"; content: string }[];
    phase: "LOBBY" | "VOTING" | "NARRATING";
    currentVotes: Record<string, number>; // action -> count
    connectedUsers: number;
    votingDeadline?: number;
}

interface Env {
    AI: any;
}

export class StoryAgent extends Agent<Env, StoryState> {
    // State is managed by the base class. We can initialize defaults if needed in onConnect or specific methods.
    // Helper to ensure state exists
    get currentState(): StoryState {
        return this.state || {
            messages: [
                {
                    role: "system",
                    content: `You are the Dungeon Master for a collaborative interactive fiction game. 
        Your goal is to narrate a compelling story based on user votes. 
        Keep responses concise (under 100 words) and end with 3 distinct options for valid actions the players can take.
        Format options as:
        1. [Action 1]
        2. [Action 2]
        3. [Action 3]
        Start the story by describing a mysterious setting.`
                }
            ],
            phase: "LOBBY",
            currentVotes: {},
            connectedUsers: 0
        };
    }

    constructor(state: DurableObjectState, env: Env) {
        super(state, env);
    }

    async onConnect(connection: WebSocket) {
        // Initialize state if needed
        if (!this.state) {
            this.setState(this.currentState);
        }

        // We can't directly mutate this.state.connectedUsers if it's a primitive update pattern,
        // but agents-sdk standard setState merges. 
        // Let's rely on reading currentState for logic and using setState for updates.

        // For connected users count, this should probably be ephemeral or tracked via broadcast listening, 
        // but for simplicity we will store it in state or just increment it.
        // Note: modifying state here persists it.

        const newState = { ...this.currentState };
        newState.connectedUsers++;
        this.setState(newState);

        this.setState(newState);

        connection.addEventListener("message", (event) => {
            const data = JSON.parse(event.data as string);
            this.handleMessage(data);
        });

        connection.addEventListener("close", () => {
            const s = this.currentState;
            if (s.connectedUsers > 0) {
                this.setState({ ...s, connectedUsers: s.connectedUsers - 1 });
            }
            if (s.connectedUsers > 0) {
                this.setState({ ...s, connectedUsers: s.connectedUsers - 1 });
            }
        });
    }

    async handleMessage(data: any) {
        // Always get fresh state
        const s = this.currentState;

        if (data.type === "START_GAME" && s.phase === "LOBBY") {
            const newState: StoryState = { ...s, phase: "NARRATING" };
            this.setState(newState);
            const newState: StoryState = { ...s, phase: "NARRATING" };
            this.setState(newState);
            await this.generateStory("Start the story.");
        } else if (data.type === "VOTE" && s.phase === "VOTING") {
            const choice = data.choice; // e.g., "1", "2", or "3"
            const currentVotes = { ...s.currentVotes };
            currentVotes[choice] = (currentVotes[choice] || 0) + 1;

            this.setState({ ...s, currentVotes });
            this.broadcastState();
        }
    }

    async generateStory(userAction: string) {
        // Update phase to narrating
        this.setState({ ...this.currentState, phase: "NARRATING" });

        // Add user message to history
        const messages = [...this.currentState.messages, { role: "user" as const, content: userAction }];
        this.setState({ ...this.currentState, messages });

        try {
            // Use native AI binding directly
            const response: any = await this.env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
                messages: messages,
            });

            const newStory = response.response;

            const newMessages = [...messages, { role: "assistant" as const, content: newStory }];

            // Reset for next round
            this.setState({
                ...this.currentState,
                messages: newMessages,
                currentVotes: {},
                phase: "VOTING"
            });

            // Set a 30-second deadline for voting (simulated for simplicity, or use alarms)
            // For this MVP, we'll just wait for votes indefinitely or let client trigger.
            // But to show "Agent" capabilities, let's use an Alarm to force move if needed.
            // this.currentAlarm = this.schedule(30 * 1000); 

        } catch (err) {
            console.error("AI Error:", err);
            const errorMessages = [...messages, { role: "system" as const, content: "The narrator stumbled. Please try again." }];
            this.setState({ ...this.currentState, messages: errorMessages });
        }
    }
}
