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

router.get("/admin/settings", authenticateToken, authorizeRole(["ADMIN"]), async (req, res) => {
  try {
    const dbSettings = await prisma.setting.findMany();
    const settingsMap = {};
    dbSettings.forEach((s) => {
      try {
        settingsMap[s.key] = JSON.parse(s.value);
      } catch {
        settingsMap[s.key] = s.value;
      }
    });

    const result = {
      system: { ...DEFAULT_SETTINGS.system, ...settingsMap.system },
      security: { ...DEFAULT_SETTINGS.security, ...settingsMap.security },
      email: { ...DEFAULT_SETTINGS.email, ...settingsMap.email },
      backup: { ...DEFAULT_SETTINGS.backup, ...settingsMap.backup },
      notifications: { ...DEFAULT_SETTINGS.notifications, ...settingsMap.notifications },
    };

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.patch("/admin/settings", authenticateToken, authorizeRole(["ADMIN"]), async (req, res) => {
  try {
    const VALID_SECTIONS = ["system", "security", "email", "backup", "notifications"];
    const { system, security, email, backup, notifications } = req.body;
    const sections = { system, security, email, backup, notifications };

    // Only allow known section keys
    const unknownKeys = Object.keys(req.body).filter(k => !VALID_SECTIONS.includes(k));
    if (unknownKeys.length > 0) {
      return res.status(400).json({ error: `Khóa cài đặt không hợp lệ: ${unknownKeys.join(", ")}` });
    }

    const upsertPromises = Object.entries(sections)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) =>
        prisma.setting.upsert({
          where: { key },
          update: { value: JSON.stringify(value) },
          create: { key, value: JSON.stringify(value) },
        })
      );

    await Promise.all(upsertPromises);

    await logActivity({
      userId: req.user.id,
      userName: req.user.name,
      userRole: req.user.role.toLowerCase(),
      action: "Cập nhật cài đặt hệ thống",
      actionType: "update",
      resource: "Setting",
      details: `Cập nhật settings: ${Object.keys(sections).filter((k) => sections[k]).join(", ")}`,
      ipAddress: getClientIP(req),
    });

    res.json({ message: "Settings updated successfully", settings: { system, security, email, backup, notifications } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
router.get("/admin/activity-logs", authenticateToken, authorizeRole(["ADMIN"]), async (req, res) => {
  try {
    const { role, actionType, status, limit = 100, offset = 0 } = req.query;

    const where = {};
    if (role && role !== "all") {
      where.userRole = role.toLowerCase();
    }
    if (actionType && actionType !== "all") {
      where.actionType = actionType;
    }
    if (status && status !== "all") {
      where.status = status;
    }

    const [logs, total] = await Promise.all([
      prisma.activityLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: Number(offset),
        take: Number(limit),
      }),
      prisma.activityLog.count({ where }),
    ]);

    const formattedLogs = logs.map((log) => ({
      id: String(log.id),
      timestamp: log.createdAt.toISOString(),
      userId: log.userId ? String(log.userId) : null,
      userName: log.userName,
      userRole: log.userRole,
      action: log.action,
      actionType: log.actionType,
      resource: log.resource,
      resourceId: log.resourceId,
      details: log.details,
      ipAddress: log.ipAddress || "N/A",
      status: log.status,
    }));

    res.json({
      logs: formattedLogs,
      total,
      limit: Number(limit),
      offset: Number(offset),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});