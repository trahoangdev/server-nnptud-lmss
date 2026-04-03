/**
 * Central router — mounts all route modules.
 * Mỗi thành viên sẽ thêm import + mount route của mình vào đây.
 */

import express from "express";
import authRoutes from "./auth.js";

const router = express.Router();

// ================== MOUNT ROUTES ==================
router.use("/auth", authRoutes);

// Các route sẽ được thêm bởi từng thành viên:
// router.use('/classes', classRoutes);
// router.use('/assignments', assignmentRoutes);
// ...

export default router;
