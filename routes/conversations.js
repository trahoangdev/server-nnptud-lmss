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

export default router;
