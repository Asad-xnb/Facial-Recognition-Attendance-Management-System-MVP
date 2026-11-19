const AuditLog = require('../models/AuditLog');

/**
 * Helper to record an audit log entry
 * @param {Object} req Express request object
 * @param {String} action Action name (e.g. 'ENROLL_STUDENT')
 * @param {String} targetEntity Target collection/entity ('Student', 'Attendance')
 * @param {String} targetId ID of the target record
 * @param {Object} details Additional context or changes
 */
async function recordAuditLog(req, action, targetEntity, targetId = null, details = {}) {
  try {
    const userId = req && req.session ? req.session.userId : null;
    const username = req && req.session ? req.session.username : 'system';
    const role = req && req.session ? req.session.role : 'system';
    const ipAddress = req ? (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '') : '';

    await AuditLog.create({
      userId,
      userModel: role === 'student' ? 'Student' : 'Admin',
      username,
      role,
      action,
      targetEntity,
      targetId: targetId ? targetId.toString() : null,
      details,
      ipAddress,
      timestamp: new Date()
    });
  } catch (error) {
    console.error('Failed to create audit log:', error.message);
  }
}

module.exports = { recordAuditLog };
