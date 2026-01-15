const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
const wsUrl = `${protocol}//${window.location.host}/agent`;

let socket;
let reconnectInterval;
let timerInterval;
let hasVoted = false;
let currentRound = 0;
let debugLogs = [];

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

function addLog(source, data) {
    const entry = {
        clientTime: new Date().toISOString(),
        source,
        data
    };
    debugLogs.push(entry);
    // Keep last 100 logs
    if (debugLogs.length > 100) debugLogs.shift();
    console.log(`[LOG][${source}]`, data);
}

function copyLogs() {
    const text = JSON.stringify(debugLogs, null, 2);
    navigator.clipboard.writeText(text).then(() => {
        alert("Logs copied to clipboard!");
    }).catch(err => {
        console.error("Copy failed", err);
        alert("Copy failed. See console.");
    });
}

function connect() {
    addLog("CLIENT", `Connecting to ${wsUrl}`);
    try {
        socket = new WebSocket(wsUrl);
    } catch (e) {
        addLog("CLIENT_ERROR", String(e));
        return;
    }

    socket.onopen = () => {
        addLog("CLIENT", "WebSocket Open");
        statusDot.classList.add("connected");
        statusText.innerText = "Online";
        clearInterval(reconnectInterval);
    };

    socket.onclose = (event) => {
        addLog("CLIENT", `WebSocket Closed: ${event.code}`);
        statusDot.classList.remove("connected");
        statusText.innerText = "Disconnected";
        clearInterval(timerInterval);
        reconnectInterval = setInterval(() => {
            if (socket.readyState === WebSocket.CLOSED) connect();
        }, 5000);
    };

    socket.onmessage = (event) => {
        const msg = JSON.parse(event.data);

        if (msg.type === "cf_agent_state") {
            renderState(msg.state);
        } else if (msg.type === "DEBUG_LOG") {
            addLog("SERVER", msg.payload);
        }
    };
}

function renderState(state) {
    if (!state) return;

    usersCount.innerText = `${state.connectedUsers || 1} online`;

    if (state.roundNumber && state.roundNumber !== currentRound) {
        addLog("CLIENT", `New Round detected: ${state.roundNumber}`);
        currentRound = state.roundNumber;
        hasVoted = false;
        document.querySelectorAll(".vote-btn").forEach(btn => {
            btn.classList.remove("selected");
        });
    }

    if (state.phase === "LOBBY") {
        renderLobby(state.connectedUsers);
        return;
    }

    // Render Chat
    chatWindow.innerHTML = "";
    const stories = state.messages || [];
    stories.forEach(entry => {
        if (entry.role === "system") return;

        const div = document.createElement("div");
        div.className = `message ${entry.role === "assistant" ? "model" : "user"}`;

        let content = entry.content;
        if (entry.role === "assistant") {
            content = content.replace(/(\d\.\s*\[[^\]]+\])/g, '<strong>$1</strong>');
            content = content.replace(/\n/g, '<br>');
        }

        div.innerHTML = content;
        chatWindow.appendChild(div);
    });

    chatWindow.scrollTop = chatWindow.scrollHeight;

    // Controls
    controlsArea.classList.remove("hidden");

    if (state.phase === "VOTING") {
        phaseLabel.innerText = "⏱️ Time to Vote";
        if (state.votingDeadline) updateTimer(state.votingDeadline);

        const votes = state.currentVotes || { "1": 0, "2": 0, "3": 0 };
        const total = Object.values(votes).reduce((a, b) => a + b, 0);

        for (let i = 1; i <= 3; i++) {
            const count = votes[String(i)] || 0;
            const btn = document.getElementById(`btn-${i}`);
            document.getElementById(`votes-${i}`).innerText = `${count} vote${count !== 1 ? 's' : ''}`;
            document.getElementById(`bar-${i}`).style.width = `${total > 0 ? (count / total) * 100 : 0}%`;
            btn.disabled = hasVoted;
        }
    } else {
        phaseLabel.innerText = "✍️ Narrator is writing...";
        timerProgress.style.width = "100%";
        timerText.innerText = "...";
        document.querySelectorAll(".vote-btn").forEach(btn => btn.disabled = true);
    }
}

function renderLobby(userCount) {
    chatWindow.innerHTML = `
        <div class="lobby-screen">
            <h2>🎭 DreamStream</h2>
            <p>Collaborative AI Storytelling</p>
            <p class="user-count">${userCount} user${userCount !== 1 ? 's' : ''} online</p>
            <button class="start-btn" onclick="startGame()">Start Game</button>
        </div>
    `;
    controlsArea.classList.add("hidden");
}

function startGame() {
    addLog("CLIENT", "Starting Game");
    if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "START_GAME" }));
    }
}

function sendVote(choice) {
    if (hasVoted) return;
    addLog("CLIENT", `Voting for ${choice}`);
    if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "VOTE", choice }));
        hasVoted = true;
        document.getElementById(`btn-${choice}`).classList.add("selected");
        document.querySelectorAll(".vote-btn").forEach(btn => btn.disabled = true);
    }
}

function updateTimer(deadline) {
    clearInterval(timerInterval);
    const update = () => {
        const remaining = Math.max(0, deadline - Date.now());
        const prog = (remaining / 20000) * 100;
        timerText.innerText = `${Math.ceil(remaining / 1000)}s`;
        timerProgress.style.width = `${Math.max(0, prog)}%`;
        if (remaining <= 0) clearInterval(timerInterval);
    };
    update();
    timerInterval = setInterval(update, 100);
}

// Voice
if ('webkitSpeechRecognition' in window) {
    const rec = new webkitSpeechRecognition();
    voiceBtn.onclick = () => voiceBtn.classList.contains("recording") ? rec.stop() : rec.start();
    rec.onstart = () => { voiceBtn.classList.add("recording"); voiceBtn.innerText = "🎙️ Listening..."; };
    rec.onend = () => { voiceBtn.classList.remove("recording"); voiceBtn.innerText = "🎤 Tap to Speak"; };
    rec.onresult = (e) => {
        const t = e.results[0][0].transcript.toLowerCase();
        if (t.includes("one")) sendVote("1");
        else if (t.includes("two")) sendVote("2");
        else if (t.includes("three")) sendVote("3");
    };
} else { voiceBtn.style.display = "none"; }

connect();
