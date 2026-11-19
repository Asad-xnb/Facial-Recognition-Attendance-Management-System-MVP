const router = require('express').Router();
const { Admin, Class, Course, Student, Attendance, Settings } = require('../models');
const { isAuthenticated, hasRole } = require('../middleware/auth');

// Get teacher's classes and courses (Supports both School Homeroom & University Course models)
router.get('/api/teacher-data', isAuthenticated, hasRole('admin', 'teacher'), async (req, res) => {
  try {
    const userId = req.session.userId;
    const isAdmin = req.session.role === 'admin';

    let classes;

    if (isAdmin) {
      // Admin sees ALL classes and their courses
      classes = await Class.find({ isActive: true })
        .populate('courses', 'name code')
        .populate('classTeacherRef', 'fullName email')
        .lean();
    } else {
      // Teacher sees:
      // 1. Classes where they are the primary Class Teacher (Homeroom - stays with class all day)
      // 2. Classes where they teach a specific Course
      const [homeroomClasses, teacherCourses] = await Promise.all([
        Class.find({ classTeacherRef: userId, isActive: true })
          .populate('courses', 'name code')
          .populate('classTeacherRef', 'fullName email')
          .lean(),
        Course.find({ instructorRef: userId })
          .populate('classRef')
          .lean()
      ]);

      const classMap = new Map();

      // Add homeroom classes
      homeroomClasses.forEach(c => {
        classMap.set(c._id.toString(), {
          ...c,
          isHomeroomTeacher: true,
          courses: c.courses || []
        });
      });

      // Add course classes
      teacherCourses.forEach(crs => {
        if (!crs.classRef) return;
        const cid = crs.classRef._id.toString();
        if (!classMap.has(cid)) {
          classMap.set(cid, {
            ...crs.classRef,
            isHomeroomTeacher: false,
            courses: []
          });
        }
        const clsObj = classMap.get(cid);
        if (!clsObj.courses) clsObj.courses = [];
        if (!clsObj.courses.some(existing => existing._id.toString() === crs._id.toString())) {
          clsObj.courses.push({
            _id: crs._id,
            name: crs.name,
            code: crs.code
          });
        }
      });

      classes = Array.from(classMap.values());
    }

    // Format for frontend
    const formattedClasses = classes.map(cls => {
      const coursesList = [...(cls.courses || [])];
      
      // Offer Daily / Homeroom Attendance for schools, class teachers, or if no separate courses exist
      coursesList.unshift({
        _id: 'daily',
        name: 'General / Daily Attendance (Homeroom)',
        code: 'DAILY'
      });

      const teacherName = cls.classTeacherRef ? cls.classTeacherRef.fullName : null;

      return {
        _id: cls._id,
        name: cls.name,
        semester: cls.semester,
        section: cls.section || 'A',
        department: cls.department,
        classTeacher: teacherName || 'Not Assigned',
        isHomeroomTeacher: !!cls.isHomeroomTeacher,
        displayName: `${cls.name} ${cls.semester ? 'Sem ' + cls.semester : ''} - Sec ${cls.section || 'A'}${teacherName ? ' (' + teacherName + ')' : ''}`,
        courses: coursesList
      };
    });

    res.json({ classes: formattedClasses });
  } catch (error) {
    console.error('Error fetching teacher data:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get students with face descriptors for a specific class
router.get('/api/class-students/:classId', isAuthenticated, hasRole('admin', 'teacher'), async (req, res) => {
  try {
    const { classId } = req.params;
    
    const students = await Student.find({ 
      classRef: classId,
      isEnrolled: true,
      faceDescriptor: { $exists: true, $ne: [] }
    }).select('_id username fullName rollNo faceDescriptor').lean();
    
    res.json({ students });
  } catch (error) {
    console.error('Error fetching students:', error);
    res.status(500).json({ error: error.message });
  }
});

// Mark attendance (Supports both course-specific and general daily attendance)
router.post('/api/mark-attendance', isAuthenticated, hasRole('admin', 'teacher'), async (req, res) => {
  try {
    const { studentId, courseId, classId, confidenceScore, faceDescriptor } = req.body;
    
    if (!studentId || !courseId || !classId) {
      return res.status(400).json({ 
        error: 'Missing required fields',
        details: { studentId: !!studentId, courseId: !!courseId, classId: !!classId }
      });
    }
    
    const isDaily = courseId === 'daily';
    const actualCourseRef = isDaily ? null : courseId;
    const sessionDate = new Date();
    sessionDate.setHours(0, 0, 0, 0);
    
    // Check if attendance already marked today for this course/session
    const query = {
      studentRef: studentId,
      classRef: classId,
      sessionDate: sessionDate
    };
    if (isDaily) {
      query.courseRef = null;
    } else {
      query.courseRef = actualCourseRef;
    }

    const existingAttendance = await Attendance.findOne(query).lean();
    
    if (existingAttendance) {
      return res.status(400).json({ 
        error: 'Attendance already marked',
        alreadyMarked: true
      });
    }
    
    // Fetch user settings to get lateCutoffTime
    const userModel = req.session.userModel || 'Teacher';
    const userId = req.session.userId;
    
    let settings = req.session.cachedSettings;
    if (!settings) {
      settings = await Settings.findOne({ userId, userModel }).lean();
      if (!settings) {
        settings = await Settings.create({ userId, userModel });
      }
      req.session.cachedSettings = settings;
    }
    
    // Determine status based on user's configured time
    const now = new Date();
    const cutoffTime = new Date(now);
    const [cutoffHours, cutoffMinutes] = (settings.lateCutoffTime || '09:15').split(':');
    cutoffTime.setHours(parseInt(cutoffHours), parseInt(cutoffMinutes), 0, 0);
    const status = now > cutoffTime ? 'late' : 'present';
    
    // Get student info
    const student = await Student.findById(studentId).select('fullName rollNo faceDescriptor').lean();
    
    if (!student) {
      return res.status(404).json({ error: 'Student not found' });
    }
    
    // Create attendance record
    const attendance = await Attendance.create({
      studentRef: studentId,
      courseRef: actualCourseRef,
      classRef: classId,
      attendanceType: isDaily ? 'daily' : 'subject',
      status: status,
      confidenceScore: confidenceScore || 0,
      markedBy: 'facial_recognition',
      sessionDate: sessionDate,
      timestamp: new Date()
    });
    
    // Update face descriptor asynchronously via incremental learning
    if (faceDescriptor && Array.isArray(faceDescriptor) && faceDescriptor.length === 128 && confidenceScore >= 0.6) {
      const existingDescriptor = student.faceDescriptor;
      
      if (existingDescriptor && existingDescriptor.length === 128) {
        setImmediate(async () => {
          try {
            const alpha = 0.15;
            const updatedDescriptor = existingDescriptor.map((oldVal, i) => {
              return oldVal * (1 - alpha) + faceDescriptor[i] * alpha;
            });
            const magnitude = Math.sqrt(updatedDescriptor.reduce((sum, val) => sum + val * val, 0));
            const normalizedDescriptor = updatedDescriptor.map(val => val / magnitude);
            
            await Student.findByIdAndUpdate(studentId, {
              faceDescriptor: normalizedDescriptor,
              lastDescriptorUpdate: new Date(),
              $inc: { descriptorUpdateCount: 1 }
            });
          } catch (err) {
            console.error('Error updating face descriptor:', err);
          }
        });
      }
    }
    
    res.json({
      success: true,
      attendance: {
        ...attendance.toObject(),
        studentRef: studentId,
        student: { fullName: student.fullName, rollNo: student.rollNo }
      },
      status: status
    });
  } catch (error) {
    console.error('Error marking attendance:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get today's attendance for a course or daily session
router.get('/api/today-attendance/:courseId', isAuthenticated, hasRole('admin', 'teacher'), async (req, res) => {
  try {
    const { courseId } = req.params;
    const { classId } = req.query;
    
    if (!courseId) {
      return res.status(400).json({ error: 'Course ID is required', attendance: [] });
    }
    
    const sessionDate = new Date();
    sessionDate.setHours(0, 0, 0, 0);
    
    const isDaily = courseId === 'daily';
    const query = { sessionDate };
    
    if (isDaily) {
      query.courseRef = null;
      if (classId) query.classRef = classId;
    } else {
      query.courseRef = courseId;
    }
    
    const attendance = await Attendance.find(query)
      .populate('studentRef', 'fullName rollNo')
      .sort({ timestamp: -1 })
      .limit(500)
      .lean();
    
    const formattedAttendance = attendance
      .filter(record => record.studentRef && record.studentRef._id)
      .map(record => ({
        ...record,
        studentRef: record.studentRef._id,
        student: {
          _id: record.studentRef._id,
          fullName: record.studentRef.fullName,
          rollNo: record.studentRef.rollNo
        }
      }));
    
    res.json({ attendance: formattedAttendance });
  } catch (error) {
    console.error('Error fetching attendance:', error);
    res.status(500).json({ error: error.message, attendance: [] });
  }
});

// Get unmarked students for a class/course session
router.get('/api/unmarked-students/:classId/:courseId', isAuthenticated, hasRole('admin', 'teacher'), async (req, res) => {
  try {
    const { classId, courseId } = req.params;
    
    if (!classId || !courseId) {
      return res.status(400).json({ error: 'Class ID and Course ID are required' });
    }
    
    const sessionDate = new Date();
    sessionDate.setHours(0, 0, 0, 0);
    
    // Get all enrolled students in this class
    const allStudents = await Student.find({
      classRef: classId,
      isEnrolled: true
    }).select('_id fullName rollNo').lean();
    
    const isDaily = courseId === 'daily';
    const query = {
      classRef: classId,
      sessionDate: sessionDate
    };
    if (isDaily) {
      query.courseRef = null;
    } else {
      query.courseRef = courseId;
    }

    const markedAttendance = await Attendance.find(query).select('studentRef').lean();
    const markedStudentIds = new Set(markedAttendance.map(a => a.studentRef.toString()));
    
    const unmarkedStudents = allStudents.filter(student => 
      !markedStudentIds.has(student._id.toString())
    );
    
    res.json({ 
      unmarkedStudents,
      totalStudents: allStudents.length,
      markedCount: markedStudentIds.size
    });
  } catch (error) {
    console.error('Error fetching unmarked students:', error);
    res.status(500).json({ error: error.message });
  }
});

// Manually mark attendance (for missed students)
router.post('/api/manual-mark-attendance', isAuthenticated, hasRole('admin', 'teacher'), async (req, res) => {
  try {
    const { studentId, courseId, classId, status } = req.body;
    
    if (!studentId || !courseId || !classId || !status) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    if (!['present', 'late', 'absent'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status. Must be present, late, or absent' });
    }
    
    const isDaily = courseId === 'daily';
    const actualCourseRef = isDaily ? null : courseId;
    const sessionDate = new Date();
    sessionDate.setHours(0, 0, 0, 0);
    
    const query = {
      studentRef: studentId,
      classRef: classId,
      sessionDate: sessionDate
    };
    if (isDaily) {
      query.courseRef = null;
    } else {
      query.courseRef = actualCourseRef;
    }

    const existingAttendance = await Attendance.findOne(query).lean();
    
    if (existingAttendance) {
      return res.status(400).json({ 
        error: 'Attendance already marked for this student',
        alreadyMarked: true
      });
    }
    
    const attendance = await Attendance.create({
      studentRef: studentId,
      courseRef: actualCourseRef,
      classRef: classId,
      attendanceType: isDaily ? 'daily' : 'subject',
      status: status,
      confidenceScore: status === 'absent' ? 0 : 1,
      markedBy: 'manual',
      sessionDate: sessionDate,
      timestamp: new Date()
    });
    
    const student = await Student.findById(studentId).select('fullName rollNo').lean();
    
    res.json({
      success: true,
      attendance: {
        ...attendance.toObject(),
        student: { fullName: student.fullName, rollNo: student.rollNo }
      }
    });
  } catch (error) {
    console.error('Error manually marking attendance:', error);
    res.status(500).json({ error: error.message });
  }
});

// Bulk mark absent for all unmarked students (End Session)
router.post('/api/end-session', isAuthenticated, hasRole('admin', 'teacher'), async (req, res) => {
  try {
    const { classId, courseId, markAbsent = true } = req.body;
    
    if (!classId || !courseId) {
      return res.status(400).json({ error: 'Class ID and Course ID are required' });
    }
    
    const isDaily = courseId === 'daily';
    const actualCourseRef = isDaily ? null : courseId;
    const sessionDate = new Date();
    sessionDate.setHours(0, 0, 0, 0);
    
    // Get all enrolled students
    const allStudents = await Student.find({
      classRef: classId,
      isEnrolled: true
    }).select('_id fullName rollNo').lean();
    
    const query = {
      classRef: classId,
      sessionDate: sessionDate
    };
    if (isDaily) {
      query.courseRef = null;
    } else {
      query.courseRef = actualCourseRef;
    }

    const markedAttendance = await Attendance.find(query).select('studentRef').lean();
    const markedStudentIds = new Set(markedAttendance.map(a => a.studentRef.toString()));
    
    const unmarkedStudents = allStudents.filter(student => 
      !markedStudentIds.has(student._id.toString())
    );
    
    let markedAbsentCount = 0;
    
    if (markAbsent && unmarkedStudents.length > 0) {
      const absentRecords = unmarkedStudents.map(student => ({
        studentRef: student._id,
        courseRef: actualCourseRef,
        classRef: classId,
        attendanceType: isDaily ? 'daily' : 'subject',
        status: 'absent',
        confidenceScore: 0,
        markedBy: 'system',
        sessionDate: sessionDate,
        timestamp: new Date()
      }));
      
      await Attendance.insertMany(absentRecords);
      markedAbsentCount = unmarkedStudents.length;
    }
    
    res.json({
      success: true,
      message: `Session ended. ${markedAbsentCount} students marked as absent.`,
      totalStudents: allStudents.length,
      markedAbsentCount
    });
  } catch (error) {
    console.error('Error ending session:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
