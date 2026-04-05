/**
 * Assignment routes — CRUD + student assignments list
 */

import express from "express";
import prisma from "../db.js";
import { authenticateToken, authorizeRole } from "../middleware/auth.js";
import { checkClassAccess, logActivity, getClientIP, parseId, validateString, isValidDate } from "./_helpers.js";
import { getIO } from "../socket.js";
import { createNotification } from "./notifications.js";

const router = express.Router();

router.post("/assignments", authenticateToken, authorizeRole(["TEACHER", "ADMIN"]), async (req, res) => {
  try {
    const { title, description, dueDate, classId, fileUrl, startTime, allowLate, maxScore } = req.body;

    const validTitle = validateString(title, 300);
    if (!validTitle) return res.status(400).json({ error: "Tiêu đề bài tập không hợp lệ (tối đa 300 ký tự)" });
    if (description && typeof description === "string" && description.length > 50000) {
      return res.status(400).json({ error: "Mô tả không được quá 50000 ký tự" });
    }
    const parsedClassId = parseId(classId);
    if (!parsedClassId) return res.status(400).json({ error: "classId không hợp lệ" });
    if (dueDate && !isValidDate(dueDate)) return res.status(400).json({ error: "Hạn nộp không hợp lệ" });
    if (startTime && !isValidDate(startTime)) return res.status(400).json({ error: "Thời gian bắt đầu không hợp lệ" });
    if (maxScore != null) {
      const parsed = parseInt(maxScore, 10);
      if (isNaN(parsed) || parsed < 0 || parsed > 1000) return res.status(400).json({ error: "Điểm tối đa phải từ 0 đến 1000" });
    }
    if (fileUrl && typeof fileUrl === "string" && fileUrl.length > 2000) {
      return res.status(400).json({ error: "URL file không hợp lệ" });
    }

    const access = await checkClassAccess(req, parsedClassId);
    if (!access.ok) return res.status(access.status).json({ error: access.message });

    const assignment = await prisma.assignment.create({
      data: {
        title: validTitle,
        description: description || null,
        fileUrl: fileUrl || null,
        startTime: startTime ? new Date(startTime) : null,
        dueDate: dueDate ? new Date(dueDate) : null,
        allowLate: allowLate === true,
        maxScore: maxScore != null ? Math.max(0, parseInt(maxScore, 10) || 10) : 10,
        classId: parsedClassId,
        createdById: req.user.id,
      },
      include: { class: { select: { id: true, name: true } } },
    });

    await logActivity({
      userId: req.user.id,
      userName: req.user.name,
      userRole: req.user.role.toLowerCase(),
      action: "Giao bài tập mới",
      actionType: "create",
      resource: "Assignment",
      resourceId: assignment.id,
      details: `Giao bài '${title}' cho lớp ${assignment.class.name}`,
      ipAddress: getClientIP(req),
    });

    // Realtime: emit to class room + notify all students
    try {
      const io = getIO();
      io.to(`class:${parsedClassId}`).emit("assignment:new", {
        id: assignment.id,
        title: assignment.title,
        className: assignment.class.name,
        classId: parsedClassId,
        dueDate: assignment.dueDate,
        teacherName: req.user.name,
      });

      // Create notifications for all active students in the class
      const members = await prisma.classMember.findMany({
        where: { classId: parsedClassId, status: "ACTIVE" },
        select: { userId: true },
      });
      await Promise.allSettled(
        members.map((m) =>
          createNotification({
            userId: m.userId,
            type: "assignment",
            title: "Bài tập mới",
            message: `${req.user.name} đã giao bài '${title}' trong lớp ${assignment.class.name}`,
            link: `/student/assignments`,
          })
        )
      );
    } catch (socketErr) {
      console.error("Socket/notification error:", socketErr);
    }

    res.status(201).json(assignment);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/assignments/:id", authenticateToken, async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: "ID bài tập không hợp lệ" });

    const assignment = await prisma.assignment.findUnique({
      where: { id },
      include: { class: { select: { id: true, name: true, teacherId: true } } },
    });
    if (!assignment) return res.status(404).json({ error: "Assignment not found" });

    if (req.user.role === "STUDENT") {
      const member = await prisma.classMember.findFirst({
        where: { classId: assignment.classId, userId: req.user.id, status: "ACTIVE" },
      });
      if (!member) return res.status(403).json({ error: "Not in this class" });
    } else if (req.user.role === "TEACHER" && assignment.class.teacherId !== req.user.id) {
      return res.status(403).json({ error: "Not your class" });
    }

    res.json(assignment);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.patch("/assignments/:id", authenticateToken, authorizeRole(["TEACHER", "ADMIN"]), async (req, res) => {
  try {
    const assignmentId = parseId(req.params.id);
    if (!assignmentId) return res.status(400).json({ error: "ID bài tập không hợp lệ" });

    const assignment = await prisma.assignment.findUnique({
      where: { id: assignmentId },
      include: { class: true },
    });
    if (!assignment) return res.status(404).json({ error: "Assignment not found" });

    const access = await checkClassAccess(req, assignment.classId);
    if (!access.ok) return res.status(access.status).json({ error: access.message });

    const { title, description, dueDate, fileUrl, startTime, allowLate, maxScore } = req.body;
    const data = {};
    if (title !== undefined) {
      const validTitle = validateString(title, 300);
      if (!validTitle) return res.status(400).json({ error: "Tiêu đề bài tập không hợp lệ (tối đa 300 ký tự)" });
      data.title = validTitle;
    }
    if (description !== undefined) {
      if (typeof description === "string" && description.length > 50000) {
        return res.status(400).json({ error: "Mô tả không được quá 50000 ký tự" });
      }
      data.description = description || null;
    }
    if (dueDate !== undefined) {
      if (dueDate && !isValidDate(dueDate)) return res.status(400).json({ error: "Hạn nộp không hợp lệ" });
      data.dueDate = dueDate ? new Date(dueDate) : null;
    }
    if (fileUrl !== undefined) {
      if (fileUrl && typeof fileUrl === "string" && fileUrl.length > 2000) return res.status(400).json({ error: "URL file không hợp lệ" });
      data.fileUrl = fileUrl || null;
    }
    if (startTime !== undefined) {
      if (startTime && !isValidDate(startTime)) return res.status(400).json({ error: "Thời gian bắt đầu không hợp lệ" });
      data.startTime = startTime ? new Date(startTime) : null;
    }
    if (allowLate !== undefined) data.allowLate = allowLate === true;
    if (maxScore !== undefined) {
      const parsed = parseInt(maxScore, 10);
      if (isNaN(parsed) || parsed < 0 || parsed > 1000) return res.status(400).json({ error: "Điểm tối đa phải từ 0 đến 1000" });
      data.maxScore = parsed;
    }

    const updated = await prisma.assignment.update({
      where: { id: assignmentId },
      data,
      include: { class: { select: { id: true, name: true } } },
    });
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/classes/:classId/assignments", authenticateToken, async (req, res) => {
  try {
    const classId = parseId(req.params.classId);
    if (!classId) return res.status(400).json({ error: "classId không hợp lệ" });

    const access = await checkClassAccess(req, classId);
    if (!access.ok) return res.status(access.status).json({ error: access.message });

    const paginate = req.query.page !== undefined;
    const page = Math.max(Number(req.query.page) || 1, 1);
    const take = Math.min(Number(req.query.limit) || 50, 100);

    const findOpts = {
      where: { classId: classId },
      include: { _count: { select: { submissions: true } } },
      orderBy: { dueDate: "asc" },
    };
    if (paginate) {
      findOpts.skip = (page - 1) * take;
      findOpts.take = take;
    }

    const assignments = await prisma.assignment.findMany(findOpts);

    if (paginate) {
      const total = await prisma.assignment.count({ where: findOpts.where });
      return res.json({ data: assignments, total, page, limit: take });
    }
    res.json(assignments);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete("/assignments/:id", authenticateToken, authorizeRole(["TEACHER", "ADMIN"]), async (req, res) => {
  try {
    const assignmentId = parseId(req.params.id);
    if (!assignmentId) return res.status(400).json({ error: "ID bài tập không hợp lệ" });

    const assignment = await prisma.assignment.findUnique({
      where: { id: assignmentId },
      include: { class: true },
    });
    if (!assignment) return res.status(404).json({ error: "Assignment not found" });
    const access = await checkClassAccess(req, assignment.classId);
    if (!access.ok) return res.status(access.status).json({ error: access.message });
    await prisma.assignment.delete({
      where: { id: assignmentId },
    });
    res.json({ message: "Assignment deleted" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/** Student: all my assignments (from enrolled classes) with my submission status */
router.get("/student/assignments", authenticateToken, authorizeRole(["STUDENT"]), async (req, res) => {
  try {
    const memberships = await prisma.classMember.findMany({
      where: { userId: req.user.id, status: "ACTIVE" },
      select: { classId: true },
    });
    const classIds = memberships.map((m) => m.classId);
    if (classIds.length === 0) return res.json([]);

    const assignments = await prisma.assignment.findMany({
      where: { classId: { in: classIds } },
      include: {
        class: { select: { id: true, name: true } },
      },
      orderBy: { dueDate: "asc" },
    });

    const submissionMap = {};
    const subs = await prisma.submission.findMany({
      where: {
        assignmentId: { in: assignments.map((a) => a.id) },
        studentId: req.user.id,
      },
      include: { grade: true },
    });
    subs.forEach((s) => {
      submissionMap[s.assignmentId] = s;
    });

    const result = assignments.map((a) => {
      const sub = submissionMap[a.id];
      return {
        assignment: {
          id: a.id,
          title: a.title,
          description: a.description,
          fileUrl: a.fileUrl,
          dueDate: a.dueDate,
          allowLate: a.allowLate,
          maxScore: a.maxScore ?? 10,
          classId: a.classId,
        },
        class: a.class,
        mySubmission: sub
          ? {
              id: sub.id,
              assignmentId: sub.assignmentId,
              studentId: sub.studentId,
              fileUrl: sub.fileUrl,
              content: sub.content,
              submittedAt: sub.submittedAt,
              lastUpdatedAt: sub.lastUpdatedAt,
              status: sub.status,
              grade: sub.grade
                ? {
                    id: sub.grade.id,
                    score: Number(sub.grade.score),
                    gradedAt: sub.grade.gradedAt instanceof Date ? sub.grade.gradedAt.toISOString() : sub.grade.gradedAt,
                  }
                : null,
            }
          : null,
      };
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
