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

export default router;
