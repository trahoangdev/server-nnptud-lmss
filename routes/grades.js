/**
 * Grade routes — upsert grade with socket notification
 */

import express from "express";
import prisma from "../db.js";
import { authenticateToken, authorizeRole } from "../middleware/auth.js";
import { checkClassAccess, logActivity, getClientIP, parseId } from "./_helpers.js";
import { getIO } from "../socket.js";
import { createNotification } from "./notifications.js";

const router = express.Router();

router.post("/grades", authenticateToken, authorizeRole(["TEACHER", "ADMIN"]), async (req, res) => {
  try {
    const { submissionId, score } = req.body;

    const parsedSubmissionId = parseId(submissionId);
    if (!parsedSubmissionId) return res.status(400).json({ error: "submissionId không hợp lệ" });
    if (score === undefined || score === null || score === "") {
      return res.status(400).json({ error: "Vui lòng nhập điểm" });
    }
    const numScore = parseFloat(score);
    if (isNaN(numScore)) return res.status(400).json({ error: "Điểm phải là số" });

    const submission = await prisma.submission.findUnique({
      where: { id: parsedSubmissionId },
      include: { assignment: true },
    });
    if (!submission) return res.status(404).json({ error: "Submission not found" });

    const access = await checkClassAccess(req, submission.assignment.classId);
    if (!access.ok) return res.status(access.status).json({ error: access.message });

    const maxScore = submission.assignment.maxScore ?? 10;
    if (numScore < 0 || numScore > maxScore) {
      return res.status(400).json({ error: `Score must be between 0 and ${maxScore}` });
    }

    const grade = await prisma.grade.upsert({
      where: { submissionId: parsedSubmissionId },
      update: { score: numScore, gradedById: req.user.id, gradedAt: new Date() },
      create: {
        submissionId: parsedSubmissionId,
        score: numScore,
        gradedById: req.user.id,
      },
    });

    try {
      const io = getIO();
      io.to(`user:${submission.studentId}`).emit("grade:updated", {
        submission_id: submission.id,
        score: grade.score,
        graded_at: grade.gradedAt,
        assignment_title: submission.assignment.title,
      });
      io.to(`assignment:${submission.assignmentId}`).emit("grade:updated", {
        submission_id: submission.id,
        score: grade.score,
        student_id: submission.studentId,
      });
      io.to(`class:${submission.assignment.classId}`).emit("grade:updated", {
        submission_id: submission.id,
        score: grade.score,
        student_id: submission.studentId,
      });
    } catch (e) {
      console.error("Socket error:", e.message);
    }

    // Notify student
    try {
      createNotification({
        userId: submission.studentId,
        type: "grade",
        title: "Đã chấm điểm",
        message: `Bài '${submission.assignment.title}' được chấm ${grade.score} điểm`,
        link: `/student/assignments/${submission.assignmentId}`,
      });
    } catch (e) {
      console.error("Notification error:", e.message);
    }

    await logActivity({
      userId: req.user.id,
      userName: req.user.name,
      userRole: req.user.role.toLowerCase(),
      action: "Chấm điểm bài tập",
      actionType: "update",
      resource: "Grade",
      resourceId: grade.id,
      details: `Chấm điểm ${grade.score} cho submission #${submission.id}`,
      ipAddress: getClientIP(req),
    });

    res.json(grade);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
