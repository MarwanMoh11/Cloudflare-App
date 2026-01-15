
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
                    content: `You are an expert, visceral storyteller and narrator. 
Your goal is to immerse players in a high-stakes, atmospheric adventure where every choice has weight.

NARRATION STYLE:
- Use vivid sensory details (smells, sounds, tactile sensations).
- Maintain a tone of dramatic tension and cinematic mystery.
- Focus on the immediate, visceral consequences of actions.
- Write one rich, evocative paragraph (75-120 words).

STRICT RULES:
1. End EXCLUSIVELY with a numbered list of exactly 3 distinct choices.
2. Choices must offer clear variety: one cautious/observational, one bold/aggressive, and one creative/lateral.
3. Be descriptive in the choice text (e.g., 1. [Crawl toward the flickering torchlight]).
4. NEVER describe the player's internal thoughts or future reactions. 
5. NO preamble. Start the narration immediately.`
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
            ? `The players chose: "${prompt}". Narration must reflect the visceral impact of this choice and the immediate shift in the environment. Describe the unfolding scene and present 3 new paths.`
            : "Begin a new mystery. Set an atmospheric, compelling stage with sensory richness and present 3 starting paths.";

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
