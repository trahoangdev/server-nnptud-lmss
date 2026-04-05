/**
 * Submission routes — create/upsert, list by assignment
 */

import express from "express";
import prisma from "../db.js";
import { authenticateToken, authorizeRole } from "../middleware/auth.js";
import { checkClassAccess, logActivity, getClientIP, parseId } from "./_helpers.js";
import { getIO } from "../socket.js";
import { createNotification } from "./notifications.js";

const router = express.Router();

router.post("/submissions", authenticateToken, authorizeRole(["STUDENT"]), async (req, res) => {
  try {
    const { content, fileUrl, assignmentId } = req.body;

    const parsedAssignmentId = parseId(assignmentId);
    if (!parsedAssignmentId) return res.status(400).json({ error: "assignmentId không hợp lệ" });
    if (content && typeof content === "string" && content.length > 50000) {
      return res.status(400).json({ error: "Nội dung bài nộp không được quá 50000 ký tự" });
    }
    if (fileUrl && typeof fileUrl === "string" && fileUrl.length > 2000) {
      return res.status(400).json({ error: "URL file không hợp lệ" });
    }
    if (!content?.trim() && !fileUrl) {
      return res.status(400).json({ error: "Vui lòng nhập nội dung hoặc đính kèm file" });
    }

    const assignment = await prisma.assignment.findUnique({
      where: { id: parsedAssignmentId },
      include: { class: true },
    });
    if (!assignment) return res.status(404).json({ error: "Assignment not found" });

    const member = await prisma.classMember.findFirst({
      where: { classId: assignment.classId, userId: req.user.id, status: "ACTIVE" },
    });
    if (!member) return res.status(403).json({ error: "Not in this class" });

    const now = new Date();
    const due = assignment.dueDate ? new Date(assignment.dueDate) : null;
    let status = "SUBMITTED";
    if (due && now > due) {
      if (!assignment.allowLate) {
        return res.status(400).json({ error: "Deadline passed. Late submission not allowed." });
      }
      status = "LATE_SUBMITTED";
    }

    const submission = await prisma.submission.upsert({
      where: {
        assignmentId_studentId: { assignmentId: parsedAssignmentId, studentId: req.user.id },
      },
      update: {
        content: content ?? undefined,
        fileUrl: fileUrl ?? undefined,
        status,
        lastUpdatedAt: now,
        submittedAt: now,
      },
      create: {
        content: content || null,
        fileUrl: fileUrl || null,
        assignmentId: parsedAssignmentId,
        studentId: req.user.id,
        status,
        lastUpdatedAt: now,
      },
      include: { student: { select: { id: true, name: true, email: true } }, grade: true },
    });

    try {
      const io = getIO();
      io.to(`class:${assignment.classId}`).emit("submission:new", {
        assignment_id: assignment.id,
        submission_id: submission.id,
        student_id: submission.studentId,
        submitted_at: submission.submittedAt,
        status,
      });
      io.to(`assignment:${assignment.id}`).emit("submission:updated", { submission_id: submission.id, status });
    } catch (e) {
      console.error("Socket error:", e.message);
    }

    // Notify teacher
    try {
      await createNotification({
        userId: assignment.class.teacherId,
        type: "submission",
        title: "Bài nộp mới",
        message: `${req.user.name} đã nộp bài '${assignment.title}'`,
        link: `/assignments/${assignment.id}`,
      });
    } catch (e) {
      console.error("Notification error:", e.message);
    }

    await logActivity({
      userId: req.user.id,
      userName: req.user.name,
      userRole: "student",
      action: "Nộp bài tập",
      actionType: "create",
      resource: "Submission",
      resourceId: submission.id,
      details: `Nộp bài '${assignment.title}' cho lớp ${assignment.class.name}`,
      ipAddress: getClientIP(req),
      status: status === "LATE_SUBMITTED" ? "warning" : "success",
    });

    res.status(201).json(submission);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/** Student: cancel (delete) own submission — only if not graded & before deadline */
router.delete("/submissions/:id", authenticateToken, authorizeRole(["STUDENT"]), async (req, res) => {
  try {
    const submissionId = parseId(req.params.id);
    if (!submissionId) return res.status(400).json({ error: "ID bài nộp không hợp lệ" });

    const submission = await prisma.submission.findUnique({
      where: { id: submissionId },
      include: { assignment: true, grade: true },
    });
    if (!submission) return res.status(404).json({ error: "Submission not found" });
    if (submission.studentId !== req.user.id) return res.status(403).json({ error: "Not your submission" });
    if (submission.grade) return res.status(400).json({ error: "Cannot cancel a graded submission" });

    const now = new Date();
    const due = submission.assignment.dueDate ? new Date(submission.assignment.dueDate) : null;
    if (due && now > due) {
      return res.status(400).json({ error: "Cannot cancel after deadline" });
    }

    await prisma.submission.delete({ where: { id: submissionId } });

    try {
      const io = getIO();
      io.to(`assignment:${submission.assignmentId}`).emit("submission:updated", { submission_id: submissionId, status: "CANCELLED" });
    } catch (e) { /* ignore */ }

    await logActivity({
      userId: req.user.id,
      userName: req.user.name,
      userRole: "student",
      action: "Huỷ nộp bài",
      actionType: "delete",
      resource: "Submission",
      resourceId: submissionId,
      details: `Huỷ nộp bài '${submission.assignment.title}'`,
      ipAddress: getClientIP(req),
      status: "info",
    });

    res.json({ message: "Submission cancelled" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/assignments/:assignmentId/submissions", authenticateToken, async (req, res) => {
  try {
    const assignmentId = parseId(req.params.assignmentId);
    if (!assignmentId) return res.status(400).json({ error: "assignmentId không hợp lệ" });

    const assignment = await prisma.assignment.findUnique({
      where: { id: assignmentId },
      include: { class: true },
    });
    if (!assignment) return res.status(404).json({ error: "Assignment not found" });

    if (req.user.role === "STUDENT") {
      const subs = await prisma.submission.findMany({
        where: { assignmentId, studentId: req.user.id },
        include: { grade: true },
      });
      return res.json(subs);
    }

    const access = await checkClassAccess(req, assignment.classId);
    if (!access.ok) return res.status(access.status).json({ error: access.message });

    const submissions = await prisma.submission.findMany({
      where: { assignmentId },
      include: { student: { select: { id: true, name: true, email: true } }, grade: true },
    });
    res.json(submissions);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
