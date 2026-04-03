/**
 * Assignment routes
 */

import express from "express";
import prisma from "../db.js";
import { authenticateToken, authorizeRole } from "../middleware/auth.js";
import { checkClassAccess, validateString, isValidDate, parseId } from "./_helpers.js";
import { getIO } from "../socket.js";

const router = express.Router();

// POST / — tạo bài tập mới (Teacher/Admin)
router.post("/", authenticateToken, authorizeRole(["TEACHER", "ADMIN"]), async (req, res) => {
  try {
    const { title, description, fileUrl, startTime, dueDate, allowLate, maxScore, classId } = req.body;

    const validTitle = validateString(title, 300);
    if (!validTitle) {
      return res.status(400).json({ error: "Tiêu đề bài tập không hợp lệ (tối đa 300 ký tự)" });
    }

    const parsedClassId = parseId(classId);
    if (!parsedClassId) {
      return res.status(400).json({ error: "classId không hợp lệ" });
    }

    if (dueDate && !isValidDate(dueDate)) {
      return res.status(400).json({ error: "Hạn nộp không hợp lệ" });
    }

    if (startTime && !isValidDate(startTime)) {
      return res.status(400).json({ error: "Thời gian bắt đầu không hợp lệ" });
    }

    if (maxScore != null) {
      const parsed = parseInt(maxScore, 10);
      if (isNaN(parsed) || parsed < 0 || parsed > 1000) {
        return res.status(400).json({ error: "Điểm tối đa phải từ 0 đến 1000" });
      }
    }

    const access = await checkClassAccess(req, parsedClassId);
    if (!access.ok) {
      return res.status(access.status).json({ error: access.message });
    }

    const assignment = await prisma.assignment.create({
      data: {
        title: validTitle,
        description: description || null,
        fileUrl: fileUrl || null,
        startTime: startTime ? new Date(startTime) : null,
        dueDate: dueDate ? new Date(dueDate) : null,
        allowLate: allowLate === true,
        maxScore: maxScore != null ? Math.max(0, parseInt(maxScore, 10)) : 10,
        classId: parsedClassId,
        createdById: req.user.id,
      },
      include: { class: { select: { id: true, name: true } } },
    });

    // Emit socket
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
    } catch (socketErr) {
      console.error("Socket error:", socketErr);
    }

    res.status(201).json(assignment);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /class/:classId — danh sách bài tập theo lớp (Teacher/Student/Admin)
router.get("/class/:classId", authenticateToken, async (req, res) => {
  try {
    const classId = parseId(req.params.classId);
    if (!classId) {
      return res.status(400).json({ error: "classId không hợp lệ" });
    }

    const access = await checkClassAccess(req, classId);
    if (!access.ok) {
      return res.status(access.status).json({ error: access.message });
    }

    const page = Math.max(Number(req.query.page) || 1, 1);
    const take = Math.min(Number(req.query.limit) || 50, 100);

    const [assignments, total] = await Promise.all([
      prisma.assignment.findMany({
        where: { classId },
        include: {
          class: { select: { id: true, name: true } },
          _count: { select: { submissions: true } },
        },
        orderBy: { dueDate: "asc" },
        skip: (page - 1) * take,
        take,
      }),
      prisma.assignment.count({ where: { classId } }),
    ]);

    res.json({ data: assignments, total, page, limit: take });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /:id — chi tiết bài tập
router.get("/:id", authenticateToken, async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) {
      return res.status(400).json({ error: "ID bài tập không hợp lệ" });
    }

    const assignment = await prisma.assignment.findUnique({
      where: { id },
      include: {
        class: { select: { id: true, name: true, teacherId: true } },
        createdBy: { select: { id: true, name: true } },
        _count: { select: { submissions: true } },
      },
    });

    if (!assignment) {
      return res.status(404).json({ error: "Assignment not found" });
    }

    // Access check: student phải là member, teacher phải là owner
    if (req.user.role === "STUDENT") {
      const member = await prisma.classMember.findFirst({
        where: { classId: assignment.classId, userId: req.user.id, status: "ACTIVE" },
      });
      if (!member) {
        return res.status(403).json({ error: "Bạn không có quyền truy cập bài tập này" });
      }
    } else if (req.user.role === "TEACHER" && assignment.class.teacherId !== req.user.id) {
      return res.status(403).json({ error: "Bạn không phải giáo viên của lớp này" });
    }

    res.json(assignment);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
