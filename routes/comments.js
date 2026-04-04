import express from "express";
import prisma from "../db.js";
import { authenticateToken } from "../middleware/auth.js";
import { getIO } from "../socket.js";
import { createNotification } from "./notifications.js";
import { parseId } from "./_helpers.js";
const router = express.Router();

const COMMENT_USER_SELECT = {
  id: true,
  name: true,
  role: true,
  avatar: true,
};

function getPagination(query) {
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 20, 1), 100);
  return {
    page,
    limit,
    skip: (page - 1) * limit,
  };
}

router.post("/comments", authenticateToken, async (req, res) => {
  try {
    const { content, assignmentId, submissionId } = req.body;
    if (!assignmentId && !submissionId)
      return res.status(400).json({ error: "Target required" });
    if (!content || typeof content !== "string" || !content.trim()) {
      return res
        .status(400)
        .json({ error: "Nội dung bình luận không được trống" });
    }
    if (content.length > 5000) {
      return res
        .status(400)
        .json({ error: "Nội dung bình luận không được quá 5000 ký tự" });
    }
    if (assignmentId && !parseId(assignmentId))
      return res.status(400).json({ error: "assignmentId không hợp lệ" });
    if (submissionId && !parseId(submissionId))
      return res.status(400).json({ error: "submissionId không hợp lệ" });

    const parsedAssignmentId = assignmentId ? parseId(assignmentId) : null;
    const parsedSubmissionId = submissionId ? parseId(submissionId) : null;

    // If submissionId provided but no assignmentId, resolve it from the submission
    let resolvedAssignmentId = parsedAssignmentId;
    if (parsedSubmissionId && !resolvedAssignmentId) {
      const sub = await prisma.submission.findUnique({
        where: { id: parsedSubmissionId },
        select: { assignmentId: true },
      });
      if (sub) resolvedAssignmentId = sub.assignmentId;
    }

    const comment = await prisma.comment.create({
      data: {
        content: content.trim(),
        userId: req.user.id,
        assignmentId: resolvedAssignmentId,
        submissionId: parsedSubmissionId,
      },
      include: { user: { select: { id: true, name: true, role: true } } },
    });

    try {
      const payload = {
        id: comment.id,
        content: comment.content,
        author_name: comment.user.name,
        author_id: comment.userId,
        created_at: comment.createdAt,
        assignmentId: parsedAssignmentId,
        submissionId: parsedSubmissionId,
      };
      const io = getIO();
      io.emit("comment:new", payload);
      if (submissionId)
        io.to(`submission:${submissionId}`).emit("comment:new", payload);
    } catch (e) {
      console.error("Socket error:", e.message);
    }

    // Notify relevant users about the comment
    try {
      if (submissionId) {
        // Get submission owner to notify
        const sub = await prisma.submission.findUnique({
          where: { id: parsedSubmissionId },
          include: {
            assignment: {
              select: {
                title: true,
                classId: true,
                class: { select: { teacherId: true } },
              },
            },
          },
        });
        if (sub) {
          // Notify student if teacher commented, or teacher if student commented
          const recipientId =
            sub.studentId === req.user.id
              ? sub.assignment.class.teacherId
              : sub.studentId;
          if (recipientId && recipientId !== req.user.id) {
            createNotification({
              userId: recipientId,
              type: "comment",
              title: "Nhận xét mới",
              message: `${comment.user.name} đã nhận xét về bài '${sub.assignment.title}'`,
              link:
                sub.studentId === req.user.id
                  ? `/assignments/${sub.assignmentId}`
                  : `/student/assignments/${sub.assignmentId}`,
            });
          }
        }
      }
    } catch (e) {
      console.error("Comment notification error:", e.message);
    }

    res.status(201).json(comment);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/assignment/:assignmentId", authenticateToken, async (req, res) => {
  try {
    const id = parseId(req.params.assignmentId);
    if (!id) return res.status(400).json({ error: "ID bài tập không hợp lệ" });
    const { page, limit, skip } = getPagination(req.query);

    const assignment = await prisma.assignment.findUnique({
      where: { id },
      include: { class: { select: { id: true, teacherId: true } } },
    });
    if (!assignment)
      return res.status(404).json({ error: "Assignment not found" });

    if (req.user.role === "STUDENT") {
      const member = await prisma.classMember.findFirst({
        where: {
          classId: assignment.classId,
          userId: req.user.id,
          status: "ACTIVE",
        },
      });
      if (!member) return res.status(403).json({ error: "Not in this class" });
    } else if (
      req.user.role === "TEACHER" &&
      assignment.class.teacherId !== req.user.id
    ) {
      return res.status(403).json({ error: "Not your class" });
    }

    const where = { assignmentId: id, submissionId: null };
    const [comments, total] = await Promise.all([
      prisma.comment.findMany({
        where,
        include: { user: { select: COMMENT_USER_SELECT } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip,
        take: limit,
      }),
      prisma.comment.count({ where }),
    ]);

    res.json({ data: comments, total, page, limit });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/submission/:submissionId", authenticateToken, async (req, res) => {
  try {
    const id = parseId(req.params.submissionId);
    if (!id) return res.status(400).json({ error: "ID bài nộp không hợp lệ" });
    const { page, limit, skip } = getPagination(req.query);

    const submission = await prisma.submission.findUnique({
      where: { id },
      include: {
        assignment: {
          select: {
            class: { select: { teacherId: true } },
          },
        },
      },
    });
    if (!submission)
      return res.status(404).json({ error: "Submission not found" });

    if (req.user.role === "STUDENT" && submission.studentId !== req.user.id) {
      return res.status(403).json({ error: "Không có quyền xem comment bài nộp này" });
    }
    if (
      req.user.role === "TEACHER" &&
      submission.assignment.class.teacherId !== req.user.id
    ) {
      return res.status(403).json({ error: "Not your class" });
    }

    const where = { submissionId: id };
    const [comments, total] = await Promise.all([
      prisma.comment.findMany({
        where,
        include: { user: { select: COMMENT_USER_SELECT } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip,
        take: limit,
      }),
      prisma.comment.count({ where }),
    ]);

    res.json({ data: comments, total, page, limit });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
