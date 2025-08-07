// backend/src/models/Session.ts
import { Schema, model, Document, Types } from "mongoose";

export interface ISession extends Document {
  _id: string;
  userId: Types.ObjectId;
  token: string;
  role: string;
  expiresAt: Date;
  ipAddress?: string;
  userAgent?: string;
  isActive: boolean;
  lastAccessedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const SessionSchema = new Schema<ISession>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: [true, "User ID is required"],
      index: true,
    },
    token: {
      type: String,
      required: [true, "Token is required"],
      unique: true,
      index: true,
    },
    role: {
      type: String,
      enum: ["admin", "user"],
      default: "admin",
      required: true,
    },
    expiresAt: {
      type: Date,
      required: [true, "Expiration date is required"],
      index: { expireAfterSeconds: 0 }, // MongoDB TTL index for automatic cleanup
    },
    ipAddress: {
      type: String,
      trim: true,
      validate: {
        validator: function (v: string) {
          if (!v) return true; // Optional field
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
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    lastAccessedAt: {
      type: Date,
      default: Date.now,
      required: true,
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform: function (doc, ret) {
        delete ret.__v;
        delete ret.token; // Never expose tokens in API responses
        return ret;
      },
    },
  }
);

// Compound indexes for efficient queries
SessionSchema.index({ token: 1, isActive: 1 });
SessionSchema.index({ userId: 1, isActive: 1 });
SessionSchema.index({ expiresAt: 1, isActive: 1 });

// Instance methods
SessionSchema.methods.isExpired = function (): boolean {
  return new Date() > this.expiresAt;
};

SessionSchema.methods.updateLastAccessed = function () {
  this.lastAccessedAt = new Date();
  return this.save();
};

SessionSchema.methods.deactivate = function () {
  this.isActive = false;
  return this.save();
};

// Static methods
SessionSchema.statics.cleanupExpiredSessions = function () {
  return this.deleteMany({
    $or: [{ expiresAt: { $lt: new Date() } }, { isActive: false }],
  });
};

SessionSchema.statics.findActiveSession = function (token: string) {
  return this.findOne({
    token,
    isActive: true,
    expiresAt: { $gt: new Date() },
  }).populate("userId", "name email isActive");
};

SessionSchema.statics.deactivateUserSessions = function (userId: string) {
  return this.updateMany(
    { userId, isActive: true },
    { isActive: false, updatedAt: new Date() }
  );
};

export const Session = model<ISession>("Session", SessionSchema);
