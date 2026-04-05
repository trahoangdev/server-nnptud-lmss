import express from "express";
import prisma from "../db.js";
import { authenticateToken } from "../middleware/auth.js";
import { getIO } from "../socket.js";
import { parseId } from "./_helpers.js";

const router = express.Router();

/**
 * Create a notification (internal helper — also exported for use in other routes).
 * Emits `notification:new` via socket to the user room.
 */
export async function createNotification({ userId, type, title, message, link }) {
  const notification = await prisma.notification.create({
    data: { userId, type, title, message, link },
  });
  try {
    const io = getIO();
    io.to(`user:${userId}`).emit("notification:new", notification);
  } catch (e) {
    console.error("Socket notification error:", e.message);
  }
  return notification;
}

export default router;