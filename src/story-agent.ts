
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
                    content: `You are a strict Dungeon Master for a turn-based adventure.
Your mission is to write ONLY the immediate response to the player's last action.

CRITICAL RULES:
1. Write EXACTLY one short paragraph of narration (max 40 words).
2. End IMMEDIATELY with exactly 3 numbered options for the NEXT turn.
3. NEVER write more than one scene.
4. NEVER play out the options yourself.
5. STOP writing after the 3rd option. 

FORMAT:
[Narration of what happened next]
1. [Option 1]
2. [Option 2]
3. [Option 3]

DO NOT write "You find yourself..." more than once.
DO NOT provide options for future turns.`
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
        this.broadcast(JSON.stringify({ type: "DEBUG_LOG", payload: logEntry }));
    }

    async onConnect(connection: any) {
        if (!this.state) this.setState(this.getDefaultState());
        const s = this.currentState;
        this.setState({ ...s, connectedUsers: s.connectedUsers + 1 });
        this.log("CLIENT_CONNECTED", { id: connection.id });
    }

    async onClose(connection: any) {
        const s = this.currentState;
        if (s.connectedUsers > 0) this.setState({ ...s, connectedUsers: s.connectedUsers - 1 });
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

    override alarm = async () => {
        if (this.currentState.phase === "VOTING" && !this.isLocked) {
            this.log("ALARM_RESOLVING");
            await this.resolveVotes();
        }
    };

    private async resolveVotes() {
        if (this.isLocked) return;
        this.isLocked = true;

        const s = this.currentState;
        const votes = s.currentVotes || {};
        const maxVotes = Math.max(...Object.values(votes));

        // Find all options that share the maximum number of votes
        const candidates = Object.keys(votes).filter(c => votes[c] === maxVotes);

        // If no one voted (max is 0) or we have a tie, pick randomly from candidates
        const winningChoice = candidates[Math.floor(Math.random() * candidates.length)] || "1";

        this.log("RESOLVING_VOTES", { winningChoice, maxVotes, candidates });

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

        // Cleanup history: Remove the options from past assistant messages
        const cleanedHistory = s.messages.map(m => {
            if (m.role === "assistant") {
                const narrationOnly = m.content.split(/\n\d\./)[0].trim();
                return { ...m, content: narrationOnly };
            }
            return m;
        });

        const newMessagesForState = [...s.messages];
        if (prompt) {
            newMessagesForState.push({ role: "user", content: `Selection: ${prompt}` });
        } else {
            newMessagesForState.push({ role: "user", content: "Adventure started." });
        }

        const aiPrompt = prompt
            ? `The player selected: "${prompt}". Describe the immediate resulting scene and stop with 3 options.`
            : "Describe the starting scene and stop with 3 options.";

        this.setState({
            ...s,
            phase: "NARRATING",
            roundNumber: nextRound,
            messages: newMessagesForState,
            currentVotes: { "1": 0, "2": 0, "3": 0 },
            votedUsers: []
        });

        const messagesForAI = cleanedHistory.concat([{ role: "user", content: aiPrompt }]);

        try {
            this.log("AI_INVOKING", { round: nextRound });
            const resp: any = await this.env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
                messages: messagesForAI
            });

            const story = resp.response;
            const deadline = Date.now() + VOTING_DURATION_MS;
            await this.ctx.storage.setAlarm(deadline);

            this.setState({
                ...this.state,
                messages: [...this.state.messages, { role: "assistant", content: story }],
                phase: "VOTING",
                votingDeadline: deadline
            });
            this.log("ROUND_READY", { round: nextRound });
        } catch (e) {
            this.log("AI_ERROR", { error: String(e) });
        } finally {
            this.isLocked = false;
        }
    }
}
