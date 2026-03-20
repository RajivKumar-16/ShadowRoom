// Per-room user tracking: roomCode -> Map<socketId, { socketId, userName }>
const roomUsers = new Map();

function getRoomUsersList(roomCode) {
  const users = roomUsers.get(roomCode);
  if (!users) return [];
  return Array.from(users.values());
}

function removeRoomIfEmpty(roomCode, roomsByCode, filesById, filesByRoom, cleanupRoomData) {
  const code = String(roomCode).toUpperCase();
  const users = roomUsers.get(code);
  if (!users || users.size === 0) {
    roomUsers.delete(code);

    // Also clean up room + files using shared helper
    if (cleanupRoomData) {
      cleanupRoomData(code);
    } else if (roomsByCode) {
      // Fallback: basic cleanup without helper
      if (roomsByCode.has(code)) roomsByCode.delete(code);
      const ids = filesByRoom?.get(code);
      if (ids) {
        for (const id of ids) {
          filesById?.delete(id);
        }
        filesByRoom.delete(code);
      }
    }

    return true;
  }
  return false;
}

export function registerSocketHandlers(
  io,
  { pinStore, logger, roomsByCode, filesById, filesByRoom, cleanupRoomData }
) {
  io.on("connection", (socket) => {
    logger.info("socket connected", { id: socket.id });

    // ==================== PIN-BASED SIGNALLING ====================

    socket.on("pin:create", () => {
      const pin = pinStore.createPin({ socketId: socket.id });
      if (!pin) {
        socket.emit("pin:created", { ok: false, reason: "PIN_GENERATION_FAILED" });
        return;
      }
      socket.data.pin = pin;
      socket.join(pin);
      socket.emit("pin:created", { ok: true, pin });
      logger.info("pin created", { pin, socketId: socket.id });
    });

    socket.on("pin:join", ({ pin } = {}) => {
      const result = pinStore.join(pin, { socketId: socket.id });
      if (!result.ok) {
        socket.emit("pin:join:result", { ok: false, reason: result.reason });
        return;
      }
      socket.data.pin = pin;
      socket.join(pin);
      socket.emit("pin:join:result", { ok: true });
      logger.info("pin joined", { pin, socketId: socket.id });

      const peerId = pinStore.getPeerSocketId(pin, socket.id);
      if (peerId) {
        socket.emit("peer:ready", { role: "receiver" });
        io.to(peerId).emit("peer:ready", { role: "sender" });
      }
    });

    socket.on("webrtc:signal", ({ pin, data } = {}) => {
      const activePin = socket.data.pin;
      const roomPin = typeof pin === "string" ? pin : activePin;
      if (!roomPin) return;
      const peerId = pinStore.getPeerSocketId(roomPin, socket.id);
      if (!peerId) return;
      io.to(peerId).emit("webrtc:signal", { data });
    });

    // ==================== CHAT ROOM USER TRACKING ====================

    socket.on("join-room", ({ roomCode, userName } = {}) => {
      if (!roomCode || !userName) return;
      const code = String(roomCode).toUpperCase();

      // Validate room exists (based on HTTP-created rooms)
      if (roomsByCode && !roomsByCode.has(code)) {
        socket.emit("join-room-error", { message: "Room not found" });
        return;
      }

      socket.data.chatRoom = code;
      socket.data.chatUserName = userName;
      socket.join(code);

      if (!roomUsers.has(code)) {
        roomUsers.set(code, new Map());
      }
      roomUsers.get(code).set(socket.id, { socketId: socket.id, userName });

      io.to(code).emit("users-updated", getRoomUsersList(code));
      logger.info("user joined chat room", { code, userName, socketId: socket.id });
    });

    socket.on("leave-room", () => {
      const code = socket.data.chatRoom;
      if (!code) return;

      const users = roomUsers.get(code);
      if (users) {
        users.delete(socket.id);
        if (users.size === 0) {
          removeRoomIfEmpty(code, roomsByCode, filesById, filesByRoom, cleanupRoomData);
        } else {
          io.to(code).emit("users-updated", getRoomUsersList(code));
        }
      }

      socket.leave(code);
      socket.data.chatRoom = null;
      socket.data.chatUserName = null;

      logger.info("user left chat room", { code, socketId: socket.id });
    });

    // ==================== TYPING INDICATOR ====================

    socket.on("typing", ({ roomCode } = {}) => {
      if (!roomCode) return;
      const code = String(roomCode).toUpperCase();
      const userName = socket.data.chatUserName || "Anon";
      socket.to(code).emit("user-typing", { userName, socketId: socket.id });
    });

    socket.on("stop-typing", ({ roomCode } = {}) => {
      if (!roomCode) return;
      const code = String(roomCode).toUpperCase();
      const userName = socket.data.chatUserName || "Anon";
      socket.to(code).emit("user-stop-typing", { userName, socketId: socket.id });
    });

    // ==================== FILE SHARING ====================

    socket.on("file-shared", (fileInfo = {}) => {
      const { roomCode } = fileInfo;
      if (!roomCode) return;
      const code = String(roomCode).toUpperCase();
      socket.to(code).emit("file-uploaded", fileInfo);
    });

    // ==================== CHAT MESSAGING ====================

    socket.on("send-message", (payload = {}) => {
      const { text, roomCode, userName, ts } = payload;
      if (!roomCode || !text) return;
      const code = String(roomCode).toUpperCase();
      socket.join(code);
      const enriched = {
        text,
        roomCode: code,
        userName: userName || "Anon",
        ts: ts || Date.now(),
      };
      socket.to(code).emit("receive-message", enriched);
    });

    // ==================== DISCONNECT ====================

    socket.on("disconnect", (reason) => {
      logger.info("socket disconnected", { id: socket.id, reason });

      const chatRoom = socket.data.chatRoom;
      if (chatRoom) {
        const code = String(chatRoom).toUpperCase();
        const users = roomUsers.get(code);
        if (users) {
          users.delete(socket.id);
          if (users.size === 0) {
            removeRoomIfEmpty(code, roomsByCode, filesById, filesByRoom, cleanupRoomData);
          } else {
            io.to(code).emit("users-updated", getRoomUsersList(code));
          }
        }
      }

      const pins = pinStore.leaveBySocketId(socket.id);
      for (const pin of pins) {
        socket.to(pin).emit("peer:disconnected");
      }
    });
  });
}