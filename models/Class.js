const mongoose = require('mongoose');

const classSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
    uppercase: true
  },
  semester: {
    type: Number,
    required: true,
    min: 1,
    max: 8,
    default: 1
  },
  section: {
    type: String,
    trim: true,
    uppercase: true,
    default: 'A'
  },
  department: {
    type: String,
    required: true,
    trim: true
  },
  academicYear: {
    type: String,
    required: true
  },
  classTeacherRef: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Admin',
    default: null // Designated Homeroom / Class Teacher who stays with the class all day
  },
  students: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Student'
  }],
  courses: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Course'
  }],
  isActive: {
    type: Boolean,
    default: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Create a compound index for unique class identification
classSchema.index({ name: 1, semester: 1, section: 1, academicYear: 1 }, { unique: true });
classSchema.index({ classTeacherRef: 1 }); // For fast teacher homeroom lookup

module.exports = mongoose.model('Class', classSchema);
