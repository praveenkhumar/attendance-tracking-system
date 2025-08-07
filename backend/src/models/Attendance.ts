// backend/src/models/Attendance.ts
import { Schema, model, Document, Types } from "mongoose";

export enum AttendanceType {
  ENTRY = "ENTRY",
  EXIT = "EXIT",
}

export interface IAttendance extends Document {
  _id: string;
  userId: Types.ObjectId;
  type: AttendanceType;
  timestamp: Date;
  imageUrl?: string;
  confidence: number;
  ipAddress?: string;
  userAgent?: string;
  location?: {
    latitude: number;
    longitude: number;
  };
}

const AttendanceSchema = new Schema<IAttendance>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: [true, "User ID is required"],
      index: true,
    },
    type: {
      type: String,
      enum: Object.values(AttendanceType),
      required: [true, "Attendance type is required"],
    },
    timestamp: {
      type: Date,
      default: Date.now,
      required: true,
      index: true,
    },
    imageUrl: {
      type: String,
      trim: true,
      validate: {
        validator: function (v: string) {
          if (!v) return true; // Optional field
          return /^https?:\/\/.+\.(jpg|jpeg|png|webp)$/i.test(v);
        },
        message: "Invalid image URL format",
      },
    },
    confidence: {
      type: Number,
      required: [true, "Confidence score is required"],
      min: [0, "Confidence must be between 0 and 1"],
      max: [1, "Confidence must be between 0 and 1"],
    },
    ipAddress: {
      type: String,
      trim: true,
      validate: {
        validator: function (v: string) {
          if (!v) return true; // Optional field
          // Basic IP validation (IPv4 and IPv6)
          const ipv4Regex =
            /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
          const ipv6Regex = /^(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$/;
          return ipv4Regex.test(v) || ipv6Regex.test(v);
        },
        message: "Invalid IP address format",
      },
    },
    userAgent: {
      type: String,
      trim: true,
      maxlength: [500, "User agent cannot exceed 500 characters"],
    },
    location: {
      latitude: {
        type: Number,
        min: [-90, "Latitude must be between -90 and 90"],
        max: [90, "Latitude must be between -90 and 90"],
      },
      longitude: {
        type: Number,
        min: [-180, "Longitude must be between -180 and 180"],
        max: [180, "Longitude must be between -180 and 180"],
      },
    },
  },
  {
    timestamps: false, // We're using custom timestamp field
    toJSON: {
      transform: function (doc, ret) {
        delete ret.__v;
        return ret;
      },
    },
  }
);

// Compound indexes for efficient queries
AttendanceSchema.index({ userId: 1, timestamp: -1 });
AttendanceSchema.index({ timestamp: -1 });
AttendanceSchema.index({ userId: 1, type: 1, timestamp: -1 });

// Static methods
AttendanceSchema.statics.getLastAttendance = function (userId: string) {
  return this.findOne({ userId }).sort({ timestamp: -1 });
};

AttendanceSchema.statics.getDailyAttendance = function (
  userId: string,
  date?: Date
) {
  const targetDate = date || new Date();
  const startOfDay = new Date(targetDate);
  startOfDay.setHours(0, 0, 0, 0);

  const endOfDay = new Date(targetDate);
  endOfDay.setHours(23, 59, 59, 999);

  return this.find({
    userId,
    timestamp: { $gte: startOfDay, $lte: endOfDay },
  }).sort({ timestamp: 1 });
};

AttendanceSchema.statics.getAttendanceStats = function (
  startDate: Date,
  endDate: Date
) {
  return this.aggregate([
    {
      $match: {
        timestamp: { $gte: startDate, $lte: endDate },
      },
    },
    {
      $lookup: {
        from: "users",
        localField: "userId",
        foreignField: "_id",
        as: "user",
      },
    },
    {
      $unwind: "$user",
    },
    {
      $group: {
        _id: "$userId",
        userName: { $first: "$user.name" },
        totalEntries: {
          $sum: { $cond: [{ $eq: ["$type", "ENTRY"] }, 1, 0] },
        },
        totalExits: {
          $sum: { $cond: [{ $eq: ["$type", "EXIT"] }, 1, 0] },
        },
        firstEntry: {
          $min: { $cond: [{ $eq: ["$type", "ENTRY"] }, "$timestamp", null] },
        },
        lastExit: {
          $max: { $cond: [{ $eq: ["$type", "EXIT"] }, "$timestamp", null] },
        },
      },
    },
    {
      $sort: { userName: 1 },
    },
  ]);
};

export const Attendance = model<IAttendance>("Attendance", AttendanceSchema);
