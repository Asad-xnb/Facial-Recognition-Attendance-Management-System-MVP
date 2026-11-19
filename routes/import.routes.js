const router = require('express').Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const xlsx = require('xlsx');
const { Student, Class, Course } = require('../models');
const { isAuthenticated, hasRole } = require('../middleware/auth');
const { recordAuditLog } = require('../middleware/audit');

// Configure multer storage for roster imports
const importStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const tempDir = path.join(__dirname, '../uploads/temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    cb(null, tempDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, `import-${uniqueSuffix}${path.extname(file.originalname)}`);
  }
});

const upload = multer({
  storage: importStorage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB max
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.xlsx', '.xls', '.csv'].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file format. Please upload an Excel (.xlsx, .xls) or CSV file.'));
    }
  }
});

// Render the Roster Import Page
router.get('/admin/import', isAuthenticated, hasRole('admin'), async (req, res) => {
  try {
    const classes = await Class.find().sort({ name: 1, semester: 1 }).lean();
    res.render('admin/import', {
      title: 'Import Roster & Students',
      classes
    });
  } catch (error) {
    console.error('Error rendering import view:', error);
    res.status(500).render('error', { message: 'Failed to load import page', description: error.message });
  }
});

// Step 1: Upload file and preview headers + sample rows
router.post('/admin/api/import/preview', isAuthenticated, hasRole('admin'), upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }

    const filePath = req.file.path;
    const workbook = xlsx.readFile(filePath);

    if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
      fs.unlinkSync(filePath);
      return res.status(400).json({ success: false, error: 'The uploaded Excel file has no readable sheets' });
    }

    const sheets = workbook.SheetNames;
    const firstSheetName = sheets[0];
    const worksheet = workbook.Sheets[firstSheetName];

    // Convert sheet to json array of objects
    const jsonData = xlsx.utils.sheet_to_json(worksheet, { defval: '' });

    if (jsonData.length === 0) {
      fs.unlinkSync(filePath);
      return res.status(400).json({ success: false, error: 'The selected sheet contains no rows' });
    }

    // Extract header keys from the first row
    const headers = Object.keys(jsonData[0]);
    const previewRows = jsonData.slice(0, 5); // First 5 rows for sample preview

    res.json({
      success: true,
      fileId: path.basename(filePath),
      sheets,
      activeSheet: firstSheetName,
      headers,
      previewRows,
      totalRows: jsonData.length
    });
  } catch (error) {
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    console.error('Import preview error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Step 2: Switch sheet within uploaded file
router.post('/admin/api/import/switch-sheet', isAuthenticated, hasRole('admin'), async (req, res) => {
  try {
    const { fileId, sheetName } = req.body;
    if (!fileId || !sheetName) {
      return res.status(400).json({ success: false, error: 'fileId and sheetName are required' });
    }

    const filePath = path.join(__dirname, '../uploads/temp', path.basename(fileId));
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ success: false, error: 'Uploaded session expired. Please re-upload the file.' });
    }

    const workbook = xlsx.readFile(filePath);
    const worksheet = workbook.Sheets[sheetName];
    if (!worksheet) {
      return res.status(404).json({ success: false, error: `Sheet "${sheetName}" not found` });
    }

    const jsonData = xlsx.utils.sheet_to_json(worksheet, { defval: '' });
    if (jsonData.length === 0) {
      return res.status(400).json({ success: false, error: 'The selected sheet contains no rows' });
    }

    const headers = Object.keys(jsonData[0]);
    const previewRows = jsonData.slice(0, 5);

    res.json({
      success: true,
      headers,
      previewRows,
      totalRows: jsonData.length
    });
  } catch (error) {
    console.error('Switch sheet error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Step 3: Execute Visual Column Mapping & Ingestion
router.post('/admin/api/import/execute', isAuthenticated, hasRole('admin'), async (req, res) => {
  try {
    const { fileId, sheetName, mappings, defaultClassId, defaultPassword } = req.body;

    if (!fileId || !mappings) {
      return res.status(400).json({ success: false, error: 'fileId and mappings are required' });
    }

    const filePath = path.join(__dirname, '../uploads/temp', path.basename(fileId));
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ success: false, error: 'Import session expired. Please re-upload the file.' });
    }

    // Required mappings
    if (!mappings.rollNo || !mappings.fullName) {
      return res.status(400).json({ success: false, error: 'You must map both Roll Number and Full Name columns' });
    }

    if (!mappings.classRef && !defaultClassId) {
      return res.status(400).json({ success: false, error: 'Please either map a Class column or select a Default Class' });
    }

    const workbook = xlsx.readFile(filePath);
    const worksheet = workbook.Sheets[sheetName || workbook.SheetNames[0]];
    const rows = xlsx.utils.sheet_to_json(worksheet, { defval: '' });

    // Cache classes in memory to avoid repetitive DB lookups
    const existingClasses = await Class.find().lean();
    const classMap = new Map(); // Key: name-semester-section -> _id
    existingClasses.forEach(c => {
      const key = `${c.name.trim().toUpperCase()}-${c.semester}-${(c.section || 'A').trim().toUpperCase()}`;
      classMap.set(key, c._id);
      classMap.set(c.name.trim().toUpperCase(), c._id);
    });

    // Cache existing courses in memory
    const existingCourses = await Course.find().lean();
    const courseMap = new Map(); // Key: code -> _id, and Key: name-classId -> _id
    existingCourses.forEach(crs => {
      courseMap.set(crs.code.trim().toUpperCase(), crs);
      courseMap.set(`${crs.name.trim().toUpperCase()}-${crs.classRef.toString()}`, crs);
    });

    // Hash default password once
    const initialPassword = defaultPassword && defaultPassword.trim().length >= 4 ? defaultPassword.trim() : 'student123';
    const hashedPassword = await bcrypt.hash(initialPassword, 10);

    let importedCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;
    const errors = [];

    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      const rowNum = index + 2; // Excel row numbering (1-based, row 1 is header)

      const rawRollNo = row[mappings.rollNo];
      const rawFullName = row[mappings.fullName];

      if (!rawRollNo || !rawFullName || String(rawRollNo).trim() === '') {
        skippedCount++;
        continue;
      }

      const rollNo = String(rawRollNo).trim().toUpperCase();
      const fullName = String(rawFullName).trim();
      const username = rollNo.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
      const email = mappings.email && row[mappings.email] ? String(row[mappings.email]).trim().toLowerCase() : `${username}@college.local`;
      const guardianPhone = mappings.guardianPhone && row[mappings.guardianPhone] ? String(row[mappings.guardianPhone]).trim() : '';
      const department = mappings.department && row[mappings.department] ? String(row[mappings.department]).trim() : '';

      // Determine class
      let targetClassId = defaultClassId || null;

      if (mappings.classRef && row[mappings.classRef]) {
        const rawClassName = String(row[mappings.classRef]).trim().toUpperCase();
        const rawSemester = mappings.semester && row[mappings.semester] ? parseInt(row[mappings.semester]) || 1 : 1;
        const rawSection = mappings.section && row[mappings.section] ? String(row[mappings.section]).trim().toUpperCase() : 'A';

        const lookupKey = `${rawClassName}-${rawSemester}-${rawSection}`;

        if (classMap.has(lookupKey)) {
          targetClassId = classMap.get(lookupKey);
        } else if (classMap.has(rawClassName)) {
          targetClassId = classMap.get(rawClassName);
        } else {
          // Auto-create new Class if it doesn't exist
          try {
            const newClass = await Class.create({
              name: rawClassName,
              semester: rawSemester,
              section: rawSection,
              department: department || 'General',
              academicYear: new Date().getFullYear().toString()
            });
            classMap.set(lookupKey, newClass._id);
            classMap.set(rawClassName, newClass._id);
            targetClassId = newClass._id;
          } catch (clsErr) {
            targetClassId = defaultClassId || null;
          }
        }
      }

      if (!targetClassId) {
        skippedCount++;
        errors.push(`Row ${rowNum}: Could not assign a valid class for student ${rollNo}`);
        continue;
      }

      try {
        // Upsert student based on rollNo
        let student = await Student.findOne({ rollNo });

        if (student) {
          // Update existing student details without overwriting face data if already enrolled
          student.fullName = fullName;
          student.email = email;
          student.classRef = targetClassId;
          if (guardianPhone) student.guardianPhone = guardianPhone;
          if (department) student.department = department;
          await student.save();
          updatedCount++;
        } else {
          // Create new student with un-enrolled face status
          student = await Student.create({
            username,
            rollNo,
            fullName,
            email,
            password: hashedPassword,
            classRef: targetClassId,
            guardianPhone,
            department,
            isEnrolled: false,
            enrollmentStatus: 'unregistered',
            faceDescriptor: []
          });

          // Link student to class
          await Class.findByIdAndUpdate(targetClassId, {
            $addToSet: { students: student._id }
          });

          importedCount++;
        }

        // Link course if course column is mapped
        if (mappings.course && row[mappings.course]) {
          const rawCourse = String(row[mappings.course]).trim().toUpperCase();
          if (rawCourse) {
            try {
              let course = courseMap.get(rawCourse) || courseMap.get(`${rawCourse}-${targetClassId}`);

              if (!course) {
                // Ensure unique code if course code already exists
                let courseCode = rawCourse;
                if (courseMap.has(courseCode)) {
                  courseCode = `${rawCourse}-${targetClassId.toString().slice(-4).toUpperCase()}`;
                }

                course = await Course.create({
                  name: rawCourse,
                  code: courseCode,
                  classRef: targetClassId,
                  instructorRef: req.session.userId || null,
                  totalSessions: 30
                });

                // Update in-memory course map
                courseMap.set(course.code, course);
                courseMap.set(`${course.name}-${targetClassId}`, course);
              }

              // Add course to class
              await Class.findByIdAndUpdate(targetClassId, {
                $addToSet: { courses: course._id }
              });
            } catch (courseErr) {
              console.warn(`Could not link course ${rawCourse}:`, courseErr.message);
              // Non-fatal: student is still saved successfully
            }
          }
        }
      } catch (rowErr) {
        skippedCount++;
        errors.push(`Row ${rowNum} (${rollNo}): ${rowErr.message}`);
      }
    }

    // Clean up temporary uploaded file
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (e) {
      // Ignore file deletion error
    }

    // Record audit log
    await recordAuditLog(req, 'IMPORT_ROSTER', 'Student', null, {
      fileId,
      importedCount,
      updatedCount,
      skippedCount,
      totalRows: rows.length
    });

    res.json({
      success: true,
      message: `Roster processed: ${importedCount} created, ${updatedCount} updated, ${skippedCount} skipped`,
      summary: {
        totalRows: rows.length,
        importedCount,
        updatedCount,
        skippedCount,
        errors: errors.slice(0, 10) // Show first 10 errors if any
      }
    });
  } catch (error) {
    console.error('Import execution error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
