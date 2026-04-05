/**
 * Notification routes — CRUD + socket emit.
 * Notifications are created internally (from submissions, grades, comments).
 */

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

/** GET /api/notifications — list user's notifications (newest first) */
router.get("/notifications", authenticateToken, async (req, res) => {
  try {
    const paginate = req.query.page !== undefined;
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Number(req.query.limit) || 20, 100);

    const where = { userId: req.user.id };

    const findOpts = {
      where,
      orderBy: { createdAt: "desc" },
    };
    if (paginate) {
      findOpts.skip = (page - 1) * limit;
      findOpts.take = limit;
    } else {
      findOpts.take = 50; // default cap
    }

    const notifications = await prisma.notification.findMany(findOpts);

    if (paginate) {
      const total = await prisma.notification.count({ where });
      return res.json({ data: notifications, total, page, limit });
    }
    res.json(notifications);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/** GET /api/notifications/unread-count */
router.get("/notifications/unread-count", authenticateToken, async (req, res) => {
  try {
    const count = await prisma.notification.count({
      where: { userId: req.user.id, isRead: false },
    });
    res.json({ count });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/** PATCH /api/notifications/:id/read — mark single notification as read */
router.patch("/notifications/:id/read", authenticateToken, async (req, res) => {
  try {
    const notifId = parseId(req.params.id);
    if (!notifId) return res.status(400).json({ error: "ID thông báo không hợp lệ" });
    const notif = await prisma.notification.findUnique({
      where: { id: notifId },
    });
    if (!notif || notif.userId !== req.user.id) {
      return res.status(404).json({ error: "Notification not found" });
    }
    const updated = await prisma.notification.update({
      where: { id: notif.id },
      data: { isRead: true },
    });
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/** PATCH /api/notifications/read-all — mark all as read */
router.patch("/notifications/read-all", authenticateToken, async (req, res) => {
  try {
    const result = await prisma.notification.updateMany({
      where: { userId: req.user.id, isRead: false },
      data: { isRead: true },
    });
    res.json({ message: "All marked as read", count: result.count });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/** DELETE /api/notifications/read — delete all read notifications */
router.delete("/notifications/read", authenticateToken, async (req, res) => {
  try {
    const result = await prisma.notification.deleteMany({
      where: { userId: req.user.id, isRead: true },
    });
    res.json({ message: "Đã xóa thông báo đã đọc", count: result.count });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
