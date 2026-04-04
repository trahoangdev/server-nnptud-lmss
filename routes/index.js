/**
 * Central router — mounts all route modules.
 * Mỗi thành viên sẽ thêm import + mount route của mình vào đây.
 */

import express from "express";
import authRoutes from "./auth.js";
import classRoutes from "./classes.js";
import assignmentRoutes from "./assignments.js";
import submissionRoutes from "./submissions.js";

const router = express.Router();

// ================== MOUNT ROUTES ==================
router.use("/auth", authRoutes);
router.use("/classes", classRoutes);
router.use("/assignments", assignmentRoutes);
router.use("/submissions", submissionRoutes);

export default router;
