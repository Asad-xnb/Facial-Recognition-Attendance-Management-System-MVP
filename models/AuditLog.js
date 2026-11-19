const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    refPath: 'userModel'
  },
  userModel: {
    type: String,
    enum: ['Admin', 'Student'],
    default: 'Admin'
  },
  username: {
    type: String,
    required: true,
    default: 'system'
  },
  role: {
    type: String,
    default: 'system'
  },
  action: {
    type: String,
    required: true,
    index: true // e.g. 'ENROLL_STUDENT', 'MANUAL_ATTENDANCE', 'IMPORT_ROSTER', 'DELETE_STUDENT'
  },
  targetEntity: {
    type: String, // 'Student', 'Attendance', 'Class', 'Settings', etc.
    required: true
  },
  targetId: {
    type: String
  },
  details: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  ipAddress: {
    type: String,
    default: ''
  },
  timestamp: {
    type: Date,
    default: Date.now,
    index: true
  }
});

// Indexes for fast searching in admin audit panel
auditLogSchema.index({ action: 1, timestamp: -1 });
auditLogSchema.index({ username: 1, timestamp: -1 });

module.exports = mongoose.model('AuditLog', auditLogSchema);
