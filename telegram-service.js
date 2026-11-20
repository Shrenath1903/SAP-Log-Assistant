const axios = require("axios");
const net = require("net");
const { exec } = require("child_process");

console.log(`[boot] telegram-service loaded, pid=${process.pid}, ${new Date().toISOString()}`);

// ================= CONFIG (hardcoded for testing) =================
const DEFAULT_APP = "<CF_APP_NAME>";
const OPENROUTER_API_KEY = "<OPENROUTER_API_KEY>";
const LOCK_PORT = 47321; // Local-only port used to detect a second copy

// Telegram Bot Configuration
const user1_Telegram_token = "<USER1_TELEGRAM_BOT_TOKEN>";
const user1_Telegram_chatID = "<USER1_CHAT_ID>";

const user2_Telegram_token = "<USER2_TELEGRAM_BOT_TOKEN>";
const user2_Telegram_chatID = "<USER2_CHAT_ID>";

// SAP CAPM Cloud Foundry Application
const capm_srv_app = "<CAPM_SERVICE_APP_NAME>";

const BOTS_CONFIG = [
    { name: "shre",    token: user1_Telegram_token, chats: [user1_Telegram_chatID], app: capm_srv_app },
    { name: "Hemanth", token: user2_Telegram_token, chats: [user2_Telegram_chatID], app: capm_srv_app }
];
// ===================================================================

const bots = BOTS_CONFIG
    .filter(b => {
        if (!b.name || !b.token || b.token.startsWith("PASTE_")) {
            console.warn(`[${b.name || "?"}] skipped: token not set`);
            return false;
        }
        return true;
    })
    .map(b => ({ ...b, chats: (b.chats || []).map(String), offset: 0 }));

// ---------------- Telegram helpers ----------------
async function sendMessage(bot, chatId, text) {
    const chunks = String(text || "(empty)").match(/[\s\S]{1,4000}/g);
    for (const chunk of chunks) {
        try {
            await axios.post(
                `https://api.telegram.org/bot${bot.token}/sendMessage`,
                { chat_id: chatId, text: chunk },
                { timeout: 15000 }
            );
        } catch (e) {
            console.error(`[${bot.name}] send error:`, e.response?.data || e.message);
        }
    }
}

async function notify(text, botName) {
    const targets = botName ? bots.filter(b => b.name === botName) : bots;
    await Promise.allSettled(
        targets.flatMap(bot => bot.chats.map(id => sendMessage(bot, id, text)))
    );
}

async function verifyBots() {
    for (const bot of bots) {
        try {
            const res = await axios.get(`https://api.telegram.org/bot${bot.token}/getMe`, { timeout: 10000 });
            console.log(`[${bot.name}] OK -> @${res.data.result.username}, chats: ${bot.chats.join(", ")}`);
        } catch (e) {
            console.error(`[${bot.name}] TOKEN PROBLEM:`, e.response?.data?.description || e.message);
        }
    }
}

function redact(text) {
    return text
        .replace(/(Bearer\s+)[A-Za-z0-9\-._~+\/]+=*/g, "$1[REDACTED]")
        .replace(/(password|secret|token)["']?\s*[:=]\s*["']?[^\s"',]+/gi, "$1=[REDACTED]");
}

async function analyzeLogs(logs) {
    const safeLogs = redact(logs.slice(-8000));

    try {
        const response = await axios.post(
            "https://openrouter.ai/api/v1/chat/completions",
            {
                model: "recursive/flint-v1.0:free", // or another OpenRouter model
            messages: [
                    {
                        role: "system",
                        content: `You are an expert SAP CAPM production support engineer.

                Analyze SAP CAPM Cloud Foundry logs and provide concise, actionable answers.

                Rules:
                - If there are no actual errors, reply only:
                ✅ No errors found.
                - Ignore INFO logs, HTTP 2xx, 3xx and successful requests.
                - Do NOT guess files that are not listed above.
                - Mention a file only if the logs strongly indicate it.
                - Mention a line number only if it is explicitly present in the stack trace or log.
                - If the file or line number cannot be determined, say:
                "File: Unable to determine from logs."
                - Do not invent stack traces, file names, or line numbers.
                - Keep the response under 12 lines.`
                    },
                    {
                        role: "user",
                        content: `Analyze these Cloud Foundry logs:

                ${safeLogs}

                Return only:

                🚨 Error:
                🔍 Root Cause:
                📂 File:
                📍 Line:
                🛠 Fix:
                ⚠ Severity:`
                    }
                ],
                temperature: 0.2,
                max_tokens: 1500
            },
            {
                headers: {
                    Authorization: `Bearer ${OPENROUTER_API_KEY}`,
                    "Content-Type": "application/json"
                },
                timeout: 180000
            }
        );

        console.log(JSON.stringify(response.data, null, 2));

        console.log("Choices:", response.data.choices);
        console.log("Message:", response.data.choices?.[0]?.message);
        console.log("Content:", response.data.choices?.[0]?.message?.content);
        console.log("Finish Reason:", response.data.choices?.[0]?.finish_reason);

       const message = response.data.choices?.[0]?.message;

        return (
            message?.content?.trim() ||
            message?.reasoning?.trim() ||
            "No response."
        );
    } catch (err) {
        console.error("OpenRouter Error:");
        console.error("Status:", err.response?.status);
        console.error("Data:", err.response?.data);

        throw err;
    }
}

// ---------------- Command handling ----------------
const running = new Set();

async function handleCommand(bot, chatId, text) {
    if (text === "start" || text === "help") {
        return sendMessage(bot, chatId, "Send 'analysis' to analyze the latest Cloud Foundry logs.");
    }
    if (!text.startsWith("analysis")) return;

    const app = bot.app || DEFAULT_APP;
    if (!/^[\w.-]+$/.test(app)) return sendMessage(bot, chatId, "Invalid app name in config.");

    const key = `${bot.name}:${chatId}`;
    if (running.has(key)) return sendMessage(bot, chatId, "⏳ An analysis is already running. Please wait.");
    running.add(key);

    await sendMessage(bot, chatId, `🔍 Fetching logs for ${app}...`);

    exec(`cf logs ${app} --recent`, { maxBuffer: 20 * 1024 * 1024 }, async (err, stdout) => {
        try {
            if (err) {
                const msg = String(err.message);
                if (/token|log back in|re-authenticate|not logged in/i.test(msg)) {
                    await sendMessage(bot, chatId, "🔐 Cloud Foundry login expired. Run 'cf login --sso' on the bot machine, then send 'analysis' again.");
                } else {
                    await sendMessage(bot, chatId, "cf error: " + msg);
                }
                return;
            }

            let logs = stdout
                .split("\n")
                .filter(l => /ERROR|Error|Exception|InvalidJwtError|SQLException|500|404|constraint|failed|rejected/.test(l))
                .slice(-80)
                .join("\n");
            if (!logs) logs = stdout.split("\n").slice(-150).join("\n");

            await sendMessage(bot, chatId, "🤖 Analyzing with AI...");
            const result = await analyzeLogs(logs);
            await sendMessage(bot, chatId, result || "Model returned an empty response.");
        } catch (e) {
            const detail = e.response?.data?.error?.message || e.response?.data || e.message;
            console.error(`[${bot.name}] AI error:`, e.response?.status, detail);
            await sendMessage(bot, chatId,
                `AI error ${e.response?.status || ""}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
        } finally {
            running.delete(key);
        }
    });
}

// ---------------- Polling loop (one per bot) ----------------
async function listenTelegram(bot) {
    console.log(`[${bot.name}] polling started`);

    while (true) {
        try {
            const response = await axios.get(`https://api.telegram.org/bot${bot.token}/getUpdates`, {
                params: { timeout: 30, offset: bot.offset },
                timeout: 35000
            });

            for (const update of response.data.result || []) {
                bot.offset = update.update_id + 1;
                const msg = update.message;
                if (!msg?.text) continue;

                const chatId = String(msg.chat.id);
                console.log(`[${bot.name}] message from chat ${chatId}: ${msg.text}`);

                if (!bot.chats.includes(chatId)) continue;

                const text = msg.text.trim().toLowerCase().replace(/^\//, "").replace(/@\w+/, "");
                handleCommand(bot, chatId, text).catch(e => console.error(`[${bot.name}] handler error:`, e));
            }
        } catch (e) {
            if (e.response?.status === 409) {
                console.error(`[${bot.name}] 409: ${e.response.data?.description}`);
            } else {
                console.error(`[${bot.name}] polling error:`, e.response?.data || e.message);
            }
            await new Promise(r => setTimeout(r, 3000));
        }
    }
}

// ---------------- Duplicate-instance guard ----------------
function acquireLock() {
    return new Promise(resolve => {
        const server = net.createServer();
        server.once("error", e => {
            if (e.code === "EADDRINUSE") {
                console.error(`[boot] pid=${process.pid}: ANOTHER COPY OF THIS BOT IS ALREADY RUNNING ON THIS MACHINE. This copy will not poll.`);
                resolve(false);
            } else {
                console.error("[boot] lock error:", e.message);
                resolve(true); // don't block startup on unrelated errors
            }
        });
        server.listen(LOCK_PORT, "127.0.0.1", () => resolve(true));
    });
}

async function main() {
    if (globalThis.__tgBotStarted) {
        console.log(`[boot] pid=${process.pid}: already started in this process, skipping duplicate load`);
        return;
    }
    globalThis.__tgBotStarted = true;

    if (!bots.length ) {
        console.error("Setat least one bot token in the CONFIG section.");
        return;
    }
    if (!(await acquireLock())) return;

    console.log(`Telegram CAPM Bot Started... pid=${process.pid}`);
    await verifyBots();
    bots.forEach(bot => listenTelegram(bot));
}

main();