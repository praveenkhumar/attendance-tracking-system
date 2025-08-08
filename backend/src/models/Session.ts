import { Schema, model, Document, Types } from "mongoose";

export interface ISession extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  sessionId: string;
  isActive: boolean;
  expiresAt: Date;
  ipAddress?: string;
  userAgent?: string;
  createdAt: Date;
  updatedAt: Date;
}

const sessionSchema = new Schema<ISession>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    sessionId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    expiresAt: {
      type: Date,
      required: true,
      index: { expireAfterSeconds: 0 }, // TTL index
    },
    ipAddress: {
      type: String,
      default: undefined,
    },
    userAgent: {
      type: String,
      default: undefined,
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

// Index for cleanup of expired sessions
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// Static method to find active session
sessionSchema.statics.findActiveSession = function (sessionId: string) {
  return this.findOne({
    sessionId,
    isActive: true,
    expiresAt: { $gt: new Date() },
  }).populate("userId", "name email role");
};

// Static method to deactivate all user sessions
sessionSchema.statics.deactivateUserSessions = function (
  userId: Types.ObjectId
) {
  return this.updateMany({ userId, isActive: true }, { isActive: false });
};

// Instance method to check if session is valid
sessionSchema.methods.isValid = function (): boolean {
  return this.isActive && this.expiresAt > new Date();
};

// Instance method to extend session
sessionSchema.methods.extend = function (
  additionalTime: number = 24 * 60 * 60 * 1000
) {
  this.expiresAt = new Date(Date.now() + additionalTime);
  return this.save();
};

export const Session = model<ISession>("Session", sessionSchema);
