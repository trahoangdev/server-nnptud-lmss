/**
 * Central router — mounts all route modules.
 * Replaces monolithic route.js
 */

import express from "express";
import authRoutes from "./auth.js";
import classRoutes from "./classes.js";
import assignmentRoutes from "./assignments.js";
import submissionRoutes from "./submissions.js";
import gradeRoutes from "./grades.js";
import commentRoutes from "./comments.js";
import uploadRoutes from "./upload.js";
import adminRoutes from "./admin.js";
import dashboardRoutes from "./dashboard.js";
import notificationRoutes from "./notifications.js";
import conversationRoutes from "./conversations.js";

const router = express.Router();

// Mount all route modules
router.use(authRoutes);
router.use(classRoutes);
router.use(assignmentRoutes);
router.use(submissionRoutes);
router.use(gradeRoutes);
router.use(commentRoutes);
router.use(uploadRoutes);
router.use(adminRoutes);
router.use(dashboardRoutes);
router.use(notificationRoutes);
router.use(conversationRoutes);

export default router;
