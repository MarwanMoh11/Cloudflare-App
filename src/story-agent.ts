
import { Agent } from "agents-sdk";

interface StoryState {
    messages: { role: "system" | "user" | "assistant"; content: string }[];
    phase: "LOBBY" | "VOTING" | "NARRATING";
    currentVotes: Record<string, number>;
    connectedUsers: number;
    votingDeadline?: number;
    votedUsers: string[];
    roundNumber: number;
    isProcessing: boolean; // Lock to prevent concurrent processing
}

interface Env {
    AI: any;
}

const VOTING_DURATION_MS = 20000;

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
            roundNumber: 0,
            isProcessing: false
        };
    }

    constructor(state: DurableObjectState, env: Env) {
        super(state, env);
    }

    private log(action: string, details: Record<string, any> = {}) {
        const s = this.currentState;
        console.log(JSON.stringify({
            timestamp: new Date().toISOString(),
            action,
            state: {
                phase: s.phase,
                roundNumber: s.roundNumber,
                isProcessing: s.isProcessing,
                connectedUsers: s.connectedUsers,
                votedUsersCount: s.votedUsers.length,
                messagesCount: s.messages.length
            },
            ...details
        }));
    }

    async onConnect(connection: any) {
        this.log("ON_CONNECT", { connectionId: connection.id });

        if (!this.state) {
            this.setState(this.getDefaultState());
            this.log("INITIALIZED_DEFAULT_STATE");
        }

        this.setState({
            ...this.currentState,
            connectedUsers: this.currentState.connectedUsers + 1
        });
        this.log("USER_CONNECTED");
    }

    async onClose(connection: any, code: number, reason: string, wasClean: boolean) {
        this.log("ON_CLOSE", { code, reason });
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
            this.log("PARSE_ERROR", { error: String(e) });
            return;
        }

        const s = this.currentState;
        const connectionId = connection.id || `user-${Date.now()}`;

        this.log("MESSAGE_RECEIVED", { type: data.type, connectionId });

        switch (data.type) {
            case "START_GAME":
                if (s.phase !== "LOBBY") {
                    this.log("START_GAME_IGNORED", { reason: "not in LOBBY", currentPhase: s.phase });
                    return;
                }
                if (s.isProcessing) {
                    this.log("START_GAME_IGNORED", { reason: "already processing" });
                    return;
                }
                this.log("START_GAME_ACCEPTED");
                await this.startNewRound(null);
                break;

            case "VOTE":
                if (s.phase !== "VOTING") {
                    this.log("VOTE_IGNORED", { reason: "not in VOTING", currentPhase: s.phase });
                    return;
                }
                if (s.isProcessing) {
                    this.log("VOTE_IGNORED", { reason: "already processing" });
                    return;
                }
                if (s.votedUsers.includes(connectionId)) {
                    this.log("VOTE_IGNORED", { reason: "already voted", connectionId });
                    return;
                }

                const choice = data.choice;
                const newVotes = { ...s.currentVotes };
                newVotes[choice] = (newVotes[choice] || 0) + 1;
                const newVotedUsers = [...s.votedUsers, connectionId];

                this.setState({
                    ...s,
                    currentVotes: newVotes,
                    votedUsers: newVotedUsers
                });

                this.log("VOTE_RECORDED", {
                    choice,
                    totalVoters: newVotedUsers.length,
                    connectedUsers: s.connectedUsers
                });

                // Check if all users have voted
                if (newVotedUsers.length >= s.connectedUsers && s.connectedUsers > 0) {
                    this.log("ALL_USERS_VOTED_ATTEMPTING_EARLY_RESOLVE");

                    // Cancel alarm first
                    try {
                        await this.ctx.storage.deleteAlarm();
                        this.log("ALARM_DELETED_SUCCESSFULLY");
                    } catch (e) {
                        this.log("ALARM_DELETE_FAILED", { error: String(e) });
                    }

                    await this.resolveAndContinue(s.roundNumber);
                }
                break;
        }
    }

    async alarm() {
        const s = this.currentState;
        this.log("ALARM_FIRED", {
            expectedPhase: "VOTING",
            actualPhase: s.phase,
            roundNumber: s.roundNumber,
            isProcessing: s.isProcessing
        });

        if (s.phase !== "VOTING") {
            this.log("ALARM_IGNORED", { reason: "not in VOTING phase" });
            return;
        }

        if (s.isProcessing) {
            this.log("ALARM_IGNORED", { reason: "already processing" });
            return;
        }

        this.log("ALARM_ACCEPTED_RESOLVING");
        await this.resolveAndContinue(s.roundNumber);
    }

    async resolveAndContinue(expectedRound: number) {
        const s = this.currentState;

        this.log("RESOLVE_ATTEMPT", {
            expectedRound,
            currentRound: s.roundNumber,
            phase: s.phase,
            isProcessing: s.isProcessing
        });

        // Guard: Check round number
        if (s.roundNumber !== expectedRound) {
            this.log("RESOLVE_ABORTED", { reason: "round mismatch" });
            return;
        }

        // Guard: Check phase
        if (s.phase !== "VOTING") {
            this.log("RESOLVE_ABORTED", { reason: "not in VOTING phase" });
            return;
        }

        // Guard: Check if already processing
        if (s.isProcessing) {
            this.log("RESOLVE_ABORTED", { reason: "already processing" });
            return;
        }

        // Set processing lock IMMEDIATELY
        this.setState({ ...s, isProcessing: true });
        this.log("PROCESSING_LOCK_SET");

        // Find winner
        let winningChoice = "1";
        let maxVotes = 0;
        for (const [choice, count] of Object.entries(s.currentVotes)) {
            if (count > maxVotes) {
                maxVotes = count;
                winningChoice = choice;
            }
        }

        this.log("WINNER_DETERMINED", { winningChoice, votes: maxVotes });

        // Extract action text
        const lastMessage = s.messages[s.messages.length - 1];
        let chosenAction = `Option ${winningChoice}`;

        if (lastMessage?.role === "assistant") {
            const regex = new RegExp(`${winningChoice}\\.\\s*\\[([^\\]]+)\\]`);
            const match = lastMessage.content.match(regex);
            if (match) {
                chosenAction = match[1];
                this.log("ACTION_EXTRACTED", { chosenAction });
            }
        }

        await this.startNewRound(chosenAction);
    }

    async startNewRound(chosenAction: string | null) {
        const s = this.currentState;
        const newRoundNumber = s.roundNumber + 1;

        this.log("ROUND_STARTING", {
            newRoundNumber,
            chosenAction: chosenAction || "INITIAL",
            previousPhase: s.phase
        });

        // Transition to NARRATING with new round number
        this.setState({
            ...s,
            phase: "NARRATING",
            roundNumber: newRoundNumber,
            currentVotes: { "1": 0, "2": 0, "3": 0 },
            votedUsers: [],
            isProcessing: true // Keep processing lock
        });

        this.log("PHASE_CHANGED_TO_NARRATING");

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

        this.log("AI_CALL_STARTING", { messagesCount: aiMessages.length });

        try {
            const response: any = await this.env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
                messages: aiMessages,
            });

            const newStory = response.response;
            this.log("AI_RESPONSE_RECEIVED", { responseLength: newStory?.length });

            // Add only assistant response to visible history
            const updatedMessages = [...s.messages, { role: "assistant" as const, content: newStory }];

            // Set voting deadline
            const votingDeadline = Date.now() + VOTING_DURATION_MS;

            this.log("SETTING_ALARM", { votingDeadline: new Date(votingDeadline).toISOString() });
            await this.ctx.storage.setAlarm(votingDeadline);

            // Transition to VOTING and release lock
            this.setState({
                ...this.currentState,
                messages: updatedMessages,
                phase: "VOTING",
                votingDeadline,
                currentVotes: { "1": 0, "2": 0, "3": 0 },
                votedUsers: [],
                isProcessing: false // Release lock
            });

            this.log("ROUND_COMPLETE_VOTING_OPEN", { roundNumber: newRoundNumber });

        } catch (err) {
            this.log("AI_ERROR", { error: String(err) });

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
                votedUsers: [],
                isProcessing: false
            });

            this.log("ERROR_RECOVERY_COMPLETE");
        }
    }
}
