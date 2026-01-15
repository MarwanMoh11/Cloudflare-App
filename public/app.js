const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
const wsUrl = `${protocol}//${window.location.host}/agent`;

let socket;
let reconnectInterval;
let timerInterval;
let hasVoted = false;

const chatWindow = document.getElementById("chat-window");
const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");
const usersCount = document.getElementById("users-count");
const voiceBtn = document.getElementById("voice-btn");
const controlsArea = document.getElementById("controls");
const timerBar = document.getElementById("timer-bar");
const timerProgress = document.getElementById("timer-progress");
const timerText = document.getElementById("timer-text");
const phaseLabel = document.getElementById("phase-label");

function connect() {
    console.log(`Connecting to ${wsUrl}...`);
    try {
        socket = new WebSocket(wsUrl);
    } catch (e) {
        console.error("Error creating WebSocket:", e);
        return;
    }

    socket.onopen = () => {
        console.log("WebSocket Open!");
        statusDot.classList.add("connected");
        statusText.innerText = "Online";
        clearInterval(reconnectInterval);
        hasVoted = false;

        // Reset state for fresh start, then start game
        socket.send(JSON.stringify({ type: "RESET_STATE" }));
        setTimeout(() => {
            socket.send(JSON.stringify({ type: "START_GAME" }));
        }, 100);
    };

    socket.onclose = (event) => {
        console.log(`WebSocket Closed. Code: ${event.code}`);
        statusDot.classList.remove("connected");
        statusText.innerText = "Disconnected";
        clearInterval(timerInterval);
        reconnectInterval = setInterval(() => {
            if (socket.readyState === WebSocket.CLOSED) {
                connect();
            }
        }, 5000);
    };

    socket.onerror = (error) => {
        console.error("WebSocket Error:", error);
    };

    socket.onmessage = (event) => {
        const msg = JSON.parse(event.data);

        if (msg.type === "cf_agent_state") {
            renderState(msg.state);
        } else if (msg.type === "STATE_UPDATE") {
            renderState(msg.data);
        }
    };
}

function renderState(state) {
    // Update user count
    const users = state.connectedUsers || state.users || 1;
    usersCount.innerText = `${users} online`;

    // Render Story Log
    chatWindow.innerHTML = "";
    const stories = state.messages || [];

    stories.forEach(entry => {
        // Hide system prompts
        if (entry.role === "system") return;
        // Hide internal user prompts (they're just for AI context)
        if (entry.role === "user") return;

        const div = document.createElement("div");
        div.className = "message model";

        // Format the content nicely
        let content = entry.content;
        // Make options bold
        content = content.replace(/(\d\.\s*\[[^\]]+\])/g, '<strong>$1</strong>');
        // Line breaks
        content = content.replace(/\n/g, '<br>');

        div.innerHTML = content;
        chatWindow.appendChild(div);
    });

    chatWindow.scrollTop = chatWindow.scrollHeight;

    // Handle voting UI
    const isVoting = state.phase === "VOTING";
    const isNarrating = state.phase === "NARRATING";

    if (isVoting) {
        controlsArea.classList.remove("hidden");
        phaseLabel.innerText = "⏱️ Voting Phase";

        // Update timer
        if (state.votingDeadline) {
            updateTimer(state.votingDeadline);
        }

        // Update vote counts
        const votes = state.currentVotes || { "1": 0, "2": 0, "3": 0 };
        const totalVotes = Object.values(votes).reduce((a, b) => a + b, 0);

        for (let i = 1; i <= 3; i++) {
            const count = votes[String(i)] || 0;
            document.getElementById(`votes-${i}`).innerText = `${count} vote${count !== 1 ? 's' : ''}`;

            // Update vote bar
            const percent = totalVotes > 0 ? (count / totalVotes) * 100 : 0;
            document.getElementById(`bar-${i}`).style.width = `${percent}%`;
        }

        // Enable/disable buttons based on vote status
        const buttons = document.querySelectorAll(".vote-btn");
        buttons.forEach((btn, i) => {
            btn.disabled = hasVoted;
            if (hasVoted && btn.classList.contains("selected")) {
                btn.style.opacity = "1";
            }
        });

    } else if (isNarrating) {
        phaseLabel.innerText = "✍️ Narrator is writing...";
        timerProgress.style.width = "100%";
        timerText.innerText = "...";

        // Disable voting during narration
        const buttons = document.querySelectorAll(".vote-btn");
        buttons.forEach(btn => btn.disabled = true);

    } else {
        controlsArea.classList.add("hidden");
    }
}

function updateTimer(deadline) {
    clearInterval(timerInterval);

    const update = () => {
        const now = Date.now();
        const remaining = Math.max(0, deadline - now);
        const seconds = Math.ceil(remaining / 1000);
        const progress = (remaining / 20000) * 100; // 20 second total

        timerText.innerText = `${seconds}s`;
        timerProgress.style.width = `${progress}%`;

        if (remaining <= 0) {
            clearInterval(timerInterval);
            timerText.innerText = "Tallying...";
        }
    };

    update();
    timerInterval = setInterval(update, 100);
}

function sendVote(choice) {
    if (hasVoted) return;

    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "VOTE", choice }));
        hasVoted = true;

        // Visual feedback
        document.querySelectorAll(".vote-btn").forEach((btn, i) => {
            if (String(i + 1) === choice) {
                btn.classList.add("selected");
            }
            btn.disabled = true;
        });
    }
}

// Voice Recognition
if ('webkitSpeechRecognition' in window) {
    const recognition = new webkitSpeechRecognition();
    recognition.continuous = false;
    recognition.lang = 'en-US';

    voiceBtn.onclick = () => {
        if (voiceBtn.classList.contains("recording")) {
            recognition.stop();
        } else {
            recognition.start();
        }
    };

    recognition.onstart = () => {
        voiceBtn.classList.add("recording");
        voiceBtn.innerText = "🎙️ Listening...";
    };

    recognition.onend = () => {
        voiceBtn.classList.remove("recording");
        voiceBtn.innerText = "🎤 Tap to Speak";
    };

    recognition.onresult = (event) => {
        const transcript = event.results[0][0].transcript.toLowerCase();
        console.log("Heard:", transcript);

        if (transcript.includes("one") || transcript.includes("1") || transcript.includes("first")) {
            sendVote("1");
        } else if (transcript.includes("two") || transcript.includes("2") || transcript.includes("second")) {
            sendVote("2");
        } else if (transcript.includes("three") || transcript.includes("3") || transcript.includes("third")) {
            sendVote("3");
        }
    };
} else {
    voiceBtn.style.display = "none";
}

// Initialize
connect();
