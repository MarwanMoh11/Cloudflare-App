
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
Your goal is to narrate EXACTLY ONE segment of the story at a time.

RULES FOR YOUR RESPONSE:
1. ONLY write consequences for the PREVIOUS player action.
2. ONLY write ONE short paragraph (max 50 words).
3. ALWAYS end with EXACTLY 3 numbered options for the NEXT turn.
4. DO NOT play for the user. DO NOT narrate multiple turns.
5. DO NOT invent user choices.
6. Format options exactly as:
   1. [Option A]
   2. [Option B]
   3. [Option C]

Example Output:
You push through the heavy oak doors, finding a dusty library lit by floating candles. The smell of old parchment is overwhelming.
1. Search the restricted section
2. Ask the librarian for help
3. Look for a secret passage`
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
        const logEntry = {
            timestamp: new Date().toISOString(),
            round: s.roundNumber,
            phase: s.phase,
            action,
            details
        };
        console.log(`[STORY_LOG] ${JSON.stringify(logEntry)}`);

        // Broadcast to clients for the Copy Log button
        this.broadcast(JSON.stringify({
            type: "DEBUG_LOG",
            payload: logEntry
        }));
    }

    async onConnect(connection: any) {
        if (!this.state) {
            this.setState(this.getDefaultState());
        }
        const s = this.currentState;
        this.setState({ ...s, connectedUsers: s.connectedUsers + 1 });
        this.log("CLIENT_CONNECTED", { id: connection.id });
    }

    async onClose(connection: any) {
        const s = this.currentState;
        if (s.connectedUsers > 0) {
            this.setState({ ...s, connectedUsers: s.connectedUsers - 1 });
        }
        this.log("CLIENT_DISCONNECTED", { id: connection.id });
    }

    async onMessage(connection: any, message: string | ArrayBuffer) {
        const msgStr = typeof message === "string" ? message : new TextDecoder().decode(message);
        let data: any;
        try { data = JSON.parse(msgStr); } catch (e) { return; }

        const s = this.currentState;
        const id = connection.id || "anon";

        if (data.type === "START_GAME" && s.phase === "LOBBY" && !this.isLocked) {
            await this.startRound(null);
        } else if (data.type === "VOTE" && s.phase === "VOTING" && !s.votedUsers.includes(id)) {
            const updatedVotes = { ...s.currentVotes };
            updatedVotes[data.choice] = (updatedVotes[data.choice] || 0) + 1;
            const updatedVoters = [...s.votedUsers, id];

            this.setState({ ...s, currentVotes: updatedVotes, votedUsers: updatedVoters });
            this.log("VOTE_CAST", { user: id, choice: data.choice });

            if (updatedVoters.length >= s.connectedUsers && !this.isLocked) {
                await this.ctx.storage.deleteAlarm();
                await this.resolveVotes();
            }
        }
    }

    async alarm() {
        if (this.currentState.phase === "VOTING" && !this.isLocked) {
            this.log("ALARM_RESOLVING_VOTES");
            await this.resolveVotes();
        }
    }

    private async resolveVotes() {
        if (this.isLocked) return;
        this.isLocked = true;

        const s = this.currentState;
        let winningChoice = "1";
        let max = -1;
        for (const [c, count] of Object.entries(s.currentVotes)) {
            if (count > max) { max = count; winningChoice = c; }
        }

        const lastModelMsg = s.messages.filter(m => m.role === "assistant").pop();
        let prompt = `Option ${winningChoice}`;
        if (lastModelMsg) {
            const match = lastModelMsg.content.match(new RegExp(`${winningChoice}\\.\\s*\\[([^\\]]+)\\]`));
            if (match) prompt = match[1];
        }

        this.log("VOTES_RESOLVED", { winningChoice, prompt });
        await this.startRound(prompt);
    }

    private async startRound(prompt: string | null) {
        this.isLocked = true;
        const s = this.currentState;
        const nextRound = s.roundNumber + 1;

        // Add the user's choice to the persistent history
        const newMessages = [...s.messages];
        if (prompt) {
            newMessages.push({ role: "user", content: `Selection: ${prompt}` });
        } else {
            newMessages.push({ role: "user", content: "Adventure started." });
        }

        this.setState({
            ...s,
            phase: "NARRATING",
            roundNumber: nextRound,
            messages: newMessages,
            currentVotes: { "1": 0, "2": 0, "3": 0 },
            votedUsers: []
        });

        try {
            this.log("AI_PROMPTING", { prompt });
            const resp: any = await this.env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
                messages: newMessages
            });

            const story = resp.response;
            const deadline = Date.now() + VOTING_DURATION_MS;
            await this.ctx.storage.setAlarm(deadline);

            this.setState({
                ...this.currentState,
                messages: [...this.currentState.messages, { role: "assistant", content: story }],
                phase: "VOTING",
                votingDeadline: deadline
            });
            this.log("ROUND_STARTED", { round: nextRound });
        } catch (e) {
            this.log("AI_ERROR", { error: String(e) });
        } finally {
            this.isLocked = false;
        }
    }
}
