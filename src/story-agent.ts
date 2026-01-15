
import { Agent } from "agents-sdk";

interface StoryState {
    messages: { role: "system" | "user" | "assistant"; content: string }[];
    phase: "LOBBY" | "VOTING" | "NARRATING";
    currentVotes: Record<string, number>;
    connectedUsers: number;
    votingDeadline?: number;
    votedUsers: string[];
    roundNumber: number; // Track rounds to prevent stale alarm executions
}

interface Env {
    AI: any;
}

const VOTING_DURATION_MS = 20000; // 20 seconds

export class StoryAgent extends Agent<Env, StoryState> {

    get currentState(): StoryState {
        return this.state || this.getDefaultState();
    }

    getDefaultState(): StoryState {
        return {
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
Never mention voting, options being chosen, players, or game mechanics. Just narrate naturally as if telling a story.`
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

    async onConnect(connection: any) {
        console.log("[StoryAgent] New connection");

        if (!this.state) {
            this.setState(this.getDefaultState());
        }

        this.setState({
            ...this.currentState,
            connectedUsers: this.currentState.connectedUsers + 1
        });
    }

    async onClose(connection: any, code: number, reason: string, wasClean: boolean) {
        console.log("[StoryAgent] Connection closed");
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
            return;
        }

        const s = this.currentState;
        const connectionId = connection.id || `user-${Date.now()}`;

        switch (data.type) {
            case "START_GAME":
                if (s.phase === "LOBBY") {
                    await this.startNewRound(null);
                }
                break;

            case "VOTE":
                if (s.phase !== "VOTING") {
                    console.log("[StoryAgent] Ignoring vote - not in VOTING phase");
                    return;
                }
                if (s.votedUsers.includes(connectionId)) {
                    console.log("[StoryAgent] User already voted");
                    return;
                }

                const choice = data.choice;
                const newVotes = { ...s.currentVotes };
                newVotes[choice] = (newVotes[choice] || 0) + 1;
                const newVotedUsers = [...s.votedUsers, connectionId];

                console.log(`[StoryAgent] Vote recorded: Option ${choice}, voters: ${newVotedUsers.length}/${s.connectedUsers}`);

                this.setState({
                    ...s,
                    currentVotes: newVotes,
                    votedUsers: newVotedUsers
                });

                // Check if all users have voted - resolve immediately
                if (newVotedUsers.length >= s.connectedUsers && s.connectedUsers > 0) {
                    console.log("[StoryAgent] All users voted - resolving immediately");
                    // Cancel the alarm since we're resolving early
                    await this.ctx.storage.deleteAlarm();
                    await this.resolveAndContinue(s.roundNumber);
                }
                break;
        }
    }

    async alarm() {
        const s = this.currentState;
        console.log(`[StoryAgent] Alarm fired. Phase: ${s.phase}, Round: ${s.roundNumber}`);

        // Only process if still in VOTING phase
        if (s.phase === "VOTING") {
            await this.resolveAndContinue(s.roundNumber);
        } else {
            console.log("[StoryAgent] Alarm ignored - not in VOTING phase");
        }
    }

    async resolveAndContinue(expectedRound: number) {
        const s = this.currentState;

        // Guard: Check if this is for the current round
        if (s.roundNumber !== expectedRound) {
            console.log(`[StoryAgent] Stale resolution ignored. Expected round ${expectedRound}, current ${s.roundNumber}`);
            return;
        }

        // Guard: Check if already transitioned
        if (s.phase !== "VOTING") {
            console.log("[StoryAgent] Resolution ignored - already transitioned from VOTING");
            return;
        }

        // Find winning choice
        let winningChoice = "1";
        let maxVotes = 0;
        for (const [choice, count] of Object.entries(s.currentVotes)) {
            if (count > maxVotes) {
                maxVotes = count;
                winningChoice = choice;
            }
        }

        console.log(`[StoryAgent] Winner: Option ${winningChoice} with ${maxVotes} votes`);

        // Extract actual option text from last message
        const lastMessage = s.messages[s.messages.length - 1];
        let chosenAction = `Option ${winningChoice}`;

        if (lastMessage?.role === "assistant") {
            const regex = new RegExp(`${winningChoice}\\.\\s*\\[([^\\]]+)\\]`);
            const match = lastMessage.content.match(regex);
            if (match) {
                chosenAction = match[1];
            }
        }

        await this.startNewRound(chosenAction);
    }

    async startNewRound(chosenAction: string | null) {
        const s = this.currentState;
        const newRoundNumber = s.roundNumber + 1;

        console.log(`[StoryAgent] Starting round ${newRoundNumber}. Action: ${chosenAction || 'INITIAL'}`);

        // Immediately transition to NARRATING with new round number
        this.setState({
            ...s,
            phase: "NARRATING",
            roundNumber: newRoundNumber,
            currentVotes: { "1": 0, "2": 0, "3": 0 },
            votedUsers: []
        });

        // Build AI messages
        let aiMessages = [...s.messages];

        if (chosenAction) {
            aiMessages.push({ role: "user" as const, content: chosenAction });
        } else {
            aiMessages.push({
                role: "user" as const,
                content: "Begin the adventure. Describe a mysterious setting to start our story."
            });
        }

        try {
            console.log("[StoryAgent] Calling AI...");
            const response: any = await this.env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
                messages: aiMessages,
            });

            const newStory = response.response;
            console.log("[StoryAgent] AI responded");

            // Add only assistant response to visible history
            const updatedMessages = [...s.messages, { role: "assistant" as const, content: newStory }];

            // Set voting deadline
            const votingDeadline = Date.now() + VOTING_DURATION_MS;
            await this.ctx.storage.setAlarm(votingDeadline);

            // Transition to VOTING
            this.setState({
                ...this.currentState,
                messages: updatedMessages,
                phase: "VOTING",
                votingDeadline,
                currentVotes: { "1": 0, "2": 0, "3": 0 },
                votedUsers: []
            });

            console.log(`[StoryAgent] Round ${newRoundNumber} ready for voting`);

        } catch (err) {
            console.error("[StoryAgent] AI Error:", err);

            // Add error message and still transition to VOTING
            const errorMessages = [...s.messages, {
                role: "assistant" as const,
                content: "The narrator pauses, gathering their thoughts... What happens next?\n\n1. [Wait patiently]\n2. [Look around]\n3. [Call out into the void]"
            }];

            const votingDeadline = Date.now() + VOTING_DURATION_MS;
            await this.ctx.storage.setAlarm(votingDeadline);

            this.setState({
                ...this.currentState,
                messages: errorMessages,
                phase: "VOTING",
                votingDeadline,
                currentVotes: { "1": 0, "2": 0, "3": 0 },
                votedUsers: []
            });
        }
    }
}
