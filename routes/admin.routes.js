const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { isAuthenticated, hasRole } = require('../middleware/auth');
const { Admin, Class, Course, Student } = require('../models');
const { recordAuditLog } = require('../middleware/audit');

// Management Page
router.get('/manage', isAuthenticated, hasRole('admin'), (req, res) => {
  res.render('admin/manage');
});

// Get all teachers
router.get('/api/teachers', isAuthenticated, hasRole('admin'), async (req, res) => {
  try {
    const teachers = await Admin.find({ role: 'teacher' }).select('-password').sort({ fullName: 1 });
    res.json(teachers);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add teacher
router.post('/api/teachers', isAuthenticated, hasRole('admin'), async (req, res) => {
  try {
    const { username, fullName, email, password } = req.body;

    // Check if username or email exists
    const existing = await Admin.findOne({ 
      $or: [{ username }, { email: email.toLowerCase() }] 
    });
    
    if (existing) {
      return res.status(400).json({ error: 'Username or email already exists' });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create teacher
    const teacher = await Admin.create({
      username,
      fullName,
      email: email.toLowerCase(),
      password: hashedPassword,
      role: 'teacher',
      isActive: true
    });

    await recordAuditLog(req, 'CREATE_TEACHER', 'Admin', teacher._id, { fullName, email });

    res.json({ success: true, teacher: { ...teacher.toObject(), password: undefined } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get all classes (with students, courses, and class teacher)
router.get('/api/classes', isAuthenticated, async (req, res) => {
  try {
    const classes = await Class.find()
      .populate('students', 'fullName rollNo')
      .populate('classTeacherRef', 'fullName email')
      .populate('courses', 'name code')
      .sort({ name: 1, semester: 1, section: 1 });
    res.json(classes);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add class (supporting Homeroom / Class Teacher assignment)
router.post('/api/classes', isAuthenticated, hasRole('admin'), async (req, res) => {
  try {
    const { name, semester, section, academicYear, department, classTeacherRef } = req.body;

    // Check if class already exists
    const existing = await Class.findOne({ 
      name: name.toUpperCase(), 
      semester: parseInt(semester) || 1, 
      section: (section || 'A').toUpperCase(), 
      academicYear 
    });
    
    if (existing) {
      return res.status(400).json({ error: 'Class already exists' });
    }

    const newClass = await Class.create({
      name: name.toUpperCase(),
      semester: parseInt(semester) || 1,
      section: (section || 'A').toUpperCase(),
      academicYear: academicYear || new Date().getFullYear().toString(),
      department: department || 'General',
      classTeacherRef: classTeacherRef || null,
      isActive: true
    });

    // If a class teacher was assigned, add this class to their profile
    if (classTeacherRef) {
      await Admin.findByIdAndUpdate(classTeacherRef, {
        $addToSet: { classes: newClass._id }
      });
    }

    await recordAuditLog(req, 'CREATE_CLASS', 'Class', newClass._id, { name, section, classTeacherRef });

    const populated = await Class.findById(newClass._id).populate('classTeacherRef', 'fullName email');
    res.json({ success: true, class: populated });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update class / Assign Class Teacher
router.put('/api/classes/:id', isAuthenticated, hasRole('admin'), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, semester, section, academicYear, department, classTeacherRef } = req.body;

    const updateData = {};
    if (name) updateData.name = name.toUpperCase();
    if (semester !== undefined) updateData.semester = parseInt(semester);
    if (section) updateData.section = section.toUpperCase();
    if (academicYear) updateData.academicYear = academicYear;
    if (department) updateData.department = department;
    if (classTeacherRef !== undefined) updateData.classTeacherRef = classTeacherRef || null;

    const updated = await Class.findByIdAndUpdate(id, updateData, { new: true })
      .populate('classTeacherRef', 'fullName email')
      .populate('students', 'fullName rollNo')
      .populate('courses', 'name code');

    if (!updated) {
      return res.status(404).json({ error: 'Class not found' });
    }

    if (classTeacherRef) {
      await Admin.findByIdAndUpdate(classTeacherRef, {
        $addToSet: { classes: id }
      });
    }

    await recordAuditLog(req, 'UPDATE_CLASS', 'Class', id, updateData);

    res.json({ success: true, class: updated });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get all courses
router.get('/api/courses', isAuthenticated, async (req, res) => {
  try {
    const courses = await Course.find()
      .populate('classRef', 'name semester section')
      .populate('instructorRef', 'fullName email')
      .sort({ name: 1 });
    res.json(courses);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add course
router.post('/api/courses', isAuthenticated, hasRole('admin', 'teacher'), async (req, res) => {
  try {
    const { name, code, classRef, instructorRef, totalSessions } = req.body;

    // Check if course code exists
    const existing = await Course.findOne({ code: code.toUpperCase() });
    if (existing) {
      return res.status(400).json({ error: 'Course code already exists' });
    }

    const course = await Course.create({
      name,
      code: code.toUpperCase(),
      classRef,
      instructorRef: instructorRef || null,
      totalSessions: totalSessions || 30
    });

    // Add course to class
    await Class.findByIdAndUpdate(classRef, {
      $push: { courses: course._id }
    });

    // Add course to teacher's classes array if instructor is set
    if (instructorRef) {
      await Admin.findByIdAndUpdate(instructorRef, {
        $addToSet: { classes: classRef }
      });
    }

    await recordAuditLog(req, 'CREATE_COURSE', 'Course', course._id, { name, code, instructorRef });

    res.json({ success: true, course });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update course (edit sessions or instructor)
router.put('/api/courses/:id', isAuthenticated, hasRole('admin', 'teacher'), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, code, totalSessions, instructorRef } = req.body;
    
    const updateData = {};
    if (name) updateData.name = name;
    if (code) updateData.code = code.toUpperCase();
    if (totalSessions !== undefined) updateData.totalSessions = totalSessions;
    if (instructorRef !== undefined) updateData.instructorRef = instructorRef || null;
    
    // If teacher role, verify they own this course
    if (req.session.role === 'teacher') {
      const course = await Course.findById(id);
      if (!course || (course.instructorRef && course.instructorRef.toString() !== req.session.userId)) {
        return res.status(403).json({ error: 'Not authorized to update this course' });
      }
    }
    
    const course = await Course.findByIdAndUpdate(id, updateData, { new: true })
      .populate('classRef', 'name semester section')
      .populate('instructorRef', 'fullName');
    
    if (!course) {
      return res.status(404).json({ error: 'Course not found' });
    }

    if (instructorRef) {
      await Admin.findByIdAndUpdate(instructorRef, {
        $addToSet: { classes: course.classRef._id }
      });
    }
    
    res.json({ success: true, course });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get all students
router.get('/api/students', isAuthenticated, async (req, res) => {
  try {
    const students = await Student.find()
      .populate('classRef', 'name semester section')
      .select('-password')
      .sort({ rollNo: 1 });
    res.json(students);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add student
router.post('/api/students', isAuthenticated, hasRole('admin', 'teacher'), async (req, res) => {
  try {
    const { username, fullName, rollNo, email, password, classRef } = req.body;

    // Check if username, rollNo, or email exists
    const existing = await Student.findOne({ 
      $or: [
        { username }, 
        { rollNo: rollNo.toUpperCase() },
        { email: email.toLowerCase() }
      ] 
    });
    
    if (existing) {
      return res.status(400).json({ error: 'Username, roll number, or email already exists' });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create student
    const student = await Student.create({
      username,
      fullName,
      rollNo: rollNo.toUpperCase(),
      email: email.toLowerCase(),
      password: hashedPassword,
      classRef,
      isEnrolled: false,
      enrollmentStatus: 'unregistered'
    });

    // Add student to class
    await Class.findByIdAndUpdate(classRef, {
      $push: { students: student._id }
    });

    await recordAuditLog(req, 'CREATE_STUDENT', 'Student', student._id, { rollNo, fullName });

    res.json({ success: true, student: { ...student.toObject(), password: undefined } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
