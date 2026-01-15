
import { Agent } from "agents-sdk";

interface PartyStats {
    hp: number;
    maxHp: number;
    gold: number;
    level: number;
    quest: string;
}

interface StoryState {
    messages: { role: "system" | "user" | "assistant"; content: string }[];
    phase: "LOBBY" | "VOTING" | "NARRATING" | "GAMEOVER" | "VICTORY";
    currentVotes: Record<string, number>;
    connectedUsers: number;
    votingDeadline?: number;
    votedUsers: string[];
    roundNumber: number;
    partyStats: PartyStats;
    inventory: string[];
}

interface Env {
    AI: any;
}

const VOTING_DURATION_MS = 25000;

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
                    content: `You are an expert Dungeon Master for a text-based DnD game. 
You manage an immersive, high-stakes adventure with persistent mechanics.

GM ENGINE RULES:
1. NARRATION: Write one rich, visceral paragraph (80-130 words).
2. STAT TAGS: You MUST use tags to affect the party. 
   - Damage: [[HP-10]]
   - Healing: [[HP+15]]
   - Loot: [[GOLD+50]]
   - Items: [[ITEM+Rusty Key]]
   - Final Boss/Win: [[VICTORY]]
   - Death: If HP hits 0, the game engine handles it.
3. CHOICES: End with exactly 3 numbered options.
4. VARIETY: Offer 1 Combat/Risk, 1 Stealth/Social, 1 Creative/Investigation choice.

QUEST: Every adventure MUST start with a clear, concise quest objective.
FORMAT: 'QUEST: [Objective]' on its OWN LINE, followed by narration on a new line.
Tone: Cinematic, dark fantasy, high stakes.`
                }
            ],
            phase: "LOBBY",
            currentVotes: { "1": 0, "2": 0, "3": 0 },
            connectedUsers: 0,
            votedUsers: [],
            roundNumber: 0,
            partyStats: {
                hp: 100,
                maxHp: 100,
                gold: 0,
                level: 1,
                quest: "Awaiting adventure..."
            },
            inventory: []
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

    private parseStateTags(text: string, currentState: StoryState): StoryState {
        let s = { ...currentState };
        let stats = { ...s.partyStats };
        let inv = [...s.inventory];

        // HP: [[HP-10]] or [[HP+5]]
        const hpMatches = text.matchAll(/\[\[HP([+-]\d+)\]\]/g);
        for (const match of hpMatches) {
            stats.hp = Math.min(stats.maxHp, Math.max(0, stats.hp + parseInt(match[1])));
        }

        // Gold: [[GOLD+50]]
        const goldMatches = text.matchAll(/\[\[GOLD([+-]\d+)\]\]/g);
        for (const match of goldMatches) {
            stats.gold = Math.max(0, stats.gold + parseInt(match[1]));
        }

        // Item: [[ITEM\+(.*?)\]\]
        const itemMatches = text.matchAll(/\[\[ITEM\+(.*?)\]\]/g);
        for (const match of itemMatches) {
            const item = match[1].trim();
            if (item && !inv.includes(item)) inv.push(item);
        }

        // Victory/Quest
        if (text.includes("[[VICTORY]]")) s.phase = "VICTORY";

        // Initial Quest Setup (if round 1 and AI sets one)
        if (s.roundNumber === 1 && (stats.quest === "Awaiting adventure..." || !stats.quest)) {
            const lines = text.split("\n");
            const questLine = lines.find(l => l.toUpperCase().startsWith("QUEST:"));
            if (questLine) {
                stats.quest = questLine.replace(/^QUEST:\s*/i, "").trim();
            }
        }

        if (stats.hp <= 0) s.phase = "GAMEOVER";

        // Level up every 5 rounds
        if (s.roundNumber > 0 && s.roundNumber % 5 === 0 && s.phase === "VOTING") {
            stats.level += 1;
            stats.maxHp += 20;
            stats.hp = stats.maxHp; // Full heal on level up
        }

        return { ...s, partyStats: stats, inventory: inv };
    }

    private async startRound(prompt: string | null) {
        this.isLocked = true;
        const s = this.currentState;
        const nextRound = s.roundNumber + 1;

        const cleanedHistory = s.messages.map(m => {
            if (m.role === "assistant") {
                const narrationOnly = m.content.split(/\n\d\./)[0].trim();
                return { ...m, content: narrationOnly };
            }
            return m;
        });

        const newMessagesForState = [...s.messages];
        if (prompt) newMessagesForState.push({ role: "user", content: `Selection: ${prompt}` });
        else newMessagesForState.push({ role: "user", content: "Adventure started." });

        const aiPrompt = prompt
            ? `The players chose: "${prompt}". Narration must reflect the visceral impact. PARTY HP: ${s.partyStats.hp}/${s.partyStats.maxHp}. GOLD: ${s.partyStats.gold}. LEVEL: ${s.partyStats.level}. Use tags like [[HP-10]] if they fail or get hurt, and [[GOLD+X]] for rewards.`
            : "Begin the epic quest. Start with 'QUEST: [Objective]' on a single line, then start the narration on a NEW line. Describe the opening scene. HP: 100/100.";

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

            let story = resp.response;
            let finalState = this.parseStateTags(story, this.currentState);

            const deadline = Date.now() + VOTING_DURATION_MS;
            await this.ctx.storage.setAlarm(deadline);

            this.setState({
                ...finalState,
                messages: [...finalState.messages, { role: "assistant", content: story }],
                phase: finalState.phase === "NARRATING" ? "VOTING" : finalState.phase,
                votingDeadline: deadline
            });
            this.log("ROUND_READY", { round: nextRound, stats: finalState.partyStats });
        } catch (e) {
            this.log("AI_ERROR", { error: String(e) });
        } finally {
            this.isLocked = false;
        }
    }
}
