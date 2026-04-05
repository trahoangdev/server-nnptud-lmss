/**
 * Middleware bảo mật: xác thực JWT và phân quyền theo role.
 * Dùng cho tất cả route cần đăng nhập và/hoặc kiểm tra vai trò (TEACHER, STUDENT, ADMIN).
 */

import jwt from "jsonwebtoken";
import dotenv from "dotenv";

dotenv.config();

const JWT_SECRET = process.env.JWT_SECRET || "supersecretkey123";

/**
 * Xác thực JWT: đảm bảo request có Bearer token hợp lệ.
 * Gắn req.user = { id, email, role, name } sau khi verify.
 * Trả 401 nếu thiếu token, 403 nếu token không hợp lệ.
 */
export const authenticateToken = (req, res, next) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];
  if (!token) {
    return res.status(401).json({ error: "Access Token Required" });
  }
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: "Invalid Token" });
    }
    req.user = user;
    next();
  });
};

/**
 * Phân quyền theo role: chỉ cho phép các role trong danh sách.
 * Phải dùng SAU authenticateToken (để req.user đã có).
 * Trả 403 nếu role không nằm trong danh sách cho phép.
 * @param {string[]} roles - Ví dụ: ["TEACHER", "ADMIN"], ["STUDENT"]
 */
export const authorizeRole = (roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: "Authentication required" });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        error: "Access Denied: You do not have permission for this action",
      });
    }
    next();
  };
};

/**
 * Helper: middleware kết hợp auth + role trong một lần.
 * Ví dụ: requireAuth(["TEACHER", "ADMIN"])
 */
export const requireAuth = (roles) => {
  return [authenticateToken, authorizeRole(roles)];
};
