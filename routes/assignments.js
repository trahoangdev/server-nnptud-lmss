/**
 * Assignment routes — CRUD + student assignments list
 */

import express from "express";
import prisma from "../db.js";
import { authenticateToken, authorizeRole } from "../middleware/auth.js";
import { checkClassAccess, logActivity, getClientIP, parseId, validateString, isValidDate } from "./_helpers.js";

const router = express.Router();

export default router;
