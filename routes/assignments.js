/**
 * Assignment routes — CRUD + student assignments list
 */

import express from "express";
import prisma from "../db.js";
import { authenticateToken, authorizeRole } from "../middleware/auth.js";
import { checkClassAccess, logActivity, getClientIP, parseId, validateString, isValidDate } from "./_helpers.js";

const router = express.Router();

// POST / — tạo assignment mới (Teacher/Admin only)
router.post("/", authenticateToken, authorizeRole(["TEACHER", "ADMIN"]), async (req, res) => {
  try {
    const { title, description, dueDate, classId, fileUrl, startTime, allowLate, maxScore } = req.body;

    // Validate required fields
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
      if (isNaN(parsed) || parsed < 0 || parsed > 1000) {
        return res.status(400).json({ error: "Điểm tối đa phải từ 0 đến 1000" });
      }
    }

    if (fileUrl && typeof fileUrl === "string" && fileUrl.length > 2000) {
      return res.status(400).json({ error: "URL file không hợp lệ" });
    }

    // Check class access
    const access = await checkClassAccess(req, parsedClassId);
    if (!access.ok) return res.status(access.status).json({ error: access.message });

    // Create assignment
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

    // Log activity
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

    res.status(201).json(assignment);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /class/:classId — danh sách assignment theo lớp (có phân trang, sort by dueDate)
router.get("/class/:classId", authenticateToken, async (req, res) => {
  try {
    const classId = parseId(req.params.classId);
    if (!classId) return res.status(400).json({ error: "classId không hợp lệ" });

    // Check class access
    const access = await checkClassAccess(req, classId);
    if (!access.ok) return res.status(access.status).json({ error: access.message });

    // Pagination
    const page = Math.max(Number(req.query.page) || 1, 1);
    const take = Math.min(Number(req.query.limit) || 50, 100);
    const skip = (page - 1) * take;

    const [assignments, total] = await Promise.all([
      prisma.assignment.findMany({
        where: { classId },
        include: { _count: { select: { submissions: true } } },
        orderBy: { dueDate: "asc" },
        skip,
        take,
      }),
      prisma.assignment.count({ where: { classId } }),
    ]);

    res.json({ data: assignments, total, page, limit: take });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /:id — chi tiết một assignment (include class info + submission count)
router.get("/:id", authenticateToken, async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: "ID bài tập không hợp lệ" });

    const assignment = await prisma.assignment.findUnique({
      where: { id },
      include: {
        class: { select: { id: true, name: true, teacherId: true } },
        _count: { select: { submissions: true } },
      },
    });

    if (!assignment) return res.status(404).json({ error: "Assignment not found" });

    // Access control: Student phải là member, Teacher phải là chủ lớp
    if (req.user.role === "STUDENT") {
      const member = await prisma.classMember.findFirst({
        where: { classId: assignment.classId, userId: req.user.id, status: "ACTIVE" },
      });
      if (!member) return res.status(403).json({ error: "Không thuộc lớp này" });
    } else if (req.user.role === "TEACHER" && assignment.class.teacherId !== req.user.id) {
      return res.status(403).json({ error: "Không phải lớp của bạn" });
    }

    res.json(assignment);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /:id — cập nhật assignment (Teacher/Admin only, Teacher phải là chủ lớp)
router.put("/:id", authenticateToken, authorizeRole(["TEACHER", "ADMIN"]), async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: "ID bài tập không hợp lệ" });

    const assignment = await prisma.assignment.findUnique({
      where: { id },
      include: { class: { select: { teacherId: true, name: true } } },
    });
    if (!assignment) return res.status(404).json({ error: "Assignment not found" });

    // Teacher phải là chủ lớp
    if (req.user.role === "TEACHER" && assignment.class.teacherId !== req.user.id) {
      return res.status(403).json({ error: "Không phải lớp của bạn" });
    }

    const { title, description, fileUrl, startTime, dueDate, allowLate, maxScore } = req.body;

    // Validate
    if (title !== undefined) {
      const validTitle = validateString(title, 300);
      if (!validTitle) return res.status(400).json({ error: "Tiêu đề không hợp lệ (tối đa 300 ký tự)" });
    }
    if (description !== undefined && typeof description === "string" && description.length > 50000) {
      return res.status(400).json({ error: "Mô tả không được quá 50000 ký tự" });
    }
    if (dueDate !== undefined && dueDate && !isValidDate(dueDate)) {
      return res.status(400).json({ error: "Hạn nộp không hợp lệ" });
    }
    if (startTime !== undefined && startTime && !isValidDate(startTime)) {
      return res.status(400).json({ error: "Thời gian bắt đầu không hợp lệ" });
    }
    if (maxScore !== undefined) {
      const parsed = parseInt(maxScore, 10);
      if (isNaN(parsed) || parsed < 0 || parsed > 1000) {
        return res.status(400).json({ error: "Điểm tối đa phải từ 0 đến 1000" });
      }
    }
    if (fileUrl !== undefined && typeof fileUrl === "string" && fileUrl.length > 2000) {
      return res.status(400).json({ error: "URL file không hợp lệ" });
    }

    const updated = await prisma.assignment.update({
      where: { id },
      data: {
        ...(title !== undefined && { title: validateString(title, 300) }),
        ...(description !== undefined && { description }),
        ...(fileUrl !== undefined && { fileUrl: fileUrl || null }),
        ...(startTime !== undefined && { startTime: startTime ? new Date(startTime) : null }),
        ...(dueDate !== undefined && { dueDate: dueDate ? new Date(dueDate) : null }),
        ...(allowLate !== undefined && { allowLate: allowLate === true }),
        ...(maxScore !== undefined && { maxScore: Math.max(0, parseInt(maxScore, 10)) }),
      },
      include: { class: { select: { id: true, name: true } } },
    });

    // Log activity
    await logActivity({
      userId: req.user.id,
      userName: req.user.name,
      userRole: req.user.role.toLowerCase(),
      action: "Cập nhật bài tập",
      actionType: "update",
      resource: "Assignment",
      resourceId: id,
      details: `Cập nhật bài '${updated.title}' của lớp ${updated.class.name}`,
      ipAddress: getClientIP(req),
    });

    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /:id — xóa assignment (Teacher/Admin only)
router.delete("/:id", authenticateToken, authorizeRole(["TEACHER", "ADMIN"]), async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: "ID bài tập không hợp lệ" });

    const assignment = await prisma.assignment.findUnique({
      where: { id },
      include: { class: { select: { teacherId: true, name: true } } },
    });
    if (!assignment) return res.status(404).json({ error: "Assignment not found" });

    if (req.user.role === "TEACHER" && assignment.class.teacherId !== req.user.id) {
      return res.status(403).json({ error: "Không phải lớp của bạn" });
    }

    await prisma.assignment.delete({ where: { id } });

    // Log activity
    await logActivity({
      userId: req.user.id,
      userName: req.user.name,
      userRole: req.user.role.toLowerCase(),
      action: "Xóa bài tập",
      actionType: "delete",
      resource: "Assignment",
      resourceId: id,
      details: `Xóa bài '${assignment.title}' của lớp ${assignment.class.name}`,
      ipAddress: getClientIP(req),
    });

    res.json({ message: "Xóa bài tập thành công" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
