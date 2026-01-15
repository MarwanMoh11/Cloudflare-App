const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
let socket;
let reconnectInterval;
let timerInterval;
let hasVoted = false;
let currentRound = 0;
let debugLogs = [];
let roomCode = "";

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
const headerRoomInfo = document.getElementById("header-room-info");
const currentRoomBadge = document.getElementById("current-room-badge");

function addLog(source, data) {
    const entry = { clientTime: new Date().toISOString(), source, data };
    debugLogs.push(entry);
    if (debugLogs.length > 100) debugLogs.shift();
    console.log(`[LOG][${source}]`, data);
}

function copyLogs() {
    const text = JSON.stringify(debugLogs, null, 2);
    navigator.clipboard.writeText(text).then(() => alert("Logs copied!")).catch(() => alert("Copy failed. Check console."));
}

function copyRoomLink() {
    const url = `${window.location.origin}${window.location.pathname}?room=${roomCode}`;
    navigator.clipboard.writeText(url).then(() => alert("Invite link copied to clipboard!")).catch(() => alert("Copy failed."));
}

function checkRoom() {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("room");
    if (code) {
        joinRoom(code.toUpperCase());
    } else {
        renderRoomSelector();
    }
}

function renderRoomSelector() {
    chatWindow.innerHTML = `
        <div class="room-selector">
            <h2>🎭 DreamStream</h2>
            <p>Enter a code to join a session or create a new one to play with friends.</p>
            <div class="input-group">
                <input type="text" id="room-input" class="room-input" placeholder="ROOM CODE" maxlength="10">
                <button class="primary-btn" onclick="handleJoin()">Join Adventure</button>
            </div>
            <div class="divider">OR</div>
            <button class="secondary-btn" onclick="createRoom()">Create New Room</button>
        </div>
    `;
    controlsArea.classList.add("hidden");
    headerRoomInfo.classList.add("hidden");
}

function handleJoin() {
    const input = document.getElementById("room-input");
    const code = input.value.trim().toUpperCase();
    if (code) joinRoom(code);
    else alert("Please enter a room code.");
}

function createRoom() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = "";
    for (let i = 0; i < 4; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
    joinRoom(code);
}

function joinRoom(code) {
    roomCode = code;
    currentRoomBadge.innerText = code;
    headerRoomInfo.classList.remove("hidden");

    // Update URL without reloading
    const newUrl = `${window.location.origin}${window.location.pathname}?room=${code}`;
    window.history.pushState({ path: newUrl }, "", newUrl);

    connect();
}

function connect() {
    if (socket) socket.close();

    const wsUrl = `${protocol}//${window.location.host}/agent?room=${roomCode}`;
    addLog("CLIENT", `Connecting to ${wsUrl}`);

    statusText.innerText = "Connecting...";

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
        statusText.innerText = "Offline";
        clearInterval(timerInterval);

        // Only reconnect if we still have a room code
        if (roomCode) {
            reconnectInterval = setInterval(() => {
                if (socket.readyState === WebSocket.CLOSED) connect();
            }, 5000);
        }
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
        addLog("CLIENT", `New Round: ${state.roundNumber}`);
        currentRound = state.roundNumber;
        hasVoted = false;
        document.querySelectorAll(".vote-btn").forEach(btn => btn.classList.remove("selected"));
    }

    if (state.phase === "LOBBY") {
        chatWindow.innerHTML = `
            <div class="lobby-screen">
                <h2>🏰 Room: ${roomCode}</h2>
                <p>Waiting for the adventure to begin...</p>
                <div class="user-count">${state.connectedUsers || 1} explorer${state.connectedUsers !== 1 ? 's' : ''} ready</div>
                <button class="start-btn" onclick="startGame()">Start Adventure</button>
                <p style="font-size: 0.8rem; opacity: 0.6;">Share the room code or link to play with others!</p>
            </div>
        `;
        controlsArea.classList.add("hidden");
        return;
    }

    // Render Chat
    chatWindow.innerHTML = "";
    let extractedOptions = [];

    (state.messages || []).forEach((entry, idx) => {
        if (entry.role === "system") return;

        const div = document.createElement("div");
        div.className = `message ${entry.role === "assistant" ? "model" : "user"}`;

        let content = entry.content;

        if (entry.role === "assistant") {
            // Find options using regex
            const optionMatches = [...content.matchAll(/(\d)\.\s*\[([^\]]+)\]/g)];
            if (optionMatches.length > 0) {
                // If it's the last assistant message and we are in VOTING, extract them
                const isLatest = idx === (state.messages || []).length - 1;
                if (isLatest && state.phase === "VOTING") {
                    extractedOptions = optionMatches.map(m => ({ id: m[1], text: m[2] }));
                }
                // Strip options from the displayed content
                content = content.split(/\n\d\./)[0].trim();
            }
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
            const label = document.getElementById(`label-${i}`);

            // Set dynamic label if found
            const opt = extractedOptions.find(o => o.id == i);
            if (label) {
                label.innerText = opt ? opt.text : `Option ${i}`;
            }

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

function startGame() {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "START_GAME" }));
}

function sendVote(choice) {
    if (hasVoted) return;
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
} else voiceBtn.style.display = "none";

checkRoom();
