import { Schema, model, Document, Types } from "mongoose";

export interface IAttendance extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  type: "ENTRY" | "EXIT";
  timestamp: Date;
  imageUrl?: string;
  confidence: number;
  ipAddress?: string;
  userAgent?: string;
  location?: {
    latitude?: number;
    longitude?: number;
  };
  createdAt: Date;
  updatedAt: Date;
}

const attendanceSchema = new Schema<IAttendance>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: ["ENTRY", "EXIT"],
      required: true,
    },
    timestamp: {
      type: Date,
      default: Date.now,
      required: true,
    },
    imageUrl: {
      type: String,
      default: undefined,
    },
    confidence: {
      type: Number,
      required: true,
      min: 0,
      max: 1,
    },
    ipAddress: {
      type: String,
      default: undefined,
    },
    userAgent: {
      type: String,
      default: undefined,
    },
    location: {
      latitude: {
        type: Number,
        default: undefined,
      },
      longitude: {
        type: Number,
        default: undefined,
      },
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform: function (doc, ret) {
        delete ret.__v;
        return ret;
      },
    },
  }
);

// Compound indexes for better query performance
attendanceSchema.index({ userId: 1, timestamp: -1 });
attendanceSchema.index({ timestamp: -1 });
attendanceSchema.index({ type: 1, timestamp: -1 });
attendanceSchema.index({ userId: 1, type: 1, timestamp: -1 });

// Static method to get last attendance for a user
attendanceSchema.statics.getLastAttendanceForUser = function (
  userId: Types.ObjectId
) {
  return this.findOne({ userId }).sort({ timestamp: -1 });
};

// Static method to get attendance for a date range
attendanceSchema.statics.getAttendanceByDateRange = function (
  startDate: Date,
  endDate: Date,
  userId?: Types.ObjectId
) {
  const query: any = {
    timestamp: {
      $gte: startDate,
      $lte: endDate,
    },
  };

  if (userId) {
    query.userId = userId;
  }

  return this.find(query)
    .populate("userId", "name email")
    .sort({ timestamp: -1 });
};

// Static method to get today's attendance
attendanceSchema.statics.getTodayAttendance = function (
  userId?: Types.ObjectId
) {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const endOfDay = new Date();
  endOfDay.setHours(23, 59, 59, 999);

  return this.getAttendanceByDateRange(startOfDay, endOfDay, userId);
};

// Static method to check if user has entry without exit today
attendanceSchema.statics.hasActiveEntry = async function (
  userId: Types.ObjectId
): Promise<boolean> {
  const todayAttendance = await this.getTodayAttendance(userId);

  if (todayAttendance.length === 0) {
    return false;
  }

  // Check if the last entry today is an ENTRY without a matching EXIT
  const lastEntry = todayAttendance.find(
    (record: IAttendance) => record.type === "ENTRY"
  );
  if (!lastEntry) {
    return false;
  }

  const lastExit = todayAttendance.find(
    (record: IAttendance) =>
      record.type === "EXIT" && record.timestamp > lastEntry.timestamp
  );

  return !lastExit;
};

// Virtual for populating user data
attendanceSchema.virtual("user", {
  ref: "User",
  localField: "userId",
  foreignField: "_id",
  justOne: true,
});

export const Attendance = model<IAttendance>("Attendance", attendanceSchema);
