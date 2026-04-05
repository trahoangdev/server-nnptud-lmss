/**
 * Class routes — CRUD, join by code, enroll student
 */

import express from "express";
import prisma from "../db.js";
import { authenticateToken, authorizeRole } from "../middleware/auth.js";
import { checkClassAccess, ensureUniqueClassCode, logActivity, getClientIP, parseId, validateString } from "./_helpers.js";

const router = express.Router();

router.post("/classes", authenticateToken, authorizeRole(["ADMIN", "TEACHER"]), async (req, res) => {
  try {
    const { name, description } = req.body;
    const validName = validateString(name, 200);
    if (!validName) return res.status(400).json({ error: "Tên lớp không hợp lệ (tối đa 200 ký tự)" });
    if (description && typeof description === "string" && description.length > 2000) {
      return res.status(400).json({ error: "Mô tả không được quá 2000 ký tự" });
    }

    const teacherId = req.user.role === "TEACHER" ? req.user.id : req.body.teacherId;
    if (!teacherId) return res.status(400).json({ error: "teacherId required for Admin" });
    const parsedTeacherId = parseId(teacherId);
    if (!parsedTeacherId) return res.status(400).json({ error: "teacherId không hợp lệ" });

    const code = await ensureUniqueClassCode();
    const newClass = await prisma.class.create({
      data: { name: validName, description: description?.trim() || null, code, teacherId: parsedTeacherId, status: "ACTIVE" },
      include: { teacher: { select: { id: true, name: true } } },
    });

    await logActivity({
      userId: req.user.id,
      userName: req.user.name,
      userRole: req.user.role.toLowerCase(),
      action: "Tạo lớp học mới",
      actionType: "create",
      resource: "Class",
      resourceId: newClass.id,
      details: `Lớp '${name}' được tạo thành công (Mã: ${code})`,
      ipAddress: getClientIP(req),
    });

    res.status(201).json(newClass);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/classes", authenticateToken, async (req, res) => {
  try {
    const paginate = req.query.page !== undefined;
    const page = Math.max(Number(req.query.page) || 1, 1);
    const take = Math.min(Number(req.query.limit) || 50, 100);
    const skip = paginate ? (page - 1) * take : undefined;

    let where = { status: "ACTIVE" };
    if (req.user.role === "TEACHER") where.teacherId = req.user.id;
    if (req.user.role === "STUDENT") {
      where.members = { some: { userId: req.user.id, status: "ACTIVE" } };
    }

    const findOpts = {
      where,
      include: {
        teacher: { select: { id: true, name: true } },
        _count: { select: { members: true, assignments: true } },
      },
      orderBy: { updatedAt: "desc" },
    };
    if (paginate) {
      findOpts.skip = skip;
      findOpts.take = take;
    }

    const classes = await prisma.class.findMany(findOpts);
    const list = classes.map((c) => ({
      ...c,
      students: c._count.members,
      assignments: c._count.assignments,
      _count: undefined,
    }));

    if (paginate) {
      const total = await prisma.class.count({ where });
      return res.json({ data: list, total, page, limit: take });
    }
    res.json(list);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/classes/:id", authenticateToken, async (req, res) => {
  try {
    const classId = parseId(req.params.id);
    if (!classId) return res.status(400).json({ error: "ID lớp không hợp lệ" });

    const access = await checkClassAccess(req, classId);
    if (!access.ok) return res.status(access.status).json({ error: access.message });

    const classItem = await prisma.class.findUnique({
      where: { id: classId },
      include: {
        teacher: { select: { id: true, name: true, email: true } },
        members: { where: { status: "ACTIVE" }, include: { user: { select: { id: true, name: true, email: true } } } },
        assignments: true,
      },
    });
    if (!classItem) return res.status(404).json({ error: "Class not found" });
    const out = {
      ...classItem,
      students: classItem.members.length,
    };
    res.json(out);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/** Join class by class code (PRD: Student join bằng code) */
router.post("/classes/join", authenticateToken, authorizeRole(["STUDENT"]), async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: "Code required" });

    const classRow = await prisma.class.findFirst({ where: { code: String(code).trim().toUpperCase(), status: "ACTIVE" } });
    if (!classRow) return res.status(404).json({ error: "Invalid or expired class code" });

    const existing = await prisma.classMember.findUnique({
      where: { classId_userId: { classId: classRow.id, userId: req.user.id } },
    });
    if (existing && existing.status === "ACTIVE") return res.status(400).json({ error: "Already in this class" });

    // Transaction: join class + tạo notification cho teacher
    await prisma.$transaction(async (tx) => {
      if (existing) {
        await tx.classMember.update({
          where: { id: existing.id },
          data: { status: "ACTIVE" },
        });
      } else {
        await tx.classMember.create({
          data: { classId: classRow.id, userId: req.user.id, status: "ACTIVE" },
        });
      }

      // Thông báo cho teacher biết có sinh viên mới tham gia
      await tx.notification.create({
        data: {
          userId: classRow.teacherId,
          type: "SYSTEM",
          title: "Sinh viên mới tham gia lớp",
          message: `${req.user.name} đã tham gia lớp '${classRow.name}'`,
          relatedId: classRow.id,
          relatedType: "Class",
        },
      });
    });

    res.json({ message: "Joined successfully", classId: classRow.id, className: classRow.name });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/classes/:id/enroll", authenticateToken, authorizeRole(["TEACHER", "ADMIN"]), async (req, res) => {
  try {
    const classId = parseId(req.params.id);
    if (!classId) return res.status(400).json({ error: "ID lớp không hợp lệ" });

    let studentId = req.user.id;
    if (req.user.role === "TEACHER" || req.user.role === "ADMIN") {
      if (!req.body.studentId) return res.status(400).json({ error: "Provide studentId" });
      const parsedStudentId = parseId(req.body.studentId);
      if (!parsedStudentId) return res.status(400).json({ error: "studentId không hợp lệ" });
      // Verify student exists
      const studentExists = await prisma.user.findUnique({ where: { id: parsedStudentId }, select: { id: true } });
      if (!studentExists) return res.status(404).json({ error: "Sinh viên không tồn tại" });
      studentId = parsedStudentId;
    }
    const access = await checkClassAccess(req, classId);
    if (!access.ok) return res.status(access.status).json({ error: access.message });
    if (access.class.teacherId !== req.user.id && req.user.role !== "ADMIN") {
      return res.status(403).json({ error: "Only teacher or admin can add students" });
    }

    await prisma.classMember.upsert({
      where: { classId_userId: { classId, userId: studentId } },
      update: { status: "ACTIVE" },
      create: { classId, userId: studentId, status: "ACTIVE" },
    });
    res.json({ message: "Enrolled successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/** Gradebook — full grade matrix for a class */
router.get("/classes/:id/gradebook", authenticateToken, authorizeRole(["TEACHER", "ADMIN"]), async (req, res) => {
  try {
    const classId = parseId(req.params.id);
    if (!classId) return res.status(400).json({ error: "ID lớp không hợp lệ" });
    const access = await checkClassAccess(req, classId);
    if (!access.ok) return res.status(access.status).json({ error: access.message });

    // Get all assignments
    const assignments = await prisma.assignment.findMany({
      where: { classId },
      select: { id: true, title: true, maxScore: true, dueDate: true },
      orderBy: { createdAt: "asc" },
    });

    // Get all active members
    const members = await prisma.classMember.findMany({
      where: { classId, status: "ACTIVE" },
      include: { user: { select: { id: true, name: true, email: true } } },
    });

    // Get all submissions for these assignments
    const assignmentIds = assignments.map((a) => a.id);
    const submissions = await prisma.submission.findMany({
      where: { assignmentId: { in: assignmentIds } },
      include: { grade: true },
    });

    // Build lookup: { `${studentId}-${assignmentId}` → submission }
    const subMap = {};
    for (const s of submissions) {
      subMap[`${s.studentId}-${s.assignmentId}`] = s;
    }

    // Build student rows
    const students = members.map((m) => {
      const grades = assignments.map((a) => {
        const sub = subMap[`${m.userId}-${a.id}`];
        return {
          assignmentId: a.id,
          submitted: !!sub,
          status: sub?.status ?? "NOT_SUBMITTED",
          submittedAt: sub?.submittedAt ?? null,
          score: sub?.grade?.score ?? null,
          graded: !!sub?.grade,
          submissionId: sub?.id ?? null,
        };
      });
      return {
        studentId: m.userId,
        studentName: m.user.name,
        studentEmail: m.user.email,
        grades,
      };
    });

    // Stats
    const totalCells = members.length * assignments.length;
    const submittedCount = submissions.length;
    const gradedCount = submissions.filter((s) => s.grade).length;
    const lateCount = submissions.filter((s) => s.status === "LATE_SUBMITTED").length;

    res.json({
      classId,
      assignments: assignments.map((a) => ({
        id: a.id,
        title: a.title,
        maxScore: a.maxScore,
        dueDate: a.dueDate,
      })),
      students,
      stats: {
        totalStudents: members.length,
        totalAssignments: assignments.length,
        submissionRate: totalCells > 0 ? Math.round((submittedCount / totalCells) * 100) : 0,
        gradingRate: submittedCount > 0 ? Math.round((gradedCount / submittedCount) * 100) : 0,
        lateSubmissions: lateCount,
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/** Leave class — student rời lớp */
router.post("/classes/:id/leave", authenticateToken, authorizeRole(["STUDENT"]), async (req, res) => {
  try {
    const classId = parseId(req.params.id);
    if (!classId) return res.status(400).json({ error: "ID lớp không hợp lệ" });

    const membership = await prisma.classMember.findUnique({
      where: { classId_userId: { classId, userId: req.user.id } },
    });
    if (!membership || membership.status !== "ACTIVE") {
      return res.status(400).json({ error: "Bạn không phải thành viên của lớp này" });
    }

    await prisma.classMember.update({
      where: { id: membership.id },
      data: { status: "LEFT" },
    });

    const classInfo = await prisma.class.findUnique({ where: { id: classId }, select: { name: true } });

    await logActivity({
      userId: req.user.id,
      userName: req.user.name,
      userRole: "student",
      action: "Rời lớp học",
      actionType: "update",
      resource: "Class",
      resourceId: classId,
      details: `Sinh viên '${req.user.name}' đã rời lớp '${classInfo?.name ?? classId}'`,
      ipAddress: getClientIP(req),
    });

    res.json({ message: "Đã rời lớp thành công" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.patch("/classes/:id", authenticateToken, authorizeRole(["TEACHER", "ADMIN"]), async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: "ID lớp không hợp lệ" });
    const access = await checkClassAccess(req, id);
    if (!access.ok) return res.status(access.status).json({ error: access.message });
    const { name, description, status } = req.body;
    const data = {};
    if (name !== undefined) {
      const validName = validateString(name, 200);
      if (!validName) return res.status(400).json({ error: "Tên lớp không hợp lệ (tối đa 200 ký tự)" });
      data.name = validName;
    }
    if (description !== undefined) {
      if (typeof description === "string" && description.length > 2000) {
        return res.status(400).json({ error: "Mô tả không được quá 2000 ký tự" });
      }
      data.description = description?.trim() || null;
    }
    if (status !== undefined && ["ACTIVE", "ARCHIVED"].includes(status)) data.status = status;

    const updated = await prisma.class.update({
      where: { id },
      data,
    });
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete("/classes/:id", authenticateToken, authorizeRole(["TEACHER", "ADMIN"]), async (req, res) => {
  try {
    const classId = parseId(req.params.id);
    if (!classId) return res.status(400).json({ error: "ID lớp không hợp lệ" });
    const access = await checkClassAccess(req, classId);
    if (!access.ok) return res.status(access.status).json({ error: access.message });

    // Transaction: archive class + deactivate members + log activity
    const archived = await prisma.$transaction(async (tx) => {
      const archivedClass = await tx.class.update({
        where: { id: classId },
        data: { status: "ARCHIVED" },
      });

      // Deactivate tất cả thành viên trong lớp
      await tx.classMember.updateMany({
        where: { classId, status: "ACTIVE" },
        data: { status: "LEFT" },
      });

      await tx.activityLog.create({
        data: {
          userId: req.user.id,
          userName: req.user.name,
          userRole: req.user.role.toLowerCase(),
          action: "Xóa (lưu trữ) lớp học",
          actionType: "delete",
          resource: "Class",
          resourceId: String(classId),
          details: `Lớp '${archivedClass.name}' đã được lưu trữ (archived) và tất cả thành viên đã bị deactivate`,
          ipAddress: getClientIP(req),
        },
      });

      return archivedClass;
    });

    res.json({ message: "Class archived", class: archived });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
