/**
 * Shared helpers used across route modules.
 * - logActivity: audit trail
 * - checkClassAccess: role-based class access check
 * - ensureUniqueClassCode: unique 6-char class code
 * - getClientIP: extract client IP
 * - cloudinary config + multer upload
 */

import crypto from "crypto";
import { v2 as cloudinary } from "cloudinary";
import { CloudinaryStorage } from "multer-storage-cloudinary";
import multer from "multer";
import prisma from "../db.js";
import dotenv from "dotenv";

dotenv.config();

/* ================== CLOUDINARY CONFIG ================== */
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: async (req, file) => {
    const isImage = file.mimetype.startsWith("image/") && file.mimetype !== "application/pdf";
    const resource_type = isImage ? "image" : "raw";
    const name = file.originalname.split(".").slice(0, -1).join(".").replace(/[^a-zA-Z0-9]/g, "_");
    const ext = file.originalname.split(".").pop();
    const public_id =
      resource_type === "raw" ? `${Date.now()}-${name}.${ext}` : `${Date.now()}-${name}`;
    return {
      folder: "lms-uploads",
      resource_type,
      public_id,
    };
  },
});

const ALLOWED_MIMETYPES = new Set([
  // Images
  "image/jpeg", "image/png", "image/gif", "image/webp", "image/svg+xml",
  // Documents
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  // Text/Code
  "text/plain", "text/csv", "text/markdown",
  // Archives
  "application/zip", "application/x-rar-compressed", "application/gzip",
]);

export const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIMETYPES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Loại file không được hỗ trợ: ${file.mimetype}`));
    }
  },
});

/* ================== AUDIT LOG HELPER ================== */

/** Ghi log hành động vào DB (real audit trail) */
export async function logActivity({
  userId = null,
  userName = "System",
  userRole = "system",
  action,
  actionType,
  resource,
  resourceId = null,
  details,
  ipAddress = null,
  status = "success",
}) {
  try {
    await prisma.activityLog.create({
      data: {
        userId,
        userName,
        userRole,
        action,
        actionType,
        resource,
        resourceId: resourceId ? String(resourceId) : null,
        details,
        ipAddress,
        status,
      },
    });
  } catch (err) {
    console.error("Failed to log activity:", err.message);
  }
}

/** Helper: extract IP from request */
export function getClientIP(req) {
  return req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket?.remoteAddress || "unknown";
}

/* ================== CLASS CODE GENERATION ================== */

/** Generate unique 6-char class code (PRD: code unique, auto generate) */
function generateClassCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars[crypto.randomInt(0, chars.length)];
  }
  return code;
}

export async function ensureUniqueClassCode() {
  let code;
  let exists = true;
  while (exists) {
    code = generateClassCode();
    const c = await prisma.class.findUnique({ where: { code } });
    exists = !!c;
  }
  return code;
}

/* ================== ROLE / ACCESS HELPERS ================== */

/** Teacher: class must be owned by req.user. Student: must be member. Admin: allow. */
export async function checkClassAccess(req, classId, needOwner = false) {
  const id = Number(classId);
  const c = await prisma.class.findUnique({
    where: { id },
    include: {
      members: { where: { status: "ACTIVE" }, include: { user: { select: { id: true, name: true, email: true } } } },
    },
  });
  if (!c) return { ok: false, status: 404, message: "Class not found" };
  if (req.user.role === "ADMIN") return { ok: true, class: c };
  if (req.user.role === "TEACHER" && c.teacherId === req.user.id) {
    if (needOwner) return { ok: true, class: c };
    return { ok: true, class: c };
  }
  if (req.user.role === "STUDENT") {
    const member = c.members.find((m) => m.userId === req.user.id);
    if (member) return { ok: true, class: c };
  }
  return { ok: false, status: 403, message: "Access denied" };
}

/* ================== VALIDATION HELPERS ================== */

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Parse route/query param to integer, return null if invalid.
 */
export function parseId(value) {
  const n = Number(value);
  return Number.isFinite(n) && Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Validate a string field: non-empty after trim, within maxLength.
 * Returns trimmed string or null.
 */
export function validateString(value, maxLength = 500) {
  if (!value || typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) return null;
  return trimmed;
}

/**
 * Validate email format.
 */
export function isValidEmail(value) {
  return typeof value === "string" && EMAIL_REGEX.test(value.trim());
}

/**
 * Validate ISO date string.
 */
export function isValidDate(value) {
  if (!value) return false;
  const d = new Date(value);
  return !isNaN(d.getTime());
}

/* ================== ADMIN SETTINGS DEFAULTS ================== */

export const DEFAULT_SETTINGS = {
  system: {
    siteName: "NNPTUD LMS",
    siteUrl: process.env.SITE_URL || "https://lms.edu.vn",
    adminEmail: process.env.ADMIN_EMAIL || "admin@lms.edu.vn",
    maxFileSize: 50,
    maxStoragePerClass: 5,
    sessionTimeout: 30,
    maintenanceMode: false,
  },
  security: {
    twoFactorRequired: false,
    passwordMinLength: 8,
    passwordRequireUppercase: true,
    passwordRequireNumber: true,
    passwordRequireSpecial: false,
    maxLoginAttempts: 5,
    lockoutDuration: 15,
    sessionConcurrent: true,
  },
  email: {
    smtpHost: process.env.SMTP_HOST || "smtp.gmail.com",
    smtpPort: process.env.SMTP_PORT || "587",
    smtpUser: process.env.SMTP_USER || "",
    smtpSecure: "tls",
    fromName: "NNPTUD LMS",
    fromEmail: process.env.SMTP_FROM || "noreply@lms.edu.vn",
  },
  backup: {
    autoBackup: true,
    backupFrequency: "daily",
    backupRetention: 30,
    backupLocation: "local",
  },
  notifications: {
    notifyNewUser: true,
    notifyNewClass: true,
    notifyStorageWarning: true,
    notifySecurityAlert: true,
    dailyReport: false,
    weeklyReport: true,
  },
};
