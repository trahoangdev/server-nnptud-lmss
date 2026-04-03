/**
 * Auth routes — register, login, profile management
 */

import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import prisma from "../db.js";
import { authenticateToken } from "../middleware/auth.js";
import { logActivity, getClientIP } from "./_helpers.js";

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || "supersecretkey123";
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_ROLES = ["STUDENT", "TEACHER"];

// ================== REGISTER ==================

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

    const existing = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
    if (existing) return res.status(400).json({ error: "Email đã được sử dụng" });

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: {
        name: name.trim(),
        email: email.trim().toLowerCase(),
        password: hashedPassword,
        role: role || "STUDENT",
        status: "ACTIVE",
      },
    });

    await logActivity({
      userId: user.id,
      userName: name.trim(),
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

export default router;
