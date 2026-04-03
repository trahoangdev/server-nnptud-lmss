/**
 * Central router — mounts all route modules.
 * Mỗi thành viên sẽ thêm import + mount route của mình vào đây.
 */

import express from "express";

const router = express.Router();

// Các route sẽ được thêm bởi từng thành viên:
// router.use(authRoutes);
// router.use(classRoutes);
// router.use(assignmentRoutes);
// ...

export default router;
