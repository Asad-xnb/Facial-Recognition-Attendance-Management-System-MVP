const mongoose = require('mongoose');

const studentSchema = new mongoose.Schema({
  username: {
    type: String,
    required: true,
    unique: true,
    trim: true
  },
  rollNo: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    uppercase: true
  },
  password: {
    type: String,
    required: true
  },
  fullName: {
    type: String,
    required: true,
    trim: true
  },
  email: {
    type: String,
    lowercase: true,
    trim: true
  },
  guardianPhone: {
    type: String,
    trim: true,
    default: ''
  },
  department: {
    type: String,
    trim: true,
    default: ''
  },
  classRef: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Class',
    required: true
  },
  faceDescriptor: {
    type: [Number], // Single averaged 128-dimensional face descriptor
    default: []
  },
  enrollmentStatus: {
    type: String,
    enum: ['unregistered', 'pending', 'approved', 'rejected'],
    default: 'unregistered'
  },
  pendingFaceImages: [{
    type: String // Temp image paths for admin approval queue
  }],
  pendingDescriptor: {
    type: [Number],
    default: []
  },
  lastDescriptorUpdate: {
    type: Date,
    default: null // Tracks when descriptor was last updated via incremental learning
  },
  descriptorUpdateCount: {
    type: Number,
    default: 0 // Tracks how many times descriptor has been refined
  },
  attendanceRecords: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Attendance'
  }],
  isEnrolled: {
    type: Boolean,
    default: false // True when face descriptors are captured and approved
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Indexes for performance
studentSchema.index({ classRef: 1, isEnrolled: 1 }); // For counting enrolled students per class
studentSchema.index({ username: 1 }); // Already unique but explicit for login
studentSchema.index({ rollNo: 1 }); // Already unique but explicit
studentSchema.index({ enrollmentStatus: 1 }); // For pending approval queue filter

module.exports = mongoose.model('Student', studentSchema);
