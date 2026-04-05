import express from "express";
import crypto from "crypto";
import { authenticateToken } from "../middleware/auth.js";
import prisma from "../db.js";
import { getIO } from "../socket.js";
import { parseId } from "./_helpers.js";
import { createNotification } from "./notifications.js";
const router = express.Router();

function generateRoomCode() {
  return crypto.randomBytes(3).toString("hex").toUpperCase(); // e.g. "A1B2C3"
}

function getConversationLink(role) {
  return role === "STUDENT" ? "/student/conversations" : "/conversations";
}
function formatTime(date) {
  const d = new Date(date);
  return d.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
}

function formatDate(date) {
  const d = new Date(date);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return "Hôm nay";
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return "Hôm qua";
  return d.toLocaleDateString("vi-VN");
}

async function getConversationForManagement(conversationId) {
  return prisma.conversation.findUnique({
    where: { id: conversationId },
    include: {
      class: { select: { id: true, name: true, teacherId: true } },
      members: {
        orderBy: [{ joinedAt: "asc" }, { id: "asc" }],
        select: { id: true, userId: true, joinedAt: true },
      },
      messages: {
        where: { type: "system" },
        orderBy: { createdAt: "asc" },
        take: 1,
        select: { content: true },
      },
    },
  });
}

async function resolveConversationOwnerId(conversation) {
  if (conversation.class?.teacherId) {
    return conversation.class.teacherId;
  }

  const createMessage = conversation.messages[0]?.content;
  const match = createMessage?.match(/^(.*) đã tạo hội thoại$/);
  if (match?.[1]) {
    const matchedUsers = await prisma.user.findMany({
      where: {
        id: { in: conversation.members.map((member) => member.userId) },
        name: match[1],
      },
      select: { id: true },
    });
    if (matchedUsers.length === 1) {
      return matchedUsers[0].id;
    }
  }

  return conversation.members[0]?.userId ?? null;
}

async function createSystemMessage(conversationId, content) {
  const message = await prisma.message.create({
    data: {
      conversationId,
      senderId: 0, // system
      content,
      type: "system",
    },
  });
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { updatedAt: new Date() },
  });
  const formatted = {
    id: String(message.id),
    senderId: "0",
    senderName: "Hệ thống",
    senderRole: "system",
    content: message.content,
    type: "system",
    time: formatTime(message.createdAt),
    date: formatDate(message.createdAt),
    isOwn: false,
    status: "delivered",
    conversationId: String(conversationId),
  };
  try {
    const io = getIO();
    io.to(`conversation:${conversationId}`).emit("message:new", formatted);
  } catch (e) {
    console.error("System message socket error:", e.message);
  }
  return formatted;
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

router.get(
  "/conversations/unread-count",
  authenticateToken,
  async (req, res) => {
    try {
      const userId = req.user.id;

      const memberships = await prisma.conversationMember.findMany({
        where: { userId },
      });

      let totalUnread = 0;
      for (const m of memberships) {
        const count = await prisma.message.count({
          where: {
            conversationId: m.conversationId,
            createdAt: { gt: m.lastReadAt },
            senderId: { not: userId },
          },
        });
        totalUnread += count;
      }

      res.json({ unreadCount: totalUnread });
    } catch (err) {
      console.error("GET /conversations/unread-count error:", err);
      res.status(500).json({ error: "Lỗi đếm tin nhắn chưa đọc" });
    }
  },
);
router.post("/conversations/:id/read", authenticateToken, async (req, res) => {
  try {
    const conversationId = parseId(req.params.id);
    if (!conversationId)
      return res.status(400).json({ error: "ID hội thoại không hợp lệ" });
    const userId = req.user.id;

    await prisma.conversationMember.update({
      where: {
        conversationId_userId: { conversationId, userId },
      },
      data: { lastReadAt: new Date() },
    });

    res.json({ success: true });
  } catch (err) {
    console.error("POST /conversations/:id/read error:", err);
    res.status(500).json({ error: "Lỗi đánh dấu đã đọc" });
  }
});

router.post("/conversations/join", authenticateToken, async (req, res) => {
  try {
    const { roomCode } = req.body;
    const userId = req.user.id;

    if (!roomCode?.trim()) {
      return res.status(400).json({ error: "Vui lòng nhập mã phòng" });
    }

    const conversation = await prisma.conversation.findUnique({
      where: { roomCode: roomCode.trim().toUpperCase() },
      include: { members: true },
    });

    if (!conversation) {
      return res.status(404).json({ error: "Mã phòng không tồn tại" });
    }

    // Check if already a member
    const existingMember = conversation.members.find(
      (m) => m.userId === userId,
    );
    if (existingMember) {
      return res.status(400).json({
        error: "Bạn đã là thành viên của hội thoại này",
        conversationId: conversation.id,
      });
    }

    // Add user as member
    await prisma.conversationMember.create({
      data: {
        conversationId: conversation.id,
        userId,
      },
    });

    // System message: user joined
    await createSystemMessage(
      conversation.id,
      `${req.user.name} đã tham gia hội thoại`,
    );

    // Notify existing members about new member
    try {
      const existingMemberIds = conversation.members
        .map((m) => m.userId)
        .filter((id) => id !== userId);
      const memberUsers = await prisma.user.findMany({
        where: { id: { in: existingMemberIds } },
        select: { id: true, role: true },
      });
      await Promise.allSettled(
        memberUsers.map((u) =>
          createNotification({
            userId: u.id,
            type: "conversation",
            title: "Thành viên mới",
            message: `${req.user.name} đã tham gia hội thoại '${conversation.name}'`,
            link:
              u.role === "STUDENT"
                ? "/student/conversations"
                : "/conversations",
          }),
        ),
      );
    } catch (e) {
      console.error("Join notification error:", e.message);
    }

    res.json({
      success: true,
      conversationId: conversation.id,
      conversationName: conversation.name,
    });
  } catch (err) {
    console.error("POST /conversations/join error:", err);
    res.status(500).json({ error: "Lỗi tham gia hội thoại" });
  }
});

router.post(
  "/conversations/:id/members",
  authenticateToken,
  async (req, res) => {
    try {
      const conversationId = parseId(req.params.id);
      if (!conversationId) {
        return res.status(400).json({ error: "ID hội thoại không hợp lệ" });
      }

      const rawMemberIds = Array.isArray(req.body.memberIds)
        ? req.body.memberIds
        : req.body.userId !== undefined
          ? [req.body.userId]
          : [];
      if (rawMemberIds.length === 0) {
        return res
          .status(400)
          .json({ error: "Cần cung cấp userId hoặc memberIds" });
      }

      const parsedMemberIds = rawMemberIds.map((id) => parseId(id));
      if (parsedMemberIds.some((id) => !id)) {
        return res
          .status(400)
          .json({ error: "Danh sách thành viên không hợp lệ" });
      }

      const memberIds = [...new Set(parsedMemberIds)];
      const conversation = await getConversationForManagement(conversationId);
      if (!conversation) {
        return res.status(404).json({ error: "Hội thoại không tồn tại" });
      }
      if (conversation.type === "direct") {
        return res
          .status(400)
          .json({ error: "Không thể thêm thành viên vào hội thoại direct" });
      }

      const ownerId = await resolveConversationOwnerId(conversation);
      const isAdmin = req.user.role === "ADMIN";
      if (!isAdmin && ownerId !== req.user.id) {
        return res
          .status(403)
          .json({ error: "Chỉ owner hoặc admin mới được thêm thành viên" });
      }

      const existingMemberIds = new Set(
        conversation.members.map((member) => member.userId),
      );
      const newMemberIds = memberIds.filter((id) => !existingMemberIds.has(id));
      if (newMemberIds.length === 0) {
        return res
          .status(400)
          .json({ error: "Tất cả người dùng này đã là thành viên" });
      }

      const users = await prisma.user.findMany({
        where: { id: { in: newMemberIds } },
        select: { id: true, name: true, role: true, status: true },
      });
      if (users.length !== newMemberIds.length) {
        return res.status(404).json({ error: "Có thành viên không tồn tại" });
      }

      const inactiveUser = users.find((user) => user.status !== "ACTIVE");
      if (inactiveUser) {
        return res.status(400).json({
          error: `Người dùng '${inactiveUser.name}' không ở trạng thái hoạt động`,
        });
      }

      await prisma.conversationMember.createMany({
        data: newMemberIds.map((userId) => ({
          conversationId,
          userId,
        })),
      });
      await prisma.conversation.update({
        where: { id: conversationId },
        data: { updatedAt: new Date() },
      });

      const addedUsers = users
        .filter((user) => newMemberIds.includes(user.id))
        .sort(
          (a, b) => newMemberIds.indexOf(a.id) - newMemberIds.indexOf(b.id),
        );

      try {
        const addedNames = addedUsers.map((user) => user.name).join(", ");
        await createSystemMessage(
          conversationId,
          `${req.user.name} đã thêm ${addedNames} vào hội thoại`,
        );

        await Promise.allSettled(
          addedUsers
            .filter((user) => user.id !== req.user.id)
            .map((user) =>
              createNotification({
                userId: user.id,
                type: "conversation",
                title: "Bạn được thêm vào hội thoại",
                message: `${req.user.name} đã thêm bạn vào hội thoại '${conversation.name || "Hội thoại"}'`,
                link: getConversationLink(user.role),
              }),
            ),
        );
      } catch (e) {
        console.error("Add member notification error:", e.message);
      }

      res.status(201).json({
        success: true,
        conversationId,
        addedMembers: addedUsers.map((user) => ({
          id: String(user.id),
          name: user.name,
          role: user.role.toLowerCase(),
        })),
      });
    } catch (err) {
      console.error("POST /conversations/:id/members error:", err);
      res.status(500).json({ error: "Lỗi thêm thành viên" });
    }
  },
);

router.delete(
  "/conversations/:id/members/:userId",
  authenticateToken,
  async (req, res) => {
    try {
      const conversationId = parseId(req.params.id);
      const targetUserId = parseId(req.params.userId);
      if (!conversationId || !targetUserId) {
        return res.status(400).json({ error: "ID không hợp lệ" });
      }

      const conversation = await getConversationForManagement(conversationId);
      if (!conversation) {
        return res.status(404).json({ error: "Hội thoại không tồn tại" });
      }

      const ownerId = await resolveConversationOwnerId(conversation);
      const isAdmin = req.user.role === "ADMIN";
      if (!isAdmin && ownerId !== req.user.id) {
        return res
          .status(403)
          .json({ error: "Chỉ owner hoặc admin mới được xóa thành viên" });
      }

      const membership = conversation.members.find(
        (member) => member.userId === targetUserId,
      );
      if (!membership) {
        return res.status(404).json({ error: "Thành viên không tồn tại" });
      }
      if (conversation.members.length <= 1) {
        return res
          .status(400)
          .json({ error: "Không thể xóa thành viên cuối cùng" });
      }
      if (targetUserId === ownerId) {
        return res
          .status(400)
          .json({ error: "Không thể xóa owner khỏi hội thoại" });
      }

      const targetUser = await prisma.user.findUnique({
        where: { id: targetUserId },
        select: { id: true, name: true, role: true },
      });

      await prisma.conversationMember.delete({
        where: {
          conversationId_userId: {
            conversationId,
            userId: targetUserId,
          },
        },
      });
      await prisma.conversation.update({
        where: { id: conversationId },
        data: { updatedAt: new Date() },
      });

      try {
        await createSystemMessage(
          conversationId,
          `${req.user.name} đã xóa ${targetUser?.name || "một thành viên"} khỏi hội thoại`,
        );

        if (targetUser && targetUser.id !== req.user.id) {
          await createNotification({
            userId: targetUser.id,
            type: "conversation",
            title: "Bạn bị xóa khỏi hội thoại",
            message: `${req.user.name} đã xóa bạn khỏi hội thoại '${conversation.name || "Hội thoại"}'`,
            link: getConversationLink(targetUser.role),
          });
        }
      } catch (e) {
        console.error("Remove member notification error:", e.message);
      }

      res.json({
        success: true,
        conversationId,
        removedUserId: String(targetUserId),
      });
    } catch (err) {
      console.error("DELETE /conversations/:id/members/:userId error:", err);
      res.status(500).json({ error: "Lỗi xóa thành viên" });
    }
  },
);

export default router;
