import express from "express";
import prisma from "../db.js";
import { authenticateToken } from "../middleware/auth.js";
import { parseId } from "./_helpers.js";

const router = express.Router();


export default router;