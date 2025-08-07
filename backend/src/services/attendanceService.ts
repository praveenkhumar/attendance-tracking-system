// backend/src/services/attendanceService.ts
import { Attendance, AttendanceType, IAttendance } from '../models/Attendance';
import { User, IUser } from '../models/User';
import { faceRecognitionService, FaceMatch } from './faceRecognitionService';
import { cacheService } from '../utils/redis';
import { logger } from '../utils/logger';
import { Types } from 'mongoose';

export interface AttendanceCheckRequest {
  imageBuffer: Buffer;
  ipAddress?: string;
  userAgent?: string;
  location?: {
    latitude: number;
    longitude: number;
  };
}

export interface AttendanceCheckResult {
  success: boolean;
  user?: {
    id: string;
    name: string;
    email: string;
  };
  attendance?: {
    id: string;
    type: AttendanceType;
    timestamp: Date;
    confidence: number;
  };
  message: string;
  confidence?: number;
}

export interface AttendanceStats {
  totalUsers: number;
  presentUsers: number;
  absentUsers: number;
  todayEntries: number;
  todayExits: number;
  averageWorkingHours: number;
  userStats: Array<{
    userId: string;
    userName: string;
    totalEntries: number;
    totalExits: number;
    firstEntry?: Date;
    lastExit?: Date;
    workingHours?: number;
  }>;
}

export interface AttendanceQuery {
  userId?: string;
  startDate?: Date;
  endDate?: Date;
  type?: AttendanceType;
  limit?: number;
  offset?: number;
}

export class AttendanceService {
  private static instance: AttendanceService;
  private readonly MIN_TIME_BETWEEN_ENTRIES = 5 * 60 * 1000; // 5 minutes

  private constructor() {}

  public static getInstance(): AttendanceService {
    if (!AttendanceService.instance) {
      AttendanceService.instance = new AttendanceService();
    }
    return AttendanceService.instance;
  }

  /**
   * Process attendance check via face recognition
   */
  public async processAttendanceCheck(request: AttendanceCheckRequest): Promise<AttendanceCheckResult> {
    try {
      // Extract face descriptor from image
      const faceResult = await faceRecognitionService.extractFaceDescriptor(request.imageBuffer);
      
      if (!faceResult.detected) {
        return {
          success: false,
          message: 'No face detected in the image. Please ensure your face is clearly visible.'
        };
      }

      if (!faceResult.descriptor || faceResult.confidence! < 0.6) {
        return {
          success: false,
          message: 'Face detection confidence too low. Please try again with better lighting.'
        };
      }

      // Find matching user
      const match = await faceRecognitionService.findMatchingUser(faceResult.descriptor);
      
      if (!match) {
        return {
          success: false,
          message: 'Face not recognized. Please register first or try again.'
        };
      }

      // Check for duplicate entries (prevent rapid successive entries)
      const recentAttendance = await cacheService.getRecentAttendance(match.userId);
      const now = new Date();
      
      if (recentAttendance) {
        const timeSinceLastEntry = now.getTime() - new Date(recentAttendance.timestamp).getTime();
        if (timeSinceLastEntry < this.MIN_TIME_BETWEEN_ENTRIES) {
          return {
            success: false,
            message: `Please wait ${Math.ceil((this.MIN_TIME_BETWEEN_ENTRIES - timeSinceLastEntry) / 1000)} seconds before next entry.`
          };
        }
      }

      // Determine attendance type (ENTRY or EXIT)
      const attendanceType = await this.determineAttendanceType(match.userId);
      
      // Create attendance record
      const attendance = new Attendance({
        userId: new Types.ObjectId(match.userId),
        type: attendanceType,
        timestamp: now,
        confidence: match.confidence,
        ipAddress: request.ipAddress,
        userAgent: request.userAgent,
        location: request.location
      });

      await attendance.save();

      // Cache recent attendance to prevent duplicates
      await cacheService.cacheRecentAttendance(match.userId, attendanceType, now);

      logger.info('Attendance recorded successfully', {
        userId: match.userId,
        type: attendanceType,
        confidence: match.confidence
      });

      return {
        success: true,
        user: {
          id: match.user._id,
          name: match.user.name,
          email: match.user.email
        },
        attendance: {
          id: attendance._id,
          type: attendanceType,
          timestamp: now,
          confidence: match.confidence
        },
        message: `${attendanceType} recorded successfully for ${match.user.name}`,
        confidence: match.confidence
      };

    } catch (error) {
      logger.error('Error processing attendance check:', error);
      return {
        success: false,
        message: 'Failed to process attendance. Please try again.'
      };
    }
  }

  /**
   * Get attendance records with filtering
   */
  public async getAttendanceRecords(query: AttendanceQuery): Promise<{
    records: IAttendance[];
    total: number;
    hasMore: boolean;
  }> {
    try {
      const filter: any = {};
      
      if (query.userId) {
        filter.userId = new Types.ObjectId(query.userId);
      }
      
      if (query.startDate || query.endDate) {
        filter.timestamp = {};
        if (query.startDate) {
          filter.timestamp.$gte = query.startDate;
        }
        if (query.endDate) {
          filter.timestamp.$lte = query.endDate;
        }
      }
      
      if (query.type) {
        filter.type = query.type;
      }