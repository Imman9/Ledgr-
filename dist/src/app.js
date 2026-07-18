import express from "express";
import dotenv from "dotenv";
import helmet from "helmet";
dotenv.config();
import cors from "cors";
import { prisma } from "./db.js";
import { handleState } from "./services/whatsapp/stateMachine.js";
const app = express();
const PORT = process.env.PORT || 3000;
//middleware
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
//health check
app.get("/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
});
app.get("/webhooks/whatsapp", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" &&
        token === process.env.WHATSAPP_VERIFY_TOKEN &&
        typeof challenge === "string") {
        res.status(200).send(challenge);
        return;
    }
    res.sendStatus(403);
});
app.post("/webhooks/whatsapp", async (req, res) => {
    res.sendStatus(200);
    for (const message of extractIncomingTextMessages(req.body)) {
        try {
            await handleState(message.from, message.text);
        }
        catch (error) {
            console.error("Failed to handle WhatsApp message", error);
        }
    }
});
function extractIncomingTextMessages(payload) {
    if (!isRecord(payload) || !Array.isArray(payload.entry))
        return [];
    const messages = [];
    for (const entry of payload.entry) {
        if (!isRecord(entry) || !Array.isArray(entry.changes))
            continue;
        for (const change of entry.changes) {
            const value = isRecord(change) ? change.value : null;
            if (!isRecord(value) || !Array.isArray(value.messages))
                continue;
            for (const rawMessage of value.messages) {
                if (!isRecord(rawMessage) || rawMessage.type !== "text")
                    continue;
                const text = isRecord(rawMessage.text) ? rawMessage.text.body : null;
                if (typeof rawMessage.from === "string" && typeof text === "string") {
                    messages.push({ from: rawMessage.from, text });
                }
            }
        }
    }
    return messages;
}
function isRecord(value) {
    return typeof value === "object" && value !== null;
}
//start the server
async function startServer() {
    try {
        await prisma.$connect();
        console.log("Connected to PostgreSQL");
        app.listen(PORT, () => {
            console.log(`Server is open at port ${PORT}`);
        });
    }
    catch (error) {
        console.log("Failed to start the server:", error);
        process.exit(1);
    }
}
startServer();
// Graceful shutdown
process.on("SIGTERM", async () => {
    console.log("SIGTERM received, closing HTTP server...");
    await prisma.$disconnect();
    process.exit(0);
});
//# sourceMappingURL=app.js.map