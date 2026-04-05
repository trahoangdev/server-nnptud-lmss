import express from "express";
import prisma from "../db.js";
import { authenticateToken, authorizeRole } from "../middleware/auth.js";
import { logActivity, getClientIP, DEFAULT_SETTINGS, parseId, validateString, isValidEmail } from "./_helpers.js";  
const router = express.Router();
router.get("/admin/users", authenticateToken, authorizeRole(["ADMIN"]), async (req, res) => {
  try {
    const { role, status } = req.query;
    const paginate = req.query.page !== undefined;
    const page = Math.max(Number(req.query.page) || 1, 1);
    const take = Math.min(Number(req.query.limit) || 50, 100);

    const where = {};
    if (role && ["ADMIN", "TEACHER", "STUDENT"].includes(role)) where.role = role;
    if (status && ["ACTIVE", "INACTIVE"].includes(status)) where.status = status;

    const findOpts = {
      where,
      select: { id: true, name: true, email: true, role: true, status: true, createdAt: true },
      orderBy: { createdAt: "desc" },
    };
    if (paginate) {
      findOpts.skip = (page - 1) * take;
      findOpts.take = take;
    }

    const users = await prisma.user.findMany(findOpts);

    if (paginate) {
      const total = await prisma.user.count({ where });
      return res.json({ data: users, total, page, limit: take });
    }
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
 
router.post("/admin/users", authenticateToken, authorizeRole(["ADMIN"]), async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    const trimmedName = validateString(name, 100);
    if (!trimmedName) return res.status(400).json({ error: "Tên không hợp lệ (tối đa 100 ký tự)" });
    if (!email || !isValidEmail(email)) return res.status(400).json({ error: "Email không hợp lệ" });
    if (!password || typeof password !== "string" || password.length < 6 || password.length > 128) {
      return res.status(400).json({ error: "Mật khẩu phải từ 6-128 ký tự" });
    }
    if (!["TEACHER", "STUDENT"].includes(role)) return res.status(400).json({ error: "role must be TEACHER or STUDENT" });

    const normalizedEmail = email.trim().toLowerCase();
    const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (existing) return res.status(400).json({ error: "Email already exists" });

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: { name: trimmedName, email: normalizedEmail, password: hashedPassword, role, status: "ACTIVE" },
      select: { id: true, name: true, email: true, role: true, status: true },
    });

    await logActivity({
      userId: req.user.id,
      userName: req.user.name,
      userRole: "admin",
      action: "Tạo tài khoản mới",
      actionType: "create",
      resource: "User",
      resourceId: user.id,
      details: `Admin tạo tài khoản ${normalizedEmail} (vai trò: ${role})`,
      ipAddress: getClientIP(req),
    });

    res.status(201).json(user);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.patch("/admin/users/:id", authenticateToken, authorizeRole(["ADMIN"]), async (req, res) => {
  try {
    const userId = parseId(req.params.id);
    if (!userId) return res.status(400).json({ error: "ID người dùng không hợp lệ" });
    const { status, name, email } = req.body;

    const updateData = {};
    if (status && ["ACTIVE", "INACTIVE"].includes(status)) {
      updateData.status = status;
    }
    if (name) {
      const trimmedName = validateString(name, 100);
      if (!trimmedName) return res.status(400).json({ error: "Tên không hợp lệ (tối đa 100 ký tự)" });
      updateData.name = trimmedName;
    }
    if (email) {
      if (!isValidEmail(email)) return res.status(400).json({ error: "Email không hợp lệ" });
      const normalizedEmail = email.trim().toLowerCase();
      const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });
      if (existing && existing.id !== userId) {
        return res.status(400).json({ error: "Email already exists" });
      }
      updateData.email = normalizedEmail;
    }

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ error: "No valid fields to update" });
    }

    const user = await prisma.user.update({
      where: { id: userId },
      data: updateData,
      select: { id: true, name: true, email: true, role: true, status: true },
    });
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
export default router;

router.get("/admin/classes", authenticateToken, authorizeRole(["ADMIN"]), async (req, res) => {
  try {
    const { status } = req.query;
    const paginate = req.query.page !== undefined;
    const page = Math.max(Number(req.query.page) || 1, 1);
    const take = Math.min(Number(req.query.limit) || 50, 100);

    const where = {};
    if (status && ["ACTIVE", "ARCHIVED"].includes(String(status))) where.status = status;

    const findOpts = {
      where,
      include: {
        teacher: { select: { id: true, name: true, email: true } },
        _count: { select: { members: true, assignments: true } },
      },
      orderBy: { updatedAt: "desc" },
    };
    if (paginate) {
      findOpts.skip = (page - 1) * take;
      findOpts.take = take;
    }

    const classes = await prisma.class.findMany(findOpts);

    if (paginate) {
      const total = await prisma.class.count({ where });
      return res.json({ data: classes, total, page, limit: take });
    }
    res.json(classes);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/admin/stats", authenticateToken, authorizeRole(["ADMIN"]), async (req, res) => {
  try {
    const [totalUsers, totalTeachers, totalStudents, totalClasses, totalAssignments, activeUsers] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { role: "TEACHER" } }),
      prisma.user.count({ where: { role: "STUDENT" } }),
      prisma.class.count(),
      prisma.assignment.count(),
      prisma.user.count({ where: { status: "ACTIVE" } }),
    ]);
    res.json({
      totalUsers,
      totalTeachers,
      totalStudents,
      totalClasses,
      totalAssignments,
      activeUsers,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});