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

export default router;
