import { Types } from "mongoose";
import { Attendance, IAttendance } from "../models/Attendance";
import { User, IUser } from "../models/User";
import { FaceRecognitionService } from "./faceRecognitionService";
import { CacheService } from "./cacheService";
import { logger } from "../utils/logger";
import { appConfig } from "../utils/config";
import * as fs from "fs";
import * as path from "path";

export interface AttendanceCheckResult {
  success: boolean;
  user?: IUser;
  attendance?: IAttendance;
  message: string;
  type?: "ENTRY" | "EXIT";
  confidence?: number;
}

export interface AttendanceStats {
  totalUsers: number;
  presentToday: number;
  totalEntries: number;
  totalExits: number;
  avgAttendanceTime?: number;
}

export class AttendanceService {
  private static instance: AttendanceService;
  private faceRecognitionService: FaceRecognitionService;
  private cacheService: CacheService;

  private constructor() {
    this.faceRecognitionService = FaceRecognitionService.getInstance();
    this.cacheService = new CacheService();
  }

  public static getInstance(): AttendanceService {
    if (!AttendanceService.instance) {
      AttendanceService.instance = new AttendanceService();
    }
    return AttendanceService.instance;
  }

  async processAttendance(
    imageBuffer: Buffer,
    ipAddress?: string,
    userAgent?: string
  ): Promise<AttendanceCheckResult> {
    try {
      logger.debug("Processing attendance check");

      // Extract face descriptor from image
      const faceData =
        await this.faceRecognitionService.extractFaceDescriptorFromBuffer(
          imageBuffer
        );
      if (!faceData) {
        return {
          success: false,
          message:
            "No face detected in the image. Please ensure your face is clearly visible.",
        };
      }

      // Get all cached face descriptors
      const knownDescriptors = await this.cacheService.getAllFaceDescriptors();
      if (Object.keys(knownDescriptors).length === 0) {
        // Try to load from database
        await this.preloadFaceDescriptorsFromDatabase();
        const reloadedDescriptors =
          await this.cacheService.getAllFaceDescriptors();
        if (Object.keys(reloadedDescriptors).length === 0) {
          return {
            success: false,
            message: "No registered users found. Please register first.",
          };
        }
      }

      // Find best match
      const match = this.faceRecognitionService.findBestMatch(
        faceData.descriptor,
        await this.cacheService.getAllFaceDescriptors()
      );

      if (!match || match.confidence < appConfig.face.matchThreshold) {
        return {
          success: false,
          message:
            "Face not recognized. Please ensure you are registered or contact administrator.",
          confidence: match?.confidence || 0,
        };
      }

      // Get user details
      const user = await User.findById(match.userId);
      if (!user || !user.isActive) {
        return {
          success: false,
          message: "User account is not active.",
        };
      }

      // Determine if this should be ENTRY or EXIT
      const attendanceType = await this.determineAttendanceType(user._id);

      // Save image
      const imageUrl = await this.saveAttendanceImage(
        imageBuffer,
        user._id.toString(),
        attendanceType
      );

      // Create attendance record
      const attendance = new Attendance({
        userId: user._id,
        type: attendanceType,
        timestamp: new Date(),
        imageUrl,
        confidence: match.confidence,
        ipAddress,
        userAgent,
      });

      await attendance.save();

      // Update cache
      await this.cacheService.setRecentAttendance(user._id.toString(), {
        lastType: attendanceType,
        timestamp: attendance.timestamp.toISOString(),
      });

      logger.info(
        `Attendance recorded: ${
          user.name
        } - ${attendanceType} (confidence: ${match.confidence.toFixed(2)})`
      );

      return {
        success: true,
        user,
        attendance,
        message: `${
          attendanceType.toLowerCase() === "entry" ? "Welcome" : "Goodbye"
        }, ${user.name}!`,
        type: attendanceType,
        confidence: match.confidence,
      };
    } catch (error) {
      logger.error("Error processing attendance:", error);
      return {
        success: false,
        message: "Failed to process attendance. Please try again.",
      };
    }
  }

  private async determineAttendanceType(
    userId: Types.ObjectId
  ): Promise<"ENTRY" | "EXIT"> {
    try {
      // Check cache first
      const recentAttendance = await this.cacheService.getRecentAttendance(
        userId.toString()
      );
      if (recentAttendance) {
        return recentAttendance.lastType === "ENTRY" ? "EXIT" : "ENTRY";
      }

      // Check database for today's last attendance
      const lastAttendance = await Attendance.findOne({ userId })
        .sort({ timestamp: -1 })
        .limit(1);

      if (!lastAttendance) {
        return "ENTRY"; // First time attendance
      }

      // If last attendance was today, alternate between ENTRY/EXIT
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);

      if (
        lastAttendance.timestamp >= today &&
        lastAttendance.timestamp < tomorrow
      ) {
        return lastAttendance.type === "ENTRY" ? "EXIT" : "ENTRY";
      }

      // If last attendance was not today, this is an ENTRY
      return "ENTRY";
    } catch (error) {
      logger.error("Error determining attendance type:", error);
      return "ENTRY"; // Default to ENTRY on error
    }
  }

  private async saveAttendanceImage(
    imageBuffer: Buffer,
    userId: string,
    type: "ENTRY" | "EXIT"
  ): Promise<string> {
    try {
      const uploadsDir = path.join(
        process.cwd(),
        appConfig.upload.directory,
        "attendance"
      );

      // Create directory if it doesn't exist
      if (!fs.existsSync(uploadsDir)) {
        fs.mkdirSync(uploadsDir, { recursive: true });
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const filename = `${userId}_${type}_${timestamp}.jpg`;
      const filepath = path.join(uploadsDir, filename);

      fs.writeFileSync(filepath, imageBuffer);

      return `attendance/${filename}`;
    } catch (error) {
      logger.error("Error saving attendance image:", error);
      return "";
    }
  }

  async getAttendanceHistory(
    userId?: string,
    startDate?: Date,
    endDate?: Date,
    page: number = 1,
    limit: number = 50
  ): Promise<{ attendance: IAttendance[]; total: number; pages: number }> {
    try {
      const query: any = {};

      if (userId) {
        query.userId = new Types.ObjectId(userId);
      }

      if (startDate || endDate) {
        query.timestamp = {};
        if (startDate) query.timestamp.$gte = startDate;
        if (endDate) query.timestamp.$lte = endDate;
      }

      const skip = (page - 1) * limit;

      const [attendance, total] = await Promise.all([
        Attendance.find(query)
          .populate("userId", "name email")
          .sort({ timestamp: -1 })
          .skip(skip)
          .limit(limit)
          .lean(),
        Attendance.countDocuments(query),
      ]);

      const pages = Math.ceil(total / limit);

      return { attendance, total, pages };
    } catch (error) {
      logger.error("Error getting attendance history:", error);
      return { attendance: [], total: 0, pages: 0 };
    }
  }

  async getTodayAttendance(): Promise<IAttendance[]> {
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);

      const attendance = await Attendance.find({
        timestamp: {
          $gte: today,
          $lt: tomorrow,
        },
      })
        .populate("userId", "name email")
        .sort({ timestamp: -1 })
        .lean();

      return attendance;
    } catch (error) {
      logger.error("Error getting today's attendance:", error);
      return [];
    }
  }

  async getUserAttendanceToday(userId: string): Promise<IAttendance[]> {
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);

      const attendance = await Attendance.find({
        userId: new Types.ObjectId(userId),
        timestamp: {
          $gte: today,
          $lt: tomorrow,
        },
      })
        .sort({ timestamp: -1 })
        .lean();

      return attendance;
    } catch (error) {
      logger.error("Error getting user attendance today:", error);
      return [];
    }
  }

  async getAttendanceStats(
    startDate?: Date,
    endDate?: Date
  ): Promise<AttendanceStats> {
    try {
      const dateFilter: any = {};
      if (startDate || endDate) {
        dateFilter.timestamp = {};
        if (startDate) dateFilter.timestamp.$gte = startDate;
        if (endDate) dateFilter.timestamp.$lte = endDate;
      }

      const [totalUsers, attendanceRecords] = await Promise.all([
        User.countDocuments({ isActive: true }),
        Attendance.find(dateFilter).lean(),
      ]);

      // Get unique users who attended today
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);

      const todayAttendance = await Attendance.find({
        timestamp: {
          $gte: today,
          $lt: tomorrow,
        },
      }).distinct("userId");

      const presentToday = todayAttendance.length;

      // Count entries and exits
      const totalEntries = attendanceRecords.filter(
        (record) => record.type === "ENTRY"
      ).length;
      const totalExits = attendanceRecords.filter(
        (record) => record.type === "EXIT"
      ).length;

      // Calculate average attendance time (time between first entry and last exit)
      let avgAttendanceTime: number | undefined;

      if (totalEntries > 0 && totalExits > 0) {
        const userAttendanceTimes: number[] = [];

        // Group by user and calculate daily attendance times
        const userGroups = new Map<string, IAttendance[]>();

        for (const record of attendanceRecords) {
          const userId = record.userId.toString();
          if (!userGroups.has(userId)) {
            userGroups.set(userId, []);
          }
          userGroups.get(userId)!.push(record);
        }

        for (const [userId, records] of userGroups) {
          // Sort by timestamp
          records.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

          let dailyEntries: Date[] = [];
          let dailyExits: Date[] = [];

          // Group by day and calculate time differences
          const dayGroups = new Map<
            string,
            { entries: Date[]; exits: Date[] }
          >();

          for (const record of records) {
            const day = record.timestamp.toDateString();
            if (!dayGroups.has(day)) {
              dayGroups.set(day, { entries: [], exits: [] });
            }

            if (record.type === "ENTRY") {
              dayGroups.get(day)!.entries.push(record.timestamp);
            } else {
              dayGroups.get(day)!.exits.push(record.timestamp);
            }
          }

          // Calculate daily attendance times
          for (const [day, dayData] of dayGroups) {
            if (dayData.entries.length > 0 && dayData.exits.length > 0) {
              const firstEntry = Math.min(
                ...dayData.entries.map((d) => d.getTime())
              );
              const lastExit = Math.max(
                ...dayData.exits.map((d) => d.getTime())
              );
              const attendanceTime = (lastExit - firstEntry) / (1000 * 60 * 60); // in hours
              userAttendanceTimes.push(attendanceTime);
            }
          }
        }

        if (userAttendanceTimes.length > 0) {
          avgAttendanceTime =
            userAttendanceTimes.reduce((sum, time) => sum + time, 0) /
            userAttendanceTimes.length;
        }
      }

      return {
        totalUsers,
        presentToday,
        totalEntries,
        totalExits,
        avgAttendanceTime,
      };
    } catch (error) {
      logger.error("Error getting attendance stats:", error);
      return {
        totalUsers: 0,
        presentToday: 0,
        totalEntries: 0,
        totalExits: 0,
      };
    }
  }

  async isUserPresent(userId: string): Promise<boolean> {
    try {
      const todayAttendance = await this.getUserAttendanceToday(userId);

      if (todayAttendance.length === 0) {
        return false;
      }

      // Find the last entry and check if there's a corresponding exit
      const lastEntry = todayAttendance.find(
        (record) => record.type === "ENTRY"
      );
      if (!lastEntry) {
        return false;
      }

      const lastExit = todayAttendance.find(
        (record) =>
          record.type === "EXIT" && record.timestamp > lastEntry.timestamp
      );

      return !lastExit; // Present if no exit after last entry
    } catch (error) {
      logger.error("Error checking user presence:", error);
      return false;
    }
  }

  async deleteAttendanceRecord(attendanceId: string): Promise<boolean> {
    try {
      const result = await Attendance.findByIdAndDelete(attendanceId);

      if (result) {
        // Clean up image file if exists
        if (result.imageUrl) {
          const imagePath = path.join(
            process.cwd(),
            appConfig.upload.directory,
            result.imageUrl
          );
          if (fs.existsSync(imagePath)) {
            fs.unlinkSync(imagePath);
          }
        }

        // Update cache
        await this.cacheService.removeRecentAttendance(
          result.userId.toString()
        );

        logger.info(`Deleted attendance record: ${attendanceId}`);
        return true;
      }

      return false;
    } catch (error) {
      logger.error("Error deleting attendance record:", error);
      return false;
    }
  }

  private async preloadFaceDescriptorsFromDatabase(): Promise<void> {
    try {
      logger.info("Preloading face descriptors from database...");

      const users = await User.find({
        isActive: true,
        faceDescriptor: { $exists: true, $ne: null },
      }).select("_id faceDescriptor");

      for (const user of users) {
        if (user.faceDescriptor && user.faceDescriptor.length > 0) {
          await this.cacheService.setFaceDescriptor(
            user._id.toString(),
            user.faceDescriptor
          );
        }
      }

      logger.info(`Preloaded ${users.length} face descriptors`);
    } catch (error) {
      logger.error("Error preloading face descriptors:", error);
    }
  }

  async syncFaceDescriptorToCache(
    userId: string,
    faceDescriptor: number[]
  ): Promise<void> {
    try {
      await this.cacheService.setFaceDescriptor(userId, faceDescriptor);
      logger.debug(`Synced face descriptor to cache for user: ${userId}`);
    } catch (error) {
      logger.error("Error syncing face descriptor to cache:", error);
    }
  }

  async removeFaceDescriptorFromCache(userId: string): Promise<void> {
    try {
      await this.cacheService.removeFaceDescriptor(userId);
      logger.debug(`Removed face descriptor from cache for user: ${userId}`);
    } catch (error) {
      logger.error("Error removing face descriptor from cache:", error);
    }
  }

  async cleanupOldImages(daysOld: number = 30): Promise<void> {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysOld);

      const oldAttendance = await Attendance.find({
        timestamp: { $lt: cutoffDate },
        imageUrl: { $exists: true, $ne: "" },
      });

      let deletedCount = 0;

      for (const record of oldAttendance) {
        if (record.imageUrl) {
          const imagePath = path.join(
            process.cwd(),
            appConfig.upload.directory,
            record.imageUrl
          );
          if (fs.existsSync(imagePath)) {
            fs.unlinkSync(imagePath);
            deletedCount++;
          }

          // Remove imageUrl from database record
          await Attendance.updateOne(
            { _id: record._id },
            { $unset: { imageUrl: 1 } }
          );
        }
      }

      if (deletedCount > 0) {
        logger.info(`Cleaned up ${deletedCount} old attendance images`);
      }
    } catch (error) {
      logger.error("Error cleaning up old images:", error);
    }
  }
}
