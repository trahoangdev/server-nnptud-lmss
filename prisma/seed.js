/**
 * Seed data - bám PRD §4 & schema mới (User status, Class code, ClassMember, Assignment maxScore/allowLate, Submission status)
 * Chạy: npx prisma db push (hoặc migrate) rồi npx prisma db seed
 */

import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import crypto from "crypto";

const prisma = new PrismaClient();
const PASSWORD = "password123";

function generateClassCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars[crypto.randomInt(0, chars.length)];
  }
  return code;
}

async function ensureUniqueClassCode() {
  let code;
  let exists = true;
  while (exists) {
    code = generateClassCode();
    const c = await prisma.class.findUnique({ where: { code } });
    exists = !!c;
  }
  return code;
}

async function main() {
  const hashedPassword = await bcrypt.hash(PASSWORD, 10);

  const admin = await prisma.user.upsert({
    where: { email: "admin@nnptud.edu.vn" },
    update: {},
    create: {
      name: "Admin Nguyễn",
      email: "admin@nnptud.edu.vn",
      password: hashedPassword,
      role: "ADMIN",
      status: "ACTIVE",
    },
  });

  const teacher = await prisma.user.upsert({
    where: { email: "teacher@nnptud.edu.vn" },
    update: {},
    create: {
      name: "Thầy Trần Văn A",
      email: "teacher@nnptud.edu.vn",
      password: hashedPassword,
      role: "TEACHER",
      status: "ACTIVE",
    },
  });

  const student1 = await prisma.user.upsert({
    where: { email: "student@nnptud.edu.vn" },
    update: {},
    create: {
      name: "Sinh viên Lê B",
      email: "student@nnptud.edu.vn",
      password: hashedPassword,
      role: "STUDENT",
      status: "ACTIVE",
    },
  });

  const student2 = await prisma.user.upsert({
    where: { email: "student2@nnptud.edu.vn" },
    update: {},
    create: {
      name: "Sinh viên Phạm C",
      email: "student2@nnptud.edu.vn",
      password: hashedPassword,
      role: "STUDENT",
      status: "ACTIVE",
    },
  });

  console.log("✓ Users:", admin.email, teacher.email, student1.email, student2.email);

  const code1 = await ensureUniqueClassCode();
  const code2 = await ensureUniqueClassCode();

  let class1 = await prisma.class.findFirst({ where: { name: "Toán cao cấp 1" } });
  if (!class1) {
    class1 = await prisma.class.create({
      data: {
        name: "Toán cao cấp 1",
        description: "Lớp toán cho năm nhất",
        code: code1,
        teacherId: teacher.id,
        status: "ACTIVE",
      },
    });
  }

  let class2 = await prisma.class.findFirst({ where: { name: "Lập trình Web" } });
  if (!class2) {
    class2 = await prisma.class.create({
      data: {
        name: "Lập trình Web",
        description: "React, Node.js",
        code: code2,
        teacherId: teacher.id,
        status: "ACTIVE",
      },
    });
  }

  await prisma.classMember.upsert({
    where: { classId_userId: { classId: class1.id, userId: student1.id } },
    update: { status: "ACTIVE" },
    create: { classId: class1.id, userId: student1.id, status: "ACTIVE" },
  });
  await prisma.classMember.upsert({
    where: { classId_userId: { classId: class1.id, userId: student2.id } },
    update: { status: "ACTIVE" },
    create: { classId: class1.id, userId: student2.id, status: "ACTIVE" },
  });
  await prisma.classMember.upsert({
    where: { classId_userId: { classId: class2.id, userId: student1.id } },
    update: { status: "ACTIVE" },
    create: { classId: class2.id, userId: student1.id, status: "ACTIVE" },
  });
  console.log("✓ Classes + ClassMember:", class1.name, class2.name);

  const due1 = new Date();
  due1.setDate(due1.getDate() + 14);
  const due2 = new Date();
  due2.setDate(due2.getDate() + 21);

  let assign1 = await prisma.assignment.findFirst({
    where: { classId: class1.id, title: "Bài tập chương 1 - Giới hạn" },
  });
  if (!assign1) {
    assign1 = await prisma.assignment.create({
      data: {
        title: "Bài tập chương 1 - Giới hạn",
        description: "Làm bài 1-10 trang 45",
        fileUrl: null,
        dueDate: due1,
        allowLate: false,
        maxScore: 10,
        classId: class1.id,
        createdById: teacher.id,
      },
    });
  }

  let assign2 = await prisma.assignment.findFirst({
    where: { classId: class1.id, title: "Bài tập chương 2 - Đạo hàm" },
  });
  if (!assign2) {
    assign2 = await prisma.assignment.create({
      data: {
        title: "Bài tập chương 2 - Đạo hàm",
        description: "Bài tập về đạo hàm cơ bản",
        fileUrl: null,
        dueDate: due2,
        allowLate: true,
        maxScore: 10,
        classId: class1.id,
        createdById: teacher.id,
      },
    });
  }

  let assign3 = await prisma.assignment.findFirst({
    where: { classId: class2.id, title: "Đồ án giữa kỳ - Todo App" },
  });
  if (!assign3) {
    assign3 = await prisma.assignment.create({
      data: {
        title: "Đồ án giữa kỳ - Todo App",
        description: "Xây dựng ứng dụng Todo với React",
        fileUrl: null,
        dueDate: due2,
        allowLate: true,
        maxScore: 10,
        classId: class2.id,
        createdById: teacher.id,
      },
    });
  }
  console.log("✓ Assignments:", assign1.title, assign2.title, assign3.title);

  let sub1 = await prisma.submission.findFirst({
    where: { assignmentId: assign1.id, studentId: student1.id },
  });
  if (!sub1) {
    sub1 = await prisma.submission.create({
      data: {
        content: "Em đã làm xong bài 1-5, bài 6-10 em nộp bổ sung.",
        fileUrl: null,
        status: "SUBMITTED",
        lastUpdatedAt: new Date(),
        assignmentId: assign1.id,
        studentId: student1.id,
      },
    });
  }

  let sub2 = await prisma.submission.findFirst({
    where: { assignmentId: assign1.id, studentId: student2.id },
  });
  if (!sub2) {
    sub2 = await prisma.submission.create({
      data: {
        content: null,
        fileUrl: null,
        status: "LATE_SUBMITTED",
        lastUpdatedAt: new Date(),
        assignmentId: assign1.id,
        studentId: student2.id,
      },
    });
  }

  let sub3 = await prisma.submission.findFirst({
    where: { assignmentId: assign3.id, studentId: student1.id },
  });
  if (!sub3) {
    sub3 = await prisma.submission.create({
      data: {
        content: "Link repo: https://github.com/demo/todo-app",
        fileUrl: null,
        status: "SUBMITTED",
        lastUpdatedAt: new Date(),
        assignmentId: assign3.id,
        studentId: student1.id,
      },
    });
  }
  console.log("✓ Submissions:", sub1.id, sub2.id, sub3.id);

  const gradeSub1 = await prisma.grade.findUnique({ where: { submissionId: sub1.id } });
  if (!gradeSub1) {
    await prisma.grade.create({
      data: {
        score: 8.5,
        submissionId: sub1.id,
        gradedById: teacher.id,
      },
    });
  }
  const gradeSub3 = await prisma.grade.findUnique({ where: { submissionId: sub3.id } });
  if (!gradeSub3) {
    await prisma.grade.create({
      data: {
        score: 9,
        submissionId: sub3.id,
        gradedById: teacher.id,
      },
    });
  }
  console.log("✓ Grades");

  const existingComment = await prisma.comment.findFirst({
    where: { submissionId: sub1.id, content: "Bài làm tốt, cần bổ sung phần giới hạn một bên." },
  });
  if (!existingComment) {
    await prisma.comment.createMany({
      data: [
        {
          content: "Bài làm tốt, cần bổ sung phần giới hạn một bên.",
          userId: teacher.id,
          submissionId: sub1.id,
        },
        {
          content: "Em cảm ơn thầy, em sẽ bổ sung ạ.",
          userId: student1.id,
          submissionId: sub1.id,
        },
      ],
    });
  }
  console.log("✓ Comments");

  console.log("\n✅ Seed hoàn tất. Đăng nhập với mật khẩu:", PASSWORD);
  console.log("Class codes:", class1.code, class2.code);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
