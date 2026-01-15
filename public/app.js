const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
const wsUrl = `${protocol}//${window.location.host}/agent`;

let socket;
let reconnectInterval;
let timerInterval;
let hasVoted = false;
let currentRound = 0;

const chatWindow = document.getElementById("chat-window");
const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");
const usersCount = document.getElementById("users-count");
const voiceBtn = document.getElementById("voice-btn");
const controlsArea = document.getElementById("controls");
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
        }
    };
}

function renderState(state) {
    if (!state) return;

    // Update user count
    const users = state.connectedUsers || 1;
    usersCount.innerText = `${users} online`;

    // Track round changes to reset vote state
    if (state.roundNumber && state.roundNumber !== currentRound) {
        currentRound = state.roundNumber;
        hasVoted = false;
        // Reset button states
        document.querySelectorAll(".vote-btn").forEach(btn => {
            btn.classList.remove("selected");
            btn.disabled = false;
        });
    }

    // Handle LOBBY phase
    if (state.phase === "LOBBY") {
        renderLobby(users);
        return;
    }

    // Render Story Log
    chatWindow.innerHTML = "";
    const stories = state.messages || [];

    stories.forEach(entry => {
        if (entry.role === "system" || entry.role === "user") return;

        const div = document.createElement("div");
        div.className = "message model";

        let content = entry.content;
        content = content.replace(/(\d\.\s*\[[^\]]+\])/g, '<strong>$1</strong>');
        content = content.replace(/\n/g, '<br>');

        div.innerHTML = content;
        chatWindow.appendChild(div);
    });

    chatWindow.scrollTop = chatWindow.scrollHeight;

    // Handle phases
    if (state.phase === "VOTING") {
        controlsArea.classList.remove("hidden");
        phaseLabel.innerText = "⏱️ Vote now!";

        if (state.votingDeadline) {
            updateTimer(state.votingDeadline);
        }

        // Update vote counts
        const votes = state.currentVotes || { "1": 0, "2": 0, "3": 0 };
        const totalVotes = Object.values(votes).reduce((a, b) => a + b, 0);

        for (let i = 1; i <= 3; i++) {
            const count = votes[String(i)] || 0;
            const votesEl = document.getElementById(`votes-${i}`);
            const barEl = document.getElementById(`bar-${i}`);

            if (votesEl) votesEl.innerText = `${count} vote${count !== 1 ? 's' : ''}`;
            if (barEl) barEl.style.width = `${totalVotes > 0 ? (count / totalVotes) * 100 : 0}%`;
        }

        // Update button states based on hasVoted
        document.querySelectorAll(".vote-btn").forEach(btn => {
            btn.disabled = hasVoted;
        });

    } else if (state.phase === "NARRATING") {
        controlsArea.classList.remove("hidden");
        phaseLabel.innerText = "✍️ Story continues...";
        timerProgress.style.width = "100%";
        timerText.innerText = "...";
        clearInterval(timerInterval);

        document.querySelectorAll(".vote-btn").forEach(btn => {
            btn.disabled = true;
        });
    }
}

function renderLobby(userCount) {
    chatWindow.innerHTML = `
        <div class="lobby-screen">
            <h2>🎭 Welcome to DreamStream</h2>
            <p>A collaborative AI storytelling adventure</p>
            <p class="user-count">${userCount} player${userCount !== 1 ? 's' : ''} ready</p>
            <button class="start-btn" onclick="startGame()">Start Adventure</button>
            <p class="hint">Any player can start the game</p>
        </div>
    `;
    controlsArea.classList.add("hidden");
}

function startGame() {
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "START_GAME" }));
    }
}

function updateTimer(deadline) {
    clearInterval(timerInterval);

    const update = () => {
        const now = Date.now();
        const remaining = Math.max(0, deadline - now);
        const seconds = Math.ceil(remaining / 1000);
        const progress = (remaining / 20000) * 100;

        timerText.innerText = `${seconds}s`;
        timerProgress.style.width = `${Math.max(0, progress)}%`;

        if (remaining <= 0) {
            clearInterval(timerInterval);
            timerText.innerText = "Tallying...";
            timerProgress.style.width = "0%";
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

        if (transcript.includes("one") || transcript.includes("first")) {
            sendVote("1");
        } else if (transcript.includes("two") || transcript.includes("second")) {
            sendVote("2");
        } else if (transcript.includes("three") || transcript.includes("third")) {
            sendVote("3");
        } else if (transcript.includes("start")) {
            startGame();
        }
    };
} else {
    voiceBtn.style.display = "none";
}

// Initialize
connect();
