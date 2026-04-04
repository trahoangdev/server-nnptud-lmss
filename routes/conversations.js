import express from "express";
import { authenticateToken } from "../middleware/auth.js";
import { prisma } from "../prisma.js";
const router = express.Router();

function generateRoomCode() {
  return crypto.randomBytes(3).toString("hex").toUpperCase(); // e.g. "A1B2C3"
}

router.post("/conversations", authenticateToken, async (req, res) => {
  try {
    const { name, type = "group", classId, memberIds } = req.body;
    const userId = req.user.id;

    if (name && typeof name === "string" && name.length > 200) {
      return res
        .status(400)
        .json({ error: "Tên hội thoại không được quá 200 ký tự" });
    }
    if (type && !["group", "class", "direct"].includes(type)) {
      return res.status(400).json({ error: "Loại hội thoại không hợp lệ" });
    }
    if (
      memberIds &&
      (!Array.isArray(memberIds) || memberIds.some((id) => !parseId(id)))
    ) {
      return res
        .status(400)
        .json({ error: "Danh sách thành viên không hợp lệ" });
    }

    // If class conversation, auto-add all class members
    let finalMemberIds = memberIds ? memberIds.map((id) => parseId(id)) : [];
    let convName = name;

    if (classId) {
      const parsedClassId = parseId(classId);
      if (!parsedClassId)
        return res.status(400).json({ error: "classId không hợp lệ" });
      const cls = await prisma.class.findUnique({
        where: { id: parsedClassId },
        include: {
          members: { where: { status: "ACTIVE" }, select: { userId: true } },
        },
      });
      if (!cls) return res.status(404).json({ error: "Lớp không tồn tại" });

      // Check if class conversation already exists
      const existing = await prisma.conversation.findFirst({
        where: { classId: parsedClassId, type: "class" },
      });
      if (existing) {
        return res.status(400).json({
          error: "Lớp này đã có hội thoại",
          conversationId: existing.id,
        });
      }

      finalMemberIds = [cls.teacherId, ...cls.members.map((m) => m.userId)];
      convName = name || `${cls.name}`;
    }

    // Always include creator
    if (!finalMemberIds.includes(userId)) {
      finalMemberIds.push(userId);
    }

    // Remove duplicates
    finalMemberIds = [...new Set(finalMemberIds)];

    // Generate unique room code
    let roomCode = generateRoomCode();
    let codeExists = await prisma.conversation.findUnique({
      where: { roomCode },
    });
    while (codeExists) {
      roomCode = generateRoomCode();
      codeExists = await prisma.conversation.findUnique({
        where: { roomCode },
      });
    }

    const conversation = await prisma.conversation.create({
      data: {
        name: convName,
        type: classId ? "class" : type,
        classId: classId ? parseId(classId) : null,
        roomCode,
        members: {
          create: finalMemberIds.map((id) => ({ userId: id })),
        },
      },
      include: {
        members: true,
        class: { select: { id: true, name: true } },
      },
    });

    // System messages: log all members who were added
    try {
      const allMemberUsers = await prisma.user.findMany({
        where: { id: { in: finalMemberIds } },
        select: { id: true, name: true, role: true },
      });

      // Creator created the conversation
      const creator = allMemberUsers.find((u) => u.id === userId);
      await createSystemMessage(
        conversation.id,
        `${creator?.name || "Ai đó"} đã tạo hội thoại`,
      );

      // Log other members being added
      const otherMembers = allMemberUsers.filter((u) => u.id !== userId);
      if (otherMembers.length > 0) {
        const names = otherMembers.map((u) => u.name).join(", ");
        await createSystemMessage(
          conversation.id,
          `${names} đã được thêm vào hội thoại`,
        );
      }

      // Notify members (except creator)
      await Promise.allSettled(
        otherMembers.map((u) =>
          createNotification({
            userId: u.id,
            type: "conversation",
            title: "Hội thoại mới",
            message: `Bạn đã được thêm vào hội thoại '${convName}'`,
            link:
              u.role === "STUDENT"
                ? "/student/conversations"
                : "/conversations",
          }),
        ),
      );
    } catch (e) {
      console.error("Conversation notification error:", e.message);
    }

    res.status(201).json({ ...conversation, roomCode });
  } catch (err) {
    console.error("POST /conversations error:", err);
    res.status(500).json({ error: "Lỗi tạo hội thoại" });
  }
});

router.get("/conversations", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const memberships = await prisma.conversationMember.findMany({
      where: { userId },
      include: {
        conversation: {
          include: {
            members: true,
            messages: {
              orderBy: { createdAt: "desc" },
              take: 1,
            },
            class: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: { conversation: { updatedAt: "desc" } },
    });

    // Build response matching frontend Conversation interface
    const conversations = await Promise.all(
      memberships.map(async (m) => {
        const conv = m.conversation;
        const lastMsg = conv.messages[0] || null;

        // Get member details with user info
        const memberDetails = await prisma.conversationMember.findMany({
          where: { conversationId: conv.id },
          include: {
            // ConversationMember doesn't have user relation, query separately
          },
        });

        // Get user info for all members
        const memberUserIds = conv.members.map((mem) => mem.userId);
        const users = await prisma.user.findMany({
          where: { id: { in: memberUserIds } },
          select: { id: true, name: true, role: true },
        });
        const userMap = Object.fromEntries(users.map((u) => [u.id, u]));

        // Get sender name for last message
        let lastMsgSender = null;
        let lastMsgType = null;
        if (lastMsg) {
          lastMsgType = lastMsg.type || "user";
          if (lastMsg.senderId === 0) {
            lastMsgSender = "Hệ thống";
          } else {
            lastMsgSender = userMap[lastMsg.senderId]?.name || "Unknown";
          }
        }

        // Count unread messages (messages after lastReadAt)
        const unreadCount = await prisma.message.count({
          where: {
            conversationId: conv.id,
            createdAt: { gt: m.lastReadAt },
            senderId: { not: userId },
          },
        });

        return {
          id: String(conv.id),
          name: conv.name || conv.class?.name || "Hội thoại",
          type: conv.type,
          classId: conv.classId ? String(conv.classId) : null,
          className: conv.class?.name || "",
          roomCode: conv.roomCode || null,
          members: users.map((u) => ({
            id: String(u.id),
            name: u.name,
            role: u.role.toLowerCase(),
            avatar: "",
          })),
          lastMessage: lastMsg
            ? {
                content: lastMsg.content,
                sender: lastMsgSender,
                time: formatTime(lastMsg.createdAt),
                isRead: lastMsg.createdAt <= m.lastReadAt,
              }
            : {
                content: "Chưa có tin nhắn",
                sender: "",
                time: "",
                isRead: true,
              },
          unreadCount,
        };
      }),
    );

    res.json(conversations);
  } catch (err) {
    console.error("GET /conversations error:", err);
    res.status(500).json({ error: "Lỗi tải danh sách hội thoại" });
  }
});

router.get(
  "/conversations/:id/messages",
  authenticateToken,
  async (req, res) => {
    try {
      const conversationId = parseId(req.params.id);
      if (!conversationId)
        return res.status(400).json({ error: "ID hội thoại không hợp lệ" });
      const userId = req.user.id;
      const { cursor, limit = 50 } = req.query;
      const parsedLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);

      // Verify membership
      const membership = await prisma.conversationMember.findUnique({
        where: {
          conversationId_userId: { conversationId, userId },
        },
      });
      if (!membership) {
        return res
          .status(403)
          .json({ error: "Bạn không phải thành viên hội thoại này" });
      }

      const messages = await prisma.message.findMany({
        where: {
          conversationId,
          ...(cursor ? { id: { lt: parseId(cursor) || 0 } } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: parsedLimit,
      });

      // Get unique sender IDs
      const senderIds = [...new Set(messages.map((m) => m.senderId))];
      const users = await prisma.user.findMany({
        where: { id: { in: senderIds } },
        select: { id: true, name: true, role: true },
      });
      const userMap = Object.fromEntries(users.map((u) => [u.id, u]));

      // Format messages matching frontend Message interface
      const formatted = messages
        .reverse() // oldest first for display
        .map((msg) => {
          const sender = userMap[msg.senderId];
          return {
            id: String(msg.id),
            senderId: String(msg.senderId),
            senderName: sender?.name || "Unknown",
            senderRole: (sender?.role || "STUDENT").toLowerCase(),
            content: msg.isRecalled ? "Tin nhắn đã được thu hồi" : msg.content,
            type: msg.type || "user",
            time: formatTime(msg.createdAt),
            date: formatDate(msg.createdAt),
            isOwn: msg.senderId === userId,
            status: "delivered",
            isRecalled: msg.isRecalled,
          };
        });

      // Update lastReadAt
      await prisma.conversationMember.update({
        where: {
          conversationId_userId: { conversationId, userId },
        },
        data: { lastReadAt: new Date() },
      });

      const hasMore = messages.length === parsedLimit;
      const nextCursor = messages.length > 0 ? messages[0].id : null;

      res.json({ messages: formatted, hasMore, nextCursor });
    } catch (err) {
      console.error("GET /conversations/:id/messages error:", err);
      res.status(500).json({ error: "Lỗi tải tin nhắn" });
    }
  },
);

router.post(
  "/conversations/:id/messages",
  authenticateToken,
  async (req, res) => {
    try {
      const conversationId = parseId(req.params.id);
      if (!conversationId)
        return res.status(400).json({ error: "ID hội thoại không hợp lệ" });
      const userId = req.user.id;
      const { content } = req.body;

      if (!content?.trim()) {
        return res
          .status(400)
          .json({ error: "Nội dung tin nhắn không được trống" });
      }
      if (content.length > 5000) {
        return res
          .status(400)
          .json({ error: "Nội dung tin nhắn không được quá 5000 ký tự" });
      }

      // Verify membership
      const membership = await prisma.conversationMember.findUnique({
        where: {
          conversationId_userId: { conversationId, userId },
        },
      });
      if (!membership) {
        return res
          .status(403)
          .json({ error: "Bạn không phải thành viên hội thoại này" });
      }

      // Create message
      const message = await prisma.message.create({
        data: {
          conversationId,
          senderId: userId,
          content: content.trim(),
        },
      });

      // Update conversation updatedAt
      await prisma.conversation.update({
        where: { id: conversationId },
        data: { updatedAt: new Date() },
      });

      // Update sender's lastReadAt
      await prisma.conversationMember.update({
        where: {
          conversationId_userId: { conversationId, userId },
        },
        data: { lastReadAt: new Date() },
      });

      // Get sender info
      const sender = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, name: true, role: true },
      });

      const formatted = {
        id: String(message.id),
        senderId: String(message.senderId),
        senderName: sender?.name || "Unknown",
        senderRole: (sender?.role || "STUDENT").toLowerCase(),
        content: message.content,
        type: "user",
        time: formatTime(message.createdAt),
        date: formatDate(message.createdAt),
        isOwn: false, // will be set client-side
        status: "delivered",
        conversationId: String(conversationId),
      };

      // Emit to conversation room
      const io = getIO();
      io.to(`conversation:${conversationId}`).emit("message:new", formatted);

      // Notify other members (skip sender)
      try {
        const convMembers = await prisma.conversationMember.findMany({
          where: { conversationId, userId: { not: userId } },
          select: { userId: true },
        });
        const conv = await prisma.conversation.findUnique({
          where: { id: conversationId },
          select: { name: true },
        });
        const convName = conv?.name || "Hội thoại";
        const truncatedContent =
          content.trim().length > 80
            ? content.trim().slice(0, 80) + "..."
            : content.trim();
        const memberUsers = await prisma.user.findMany({
          where: { id: { in: convMembers.map((m) => m.userId) } },
          select: { id: true, role: true },
        });
        await Promise.allSettled(
          memberUsers.map((u) =>
            createNotification({
              userId: u.id,
              type: "message",
              title: `Tin nhắn mới - ${convName}`,
              message: `${sender?.name || "Ai đó"}: ${truncatedContent}`,
              link:
                u.role === "STUDENT"
                  ? "/student/conversations"
                  : "/conversations",
            }),
          ),
        );
      } catch (e) {
        console.error("Message notification error:", e.message);
      }

      res.status(201).json(formatted);
    } catch (err) {
      console.error("POST /conversations/:id/messages error:", err);
      res.status(500).json({ error: "Lỗi gửi tin nhắn" });
    }
  },
);

export default router;
