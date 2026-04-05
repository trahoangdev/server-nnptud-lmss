/**
 * Auth routes — POST /register, POST /login, GET /me, PATCH /me, PATCH /me/password
 */

import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import prisma from "../db.js";
import { authenticateToken } from "../middleware/auth.js";
import { upload, logActivity, getClientIP } from "./_helpers.js";

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || "supersecretkey123";
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_ROLES = ["STUDENT", "TEACHER"];

router.post("/register", async (req, res) => {
  try {
    const { name, email, password, role } = req.body;

    // Validate required fields
    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "Tên không được để trống" });
    }
    if (name.trim().length > 100) {
      return res.status(400).json({ error: "Tên không được quá 100 ký tự" });
    }
    if (!email || typeof email !== "string" || !email.trim()) {
      return res.status(400).json({ error: "Email không được để trống" });
    }
    if (!EMAIL_REGEX.test(email.trim())) {
      return res.status(400).json({ error: "Email không đúng định dạng" });
    }
    if (!password || typeof password !== "string") {
      return res.status(400).json({ error: "Mật khẩu không được để trống" });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: "Mật khẩu phải có ít nhất 6 ký tự" });
    }
    if (password.length > 128) {
      return res.status(400).json({ error: "Mật khẩu không được quá 128 ký tự" });
    }
    if (role && !VALID_ROLES.includes(role)) {
      return res.status(400).json({ error: "Vai trò không hợp lệ" });
    }

    const existing = await prisma.user.findUnique({ where: { email: email.trim() } });
    if (existing) return res.status(400).json({ error: "Email đã được sử dụng" });

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: { name: name.trim(), email: email.trim().toLowerCase(), password: hashedPassword, role: role || "STUDENT", status: "ACTIVE" },
    });

    await logActivity({
      userId: user.id,
      userName: name,
      userRole: (role || "STUDENT").toLowerCase(),
      action: "Đăng ký tài khoản",
      actionType: "create",
      resource: "User",
      resourceId: user.id,
      details: `Tài khoản ${email} được tạo (vai trò: ${role || "STUDENT"})`,
      ipAddress: getClientIP(req),
    });

    res.status(201).json({ message: "User created", userId: user.id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || typeof email !== "string" || !email.trim()) {
      return res.status(400).json({ error: "Vui lòng nhập email" });
    }
    if (!EMAIL_REGEX.test(email.trim())) {
      return res.status(400).json({ error: "Email không đúng định dạng" });
    }
    if (!password || typeof password !== "string") {
      return res.status(400).json({ error: "Vui lòng nhập mật khẩu" });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: "Mật khẩu phải có ít nhất 6 ký tự" });
    }
    const user = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
    if (!user) return res.status(400).json({ error: "Email hoặc mật khẩu không đúng" });
    if (user.status && user.status !== "ACTIVE") return res.status(403).json({ error: "Tài khoản đã bị khóa" });

    const validPass = await bcrypt.compare(password, user.password);
    if (!validPass) return res.status(400).json({ error: "Email hoặc mật khẩu không đúng" });

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, name: user.name },
      JWT_SECRET,
      { expiresIn: "24h" }
    );

    await logActivity({
      userId: user.id,
      userName: user.name,
      userRole: user.role.toLowerCase(),
      action: "Đăng nhập",
      actionType: "login",
      resource: "Auth",
      resourceId: user.id,
      details: `${user.name} đăng nhập thành công`,
      ipAddress: getClientIP(req),
    });

    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/** POST /admin/login — Admin-only login endpoint */
router.post("/admin/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || typeof email !== "string" || !email.trim()) {
      return res.status(400).json({ error: "Vui lòng nhập email" });
    }
    if (!EMAIL_REGEX.test(email.trim())) {
      return res.status(400).json({ error: "Email không đúng định dạng" });
    }
    if (!password || typeof password !== "string") {
      return res.status(400).json({ error: "Vui lòng nhập mật khẩu" });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: "Mật khẩu phải có ít nhất 6 ký tự" });
    }
    const user = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
    if (!user || user.role !== "ADMIN") {
      return res.status(400).json({ error: "Email hoặc mật khẩu không đúng" });
    }
    if (user.status && user.status !== "ACTIVE") {
      return res.status(403).json({ error: "Tài khoản đã bị khóa" });
    }

    const validPass = await bcrypt.compare(password, user.password);
    if (!validPass) return res.status(400).json({ error: "Email hoặc mật khẩu không đúng" });

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, name: user.name },
      JWT_SECRET,
      { expiresIn: "24h" }
    );

    await logActivity({
      userId: user.id,
      userName: user.name,
      userRole: "admin",
      action: "Đăng nhập Admin",
      actionType: "login",
      resource: "Auth",
      resourceId: user.id,
      details: `Admin '${user.name}' đăng nhập thành công`,
      ipAddress: getClientIP(req),
    });

    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* ================== PROFILE / ME API ================== */

router.get("/me", authenticateToken, async (req, res) => {
  try {
    const userId = Number(req.user.id);
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, email: true, role: true, avatar: true, status: true, createdAt: true },
    });
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/** Update profile (name, email) */
router.patch("/me", authenticateToken, async (req, res) => {
  try {
    const userId = Number(req.user.id);
    const { name, email } = req.body;
    const updateData = {};

    if (name !== undefined) {
      if (typeof name !== "string" || !name.trim()) {
        return res.status(400).json({ error: "Tên không được để trống" });
      }
      if (name.trim().length > 100) {
        return res.status(400).json({ error: "Tên không được quá 100 ký tự" });
      }
      updateData.name = name.trim();
    }
    if (email !== undefined) {
      if (typeof email !== "string" || !email.trim()) {
        return res.status(400).json({ error: "Email không được để trống" });
      }
      if (!EMAIL_REGEX.test(email.trim())) {
        return res.status(400).json({ error: "Email không đúng định dạng" });
      }
      const existing = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
      if (existing && existing.id !== userId) {
        return res.status(400).json({ error: "Email đã được sử dụng" });
      }
      updateData.email = email.trim().toLowerCase();
    }

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ error: "Không có thông tin cần cập nhật" });
    }

    const user = await prisma.user.update({
      where: { id: userId },
      data: updateData,
      select: { id: true, name: true, email: true, role: true, avatar: true, status: true, createdAt: true },
    });

    await logActivity({
      userId,
      userName: user.name,
      userRole: user.role.toLowerCase(),
      action: "Cập nhật hồ sơ",
      actionType: "update",
      resource: "User",
      resourceId: userId,
      details: `Cập nhật hồ sơ: ${Object.keys(updateData).join(", ")}`,
      ipAddress: getClientIP(req),
    });

    res.json(user);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/** Change password */
router.patch("/me/password", authenticateToken, async (req, res) => {
  try {
    const userId = Number(req.user.id);
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || typeof currentPassword !== "string") {
      return res.status(400).json({ error: "Vui lòng nhập mật khẩu hiện tại" });
    }
    if (!newPassword || typeof newPassword !== "string") {
      return res.status(400).json({ error: "Vui lòng nhập mật khẩu mới" });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: "Mật khẩu mới phải có ít nhất 6 ký tự" });
    }
    if (newPassword.length > 128) {
      return res.status(400).json({ error: "Mật khẩu không được quá 128 ký tự" });
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ error: "User not found" });

    const validPass = await bcrypt.compare(currentPassword, user.password);
    if (!validPass) {
      return res.status(400).json({ error: "Mật khẩu hiện tại không đúng" });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({
      where: { id: userId },
      data: { password: hashedPassword },
    });

    await logActivity({
      userId,
      userName: user.name,
      userRole: user.role.toLowerCase(),
      action: "Đổi mật khẩu",
      actionType: "update",
      resource: "User",
      resourceId: userId,
      details: `${user.name} đã đổi mật khẩu`,
      ipAddress: getClientIP(req),
    });

    res.json({ message: "Đổi mật khẩu thành công" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/** Upload avatar */
router.post("/me/avatar", authenticateToken, (req, res, next) => {
  upload.single("file")(req, res, (err) => {
    if (err) return res.status(500).json({ error: err.message || "Upload failed" });
    next();
  });
}, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const userId = Number(req.user.id);
    const avatarUrl = req.file.path;

    const user = await prisma.user.update({
      where: { id: userId },
      data: { avatar: avatarUrl },
      select: { id: true, name: true, email: true, role: true, avatar: true, status: true, createdAt: true },
    });

    res.json(user);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
