import express from "express";
import prisma from "../db.js";
import { authenticateToken, authorizeRole } from "../middleware/auth.js";
import { logActivity, getClientIP, DEFAULT_SETTINGS, parseId, validateString, isValidEmail } from "./_helpers.js";  
const router = express.Router();
export default router;
