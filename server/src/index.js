import http from "http";
import express from "express";
import cors from "cors";
import multer from "multer";
import { Readable } from "stream";
import { Server as SocketIOServer } from "socket.io";
import { PinStore } from "./pinStore.js";
import { createLogger } from "./logger.js";
import { registerSocketHandlers } from "./socket.js";

const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "*";
const PIN_TTL_MS = process.env.PIN_TTL_MS ? Number(process.env.PIN_TTL_MS) : 10 * 60 * 1000;

// ==================== FILE + ROOM STORES (IN-MEMORY ONLY) ====================

const roomsByCode = new Map(); // code -> { id, code, name, adminName, createdAt }
const filesById = new Map();   // id -> { roomCode, mime, name, size, buffer }
const filesByRoom = new Map(); // roomCode -> Set<fileId>

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2GB
});

const logger = createLogger();
const app = express();

const corsCredentials = CLIENT_ORIGIN !== "*";

app.use(
  cors({
    origin: CLIENT_ORIGIN,
    credentials: corsCredentials,
  })
);

app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// ==================== HELPERS ====================

function generateRoomCode() {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function attachFileToRoom(roomCode, fileId) {
  const code = String(roomCode).toUpperCase();
  if (!filesByRoom.has(code)) {
    filesByRoom.set(code, new Set());
  }
  filesByRoom.get(code).add(fileId);
}

export function cleanupRoomData(roomCode) {
  const code = String(roomCode).toUpperCase();

  if (roomsByCode.has(code)) {
    roomsByCode.delete(code);
  }

  const ids = filesByRoom.get(code);
  if (ids) {
    for (const id of ids) {
      filesById.delete(id);
    }
    filesByRoom.delete(code);
  }

  logger.info("room cleaned up", { roomCode: code });
}

// ==================== ROOM ROUTES ====================

app.post("/api/rooms", (req, res) => {
  const { adminName, roomName } = req.body || {};
  if (!adminName || !roomName) {
    return res.status(400).json({ message: "adminName and roomName are required" });
  }

  const id = generateId();
  let code;
  for (let i = 0; i < 10; i++) {
    const candidate = generateRoomCode();
    if (!roomsByCode.has(candidate)) {
      code = candidate;
      break;
    }
  }
  if (!code) {
    return res.status(500).json({ message: "Could not generate room code" });
  }

  const room = { id, code, name: roomName, adminName, createdAt: Date.now() };
  roomsByCode.set(code, room);
  logger.info("room created", { code, id, roomName, adminName });

  res.json({ roomId: id, code, roomName });
});

app.post("/api/rooms/join", (req, res) => {
  const { roomCode, userName } = req.body || {};
  if (!roomCode || !userName) {
    return res.status(400).json({ message: "roomCode and userName are required" });
  }

  const code = String(roomCode).toUpperCase();
  const room = roomsByCode.get(code);
  if (!room) {
    return res.status(404).json({ message: "Room not found" });
  }

  logger.info("room joined", { code, userName });
  res.json({ roomId: room.id, roomName: room.name });
});

// ==================== FILE UPLOAD / DOWNLOAD (IN-MEMORY) ====================

app.post("/api/upload", upload.single("file"), (req, res) => {
  const file = req.file;
  const { roomCode, userName } = req.body || {};

  if (!file || !roomCode) {
    return res.status(400).json({ message: "file and roomCode are required" });
  }

  const code = String(roomCode).toUpperCase();
  const room = roomsByCode.get(code);
  if (!room) {
    return res.status(404).json({ message: "Room not found" });
  }

  const id = generateId();

  filesById.set(id, {
    roomCode: code,
    buffer: file.buffer,
    mime: file.mimetype,
    name: file.originalname,
    size: file.size,
  });

  attachFileToRoom(code, id);

  const info = {
    id,
    name: file.originalname,
    size: file.size,
    mime: file.mimetype,
    url: `/files/${id}/${encodeURIComponent(file.originalname)}`,
    uploadedBy: userName || "unknown",
    uploadedAt: Date.now(),
    roomCode: code,
  };

  logger.info("file uploaded (in-memory)", {
    id,
    name: info.name,
    roomCode: info.roomCode,
    size: info.size,
  });

  res.json(info);
});

app.get("/files/:id/:name", (req, res) => {
  const { id } = req.params;
  const stored = filesById.get(id);
  if (!stored) {
    return res.status(404).send("File not found");
  }

  res.setHeader("Content-Type", stored.mime || "application/octet-stream");
  res.setHeader("Content-Length", stored.size);
  res.setHeader("Content-Disposition", `inline; filename="${stored.name}"`);

  const stream = Readable.from(stored.buffer);
  stream.on("error", (err) => {
    console.error("Error streaming file from memory", err);
    if (!res.headersSent) {
      res.status(500).send("Could not read file");
    } else {
      res.end();
    }
  });
  stream.pipe(res);
});

// ==================== HTTP + SOCKET SERVER ====================

const server = http.createServer(app);

const io = new SocketIOServer(server, {
  cors: {
    origin: CLIENT_ORIGIN,
    methods: ["GET", "POST"],
    credentials: corsCredentials,
  },
});

const pinStore = new PinStore({ ttlMs: PIN_TTL_MS });

registerSocketHandlers(io, {
  pinStore,
  logger,
  roomsByCode,
  filesById,
  filesByRoom,
  cleanupRoomData,
});

setInterval(() => pinStore.cleanupExpired(), 30 * 1000).unref?.();

server.listen(PORT, () => {
  logger.info("signaling server listening", { port: PORT, clientOrigin: CLIENT_ORIGIN });
});