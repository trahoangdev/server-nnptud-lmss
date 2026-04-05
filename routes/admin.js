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
 
export default router;
