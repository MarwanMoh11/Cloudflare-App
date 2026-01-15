
import { Agent } from "agents-sdk";

interface StoryState {
    messages: { role: "system" | "user" | "assistant"; content: string }[];
    phase: "LOBBY" | "VOTING" | "NARRATING";
    currentVotes: Record<string, number>; // option -> count
    connectedUsers: number;
    votingDeadline?: number; // timestamp when voting ends
    votedUsers: string[]; // track who has voted
}

interface Env {
    AI: any;
}

const VOTING_DURATION_MS = 20000; // 20 seconds for voting

export class StoryAgent extends Agent<Env, StoryState> {

    get currentState(): StoryState {
        return this.state || {
            messages: [
                {
                    role: "system",
                    content: `You are the Dungeon Master for a collaborative interactive fiction game. 
Your goal is to narrate a compelling story based on user votes. 
Keep responses concise (under 100 words) and end with exactly 3 distinct action options.
Format options EXACTLY like this:
1. [First action option]
2. [Second action option]
3. [Third action option]
Never mention voting, options being chosen, or game mechanics. Just narrate naturally.`
                }
            ],
            phase: "LOBBY",
            currentVotes: {},
            connectedUsers: 0,
            votedUsers: []
        };
    }

    constructor(state: DurableObjectState, env: Env) {
        super(state, env);
    }

    async onConnect(connection: any) {
        console.log("[StoryAgent] onConnect called");
        if (!this.state) {
            this.setState(this.currentState);
        }

        const newState = { ...this.currentState };
        newState.connectedUsers++;
        this.setState(newState);
    }

    async onClose(connection: any, code: number, reason: string, wasClean: boolean) {
        console.log(`[StoryAgent] onClose called`);
        const s = this.currentState;
        if (s.connectedUsers > 0) {
            this.setState({ ...s, connectedUsers: s.connectedUsers - 1 });
        }
    }

    async onMessage(connection: any, message: string | ArrayBuffer) {
        const msgStr = typeof message === "string" ? message : new TextDecoder().decode(message);

        let data: any;
        try {
            data = JSON.parse(msgStr);
        } catch (e) {
            console.error("[StoryAgent] Failed to parse message:", e);
            return;
        }

        const s = this.currentState;
        const connectionId = connection.id || "unknown";

        if (data.type === "RESET_STATE") {
            console.log("[StoryAgent] Resetting state");
            this.setState({
                messages: this.currentState.messages.slice(0, 1), // Keep only system prompt
                phase: "LOBBY",
                currentVotes: {},
                connectedUsers: 1,
                votedUsers: []
            });
            return;
        }

        if (data.type === "START_GAME" && s.phase === "LOBBY") {
            console.log("[StoryAgent] Starting game");
            this.setState({ ...s, phase: "NARRATING" });
            await this.generateStory(null); // null = initial story
        } else if (data.type === "VOTE" && s.phase === "VOTING") {
            // Check if user already voted
            if (s.votedUsers.includes(connectionId)) {
                console.log(`[StoryAgent] User ${connectionId} already voted`);
                return;
            }

            const choice = data.choice;
            const currentVotes = { ...s.currentVotes };
            currentVotes[choice] = (currentVotes[choice] || 0) + 1;
            const votedUsers = [...s.votedUsers, connectionId];

            this.setState({ ...s, currentVotes, votedUsers });
            console.log(`[StoryAgent] Vote recorded: Option ${choice}, total votes: ${votedUsers.length}`);

            // Check if all connected users have voted
            if (votedUsers.length >= s.connectedUsers) {
                console.log("[StoryAgent] All users voted, resolving early");
                await this.resolveVotes();
            }
        }
    }

    // Called by Durable Object alarm
    async alarm() {
        console.log("[StoryAgent] Alarm triggered - voting deadline reached");
        if (this.currentState.phase === "VOTING") {
            await this.resolveVotes();
        }
    }

    async resolveVotes() {
        const s = this.currentState;
        const votes = s.currentVotes;

        let winningChoice = "1"; // default
        let maxVotes = 0;

        for (const [choice, count] of Object.entries(votes)) {
            if (count > maxVotes) {
                maxVotes = count;
                winningChoice = choice;
            }
        }

        console.log(`[StoryAgent] Resolving votes - Winner: Option ${winningChoice}`);

        // Get the option text from the last assistant message
        const lastMessage = s.messages[s.messages.length - 1];
        let chosenAction = `Option ${winningChoice}`;

        if (lastMessage?.role === "assistant") {
            const optionMatch = lastMessage.content.match(new RegExp(`${winningChoice}\\.\\s*\\[([^\\]]+)\\]`));
            if (optionMatch) {
                chosenAction = optionMatch[1];
            }
        }

        await this.generateStory(chosenAction);
    }

    async generateStory(chosenAction: string | null) {
        console.log(`[StoryAgent] generateStory called with: ${chosenAction}`);

        this.setState({
            ...this.currentState,
            phase: "NARRATING",
            currentVotes: {},
            votedUsers: []
        });

        // Build messages for AI
        let messages = [...this.currentState.messages];

        if (chosenAction) {
            // Add the chosen action as a user message (but we won't display this to users)
            messages.push({ role: "user" as const, content: chosenAction });
        } else {
            // Initial story prompt
            messages.push({ role: "user" as const, content: "Begin the adventure! Describe a mysterious setting to start our story." });
        }

        try {
            console.log("[StoryAgent] Calling AI...");
            const response: any = await this.env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
                messages: messages,
            });

            const newStory = response.response;
            console.log("[StoryAgent] AI response received");

            // Only add the assistant response to visible history (not the internal user prompt)
            const newMessages = [...this.currentState.messages, { role: "assistant" as const, content: newStory }];

            // Set voting deadline
            const votingDeadline = Date.now() + VOTING_DURATION_MS;

            // Schedule alarm for vote resolution
            await this.ctx.storage.setAlarm(votingDeadline);

            this.setState({
                ...this.currentState,
                messages: newMessages,
                currentVotes: { "1": 0, "2": 0, "3": 0 },
                votedUsers: [],
                phase: "VOTING",
                votingDeadline
            });

        } catch (err) {
            console.error("[StoryAgent] AI Error:", err);
            const errorMessages = [...this.currentState.messages, {
                role: "assistant" as const,
                content: "The narrator pauses to gather their thoughts... (Please try voting again)"
            }];
            this.setState({
                ...this.currentState,
                messages: errorMessages,
                phase: "VOTING",
                votingDeadline: Date.now() + VOTING_DURATION_MS
            });
        }
    }
}
