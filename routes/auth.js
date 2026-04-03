/**
 * Auth routes — register, login, profile management
 */

import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import prisma from "../db.js";
import { authenticateToken } from "../middleware/auth.js";
import { logActivity, getClientIP } from "./_helpers.js";

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || "supersecretkey123";
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_ROLES = ["STUDENT", "TEACHER"];

export default router;
