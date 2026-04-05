/**
 * Dashboard stats routes — teacher + student specific stats.
 */

import express from "express";
import prisma from "../db.js";
import { authenticateToken, authorizeRole } from "../middleware/auth.js";

const router = express.Router();

/** Teacher dashboard stats — submission rates per class/assignment */
router.get("/teacher/dashboard-stats", authenticateToken, authorizeRole(["TEACHER", "ADMIN"]), async (req, res) => {
  try {
    const where = req.user.role === "TEACHER" ? { teacherId: req.user.id } : {};
    const classes = await prisma.class.findMany({
      where: { ...where, status: "ACTIVE" },
      include: {
        _count: { select: { members: true } },
        assignments: {
          select: {
            id: true,
            title: true,
            maxScore: true,
            dueDate: true,
            _count: { select: { submissions: true } },
          },
          orderBy: { createdAt: "desc" },
          take: 20,
        },
      },
    });

    // Per-class stats
    const classStats = classes.map((c) => {
      const totalStudents = c._count.members;
      const assignmentStats = c.assignments.map((a) => ({
        id: a.id,
        title: a.title,
        maxScore: a.maxScore,
        dueDate: a.dueDate,
        submissionCount: a._count.submissions,
        totalStudents,
        submissionRate: totalStudents > 0 ? Math.round((a._count.submissions / totalStudents) * 100) : 0,
      }));
      return {
        classId: c.id,
        className: c.name,
        totalStudents,
        totalAssignments: c.assignments.length,
        assignments: assignmentStats,
      };
    });

    // Total pending grading across all
    const pendingGrading = await prisma.submission.count({
      where: {
        assignment: { class: { ...where, status: "ACTIVE" } },
        grade: null,
        status: { in: ["SUBMITTED", "LATE_SUBMITTED"] },
      },
    });

    // Total graded
    const totalGraded = await prisma.grade.count({
      where: {
        submission: { assignment: { class: { ...where, status: "ACTIVE" } } },
      },
    });

    // Recent submissions (last 10)
    const recentSubmissions = await prisma.submission.findMany({
      where: { assignment: { class: { ...where, status: "ACTIVE" } } },
      include: {
        student: { select: { id: true, name: true } },
        assignment: { select: { id: true, title: true, class: { select: { id: true, name: true } } } },
      },
      orderBy: { submittedAt: "desc" },
      take: 10,
    });

    res.json({
      classStats,
      pendingGrading,
      totalGraded,
      recentSubmissions: recentSubmissions.map((s) => ({
        id: s.id,
        studentName: s.student.name,
        assignmentTitle: s.assignment.title,
        className: s.assignment.class.name,
        classId: s.assignment.class.id,
        assignmentId: s.assignment.id,
        status: s.status,
        submittedAt: s.submittedAt,
      })),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/** Student dashboard stats — personal progress */
router.get("/student/dashboard-stats", authenticateToken, authorizeRole(["STUDENT"]), async (req, res) => {
  try {
    const userId = req.user.id;

    // Get enrolled classes
    const memberships = await prisma.classMember.findMany({
      where: { userId, status: "ACTIVE" },
      select: { classId: true },
    });
    const classIds = memberships.map((m) => m.classId);

    // All assignments in enrolled classes
    const totalAssignments = await prisma.assignment.count({
      where: { classId: { in: classIds } },
    });

    // My submissions
    const mySubmissions = await prisma.submission.findMany({
      where: { studentId: userId, assignment: { classId: { in: classIds } } },
      include: {
        grade: true,
        assignment: { select: { id: true, title: true, maxScore: true, dueDate: true } },
      },
    });

    const submittedCount = mySubmissions.length;
    const gradedCount = mySubmissions.filter((s) => s.grade).length;
    const lateCount = mySubmissions.filter((s) => s.status === "LATE_SUBMITTED").length;

    // Average score (percentage)
    const gradedSubs = mySubmissions.filter((s) => s.grade);
    const avgScore =
      gradedSubs.length > 0
        ? Math.round(
            (gradedSubs.reduce((sum, s) => sum + (s.grade.score / (s.assignment.maxScore || 10)) * 100, 0) /
              gradedSubs.length) *
              10
          ) / 10
        : null;

    // Due soon (within 7 days, not submitted)
    const now = new Date();
    const sevenDaysLater = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const submittedAssignmentIds = new Set(mySubmissions.map((s) => s.assignmentId));
    const dueSoon = await prisma.assignment.findMany({
      where: {
        classId: { in: classIds },
        dueDate: { gte: now, lte: sevenDaysLater },
        id: { notIn: [...submittedAssignmentIds] },
      },
      select: { id: true, title: true, dueDate: true, classId: true },
      orderBy: { dueDate: "asc" },
    });

    // Per-class grades
    const classGrades = [];
    for (const cid of classIds) {
      const classData = await prisma.class.findUnique({
        where: { id: cid },
        select: { id: true, name: true },
      });
      const classSubs = mySubmissions.filter((s) => s.assignment && classIds.includes(cid));
      const classGraded = classSubs.filter((s) => s.grade);
      const classAvg =
        classGraded.length > 0
          ? Math.round(
              (classGraded.reduce((sum, s) => sum + (s.grade.score / (s.assignment.maxScore || 10)) * 100, 0) /
                classGraded.length) *
                10
            ) / 10
          : null;
      classGrades.push({
        classId: cid,
        className: classData?.name ?? "",
        avgScore: classAvg,
        assignmentsTotal: await prisma.assignment.count({ where: { classId: cid } }),
        submitted: classSubs.length,
        graded: classGraded.length,
      });
    }

    res.json({
      totalClasses: classIds.length,
      totalAssignments,
      submittedCount,
      gradedCount,
      lateCount,
      avgScore,
      submissionRate: totalAssignments > 0 ? Math.round((submittedCount / totalAssignments) * 100) : 0,
      dueSoon,
      classGrades,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
