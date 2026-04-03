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

export default router;
