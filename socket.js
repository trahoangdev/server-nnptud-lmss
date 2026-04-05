/**
 * Socket.io - PRD §6 Realtime & Socket
 * Namespace: / (default) hoặc /lms
 * Rooms: class:{class_id}, assignment:{assignment_id}, submission:{submission_id}, user:{user_id}, teachers
 */

import { Server } from "socket.io";

let io;

export const initSocket = (httpServer) => {
  io = new Server(httpServer, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
    },
  });

  io.on("connection", (socket) => {
    console.log(`⚡ Client connected: ${socket.id}`);

    /**
     * Client gửi: socket.emit("join_room", { userId, role, classId?, assignmentId?, submissionId? })
     * - user_{userId}: thông báo cá nhân (grade, comment)
     * - teachers: giáo viên nhận submission:new
     * - class:{classId}: event liên quan lớp (submission, grade)
     * - assignment:{assignmentId}: event liên quan bài tập
     * - submission:{submissionId}: comment realtime trên bài nộp
     */
    socket.on("join_room", (data) => {
      const { userId, role, classId, assignmentId, submissionId } = data || {};
      if (!userId) return;

      socket.join(`user:${userId}`);
      console.log(`User ${userId} joined room user:${userId}`);

      if (role === "TEACHER" || role === "ADMIN") {
        socket.join("teachers");
      }
      if (classId) {
        socket.join(`class:${classId}`);
      }
      if (assignmentId) {
        socket.join(`assignment:${assignmentId}`);
      }
      if (submissionId) {
        socket.join(`submission:${submissionId}`);
      }
    });

    socket.on("leave_room", (data) => {
      const { room } = data || {};
      if (room) {
        socket.leave(room);
        console.log(`Socket ${socket.id} left room ${room}`);
      }
    });

    // ─── Conversations / Messaging ───────────────────────────────

    socket.on("join_conversation", (data) => {
      const { conversationId } = data || {};
      if (conversationId) {
        socket.join(`conversation:${conversationId}`);
        console.log(`Socket ${socket.id} joined conversation:${conversationId}`);
      }
    });

    socket.on("leave_conversation", (data) => {
      const { conversationId } = data || {};
      if (conversationId) {
        socket.leave(`conversation:${conversationId}`);
        console.log(`Socket ${socket.id} left conversation:${conversationId}`);
      }
    });

    socket.on("typing", (data) => {
      const { conversationId, userId, userName } = data || {};
      if (conversationId) {
        socket.to(`conversation:${conversationId}`).emit("user:typing", {
          conversationId: String(conversationId),
          userId: String(userId),
          userName,
        });
      }
    });

    socket.on("stop_typing", (data) => {
      const { conversationId, userId } = data || {};
      if (conversationId) {
        socket.to(`conversation:${conversationId}`).emit("user:stop_typing", {
          conversationId: String(conversationId),
          userId: String(userId),
        });
      }
    });

    socket.on("disconnect", () => {
      console.log(`Client disconnected: ${socket.id}`);
    });
  });

  return io;
};

export const getIO = () => {
  if (!io) {
    throw new Error("Socket.io not initialized!");
  }
  return io;
};
