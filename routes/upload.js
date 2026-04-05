/**
 * Upload route — file upload via Multer + Cloudinary
 */

import express from "express";
import { authenticateToken } from "../middleware/auth.js";
import { upload } from "./_helpers.js";

const router = express.Router();

router.post("/upload", authenticateToken, (req, res, next) => {
  upload.single("file")(req, res, (err) => {
    if (err) {
      console.error("Multer/Cloudinary Error:", err);
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({ error: "File quá lớn. Tối đa 50MB" });
      }
      return res.status(400).json({ error: err.message || "File upload failed" });
    }
    next();
  });
}, (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  res.json({ message: "File uploaded", fileUrl: req.file.path, filename: req.file.filename });
});

export default router;
