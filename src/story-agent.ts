
import { Agent } from "agents-sdk";

interface StoryState {
    messages: { role: "system" | "user" | "assistant"; content: string }[];
    phase: "LOBBY" | "VOTING" | "NARRATING";
    currentVotes: Record<string, number>;
    connectedUsers: number;
    votingDeadline?: number;
    votedUsers: string[];
    roundNumber: number;
}

interface Env {
    AI: any;
}

const VOTING_DURATION_MS = 20000;

export class StoryAgent extends Agent<Env, StoryState> {
    // In-memory lock (Durable Objects are single-threaded, so this is safe)
    private isLocked = false;

    get currentState(): StoryState {
        return this.state || this.getDefaultState();
    }

    private getDefaultState(): StoryState {
        return {
            messages: [
                {
                    role: "system",
                    content: `You are the Dungeon Master for a collaborative interactive fiction game. 
Your goal is to narrate the CURRENT segment of a story based on player choices.

CRITICAL CONSTRAINTS:
1. ONLY write ONE paragraph (max 60 words).
2. ONLY provide EXACTLY 3 numbered options at the end.
3. NEVER continue the story beyond the current turn.
4. NEVER summarize or repeat past turns.
5. NEVER mention game mechanics, dice, or voting.
6. Format options exactly as:
   1. [Option 1]
   2. [Option 2]
   3. [Option 3]

Stay in character as a mysterious and immersive narrator.`
                }
            ],
            phase: "LOBBY",
            currentVotes: { "1": 0, "2": 0, "3": 0 },
            connectedUsers: 0,
            votedUsers: [],
            roundNumber: 0
        };
    }

    constructor(state: DurableObjectState, env: Env) {
        super(state, env);
    }

    private log(action: string, details: any = {}) {
        const s = this.currentState;
        console.log(`[STORY_LOG] ${action} | Phase: ${s.phase} | Round: ${s.roundNumber} | Users: ${s.votedUsers.length}/${s.connectedUsers} | Details: ${JSON.stringify(details)}`);
    }

    async onConnect(connection: any) {
        if (!this.state) {
            this.setState(this.getDefaultState());
        }
        const s = this.currentState;
        this.setState({ ...s, connectedUsers: s.connectedUsers + 1 });
        this.log("USER_CONNECTED", { id: connection.id });
    }

    async onClose(connection: any) {
        const s = this.currentState;
        if (s.connectedUsers > 0) {
            this.setState({ ...s, connectedUsers: s.connectedUsers - 1 });
        }
        this.log("USER_DISCONNECTED", { id: connection.id });
    }

    async onMessage(connection: any, message: string | ArrayBuffer) {
        const msgStr = typeof message === "string" ? message : new TextDecoder().decode(message);
        let data: any;
        try {
            data = JSON.parse(msgStr);
        } catch (e) { return; }

        const s = this.currentState;
        const connectionId = connection.id || "unknown";

        if (data.type === "START_GAME") {
            if (s.phase === "LOBBY" && !this.isLocked) {
                this.log("ACTION: START_GAME");
                await this.startRound(null);
            }
        } else if (data.type === "VOTE") {
            if (s.phase === "VOTING" && !s.votedUsers.includes(connectionId)) {
                this.log("ACTION: VOTE", { choice: data.choice, user: connectionId });

                // Update state for the vote
                const updatedVotes = { ...s.currentVotes };
                updatedVotes[data.choice] = (updatedVotes[data.choice] || 0) + 1;
                const updatedVoters = [...s.votedUsers, connectionId];

                this.setState({ ...s, currentVotes: updatedVotes, votedUsers: updatedVoters });

                // Check for early resolution
                if (updatedVoters.length >= s.connectedUsers && !this.isLocked) {
                    this.log("EARLY_RESOLUTION_TRIGGERED");
                    await this.ctx.storage.deleteAlarm();
                    await this.resolveVotes();
                }
            }
        }
    }

    async alarm() {
        this.log("ALARM_FIRED");
        if (this.currentState.phase === "VOTING" && !this.isLocked) {
            await this.resolveVotes();
        } else {
            this.log("ALARM_SKIPPED", { phase: this.currentState.phase, isLocked: this.isLocked });
        }
    }

    private async resolveVotes() {
        if (this.isLocked) return;
        this.isLocked = true;

        const s = this.currentState;
        this.log("RESOLVING_VOTES", { votes: s.currentVotes });

        let winningChoice = "1";
        let maxVotes = -1;
        for (const [choice, count] of Object.entries(s.currentVotes)) {
            if (count > maxVotes) {
                maxVotes = count;
                winningChoice = choice;
            }
        }

        const lastAssistantMsg = s.messages.filter(m => m.role === "assistant").pop();
        let actionText = `Option ${winningChoice}`;
        if (lastAssistantMsg) {
            const match = lastAssistantMsg.content.match(new RegExp(`${winningChoice}\\.\\s*\\[([^\\]]+)\\]`));
            if (match) actionText = match[1];
        }

        this.log("WINNER_CHOSEN", { choice: winningChoice, text: actionText });
        await this.startRound(actionText);
    }

    private async startRound(prompt: string | null) {
        // Double check lock but this is private and called only from resolve or start
        this.isLocked = true;

        // Fresh state snapshot
        const s = this.currentState;
        const nextRound = s.roundNumber + 1;

        this.log("NARRATING_START", { round: nextRound, prompt });

        // Update state to NARRATING immediately
        this.setState({
            ...s,
            phase: "NARRATING",
            roundNumber: nextRound,
            currentVotes: { "1": 0, "2": 0, "3": 0 },
            votedUsers: []
        });

        // Prepare History for AI
        const history = [...s.messages];
        if (prompt) {
            history.push({ role: "user", content: `ACTION: ${prompt}` });
        } else {
            history.push({ role: "user", content: "Begin the adventure." });
        }

        try {
            this.log("AI_INVOKING");
            const response: any = await this.env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
                messages: history,
            });

            const story = response.response;
            this.log("AI_SUCCESS");

            // Update state with new message and transition back to VOTING
            const finalMessages = [...history, { role: "assistant" as const, content: story }];
            const deadline = Date.now() + VOTING_DURATION_MS;

            await this.ctx.storage.setAlarm(deadline);

            this.setState({
                ...this.currentState, // Important: use current state for non-history fields
                messages: finalMessages,
                phase: "VOTING",
                votingDeadline: deadline,
                roundNumber: nextRound // Re-verify round number
            });

            this.log("ROUND_READY", { round: nextRound });

        } catch (e) {
            this.log("AI_FAILURE", { error: String(e) });
            // Fallback strategy
            const errorMsg = "The mist thickens, obscuring the path. Try again.\n\n1. [Wait]\n2. [Listen]\n3. [Move forward]";
            this.setState({
                ...this.currentState,
                messages: [...this.currentState.messages, { role: "assistant", content: errorMsg }],
                phase: "VOTING",
                votingDeadline: Date.now() + 5000
            });
            await this.ctx.storage.setAlarm(Date.now() + 5000);
        } finally {
            this.isLocked = false;
            this.log("LOCK_RELEASED");
        }
    }
}
