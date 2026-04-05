import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { createServer } from "http"; // Import HTTP Server
import router from "./routes/index.js";
import prisma from "./db.js";
import { initSocket } from "./socket.js"; // Import Socket config

// Load biến môi trường
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = createServer(app); // Tạo HTTP Server bọc Express
const PORT = process.env.PORT || 3000;

// Khởi tạo Socket.io
initSocket(httpServer);

// ================== MIDDLEWARE ==================
app.use(helmet({ contentSecurityPolicy: false })); // Security headers (CSP disabled for SPA compatibility)

const allowedOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(",").map(s => s.trim())
  : ["http://localhost:5173", "http://localhost:8080"];
app.use(cors({
  origin: allowedOrigins,
  credentials: true,
}));

// Rate limiting — 200 requests per minute per IP
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Quá nhiều yêu cầu, vui lòng thử lại sau" },
});
app.use("/api", limiter);

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// Serve static files from 'uploads' directory
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// ================== ROUTES ==================
app.use("/api", router);

app.get("/", (req, res) => {
  res.send("Server NNPTUD LMS (Prisma + PostgreSQL + Cloudinary + Socket.io) is running...");
});

// ================== SERVER START ==================
const startServer = async () => {
  try {
    // Kiểm tra kết nối database
    await prisma.$connect();
    console.log("✅ Connected to Database via Prisma");

    // Dùng httpServer.listen thay vì app.listen
    httpServer.listen(PORT, () => {
      console.log(`🚀 Server is running on port ${PORT}`);
      console.log(`👉 API Endpoint: http://localhost:${PORT}/api`);
      console.log(`⚡ Socket.io ready`);
    });
  } catch (error) {
    console.error("❌ Failed to connect to database:", error);
    await prisma.$disconnect();
    process.exit(1);
  }
};

startServer();
