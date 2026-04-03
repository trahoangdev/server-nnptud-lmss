/**
 * Class routes — CRUD, join by code, enroll student
 */

import express from "express";
import prisma from "../db.js";
import { authenticateToken, authorizeRole } from "../middleware/auth.js";
import { checkClassAccess, ensureUniqueClassCode, logActivity, getClientIP, parseId, validateString } from "./_helpers.js";

const router = express.Router();

// ================== CREATE CLASS ==================

router.post("/", authenticateToken, authorizeRole(["ADMIN", "TEACHER"]), async (req, res) => {
  try {
    const { name, description } = req.body;
    const validName = validateString(name, 200);
    if (!validName) return res.status(400).json({ error: "Tên lớp không hợp lệ (tối đa 200 ký tự)" });
    if (description && typeof description === "string" && description.length > 2000) {
      return res.status(400).json({ error: "Mô tả không được quá 2000 ký tự" });
    }

    const teacherId = req.user.role === "TEACHER" ? req.user.id : req.body.teacherId;
    if (!teacherId) return res.status(400).json({ error: "teacherId required for Admin" });
    const parsedTeacherId = parseId(teacherId);
    if (!parsedTeacherId) return res.status(400).json({ error: "teacherId không hợp lệ" });

    const code = await ensureUniqueClassCode();
    const newClass = await prisma.class.create({
      data: { name: validName, description: description?.trim() || null, code, teacherId: parsedTeacherId, status: "ACTIVE" },
      include: { teacher: { select: { id: true, name: true } } },
    });

    await logActivity({
      userId: req.user.id,
      userName: req.user.name,
      userRole: req.user.role.toLowerCase(),
      action: "Tạo lớp học mới",
      actionType: "create",
      resource: "Class",
      resourceId: newClass.id,
      details: `Lớp '${validName}' được tạo thành công (Mã: ${code})`,
      ipAddress: getClientIP(req),
    });

    res.status(201).json(newClass);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ================== LIST CLASSES ==================

router.get("/", authenticateToken, async (req, res) => {
  try {
    const paginate = req.query.page !== undefined;
    const page = Math.max(Number(req.query.page) || 1, 1);
    const take = Math.min(Number(req.query.limit) || 50, 100);
    const skip = paginate ? (page - 1) * take : undefined;

    let where = { status: "ACTIVE" };
    if (req.user.role === "TEACHER") where.teacherId = req.user.id;
    if (req.user.role === "STUDENT") {
      where.members = { some: { userId: req.user.id, status: "ACTIVE" } };
    }

    const findOpts = {
      where,
      include: {
        teacher: { select: { id: true, name: true } },
        _count: { select: { members: true } },
      },
      orderBy: { updatedAt: "desc" },
    };
    if (paginate) {
      findOpts.skip = skip;
      findOpts.take = take;
    }

    const classes = await prisma.class.findMany(findOpts);
    const list = classes.map((c) => ({
      ...c,
      students: c._count.members,
      _count: undefined,
    }));

    if (paginate) {
      const total = await prisma.class.count({ where });
      return res.json({ data: list, total, page, limit: take });
    }
    res.json(list);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ================== CLASS DETAIL ==================

router.get("/:id", authenticateToken, async (req, res) => {
  try {
    const classId = parseId(req.params.id);
    if (!classId) return res.status(400).json({ error: "ID lớp không hợp lệ" });

    const access = await checkClassAccess(req, classId);
    if (!access.ok) return res.status(access.status).json({ error: access.message });

    const classItem = await prisma.class.findUnique({
      where: { id: classId },
      include: {
        teacher: { select: { id: true, name: true, email: true } },
        members: { where: { status: "ACTIVE" }, include: { user: { select: { id: true, name: true, email: true } } } },
      },
    });
    if (!classItem) return res.status(404).json({ error: "Class not found" });

    res.json({ ...classItem, students: classItem.members.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ================== UPDATE CLASS ==================

router.put("/:id", authenticateToken, authorizeRole(["TEACHER", "ADMIN"]), async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: "ID lớp không hợp lệ" });
    const access = await checkClassAccess(req, id);
    if (!access.ok) return res.status(access.status).json({ error: access.message });

    const { name, description, status } = req.body;
    const data = {};
    if (name !== undefined) {
      const validName = validateString(name, 200);
      if (!validName) return res.status(400).json({ error: "Tên lớp không hợp lệ (tối đa 200 ký tự)" });
      data.name = validName;
    }
    if (description !== undefined) {
      if (typeof description === "string" && description.length > 2000) {
        return res.status(400).json({ error: "Mô tả không được quá 2000 ký tự" });
      }
      data.description = description?.trim() || null;
    }
    if (status !== undefined && ["ACTIVE", "ARCHIVED"].includes(status)) data.status = status;

    const updated = await prisma.class.update({ where: { id }, data });
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ================== DELETE (ARCHIVE) CLASS ==================

router.delete("/:id", authenticateToken, authorizeRole(["TEACHER", "ADMIN"]), async (req, res) => {
  try {
    const classId = parseId(req.params.id);
    if (!classId) return res.status(400).json({ error: "ID lớp không hợp lệ" });
    const access = await checkClassAccess(req, classId);
    if (!access.ok) return res.status(access.status).json({ error: access.message });

    const archived = await prisma.$transaction(async (tx) => {
      const archivedClass = await tx.class.update({
        where: { id: classId },
        data: { status: "ARCHIVED" },
      });

      await tx.classMember.updateMany({
        where: { classId, status: "ACTIVE" },
        data: { status: "LEFT" },
      });

      return archivedClass;
    });

    await logActivity({
      userId: req.user.id,
      userName: req.user.name,
      userRole: req.user.role.toLowerCase(),
      action: "Xóa (lưu trữ) lớp học",
      actionType: "delete",
      resource: "Class",
      resourceId: classId,
      details: `Lớp '${archived.name}' đã được lưu trữ (archived)`,
      ipAddress: getClientIP(req),
    });

    res.json({ message: "Class archived", class: archived });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ================== JOIN CLASS BY CODE ==================

router.post("/join", authenticateToken, authorizeRole(["STUDENT"]), async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: "Code required" });

    const classRow = await prisma.class.findFirst({ where: { code: String(code).trim().toUpperCase(), status: "ACTIVE" } });
    if (!classRow) return res.status(404).json({ error: "Invalid or expired class code" });

    const existing = await prisma.classMember.findUnique({
      where: { classId_userId: { classId: classRow.id, userId: req.user.id } },
    });
    if (existing && existing.status === "ACTIVE") return res.status(400).json({ error: "Already in this class" });

    if (existing) {
      await prisma.classMember.update({
        where: { id: existing.id },
        data: { status: "ACTIVE" },
      });
    } else {
      await prisma.classMember.create({
        data: { classId: classRow.id, userId: req.user.id, status: "ACTIVE" },
      });
    }

    res.json({ message: "Joined successfully", classId: classRow.id, className: classRow.name });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ================== ENROLL STUDENT ==================

router.post("/:id/enroll", authenticateToken, authorizeRole(["TEACHER", "ADMIN"]), async (req, res) => {
  try {
    const classId = parseId(req.params.id);
    if (!classId) return res.status(400).json({ error: "ID lớp không hợp lệ" });

    if (!req.body.studentId) return res.status(400).json({ error: "Provide studentId" });
    const studentId = parseId(req.body.studentId);
    if (!studentId) return res.status(400).json({ error: "studentId không hợp lệ" });

    const studentExists = await prisma.user.findUnique({ where: { id: studentId }, select: { id: true } });
    if (!studentExists) return res.status(404).json({ error: "Sinh viên không tồn tại" });

    const access = await checkClassAccess(req, classId);
    if (!access.ok) return res.status(access.status).json({ error: access.message });
    if (access.class.teacherId !== req.user.id && req.user.role !== "ADMIN") {
      return res.status(403).json({ error: "Only teacher or admin can add students" });
    }

    await prisma.classMember.upsert({
      where: { classId_userId: { classId, userId: studentId } },
      update: { status: "ACTIVE" },
      create: { classId, userId: studentId, status: "ACTIVE" },
    });
    res.json({ message: "Enrolled successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ================== LEAVE CLASS ==================

router.post("/:id/leave", authenticateToken, authorizeRole(["STUDENT"]), async (req, res) => {
  try {
    const classId = parseId(req.params.id);
    if (!classId) return res.status(400).json({ error: "ID lớp không hợp lệ" });

    const membership = await prisma.classMember.findUnique({
      where: { classId_userId: { classId, userId: req.user.id } },
    });
    if (!membership || membership.status !== "ACTIVE") {
      return res.status(400).json({ error: "Bạn không phải thành viên của lớp này" });
    }

    await prisma.classMember.update({
      where: { id: membership.id },
      data: { status: "LEFT" },
    });

    const classInfo = await prisma.class.findUnique({ where: { id: classId }, select: { name: true } });

    await logActivity({
      userId: req.user.id,
      userName: req.user.name,
      userRole: "student",
      action: "Rời lớp học",
      actionType: "update",
      resource: "Class",
      resourceId: classId,
      details: `Sinh viên '${req.user.name}' đã rời lớp '${classInfo?.name ?? classId}'`,
      ipAddress: getClientIP(req),
    });

    res.json({ message: "Đã rời lớp thành công" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ================== REMOVE MEMBER ==================

router.delete("/:id/members/:userId", authenticateToken, authorizeRole(["TEACHER", "ADMIN"]), async (req, res) => {
  try {
    const classId = parseId(req.params.id);
    const userId = parseId(req.params.userId);
    if (!classId || !userId) return res.status(400).json({ error: "ID không hợp lệ" });

    const access = await checkClassAccess(req, classId);
    if (!access.ok) return res.status(access.status).json({ error: access.message });
    if (access.class.teacherId !== req.user.id && req.user.role !== "ADMIN") {
      return res.status(403).json({ error: "Only teacher or admin can remove members" });
    }

    const membership = await prisma.classMember.findUnique({
      where: { classId_userId: { classId, userId } },
    });
    if (!membership || membership.status !== "ACTIVE") {
      return res.status(404).json({ error: "Member not found" });
    }

    await prisma.classMember.update({
      where: { id: membership.id },
      data: { status: "LEFT" },
    });

    res.json({ message: "Member removed" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
