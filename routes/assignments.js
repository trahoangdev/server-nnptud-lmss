/**
 * Assignment routes
 */

import express from "express";
import prisma from "../db.js";
import { authenticateToken, authorizeRole } from "../middleware/auth.js";
import { checkClassAccess } from "./_helpers.js";

const router = express.Router();

export default router;
