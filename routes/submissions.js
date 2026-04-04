/**
 * Submission routes — student submission handling
 */

import express from "express";
import prisma from "../db.js";
import { authenticateToken } from "../middleware/auth.js";
import { checkClassAccess, getClientIP, parseId, isValidDate } from "./_helpers.js";

const router = express.Router();

// POST / — nộp bài (Student only)
router.post("/", authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== "STUDENT") {
      return res.status(403).json({ error: "Chỉ sinh viên mới được nộp bài" });
    }

    const { assignmentId, content, fileUrl } = req.body;

    const id = parseId(assignmentId);
    if (!id) return res.status(400).json({ error: "assignmentId không hợp lệ" });

    // Check assignment exists
    const assignment = await prisma.assignment.findUnique({
      where: { id },
      include: { class: { select: { id: true, name: true, teacherId: true } } },
    });
    if (!assignment) return res.status(404).json({ error: "Assignment not found" });

    // Check membership
    const member = await prisma.classMember.findFirst({
      where: { classId: assignment.classId, userId: req.user.id, status: "ACTIVE" },
    });
    if (!member) return res.status(403).json({ error: "Không thuộc lớp này" });

    // Validate content
    if (!content && !fileUrl) {
      return res.status(400).json({ error: "Cần cung cấp content hoặc fileUrl" });
    }
    if (content && typeof content === "string" && content.length > 100000) {
      return res.status(400).json({ error: "Nội dung không được quá 100000 ký tự" });
    }
    if (fileUrl && typeof fileUrl === "string" && fileUrl.length > 2000) {
      return res.status(400).json({ error: "URL file không hợp lệ" });
    }

    // Determine status
    let status = "SUBMITTED";
    if (assignment.dueDate) {
      const now = new Date();
      const dueDate = new Date(assignment.dueDate);
      if (now > dueDate && !assignment.allowLate) {
        return res.status(400).json({ error: "Đã quá hạn nộp và không cho phép nộp muộn" });
      }
      if (now > dueDate && assignment.allowLate) {
        status = "LATE_SUBMITTED";
      }
    }

    // Upsert submission
    const submission = await prisma.submission.upsert({
      where: { assignmentId_studentId: { assignmentId: id, studentId: req.user.id } },
      create: {
        content: content || null,
        fileUrl: fileUrl || null,
        status,
        assignmentId: id,
        studentId: req.user.id,
      },
      update: {
        content: content || null,
        fileUrl: fileUrl || null,
        status,
        submittedAt: new Date(),
      },
      include: { assignment: { select: { id: true, title: true, class: { select: { name: true } } } } },
    });

    // Log activity
    await prisma.activityLog.create({
      data: {
        userId: req.user.id,
        userName: req.user.name,
        userRole: req.user.role.toLowerCase(),
        action: "Nộp bài tập",
        actionType: "create",
        resource: "Submission",
        resourceId: submission.id,
        details: `Nộp bài '${assignment.title}' (${status})`,
        ipAddress: getClientIP(req),
        status: "SUCCESS",
      },
    });

    res.status(201).json(submission);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /assignment/:assignmentId — danh sách bài nộp theo assignment (Teacher/Admin)
router.get("/assignment/:assignmentId", authenticateToken, async (req, res) => {
  try {
    const assignmentId = parseId(req.params.assignmentId);
    if (!assignmentId) return res.status(400).json({ error: "assignmentId không hợp lệ" });

    const assignment = await prisma.assignment.findUnique({
      where: { id: assignmentId },
      include: { class: { select: { teacherId: true } } },
    });
    if (!assignment) return res.status(404).json({ error: "Assignment not found" });

    // Access check
    if (req.user.role === "STUDENT") {
      return res.status(403).json({ error: "Chỉ giáo viên hoặc admin mới xem được" });
    }
    if (req.user.role === "TEACHER" && assignment.class.teacherId !== req.user.id) {
      return res.status(403).json({ error: "Không phải lớp của bạn" });
    }

    const { page = 1, limit = 50 } = req.query;
    const skip = (Math.max(1, parseInt(page)) - 1) * Math.min(100, parseInt(limit));
    const take = Math.min(100, Math.max(1, parseInt(limit)));

    const [submissions, total] = await Promise.all([
      prisma.submission.findMany({
        where: { assignmentId },
        include: {
          student: { select: { id: true, name: true, email: true } },
          grade: { select: { id: true, score: true, gradedAt: true } },
        },
        orderBy: { submittedAt: "desc" },
        skip,
        take,
      }),
      prisma.submission.count({ where: { assignmentId } }),
    ]);

    res.json({ data: submissions, total, page: parseInt(page), limit: take });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /:id — chi tiết bài nộp
router.get("/:id", authenticateToken, async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: "ID bài nộp không hợp lệ" });

    const submission = await prisma.submission.findUnique({
      where: { id },
      include: {
        student: { select: { id: true, name: true, email: true, avatar: true } },
        assignment: {
          select: {
            id: true,
            title: true,
            maxScore: true,
            class: { select: { id: true, teacherId: true } },
          },
        },
        grade: { select: { id: true, score: true, gradedAt: true } },
      },
    });
    if (!submission) return res.status(404).json({ error: "Submission not found" });

    // Access check
    if (req.user.role === "STUDENT" && submission.studentId !== req.user.id) {
      return res.status(403).json({ error: "Không có quyền xem bài nộp này" });
    }
    if (req.user.role === "TEACHER" && submission.assignment.class.teacherId !== req.user.id) {
      return res.status(403).json({ error: "Không phải lớp của bạn" });
    }

    res.json(submission);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /:id — cập nhật / resubmit bài nộp (chỉ owner)
router.put("/:id", authenticateToken, async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: "ID bài nộp không hợp lệ" });

    const submission = await prisma.submission.findUnique({
      where: { id },
      include: { assignment: { select: { id: true, title: true, dueDate: true, allowLate: true } } },
    });
    if (!submission) return res.status(404).json({ error: "Submission not found" });

    if (submission.studentId !== req.user.id) {
      return res.status(403).json({ error: "Chỉ chủ bài nộp mới được cập nhật" });
    }

    const { content, fileUrl } = req.body;

    if (content && typeof content === "string" && content.length > 100000) {
      return res.status(400).json({ error: "Nội dung không được quá 100000 ký tự" });
    }
    if (fileUrl && typeof fileUrl === "string" && fileUrl.length > 2000) {
      return res.status(400).json({ error: "URL file không hợp lệ" });
    }

    // Re-check due date
    let status = submission.status;
    if (submission.assignment.dueDate) {
      const now = new Date();
      const dueDate = new Date(submission.assignment.dueDate);
      if (now > dueDate && submission.assignment.allowLate) {
        status = "LATE_SUBMITTED";
      }
    }

    const updated = await prisma.submission.update({
      where: { id },
      data: {
        ...(content !== undefined && { content: content || null }),
        ...(fileUrl !== undefined && { fileUrl: fileUrl || null }),
        status,
        submittedAt: new Date(),
      },
      include: {
        student: { select: { id: true, name: true } },
        assignment: { select: { id: true, title: true } },
        grade: { select: { id: true, score: true } },
      },
    });

    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
