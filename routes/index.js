/**
 * Central router — mounts all route modules.
 * Mỗi thành viên sẽ thêm import + mount route của mình vào đây.
 */

import express from "express";
import authRoutes from "./auth.js";
import classRoutes from "./classes.js";
import assignmentRoutes from "./assignments.js";
import submissionRoutes from "./submissions.js";
import gradeRoutes from "./grades.js";
import commentRoutes from "./comments.js";
import conversationRoutes from "./conversations.js";
import notificationRoutes from "./notifications.js";

const router = express.Router();

// ================== MOUNT ROUTES ==================
router.use("/auth", authRoutes);
router.use("/classes", classRoutes);
router.use("/assignments", assignmentRoutes);
router.use("/submissions", submissionRoutes);
router.use("/grades", gradeRoutes);
router.use("/comments", commentRoutes);
router.use("/conversations", conversationRoutes);

export default router;
