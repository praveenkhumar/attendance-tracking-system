// backend/src/routes/attendance.js
const { User, Attendance } = require('../models');
const { faceService, attendanceService, cacheService } = require('../services');
const { AppError } = require('../utils/errors');

/**
 * Attendance Routes Plugin
 */
async function attendanceRoutes(fastify, options) {

  // Check-in with face recognition
  fastify.post('/checkin', {
    schema: {
      body: {
        type: 'object',
        required: ['faceDescriptor'],
        properties: {
          faceDescriptor: {
            type: 'array',
            items: { type: 'number' },
            minItems: 128,
            maxItems: 128
          },
          location: {
            type: 'object',
            properties: {
              latitude: { type: 'number' },
              longitude: { type: 'number' },
              address: { type: 'string', maxLength: 200 }
            }
          },
          note: { type: 'string', maxLength: 500 }
        }
      }
    },
    preHandler: [
      fastify.authenticate,
      fastify.rateLimit({
        max: 10,
        timeWindow: '1 minute',
        keyGenerator: (request) => `checkin-${request.user.id}`
      })
    ],
    handler: async (request, reply) => {
      const { faceDescriptor, location, note } = request.body;
      const userId = request.user.id;

      try {
        // Get user with face descriptors
        const user = await User.findById(userId).select('+faceDescriptors');
        
        if (!user || !user.isActive) {
          throw new AppError('User not found or inactive', 404);
        }

        if (!user.faceDescriptors || user.faceDescriptors.length === 0) {
          throw new AppError('Face not registered. Please register your face first.', 400);
        }

        // Verify face recognition
        const isValidFace = await faceService.verifyFace(
          faceDescriptor, 
          user.faceDescriptors
        );

        if (!isValidFace) {
          fastify.log.warn(`Failed face recognition for check-in`, {
            userId,
            ip: request.ip
          });
          throw new AppError('Face recognition failed', 401);
        }

        // Check if user is already checked in today
        const existingCheckin = await attendanceService.getTodaysAttendance(userId);
        
        if (existingCheckin && existingCheckin.checkInTime && !existingCheckin.checkOutTime) {
          throw new AppError('Already checked in today', 400);
        }

        // Create new attendance record
        const attendanceData = {
          userId,
          checkInTime: new Date(),
          location: location || null,
          note: note || null,
          faceVerified: true,
          metadata: {
            ip: request.ip,
            userAgent: request.headers['user-agent']
          }
        };

        const attendance = await attendanceService.createAttendance(attendanceData);

        // Cache today's attendance for quick access
        await cacheService.setTodaysAttendance(userId, attendance);

        fastify.log.info(`User checked in: ${user.email}`, {
          userId,
          attendanceId: attendance._id,
          location: location?.address
        });

        return {
          success: true,
          message: 'Check-in successful',
          attendance: {
            id: attendance._id,
            checkInTime: attendance.checkInTime,
            location: attendance.location,
            note: attendance.note
          }
        };

      } catch (error) {
        if (error instanceof AppError) {
          throw error;
        }
        
        fastify.log.error('Check-in error:', error);
        throw new AppError('Check-in failed', 500);
      }
    }
  });

  // Check-out with face recognition
  fastify.post('/checkout', {
    schema: {
      body: {
        type: 'object',
        required: ['faceDescriptor'],
        properties: {
          faceDescriptor: {
            type: 'array',
            items: { type: 'number' },
            minItems: 128,
            maxItems: 128
          },
          location: {
            type: 'object',
            properties: {
              latitude: { type: 'number' },
              longitude: { type: 'number' },
              address: { type: 'string', maxLength: 200 }
            }
          },
          note: { type: 'string', maxLength: 500 }
        }
      }
    },
    preHandler: [
      fastify.authenticate,
      fastify.rateLimit({
        max: 10,
        timeWindow: '1 minute',
        keyGenerator: (request) => `checkout-${request.user.id}`
      })
    ],
    handler: async (request, reply) => {
      const { faceDescriptor, location, note } = request.body;
      const userId = request.user.id;

      try {
        // Get user with face descriptors
        const user = await User.findById(userId).select('+faceDescriptors');
        
        if (!user || !user.isActive) {
          throw new AppError('User not found or inactive', 404);
        }

        if (!user.faceDescriptors || user.faceDescriptors.length === 0) {
          throw new AppError('Face not registered. Please register your face first.', 400);
        }

        // Verify face recognition
        const isValidFace = await faceService.verifyFace(
          faceDescriptor, 
          user.faceDescriptors
        );

        if (!isValidFace) {
          fastify.log.warn(`Failed face recognition for check-out`, {
            userId,
            ip: request.ip
          });
          throw new AppError('Face recognition failed', 401);
        }

        // Find today's attendance record
        const attendance = await attendanceService.getTodaysAttendance(userId);
        
        if (!attendance) {
          throw new AppError('No check-in record found for today', 400);
        }

        if (!attendance.checkInTime) {
          throw new AppError('No check-in time recorded', 400);
        }

        if (attendance.checkOutTime) {
          throw new AppError('Already checked out today', 400);
        }

        // Update attendance with check-out
        const checkOutTime = new Date();
        const workDuration = Math.round((checkOutTime - attendance.checkInTime) / 1000); // in seconds

        attendance.checkOutTime = checkOutTime;
        attendance.workDuration = workDuration;
        attendance.checkOutLocation = location || null;
        attendance.checkOutNote = note || null;
        attendance.updatedAt = new Date();

        await attendance.save();

        // Update cache
        await cacheService.setTodaysAttendance(userId, attendance);

        fastify.log.info(`User checked out: ${user.email}`, {
          userId,
          attendanceId: attendance._id,
          workDuration: Math.round(workDuration / 3600), // hours
          location: location?.address
        });

        return {
          success: true,
          message: 'Check-out successful',
          attendance: {
            id: attendance._id,
            checkInTime: attendance.checkInTime,
            checkOutTime: attendance.checkOutTime,
            workDuration: workDuration,
            workDurationFormatted: attendanceService.formatDuration(workDuration),
            location: attendance.location,
            checkOutLocation: attendance.checkOutLocation,
            note: attendance.note,
            checkOutNote: attendance.checkOutNote
          }
        };

      } catch (error) {
        if (error instanceof AppError) {
          throw error;
        }
        
        fastify.log.error('Check-out error:', error);
        throw new AppError('Check-out failed', 500);
      }
    }
  });

  // Get current attendance status
  fastify.get('/status', {
    preHandler: [fastify.authenticate],
    handler: async (request, reply) => {
      const userId = request.user.id;

      try {
        // Try cache first
        let todaysAttendance = await cacheService.getTodaysAttendance(userId);
        
        if (!todaysAttendance) {
          todaysAttendance = await attendanceService.getTodaysAttendance(userId);
          if (todaysAttendance) {
            await cacheService.setTodaysAttendance(userId, todaysAttendance);
          }
        }

        const now = new Date();
        let currentStatus = 'not_checked_in';
        let workDuration = 0;

        if (todaysAttendance) {
          if (todaysAttendance.checkInTime && !todaysAttendance.checkOutTime) {
            currentStatus = 'checked_in';
            workDuration = Math.round((now - todaysAttendance.checkInTime) / 1000);
          } else if (todaysAttendance.checkInTime && todaysAttendance.checkOutTime) {
            currentStatus = 'checked_out';
            workDuration = todaysAttendance.workDuration;
          }
        }

        return {
          success: true,
          status: {
            currentStatus,
            todaysAttendance: todaysAttendance ? {
              id: todaysAttendance._id,
              checkInTime: todaysAttendance.checkInTime,
              checkOutTime: todaysAttendance.checkOutTime,
              workDuration,
              workDurationFormatted: attendanceService.formatDuration(workDuration),
              location: todaysAttendance.location,
              checkOutLocation: todaysAttendance.checkOutLocation,
              note: todaysAttendance.note,
              checkOutNote: todaysAttendance.checkOutNote
            } : null
          }
        };

      } catch (error) {
        fastify.log.error('Get status error:', error);
        throw new AppError('Failed to get attendance status', 500);
      }
    }
  });

  // Get attendance history
  fastify.get('/history', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'integer', minimum: 1, default: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          startDate: { type: 'string', format: 'date' },
          endDate: { type: 'string', format: 'date' },
          status: { 
            type: 'string', 
            enum: ['complete', 'incomplete', 'all'],
            default: 'all'
          }
        }
      }
    },
    preHandler: [fastify.authenticate],
    handler: async (request, reply) => {
      const { page, limit, startDate, endDate, status } = request.query;
      const userId = request.user.id;

      try {
        // Build date range query
        const dateQuery = {};
        if (startDate || endDate) {
          dateQuery.date = {};
          if (startDate) dateQuery.date.$gte = new Date(startDate);
          if (endDate) dateQuery.date.$lte = new Date(endDate);
        }

        // Build status query
        let statusQuery = {};
        if (status === 'complete') {
          statusQuery = { checkInTime: { $exists: true }, checkOutTime: { $exists: true } };
        } else if (status === 'incomplete') {
          statusQuery = { 
            checkInTime: { $exists: true }, 
            $or: [
              { checkOutTime: { $exists: false } },
              { checkOutTime: null }
            ]
          };
        }

        const query = {
          userId,
          ...dateQuery,
          ...statusQuery
        };

        // Execute query with pagination
        const skip = (page - 1) * limit;
        const [attendanceRecords, total] = await Promise.all([
          Attendance.find(query)
            .sort({ date: -1, checkInTime: -1 })
            .skip(skip)
            .limit(limit),
          Attendance.countDocuments(query)
        ]);

        const totalPages = Math.ceil(total / limit);

        // Calculate summary statistics
        const stats = await attendanceService.calculateAttendanceStats(userId, {
          startDate: startDate ? new Date(startDate) : null,
          endDate: endDate ? new Date(endDate) : null
        });

        return {
          success: true,
          attendance: attendanceRecords.map(record => ({
            id: record._id,
            date: record.date,
            checkInTime: record.checkInTime,
            checkOutTime: record.checkOutTime,
            workDuration: record.workDuration,
            workDurationFormatted: record.workDuration ? 
              attendanceService.formatDuration(record.workDuration) : null,
            location: record.location,
            checkOutLocation: record.checkOutLocation,
            note: record.note,
            checkOutNote: record.checkOutNote,
            isComplete: !!(record.checkInTime && record.checkOutTime)
          })),
          pagination: {
            page,
            limit,
            total,
            totalPages,
            hasNext: page < totalPages,
            hasPrev: page > 1
          },
          stats
        };

      } catch (error) {
        fastify.log.error('Get attendance history error:', error);
        throw new AppError('Failed to get attendance history', 500);
      }
    }
  });

  // Get attendance report (admin only)
  fastify.get('/report', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          startDate: { type: 'string', format: 'date' },
          endDate: { type: 'string', format: 'date' },
          userId: { type: 'string', pattern: '^[0-9a-fA-F]{24} },
          department: { type: 'string', maxLength: 50 },
          format: { type: 'string', enum: ['json', 'csv'], default: 'json' }
        }
      }
    },
    preHandler: [fastify.authenticate, fastify.requireRole('admin')],
    handler: async (request, reply) => {
      const { startDate, endDate, userId, department, format } = request.query;

      try {
        const reportData = await attendanceService.generateReport({
          startDate: startDate ? new Date(startDate) : null,
          endDate: endDate ? new Date(endDate) : null,
          userId,
          department
        });

        if (format === 'csv') {
          reply.type('text/csv');
          reply.header('Content-Disposition', 
            `attachment; filename="attendance-report-${new Date().toISOString().split('T')[0]}.csv"`
          );
          
          return attendanceService.formatReportAsCSV(reportData);
        }

        return {
          success: true,
          report: reportData,
          meta: {
            generatedAt: new Date(),
            totalRecords: reportData.length,
            dateRange: {
              start: startDate,
              end: endDate
            }
          }
        };

      } catch (error) {
        fastify.log.error('Generate attendance report error:', error);
        throw new AppError('Failed to generate report', 500);
      }
    }
  });

  // Manual attendance correction (admin only)
  fastify.put('/:attendanceId/correct', {
    schema: {
      params: {
        type: 'object',
        required: ['attendanceId'],
        properties: {
          attendanceId: { type: 'string', pattern: '^[0-9a-fA-F]{24} }
        }
      },
      body: {
        type: 'object',
        properties: {
          checkInTime: { type: 'string', format: 'date-time' },
          checkOutTime: { type: 'string', format: 'date-time' },
          note: { type: 'string', maxLength: 500 },
          reason: { type: 'string', maxLength: 200, required: true }
        }
      }
    },
    preHandler: [fastify.authenticate, fastify.requireRole('admin')],
    handler: async (request, reply) => {
      const { attendanceId } = request.params;
      const { checkInTime, checkOutTime, note, reason } = request.body;

      try {
        const attendance = await Attendance.findById(attendanceId)
          .populate('userId', 'name email');

        if (!attendance) {
          throw new AppError('Attendance record not found', 404);
        }

        const originalData = {
          checkInTime: attendance.checkInTime,
          checkOutTime: attendance.checkOutTime,
          workDuration: attendance.workDuration
        };

        // Update attendance record
        if (checkInTime) attendance.checkInTime = new Date(checkInTime);
        if (checkOutTime) attendance.checkOutTime = new Date(checkOutTime);
        if (note !== undefined) attendance.note = note;

        // Recalculate work duration
        if (attendance.checkInTime && attendance.checkOutTime) {
          attendance.workDuration = Math.round(
            (attendance.checkOutTime - attendance.checkInTime) / 1000
          );
        }

        // Add correction log
        attendance.corrections = attendance.corrections || [];
        attendance.corrections.push({
          correctedBy: request.user.id,
          correctedAt: new Date(),
          reason,
          originalData,
          newData: {
            checkInTime: attendance.checkInTime,
            checkOutTime: attendance.checkOutTime,
            workDuration: attendance.workDuration
          }
        });

        attendance.updatedAt = new Date();
        await attendance.save();

        // Clear cache for this user's attendance
        await cacheService.deleteTodaysAttendance(attendance.userId._id);

        fastify.log.info(`Attendance corrected by admin`, {
          adminId: request.user.id,
          attendanceId: attendance._id,
          userId: attendance.userId._id,
          reason
        });

        return {
          success: true,
          message: 'Attendance record corrected successfully',
          attendance: {
            id: attendance._id,
            checkInTime: attendance.checkInTime,
            checkOutTime: attendance.checkOutTime,
            workDuration: attendance.workDuration,
            workDurationFormatted: attendance.workDuration ? 
              attendanceService.formatDuration(attendance.workDuration) : null,
            note: attendance.note,
            correctionCount: attendance.corrections.length
          }
        };

      } catch (error) {
        if (error instanceof AppError) {
          throw error;
        }
        
        fastify.log.error('Correct attendance error:', error);
        throw new AppError('Failed to correct attendance', 500);
      }
    }
  });

  // Get attendance statistics
  fastify.get('/stats', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          period: { 
            type: 'string', 
            enum: ['today', 'week', 'month', 'year'],
            default: 'month'
          }
        }
      }
    },
    preHandler: [fastify.authenticate],
    handler: async (request, reply) => {
      const { period } = request.query;
      const userId = request.user.id;

      try {
        const stats = await attendanceService.getAttendanceStats(userId, period);

        return {
          success: true,
          stats,
          period
        };

      } catch (error) {
        fastify.log.error('Get attendance stats error:', error);
        throw new AppError('Failed to get attendance statistics', 500);
      }
    }
  });
}

module.exports = attendanceRoutes;