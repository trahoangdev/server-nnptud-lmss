/**
 * Grade routes — chấm điểm bài nộp
 */

import express from "express";
import prisma from "../db.js";
import { authenticateToken } from "../middleware/auth.js";
import { parseId, getClientIP } from "./_helpers.js";
import { createNotification } from "./notifications.js";

const router = express.Router();

// POST / — chấm điểm (Teacher/Admin)
router.post("/", authenticateToken, async (req, res) => {
  try {
    if (req.user.role === "STUDENT") {
      return res.status(403).json({ error: "Sinh viên không có quyền chấm điểm" });
    }

    const { submissionId, score } = req.body;

    const subId = parseId(submissionId);
    if (!subId) return res.status(400).json({ error: "submissionId không hợp lệ" });

    if (typeof score !== "number" || isNaN(score)) {
      return res.status(400).json({ error: "score phải là số" });
    }

    const submission = await prisma.submission.findUnique({
      where: { id: subId },
      include: {
        assignment: {
          select: {
            id: true,
            title: true,
            maxScore: true,
            class: { select: { id: true, teacherId: true } },
          },
        },
      },
    });
    if (!submission) return res.status(404).json({ error: "Submission not found" });

    if (req.user.role === "TEACHER" && submission.assignment.class.teacherId !== req.user.id) {
      return res.status(403).json({ error: "Không phải lớp của bạn" });
    }

    if (score < 0 || score > submission.assignment.maxScore) {
      return res.status(400).json({
        error: `Score phải từ 0 đến ${submission.assignment.maxScore}`,
      });
    }

    const grade = await prisma.grade.upsert({
      where: { submissionId: subId },
      create: {
        score,
        submissionId: subId,
        gradedById: req.user.id,
      },
      update: {
        score,
        gradedById: req.user.id,
      },
      include: {
        submission: {
          include: {
            student: { select: { id: true, name: true, email: true } },
            assignment: { select: { id: true, title: true } },
          },
        },
        gradedBy: { select: { id: true, name: true } },
      },
    });

    // Update submission status
    await prisma.submission.update({
      where: { id: subId },
      data: { status: "GRADED" },
    });

    // Log
    await prisma.activityLog.create({
      data: {
        userId: req.user.id,
        userName: req.user.name,
        userRole: req.user.role.toLowerCase(),
        action: "Chấm điểm",
        actionType: "create",
        resource: "Grade",
        resourceId: grade.id,
        details: `Chấm ${score}/${submission.assignment.maxScore} cho '${submission.assignment.title}' — ${grade.submission.student.name}`,
        ipAddress: getClientIP(req),
        status: "SUCCESS",
      },
    });

    res.status(201).json(grade);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /:submissionId — lấy điểm của bài nộp
router.get("/:submissionId", authenticateToken, async (req, res) => {
  try {
    const submissionId = parseId(req.params.submissionId);
    if (!submissionId) return res.status(400).json({ error: "submissionId không hợp lệ" });

    const submission = await prisma.submission.findUnique({
      where: { id: submissionId },
      include: { assignment: { select: { class: { select: { teacherId: true } } } } },
    });
    if (!submission) return res.status(404).json({ error: "Submission not found" });

    if (
      req.user.role === "STUDENT" &&
      submission.studentId !== req.user.id &&
      submission.assignment.class.teacherId !== req.user.id
    ) {
      return res.status(403).json({ error: "Không có quyền xem điểm này" });
    }

    const grade = await prisma.grade.findUnique({
      where: { submissionId },
      include: {
        gradedBy: { select: { id: true, name: true } },
        submission: {
          include: {
            student: { select: { id: true, name: true } },
            assignment: { select: { id: true, title: true, maxScore: true } },
          },
        },
      },
    });

    if (!grade) return res.status(404).json({ error: "Chưa có điểm cho bài nộp này" });

    res.json(grade);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
