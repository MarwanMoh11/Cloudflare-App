
const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
const wsUrl = `${protocol}//${window.location.host}/agent`;

let socket;
let reconnectInterval;

const chatWindow = document.getElementById("chat-window");
const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");
const usersCount = document.getElementById("users-count");
const voiceBtn = document.getElementById("voice-btn");

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

        // Auto-start game if in lobby
        socket.send(JSON.stringify({ type: "START_GAME" }));
    };

    socket.onclose = (event) => {
        console.log(`WebSocket Closed. Code: ${event.code}, Reason: ${event.reason || 'None'}, WasClean: ${event.wasClean}`);
        statusDot.classList.remove("connected");
        statusText.innerText = "Disconnected";
        reconnectInterval = setInterval(() => {
            if (socket.readyState === WebSocket.CLOSED) {
                console.log("Reconnecting...");
                connect();
            }
        }, 5000); // Slower reconnect
    };

    socket.onerror = (error) => {
        console.error("WebSocket Error occurred:", error);
    };

    socket.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === "STATE_UPDATE") {
            renderState(msg.data);
        } else {
            console.log(`Received unknown message: ${JSON.stringify(msg)}`);
        }
    };
}

function renderState(state) {
    // Update users
    usersCount.innerText = `(${state.users} connected)`;

    // Update Chat
    chatWindow.innerHTML = "";
    state.messages.forEach(msg => {
        // Hide system prompts from the UI
        if (msg.role === "system") return;

        const div = document.createElement("div");
        div.className = `message ${msg.role}`;
        // Simple markdown-ish parse for bold
        div.innerHTML = msg.content.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>');
        chatWindow.appendChild(div);
    });
    chatWindow.scrollTop = chatWindow.scrollHeight;

    // Update Buttons
    const buttons = document.querySelectorAll("#vote-panel button");
    const isVoting = state.phase === "VOTING";

    buttons.forEach(btn => {
        btn.disabled = !isVoting;
        if (isVoting) {
            btn.style.opacity = "1";
        } else {
            btn.style.opacity = "0.5";
        }
    });

    // Show votes on buttons if available
    if (state.votes) {
        document.getElementById("btn-1").innerText = `Option 1 (${state.votes['1'] || 0})`;
        document.getElementById("btn-2").innerText = `Option 2 (${state.votes['2'] || 0})`;
        document.getElementById("btn-3").innerText = `Option 3 (${state.votes['3'] || 0})`;
    }
}

function sendVote(choice) {
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "VOTE", choice }));
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
        voiceBtn.innerText = "Listening...";
    };

    recognition.onend = () => {
        voiceBtn.classList.remove("recording");
        voiceBtn.innerText = "Tap to Speak";
    };

    recognition.onresult = (event) => {
        const transcript = event.results[0][0].transcript.toLowerCase();
        console.log("Heard:", transcript);

        // Simple command parsing
        if (transcript.includes("one") || transcript.includes("1")) sendVote("1");
        else if (transcript.includes("two") || transcript.includes("2")) sendVote("2");
        else if (transcript.includes("three") || transcript.includes("3")) sendVote("3");
        else alert(`Heard: "${transcript}". Say "Option One", "Two", or "Three"`);
    };
} else {
    voiceBtn.style.display = "none";
}

// Init
connect();
